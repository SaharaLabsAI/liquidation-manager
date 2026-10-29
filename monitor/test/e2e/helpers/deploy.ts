// Deploys the liquidity contracts on a local anvil node in the post-handover state, wired the way script/Deploy.s.sol
// and script/Handover.s.sol wire them, with the test/mocks stand-ins for the SAHARA token, the TokenAdminRegistry and
// the CCIP pool. Also the typed actions the scenarios drive (fund, recall, Guardian and Timelock calls, unexplained
// transfers).
//
// TEST-ONLY: transactions are signed with anvil's well-known dev keys (default mnemonic); the monitor never holds a
// key.
//
// Differences from mainnet forced by the mocks (see test/mocks/MockLockReleaseTokenPool.sol):
// - pool and registry handover are single-step: the legacy multisig hands over pool ownership with `transferOwnership`
//   (the mock has no acceptOwnership) and the registry administrator with `setAdministrator` (the mock has no
//   transferAdminRole/acceptAdminRole), so the Timelock batch omits `pool.acceptOwnership()` and
//   `registry.acceptAdminRole(token)`;
// - the pool emits only LiquidityAdded/LiquidityRemoved/RebalancerSet/ChainConfigured (no ownership, Router, rate-limit
//   admin or LockedOrBurned/ReleasedOrMinted events) and lacks the rate-limiter state getters;
// - the Router is a plain address without code (the pool and the Manager's spec only store it).
import {spawnSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  http,
  numberToHex,
  padHex,
  parseAbi,
  parseUnits,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
} from "viem";
import {mnemonicToAccount} from "viem/accounts";

import {saharaTokenAbi} from "../../../src/abi/external.ts";
import {
  ccipPoolAdapterAbi,
  guardianControllerAbi,
  liquidityManagerAbi,
  saharaTimelockAbi,
} from "../../../src/abi/generated.ts";
import type {Anvil} from "./anvil.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** Foundry project root (contracts, scripts, test/mocks). */
export const REPO_ROOT = join(here, "..", "..", "..", "..");
const OUT_DIR = join(REPO_ROOT, "out");

/** anvil's default mnemonic; its accounts are pre-funded with 10,000 ETH each. Test-only keys. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

/** CCIP selector of the (non-existent) counterpart chain the pool is configured for. */
export const REMOTE_CHAIN_SELECTOR = 1_000_000_000_000_000_002n;
/** Pool `typeAndVersion()` (the mock's default) pinned in the Manager's pool spec. */
export const POOL_TYPE_AND_VERSION = "LockReleaseTokenPool 1.6.3-dev";
/** Stand-ins without code: the pool's Router and the remote token and pool of the counterpart chain. */
export const ROUTER = getAddress(padHex("0xc0de01", {size: 20}));
export const REMOTE_TOKEN = getAddress(padHex("0xc0de02", {size: 20}));
export const REMOTE_POOL = getAddress(padHex("0xc0de03", {size: 20}));

/** Whole tokens (18 decimals) to base units: tokens(1_000_000), tokens("2.5"). */
export function tokens(amount: number | string | bigint): bigint {
  return parseUnits(String(amount), 18);
}

// Mock-only functions, copied from test/mocks/*.sol; checked against the build artifacts' selectors on load.
export const mockPoolAbi = parseAbi([
  "struct RateLimiterConfig { bool isEnabled; uint128 capacity; uint128 rate; }",
  "function addChain(uint64 remoteChainSelector, bytes remoteToken, bytes remotePool, RateLimiterConfig outbound, RateLimiterConfig inbound)",
  "function removeChain(uint64 remoteChainSelector)",
  "function setRebalancer(address rebalancer)",
  "function setRateLimitAdmin(address rateLimitAdmin)",
  "function setRouter(address router)",
  "function setTypeAndVersion(string typeAndVersion_)",
  "function transferOwnership(address newOwner)",
  "function setChainRateLimiterConfig(uint64 remoteChainSelector, RateLimiterConfig outbound, RateLimiterConfig inbound)",
  "function outboundConfig(uint64 remoteChainSelector) view returns (bool isEnabled, uint128 capacity, uint128 rate)",
  "function inboundConfig(uint64 remoteChainSelector) view returns (bool isEnabled, uint128 capacity, uint128 rate)",
  "function simulateRelease(address receiver, uint256 amount)",
  "function owner() view returns (address)",
  "function getRebalancer() view returns (address)",
  "function getRateLimitAdmin() view returns (address)",
]);

export const mockRegistryAbi = parseAbi([
  "function setPool(address token, address pool)",
  "function setAdministrator(address token, address administrator)",
  "function setPendingAdministrator(address token, address pendingAdministrator)",
]);

export interface RateLimit {
  isEnabled: boolean;
  capacity: bigint;
  rate: bigint;
}

export interface Budget {
  /** Base units. */
  capacity: bigint;
  /** Base units per second. */
  rate: bigint;
}

