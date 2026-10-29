// Fixtures for the event-rule tests: known addresses, a ChainContext with a recording alerter and logger, a fake
// client, and real event logs built with viem encoders (one `TxBuilder` per transaction, log indices in order).
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  keccak256,
  pad,
  toHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";

import {configSchema, type Config} from "../../src/config.ts";
import type {Logger} from "../../src/log.ts";
import {createStore, type Store} from "../../src/store.ts";
import type {Alert, ChainContext, ResolvedAddresses} from "../../src/types.ts";

export const evAddr = (n: number): Address => getAddress(pad(toHex(n), {size: 20}));

export const EV = {
  token: evAddr(0x10),
  registry: evAddr(0x11),
  manager: evAddr(0x12),
  timelock: evAddr(0x13),
  controller: evAddr(0x14),
  router: evAddr(0x15),
  pool: evAddr(0x20),
  pool2: evAddr(0x21),
  unwatchedPool: evAddr(0x22),
  adapter: evAddr(0x30),
  adapter2: evAddr(0x31),
  oldAdapter: evAddr(0x32),
  guardian: evAddr(0x40),
  newGuardian: evAddr(0x41),
  fundingOperator: evAddr(0x50),
  recallOperator: evAddr(0x51),
  offRamp: evAddr(0x60),
  onRamp: evAddr(0x61),
  otherToken: evAddr(0x70),
  stranger: evAddr(0x99),
} as const;

export const ETH_SELECTOR = 5009297550715157269n;
export const BSC_SELECTOR = 11344663589394136015n;
/** A lane neither configured chain is on. */
export const OTHER_SELECTOR = 4949039107694359620n;

export function evAddresses(overrides: Partial<ResolvedAddresses> = {}): ResolvedAddresses {
  const labels: Record<string, string> = {
    [EV.token.toLowerCase()]: "Token",
    [EV.registry.toLowerCase()]: "Registry",
    [EV.manager.toLowerCase()]: "Manager",
    [EV.timelock.toLowerCase()]: "Timelock",
    [EV.controller.toLowerCase()]: "GuardianController",
    [EV.router.toLowerCase()]: "Router",
    [EV.pool.toLowerCase()]: "Pool",
    [EV.pool2.toLowerCase()]: "Pool 2",
    [EV.adapter.toLowerCase()]: "Adapter #1",
    [EV.adapter2.toLowerCase()]: "Adapter #2",
    [EV.guardian.toLowerCase()]: "Guardian",
  };
  return {
    token: EV.token,
    registry: EV.registry,
    router: EV.router,
    manager: EV.manager,
    timelock: EV.timelock,
    controller: EV.controller,
    registryPool: EV.pool,
    adapters: [
      {id: 1n, adapter: EV.adapter, pool: EV.pool, fundingEnabled: true, recallEnabled: true},
      {id: 2n, adapter: EV.adapter2, pool: EV.pool2, fundingEnabled: true, recallEnabled: true},
    ],
    adapterHistory: [EV.oldAdapter, EV.adapter, EV.adapter2],
    pools: [EV.pool, EV.pool2],
    legacyWallets: [],
    endpoints: [EV.manager, EV.oldAdapter, EV.adapter, EV.adapter2, EV.pool, EV.pool2],
    labels,
    ...overrides,
  };
}

function chainEntry(chainId: number, selector: bigint) {
  return {
    chainId,
    chainSelector: selector.toString(),
    rpcUrls: ["http://localhost:8545"],
    explorerUrl: "https://explorer.example",
    contracts: {token: EV.token, registry: EV.registry, manager: EV.manager},
  };
}

/** Ethereum + BSC (the counterpart lane of ethereum is BSC). */
export const evConfig: Config = configSchema.parse({
  chains: {ethereum: chainEntry(1, ETH_SELECTOR), bsc: chainEntry(56, BSC_SELECTOR)},
});

/** Ethereum only: no other configured chain, so the remote selector must come from the pool spec. */
export const evSingleChainConfig: Config = configSchema.parse({chains: {ethereum: chainEntry(1, ETH_SELECTOR)}});

export interface RecordingAlerter {
  emitted: Alert[];
  emit(alert: Alert): void;
  sync(scope: string, active: Alert[]): void;
  resolve(key: string): void;
}

export function recordingAlerter(): RecordingAlerter {
  const emitted: Alert[] = [];
  return {emitted, emit: (alert) => emitted.push(alert), sync: () => {}, resolve: () => {}};
}

