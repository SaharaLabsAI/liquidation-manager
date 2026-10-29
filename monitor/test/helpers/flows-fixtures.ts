// Fixtures for the flow rule tests: known addresses, a ChainContext with a recording alerter, ABI-encoded logs, and
// builders for the exact log sequences of Manager.fund/recall/migrateReserves, CCIP lock/release and
// transferLiquidity (OZ v5 token: transferFrom spends the allowance without an Approval event).
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  keccak256,
  pad,
  parseUnits,
  toHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";

import {saharaTokenAbi, tokenPoolAbi} from "../../src/abi/external.ts";
import {liquidityManagerAbi} from "../../src/abi/generated.ts";
import {configSchema} from "../../src/config.ts";
import {silentLogger, type Logger} from "../../src/log.ts";
import {createStore, type Store} from "../../src/store.ts";
import type {Alert, ChainContext, ResolvedAddresses} from "../../src/types.ts";

export const flAddr = (n: number): Address => getAddress(pad(toHex(n), {size: 20}));

export const FL = {
  token: flAddr(0x10),
  registry: flAddr(0x11),
  manager: flAddr(0x12),
  timelock: flAddr(0x13),
  controller: flAddr(0x14),
  router: flAddr(0x15),
  pool: flAddr(0x20),
  newPool: flAddr(0x21),
  adapter: flAddr(0x30),
  oldAdapter: flAddr(0x31),
  legacy: flAddr(0x50),
  extra: flAddr(0x51),
  operator: flAddr(0x60),
  onRamp: flAddr(0x70),
  offRamp: flAddr(0x71),
  user: flAddr(0x80),
  stranger: flAddr(0x99),
} as const;

export const ETH_SELECTOR = 5009297550715157269n;
export const BSC_SELECTOR = 11344663589394136015n;

/** Whole SAHARA to base units. */
export const tokens = (value: string | number): bigint => parseUnits(String(value), 18);

export function flAddresses(overrides: Partial<ResolvedAddresses> = {}): ResolvedAddresses {
  const labels: Record<string, string> = {
    [FL.token.toLowerCase()]: "Token",
    [FL.registry.toLowerCase()]: "Registry",
    [FL.manager.toLowerCase()]: "Manager",
    [FL.timelock.toLowerCase()]: "Timelock",
    [FL.controller.toLowerCase()]: "GuardianController",
    [FL.router.toLowerCase()]: "Router",
    [FL.pool.toLowerCase()]: "Pool",
    [FL.newPool.toLowerCase()]: "Pool 2",
    [FL.adapter.toLowerCase()]: "Adapter #1",
    [FL.oldAdapter.toLowerCase()]: "Adapter (retired)",
    [FL.legacy.toLowerCase()]: "Legacy wallet 1",
    [FL.extra.toLowerCase()]: "Endpoint 1",
  };
  return {
    token: FL.token,
    registry: FL.registry,
    router: FL.router,
    manager: FL.manager,
    timelock: FL.timelock,
    controller: FL.controller,
    registryPool: FL.pool,
    adapters: [{id: 1n, adapter: FL.adapter, pool: FL.pool, fundingEnabled: true, recallEnabled: true}],
    adapterHistory: [FL.oldAdapter, FL.adapter],
    pools: [FL.pool, FL.newPool],
    legacyWallets: [FL.legacy],
    endpoints: [FL.manager, FL.oldAdapter, FL.adapter, FL.pool, FL.newPool, FL.legacy, FL.extra],
    labels,
    ...overrides,
  };
}

export interface FlowsLimits {
  largeTransfer?: string;
  outflowWindowSec?: number;
  outflowWindowAmount?: string;
}

export function flConfig(limits: FlowsLimits = {}) {
  return configSchema.parse({
    chains: {
      ethereum: {
        chainId: 1,
        chainSelector: ETH_SELECTOR.toString(),
        rpcUrls: ["http://localhost:8545"],
        explorerUrl: "https://etherscan.io",
        contracts: {token: FL.token, registry: FL.registry, manager: FL.manager},
        limits,
      },
      bsc: {
        chainId: 56,
        chainSelector: BSC_SELECTOR.toString(),
        rpcUrls: ["http://localhost:8546"],
        explorerUrl: "https://bscscan.com",
        contracts: {token: FL.token, registry: FL.registry},
      },
    },
  });
}