/** Deployment parameters; amounts in base units. Defaults: `DEFAULT_PARAMS`. */
export interface DeployParams {
  /** Timelock delay and its immutable bounds (Deploy.s.sol defaults: 72 h, 48 h, 30 days). */
  delaySec: bigint;
  minimumDelaySec: bigint;
  maximumDelaySec: bigint;
  remoteChainSelector: bigint;
  thresholds: {minimum: bigint; refillTrigger: bigint; refillTarget: bigint};
  maxFundingPerCall: bigint;
  aggregateFunding: Budget;
  poolFunding: Budget;
  maxRecallPerCall: bigint;
  recall: Budget;
  /** Pool rate limits for the remote chain, both directions. */
  rateLimits: {outbound: RateLimit; inbound: RateLimit};
  /** Bridge inventory already in the pool before the handover (plain transfer from the legacy multisig). */
  poolInventory: bigint;
  /** Legacy reserves moved into the Manager after the handover (handover step 3, plain transfer). */
  managerReserves: bigint;
}

export const DEFAULT_PARAMS: DeployParams = {
  delaySec: 72n * 3600n,
  minimumDelaySec: 48n * 3600n,
  maximumDelaySec: 30n * 86400n,
  remoteChainSelector: REMOTE_CHAIN_SELECTOR,
  thresholds: {minimum: tokens(1_000_000), refillTrigger: tokens(2_000_000), refillTarget: tokens(8_000_000)},
  maxFundingPerCall: tokens(5_000_000),
  // Slow refill (10 tokens/s), so draining a budget in a scenario stays drained for its duration.
  aggregateFunding: {capacity: tokens(20_000_000), rate: tokens(10)},
  poolFunding: {capacity: tokens(20_000_000), rate: tokens(10)},
  maxRecallPerCall: tokens(5_000_000),
  recall: {capacity: tokens(20_000_000), rate: tokens(10)},
  rateLimits: {
    outbound: {isEnabled: true, capacity: tokens(300_000_000), rate: tokens(3_500)},
    inbound: {isEnabled: true, capacity: tokens(300_000_000), rate: tokens(3_500)},
  },
  poolInventory: tokens(5_000_000),
  managerReserves: tokens(100_000_000),
};

/** Dev accounts by role (anvil mnemonic indexes 0..9). */
export interface DevAccounts {
  /**
   * #0. Deploys everything and stands in for the legacy multisig: initial owner of the token, pool and registry entry,
   * and holder of the remaining token supply (the treasury the helpers top other accounts up from).
   */
  deployer: LocalAccount;
  /** #1. Governance Safe stand-in: the Timelock's only proposer and executor, and a canceller. */
  governance: LocalAccount;
  /** #2. Guardian Safe stand-in (`Manager.guardian()`). */
  guardian: LocalAccount;
  /** #3. Funding Operator. */
  fundingOperator: LocalAccount;
  /** #4. Recall Operator. */
  recallOperator: LocalAccount;
  /** #5. Holds no role: direct transfers to the pool, unauthorised pool withdrawals. */
  attacker: LocalAccount;
  /** #6. Candidate new Guardian for a recovery (`scheduleSetGuardian`). */
  replacementGuardian: LocalAccount;
  /** #7..#9, unused. */
  spare: LocalAccount[];
}

export function devAccounts(): DevAccounts {
  const at = (addressIndex: number) => mnemonicToAccount(ANVIL_MNEMONIC, {addressIndex});
  return {
    deployer: at(0),
    governance: at(1),
    guardian: at(2),
    fundingOperator: at(3),
    recallOperator: at(4),
    attacker: at(5),
    replacementGuardian: at(6),
    spare: [at(7), at(8), at(9)],
  };
}

export interface DeployedAddresses {
  token: Address;
  registry: Address;
  pool: Address;
  router: Address;
  timelock: Address;
  manager: Address;
  controller: Address;
  adapter: Address;
}

export interface TimelockCall {
  target: Address;
  value: bigint;
  data: Hex;
}

/** A scheduled Timelock operation: everything needed to execute or cancel it (the id is recomputed from it). */
export interface TimelockOp {
  id: Hex;
  calls: TimelockCall[];
  /** Scheduled with `scheduleBatch` (executed with `executeBatch`, cancelled with `cancelBatch`). */
  batch: boolean;
  predecessor: Hex;
  salt: Hex;
  delay: bigint;
  /** The schedule transaction. */
  receipt: TransactionReceipt;
}

export interface ScheduleOptions {
  /** Default: the Timelock's current `getMinDelay()`. */
  delay?: bigint;
  /** Default: zero (no predecessor). */
  predecessor?: Hex;
  /** Default: a fresh salt per operation, so the same call can be scheduled twice. */
  salt?: Hex;
  /** Default: the Governance Safe. */
  from?: LocalAccount;
}

