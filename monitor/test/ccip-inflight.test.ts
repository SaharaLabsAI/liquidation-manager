import type {Address, Hex} from "viem";
import {describe, expect, it} from "vitest";

import {computeInFlight} from "../src/ccip/inflight.ts";
import {emptyScanState, type ExecAttempt, type ExecRecord, type ScanState, type SentRecord} from "../src/ccip/store.ts";
import {BSC, ccAddr, ETH, OFFRAMP_V2, ONRAMP_V2, POOL} from "./helpers/ccip-fakes.ts";

const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const tx = (n: number): Hex => `0x${(1000 + n).toString(16).padStart(64, "0")}`;

function sent(n: number, overrides: Partial<SentRecord> = {}): SentRecord {
  return {
    messageId: id(n),
    sourceChain: "ethereum",
    destSelector: BSC,
    destChain: "bsc",
    amount: BigInt(n) * 100n,
    receiver: ccAddr(0x500 + n) as Address,
    sender: ccAddr(0x600),
    pool: POOL,
    onRamp: ONRAMP_V2.ethereum,
    kind: "OnRamp 2.0.0",
    sequenceNumber: BigInt(n),
    sentBlock: 100n,
    sentAt: 1_000,
    txHash: tx(n),
    logIndex: 1,
    ...overrides,
  };
}

function attempt(state: 2 | 3, block: bigint): ExecAttempt {
  return {state, block, txHash: tx(Number(block)), logIndex: 0, at: 2_000, ...(state === 3 ? {reason: "boom"} : {})};
}

function exec(n: number, attempts: ExecAttempt[]): ExecRecord {
  return {
    messageId: id(n),
    sourceChain: "ethereum",
    sourceSelector: ETH,
    sequenceNumber: BigInt(n),
    kind: "OffRamp 2.0.0",
    offRamp: OFFRAMP_V2.bsc,
    sahara: "release",
    attempts,
  };
}

const byId = <T extends {messageId: Hex}>(...records: T[]) =>
  Object.fromEntries(records.map((record) => [record.messageId, record])) as Record<Hex, T>;

