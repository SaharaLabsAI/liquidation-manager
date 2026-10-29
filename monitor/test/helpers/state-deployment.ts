// In-memory model of a correctly configured deployment (token, registry, router, pool, Manager, adapter, Timelock,
// GuardianController) and a fake viem client answering readContract from it, for the state rule tests. The Manager's
// verifyHandover/verifyAdapter mirror LiquidityManager._verifyHandover/_verifyPool and throw real viem revert errors.
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  getAddress,
  keccak256,
  numberToHex,
  padHex,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {liquidityManagerAbi} from "../../src/abi/generated.ts";
import {configSchema} from "../../src/config.ts";
import {silentLogger} from "../../src/log.ts";
import {stateRules} from "../../src/rules/state.ts";
import {createStore, type Store} from "../../src/store.ts";
import type {Alert, ChainContext, ResolvedAddresses, Severity, StateRule} from "../../src/types.ts";

export const sdAddr = (n: number): Address => getAddress(padHex(numberToHex(n), {size: 20}));

export const A = {
  token: sdAddr(0x5a10),
  registry: sdAddr(0x5a11),
  router: sdAddr(0x5a12),
  manager: sdAddr(0x5a13),
  timelock: sdAddr(0x5a14),
  controller: sdAddr(0x5a15),
  pool: sdAddr(0x5a20),
  pool2: sdAddr(0x5a21),
  adapter: sdAddr(0x5a30),
  adapter2: sdAddr(0x5a31),
  guardian: sdAddr(0x5a40),
  safe: sdAddr(0x5a41),
  fundingOperator: sdAddr(0x5a42),
  recallOperator: sdAddr(0x5a43),
  onRamp: sdAddr(0x5a50),
  offRamp: sdAddr(0x5a51),
  offRamp2: sdAddr(0x5a52),
  otherLaneOffRamp: sdAddr(0x5a53),
  remoteToken: sdAddr(0x5b10),
  remotePool: sdAddr(0x5b20),
  stranger: sdAddr(0x5a99),
} as const;

export const ETH = 5009297550715157269n;
export const BSC = 11344663589394136015n;
export const BLOCK = 21_000_000n;
export const CHAIN = "ethereum";

export const tokens = (whole: number | bigint): bigint => BigInt(whole) * 10n ** 18n;
/** ABI-encoded address, as pool specs and pools store remote tokens and pools. */
export const encodedAddress = (address: Address): Hex => encodeAbiParameters([{type: "address"}], [address]);

export const ROLE = {
  ADMIN: zeroHash,
  PROPOSER: keccak256(stringToHex("PROPOSER_ROLE")),
  EXECUTOR: keccak256(stringToHex("EXECUTOR_ROLE")),
  CANCELLER: keccak256(stringToHex("CANCELLER_ROLE")),
} as const;

export interface Bucket {
  tokens: bigint;
  lastUpdated: number;
  isEnabled: boolean;
  capacity: bigint;
  rate: bigint;
}

export interface PoolModel {
  owner: Address;
  rebalancer: Address;
  rateLimitAdmin: Address;
  router: Address;
  typeAndVersion: string;
  token: Address;
  chains: bigint[];
  remoteToken: Record<string, Hex>;
  remotePools: Record<string, Hex[]>;
  outbound: Record<string, Bucket>;
  inbound: Record<string, Bucket>;
}

export interface Spec {
  typeAndVersion: string;
  router: Address;
  remoteChainSelector: bigint;
  remoteToken: Hex;
  remotePools: Hex[];
  rateLimitAdmin: Address;
}

export interface Budget {
  capacity: bigint;
  rate: bigint;
  available: bigint;
}

export interface Deployment {
  token: {owner: Address; paused: boolean; balances: Record<string, bigint>; allowances: Record<string, bigint>};
  registry: {administrator: Address; pendingAdministrator: Address; tokenPool: Address};
  router: {onRamps: Record<string, Address>; offRamps: Array<{sourceChainSelector: bigint; offRamp: Address}>};
  pools: Record<string, PoolModel>;
  adapters: Record<string, {MANAGER: Address; TOKEN: Address; POOL: Address}>;
  manager: {
    owner: Address;
    pendingOwner: Address;
    guardian: Address;
    fundingPaused: boolean;
    recallPaused: boolean;
    maxFundingPerCall: bigint;
    maxRecallPerCall: bigint;
    fundingOperators: Address[];
    recallOperators: Address[];
    adapters: Array<{adapter: Address; pool: Address; fundingEnabled: boolean; recallEnabled: boolean}>;
    history: Address[];
    specs: Record<string, Spec>;
    thresholds: Record<string, {minimum: bigint; refillTrigger: bigint; refillTarget: bigint}>;
    migrationSources: Record<string, Address>;
    aggregate: Budget;
    recall: Budget;
    poolBudgets: Record<string, Budget>;
  };
  timelock: {minDelay: bigint; roles: Record<string, Address[]>};
  controller: {MANAGER: Address; TIMELOCK: Address};
  /** `${lowercase address}.${functionName}` -> value thrown instead of answering (RPC failures, crafted reverts). */
  failures: Record<string, unknown>;
}