export interface From {
  from?: LocalAccount;
}

/** OpenZeppelin `TimelockController.OperationState`. */
export const OPERATION_STATE = {unset: 0, waiting: 1, ready: 2, done: 3} as const;

export type Wallet = ReturnType<typeof walletFor>;

export interface E2EDeployment {
  anvil: Anvil;
  addresses: DeployedAddresses;
  accounts: DevAccounts;
  params: DeployParams;
  /** Manager adapter id of the pool (1). */
  adapterId: bigint;
  /** First block of the deployment and last block of the setup: start a monitor at `readyBlock + 1n`. */
  firstBlock: bigint;
  readyBlock: bigint;
  /** The handover batch (executed). */
  handover: TimelockOp;

  wallet(account: LocalAccount): Wallet;
  /** Waits for the receipt and throws if the transaction reverted. */
  confirm(hash: Hex): Promise<TransactionReceipt>;
  balanceOf(account: Address): Promise<bigint>;
  /** Plain SAHARA transfer. */
  transferToken(from: LocalAccount, to: Address, amount: bigint): Promise<TransactionReceipt>;

  /** `Manager.fund(adapterId, amount)` by the Funding Operator. */
  fund(amount: bigint, options?: From): Promise<TransactionReceipt>;
  /** `Manager.recall(adapterId, amount)` by the Recall Operator. */
  recall(amount: bigint, options?: From): Promise<TransactionReceipt>;

  /** Guardian `suspendFundingOperator(operator)` (default: the Funding Operator). */
  guardianSuspendFundingOperator(operator?: Address, options?: From): Promise<TransactionReceipt>;
  /** Guardian `pauseFunding()`. */
  guardianPauseFunding(options?: From): Promise<TransactionReceipt>;
  /** Guardian `raisePoolMinimum(pool, minimum)`. */
  guardianRaisePoolMinimum(minimum: bigint, options?: From): Promise<TransactionReceipt>;
  /** Guardian `GuardianController.lockdown(pool)`: zero rate limits on every chain of the pool. */
  guardianLockdown(options?: From): Promise<TransactionReceipt>;
  /** Guardian `GuardianController.cancel(...)` / `cancelBatch(...)` of a scheduled operation. */
  guardianCancel(op: TimelockOp, options?: From): Promise<TransactionReceipt>;

  /** Governance `Timelock.schedule(target, 0, data, predecessor, salt, delay)`. */
  scheduleTimelockCall(target: Address, data: Hex, options?: ScheduleOptions & {value?: bigint}): Promise<TimelockOp>;
  /** Governance `Timelock.scheduleBatch(...)`. */
  scheduleTimelockBatch(calls: TimelockCall[], options?: ScheduleOptions): Promise<TimelockOp>;
  /**
   * Protected Guardian recovery: exactly `abi.encodeCall(Manager.setGuardian, (newGuardian))`, value 0, single
   * operation, predecessor zero unless given (README runbook). The Guardian cannot cancel it.
   */
  scheduleSetGuardian(newGuardian: Address, options?: ScheduleOptions): Promise<TimelockOp>;
  /** Mines a block at the operation's ready timestamp unless it is already ready. */
  warpUntilReady(op: TimelockOp): Promise<void>;
  /** Governance `execute`/`executeBatch`; warps to the ready time first unless `warp` is false. */
  executeTimelockCall(op: TimelockOp, options?: From & {warp?: boolean}): Promise<TransactionReceipt>;
  /** `Timelock.getOperationState(id)`: see `OPERATION_STATE`. */
  operationState(op: TimelockOp): Promise<number>;

  /** SAHARA transfer into the pool by a non-operator (default: the attacker, topped up from the treasury). */
  directTransferToPool(amount: bigint, options?: From): Promise<TransactionReceipt>;
  /**
   * Pool outflow through the mock's unrestricted `simulateRelease(receiver, amount)` (default receiver: the attacker).
   * Emits only the token Transfer: no ReleasedOrMinted, no LiquidityRemoved.
   */
  transferOutOfPool(amount: bigint, options?: From & {to?: Address}): Promise<TransactionReceipt>;
  /**
   * `token.pause()` / `unpause()`. The Timelock owns the token, so this schedules the call through the Timelock,
   * warps past the delay and executes it (CallScheduled/CallExecuted are emitted too). Returns the operation.
   */
  pauseToken(): Promise<TimelockOp>;
  unpauseToken(): Promise<TimelockOp>;
}

