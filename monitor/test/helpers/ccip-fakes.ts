// Fakes for the CCIP tracking and reconciliation tests: the real Ethereum/BSC addresses of the captured fixtures, chain
// contexts sharing one store, a fake client (eth_getLogs, receipts, reads, blocks) and synthesized ramp/pool logs.
import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  keccak256,
  numberToHex,
  slice,
  toHex,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type RpcLog,
} from "viem";

import {evm2EvmOffRampAbi, offRampAbi} from "../../src/abi/ccip.ts";
import {saharaTokenAbi, tokenPoolAbi} from "../../src/abi/external.ts";
import {createExplorer} from "../../src/chain/client.ts";
import {configSchema, type Config} from "../../src/config.ts";
import {silentLogger} from "../../src/log.ts";
import {createStore, type Store} from "../../src/store.ts";
import type {Alert, Alerter, ChainContext, ResolvedAddresses} from "../../src/types.ts";

export const ETH = 5009297550715157269n;
export const BSC = 11344663589394136015n;
export const SAHARA = getAddress("0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111");
export const POOL = getAddress("0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4");
export const REGISTRY = {
  ethereum: getAddress("0xb22764f98dD05c789929716D677382Df22C05Cb6"),
  bsc: getAddress("0x736Fd8660c443547a85e4Eaf70A49C1b7Bb008fc"),
};
export const ROUTER = {
  ethereum: getAddress("0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D"),
  bsc: getAddress("0x34B03Cb9086d7D758AC55af71584F81A598759FE"),
};
export const ONRAMP_V2 = {
  ethereum: getAddress("0xc3423F3FB30857D9C14717b119884b1B63d250b7"),
  bsc: getAddress("0x84a0797B31Ac0d3E1D06157663dd4b18cFFdA188"),
};
export const OFFRAMP_V2 = {
  ethereum: getAddress("0x408428bca0e24A25ac8baAc1b70f64AF257717c3"),
  bsc: getAddress("0x4914044f8d787bd5DC7528f00775D850dC54477e"),
};
export const OFFRAMP_V15 = {
  ethereum: getAddress("0x66d84fedED0e51aeB47ceD1BB2fc0221Ae8D7C12"),
  bsc: getAddress("0xF616733641D420207b8F30db9C4cE39684768991"),
};
export const OFFRAMP_V12 = {
  ethereum: getAddress("0x7Afe7088aff57173565F4b034167643AA8b9171c"),
  bsc: getAddress("0x181Bb1E97b0bDD1D85E741ad0943552D3682cc35"),
};
export const MANAGER = {ethereum: ccAddr(0xe1), bsc: ccAddr(0xb1)};
/** A third chain's OffRamp on the Router (must be ignored). */
export const OTHER_SELECTOR = 4949039107694359620n;

export type ChainName = "ethereum" | "bsc";
export const SELECTOR: Record<ChainName, bigint> = {ethereum: ETH, bsc: BSC};

export function ccAddr(n: number): Address {
  return getAddress(numberToHex(n, {size: 20}));
}

export const ccipConfig: Config = configSchema.parse({
  chains: {
    ethereum: {
      chainId: 1,
      chainSelector: ETH.toString(),
      rpcUrls: ["http://localhost:8545"],
      explorerUrl: "https://etherscan.io",
      contracts: {token: SAHARA, registry: REGISTRY.ethereum, router: ROUTER.ethereum, pool: POOL},
    },
    bsc: {
      chainId: 56,
      chainSelector: BSC.toString(),
      rpcUrls: ["http://localhost:8546"],
      explorerUrl: "https://bscscan.com/",
      contracts: {token: SAHARA, registry: REGISTRY.bsc, router: ROUTER.bsc, pool: POOL},
    },
  },
});

export function ccipAddresses(chain: ChainName, overrides: Partial<ResolvedAddresses> = {}): ResolvedAddresses {
  return {
    token: SAHARA,
    registry: REGISTRY[chain],
    router: ROUTER[chain],
    registryPool: POOL,
    adapters: [],
    adapterHistory: [],
    pools: [POOL],
    legacyWallets: [],
    endpoints: [MANAGER[chain], POOL],
    labels: {[POOL.toLowerCase()]: "Pool", [MANAGER[chain].toLowerCase()]: "Manager"},
    ...overrides,
  };
}