describe("computeInFlight", () => {
  // Message 1: locked at ETH 100, released at BSC 200.
  const input = (snapshots: Record<string, bigint | undefined>, scan: Record<string, ScanState> = {}) => ({
    snapshots,
    sent: {ethereum: byId(sent(1))},
    exec: {bsc: byId(exec(1, [attempt(2, 200n)]))},
    scan,
  });

  it("counts a message locked by the source snapshot and not released by the destination snapshot", () => {
    expect(computeInFlight(input({ethereum: 150n, bsc: 199n}))).toMatchObject({
      total: 100n,
      uncertain: 0n,
      byLane: {"ethereum→bsc": 100n},
      entries: [{status: "pending", messageId: id(1), amount: 100n}],
    });
  });

  it("drops it once both snapshots include the lock and the release", () => {
    expect(computeInFlight(input({ethereum: 150n, bsc: 200n}))).toMatchObject({total: 0n, entries: []});
  });

  it("ignores it while neither snapshot includes it", () => {
    expect(computeInFlight(input({ethereum: 99n, bsc: 199n}))).toMatchObject({total: 0n, entries: []});
  });

  it("subtracts a release whose lock is after the source snapshot (the destination balance already paid it)", () => {
    expect(computeInFlight(input({ethereum: 99n, bsc: 250n}))).toMatchObject({
      total: -100n,
      entries: [{status: "released-ahead", amount: 100n}],
    });
  });

  it("counts failed messages until a manual re-execution at or before the destination snapshot", () => {
    const stores = {
      sent: {ethereum: byId(sent(2))},
      exec: {bsc: byId(exec(2, [attempt(3, 180n), attempt(2, 300n)]))},
    };
    const at = (bsc: bigint) => computeInFlight({snapshots: {ethereum: 500n, bsc}, ...stores, scan: {}});
    expect(at(179n).entries).toMatchObject([{status: "pending"}]);
    expect(at(250n)).toMatchObject({
      total: 200n,
      entries: [{status: "failed", failure: {block: 180n, reason: "boom"}}],
    });
    expect(at(300n)).toMatchObject({total: 0n, entries: []});
  });

  it("counts unverifiable messages and unlinked locks conservatively", () => {
    const scan: ScanState = {
      ...emptyScanState(),
      unlinked: [{txHash: tx(9), logIndex: 4, block: 90n, pool: POOL, amount: 7n, remoteSelector: BSC, at: 900}],
      pendingTxs: {
        [tx(10)]: {txHash: tx(10), block: 95n, locked: 11n, released: 0n, firstSeenAt: 950, attempts: 2, error: "x"},
        // After the snapshot: not counted.
        [tx(11)]: {txHash: tx(11), block: 900n, locked: 13n, released: 0n, firstSeenAt: 950, attempts: 1, error: "x"},
      },
    };
    const bscScan: ScanState = {
      ...emptyScanState(),
      pendingTxs: {
        [tx(12)]: {txHash: tx(12), block: 150n, locked: 0n, released: 300n, firstSeenAt: 950, attempts: 1, error: "x"},
      },
    };
    const result = computeInFlight({
      snapshots: {ethereum: 500n, bsc: 400n},
      sent: {
        ethereum: byId(
          sent(3, {destChain: null, destSelector: 42n}),
          sent(4, {destChain: "polygon"}),
          sent(5, {sentBlock: 600n}),
        ),
      },
      exec: {},
      scan: {ethereum: scan, bsc: bscScan},
    });
    expect(result.entries.map((entry) => [entry.status, entry.amount])).toEqual([
      ["unknown-destination", 300n],
      ["unverified", 400n],
      ["unlinked", 7n],
      ["unlinked", 11n],
    ]);
    expect(result.total).toBe(718n);
    // A release that could not be tied to its message may already have settled one of the counted ones.
    expect(result.uncertain).toBe(718n + 300n);
    expect(result.byLane).toEqual({"ethereum→?": 318n, "ethereum→polygon": 400n});
  });

  it("lists what the operator acknowledged without counting it", () => {
    const scan: ScanState = {
      ...emptyScanState(),
      unlinked: [{txHash: tx(9), logIndex: 4, block: 90n, pool: POOL, amount: 7n, remoteSelector: BSC, at: 900}],
      pendingTxs: {
        [tx(10)]: {txHash: tx(10), block: 95n, locked: 11n, released: 0n, firstSeenAt: 950, attempts: 2, error: "x"},
      },
    };
    const note = "explorer: released 2026-10-01";
    const upper = (hash: Hex) => hash.toUpperCase().replace("0X", "0x") as Hex;
    const result = computeInFlight({
      snapshots: {ethereum: 500n, bsc: 400n},
      sent: {ethereum: byId(sent(3, {destChain: null, destSelector: 42n}), sent(4, {destChain: "polygon"}), sent(6))},
      exec: {},
      scan: {ethereum: scan},
      acknowledged: [
        {chain: "ethereum", txHash: tx(9), note},
        {chain: "ethereum", txHash: upper(tx(10)), note},
        {chain: "ethereum", messageId: id(3), note},
        {chain: "ethereum", messageId: id(4), note},
        // Settlement on a configured destination is observable: not acknowledgeable.
        {chain: "ethereum", messageId: id(6), note},
        // Another chain's transaction.
        {chain: "bsc", txHash: tx(9), note},
      ],
    });
    expect(result.entries.map((entry) => [entry.status, entry.amount, entry.note])).toEqual([
      ["acknowledged", 300n, note],
      ["acknowledged", 400n, note],
      ["pending", 600n, undefined],
      ["acknowledged", 7n, note],
      ["acknowledged", 11n, note],
    ]);
    expect(result).toMatchObject({total: 600n, uncertain: 0n, byLane: {"ethereum→bsc": 600n}});
  });

  it("skips source chains without a snapshot", () => {
    expect(computeInFlight(input({bsc: 250n})).entries).toEqual([]);
  });
});