/**
 * Deploys the mocks and the four contracts and completes the handover:
 *
 * 1. Legacy state (deployer = legacy multisig): MockSahara (whole supply to the deployer), MockTokenAdminRegistry
 *    mapping the token to the pool with the deployer as administrator, MockLockReleaseTokenPool configured for the
 *    remote chain (rate limits, remote token and pool) and holding `poolInventory`.
 * 2. Deploy.s.sol `deploy()`: Timelock (Governance Safe proposer/executor, the predicted controller as canceller),
 *    Manager (owner Timelock, Guardian), GuardianController, adapter, in that nonce order; then its wiring checks.
 * 3. Handover legacy calls: pool `setRateLimitAdmin(controller)`, pool ownership, registry administration and token
 *    ownership to the Timelock.
 * 4. Handover Timelock batch (scheduled by governance, executed after the delay): pool `setRebalancer(adapter)`,
 *    `setPoolSpec`, `setPoolThresholds`, budgets and limits, operators, `registerAdapter`; then the checks of
 *    `HandoverPlan.simulate` (verifyHandover, verifyAdapter, pool authorities, operators).
 * 5. Legacy reserves to the Manager (`managerReserves`).
 *
 * Step 4 warps block time forward by the Timelock delay (72 h by default): block timestamps are ahead of the wall clock
 * from then on.
 */