export interface SyncCall {
  scope: string;
  active: Alert[];
}

export interface RecordingAlerter {
  emitted: Alert[];
  syncs: SyncCall[];
  resolved: string[];
  /** Conditions currently open, as the alert manager would track them from emit/sync/resolve. */
  open: Map<string, Alert>;
  emit(alert: Alert): void;
  sync(scope: string, active: Alert[]): void;
  resolve(key: string): void;
}

export function recordingAlerter(): RecordingAlerter {
  const alerter: RecordingAlerter = {
    emitted: [],
    syncs: [],
    resolved: [],
    open: new Map(),
    emit(alert) {
      alerter.emitted.push(alert);
      if (alert.kind === "condition") alerter.open.set(alert.key, alert);
    },
    sync(scope, active) {
      alerter.syncs.push({scope, active});
      const keys = new Set(active.map((alert) => alert.key));
      for (const key of [...alerter.open.keys()]) {
        if (key.startsWith(scope) && !keys.has(key)) alerter.resolve(key);
      }
      for (const alert of active) alerter.open.set(alert.key, alert);
    },
    resolve(key) {
      if (alerter.open.delete(key)) alerter.resolved.push(key);
    },
  };
  return alerter;
}

/** Default block time: 12 s blocks from 1_700_000_000. */
export const blockTime = (blockNumber: bigint) => 1_700_000_000 + Number(blockNumber) * 12;

export interface FakeClientOptions {
  timestamp?: (blockNumber: bigint) => number;
  failGetBlock?: boolean;
}

/** A client with only `getBlock`; records the blocks requested. */
export function fakeClient(opts: FakeClientOptions = {}): PublicClient & {blocks: bigint[]} {
  const blocks: bigint[] = [];
  const client = {
    blocks,
    async getBlock({blockNumber}: {blockNumber: bigint}) {
      blocks.push(blockNumber);
      if (opts.failGetBlock) throw new Error("getBlock failed");
      return {number: blockNumber, timestamp: BigInt((opts.timestamp ?? blockTime)(blockNumber))};
    },
  };
  return client as unknown as PublicClient & {blocks: bigint[]};
}

export interface WarnRecord {
  message: string;
  fields?: Record<string, unknown>;
}

export function recordingLogger(): Logger & {warnings: WarnRecord[]} {
  const warnings: WarnRecord[] = [];
  const logger = {
    ...silentLogger,
    warnings,
    warn: (message: string, fields?: Record<string, unknown>) => warnings.push({message, fields}),
    child: () => logger,
  };
  return logger;
}

export interface FlowsContextOptions {
  limits?: FlowsLimits;
  addresses?: Partial<ResolvedAddresses>;
  store?: Store;
  client?: PublicClient;
  alerter?: RecordingAlerter;
}

export type FlowsContext = ChainContext & {
  alerter: RecordingAlerter;
  log: ReturnType<typeof recordingLogger>;
};

export function flContext(opts: FlowsContextOptions = {}): FlowsContext {
  const global = flConfig(opts.limits);
  const addresses = flAddresses(opts.addresses);
  return {
    name: "ethereum",
    config: global.chains.ethereum!,
    global,
    client: opts.client ?? fakeClient(),
    explorer: {
      tx: (hash: Hex) => `https://etherscan.io/tx/${hash}`,
      address: (address: Address) => `https://etherscan.io/address/${address}`,
    },
    alerter: opts.alerter ?? recordingAlerter(),
    store: opts.store ?? createStore(),
    log: recordingLogger(),
    addresses,
    label: (address: Address) => addresses.labels[address.toLowerCase()] ?? getAddress(address),
  };
}

// ----------------------------------------------------------------------------------------------------------------
// Logs
// ----------------------------------------------------------------------------------------------------------------

export const txHash = (n: number): Hex => keccak256(toHex(`flows-tx-${n}`));

