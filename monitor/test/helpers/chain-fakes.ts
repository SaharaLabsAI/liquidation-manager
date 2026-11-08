// Fakes for the chain infra tests: an in-memory eth_getLogs node and a readContract table, both cast to PublicClient.
import {getAddress, numberToHex, padHex, type Address, type Hex, type PublicClient, type RpcLog} from "viem";

import {configSchema, type ChainConfig, type Config} from "../../src/config.ts";

/** Deterministic test address from a small number: addr(1) = 0x00…01. */
export function addr(n: number): Address {
  return getAddress(padHex(numberToHex(n), {size: 20}));
}

export function topic(n: number): Hex {
  return padHex(numberToHex(n), {size: 32});
}

export interface LogSpec {
  address: Address;
  block: bigint;
  logIndex: number;
  topics?: Hex[];
  txIndex?: number;
  removed?: boolean;
  /** Hex block timestamp, as some RPCs add it. */
  blockTimestamp?: Hex;
}

export function rpcLog(spec: LogSpec): RpcLog {
  const log: RpcLog = {
    address: spec.address.toLowerCase() as Address,
    blockHash: padHex(numberToHex(spec.block + 0xb000n), {size: 32}),
    blockNumber: numberToHex(spec.block),
    data: "0x",
    logIndex: numberToHex(spec.logIndex),
    transactionHash: padHex(numberToHex(spec.block * 1000n + BigInt(spec.txIndex ?? 0)), {size: 32}),
    transactionIndex: numberToHex(spec.txIndex ?? 0),
    removed: spec.removed ?? false,
    topics: (spec.topics ?? [topic(1)]) as [Hex, ...Hex[]],
  };
  if (spec.blockTimestamp) log.blockTimestamp = spec.blockTimestamp;
  return log;
}

type Topics = Array<Hex | Hex[] | null>;

export interface GetLogsCall {
  address: Address | Address[];
  topics: Array<Hex | Hex[] | null> | undefined;
  from: bigint;
  to: bigint;
  ok: boolean;
}

export interface LogNodeOptions {
  /** Ranges with more blocks than this are rejected (like a provider's range limit). */
  maxBlocks?: number;
  /** Requests covering any of these blocks fail, down to the single block. */
  failBlocks?: bigint[];
  /** Milliseconds each request takes (to observe concurrency). */
  delayMs?: number;
  /** Extra copies returned for every matching log (duplicates across responses). */
  echo?: (log: RpcLog) => RpcLog[];
  /** Queries matching more logs than this are rejected, whatever their range (like Infura's 10,000-result cap). */
  maxResults?: number;
  /** eth_getBlockReceipts: false rejects it (a provider without the method); a function rewrites the answer. */
  receipts?: false | ((block: bigint, receipts: unknown[]) => unknown);
}

/**
 * In-memory eth_getLogs (and eth_getBlockReceipts, one receipt per transaction) with provider-like failures; records
 * every call and the peak number of calls in flight.
 */