export async function deploySystem(anvil: Anvil, overrides: Partial<DeployParams> = {}): Promise<E2EDeployment> {
  const params: DeployParams = {...DEFAULT_PARAMS, ...overrides};
  const accounts = devAccounts();
  const client = anvil.client;
  const wallets = new Map<string, Wallet>();
  const wallet = (account: LocalAccount): Wallet => {
    let entry = wallets.get(account.address);
    if (!entry) {
      entry = walletFor(anvil, account);
      wallets.set(account.address, entry);
    }
    return entry;
  };
  const confirm = async (hash: Hex): Promise<TransactionReceipt> => {
    const receipt = await client.waitForTransactionReceipt({hash});
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return receipt;
  };
  const deployer = wallet(accounts.deployer);
  const deploy = async (name: string, args: readonly unknown[]): Promise<Address> => {
    const artifact = loadArtifact(name);
    const hash = await deployer.deployContract({abi: artifact.abi, bytecode: artifact.bytecode, args});
    const receipt = await confirm(hash);
    if (!receipt.contractAddress) throw new Error(`${name} deployment returned no contract address`);
    return getAddress(receipt.contractAddress);
  };

  ensureArtifacts();
  assertImplements("MockSahara", saharaTokenAbi);
  assertImplements("MockLockReleaseTokenPool", mockPoolAbi);
  assertImplements("MockTokenAdminRegistry", mockRegistryAbi);

  const firstBlock = (await anvil.blockNumber()) + 1n;
  const legacy = accounts.deployer.address;
  const governance = accounts.governance.address;
  const guardian = accounts.guardian.address;
  const remote = params.remoteChainSelector;
  const remoteToken = encodeAddress(REMOTE_TOKEN);
  const remotePool = encodeAddress(REMOTE_POOL);

  // 1. Legacy state.
  const token = await deploy("MockSahara", [legacy]);
  const registry = await deploy("MockTokenAdminRegistry", []);
  const pool = await deploy("MockLockReleaseTokenPool", [token, ROUTER]);
  const legacyWrite = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[]) =>
    confirm(await deployer.writeContract({address, abi, functionName, args}));
  await legacyWrite(pool, mockPoolAbi, "addChain", [
    remote,
    remoteToken,
    remotePool,
    params.rateLimits.outbound,
    params.rateLimits.inbound,
  ]);
  await legacyWrite(registry, mockRegistryAbi, "setPool", [token, pool]);
  await legacyWrite(registry, mockRegistryAbi, "setAdministrator", [token, legacy]);
  await legacyWrite(token, saharaTokenAbi, "transfer", [pool, params.poolInventory]);

  // 2. Deploy.s.sol deploy(): the Timelock grants CANCELLER_ROLE to the controller's predicted address (nonce n + 2).
  const nonce = await client.getTransactionCount({address: legacy, blockTag: "pending"});
  const predictedController = getContractAddress({from: legacy, nonce: BigInt(nonce + 2)});
  const timelock = await deploy("SaharaTimelock", [
    params.delaySec,
    params.minimumDelaySec,
    params.maximumDelaySec,
    [governance],
    [governance],
    [predictedController],
  ]);
  const manager = await deploy("LiquidityManager", [token, registry, timelock, guardian]);
  const controller = await deploy("GuardianController", [manager, timelock]);
  const adapter = await deploy("CCIPPoolAdapter", [manager, token, pool]);
  if (controller !== predictedController) {
    throw new Error(`GuardianController deployed at ${controller}, Timelock canceller is ${predictedController}`);
  }
  const addresses: DeployedAddresses = {token, registry, pool, router: ROUTER, timelock, manager, controller, adapter};
  await checkWiring(client, addresses, accounts, params);

  // 3. Legacy multisig calls (one MultiSend on mainnet).
  await legacyWrite(pool, mockPoolAbi, "setRateLimitAdmin", [controller]);
  await legacyWrite(pool, mockPoolAbi, "transferOwnership", [timelock]);
  await legacyWrite(registry, mockRegistryAbi, "setAdministrator", [token, timelock]);
  await legacyWrite(token, saharaTokenAbi, "transferOwnership", [timelock]);

  // Timelock operations; salts are fresh per operation so identical calls can be scheduled again.
  let saltSeq = 0n;
  const nextSalt = () => padHex(numberToHex(++saltSeq), {size: 32});
  const minDelay = () => client.readContract({address: timelock, abi: saharaTimelockAbi, functionName: "getMinDelay"});

  const scheduleTimelockBatch = async (calls: TimelockCall[], options: ScheduleOptions = {}): Promise<TimelockOp> => {
    const predecessor = options.predecessor ?? zeroHash;
    const salt = options.salt ?? nextSalt();
    const delay = options.delay ?? (await minDelay());
    const targets = calls.map((call) => call.target);
    const values = calls.map((call) => call.value);
    const payloads = calls.map((call) => call.data);
    const governanceWallet = wallet(options.from ?? accounts.governance);
    const hash = await governanceWallet.writeContract({
      address: timelock,
      abi: saharaTimelockAbi,
      functionName: "scheduleBatch",
      args: [targets, values, payloads, predecessor, salt, delay],
    });
    const receipt = await confirm(hash);
    const id = await client.readContract({
      address: timelock,
      abi: saharaTimelockAbi,
      functionName: "hashOperationBatch",
      args: [targets, values, payloads, predecessor, salt],
    });
    return {id, calls, batch: true, predecessor, salt, delay, receipt};
  };

  const scheduleTimelockCall = async (
    target: Address,
    data: Hex,
    options: ScheduleOptions & {value?: bigint} = {},
  ): Promise<TimelockOp> => {
    const value = options.value ?? 0n;
    const predecessor = options.predecessor ?? zeroHash;
    const salt = options.salt ?? nextSalt();
    const delay = options.delay ?? (await minDelay());
    const hash = await wallet(options.from ?? accounts.governance).writeContract({
      address: timelock,
      abi: saharaTimelockAbi,
      functionName: "schedule",
      args: [target, value, data, predecessor, salt, delay],
    });
    const receipt = await confirm(hash);
    const id = await client.readContract({
      address: timelock,
      abi: saharaTimelockAbi,
      functionName: "hashOperation",
      args: [target, value, data, predecessor, salt],
    });
    return {id, calls: [{target, value, data}], batch: false, predecessor, salt, delay, receipt};
  };

  const warpUntilReady = async (op: TimelockOp): Promise<void> => {
    const readyAt = await client.readContract({
      address: timelock,
      abi: saharaTimelockAbi,
      functionName: "getTimestamp",
      args: [op.id],
    });
    // 0 = unset, 1 = done; otherwise the timestamp from which the operation is ready.
    if (readyAt <= 1n) return;
    if ((await anvil.timestamp()) < readyAt) await anvil.warpTo(readyAt);
  };

  const executeTimelockCall = async (
    op: TimelockOp,
    options: From & {warp?: boolean} = {},
  ): Promise<TransactionReceipt> => {
    if (options.warp ?? true) await warpUntilReady(op);
    const executor = wallet(options.from ?? accounts.governance);
    const [first] = op.calls;
    if (!op.batch && first) {
      return confirm(
        await executor.writeContract({
          address: timelock,
          abi: saharaTimelockAbi,
          functionName: "execute",
          args: [first.target, first.value, first.data, op.predecessor, op.salt],
          value: first.value,
        }),
      );
    }
    return confirm(
      await executor.writeContract({
        address: timelock,
        abi: saharaTimelockAbi,
        functionName: "executeBatch",
        args: [
          op.calls.map((call) => call.target),
          op.calls.map((call) => call.value),
          op.calls.map((call) => call.data),
          op.predecessor,
          op.salt,
        ],
        value: op.calls.reduce((sum, call) => sum + call.value, 0n),
      }),
    );
  };

  // 4. Handover Timelock batch (HandoverPlan.timelockBatch without the two accept calls the mocks lack).
  const spec = {
    typeAndVersion: POOL_TYPE_AND_VERSION,
    router: ROUTER,
    remoteChainSelector: remote,
    remoteToken,
    remotePools: [remotePool],
    rateLimitAdmin: controller,
  };
  const managerCall = (data: Hex): TimelockCall => ({target: manager, value: 0n, data});
  const {thresholds} = params;
  const handover = await scheduleTimelockBatch([
    {
      target: pool,
      value: 0n,
      data: encodeFunctionData({abi: mockPoolAbi, functionName: "setRebalancer", args: [adapter]}),
    },
    managerCall(encodeManager("setPoolSpec", [pool, spec])),
    managerCall(
      encodeManager("setPoolThresholds", [pool, thresholds.minimum, thresholds.refillTrigger, thresholds.refillTarget]),
    ),
    managerCall(encodeManager("setPoolFundingBudget", [pool, params.poolFunding.capacity, params.poolFunding.rate])),
    managerCall(
      encodeManager("setAggregateFundingBudget", [params.aggregateFunding.capacity, params.aggregateFunding.rate]),
    ),
    managerCall(encodeManager("setMaxFundingPerCall", [params.maxFundingPerCall])),
    managerCall(
      encodeManager("setRecallLimits", [params.maxRecallPerCall, params.recall.capacity, params.recall.rate]),
    ),
    managerCall(encodeManager("setFundingOperator", [accounts.fundingOperator.address, true])),
    managerCall(encodeManager("setRecallOperator", [accounts.recallOperator.address, true])),
    managerCall(encodeManager("registerAdapter", [adapter, pool])),
  ]);
  await executeTimelockCall(handover);
  const adapterId = await checkHandover(client, addresses, accounts);

  // 5. Legacy reserves into the Manager.
  await legacyWrite(token, saharaTokenAbi, "transfer", [manager, params.managerReserves]);
  const readyBlock = await anvil.blockNumber();

  const balanceOf = (account: Address) =>
    client.readContract({address: token, abi: saharaTokenAbi, functionName: "balanceOf", args: [account]});
  const transferToken = async (from: LocalAccount, to: Address, amount: bigint) =>
    confirm(
      await wallet(from).writeContract({
        address: token,
        abi: saharaTokenAbi,
        functionName: "transfer",
        args: [to, amount],
      }),
    );
  // Typed against the generated ABIs at the call sites; the generic body goes through the untyped `Abi`.
  const write = async (from: LocalAccount, address: Address, abi: Abi, functionName: string, args: unknown) =>
    confirm(await wallet(from).writeContract({address, abi, functionName, args: args as readonly unknown[]}));
  const managerWrite = <fn extends ManagerFunction>(from: LocalAccount, functionName: fn, args: ManagerArgs<fn>) =>
    write(from, manager, liquidityManagerAbi as Abi, functionName, args);
  const controllerWrite = <fn extends ControllerFunction>(
    from: LocalAccount,
    functionName: fn,
    args: ControllerArgs<fn>,
  ) => write(from, controller, guardianControllerAbi as Abi, functionName, args);
  const timelockOp = async (data: Hex) => {
    const op = await scheduleTimelockCall(token, data);
    await executeTimelockCall(op);
    return op;
  };

  return {
    anvil,
    addresses,
    accounts,
    params,
    adapterId,
    firstBlock,
    readyBlock,
    handover,
    wallet,
    confirm,
    balanceOf,
    transferToken,

    fund: (amount, options = {}) => managerWrite(options.from ?? accounts.fundingOperator, "fund", [adapterId, amount]),
    recall: (amount, options = {}) =>
      managerWrite(options.from ?? accounts.recallOperator, "recall", [adapterId, amount]),

    guardianSuspendFundingOperator: (operator = accounts.fundingOperator.address, options = {}) =>
      managerWrite(options.from ?? accounts.guardian, "suspendFundingOperator", [operator]),
    guardianPauseFunding: (options = {}) => managerWrite(options.from ?? accounts.guardian, "pauseFunding", []),
    guardianRaisePoolMinimum: (minimum, options = {}) =>
      managerWrite(options.from ?? accounts.guardian, "raisePoolMinimum", [pool, minimum]),
    guardianLockdown: (options = {}) => controllerWrite(options.from ?? accounts.guardian, "lockdown", [pool]),
    guardianCancel: (op, options = {}) => {
      const from = options.from ?? accounts.guardian;
      const [first] = op.calls;
      if (!op.batch && first) {
        return controllerWrite(from, "cancel", [first.target, first.value, first.data, op.predecessor, op.salt]);
      }
      return controllerWrite(from, "cancelBatch", [
        op.calls.map((call) => call.target),
        op.calls.map((call) => call.value),
        op.calls.map((call) => call.data),
        op.predecessor,
        op.salt,
      ]);
    },

    scheduleTimelockCall,
    scheduleTimelockBatch,
    scheduleSetGuardian: (newGuardian, options = {}) =>
      scheduleTimelockCall(manager, encodeManager("setGuardian", [newGuardian]), {...options, value: 0n}),
    warpUntilReady,
    executeTimelockCall,
    operationState: (op) =>
      client.readContract({
        address: timelock,
        abi: saharaTimelockAbi,
        functionName: "getOperationState",
        args: [op.id],
      }),

    directTransferToPool: async (amount, options = {}) => {
      const from = options.from ?? accounts.attacker;
      const balance = await balanceOf(from.address);
      if (balance < amount) await transferToken(accounts.deployer, from.address, amount - balance);
      return transferToken(from, pool, amount);
    },
    transferOutOfPool: async (amount, options = {}) => {
      const from = options.from ?? accounts.attacker;
      const to = options.to ?? accounts.attacker.address;
      return confirm(
        await wallet(from).writeContract({
          address: pool,
          abi: mockPoolAbi,
          functionName: "simulateRelease",
          args: [to, amount],
        }),
      );
    },
    pauseToken: () => timelockOp(encodeFunctionData({abi: saharaTokenAbi, functionName: "pause"})),
    unpauseToken: () => timelockOp(encodeFunctionData({abi: saharaTokenAbi, functionName: "unpause"})),
  };
}

