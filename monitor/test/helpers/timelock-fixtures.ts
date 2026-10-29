// Fixtures for the Timelock tests: known addresses, a ChainContext with a recording alerter, real event logs built
// with viem encoders, and a fake client.
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  keccak256,
  pad,
  toHex,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";

import {guardianControllerAbi, saharaTimelockAbi} from "../../src/abi/generated.ts";
import {configSchema} from "../../src/config.ts";
import {silentLogger} from "../../src/log.ts";
import {createStore, type Store} from "../../src/store.ts";
import type {Alert, ChainContext, ResolvedAddresses} from "../../src/types.ts";

export const tlAddr = (n: number): Address => getAddress(pad(toHex(n), {size: 20}));

export const TL = {
  token: tlAddr(0x10),
  registry: tlAddr(0x11),
  manager: tlAddr(0x12),
  timelock: tlAddr(0x13),
  controller: tlAddr(0x14),
  router: tlAddr(0x15),
  pool: tlAddr(0x20),
  adapter: tlAddr(0x30),
  guardian: tlAddr(0x40),
  newGuardian: tlAddr(0x41),
  safe: tlAddr(0x42),
  stranger: tlAddr(0x99),
} as const;

export const ETH_SELECTOR = 5009297550715157269n;
export const BSC_SELECTOR = 11344663589394136015n;

export function tlAddresses(overrides: Partial<ResolvedAddresses> = {}): ResolvedAddresses {
  const labels: Record<string, string> = {
    [TL.token.toLowerCase()]: "Token",
    [TL.registry.toLowerCase()]: "Registry",
    [TL.manager.toLowerCase()]: "Manager",
    [TL.timelock.toLowerCase()]: "Timelock",
    [TL.controller.toLowerCase()]: "GuardianController",
    [TL.router.toLowerCase()]: "Router",
    [TL.pool.toLowerCase()]: "Pool",
    [TL.adapter.toLowerCase()]: "Adapter #1",
    [TL.guardian.toLowerCase()]: "Guardian",
    [TL.safe.toLowerCase()]: "Governance Safe",
  };
  return {
    token: TL.token,
    registry: TL.registry,
    router: TL.router,
    manager: TL.manager,
    timelock: TL.timelock,
    controller: TL.controller,
    registryPool: TL.pool,
    adapters: [{id: 1n, adapter: TL.adapter, pool: TL.pool, fundingEnabled: true, recallEnabled: true}],
    adapterHistory: [TL.adapter],
    pools: [TL.pool],
    legacyWallets: [],
    endpoints: [TL.manager, TL.adapter, TL.pool],
    labels,
    ...overrides,
  };
}

export const tlConfig = configSchema.parse({
  chains: {
    ethereum: {
      chainId: 1,
      chainSelector: ETH_SELECTOR.toString(),
      rpcUrls: ["http://localhost:8545"],
      explorerUrl: "https://etherscan.io",
      contracts: {token: TL.token, registry: TL.registry, manager: TL.manager},
    },
    bsc: {
      chainId: 56,
      chainSelector: BSC_SELECTOR.toString(),
      rpcUrls: ["http://localhost:8546"],
      explorerUrl: "https://bscscan.com",
      contracts: {token: TL.token, registry: TL.registry},
    },
  },
});

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

export interface FakeClientOptions {
  /** Block number -> unix seconds. Default: 1_700_000_000 + block * 12. */
  timestamp?: (blockNumber: bigint) => number;
  read?: (functionName: string, args: readonly unknown[], blockNumber: bigint | undefined) => unknown;
  failGetBlock?: boolean;
}

export const blockTime = (blockNumber: bigint) => 1_700_000_000 + Number(blockNumber) * 12;

export function fakeClient(opts: FakeClientOptions = {}): PublicClient & {reads: Array<{fn: string; args: unknown[]}>} {
  const reads: Array<{fn: string; args: unknown[]}> = [];
  const client = {
    reads,
    async getBlock({blockNumber}: {blockNumber: bigint}) {
      if (opts.failGetBlock) throw new Error("getBlock failed");
      return {number: blockNumber, timestamp: BigInt((opts.timestamp ?? blockTime)(blockNumber))};
    },
    async readContract(params: {functionName: string; args?: readonly unknown[]; blockNumber?: bigint}) {
      reads.push({fn: params.functionName, args: [...(params.args ?? [])]});
      if (!opts.read) throw new Error(`unexpected read ${params.functionName}`);
      const result = opts.read(params.functionName, params.args ?? [], params.blockNumber);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return client as unknown as PublicClient & {reads: typeof reads};
}

export function tlContext(
  opts: {client?: PublicClient; addresses?: ResolvedAddresses; store?: Store} = {},
): ChainContext & {alerter: RecordingAlerter} {
  const addresses = opts.addresses ?? tlAddresses();
  const alerter = recordingAlerter();
  const chain = tlConfig.chains.ethereum;
  if (!chain) throw new Error("fixture config");
  return {
    name: "ethereum",
    config: chain,
    global: tlConfig,
    client: opts.client ?? fakeClient(),
    explorer: {tx: (hash) => `https://etherscan.io/tx/${hash}`, address: (a) => `https://etherscan.io/address/${a}`},
    alerter,
    store: opts.store ?? createStore(),
    log: silentLogger,
    addresses,
    label: (address: Address) => addresses.labels[address.toLowerCase()] ?? getAddress(address),
  };
}

let logCounter = 0;

export interface LogPosition {
  txHash: Hex;
  blockNumber: bigint;
  logIndex?: number;
  address?: Address;
}

/** A log of `eventName` on `abi`, encoded exactly as the contract would emit it. */
export function eventLog(
  abi: typeof saharaTimelockAbi | typeof guardianControllerAbi,
  eventName: string,
  args: Record<string, unknown>,
  pos: LogPosition,
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
    address: pos.address ?? (abi === guardianControllerAbi ? TL.controller : TL.timelock),
    blockHash: keccak256(toHex(`block-${pos.blockNumber}`)),
    blockNumber: pos.blockNumber,
    data,
    logIndex: pos.logIndex ?? logCounter++,
    transactionHash: pos.txHash,
    transactionIndex: 0,
    removed: false,
    topics: topics as [Hex, ...Hex[]],
  } as Log;
}

export const txHash = (n: number): Hex => keccak256(toHex(`tx-${n}`));

export interface Call {
  target: Address;
  value: bigint;
  data: Hex;
}

/** The logs `schedule` / `scheduleBatch` emit: one CallScheduled per call, then CallSalt when the salt is non-zero. */
export function scheduleLogs(
  id: Hex,
  calls: Call[],
  opts: {predecessor: Hex; salt: Hex; delay: bigint; txHash: Hex; blockNumber: bigint; firstLogIndex?: number},
): Log[] {
  let logIndex = opts.firstLogIndex ?? 0;
  const logs = calls.map((call, i) =>
    eventLog(
      saharaTimelockAbi,
      "CallScheduled",
      {id, index: BigInt(i), ...call, predecessor: opts.predecessor, delay: opts.delay},
      {txHash: opts.txHash, blockNumber: opts.blockNumber, logIndex: logIndex++},
    ),
  );
  if (BigInt(opts.salt) !== 0n) {
    logs.push(
      eventLog(saharaTimelockAbi, "CallSalt", {id, salt: opts.salt}, {
        txHash: opts.txHash,
        blockNumber: opts.blockNumber,
        logIndex: logIndex++,
      }),
    );
  }
  return logs;
}