/** A log of `eventName` on `abi`, encoded exactly as the contract emits it (indexed args in topics). */
export function eventLog(
  abi: Abi,
  address: Address,
  eventName: string,
  args: Record<string, unknown>,
  pos: {txHash: Hex; blockNumber: bigint; logIndex: number; blockTimestamp?: number},
): Log {
  const item = getAbiItem({abi, name: eventName} as never) as AbiEvent;
  const indexedArgs: Record<string, unknown> = {};
  for (const input of item.inputs) if (input.indexed && input.name) indexedArgs[input.name] = args[input.name];
  const topics = encodeEventTopics({abi: [item], eventName, args: indexedArgs} as never) as Hex[];
  const nonIndexed = item.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(
    nonIndexed,
    nonIndexed.map((input) => args[input.name ?? ""]),
  );
  const log = {
    address: address.toLowerCase() as Address,
    blockHash: keccak256(toHex(`block-${pos.blockNumber}`)),
    blockNumber: pos.blockNumber,
    data,
    logIndex: pos.logIndex,
    transactionHash: pos.txHash,
    transactionIndex: 0,
    removed: false,
    topics: topics as [Hex, ...Hex[]],
  } as Log;
  if (pos.blockTimestamp !== undefined) Object.assign(log, {blockTimestamp: toHex(pos.blockTimestamp)});
  return log;
}

/**
 * Builds the logs of one transaction with sequential log indices. Composite helpers append the exact sequence the
 * contracts emit.
 */
export class TxBuilder {
  readonly logs: Log[] = [];
  readonly hash: Hex;
  readonly blockNumber: bigint;
  #nextIndex: number;
  #blockTimestamp: number | undefined;

  constructor(n: number, blockNumber: bigint, opts: {firstLogIndex?: number; blockTimestamp?: number} = {}) {
    this.hash = txHash(n);
    this.blockNumber = blockNumber;
    this.#nextIndex = opts.firstLogIndex ?? 0;
    this.#blockTimestamp = opts.blockTimestamp;
  }

  #push(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>): this {
    this.logs.push(
      eventLog(abi, address, eventName, args, {
        txHash: this.hash,
        blockNumber: this.blockNumber,
        logIndex: this.#nextIndex++,
        ...(this.#blockTimestamp !== undefined ? {blockTimestamp: this.#blockTimestamp} : {}),
      }),
    );
    return this;
  }

  // Token
  transfer(from: Address, to: Address, value: bigint): this {
    return this.#push(saharaTokenAbi, FL.token, "Transfer", {from, to, value});
  }
  approval(owner: Address, spender: Address, value: bigint): this {
    return this.#push(saharaTokenAbi, FL.token, "Approval", {owner, spender, value});
  }

