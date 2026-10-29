import type {PublicClient} from "viem";
import {describe, expect, it} from "vitest";

import {chunkRange, fetchLogs, MAX_CONCURRENT_REQUESTS} from "../src/chain/scanner.ts";
import {silentLogger} from "../src/log.ts";
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

  it("rethrows a single-block failure naming the block and the filter", async () => {
    const node = createLogNode([rpcLog({address: POOL, block: 3n, logIndex: 0})], {failBlocks: [5n]});
    const promise = fetchLogs(node.client, [{address: POOL, topics: [topic(7)]}], {from: 0n, to: 15n}, opts(100));
    await expect(promise).rejects.toThrow(
      /eth_getLogs failed at block 5 for address 0x0+[aA]1, topics \["0x0+7"\]: upstream timeout/,
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