/** The Router's OffRamps as getOffRamps() lists them: every version for the counterpart lane, plus another lane. */
export function routerOffRamps(chain: ChainName): Array<{sourceChainSelector: bigint; offRamp: Address}> {
  const remote = chain === "ethereum" ? BSC : ETH;
  return [
    {sourceChainSelector: remote, offRamp: OFFRAMP_V12[chain]},
    {sourceChainSelector: remote, offRamp: OFFRAMP_V15[chain]},
    {sourceChainSelector: remote, offRamp: OFFRAMP_V2[chain]},
    {sourceChainSelector: OTHER_SELECTOR, offRamp: OFFRAMP_V2[chain]},
    {sourceChainSelector: OTHER_SELECTOR, offRamp: ccAddr(0x0ff)},
  ];
}

export interface ReadCall {
  address: Address;
  functionName: string;
  args: readonly unknown[];
  blockNumber?: bigint;
}

export interface FakeClientOptions {
  chain: ChainName;
  /** Logs served by eth_getLogs. */
  logs?: Log[];
  /** Receipt logs by transaction hash (lowercase or not); an Error is thrown. Default: the matching `logs`. */
  receipts?: Record<string, Log[] | Error>;
  /** readContract override; return undefined to fall through to the Router defaults. */
  read?: (call: ReadCall) => unknown;
  /** Unix seconds of a block. Default 1_760_000_000. */
  timestamp?: (block: bigint) => number;
  /** "finalized" block, or an Error when the tag is unsupported. */
  finalized?: bigint | Error;
  head?: bigint | Error;
  /** Thrown by eth_getLogs, for every range or for the ranges the function returns one for. */
  getLogsError?: Error | ((range: {from: bigint; to: bigint}) => Error | undefined);
}

export interface FakeClient {
  client: PublicClient;
  reads: ReadCall[];
  getLogs: Array<{address: unknown; topics: unknown; fromBlock: Hex; toBlock: Hex}>;
  receipts: Hex[];
  options: FakeClientOptions;
}

export const T0 = 1_760_000_000;

function toRpcLog(log: Log): RpcLog {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockHash: log.blockHash,
    blockNumber: log.blockNumber === null ? null : numberToHex(log.blockNumber),
    logIndex: log.logIndex === null ? null : numberToHex(log.logIndex),
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex === null ? null : numberToHex(log.transactionIndex),
    removed: false,
  } as RpcLog;
}

function matches(log: Log, address: Address | Address[], topics: Array<Hex | Hex[] | null> | undefined): boolean {
  const addresses = (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase());
  if (!addresses.includes(log.address.toLowerCase())) return false;
  return (topics ?? []).every((wanted, i) => {
    if (wanted === null) return true;
    const actual = log.topics[i]?.toLowerCase();
    return (Array.isArray(wanted) ? wanted : [wanted]).some((t) => t.toLowerCase() === actual);
  });
}