const lower = (address: string) => address.toLowerCase();

export function bucket(capacity: bigint, rate: bigint, isEnabled = true): Bucket {
  return {tokens: capacity, lastUpdated: 1_700_000_000, isEnabled, capacity, rate};
}

/** The deployment after the handover, with every authority where the design wants it. */
export function deployment(): Deployment {
  const spec: Spec = {
    typeAndVersion: "LockReleaseTokenPool 1.6.3-dev",
    router: A.router,
    remoteChainSelector: BSC,
    remoteToken: encodedAddress(A.remoteToken),
    remotePools: [encodedAddress(A.remotePool)],
    rateLimitAdmin: A.controller,
  };
  return {
    token: {
      owner: A.timelock,
      paused: false,
      balances: {[lower(A.pool)]: tokens(8_000_000), [lower(A.manager)]: tokens(100_000_000)},
      allowances: {},
    },
    registry: {administrator: A.timelock, pendingAdministrator: zeroAddress, tokenPool: A.pool},
    router: {
      onRamps: {[BSC.toString()]: A.onRamp},
      offRamps: [
        {sourceChainSelector: BSC, offRamp: A.offRamp},
        {sourceChainSelector: 999n, offRamp: A.otherLaneOffRamp},
      ],
    },
    pools: {
      [lower(A.pool)]: {
        owner: A.timelock,
        rebalancer: A.adapter,
        rateLimitAdmin: A.controller,
        router: A.router,
        typeAndVersion: "LockReleaseTokenPool 1.6.3-dev",
        token: A.token,
        chains: [BSC],
        remoteToken: {[BSC.toString()]: encodedAddress(A.remoteToken)},
        remotePools: {[BSC.toString()]: [encodedAddress(A.remotePool)]},
        outbound: {[BSC.toString()]: bucket(tokens(1_000_000), tokens(100))},
        inbound: {[BSC.toString()]: bucket(tokens(1_000_000), tokens(100))},
      },
    },
    adapters: {[lower(A.adapter)]: {MANAGER: A.manager, TOKEN: A.token, POOL: A.pool}},
    manager: {
      owner: A.timelock,
      pendingOwner: zeroAddress,
      guardian: A.guardian,
      fundingPaused: false,
      recallPaused: false,
      maxFundingPerCall: tokens(2_000_000),
      maxRecallPerCall: tokens(2_000_000),
      fundingOperators: [A.fundingOperator],
      recallOperators: [A.recallOperator],
      adapters: [{adapter: A.adapter, pool: A.pool, fundingEnabled: true, recallEnabled: true}],
      history: [A.adapter],
      specs: {[lower(A.pool)]: spec},
      thresholds: {
        [lower(A.pool)]: {
          minimum: tokens(1_000_000),
          refillTrigger: tokens(5_000_000),
          refillTarget: tokens(10_000_000),
        },
      },
      migrationSources: {},
      aggregate: {capacity: tokens(10_000_000), rate: tokens(10), available: tokens(10_000_000)},
      recall: {capacity: tokens(5_000_000), rate: tokens(10), available: tokens(5_000_000)},
      poolBudgets: {[lower(A.pool)]: {capacity: tokens(10_000_000), rate: tokens(10), available: tokens(9_000_000)}},
    },
    timelock: {
      minDelay: 172_800n,
      roles: {
        [ROLE.ADMIN]: [A.timelock],
        [ROLE.PROPOSER]: [A.safe],
        [ROLE.EXECUTOR]: [A.safe],
        [ROLE.CANCELLER]: [A.safe, A.controller],
      },
    },
    controller: {MANAGER: A.manager, TIMELOCK: A.timelock},
    failures: {},
  };
}

export function pool(model: Deployment, address: Address = A.pool): PoolModel {
  const entry = model.pools[lower(address)];
  if (!entry) throw new Error(`no pool ${address} in the model`);
  return entry;
}

