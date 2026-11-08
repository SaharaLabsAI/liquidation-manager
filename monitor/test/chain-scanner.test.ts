import type {PublicClient, RpcLog} from "viem";
import {describe, expect, it} from "vitest";

import {
  chunkRange,
  fetchLogs,
  matchesFilter,
  MAX_CONCURRENT_REQUESTS,
  MIN_RESULT_CAP,
  toLog,
} from "../src/chain/scanner.ts";
import {silentLogger, type Logger} from "../src/log.ts";
import {addr, createLogNode, rpcLog, topic} from "./helpers/chain-fakes.ts";

const POOL = addr(0xa1);
const TOKEN = addr(0xa2);
const opts = (maxRange: number) => ({maxRange, log: silentLogger});

describe("chunkRange", () => {
  it("splits an inclusive range into inclusive chunks", () => {
    expect(chunkRange({from: 0n, to: 4999n}, 2000)).toEqual([
      {from: 0n, to: 1999n},
      {from: 2000n, to: 3999n},
      {from: 4000n, to: 4999n},
    ]);
    expect(chunkRange({from: 10n, to: 10n}, 2000)).toEqual([{from: 10n, to: 10n}]);
    expect(chunkRange({from: 5n, to: 4n}, 2000)).toEqual([]);
  });
});