export function fakeClient(options: FakeClientOptions): FakeClient {
  const fake: FakeClient = {
    client: undefined as unknown as PublicClient,
    reads: [],
    getLogs: [],
    receipts: [],
    options,
  };
  const timestamp = (block: bigint) => (options.timestamp ?? (() => T0))(block);
  const client = {
    async request({method, params}: {method: string; params: unknown[]}) {
      if (method !== "eth_getLogs") throw new Error(`unexpected method ${method}`);
      const filter = params[0] as {
        address: Address | Address[];
        topics?: Array<Hex | Hex[] | null>;
        fromBlock: Hex;
        toBlock: Hex;
      };
      const {address, topics, fromBlock, toBlock} = filter;
      fake.getLogs.push({address, topics, fromBlock, toBlock});
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      const error =
        typeof options.getLogsError === "function" ? options.getLogsError({from, to}) : options.getLogsError;
      if (error) throw error;
      return (options.logs ?? [])
        .filter((log) => log.blockNumber! >= from && log.blockNumber! <= to && matches(log, address, topics))
        .map(toRpcLog);
    },
    async getTransactionReceipt({hash}: {hash: Hex}) {
      fake.receipts.push(hash);
      const entry =
        options.receipts?.[hash] ??
        options.receipts?.[hash.toLowerCase()] ??
        (options.logs ?? []).filter((log) => log.transactionHash?.toLowerCase() === hash.toLowerCase());
      if (entry instanceof Error) throw entry;
      if (!entry.length) throw new Error(`no receipt for ${hash}`);
      return {transactionHash: hash, logs: entry};
    },
    async getBlock(params: {blockNumber?: bigint; blockTag?: string}) {
      if (params.blockTag === "finalized") {
        const finalized = options.finalized ?? 1_000n;
        if (finalized instanceof Error) throw finalized;
        return {number: finalized, timestamp: BigInt(timestamp(finalized))};
      }
      if (params.blockNumber === undefined) throw new Error("getBlock without a block");
      return {number: params.blockNumber, timestamp: BigInt(timestamp(params.blockNumber))};
    },
    async getBlockNumber() {
      const head = options.head ?? 2_000n;
      if (head instanceof Error) throw head;
      return head;
    },
    async readContract(params: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }) {
      const call: ReadCall = {
        address: params.address,
        functionName: params.functionName,
        args: params.args ?? [],
        blockNumber: params.blockNumber,
      };
      fake.reads.push(call);
      const result = options.read?.(call);
      if (result instanceof Error) throw result;
      if (result !== undefined) return result;
      if (call.address.toLowerCase() === ROUTER[options.chain].toLowerCase()) {
        if (call.functionName === "getOffRamps") return routerOffRamps(options.chain);
        if (call.functionName === "getOnRamp") return ONRAMP_V2[options.chain];
      }
      throw new Error(`execution reverted: ${call.address}.${call.functionName}`);
    },
  };
  fake.client = client as unknown as PublicClient;
  return fake;
}

export interface RecordingAlerter extends Alerter {
  emitted: Alert[];
  resolved: string[];
  syncs: Array<{scope: string; active: Alert[]}>;
}

export function recordingAlerter(): RecordingAlerter {
  const alerter: RecordingAlerter = {
    emitted: [],
    resolved: [],
    syncs: [],
    emit: (alert) => alerter.emitted.push(alert),
    sync: (scope, active) => alerter.syncs.push({scope, active}),
    resolve: (key) => alerter.resolved.push(key),
  };
  return alerter;
}

export function ccipContext(
  chain: ChainName,
  opts: {
    client: PublicClient;
    store: Store;
    alerter?: RecordingAlerter;
    config?: Config;
    addresses?: ResolvedAddresses;
  },
): ChainContext & {alerter: RecordingAlerter} {
  const config = opts.config ?? ccipConfig;
  const addresses = opts.addresses ?? ccipAddresses(chain);
  const chainConfig = config.chains[chain]!;
  return {
    name: chain,
    config: chainConfig,
    global: config,
    client: opts.client,
    explorer: createExplorer(chainConfig.explorerUrl),
    alerter: opts.alerter ?? recordingAlerter(),
    store: opts.store,
    log: silentLogger,
    addresses,
    label: (address: Address) => addresses.labels[address.toLowerCase()] ?? getAddress(address),
  };
}