function walletFor(anvil: Anvil, account: LocalAccount) {
  return createWalletClient({account, chain: anvil.chain, transport: http(anvil.rpcUrl)});
}

type ManagerFunction = ContractFunctionName<typeof liquidityManagerAbi, "nonpayable">;
type ManagerArgs<fn extends ManagerFunction> = ContractFunctionArgs<typeof liquidityManagerAbi, "nonpayable", fn>;
type ControllerFunction = ContractFunctionName<typeof guardianControllerAbi, "nonpayable">;
type ControllerArgs<fn extends ControllerFunction> = ContractFunctionArgs<
  typeof guardianControllerAbi,
  "nonpayable",
  fn
>;

/** Calldata of a Manager call (typed against the generated ABI). */
export function encodeManager<fn extends ManagerFunction>(functionName: fn, args: ManagerArgs<fn>): Hex {
  return encodeFunctionData({
    abi: liquidityManagerAbi as Abi,
    functionName: functionName as string,
    args: args as readonly unknown[],
  });
}

function encodeAddress(address: Address): Hex {
  return encodeAbiParameters([{type: "address"}], [address]);
}

/** The post-deployment checks of Deploy.s.sol `_checkWiring`. */
async function checkWiring(
  client: Anvil["client"],
  a: DeployedAddresses,
  accounts: DevAccounts,
  params: DeployParams,
): Promise<void> {
  const timelock = {address: a.timelock, abi: saharaTimelockAbi} as const;
  const [admin, proposer, executor, canceller] = await Promise.all([
    client.readContract({...timelock, functionName: "DEFAULT_ADMIN_ROLE"}),
    client.readContract({...timelock, functionName: "PROPOSER_ROLE"}),
    client.readContract({...timelock, functionName: "EXECUTOR_ROLE"}),
    client.readContract({...timelock, functionName: "CANCELLER_ROLE"}),
  ]);
  const hasRole = (role: Hex, account: Address) =>
    client.readContract({...timelock, functionName: "hasRole", args: [role, account]});
  const manager = {address: a.manager, abi: liquidityManagerAbi} as const;
  const controller = {address: a.controller, abi: guardianControllerAbi} as const;
  const adapter = {address: a.adapter, abi: ccipPoolAdapterAbi} as const;
  const governance = accounts.governance.address;

  const checks: Array<[string, Promise<boolean>]> = [
    ["minimum delay", eq(client.readContract({...timelock, functionName: "MINIMUM_DELAY"}), params.minimumDelaySec)],
    ["maximum delay", eq(client.readContract({...timelock, functionName: "MAXIMUM_DELAY"}), params.maximumDelaySec)],
    ["delay", eq(client.readContract({...timelock, functionName: "getMinDelay"}), params.delaySec)],
    ["timelock is self-administered", hasRole(admin, a.timelock)],
    ["safe is proposer", hasRole(proposer, governance)],
    ["safe is executor", hasRole(executor, governance)],
    ["safe is canceller", hasRole(canceller, governance)],
    ["controller is canceller", hasRole(canceller, a.controller)],
    ["manager owner", eq(client.readContract({...manager, functionName: "owner"}), a.timelock)],
    ["manager guardian", eq(client.readContract({...manager, functionName: "guardian"}), accounts.guardian.address)],
    ["manager token", eq(client.readContract({...manager, functionName: "TOKEN"}), a.token)],
    ["manager registry", eq(client.readContract({...manager, functionName: "TOKEN_ADMIN_REGISTRY"}), a.registry)],
    ["controller manager", eq(client.readContract({...controller, functionName: "MANAGER"}), a.manager)],
    ["controller timelock", eq(client.readContract({...controller, functionName: "TIMELOCK"}), a.timelock)],
    ["adapter manager", eq(client.readContract({...adapter, functionName: "MANAGER"}), a.manager)],
    ["adapter token", eq(client.readContract({...adapter, functionName: "TOKEN"}), a.token)],
    ["adapter pool", eq(client.readContract({...adapter, functionName: "POOL"}), a.pool)],
  ];
  // The deployer, the Guardian and the controller hold no unexpected role (the controller only CANCELLER).
  for (const account of [accounts.deployer.address, accounts.guardian.address, a.controller]) {
    const roles = account === a.controller ? [admin, proposer, executor] : [admin, proposer, executor, canceller];
    for (const role of roles) checks.push([`no timelock role ${role} for ${account}`, not(hasRole(role, account))]);
  }
  await requireAll("deployment wiring", checks);
}

