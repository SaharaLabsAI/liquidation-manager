// Log scanning: raw eth_getLogs (address arrays and raw topic OR-arrays), chunked by `maxLogRange` and split further
// whenever a provider rejects a range, merged into one deduplicated, ordered list. A single block the provider still
// rejects is read from its receipts (eth_getBlockReceipts) and filtered here.
import {BaseError, formatLog, numberToHex, type Log, type PublicClient, type RpcLog} from "viem";

import {redact, type Logger} from "../log.ts";
import type {BlockRange, LogFilter} from "../types.ts";

/** eth_getLogs requests in flight per `fetchLogs` call (shared by every filter, chunk and split). */
export const MAX_CONCURRENT_REQUESTS = 4;

/**
 * No provider caps one eth_getLogs query below this many results (Infura: 10,000; NodeReal: 50,000; Alchemy: none).
 * A single block that fails although its receipts hold fewer logs matching the filter did not hit a result cap: the
 * provider is rate limiting, failing or does not serve eth_getLogs, and its receipts are not used. Otherwise an outage
 * of eth_getLogs alone would turn every scanned block into a receipts request (thousands of requests per chunk).
 */
export const MIN_RESULT_CAP = 1_000;

export interface FetchLogsOptions {
  /** Largest block range per request (`maxLogRange`). */
  maxRange: number;
  log: Logger;
  /** Checked before each request: true fails the scan instead of sending (or splitting) any more (a time budget). */
  stopped?: () => boolean;
  /** Default MIN_RESULT_CAP (tests lower it). */
  minResultCap?: number;
}

/**
 * Every log matching any of `filters` in `range` (inclusive), deduplicated by `blockHash:logIndex`, without removed
 * (reorged) logs, sorted by blockNumber then logIndex.
 *
 * Providers reject ranges with too many results or blocks under varying error codes and messages, so any error splits
 * the range in half, down to single blocks. A single block can still exceed a provider's result cap (Infura: 10,000
 * logs per query, one block included), e.g. one transaction that moves 1 wei to a watched address 15,000 times; without
 * a way past it, the scan would fail on that block forever. So a single block that fails is read from its receipts
 * (eth_getBlockReceipts, fetched once per block and shared by every filter), whose logs are matched against the filter
 * here, as long as at least `minResultCap` of them match (see MIN_RESULT_CAP). Otherwise, or if the receipts fail too,
 * it is rethrown with the filter, the block and the reasons; so is any range once `stopped` (requests already sent
 * still complete).
 */