/** Both chains over one shared store, as the daemon wires them. */
export function ccipPair(clients: Partial<Record<ChainName, Omit<FakeClientOptions, "chain">>> = {}) {
  const store = createStore();
  const ethFake = fakeClient({chain: "ethereum", ...clients.ethereum});
  const bscFake = fakeClient({chain: "bsc", ...clients.bsc});
  return {
    store,
    eth: ccipContext("ethereum", {client: ethFake.client, store}),
    bsc: ccipContext("bsc", {client: bscFake.client, store}),
    ethFake,
    bscFake,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Synthesized logs

export interface Position {
  txHash: Hex;
  block: bigint;
  logIndex: number;
}

export const txHash = (label: string): Hex => keccak256(toHex(`tx-${label}`));

function eventLog(
  abi: readonly unknown[],
  eventName: string,
  args: Record<string, unknown>,
  address: Address,
  pos: Position,
): Log {
  const item = getAbiItem({abi, name: eventName} as never) as AbiEvent;
  const indexed: Record<string, unknown> = {};
  for (const input of item.inputs) if (input.indexed && input.name) indexed[input.name] = args[input.name];
  const topics = encodeEventTopics({abi: [item], eventName, args: indexed} as never) as Hex[];
  const nonIndexed = item.inputs.filter((input) => !input.indexed);
  return {
    address,
    blockHash: keccak256(toHex(`block-${pos.block}`)),
    blockNumber: pos.block,
    data: encodeAbiParameters(
      nonIndexed,
      nonIndexed.map((input) => args[input.name ?? ""]),
    ),
    logIndex: pos.logIndex,
    transactionHash: pos.txHash,
    transactionIndex: 0,
    removed: false,
    topics: topics as [Hex, ...Hex[]],
  } as Log;
}

/** OffRamp 2.0.0 ExecutionStateChanged. */
export function execLogV2(
  offRamp: Address,
  args: {sourceChainSelector: bigint; messageNumber: bigint; messageId: Hex; state: number; returnData?: Hex},
  pos: Position,
): Log {
  return eventLog(offRampAbi, "ExecutionStateChanged", {returnData: "0x", ...args}, offRamp, pos);
}

/**
 * A real ExecutionStateChanged (OffRamp 2.0.0 or EVM2EVM: same data layout) as a FAILURE with `returnData` at `pos`,
 * keeping its OffRamp, messageId and lane or sequence number.
 */
export function failedExecution(log: Log, returnData: Hex, pos: Position): Log {
  return {
    ...log,
    blockHash: keccak256(toHex(`block-${pos.block}`)),
    blockNumber: pos.block,
    data: encodeAbiParameters([{type: "uint8"}, {type: "bytes"}], [3, returnData]),
    logIndex: pos.logIndex,
    transactionHash: pos.txHash,
  };
}

/** Pool ReleasedOrMinted (sender = the OffRamp). */
export function releaseLog(
  args: {remoteChainSelector: bigint; offRamp: Address; recipient: Address; amount: bigint},
  pos: Position,
  pool: Address = POOL,
): Log {
  return eventLog(
    tokenPoolAbi,
    "ReleasedOrMinted",
    {
      remoteChainSelector: args.remoteChainSelector,
      token: SAHARA,
      sender: args.offRamp,
      recipient: args.recipient,
      amount: args.amount,
    },
    pool,
    pos,
  );
}

/** Pool LockedOrBurned (sender = the OnRamp). */
export function lockLog(
  args: {remoteChainSelector: bigint; onRamp: Address; amount: bigint},
  pos: Position,
  pool: Address = POOL,
): Log {
  return eventLog(
    tokenPoolAbi,
    "LockedOrBurned",
    {remoteChainSelector: args.remoteChainSelector, token: SAHARA, sender: args.onRamp, amount: args.amount},
    pool,
    pos,
  );
}

/**
 * Pool-out-of-inventory failure as OffRamp 2.0.0 reports it: TokenHandlingError(target = token,
 * err = ERC20InsufficientBalance(pool, balance, needed)), truncated to 132 bytes.
 */
export function insufficientBalanceError(target: Address, pool: Address, balance: bigint, needed: bigint): Hex {
  const inner = encodeErrorResult({
    abi: saharaTokenAbi,
    errorName: "ERC20InsufficientBalance",
    args: [pool, balance, needed],
  });
  const full = encodeErrorResult({abi: offRampAbi, errorName: "TokenHandlingError", args: [target, inner]});
  return slice(full, 0, 132);
}

/** Pool-out-of-inventory failure as EVM2EVMOffRamp 1.5.0 reports it: TokenHandlingError(ERC20InsufficientBalance). */
export function insufficientBalanceErrorV15(pool: Address, balance: bigint, needed: bigint): Hex {
  const inner = encodeErrorResult({
    abi: saharaTokenAbi,
    errorName: "ERC20InsufficientBalance",
    args: [pool, balance, needed],
  });
  return encodeErrorResult({abi: evm2EvmOffRampAbi, errorName: "TokenHandlingError", args: [inner]});
}

export function receiverError(): Hex {
  return encodeErrorResult({abi: offRampAbi, errorName: "ReceiverError", args: ["0x"]});
}