/**
 * Registers a replacement pool (adapter #2) with the same spec, thresholds and budget as the first one, pre-funded,
 * and approved for migration from the current registry pool (README "Pool migration").
 */
export function addMigrationTarget(model: Deployment, newPool: Address, newAdapter: Address, balance: bigint): void {
  const source = pool(model);
  model.pools[lower(newPool)] = {
    ...structuredClone(source),
    rebalancer: newAdapter,
  };
  model.adapters[lower(newAdapter)] = {MANAGER: A.manager, TOKEN: A.token, POOL: newPool};
  model.manager.adapters.push({adapter: newAdapter, pool: newPool, fundingEnabled: true, recallEnabled: true});
  model.manager.history.push(newAdapter);
  const spec = model.manager.specs[lower(A.pool)];
  const thresholds = model.manager.thresholds[lower(A.pool)];
  const budget = model.manager.poolBudgets[lower(A.pool)];
  if (!spec || !thresholds || !budget) throw new Error("fixture");
  model.manager.specs[lower(newPool)] = structuredClone(spec);
  model.manager.thresholds[lower(newPool)] = {...thresholds};
  model.manager.poolBudgets[lower(newPool)] = {...budget};
  model.manager.migrationSources[lower(newPool)] = model.registry.tokenPool;
  model.token.balances[lower(newPool)] = balance;
}

export function grant(model: Deployment, role: Hex, account: Address): void {
  (model.timelock.roles[role] ??= []).push(account);
}

export function revoke(model: Deployment, role: Hex, account: Address): void {
  model.timelock.roles[role] = (model.timelock.roles[role] ?? []).filter((a) => lower(a) !== lower(account));
}

/** The error viem's readContract throws for a revert with a Manager custom error. */
export function managerRevert(functionName: string, errorName: string, args: readonly unknown[]): Error {
  const data = encodeErrorResult({abi: liquidityManagerAbi, errorName, args} as never);
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({abi: liquidityManagerAbi, data, functionName}),
    {abi: liquidityManagerAbi, functionName, args: [], contractAddress: A.manager},
  );
}

export interface FakeClient {
  client: PublicClient;
  reads: Array<{address: Address; functionName: string; args: readonly unknown[]}>;
}