export function createLogNode(logs: RpcLog[], options: LogNodeOptions = {}) {
  const calls: GetLogsCall[] = [];
  const receiptCalls: bigint[] = [];
  const stats = {inFlight: 0, maxInFlight: 0};
  const request = async ({method, params}: {method: string; params: unknown[]}): Promise<unknown> => {
    if (method === "eth_getBlockReceipts") return blockReceipts(BigInt(params[0] as Hex));
    if (method !== "eth_getLogs") throw new Error(`unexpected method ${method}`);
    const filter = params[0] as {address: Address | Address[]; topics?: Topics; fromBlock: Hex; toBlock: Hex};
    const from = BigInt(filter.fromBlock);
    const to = BigInt(filter.toBlock);
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
      const call: GetLogsCall = {address: filter.address, topics: filter.topics, from, to, ok: false};
      calls.push(call);
      if (options.maxBlocks !== undefined && to - from + 1n > BigInt(options.maxBlocks)) {
        throw Object.assign(new Error("query returned more than 10000 results"), {code: -32005});
      }
      if (options.failBlocks?.some((block) => block >= from && block <= to)) throw new Error("upstream timeout");
      const matches = logs.filter((log) => {
        const block = BigInt(log.blockNumber ?? "0x0");
        return block >= from && block <= to && matchesFilter(log, filter.address, filter.topics);
      });
      if (options.maxResults !== undefined && matches.length > options.maxResults) {
        throw Object.assign(new Error(`query returned more than ${options.maxResults} results`), {code: -32005});
      }
      call.ok = true;
      return matches.flatMap((log) => [log, ...(options.echo?.(log) ?? [])]);
    } finally {
      stats.inFlight--;
    }
  };
  const blockReceipts = async (block: bigint): Promise<unknown> => {
    receiptCalls.push(block);
    if (options.receipts === false) throw new Error("the method eth_getBlockReceipts does not exist/is not available");
    const byTx = new Map<string, RpcLog[]>();
    for (const log of logs) {
      if (BigInt(log.blockNumber ?? "0x0") !== block) continue;
      const tx = log.transactionHash ?? "0x";
      byTx.set(tx, [...(byTx.get(tx) ?? []), log]);
    }
    const receipts = [...byTx].map(([transactionHash, txLogs]) => ({
      blockNumber: numberToHex(block),
      transactionHash,
      status: "0x1",
      logs: txLogs,
    }));
    return options.receipts ? options.receipts(block, receipts) : receipts;
  };
  return {client: {request} as unknown as PublicClient, calls, receiptCalls, stats};
}

function matchesFilter(log: RpcLog, address: Address | Address[], topics: Topics | undefined): boolean {
  const addresses = (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase());
  if (!addresses.includes(log.address.toLowerCase())) return false;
  return (topics ?? []).every((wanted, i) => {
    if (wanted === null) return true;
    const actual = log.topics[i]?.toLowerCase();
    return (Array.isArray(wanted) ? wanted : [wanted]).some((t) => t.toLowerCase() === actual);
  });
}

/** Return value, thrown Error, or a function of the call args (whose result may again be an Error to throw). */
export type FakeResult = ((args: readonly unknown[]) => unknown) | object | string | bigint | boolean | number;

export interface ReadCall {
  address: Address;
  functionName: string;
  args: readonly unknown[];
  blockNumber: bigint | undefined;
}

/**
 * readContract over a table `{[address]: {[functionName]: result}}`. Every call must carry `expectBlock`; unknown
 * contracts or functions revert like an EOA would.
 */
export function createContractClient(table: Record<string, Record<string, FakeResult>>, expectBlock: bigint) {
  const calls: ReadCall[] = [];
  const contracts = new Map(Object.entries(table).map(([address, fns]) => [address.toLowerCase(), fns]));
  const readContract = async (params: {
    address: Address;
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown> => {
    const args = params.args ?? [];
    calls.push({address: params.address, functionName: params.functionName, args, blockNumber: params.blockNumber});
    if (params.blockNumber !== expectBlock) {
      throw new Error(`${params.functionName} read at block ${params.blockNumber}, expected ${expectBlock}`);
    }
    const fns = contracts.get(params.address.toLowerCase());
    if (!fns || !(params.functionName in fns)) {
      throw new Error(`execution reverted: ${params.address}.${params.functionName}`);
    }
    const entry = fns[params.functionName];
    const result = typeof entry === "function" ? entry(args) : entry;
    if (result instanceof Error) throw result;
    return result;
  };
  return {client: {readContract} as unknown as PublicClient, calls};
}

/** A validated chain config (defaults applied) from a partial input. */
export function chainConfig(input: {
  contracts: Record<string, string>;
  reserves?: Record<string, string[]>;
  expected?: Record<string, unknown>;
  explorerUrl?: string;
}): ChainConfig {
  return globalConfig({ethereum: input}).chains.ethereum!;
}

export function globalConfig(chains: Record<string, Parameters<typeof chainConfig>[0]>): Config {
  return configSchema.parse({
    chains: Object.fromEntries(
      Object.entries(chains).map(([name, chain], i) => [
        name,
        {
          chainId: i + 1,
          chainSelector: String(1000 + i),
          rpcUrls: ["https://rpc.example.com"],
          explorerUrl: chain.explorerUrl ?? "https://etherscan.example.com/",
          contracts: chain.contracts,
          reserves: chain.reserves,
          expected: chain.expected,
        },
      ]),
    ),
  });
}