export async function fetchLogs(
  client: PublicClient,
  filters: readonly LogFilter[],
  range: BlockRange,
  opts: FetchLogsOptions,
): Promise<Log[]> {
  if (range.from > range.to) return [];
  const usable = usableFilters(filters);
  if (!usable.length) return [];

  const limit = createLimiter(MAX_CONCURRENT_REQUESTS);
  // Set once a single block fails: the scan is lost, so queued requests are skipped instead of sent.
  let aborted = false;
  // A stopped scan reports the provider's last error, not the requests it did not send.
  const stop = new Error("log scan stopped");
  let providerError: unknown;

  const request = (filter: LogFilter, from: bigint, to: bigint): Promise<RpcLog[]> =>
    limit(() => {
      if (aborted) return Promise.reject(new Error("log scan aborted"));
      if (opts.stopped?.()) return Promise.reject(stop);
      return client.request({
        method: "eth_getLogs",
        params: [
          {address: filter.address, topics: filter.topics, fromBlock: numberToHex(from), toBlock: numberToHex(to)},
        ],
      });
    });

  // A block's receipts, fetched at most once per call and shared by every filter that fails on that block.
  const receipts = new Map<bigint, Promise<RpcLog[]>>();
  const blockLogs = (block: bigint): Promise<RpcLog[]> => {
    let logs = receipts.get(block);
    if (!logs) {
      logs = limit(() => {
        if (aborted) return Promise.reject(new Error("log scan aborted"));
        if (opts.stopped?.()) return Promise.reject(stop);
        return receiptLogs(client, block);
      });
      receipts.set(block, logs);
    }
    return logs;
  };
  const minResultCap = opts.minResultCap ?? MIN_RESULT_CAP;
  const fellBack = new Set<bigint>();

  /** The logs of `block` matching `filter`, from its receipts, after eth_getLogs failed on the block alone. */
  const fromReceipts = async (filter: LogFilter, block: bigint, error: unknown): Promise<RpcLog[]> => {
    const failed = `eth_getLogs failed at block ${block} for ${describeFilter(filter)}: ${errorText(error)}`;
    let matching: RpcLog[];
    try {
      matching = (await blockLogs(block)).filter((log) => matchesFilter(log, filter));
    } catch (fallback) {
      aborted = true;
      throw new Error(`${failed}; eth_getBlockReceipts failed too: ${errorText(fallback)}`, {cause: error});
    }
    if (matching.length < minResultCap) {
      aborted = true;
      throw new Error(
        `${failed} (its receipts hold ${matching.length} matching logs, too few for a result cap)`,
        {cause: error},
      );
    }
    if (!fellBack.has(block)) {
      fellBack.add(block);
      opts.log.warn("eth_getLogs failed for a single block; read its logs from eth_getBlockReceipts", {
        block,
        logs: matching.length,
        error: errorText(error),
      });
    }
    return matching;
  };

  const fetchRange = async (filter: LogFilter, from: bigint, to: bigint): Promise<RpcLog[]> => {
    try {
      return await request(filter, from, to);
    } catch (error) {
      if (aborted) throw error;
      if (error !== stop) providerError = error;
      if (from === to && error !== stop && !opts.stopped?.()) return fromReceipts(filter, from, error);
      if (from === to || opts.stopped?.()) {
        aborted = true;
        const cause = error === stop ? (providerError ?? error) : error;
        const blocks = from === to ? `block ${from}` : `blocks ${from}-${to} (stopped)`;
        throw new Error(`eth_getLogs failed at ${blocks} for ${describeFilter(filter)}: ${errorText(cause)}`, {cause});
      }
      const mid = from + (to - from) / 2n;
      opts.log.debug("eth_getLogs failed, splitting range", {from, to, error: errorText(error)});
      const [left, right] = await Promise.all([fetchRange(filter, from, mid), fetchRange(filter, mid + 1n, to)]);
      return left.concat(right);
    }
  };

  const tasks: Array<Promise<RpcLog[]>> = [];
  for (const filter of usable) {
    for (const chunk of chunkRange(range, opts.maxRange)) tasks.push(fetchRange(filter, chunk.from, chunk.to));
  }
  const batches = await Promise.all(tasks);

  const unique = new Map<string, Log>();
  for (const raw of batches.flat()) {
    if (raw.removed) continue;
    // Pending logs (no block) cannot be ordered or keyed; a fixed historical range never returns them.
    if (raw.blockHash === null || raw.blockNumber === null || raw.logIndex === null) continue;
    const log = toLog(raw);
    unique.set(`${log.blockHash?.toLowerCase()}:${log.logIndex}`, log);
  }
  return [...unique.values()].sort(compareLogs);
}

/** Every log of `block`, from the receipts of its transactions. */
async function receiptLogs(client: PublicClient, block: bigint): Promise<RpcLog[]> {
  const receipts = await client.request({method: "eth_getBlockReceipts", params: [numberToHex(block)]});
  if (!Array.isArray(receipts)) throw new Error(`no receipts returned for block ${block}`);
  const logs: RpcLog[] = [];
  for (const receipt of receipts) {
    // A receipt of another block would be read as this block's.
    if (receipt.blockNumber === null || BigInt(receipt.blockNumber) !== block) {
      throw new Error(`a receipt of block ${receipt.blockNumber} was returned for block ${block}`);
    }
    for (const log of receipt.logs) logs.push(log);
  }
  return logs;
}