  // Manager
  fundedEvent(amount: bigint, o: {adapterId?: bigint; pool?: Address; adapter?: Address} = {}): this {
    return this.#push(liquidityManagerAbi as Abi, FL.manager, "Funded", {
      adapterId: o.adapterId ?? 1n,
      pool: o.pool ?? FL.pool,
      operator: FL.operator,
      adapter: o.adapter ?? FL.adapter,
      amount,
    });
  }
  recalledEvent(amount: bigint, o: {adapterId?: bigint; pool?: Address; adapter?: Address} = {}): this {
    return this.#push(liquidityManagerAbi as Abi, FL.manager, "Recalled", {
      adapterId: o.adapterId ?? 1n,
      pool: o.pool ?? FL.pool,
      operator: FL.operator,
      adapter: o.adapter ?? FL.adapter,
      amount,
    });
  }
  reservesMigrated(to: Address, amount: bigint): this {
    return this.#push(liquidityManagerAbi as Abi, FL.manager, "ReservesMigrated", {to, amount});
  }
  guardianAction(selector: Hex): this {
    return this.#push(liquidityManagerAbi as Abi, FL.manager, "GuardianAction", {guardian: FL.stranger, selector});
  }

  // Pool
  liquidityAdded(pool: Address, provider: Address, amount: bigint): this {
    return this.#push(tokenPoolAbi, pool, "LiquidityAdded", {provider, amount});
  }
  liquidityRemoved(pool: Address, provider: Address, amount: bigint): this {
    return this.#push(tokenPoolAbi, pool, "LiquidityRemoved", {provider, amount});
  }
  liquidityTransferred(pool: Address, from: Address, amount: bigint): this {
    return this.#push(tokenPoolAbi, pool, "LiquidityTransferred", {from, amount});
  }
  lockedOrBurned(pool: Address, amount: bigint, remote = BSC_SELECTOR, token: Address = FL.token): this {
    this.#push(tokenPoolAbi, pool, "OutboundRateLimitConsumed", {remoteChainSelector: remote, token, amount});
    return this.#push(tokenPoolAbi, pool, "LockedOrBurned", {
      remoteChainSelector: remote,
      token,
      sender: FL.onRamp,
      amount,
    });
  }
  releasedOrMinted(pool: Address, recipient: Address, amount: bigint, remote = BSC_SELECTOR): this {
    return this.#push(tokenPoolAbi, pool, "ReleasedOrMinted", {
      remoteChainSelector: remote,
      token: FL.token,
      sender: FL.offRamp,
      recipient,
      amount,
    });
  }

  // Composite operations

  /**
   * Manager.fund: safeTransfer Manager -> adapter; adapter.fund: forceApprove(pool, amount), pool.provideLiquidity
   * (transferFrom adapter -> pool, no Approval in OZ v5, then LiquidityAdded), forceApprove(pool, 0); then Funded.
   */
  fund(amount: bigint, o: {adapter?: Address; pool?: Address; adapterId?: bigint} = {}): this {
    const adapter = o.adapter ?? FL.adapter;
    const pool = o.pool ?? FL.pool;
    return this.transfer(FL.manager, adapter, amount)
      .approval(adapter, pool, amount)
      .transfer(adapter, pool, amount)
      .liquidityAdded(pool, adapter, amount)
      .approval(adapter, pool, 0n)
      .fundedEvent(amount, {adapter, pool, adapterId: o.adapterId});
  }

  /** Manager.recall: pool.withdrawLiquidity (pool -> adapter, LiquidityRemoved), adapter -> Manager, Recalled. */
  recall(amount: bigint, o: {adapter?: Address; pool?: Address; adapterId?: bigint} = {}): this {
    const adapter = o.adapter ?? FL.adapter;
    const pool = o.pool ?? FL.pool;
    return this.transfer(pool, adapter, amount)
      .liquidityRemoved(pool, adapter, amount)
      .transfer(adapter, FL.manager, amount)
      .recalledEvent(amount, {adapter, pool, adapterId: o.adapterId});
  }

  /** Manager.migrateReserves(to, amount). */
  migrate(to: Address, amount: bigint): this {
    return this.transfer(FL.manager, to, amount).reservesMigrated(to, amount);
  }

  /** User bridge send: Router pulls user -> pool, then OutboundRateLimitConsumed and LockedOrBurned. */
  lock(user: Address, amount: bigint, pool: Address = FL.pool): this {
    return this.transfer(user, pool, amount).lockedOrBurned(pool, amount);
  }

  /** OffRamp execution: InboundRateLimitConsumed, pool -> recipient, ReleasedOrMinted. */
  release(recipient: Address, amount: bigint, pool: Address = FL.pool, remote = BSC_SELECTOR): this {
    this.#push(tokenPoolAbi, pool, "InboundRateLimitConsumed", {remoteChainSelector: remote, token: FL.token, amount});
    return this.transfer(pool, recipient, amount).releasedOrMinted(pool, recipient, amount, remote);
  }

  /** newPool.transferLiquidity(oldPool, amount): oldPool.withdrawLiquidity pays the new pool (its rebalancer). */
  transferLiquidity(oldPool: Address, newPool: Address, amount: bigint): this {
    return this.transfer(oldPool, newPool, amount)
      .liquidityRemoved(oldPool, newPool, amount)
      .liquidityTransferred(newPool, oldPool, amount);
  }
}