describe("fetchLogs", () => {
  it("returns nothing for no filters or an empty range, without requests", async () => {
    const node = createLogNode([rpcLog({address: POOL, block: 1n, logIndex: 0})]);
    expect(await fetchLogs(node.client, [], {from: 0n, to: 10n}, opts(100))).toEqual([]);
    expect(await fetchLogs(node.client, [{address: POOL}], {from: 11n, to: 10n}, opts(100))).toEqual([]);
    expect(node.calls).toEqual([]);
  });

  it("sends one request per filter and chunk with address arrays and topic OR-arrays", async () => {
    const node = createLogNode([]);
    const transfer = {address: TOKEN, topics: [topic(1), [topic(2), topic(3)], null]};
    await fetchLogs(node.client, [{address: [POOL, TOKEN]}, transfer], {from: 0n, to: 4999n}, opts(2000));
    const ranges = (address: unknown) =>
      node.calls
        .filter((call) => JSON.stringify(call.address) === JSON.stringify(address))
        .map((call) => [call.from, call.to])
        .sort((a, b) => Number(a[0]! - b[0]!));
    expect(node.calls).toHaveLength(6);
    expect(ranges([POOL, TOKEN])).toEqual([
      [0n, 1999n],
      [2000n, 3999n],
      [4000n, 4999n],
    ]);
    expect(ranges(TOKEN)).toHaveLength(3);
    expect(node.calls.find((call) => call.address === TOKEN)?.topics).toEqual(transfer.topics);
  });

  it("splits failing ranges until the provider accepts them", async () => {
    const logs = Array.from({length: 40}, (_, i) => rpcLog({address: POOL, block: BigInt(i * 25), logIndex: 0}));
    const node = createLogNode(logs, {maxBlocks: 300});
    const result = await fetchLogs(node.client, [{address: POOL}], {from: 0n, to: 999n}, opts(2000));
    expect(result.map((log) => log.blockNumber)).toEqual(logs.map((_, i) => BigInt(i * 25)));
    const accepted = node.calls.filter((call) => call.ok);
    expect(accepted.every((call) => call.to - call.from + 1n <= 300n)).toBe(true);
    // The accepted ranges tile the requested range exactly once.
    const covered = accepted.map((call) => [call.from, call.to]).sort((a, b) => Number(a[0]! - b[0]!));
    expect(covered[0]![0]).toBe(0n);
    expect(covered.at(-1)![1]).toBe(999n);
    for (let i = 1; i < covered.length; i++) expect(covered[i]![0]).toBe(covered[i - 1]![1]! + 1n);
  });

  it("rethrows a single-block failure naming the block and the filter when its receipts fail too", async () => {
    const node = createLogNode([rpcLog({address: POOL, block: 3n, logIndex: 0})], {failBlocks: [5n], receipts: false});
    const promise = fetchLogs(node.client, [{address: POOL, topics: [topic(7)]}], {from: 0n, to: 15n}, opts(100));
    await expect(promise).rejects.toThrow(
      /eth_getLogs failed at block 5 for address 0x0+[aA]1, topics \["0x0+7"\]: upstream timeout; eth_getBlockReceipts failed too/,
    );
    expect(node.calls.some((call) => call.from === 5n && call.to === 5n)).toBe(true);
  });

  it("gives up after a few requests when the provider rejects everything (depth-first splitting)", async () => {
    let requests = 0;
    const client = {
      async request() {
        requests++;
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw Object.assign(new Error("rate limit exceeded"), {code: -32005});
      },
    } as unknown as PublicClient;
    const filters = Array.from({length: 18}, (_, i) => ({address: addr(0x100 + i)}));
    await expect(fetchLogs(client, filters, {from: 1_000n, to: 1_499n}, opts(500))).rejects.toThrow(
      /eth_getLogs failed at block \d+ for address .*: rate limit exceeded/,
    );
    // Breadth-first (a FIFO limiter), nearly every split of every filter was requested first: about 4,600 here.
    expect(requests).toBeLessThan(100);
  });

  it("sends and splits nothing more once stopped, reporting the provider's error", async () => {
    const node = createLogNode([], {failBlocks: [5n]});
    let stopped = false;
    const client = {
      async request(args: unknown) {
        // The first answer arrives after the budget: requests in flight complete, nothing new is sent.
        const response = node.client.request(args as never);
        stopped = true;
        return response;
      },
    } as unknown as PublicClient;
    const promise = fetchLogs(client, [{address: POOL}], {from: 0n, to: 499n}, {...opts(500), stopped: () => stopped});
    await expect(promise).rejects.toThrow(/eth_getLogs failed at blocks 0-499 \(stopped\) for .*: upstream timeout/);
    expect(node.calls.map((call) => [call.from, call.to])).toEqual([[0n, 499n]]);
  });

  it("dedupes logs by blockHash:logIndex and sorts by block then log index", async () => {
    const logs = [
      rpcLog({address: TOKEN, block: 9n, logIndex: 4}),
      rpcLog({address: POOL, block: 9n, logIndex: 1}),
      rpcLog({address: POOL, block: 2n, logIndex: 7}),
      rpcLog({address: TOKEN, block: 2n, logIndex: 3}),
    ];
    // Both filters match every POOL log; the node also returns each TOKEN log twice.
    const node = createLogNode(logs, {echo: (log) => (log.address === TOKEN.toLowerCase() ? [log] : [])});
    const filters = [{address: POOL}, {address: [POOL, TOKEN]}];
    const result = await fetchLogs(node.client, filters, {from: 0n, to: 10n}, opts(4));
    expect(result.map((log) => [log.blockNumber, log.logIndex])).toEqual([
      [2n, 3],
      [2n, 7],
      [9n, 1],
      [9n, 4],
    ]);
  });

  it("drops removed logs", async () => {
    const node = createLogNode([
      rpcLog({address: POOL, block: 1n, logIndex: 0, removed: true}),
      rpcLog({address: POOL, block: 1n, logIndex: 1}),
    ]);
    const result = await fetchLogs(node.client, [{address: POOL}], {from: 0n, to: 1n}, opts(10));
    expect(result.map((log) => log.logIndex)).toEqual([1]);
  });

  it("converts RPC quantities to viem Log types and keeps blockTimestamp", async () => {
    const node = createLogNode([
      rpcLog({address: POOL, block: 0x1234n, logIndex: 0x11, txIndex: 3, blockTimestamp: "0x6553f100"}),
      rpcLog({address: POOL, block: 0x1235n, logIndex: 0}),
    ]);
    const [first, second] = await fetchLogs(node.client, [{address: POOL}], {from: 0x1200n, to: 0x1300n}, opts(2000));
    expect(first).toMatchObject({blockNumber: 0x1234n, logIndex: 0x11, transactionIndex: 3, removed: false});
    expect(first!.blockTimestamp).toBe(0x6553f100n);
    expect(typeof first!.blockHash).toBe("string");
    expect(second!.blockTimestamp).toBeUndefined();
    expect(second!.logIndex).toBe(0);
  });

  it("keeps at most four requests in flight", async () => {
    const node = createLogNode([], {delayMs: 5, maxBlocks: 50});
    await fetchLogs(node.client, [{address: POOL}, {address: TOKEN}], {from: 0n, to: 999n}, opts(100));
    expect(node.stats.maxInFlight).toBe(MAX_CONCURRENT_REQUESTS);
    expect(node.calls.length).toBeGreaterThan(20);
  });

  it("skips filters that match nothing and duplicate filters", async () => {
    const node = createLogNode([]);
    await fetchLogs(
      node.client,
      [
        {address: []},
        {address: TOKEN, topics: [topic(1), []]},
        {address: POOL},
        {address: POOL.toLowerCase() as typeof POOL},
      ],
      {from: 0n, to: 10n},
      opts(100),
    );
    expect(node.calls.map((call) => call.address)).toEqual([POOL]);
  });
});