/** The end-state checks of HandoverPlan.simulate; returns the pool's adapter id. */
async function checkHandover(
  client: Anvil["client"],
  a: DeployedAddresses,
  accounts: DevAccounts,
): Promise<bigint> {
  const manager = {address: a.manager, abi: liquidityManagerAbi} as const;
  // Both revert with the Manager's custom error on any broken safeguard.
  await client.readContract({...manager, functionName: "verifyHandover"});
  const adapterId = await client.readContract({...manager, functionName: "adapterIdByPool", args: [a.pool]});
  if (adapterId === 0n) throw new Error("handover: adapter not registered");
  await client.readContract({...manager, functionName: "verifyAdapter", args: [adapterId]});
  const entry = await client.readContract({...manager, functionName: "getAdapter", args: [adapterId]});
  const pool = {address: a.pool, abi: mockPoolAbi} as const;
  await requireAll("handover", [
    ["registered adapter", Promise.resolve(getAddress(entry.adapter) === a.adapter)],
    ["pool owner", eq(client.readContract({...pool, functionName: "owner"}), a.timelock)],
    ["pool rebalancer", eq(client.readContract({...pool, functionName: "getRebalancer"}), a.adapter)],
    ["pool rateLimitAdmin", eq(client.readContract({...pool, functionName: "getRateLimitAdmin"}), a.controller)],
    [
      "funding operator",
      client.readContract({...manager, functionName: "isFundingOperator", args: [accounts.fundingOperator.address]}),
    ],
    [
      "recall operator",
      client.readContract({...manager, functionName: "isRecallOperator", args: [accounts.recallOperator.address]}),
    ],
    ["guardian is set", not(eq(client.readContract({...manager, functionName: "guardian"}), zeroAddress))],
  ]);
  return adapterId;
}

