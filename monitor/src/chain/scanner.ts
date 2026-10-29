// Log scanning: raw eth_getLogs (address arrays and raw topic OR-arrays), chunked by `maxLogRange` and split further
// whenever a provider rejects a range, merged into one deduplicated, ordered list.
import {BaseError, formatLog, numberToHex, type Log, type PublicClient, type RpcLog} from "viem";

import {redact, type Logger} from "../log.ts";
import type {BlockRange, LogFilter} from "../types.ts";

/** eth_getLogs requests in flight per `fetchLogs` call (shared by every filter, chunk and split). */
export const MAX_CONCURRENT_REQUESTS = 4;

export interface FetchLogsOptions {
  /** Largest block range per request (`maxLogRange`). */
  maxRange: number;
  log: Logger;
  /** Checked before each request: true fails the scan instead of sending (or splitting) any more (a time budget). */
  stopped?: () => boolean;
}

/**
 * Every log matching any of `filters` in `range` (inclusive), deduplicated by `blockHash:logIndex`, without removed
 * (reorged) logs, sorted by blockNumber then logIndex.
 *
 * Providers reject ranges with too many results or blocks under varying error codes and messages, so any error splits
 * the range in half, down to single blocks; a single block that still fails is rethrown with the filter and block, and
 * so is any range once `stopped` (requests already sent still complete).
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

  const fetchRange = async (filter: LogFilter, from: bigint, to: bigint): Promise<RpcLog[]> => {
    try {
      return await request(filter, from, to);
    } catch (error) {
      if (aborted) throw error;
      if (error !== stop) providerError = error;
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