describe("fetchLogs: a single block over the provider's result cap", () => {
  // Block 5: one transaction moving dust 40 times (Transfer topic 1, to POOL as topic 3), plus unrelated logs.
  const flood = Array.from({length: 40}, (_, i) =>
    rpcLog({address: TOKEN, block: 5n, logIndex: i, topics: [topic(1), topic(0xee), topic(0xa1)]}),
  );
  const logs = [
    rpcLog({address: POOL, block: 3n, logIndex: 0}),
    ...flood,
    rpcLog({address: TOKEN, block: 5n, logIndex: 40, txIndex: 1, topics: [topic(1), topic(0xee), topic(0xbb)]}),
    rpcLog({address: POOL, block: 5n, logIndex: 41, txIndex: 2, topics: [topic(2)]}),
    rpcLog({address: TOKEN, block: 7n, logIndex: 0, topics: [topic(1), topic(0xee), topic(0xa1)]}),
  ];
  const filters = [
    {address: TOKEN, topics: [topic(1), null, [topic(0xa1), topic(0xa3)]]},
    {address: [POOL, TOKEN], topics: [[topic(1), topic(2)]]},
  ];
  const key = (log: {blockNumber: bigint | null; logIndex: number | null}) => `${log.blockNumber}:${log.logIndex}`;

  it("reads it from its receipts, once for every filter, exactly as eth_getLogs would return it", async () => {
    const capped = createLogNode(logs, {maxResults: 10});
    const warnings: Array<Record<string, unknown>> = [];
    const log = {
      ...silentLogger,
      warn: (_msg: string, fields?: Record<string, unknown>) => warnings.push(fields ?? {}),
    };
    const result = await fetchLogs(capped.client, filters, {from: 0n, to: 9n}, {...opts(100), log: log as Logger, minResultCap: 20});
    const expected = await fetchLogs(createLogNode(logs).client, filters, {from: 0n, to: 9n}, opts(100));
    expect(result.map(key)).toEqual(expected.map(key));
    expect(result).toHaveLength(44);
    expect(capped.receiptCalls).toEqual([5n]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({block: 5n, error: "query returned more than 10 results"});
  });

  it("fails naming the block and both errors when the receipts cannot be read either", async () => {
    const node = createLogNode(logs, {maxResults: 10, receipts: false});
    await expect(fetchLogs(node.client, filters.slice(0, 1), {from: 0n, to: 9n}, opts(100))).rejects.toThrow(
      /eth_getLogs failed at block 5 for address .*: query returned more than 10 results; eth_getBlockReceipts failed too: the method eth_getBlockReceipts does not exist/,
    );
  });

  it("does not use receipts holding fewer matching logs than any result cap: an outage, not a cap", async () => {
    // eth_getLogs fails everywhere (rate limit, outage, method disabled); receipts work.
    const node = createLogNode(logs, {failBlocks: [...Array(10).keys()].map(BigInt)});
    await expect(fetchLogs(node.client, filters, {from: 0n, to: 9n}, opts(100))).rejects.toThrow(
      /eth_getLogs failed at block \d+ for .*: upstream timeout \(its receipts hold \d+ matching logs, too few for a result cap\)/,
    );
    // Gives up at the first single blocks, as without the fallback: a receipts request per filter reaching one before
    // the scan is aborted (at most the requests in flight), and a few dozen log queries.
    expect(node.receiptCalls.length).toBeLessThanOrEqual(MAX_CONCURRENT_REQUESTS);
    expect(node.calls.length).toBeLessThan(30);
  });

  it("uses receipts from MIN_RESULT_CAP matching logs on", async () => {
    const big = Array.from({length: MIN_RESULT_CAP}, (_, i) =>
      rpcLog({address: TOKEN, block: 8n, logIndex: i, topics: [topic(1), topic(0xee), topic(0xa1)]}),
    );
    const node = createLogNode(big, {maxResults: 10_000 - 1, failBlocks: [8n]});
    const result = await fetchLogs(node.client, filters.slice(0, 1), {from: 8n, to: 8n}, opts(100));
    expect(result).toHaveLength(MIN_RESULT_CAP);
    const short = createLogNode(big.slice(1), {failBlocks: [8n]});
    await expect(fetchLogs(short.client, filters.slice(0, 1), {from: 8n, to: 8n}, opts(100))).rejects.toThrow(
      /hold 999 matching logs, too few/,
    );
  });

  it("rejects receipts of another block", async () => {
    const node = createLogNode(logs, {
      maxResults: 10,
      receipts: (_block, receipts) => [...receipts, {blockNumber: "0x6", logs: []}],
    });
    await expect(fetchLogs(node.client, filters.slice(0, 1), {from: 5n, to: 5n}, opts(100))).rejects.toThrow(
      /eth_getBlockReceipts failed too: a receipt of block 0x6 was returned for block 5/,
    );
  });

  it("does not fall back once stopped", async () => {
    const node = createLogNode(logs, {maxResults: 10});
    const stopped = {...opts(100), stopped: () => true};
    const promise = fetchLogs(node.client, filters.slice(0, 1), {from: 5n, to: 5n}, stopped);
    await expect(promise).rejects.toThrow(/stopped/);
    expect(node.receiptCalls).toEqual([]);
  });
});

describe("matchesFilter", () => {
  const log = rpcLog({address: POOL, block: 1n, logIndex: 0, topics: [topic(1), topic(2)]});

  it("matches eth_getLogs semantics: any address, null or an OR-array per topic position", () => {
    expect(matchesFilter(log, {address: POOL.toLowerCase() as typeof POOL})).toBe(true);
    expect(matchesFilter(log, {address: [TOKEN, POOL], topics: [topic(1)]})).toBe(true);
    expect(matchesFilter(log, {address: POOL, topics: [null, [topic(3), topic(2)]]})).toBe(true);
    expect(matchesFilter(log, {address: TOKEN})).toBe(false);
    expect(matchesFilter(log, {address: POOL, topics: [topic(2)]})).toBe(false);
    expect(matchesFilter(log, {address: POOL, topics: [null, [topic(3)]]})).toBe(false);
  });

  it("matches a null position beyond the log's topics (providers disagree), never a value there", () => {
    expect(matchesFilter(log, {address: POOL, topics: [topic(1), topic(2), null]})).toBe(true);
    expect(matchesFilter(log, {address: POOL, topics: [topic(1), null, null, null]})).toBe(true);
    expect(matchesFilter(log, {address: POOL, topics: [topic(1), topic(2), topic(3)]})).toBe(false);
    expect(matchesFilter(log, {address: POOL, topics: [null, null, [topic(3)]]})).toBe(false);
  });
});

describe("fetchLogs: randomized provider failures", () => {
  // Deterministic PRNG, so a failing case can be replayed from its seed.
  const prng = (seed: number) => () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  const ADDRESSES = [addr(0xc1), addr(0xc2), addr(0xc3), addr(0xc4)];
  const TOPICS = [1, 2, 3, 4, 5].map(topic);
  const keyOf = (log: {blockNumber: bigint | null; logIndex: number | null}) => `${log.blockNumber}:${log.logIndex}`;

  it("returns exactly the matching logs, or fails only when a block can be read neither way", async () => {
    let resolved = 0;
    let rejected = 0;
    let fallbacks = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = prng(seed);
      const int = (n: number) => Math.floor(rnd() * n);
      const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
      const blocks = 2 + int(40);
      const logs: RpcLog[] = [];
      for (let block = 0; block < blocks; block++) {
        const count = rnd() < 0.15 ? 40 + int(40) : int(12);
        for (let i = 0; i < count; i++) {
          const topics = Array.from({length: int(5)}, () => pick(TOPICS));
          logs.push(rpcLog({address: pick(ADDRESSES), block: BigInt(block), logIndex: i, txIndex: int(3), topics}));
        }
      }
      const filters = Array.from({length: 1 + int(4)}, () => ({
        address: rnd() < 0.5 ? pick(ADDRESSES) : [pick(ADDRESSES), pick(ADDRESSES)],
        topics: Array.from({length: int(4)}, () => (rnd() < 0.4 ? null : rnd() < 0.5 ? pick(TOPICS) : [pick(TOPICS)])),
      }));
      const maxResults = rnd() < 0.7 ? 5 + int(30) : undefined;
      const failBlocks = Array.from({length: int(3)}, () => BigInt(int(blocks)));
      const noReceipts = new Set(Array.from({length: int(3)}, () => BigInt(int(blocks))));
      const node = createLogNode(logs, {
        maxResults,
        maxBlocks: rnd() < 0.5 ? 1 + int(20) : undefined,
        failBlocks,
        receipts: (block, receipts) => {
          if (noReceipts.has(block)) throw new Error(`receipts unavailable at ${block}`);
          return receipts;
        },
      });
      const range = {from: 0n, to: BigInt(blocks - 1)};
      const minResultCap = rnd() < 0.5 ? 0 : 1 + int(40);
      const matching = (block: bigint, filter: (typeof filters)[number]) =>
        logs.filter((log) => BigInt(log.blockNumber!) === block && matchesFilter(log, filter));
      // A block eth_getLogs cannot serve for some filter even alone, whose receipts are unavailable or hold too few
      // matching logs for a result cap.
      const unreadable = [...Array(blocks).keys()].map(BigInt).filter((block) =>
        filters.some((filter) => {
          const count = matching(block, filter).length;
          const failsAlone = failBlocks.includes(block) || (maxResults !== undefined && count > maxResults);
          return failsAlone && (noReceipts.has(block) || count < minResultCap);
        }),
      );
      try {
        const result = await fetchLogs(node.client, filters, range, {...opts(1 + int(30)), minResultCap});
        const expected = [...new Map(
          logs.filter((log) => filters.some((filter) => matchesFilter(log, filter))).map((log) => [keyOf(toLog(log)), log]),
        ).keys()].sort((a, b) => {
          const [ba, ia] = a.split(":").map(Number);
          const [bb, ib] = b.split(":").map(Number);
          return ba! - bb! || ia! - ib!;
        });
        expect(result.map(keyOf), `seed ${seed}`).toEqual(expected);
        expect(unreadable, `seed ${seed}: resolved although a block was unreadable`).toEqual([]);
        resolved++;
      } catch (error) {
        if (!(error instanceof Error) || !/eth_getBlockReceipts failed too|too few for a result cap/.test(error.message)) {
          throw error;
        }
        expect(unreadable.length, `seed ${seed}: failed although every block was readable`).toBeGreaterThan(0);
        rejected++;
      }
      // Receipts are read only for blocks eth_getLogs failed on alone, each at most once.
      expect(new Set(node.receiptCalls).size, `seed ${seed}`).toBe(node.receiptCalls.length);
      for (const block of node.receiptCalls) {
        expect(
          node.calls.some((call) => call.from === block && call.to === block && !call.ok),
          `seed ${seed}: receipts of ${block} without a failed single-block query`,
        ).toBe(true);
      }
      expect(node.stats.maxInFlight).toBeLessThanOrEqual(MAX_CONCURRENT_REQUESTS);
      fallbacks += node.receiptCalls.length;
    }
    // The cases exercise both outcomes and the fallback.
    expect(resolved).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(10);
    expect(fallbacks).toBeGreaterThan(100);
  });
});