async function eq<T extends string | bigint>(actual: Promise<T>, expected: T): Promise<boolean> {
  const value = await actual;
  return typeof value === "string" ? value.toLowerCase() === String(expected).toLowerCase() : value === expected;
}

async function not(value: Promise<boolean>): Promise<boolean> {
  return !(await value);
}

async function requireAll(what: string, checks: Array<[string, Promise<boolean>]>): Promise<void> {
  const results = await Promise.all(checks.map(async ([name, ok]) => [name, await ok] as const));
  const failed = results.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) throw new Error(`${what} check failed: ${failed.join(", ")}`);
}

// --- Foundry artifacts ----------------------------------------------------------------------------------------------

interface Artifact {
  abi: Abi;
  bytecode: Hex;
  /** Selectors (hex without 0x) of every external function. */
  selectors: Set<string>;
}

const ARTIFACTS = [
  "MockSahara",
  "MockTokenAdminRegistry",
  "MockLockReleaseTokenPool",
  "SaharaTimelock",
  "LiquidityManager",
  "GuardianController",
  "CCIPPoolAdapter",
] as const;

const artifactCache = new Map<string, Artifact>();

function artifactPath(name: string): string {
  return join(OUT_DIR, `${name}.sol`, `${name}.json`);
}

/** Runs `forge build` in the repository root when an artifact is missing (CI builds them before the tests). */
export function ensureArtifacts(): void {
  if (ARTIFACTS.every((name) => existsSync(artifactPath(name)))) return;
  const result = spawnSync("forge", ["build"], {cwd: REPO_ROOT, encoding: "utf8", timeout: 600_000});
  if (result.error || result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-4000);
    throw new Error(`forge build in ${REPO_ROOT} failed: ${result.error?.message ?? output}`);
  }
  const missing = ARTIFACTS.filter((name) => !existsSync(artifactPath(name)));
  if (missing.length) throw new Error(`forge build produced no artifact for ${missing.join(", ")}`);
}

function loadArtifact(name: string): Artifact {
  const cached = artifactCache.get(name);
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(artifactPath(name), "utf8")) as {
    abi: Abi;
    bytecode: {object: Hex};
    methodIdentifiers: Record<string, string>;
  };
  const artifact: Artifact = {
    abi: raw.abi,
    bytecode: raw.bytecode.object,
    selectors: new Set(Object.values(raw.methodIdentifiers)),
  };
  artifactCache.set(name, artifact);
  return artifact;
}

/** Throws unless every function of `abi` exists in the compiled contract (catches drift in the copied fragments). */
function assertImplements(name: string, abi: Abi): void {
  const {selectors} = loadArtifact(name);
  for (const item of abi) {
    if (item.type !== "function") continue;
    if (!selectors.has(toFunctionSelector(item).slice(2))) {
      throw new Error(`${name} artifact has no function ${item.name}: the ABI fragment in deploy.ts is stale`);
    }
  }
}