/** readContract over the model; reads at any block other than `expectBlock` fail. */
export function stateClient(model: Deployment, expectBlock: bigint = BLOCK): FakeClient {
  const reads: FakeClient["reads"] = [];
  const readContract = async (params: {
    address: Address;
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown> => {
    const args = params.args ?? [];
    reads.push({address: params.address, functionName: params.functionName, args});
    if (params.blockNumber !== expectBlock) {
      throw new Error(`${params.functionName} read at block ${params.blockNumber}, expected ${expectBlock}`);
    }
    const failure = model.failures[`${lower(params.address)}.${params.functionName}`];
    if (failure !== undefined) throw failure;
    return answer(model, lower(params.address), params.functionName, args);
  };
  return {client: {readContract} as unknown as PublicClient, reads};
}

function answer(model: Deployment, address: string, fn: string, args: readonly unknown[]): unknown {
  const arg = (i: number) => args[i];
  const addressArg = (i: number) => lower(String(args[i]));
  if (address === lower(A.token)) {
    switch (fn) {
      case "owner":
        return model.token.owner;
      case "paused":
        return model.token.paused;
      case "balanceOf":
        return model.token.balances[addressArg(0)] ?? 0n;
      case "allowance":
        return model.token.allowances[`${addressArg(0)}:${addressArg(1)}`] ?? 0n;
    }
  }
  if (address === lower(A.registry) && fn === "getTokenConfig" && addressArg(0) === lower(A.token)) {
    return {...model.registry};
  }
  if (address === lower(A.router)) {
    if (fn === "getOnRamp") return model.router.onRamps[String(arg(0))] ?? zeroAddress;
    if (fn === "getOffRamps") return model.router.offRamps.map((entry) => ({...entry}));
  }
  const poolModel = model.pools[address];
  if (poolModel) return answerPool(poolModel, fn, args);
  if (address === lower(A.manager)) return answerManager(model, fn, args);
  if (address === lower(A.timelock)) {
    if (fn === "getMinDelay") return model.timelock.minDelay;
    if (fn === "hasRole") {
      return (model.timelock.roles[String(arg(0))] ?? []).some((holder) => lower(holder) === addressArg(1));
    }
  }
  if (address === lower(A.controller)) {
    if (fn === "MANAGER") return model.controller.MANAGER;
    if (fn === "TIMELOCK") return model.controller.TIMELOCK;
  }
  throw new Error(`execution reverted: unexpected read ${address}.${fn}`);
}

function answerPool(pool: PoolModel, fn: string, args: readonly unknown[]): unknown {
  const selector = String(args[0]);
  // A chain the pool does not support answers the zero struct, as the CCIP pool does.
  const empty: Bucket = {tokens: 0n, lastUpdated: 0, isEnabled: false, capacity: 0n, rate: 0n};
  switch (fn) {
    case "owner":
      return pool.owner;
    case "getRebalancer":
      return pool.rebalancer;
    case "getRateLimitAdmin":
      return pool.rateLimitAdmin;
    case "getRouter":
      return pool.router;
    case "typeAndVersion":
      return pool.typeAndVersion;
    case "getToken":
      return pool.token;
    case "getSupportedChains":
      return [...pool.chains];
    case "getRemoteToken":
      return pool.remoteToken[selector] ?? "0x";
    case "getRemotePools":
      return [...(pool.remotePools[selector] ?? [])];
    case "getCurrentOutboundRateLimiterState":
      return {...(pool.outbound[selector] ?? empty)};
    case "getCurrentInboundRateLimiterState":
      return {...(pool.inbound[selector] ?? empty)};
  }
  throw new Error(`execution reverted: unexpected pool read ${fn}`);
}

function answerManager(model: Deployment, fn: string, args: readonly unknown[]): unknown {
  const m = model.manager;
  const poolKey = lower(String(args[0]));
  switch (fn) {
    case "owner":
      return m.owner;
    case "pendingOwner":
      return m.pendingOwner;
    case "guardian":
      return m.guardian;
    case "fundingPaused":
      return m.fundingPaused;
    case "recallPaused":
      return m.recallPaused;
    case "maxFundingPerCall":
      return m.maxFundingPerCall;
    case "maxRecallPerCall":
      return m.maxRecallPerCall;
    case "isFundingOperator":
      return m.fundingOperators.some((op) => lower(op) === poolKey);
    case "isRecallOperator":
      return m.recallOperators.some((op) => lower(op) === poolKey);
    case "getAggregateFundingBudget":
      return {...m.aggregate};
    case "getRecallBudget":
      return {...m.recall};
    case "getPoolFundingBudget":
      return {...(m.poolBudgets[poolKey] ?? {capacity: 0n, rate: 0n, available: 0n})};
    case "getPoolSpec": {
      const spec = m.specs[poolKey];
      if (spec) return [{...spec, remotePools: [...spec.remotePools]}, true];
      const unset = {typeAndVersion: "", router: zeroAddress, remoteChainSelector: 0n, remoteToken: "0x"};
      return [{...unset, remotePools: [], rateLimitAdmin: zeroAddress}, false];
    }
    case "getPoolThresholds": {
      const thresholds = m.thresholds[poolKey];
      return thresholds ? [{...thresholds}, true] : [{minimum: 0n, refillTrigger: 0n, refillTarget: 0n}, false];
    }
    case "verifyHandover":
      verifyHandover(model);
      return undefined;
    case "verifyAdapter": {
      const id = BigInt(args[0] as bigint);
      const entry = id >= 1n && id <= BigInt(m.adapters.length) ? m.adapters[Number(id) - 1] : undefined;
      if (!entry) throw managerRevert("verifyAdapter", "UnknownAdapter", [id]);
      verifyPool(model, entry.adapter, entry.pool);
      return undefined;
    }
  }
  throw new Error(`execution reverted: unexpected Manager read ${fn}`);
}

/** LiquidityManager._verifyHandover. */
function verifyHandover(model: Deployment): void {
  const governance = lower(model.manager.owner);
  const {administrator, pendingAdministrator} = model.registry;
  const fail = (errorName: string, args: unknown[]) => managerRevert("verifyHandover", errorName, args);
  if (lower(administrator) !== governance) throw fail("RegistryAdminMismatch", [administrator]);
  if (lower(pendingAdministrator) !== zeroAddress) throw fail("RegistryAdminTransferPending", [pendingAdministrator]);
  if (lower(model.token.owner) !== governance) throw fail("TokenOwnerMismatch", [model.token.owner]);
}

/** LiquidityManager._verifyPool, in the contract's order. */
function verifyPool(model: Deployment, adapter: Address, poolAddress: Address): void {
  const fail = (errorName: string, args: unknown[]) => managerRevert("verifyAdapter", errorName, args);
  const spec = model.manager.specs[lower(poolAddress)];
  if (!spec) throw fail("PoolSpecNotSet", [poolAddress]);
  const bound = model.adapters[lower(adapter)];
  if (!bound) throw fail("NotAContract", [adapter]);
  const p = model.pools[lower(poolAddress)];
  if (!p) throw fail("NotAContract", [poolAddress]);
  const bindings: Array<[Address, Address]> = [
    [bound.MANAGER, A.manager],
    [bound.TOKEN, A.token],
    [bound.POOL, poolAddress],
  ];
  if (bindings.some(([actual, wanted]) => lower(actual) !== lower(wanted))) {
    throw fail("AdapterBindingMismatch", [adapter]);
  }
  if (lower(p.token) !== lower(A.token)) throw fail("PoolTokenMismatch", [poolAddress, p.token]);
  if (p.typeAndVersion !== spec.typeAndVersion) throw fail("PoolVersionMismatch", [poolAddress, p.typeAndVersion]);
  const registryPool = model.registry.tokenPool;
  if (lower(registryPool) !== lower(poolAddress)) {
    const source = model.manager.migrationSources[lower(poolAddress)];
    if (!source || lower(registryPool) !== lower(source)) {
      throw fail("PoolNotActiveInRegistry", [poolAddress, registryPool]);
    }
  }
  if (lower(p.rebalancer) !== lower(adapter)) throw fail("PoolRebalancerMismatch", [poolAddress, p.rebalancer]);
  if (lower(p.router) !== lower(spec.router)) throw fail("PoolRouterMismatch", [poolAddress, p.router]);
  const remote = spec.remoteChainSelector;
  if (p.chains.length !== 1 || p.chains[0] !== remote) throw fail("PoolChainsMismatch", [poolAddress]);
  if (lower(p.remoteToken[remote.toString()] ?? "0x") !== lower(spec.remoteToken)) {
    throw fail("PoolRemoteTokenMismatch", [poolAddress]);
  }
  const remotePools = (p.remotePools[remote.toString()] ?? []).map(lower);
  const missing = spec.remotePools.some((remotePool) => !remotePools.includes(lower(remotePool)));
  if (remotePools.length !== spec.remotePools.length || missing) throw fail("PoolRemotePoolsMismatch", [poolAddress]);
  if (lower(p.owner) !== lower(model.manager.owner)) throw fail("PoolOwnerMismatch", [poolAddress, p.owner]);
  if (lower(p.rateLimitAdmin) !== lower(spec.rateLimitAdmin)) {
    throw fail("PoolRateLimitAdminMismatch", [poolAddress, p.rateLimitAdmin]);
  }
}

/** What resolveAddresses would produce for the model (registry pool first, labels as in src/chain/addresses.ts). */
export function addressesFor(model: Deployment, opts: {withManager?: boolean} = {}): ResolvedAddresses {
  const withManager = opts.withManager ?? true;
  const adapters = withManager
    ? model.manager.adapters.map((entry, i) => ({id: BigInt(i + 1), ...entry}))
    : [];
  const registryPool = model.registry.tokenPool;
  const pools: Address[] = [];
  for (const candidate of [...adapters.map((entry) => entry.pool), registryPool, A.pool]) {
    if (lower(candidate) === zeroAddress || pools.some((p) => lower(p) === lower(candidate))) continue;
    pools.push(getAddress(candidate));
  }
  const labels: Record<string, string> = {};
  const add = (address: Address, label: string) => {
    labels[lower(address)] ??= label;
  };
  add(A.token, "Token");
  add(A.registry, "Registry");
  add(A.router, "Router");
  if (withManager) {
    add(A.manager, "Manager");
    add(A.timelock, "Timelock");
    add(A.controller, "GuardianController");
  }
  const primary = lower(registryPool) === zeroAddress ? A.pool : registryPool;
  for (const p of pools) {
    const adapter = adapters.find((entry) => lower(entry.pool) === lower(p));
    add(p, lower(p) === lower(primary) ? "Pool" : adapter ? `Pool (adapter #${adapter.id})` : "Retired pool");
  }
  adapters.forEach((entry) => add(entry.adapter, `Adapter #${entry.id}`));
  if (withManager) add(model.manager.guardian, "Guardian");
  add(A.guardian, "Expected Guardian");
  add(A.safe, "Governance Safe");
  add(A.fundingOperator, "Funding operator");
  add(A.recallOperator, "Recall operator");
  const history = withManager ? model.manager.history : [];
  return {
    token: A.token,
    registry: A.registry,
    router: A.router,
    manager: withManager ? A.manager : undefined,
    timelock: withManager ? A.timelock : undefined,
    controller: withManager ? A.controller : undefined,
    registryPool: getAddress(registryPool),
    adapters,
    adapterHistory: history,
    pools,
    legacyWallets: [],
    endpoints: [...(withManager ? [A.manager] : []), ...history, ...pools],
    labels,
  };
}

/** The `expected` block of a correctly configured Manager-era chain. */
export function expectedConfig(): Record<string, unknown> {
  return {
    governanceSafe: A.safe,
    guardian: A.guardian,
    fundingOperators: [A.fundingOperator],
    recallOperators: [A.recallOperator],
    timelockDelaySec: 172_800,
    timelockRoles: {
      admins: ["timelock"],
      proposers: ["governanceSafe"],
      executors: ["governanceSafe"],
      cancellers: ["governanceSafe", "controller"],
    },
    onRamp: A.onRamp,
    offRamps: [A.offRamp],
    rateLimits: {
      outbound: {enabled: true, capacity: "1000000", rate: "100"},
      inbound: {enabled: true, capacity: "1_000_000", rate: 100},
    },
  };
}

export interface StateContextOptions {
  /** Default true: contracts.manager/timelock configured and addresses resolved with the Manager. */
  withManager?: boolean;
  expected?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  store?: Store;
}

export interface StateHarness {
  ctx: ChainContext;
  reads: FakeClient["reads"];
}

export function stateContext(model: Deployment, opts: StateContextOptions = {}): StateHarness {
  const withManager = opts.withManager ?? true;
  const contracts: Record<string, string> = {token: A.token, registry: A.registry, pool: A.pool};
  if (withManager) Object.assign(contracts, {manager: A.manager, timelock: A.timelock});
  const config = configSchema.parse({
    chains: {
      [CHAIN]: {
        chainId: 1,
        chainSelector: ETH.toString(),
        rpcUrls: ["http://localhost:8545"],
        explorerUrl: "https://etherscan.io",
        contracts,
        expected: opts.expected ?? (withManager ? expectedConfig() : {}),
        limits: opts.limits,
      },
      bsc: {
        chainId: 56,
        chainSelector: BSC.toString(),
        rpcUrls: ["http://localhost:8546"],
        explorerUrl: "https://bscscan.com",
        contracts: {token: A.token, registry: A.registry},
      },
    },
  });
  const chain = config.chains[CHAIN];
  if (!chain) throw new Error("fixture config");
  const addresses = addressesFor(model, {withManager});
  const {client, reads} = stateClient(model);
  const ctx: ChainContext = {
    name: CHAIN,
    config: chain,
    global: config,
    client,
    explorer: {tx: (hash) => `https://etherscan.io/tx/${hash}`, address: (a) => `https://etherscan.io/address/${a}`},
    alerter: {emit: () => {}, sync: () => {}, resolve: () => {}},
    store: opts.store ?? createStore(),
    log: silentLogger,
    addresses,
    label: (address: Address) => addresses.labels[lower(address)] ?? getAddress(address),
  };
  return {ctx, reads};
}

export interface RunResult {
  conditions: Alert[];
  /** key -> severity, for exact assertions. */
  keys: Record<string, Severity>;
  snapshots: Record<string, Record<string, string>>;
}

/** Runs the rules like the daemon does and checks every key is inside the rule's sync scope. */
export async function runRules(
  ctx: ChainContext,
  rules: StateRule[] = stateRules,
  blockNumber = BLOCK,
): Promise<RunResult> {
  const conditions: Alert[] = [];
  const snapshots: Record<string, Record<string, string>> = {};
  for (const rule of rules) {
    const result = await rule.check(ctx, blockNumber);
    for (const alert of result.conditions) {
      if (!alert.key.startsWith(`${ctx.name}:${rule.id}:`)) {
        throw new Error(`key ${alert.key} outside ${rule.id} scope`);
      }
      if (alert.kind !== "condition") throw new Error(`${alert.key} is not a condition`);
    }
    conditions.push(...result.conditions);
    snapshots[rule.id] = result.snapshot;
  }
  const keys = Object.fromEntries(conditions.map((alert) => [alert.key, alert.severity]));
  return {conditions, keys, snapshots};
}

/** `${chain}:${rule}:${subject}` */
export const key = (rule: string, subject: string): string => `${CHAIN}:${rule}:${subject}`;
export const lc = lower;