export interface RecordingLogger extends Logger {
  warnings: Array<{message: string; fields?: Record<string, unknown>}>;
}

export function recordingLogger(): RecordingLogger {
  const warnings: RecordingLogger["warnings"] = [];
  const logger: RecordingLogger = {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message, fields) => warnings.push({message, fields}),
    error: (message, fields) => warnings.push({message, fields}),
    child: () => logger,
  };
  return logger;
}

export type ReadHandler = (call: {address: Address; functionName: string; args: readonly unknown[]}) => unknown;

/** Fake client: `readContract` answered by `read` (an Error result is thrown); every call is recorded. */
export function evClient(read?: ReadHandler) {
  const reads: Array<{address: Address; functionName: string; args: readonly unknown[]; blockNumber?: bigint}> = [];
  const client = {
    async readContract(params: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }) {
      const call = {address: params.address, functionName: params.functionName, args: params.args ?? []};
      reads.push({...call, blockNumber: params.blockNumber});
      if (!read) throw new Error(`unexpected read ${params.functionName}`);
      const result = read(call);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return {client: client as unknown as PublicClient, reads};
}

/** Default reads: every pool has a Manager spec for the BSC lane. */
export const defaultRead: ReadHandler = ({functionName}) => {
  if (functionName !== "getPoolSpec") return new Error(`unexpected read ${functionName}`);
  const spec = {
    typeAndVersion: "LockReleaseTokenPool 1.6.3-dev",
    router: EV.router,
    remoteChainSelector: BSC_SELECTOR,
    remoteToken: encodedAddress(EV.otherToken),
    remotePools: [],
    rateLimitAdmin: EV.controller,
  };
  return [spec, true];
};

export type EvContext = ChainContext & {alerter: RecordingAlerter; log: RecordingLogger};

export function evContext(
  opts: {addresses?: ResolvedAddresses; store?: Store; client?: PublicClient; config?: Config; name?: string} = {},
): EvContext {
  const addresses = opts.addresses ?? evAddresses();
  const global = opts.config ?? evConfig;
  const name = opts.name ?? "ethereum";
  const chain = global.chains[name];
  if (!chain) throw new Error(`fixture config has no chain ${name}`);
  return {
    name,
    config: chain,
    global,
    client: opts.client ?? evClient(defaultRead).client,
    explorer: {
      tx: (hash) => `https://explorer.example/tx/${hash}`,
      address: (a) => `https://explorer.example/address/${a}`,
    },
    alerter: recordingAlerter(),
    store: opts.store ?? createStore(),
    log: recordingLogger(),
    addresses,
    label: (address: Address) => addresses.labels[address.toLowerCase()] ?? getAddress(address),
  };
}

/** One log of `eventName`, encoded exactly as the contract emits it. */
export function eventLog(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  pos: {address: Address; txHash: Hex; blockNumber: bigint; logIndex: number},
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
  return {
    address: pos.address,
    blockHash: keccak256(toHex(`block-${pos.blockNumber}`)),
    blockNumber: pos.blockNumber,
    data,
    logIndex: pos.logIndex,
    transactionHash: pos.txHash,
    transactionIndex: 0,
    removed: false,
    topics: topics as [Hex, ...Hex[]],
  } as Log;
}

export const evTxHash = (n: number): Hex => keccak256(toHex(`events-tx-${n}`));

/** Builds the logs of one transaction in emission order. */
export class TxBuilder {
  readonly hash: Hex;
  readonly blockNumber: bigint;
  readonly logs: Log[] = [];
  #next: number;

  constructor(n: number, opts: {blockNumber?: bigint; firstLogIndex?: number} = {}) {
    this.hash = evTxHash(n);
    this.blockNumber = opts.blockNumber ?? BigInt(100 + n);
    this.#next = opts.firstLogIndex ?? 0;
  }

  log(abi: Abi, address: Address, eventName: string, args: Record<string, unknown> = {}): this {
    const pos = {address, txHash: this.hash, blockNumber: this.blockNumber, logIndex: this.#next++};
    this.logs.push(eventLog(abi, eventName, args, pos));
    return this;
  }
}

/** Every log of `txs`, sorted like the scanner delivers them. */
export function allLogs(...txs: TxBuilder[]): Log[] {
  return txs
    .flatMap((tx) => tx.logs)
    .sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
}

/** `abi.encode(address)`, the remote-address encoding of pool specs and remote pools. */
export function encodedAddress(address: Address): Hex {
  return encodeAbiParameters([{type: "address"}], [address]);
}

export const RANGE = {from: 100n, to: 200n};