/**
 * Whether eth_getLogs would return `log` for `filter`: its address is one of the filter's, and each topic position of
 * the filter is null (anything) or lists the log's topic there. Providers disagree on a null position beyond the log's
 * topics (on 2026-11-08 publicnode's reth did not match it, drpc's Ethereum endpoint did), so it matches here: the
 * fallback must never drop a log some provider returns, and the rules check the topics of what they decode.
 */
export function matchesFilter(log: RpcLog, filter: LogFilter): boolean {
  const address = log.address.toLowerCase();
  const addresses = Array.isArray(filter.address) ? filter.address : [filter.address];
  if (!addresses.some((wanted) => wanted.toLowerCase() === address)) return false;
  const topics = filter.topics ?? [];
  return topics.every((wanted, i) => {
    if (wanted === null) return true;
    const actual = log.topics[i]?.toLowerCase();
    return (Array.isArray(wanted) ? wanted : [wanted]).some((topic) => topic.toLowerCase() === actual);
  });
}

/** Splits an inclusive range into consecutive inclusive chunks of at most `maxRange` blocks. */
export function chunkRange(range: BlockRange, maxRange: number): BlockRange[] {
  const size = BigInt(Math.max(1, Math.floor(maxRange)));
  const chunks: BlockRange[] = [];
  for (let from = range.from; from <= range.to; from += size) {
    const to = from + size - 1n;
    chunks.push({from, to: to < range.to ? to : range.to});
  }
  return chunks;
}

/** RPC log (hex quantities) to viem's `Log` (bigint blockNumber, number logIndex/transactionIndex). */
export function toLog(raw: RpcLog): Log {
  // formatLog keeps extra fields and converts an RPC-provided `blockTimestamp` to bigint.
  return {...formatLog(raw), removed: false};
}

function compareLogs(a: Log, b: Log): number {
  const blockA = a.blockNumber ?? 0n;
  const blockB = b.blockNumber ?? 0n;
  if (blockA !== blockB) return blockA < blockB ? -1 : 1;
  return (a.logIndex ?? 0) - (b.logIndex ?? 0);
}

/**
 * Drops filters that cannot match anything — an empty address list or an empty topic OR-array, which RPC nodes would
 * treat as wildcards and answer with every log — and exact duplicates (several rules may request the same filter).
 */
function usableFilters(filters: readonly LogFilter[]): LogFilter[] {
  const seen = new Set<string>();
  const result: LogFilter[] = [];
  for (const filter of filters) {
    if (Array.isArray(filter.address) && filter.address.length === 0) continue;
    if (filter.topics?.some((topic) => Array.isArray(topic) && topic.length === 0)) continue;
    const key = JSON.stringify([filter.address, filter.topics ?? []]).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(filter);
  }
  return result;
}

function describeFilter(filter: LogFilter): string {
  const address = Array.isArray(filter.address) ? `[${filter.address.join(", ")}]` : filter.address;
  return `address ${address}, topics ${JSON.stringify(filter.topics ?? [])}`;
}

/** Provider error text without request URLs (viem's full message lists the URL, which may embed an API key). */
function errorText(error: unknown): string {
  let text: string;
  if (error instanceof BaseError) {
    const {shortMessage, details} = error;
    text = details && details !== shortMessage ? `${shortMessage} ${details}` : shortMessage;
  } else {
    text = error instanceof Error ? error.message : String(error);
  }
  return redact(text);
}

/**
 * Runs at most `max` tasks at once; a finishing task hands its slot straight to the most recently queued one. LIFO
 * makes the range splitting depth-first: on a provider that rejects everything (rate limit, outage) the first single
 * block fails, and aborts the scan, after about log2(maxRange) requests per slot instead of after nearly every
 * split of every filter (thousands of requests per chunk).
 */
function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await task();
    } finally {
      const next = queue.pop();
      if (next) next();
      else active--;
    }
  };
}
