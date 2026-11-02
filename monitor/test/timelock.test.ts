import {concat, decodeFunctionData, encodeFunctionData, keccak256, toHex, zeroHash, type Hex} from "viem";
import {describe, expect, it} from "vitest";

import {tokenPoolAbi} from "../src/abi/external.ts";
import {guardianControllerAbi, liquidityManagerAbi, saharaTimelockAbi} from "../src/abi/generated.ts";
import type {fetchLogs} from "../src/chain/scanner.ts";
import {scanChunk} from "../src/daemon.ts";
import {formatTimestamp} from "../src/format.ts";
import {eventRules} from "../src/rules/events.ts";
import {TIMELOCK_ROLES} from "../src/rules/calls.ts";
import {
  guardianCancelCalldata,
  hashOperation,
  hashOperationBatch,
  OPERATION_STATE,
  readPendingOps,
  scheduledAsBatch,
  timelockEventsRule,
  timelockNamespace,
  timelockQueueRule,
  type PendingOp,
} from "../src/rules/timelock.ts";
import type {Alert, EventRule} from "../src/types.ts";
import {
  blockTime,
  eventLog,
  fakeClient,
  scheduleLogs,
  TL,
  tlAddresses,
  tlContext,
  txHash,
  type Call,
} from "./helpers/timelock-fixtures.ts";

const DELAY = 259200n; // 72h
const controllerRule = eventRules.find((rule) => rule.id === "controller") as EventRule;
const BLOCK = 100n;
const RANGE = {from: BLOCK, to: BLOCK + 10n};
const SALT = keccak256(toHex("salt"));

const setGuardianData = (guardian = TL.newGuardian) =>
  encodeFunctionData({abi: liquidityManagerAbi, functionName: "setGuardian", args: [guardian]});
const setGuardian = (data = setGuardianData(), value = 0n): Call => ({target: TL.manager, value, data});
const thresholds: Call = {
  target: TL.manager,
  value: 0n,
  data: encodeFunctionData({
    abi: liquidityManagerAbi,
    functionName: "setPoolThresholds",
    args: [TL.pool, 10n ** 21n, 2n * 10n ** 21n, 3n * 10n ** 21n],
  }),
};
const acceptPool: Call = {
  target: TL.pool,
  value: 0n,
  data: encodeFunctionData({abi: tokenPoolAbi, functionName: "acceptOwnership"}),
};
const setRebalancer: Call = {
  target: TL.pool,
  value: 0n,
  data: encodeFunctionData({abi: tokenPoolAbi, functionName: "setRebalancer", args: [TL.adapter]}),
};

interface Scheduled {
  id: Hex;
  logs: ReturnType<typeof scheduleLogs>;
}

function single(call: Call, opts: {predecessor?: Hex; salt?: Hex; tx?: number; block?: bigint} = {}): Scheduled {
  const predecessor = opts.predecessor ?? zeroHash;
  const salt = opts.salt ?? zeroHash;
  const id = hashOperation(call, predecessor, salt);
  const logs = scheduleLogs(id, [call], {
    predecessor,
    salt,
    delay: DELAY,
    txHash: txHash(opts.tx ?? 1),
    blockNumber: opts.block ?? BLOCK,
  });
  return {id, logs};
}

function batch(calls: Call[], opts: {predecessor?: Hex; salt?: Hex; tx?: number} = {}): Scheduled {
  const predecessor = opts.predecessor ?? zeroHash;
  const salt = opts.salt ?? zeroHash;
  const id = hashOperationBatch(calls, predecessor, salt);
  const tx = txHash(opts.tx ?? 1);
  const logs = scheduleLogs(id, calls, {predecessor, salt, delay: DELAY, txHash: tx, blockNumber: BLOCK});
  return {id, logs};
}

function field(alert: Alert | undefined, label: string): string | undefined {
  return alert?.fields?.find((f) => f.label === label)?.value;
}

function fieldsMatching(alert: Alert | undefined, pattern: RegExp): string[] {
  return (alert?.fields ?? []).filter((f) => pattern.test(f.label)).map((f) => f.value);
}

/** Reassembles calldata split over "(part i/n)" fields. */
function calldataFrom(alert: Alert | undefined, label: string): Hex {
  return fieldsMatching(alert, new RegExp(`^${label.replace(/[()]/g, "\\$&")}`)).join("") as Hex;
}

async function run(logs: ReturnType<typeof scheduleLogs>, ctx = tlContext()) {
  await timelockEventsRule.onLogs(ctx, logs, RANGE);
  return ctx;
}

/** The logs of one transaction (a Safe multiSend), renumbered in the order given. */
function inOneTx(...groups: Array<ReturnType<typeof scheduleLogs>>): ReturnType<typeof scheduleLogs> {
  return groups.flat().map((log, i) => ({...log, transactionHash: txHash(20), logIndex: i}));
}

const cancelled = (id: Hex) => eventLog(saharaTimelockAbi, "Cancelled", {id}, {txHash: txHash(20), blockNumber: BLOCK});

describe("operation ids", () => {
  it("recomputes schedule and scheduleBatch ids, including a one-call batch", () => {
    const one = hashOperation(thresholds, zeroHash, SALT);
    expect(scheduledAsBatch({id: one, calls: [thresholds], predecessor: zeroHash, salt: SALT})).toBe(false);
    const oneBatch = hashOperationBatch([thresholds], zeroHash, SALT);
    expect(oneBatch).not.toBe(one);
    expect(scheduledAsBatch({id: oneBatch, calls: [thresholds], predecessor: zeroHash, salt: SALT})).toBe(true);
    // Wrong salt: matches neither.
    expect(scheduledAsBatch({id: one, calls: [thresholds], predecessor: zeroHash, salt: null})).toBeNull();
    const wrongSalt = {id: one, calls: [thresholds], predecessor: zeroHash, salt: null};
    expect(() => guardianCancelCalldata(wrongSalt, TL.controller)).toThrow();
  });
});

describe("timelockEventsRule: CallScheduled", () => {
  it("has no filters without a Timelock and watches the controller for attribution", () => {
    expect(timelockEventsRule.filters(tlContext({addresses: tlAddresses({timelock: undefined})}))).toEqual([]);
    const filters = timelockEventsRule.filters(tlContext());
    expect(filters).toHaveLength(2);
    expect(filters[0]?.address).toBe(TL.timelock);
    expect((filters[0]?.topics?.[0] as Hex[]).length).toBe(8);
    expect(filters[1]?.address).toBe(TL.controller);
  });

  it("alerts a single schedule with the exact Guardian cancel calldata", async () => {
    const {id, logs} = single(thresholds);
    const ctx = await run(logs);
    expect(ctx.alerter.emitted).toHaveLength(1);
    const alert = ctx.alerter.emitted[0];
    expect(alert).toMatchObject({
      key: `ethereum:timelock:scheduled:${id}`,
      kind: "event",
      severity: "high",
      rule: "timelock.scheduled",
      title: "Timelock operation scheduled: LiquidityManager.setPoolThresholds",
    });
    expect(field(alert, "Operation id")).toBe(id);
    expect(field(alert, "Scheduled with")).toBe("schedule");
    expect(field(alert, "Call 1/1")).toBe(
      `LiquidityManager.setPoolThresholds(pool=Pool ${TL.pool}, minimum=1,000 SAHARA, refillTrigger=2,000 SAHARA, ` +
        "refillTarget=3,000 SAHARA)",
    );
    expect(field(alert, "Executable at")).toContain("delay 3d");
    expect(field(alert, "Predecessor")).toBe("none");
    expect(field(alert, "Salt")).toBe("0 (none)");
    expect(field(alert, "Guardian action")).toContain(
      "GuardianController.cancel(address,uint256,bytes,bytes32,bytes32)",
    );
    expect(field(alert, "Cancel tx: to")).toBe(`GuardianController ${TL.controller}`);
    expect(alert?.links?.[0]?.url).toBe(`https://etherscan.io/tx/${txHash(1)}`);

    const decoded = decodeFunctionData({abi: guardianControllerAbi, data: calldataFrom(alert, "Cancel tx: calldata")});
    expect(decoded.functionName).toBe("cancel");
    expect(decoded.args).toEqual([thresholds.target, 0n, thresholds.data, zeroHash, zeroHash]);

    const op = readPendingOps(ctx.store, "ethereum")[id];
    expect(op).toMatchObject({
      id,
      predecessor: zeroHash,
      salt: null,
      delay: DELAY,
      scheduledAt: blockTime(BLOCK),
      readyAt: blockTime(BLOCK) + Number(DELAY),
      txHash: txHash(1),
      severity: "high",
      protected: false,
      status: "pending",
      batch: false,
      scheduledBlock: BLOCK,
    });
    expect(op?.calls).toEqual([thresholds]);
    expect(op?.summary).toBe(field(alert, "Call 1/1"));
  });

  it("groups a batch, picks up the CallSalt emitted after it, and builds cancelBatch", async () => {
    const calls = [acceptPool, setRebalancer, thresholds];
    const {id, logs} = batch(calls, {salt: SALT});
    expect(logs.at(-1)?.topics[0]).not.toBe(logs[0]?.topics[0]); // CallSalt last
    const ctx = await run(logs);
    expect(ctx.alerter.emitted).toHaveLength(1);
    const alert = ctx.alerter.emitted[0];
    expect(alert?.severity).toBe("critical"); // pool admin calls
    expect(alert?.title).toBe(
      "Timelock batch (3 calls) scheduled: " +
        "Pool.acceptOwnership, Pool.setRebalancer, LiquidityManager.setPoolThresholds",
    );
    expect(field(alert, "Scheduled with")).toBe("scheduleBatch");
    expect(field(alert, "Salt")).toBe(SALT);
    expect(field(alert, "Call 2/3")).toBe(`Pool.setRebalancer(rebalancer=Adapter #1 ${TL.adapter})`);
    const decoded = decodeFunctionData({abi: guardianControllerAbi, data: calldataFrom(alert, "Cancel tx: calldata")});
    expect(decoded.functionName).toBe("cancelBatch");
    expect(decoded.args).toEqual([
      calls.map((c) => c.target),
      calls.map((c) => c.value),
      calls.map((c) => c.data),
      zeroHash,
      SALT,
    ]);
    const op = readPendingOps(ctx.store, "ethereum")[id];
    expect(op).toMatchObject({salt: SALT, batch: true, severity: "critical"});
    expect(op?.summary).toBe(
      "batch of 3: Pool.acceptOwnership, Pool.setRebalancer, LiquidityManager.setPoolThresholds",
    );
  });

  it("cancels a one-call scheduleBatch with cancelBatch", async () => {
    const {id, logs} = batch([thresholds]);
    const ctx = await run(logs);
    const alert = ctx.alerter.emitted[0];
    expect(field(alert, "Scheduled with")).toBe("scheduleBatch");
    const decoded = decodeFunctionData({abi: guardianControllerAbi, data: calldataFrom(alert, "Cancel tx: calldata")});
    expect(decoded.functionName).toBe("cancelBatch");
    expect(readPendingOps(ctx.store, "ethereum")[id]?.batch).toBe(true);
  });

  it("separates two operations scheduled in one transaction", async () => {
    const a = single(thresholds, {salt: SALT});
    const b = single(setRebalancer);
    // Renumber the second op's logs after the first in the same tx.
    const logs = [...a.logs, ...b.logs.map((log, i) => ({...log, logIndex: a.logs.length + i}))];
    const ctx = await run(logs);
    expect(ctx.alerter.emitted.map((alert) => alert.key)).toEqual([
      `ethereum:timelock:scheduled:${a.id}`,
      `ethereum:timelock:scheduled:${b.id}`,
    ]);
    const ops = readPendingOps(ctx.store, "ethereum");
    expect(ops[a.id]?.salt).toBe(SALT);
    expect(ops[b.id]?.salt).toBeNull();
  });

  it("says the Guardian cannot cancel a protected setGuardian and gives the Governance cancel", async () => {
    const {id, logs} = single(setGuardian());
    const ctx = await run(logs);
    const alert = ctx.alerter.emitted[0];
    expect(alert?.severity).toBe("critical");
    expect(alert?.title).toBe("Guardian recovery scheduled on Timelock (protected setGuardian)");
    expect(field(alert, "Guardian action")).toBe(
      "Guardian cannot cancel (protected setGuardian); only the Governance Safe can cancel via Timelock.cancel(id)",
    );
    expect(field(alert, "Cancel tx: calldata")).toBeUndefined();
    expect(fieldsMatching(alert, /^Warning$/)).toEqual([]);
    const gov = decodeFunctionData({abi: saharaTimelockAbi, data: calldataFrom(alert, "Governance cancel: calldata")});
    expect(gov).toEqual({functionName: "cancel", args: [id]});
    expect(field(alert, "Governance cancel: to")).toBe(`Timelock ${TL.timelock}`);
    expect(alert?.note).toMatch(/Protected Guardian recovery/);
    expect(readPendingOps(ctx.store, "ethereum")[id]?.protected).toBe(true);
  });

  it("treats a one-call batch of the canonical setGuardian as protected", async () => {
    const {id, logs} = batch([setGuardian()]);
    const ctx = await run(logs);
    expect(readPendingOps(ctx.store, "ethereum")[id]?.protected).toBe(true);
    expect(field(ctx.alerter.emitted[0], "Cancel tx: calldata")).toBeUndefined();
  });

  it("flags a protected setGuardian with a predecessor", async () => {
    const parent = single(thresholds, {tx: 1});
    const child = single(setGuardian(), {predecessor: parent.id, tx: 2});
    const ctx = await run([...parent.logs, ...child.logs]);
    const alert = ctx.alerter.emitted[1];
    expect(alert?.severity).toBe("critical");
    expect(fieldsMatching(alert, /^Warning$/).join(" ")).toMatch(/non-zero predecessor/);
    const parentSummary = readPendingOps(ctx.store, "ethereum")[parent.id]?.summary;
    expect(field(alert, "Predecessor")).toBe(`${parent.id} (pending: ${parentSummary})`);
  });

  const unprotected: Array<[string, () => Scheduled, RegExp]> = [
    ["padded to 37 bytes", () => single(setGuardian(concat([setGuardianData(), "0x00"]))), /37 bytes, not 36/],
    ["cut to 35 bytes", () => single(setGuardian(setGuardianData().slice(0, -2) as Hex)), /35 bytes, not 36/],
    ["sent with value", () => single(setGuardian(setGuardianData(), 1n)), /carries value/],
    [
      "dirty upper bits",
      () => single(setGuardian(`${setGuardianData().slice(0, 10)}01${setGuardianData().slice(12)}` as Hex)),
      /upper bits/,
    ],
    ["in a mixed batch", () => batch([setGuardian(), thresholds]), /one of 2 calls in a batch/],
  ];
  for (const [name, make, reason] of unprotected) {
    it(`flags a setGuardian ${name} as cancellable by the Guardian`, async () => {
      const {id, logs} = make();
      const ctx = await run(logs);
      const alert = ctx.alerter.emitted[0];
      expect(alert?.severity).toBe("critical");
      expect(alert?.title).not.toMatch(/protected/);
      const warnings = fieldsMatching(alert, /^Warning$/).join(" ");
      expect(warnings).toMatch(/NOT protected/);
      expect(warnings).toMatch(reason);
      expect(warnings).toMatch(/the current Guardian can cancel this recovery/);
      const op = readPendingOps(ctx.store, "ethereum")[id];
      expect(op?.protected).toBe(false);
      // The Guardian can cancel it, and the calldata reproduces the id.
      const cancelData = calldataFrom(alert, "Cancel tx: calldata");
      const decoded = decodeFunctionData({abi: guardianControllerAbi, data: cancelData});
      const args = decoded.args as readonly unknown[];
      if (decoded.functionName === "cancel") {
        const call = {target: args[0], value: args[1], data: args[2]} as Call;
        expect(hashOperation(call, args[3] as Hex, args[4] as Hex)).toBe(id);
      } else {
        const [targets, values, payloads] = args as [Hex[], bigint[], Hex[]];
        const calls = targets.map((target, i) => ({target, value: values[i], data: payloads[i]}) as Call);
        expect(hashOperationBatch(calls, args[3] as Hex, args[4] as Hex)).toBe(id);
      }
    });
  }

  it("cannot build a cancel when the salt is missing, and says so", async () => {
    const {logs} = single(thresholds, {salt: SALT});
    const ctx = await run(logs.slice(0, 1)); // drop CallSalt
    const alert = ctx.alerter.emitted[0];
    expect(alert?.severity).toBe("critical");
    expect(field(alert, "Scheduled with")).toBe("unknown (id mismatch)");
    expect(field(alert, "Guardian action")).toMatch(/Cannot build the Guardian cancel calldata/);
    expect(field(alert, "Cancel tx: calldata")).toBeUndefined();
  });

  it("marks the ETA as estimated when the block timestamp is unavailable", async () => {
    const ctx = tlContext({client: fakeClient({failGetBlock: true})});
    await run(single(thresholds).logs, ctx);
    expect(field(ctx.alerter.emitted[0], "Executable at")).toMatch(/estimated: block timestamp unavailable/);
  });

  it("says so when no GuardianController is resolved", async () => {
    const ctx = tlContext({addresses: tlAddresses({controller: undefined})});
    await run(single(thresholds).logs, ctx);
    const alert = ctx.alerter.emitted[0];
    expect(field(alert, "Guardian action")).toMatch(/No GuardianController resolved/);
    expect(calldataFrom(alert, "Governance cancel: calldata")).toMatch(/^0x/);
  });

  it("splits very long cancel calldata into parts that reassemble exactly", async () => {
    const big: Call = {target: TL.pool, value: 0n, data: concat([acceptPool.data, `0x${"ab".repeat(4000)}`])};
    const {id, logs} = single(big);
    const ctx = await run(logs);
    const alert = ctx.alerter.emitted[0];
    const parts = fieldsMatching(alert, /^Cancel tx: calldata/);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 3000)).toBe(true);
    const op = readPendingOps(ctx.store, "ethereum")[id] as PendingOp;
    expect(calldataFrom(alert, "Cancel tx: calldata")).toBe(guardianCancelCalldata(op, TL.controller).data);
  });

  it("shows updateDelay as old -> new using the delay at the scheduling block", async () => {
    const call: Call = {
      target: TL.timelock,
      value: 0n,
      data: encodeFunctionData({abi: saharaTimelockAbi, functionName: "updateDelay", args: [86400n]}),
    };
    const client = fakeClient({read: (fn) => (fn === "getMinDelay" ? DELAY : new Error(fn))});
    const ctx = await run(single(call).logs, tlContext({client}));
    expect(field(ctx.alerter.emitted[0], "Call 1/1")).toBe("Timelock.updateDelay(newDelay=3d -> 1d (86400s))");
  });

  it("is idempotent on a rescan and gives a re-schedule of a cancelled id its own key", async () => {
    const first = single(thresholds, {tx: 1});
    const ctx = await run(first.logs);
    const cancel = eventLog(saharaTimelockAbi, "Cancelled", {id: first.id}, {
      txHash: txHash(2),
      blockNumber: BLOCK + 1n,
    });
    await run([cancel], ctx);
    // Rescan of the scheduling tx: same key, status kept.
    await run(first.logs, ctx);
    expect(ctx.alerter.emitted[2]?.key).toBe(`ethereum:timelock:scheduled:${first.id}`);
    expect(readPendingOps(ctx.store, "ethereum")[first.id]?.status).toBe("cancelled");
    // Same operation proposed again in a new tx: a new proposal, new key, pending again.
    const again = single(thresholds, {tx: 3, block: BLOCK + 5n});
    await run(again.logs, ctx);
    expect(ctx.alerter.emitted[3]?.key).toBe(`ethereum:timelock:scheduled:${first.id}:${txHash(3)}`);
    expect(readPendingOps(ctx.store, "ethereum")[first.id]).toMatchObject({status: "pending", txHash: txHash(3)});
    // A replayed chunk with the re-schedule keeps its key (the bare key may have left the dedupe window).
    await run(again.logs, ctx);
    expect(ctx.alerter.emitted[4]?.key).toBe(`ethereum:timelock:scheduled:${first.id}:${txHash(3)}`);
    expect(readPendingOps(ctx.store, "ethereum")[first.id]).toMatchObject({status: "pending", txHash: txHash(3)});
  });

  it("is idempotent on a rescan of a transaction that cancels an op and schedules it again", async () => {
    const first = single(thresholds, {tx: 1});
    const ctx = await run(first.logs);
    // One Safe transaction: cancel the pending op, then propose it again (e.g. with a new delay).
    const again = inOneTx([cancelled(first.id)], single(thresholds).logs);
    await run(again, ctx);
    const keys = ctx.alerter.emitted.map((alert) => alert.key);
    expect(keys.slice(1)).toEqual([
      `ethereum:timelock:${txHash(20)}:0`,
      `ethereum:timelock:scheduled:${first.id}:${txHash(20)}`,
    ]);
    const stored = readPendingOps(ctx.store, "ethereum")[first.id];
    expect(stored).toMatchObject({status: "pending", txHash: txHash(20)});
    await run(again, ctx);
    expect(ctx.alerter.emitted.slice(3).map((alert) => alert.key)).toEqual(keys.slice(1));
    expect(readPendingOps(ctx.store, "ethereum")[first.id]).toEqual(stored);
  });

  it("keeps an op pending when a chunk that cancels it, then schedules it again, is processed again", async () => {
    // The daemon hands a chunk to every rule again when a later rule failed on it (or after a crash), on the state the
    // first attempt left: the op as scheduled again in tx 3, which tx 2's Cancelled must not close on the second pass.
    const first = single(thresholds, {tx: 1});
    const ctx = await run(first.logs);
    const cancel = eventLog(saharaTimelockAbi, "Cancelled", {id: first.id}, {
      txHash: txHash(2),
      blockNumber: BLOCK + 1n,
    });
    const again = single(thresholds, {tx: 3, block: BLOCK + 2n});
    let failing = true;
    const later: EventRule = {
      id: "later",
      filters: () => [],
      async onLogs() {
        if (failing) throw new Error("boom");
      },
    };
    const fetch = (async () => [cancel, ...again.logs]) as unknown as typeof fetchLogs;
    const chunk = {from: BLOCK + 1n, to: BLOCK + 2n};
    await expect(scanChunk(ctx, [timelockEventsRule, later], chunk, fetch)).rejects.toThrow(/rule later failed/);
    const stored = readPendingOps(ctx.store, "ethereum")[first.id];
    expect(stored).toMatchObject({status: "pending", txHash: txHash(3)});
    expect(stored?.closedAt).toBeUndefined();
    const keys = ctx.alerter.emitted.map((alert) => alert.key);

    failing = false;
    await scanChunk(ctx, [timelockEventsRule, later], chunk, fetch);
    expect(readPendingOps(ctx.store, "ethereum")[first.id]).toEqual(stored);
    expect(ctx.alerter.emitted.slice(keys.length).map((alert) => alert.key)).toEqual(keys.slice(1));
    // Still reminded once executable.
    const client = fakeClient({
      read: (fn) => (fn === "getOperationState" ? OPERATION_STATE.Ready : BigInt(stored!.readyAt)),
    });
    const {conditions} = await timelockQueueRule.check({...ctx, client}, BLOCK + 2n + DELAY / 12n);
    expect(conditions.map((c) => c.key)).toEqual([`ethereum:timelock-queue:${first.id}:ready`]);
  });

  it("ignores events of the same shape from other contracts", async () => {
    const foreign = eventLog(
      saharaTimelockAbi,
      "RoleGranted",
      {role: TIMELOCK_ROLES.PROPOSER_ROLE, account: TL.stranger, sender: TL.stranger},
      {txHash: txHash(9), blockNumber: BLOCK, address: TL.stranger},
    );
    const ctx = await run([foreign]);
    expect(ctx.alerter.emitted).toEqual([]);
  });

  it("does not crash on an undecodable log", async () => {
    const {logs} = single(thresholds);
    const broken = {...logs[0], data: "0x1234"} as (typeof logs)[number];
    const ctx = await run([broken]);
    expect(ctx.alerter.emitted).toEqual([]);
  });
});

describe("timelockEventsRule: one id scheduled again in the same transaction", () => {
  it("tracks schedule -> cancel -> schedule as two proposals and keeps the second pending", async () => {
    const op = single(thresholds, {salt: SALT});
    // The delay is not part of the id: the first scheduling asked for twice the delay.
    const pos = {predecessor: zeroHash, salt: SALT, txHash: txHash(20), blockNumber: BLOCK};
    const longer = scheduleLogs(op.id, [thresholds], {...pos, delay: 2n * DELAY});
    const logs = inOneTx(longer, [cancelled(op.id)], op.logs);
    const client = fakeClient({
      read: (fn) => (fn === "getOperationState" ? OPERATION_STATE.Waiting : BigInt(blockTime(BLOCK) + Number(DELAY))),
    });
    const ctx = await run(logs, tlContext({client}));
    expect(ctx.alerter.emitted.map((alert) => [alert.rule, alert.key])).toEqual([
      ["timelock.scheduled", `ethereum:timelock:scheduled:${op.id}`],
      ["timelock.cancelled", `ethereum:timelock:${txHash(20)}:2`],
      ["timelock.scheduled", `ethereum:timelock:scheduled:${op.id}:${txHash(20)}:1`],
    ]);
    const [first, cancel, second] = ctx.alerter.emitted;
    // Each scheduling is the one call it logged, not a batch merged from both.
    for (const alert of [first, second]) {
      expect(field(alert, "Scheduled with")).toBe("schedule");
      expect(fieldsMatching(alert, /^Call \d+\/\d+$/)).toHaveLength(1);
      expect(field(alert, "Salt")).toBe(SALT);
      expect(fieldsMatching(alert, /^Warning$/)).toEqual([]);
    }
    expect(first?.title).toBe(
      "Timelock operation scheduled: LiquidityManager.setPoolThresholds (cancelled in the same transaction)",
    );
    expect(field(first, "Status")).toMatch(/^Cancelled later in this transaction/);
    expect(field(first, "Executable at")).toContain("delay 6d");
    expect(field(first, "Guardian action")).toBeUndefined();
    expect(field(first, "Cancel tx: calldata")).toBeUndefined();
    expect(first?.note).toBeUndefined();
    expect(field(cancel, "Operation")).toMatch(/^LiquidityManager.setPoolThresholds/);
    expect(second?.title).toBe("Timelock operation scheduled: LiquidityManager.setPoolThresholds");
    expect(field(second, "Status")).toBeUndefined();
    expect(field(second, "Executable at")).toContain("delay 3d");
    const cancelData = calldataFrom(second, "Cancel tx: calldata");
    expect(decodeFunctionData({abi: guardianControllerAbi, data: cancelData})).toEqual({
      functionName: "cancel",
      args: [thresholds.target, 0n, thresholds.data, zeroHash, SALT],
    });

    const stored = readPendingOps(ctx.store, "ethereum")[op.id];
    // alertKey is the transaction's first scheduling key: later ones derive theirs from the tx hash on a rescan.
    expect(stored).toMatchObject({
      status: "pending",
      txHash: txHash(20),
      batch: false,
      salt: SALT,
      delay: DELAY,
      readyAt: blockTime(BLOCK) + Number(DELAY),
      alertKey: first?.key,
    });
    expect(stored?.calls).toEqual([thresholds]);
    // The live proposal is reminded, with its cancel instruction.
    const {conditions} = await timelockQueueRule.check(ctx, BLOCK + BigInt((2.5 * 86400) / 12));
    expect(conditions.map((c) => c.key)).toEqual([`ethereum:timelock-queue:${op.id}:soon`]);
    expect(calldataFrom(conditions[0], "Cancel tx: calldata")).toBe(cancelData);
  });

  it("separates scheduleBatch -> cancel -> scheduleBatch of one id and builds cancelBatch", async () => {
    const calls = [acceptPool, setRebalancer];
    const op = batch(calls, {salt: SALT});
    const ctx = await run(inOneTx(op.logs, [cancelled(op.id)], op.logs));
    expect(ctx.alerter.emitted.map((alert) => alert.rule)).toEqual([
      "timelock.scheduled",
      "timelock.cancelled",
      "timelock.scheduled",
    ]);
    const [first, , second] = ctx.alerter.emitted;
    for (const alert of [first, second]) {
      expect(field(alert, "Scheduled with")).toBe("scheduleBatch");
      expect(fieldsMatching(alert, /^Call \d+\/\d+$/)).toHaveLength(2);
      expect(fieldsMatching(alert, /^Warning$/)).toEqual([]);
    }
    const decoded = decodeFunctionData({abi: guardianControllerAbi, data: calldataFrom(second, "Cancel tx: calldata")});
    expect(decoded.functionName).toBe("cancelBatch");
    expect(decoded.args).toEqual([
      calls.map((c) => c.target),
      calls.map((c) => c.value),
      calls.map((c) => c.data),
      zeroHash,
      SALT,
    ]);
    const stored = readPendingOps(ctx.store, "ethereum")[op.id];
    expect(stored).toMatchObject({status: "pending", batch: true, salt: SALT});
    expect(stored?.calls).toEqual(calls);
  });

  it("treats schedule -> cancel -> scheduleBatch of the same call as two operations", async () => {
    const one = single(thresholds);
    const asBatch = batch([thresholds]);
    // hashOperation and hashOperationBatch encode differently, so a call cannot keep its id across the two.
    expect(asBatch.id).not.toBe(one.id);
    const ctx = await run(inOneTx(one.logs, [cancelled(one.id)], asBatch.logs));
    const ops = readPendingOps(ctx.store, "ethereum");
    expect(ops[one.id]).toMatchObject({status: "cancelled", batch: false});
    expect(ops[asBatch.id]).toMatchObject({status: "pending", batch: true});
    const second = ctx.alerter.emitted[2];
    expect(second?.key).toBe(`ethereum:timelock:scheduled:${asBatch.id}`);
    const decoded = decodeFunctionData({abi: guardianControllerAbi, data: calldataFrom(second, "Cancel tx: calldata")});
    expect(decoded.functionName).toBe("cancelBatch");
  });

  const sequences: Array<[string, (op: Scheduled) => ReturnType<typeof scheduleLogs>, PendingOp["status"]]> = [
    ["schedule -> cancel -> schedule", (op) => inOneTx(op.logs, [cancelled(op.id)], op.logs), "pending"],
    [
      "schedule -> cancel -> schedule -> cancel",
      (op) => inOneTx(op.logs, [cancelled(op.id)], op.logs, [cancelled(op.id)]),
      "cancelled",
    ],
  ];
  for (const [name, make, status] of sequences) {
    it(`replays ${name} with the same keys and stored state (${status})`, async () => {
      const op = single(thresholds, {salt: SALT});
      const logs = make(op);
      const ctx = await run(logs);
      const keys = ctx.alerter.emitted.map((alert) => alert.key);
      expect(new Set(keys).size).toBe(keys.length);
      const stored = readPendingOps(ctx.store, "ethereum")[op.id];
      expect(stored?.status).toBe(status);
      await run(logs, ctx);
      expect(ctx.alerter.emitted.slice(keys.length).map((alert) => alert.key)).toEqual(keys);
      expect(readPendingOps(ctx.store, "ethereum")[op.id]).toEqual(stored);
    });
  }
});

describe("timelockEventsRule: Cancelled, CallExecuted and admin events", () => {
  it("marks a cancelled op and attributes it to the Guardian", async () => {
    const {id, logs} = single(thresholds);
    const ctx = await run(logs);
    const tx = txHash(5);
    await run(
      [
        eventLog(saharaTimelockAbi, "Cancelled", {id}, {txHash: tx, blockNumber: BLOCK + 2n, logIndex: 0}),
        eventLog(guardianControllerAbi, "ProposalCancelled", {id, guardian: TL.guardian}, {
          txHash: tx,
          blockNumber: BLOCK + 2n,
          logIndex: 1,
        }),
      ],
      ctx,
    );
    const alert = ctx.alerter.emitted[1];
    expect(alert).toMatchObject({
      key: `ethereum:timelock:${tx}:0`,
      severity: "high",
      rule: "timelock.cancelled",
      title: "Timelock operation cancelled: LiquidityManager.setPoolThresholds",
    });
    expect(field(alert, "Cancelled by Guardian (via GuardianController)")).toBe(`Guardian ${TL.guardian}`);
    expect(readPendingOps(ctx.store, "ethereum")[id]).toMatchObject({
      status: "cancelled",
      closedAt: blockTime(BLOCK + 2n),
    });
  });

  it("raises a cancelled Guardian change to critical", async () => {
    const {id, logs} = single(setGuardian(concat([setGuardianData(), "0x00"])));
    const ctx = await run(logs);
    await run([eventLog(saharaTimelockAbi, "Cancelled", {id}, {txHash: txHash(6), blockNumber: BLOCK + 1n})], ctx);
    const alert = ctx.alerter.emitted[1];
    expect(alert?.severity).toBe("critical");
    expect(alert?.title).toBe("Timelock Guardian change cancelled");
    expect(field(alert, "Cancelled by")).toMatch(/CANCELLER_ROLE holder directly/);
    expect(alert?.note).toMatch(/re-propose it as a single protected call/);
  });

  it("tells governance to re-propose a Guardian change the Guardian cancelled in its protected form", async () => {
    const mixed = batch([setGuardian(), thresholds], {salt: SALT});
    const ctx = await run(mixed.logs);
    const tx = txHash(5);
    const logs = [
      eventLog(saharaTimelockAbi, "Cancelled", {id: mixed.id}, {txHash: tx, blockNumber: BLOCK + 2n, logIndex: 0}),
      eventLog(guardianControllerAbi, "ProposalCancelled", {id: mixed.id, guardian: TL.guardian}, {
        txHash: tx,
        blockNumber: BLOCK + 2n,
        logIndex: 1,
      }),
    ];
    await run(logs, ctx);
    await controllerRule.onLogs(ctx, logs, RANGE);
    const byRule = Object.fromEntries(ctx.alerter.emitted.map((alert) => [alert.rule, alert]));
    expect(byRule["timelock.cancelled"]?.note).toMatch(/single protected call: LiquidityManager\.setGuardian/);
    expect(byRule["controller.proposal-cancelled"]?.note).toMatch(/single protected call: LiquidityManager\.setGuardian/);
  });

  it("gives a Guardian cancel the ETA of the scheduling it cancelled, even when the id is re-scheduled later", async () => {
    const first = single(thresholds, {salt: SALT, tx: 1});
    const ctx = await run(first.logs);
    const cancelledEta = readPendingOps(ctx.store, "ethereum")[first.id]?.readyAt;
    const tx = txHash(5);
    // One block range: the Guardian cancels, then governance schedules the same id again three blocks later.
    const logs = [
      eventLog(saharaTimelockAbi, "Cancelled", {id: first.id}, {txHash: tx, blockNumber: BLOCK + 2n, logIndex: 0}),
      eventLog(guardianControllerAbi, "ProposalCancelled", {id: first.id, guardian: TL.guardian}, {
        txHash: tx,
        blockNumber: BLOCK + 2n,
        logIndex: 1,
      }),
      ...single(thresholds, {salt: SALT, tx: 6, block: BLOCK + 5n}).logs,
    ];
    await run(logs, ctx);
    await controllerRule.onLogs(ctx, logs, RANGE);
    expect(readPendingOps(ctx.store, "ethereum")[first.id]?.readyAt).not.toBe(cancelledEta);
    const byRule = Object.fromEntries(ctx.alerter.emitted.map((alert) => [alert.rule, alert]));
    const expected = formatTimestamp(cancelledEta ?? 0);
    expect(field(byRule["timelock.cancelled"], "Was executable at")).toBe(expected);
    expect(field(byRule["controller.proposal-cancelled"], "Was executable at")).toBe(expected);
  });

  it("raises a cancel that stalls a pending Guardian recovery to critical and names the dependents", async () => {
    const parent = single(thresholds, {tx: 1});
    const recovery = single(setGuardian(), {predecessor: parent.id, tx: 2});
    const ctx = await run([...parent.logs, ...recovery.logs]);
    const tx = txHash(5);
    await run(
      [
        eventLog(saharaTimelockAbi, "Cancelled", {id: parent.id}, {txHash: tx, blockNumber: BLOCK + 2n, logIndex: 0}),
        eventLog(guardianControllerAbi, "ProposalCancelled", {id: parent.id, guardian: TL.guardian}, {
          txHash: tx,
          blockNumber: BLOCK + 2n,
          logIndex: 1,
        }),
      ],
      ctx,
    );
    const alert = ctx.alerter.emitted[2];
    const recoverySummary = readPendingOps(ctx.store, "ethereum")[recovery.id]?.summary;
    expect(alert).toMatchObject({
      severity: "critical",
      rule: "timelock.cancelled",
      title: "Timelock operation cancelled: LiquidityManager.setPoolThresholds (stalls a pending Guardian recovery)",
    });
    expect(field(alert, "Stalls pending operation")).toBe(`${recovery.id} (${recoverySummary})`);
    expect(alert?.note).toMatch(/TimelockUnexecutedPredecessor/);
    expect(alert?.note).toMatch(/re-proposed with predecessor 0/);

    // Any other dependent is named, at the cancelled op's own severity.
    const base = single(thresholds, {tx: 6, salt: SALT});
    const child = single(setRebalancer, {predecessor: base.id, tx: 7});
    const other = await run([...base.logs, ...child.logs]);
    const pos = {txHash: txHash(8), blockNumber: BLOCK + 3n};
    await run([eventLog(saharaTimelockAbi, "Cancelled", {id: base.id}, pos)], other);
    const cancelled = other.alerter.emitted[2];
    expect(cancelled?.severity).toBe("high");
    expect(cancelled?.title).toBe("Timelock operation cancelled: LiquidityManager.setPoolThresholds");
    expect(field(cancelled, "Stalls pending operation")).toMatch(new RegExp(`^${child.id} \\(Pool.setRebalancer`));
    expect(cancelled?.note).not.toMatch(/predecessor 0/);
  });

  it("keeps the cancelled scheduling's own ETA when the queue rule already read a later one", async () => {
    const first = single(thresholds, {salt: SALT, tx: 1});
    const ctx = await run(first.logs);
    const stored = readPendingOps(ctx.store, "ethereum")[first.id];
    if (!stored) throw new Error("not tracked");
    const ownEta = stored.scheduledAt + Number(stored.delay);
    // The scan lags: the queue rule has read getTimestamp of a later scheduling of the same id at the head.
    const ops = readPendingOps(ctx.store, "ethereum");
    ctx.store.set(timelockNamespace("ethereum"), {ops: {...ops, [first.id]: {...stored, readyAt: ownEta + 86400}}});
    const tx = txHash(5);
    const logs = [
      eventLog(saharaTimelockAbi, "Cancelled", {id: first.id}, {txHash: tx, blockNumber: BLOCK + 2n, logIndex: 0}),
      eventLog(guardianControllerAbi, "ProposalCancelled", {id: first.id, guardian: TL.guardian}, {
        txHash: tx,
        blockNumber: BLOCK + 2n,
        logIndex: 1,
      }),
    ];
    await run(logs, ctx);
    await controllerRule.onLogs(ctx, logs, RANGE);
    const byRule = Object.fromEntries(ctx.alerter.emitted.map((alert) => [alert.rule, alert]));
    expect(field(byRule["timelock.cancelled"], "Was executable at")).toBe(formatTimestamp(ownEta));
    expect(field(byRule["controller.proposal-cancelled"], "Was executable at")).toBe(formatTimestamp(ownEta));
  });

  it("does not describe an untracked cancelled op with a later scheduling of the same id", async () => {
    const later = single(thresholds, {salt: SALT, tx: 6, block: BLOCK + 5n});
    const ctx = tlContext();
    const tx = txHash(5);
    const logs = [
      eventLog(saharaTimelockAbi, "Cancelled", {id: later.id}, {txHash: tx, blockNumber: BLOCK + 2n, logIndex: 0}),
      eventLog(guardianControllerAbi, "ProposalCancelled", {id: later.id, guardian: TL.guardian}, {
        txHash: tx,
        blockNumber: BLOCK + 2n,
        logIndex: 1,
      }),
      ...later.logs,
    ];
    await run(logs, ctx);
    await controllerRule.onLogs(ctx, logs, RANGE);
    const alert = ctx.alerter.emitted.find((a) => a.rule === "controller.proposal-cancelled");
    expect(field(alert, "Operation")).toMatch(/not tracked/);
    expect(field(alert, "Was executable at")).toBeUndefined();
  });

  it("alerts a cancel of an untracked op", async () => {
    const unknownId = keccak256(toHex("untracked"));
    const ctx = await run([
      eventLog(saharaTimelockAbi, "Cancelled", {id: unknownId}, {txHash: txHash(7), blockNumber: BLOCK}),
    ]);
    expect(ctx.alerter.emitted[0]?.severity).toBe("high");
    expect(field(ctx.alerter.emitted[0], "Operation")).toMatch(/not tracked/);
  });

  it("alerts an executed batch once with the op severity", async () => {
    const calls = [acceptPool, thresholds];
    const {id, logs} = batch(calls);
    const ctx = await run(logs);
    const tx = txHash(8);
    await run(
      calls.map((call, i) =>
        eventLog(saharaTimelockAbi, "CallExecuted", {id, index: BigInt(i), ...call}, {
          txHash: tx,
          blockNumber: BLOCK + 30000n,
          logIndex: i,
        }),
      ),
      ctx,
    );
    expect(ctx.alerter.emitted).toHaveLength(2);
    const alert = ctx.alerter.emitted[1];
    expect(alert).toMatchObject({
      key: `ethereum:timelock:executed:${id}`,
      severity: "critical",
      rule: "timelock.executed",
    });
    expect(field(alert, "Call 2/2")).toMatch(/^LiquidityManager.setPoolThresholds/);
    expect(readPendingOps(ctx.store, "ethereum")[id]?.status).toBe("executed");
  });

  it("alerts an executed high op as high, and an untracked one from its own calls", async () => {
    const {id, logs} = single(thresholds);
    const ctx = await run(logs);
    const pos = {txHash: txHash(10), blockNumber: BLOCK + 9n};
    await run([eventLog(saharaTimelockAbi, "CallExecuted", {id, index: 0n, ...thresholds}, pos)], ctx);
    expect(ctx.alerter.emitted[1]?.severity).toBe("high");

    const untracked = await run([
      eventLog(
        saharaTimelockAbi,
        "CallExecuted",
        {id: keccak256(toHex("untracked")), index: 0n, ...setRebalancer},
        {txHash: txHash(11), blockNumber: BLOCK},
      ),
    ]);
    expect(untracked.alerter.emitted[0]?.severity).toBe("critical");
    expect(field(untracked.alerter.emitted[0], "Note")).toMatch(/not seen/);
  });

  it("alerts delay and role changes as critical with role names", async () => {
    const tx = txHash(12);
    const at = (logIndex: number) => ({txHash: tx, blockNumber: BLOCK, logIndex});
    const ctx = await run([
      eventLog(saharaTimelockAbi, "MinDelayChange", {oldDuration: DELAY, newDuration: 172800n}, at(0)),
      eventLog(
        saharaTimelockAbi,
        "RoleGranted",
        {role: TIMELOCK_ROLES.PROPOSER_ROLE, account: TL.stranger, sender: TL.timelock},
        at(1),
      ),
      eventLog(
        saharaTimelockAbi,
        "RoleRevoked",
        {role: TIMELOCK_ROLES.CANCELLER_ROLE, account: TL.controller, sender: TL.timelock},
        at(2),
      ),
      eventLog(
        saharaTimelockAbi,
        "RoleAdminChanged",
        {role: TIMELOCK_ROLES.EXECUTOR_ROLE, previousAdminRole: zeroHash, newAdminRole: TIMELOCK_ROLES.PROPOSER_ROLE},
        at(3),
      ),
    ]);
    const alerts = ctx.alerter.emitted;
    expect(alerts.map((a) => a.severity)).toEqual(["critical", "critical", "critical", "critical"]);
    expect(alerts.map((a) => a.title)).toEqual([
      "Timelock delay changed: 3d -> 2d",
      `Timelock PROPOSER_ROLE granted: ${TL.stranger}`,
      "Timelock CANCELLER_ROLE revoked: GuardianController",
      "Timelock admin role of EXECUTOR_ROLE changed",
    ]);
    expect(field(alerts[3], "Previous admin role")).toBe("DEFAULT_ADMIN_ROLE");
    expect(alerts[1]?.key).toBe(`ethereum:timelock:${tx}:1`);
  });
});

describe("timelockQueueRule", () => {
  const NOW_BLOCK = 50_000n;
  const now = blockTime(NOW_BLOCK);

  /** A tracked single-call op with a real id (salt derived from `n`), so cancel calldata can be built. */
  function op(n: number, readyIn: number, extra: Partial<PendingOp> = {}): PendingOp {
    const salt = keccak256(toHex(`op-${n}`));
    const [call = thresholds] = extra.calls ?? [thresholds];
    return {
      id: hashOperation(call, zeroHash, salt),
      calls: [call],
      predecessor: zeroHash,
      salt,
      delay: DELAY,
      scheduledAt: now + readyIn - Number(DELAY),
      readyAt: now + readyIn,
      txHash: txHash(100 + n),
      summary: `op ${n}`,
      severity: "critical",
      protected: false,
      status: "pending",
      batch: false,
      scheduledBlock: 1n,
      ...extra,
    };
  }

  function seeded(ops: PendingOp[], read: (fn: string, id: Hex) => unknown) {
    const client = fakeClient({read: (fn, args) => read(fn, args[0] as Hex)});
    const ctx = tlContext({client});
    ctx.store.set(timelockNamespace("ethereum"), {ops: Object.fromEntries(ops.map((o) => [o.id, o]))});
    return ctx;
  }

  it("raises soon/ready conditions, drops done and unset ops, and prunes old ones", async () => {
    const far = op(1, 2 * 86400);
    const soon = op(2, 3600);
    const soonHigh = op(3, 7200, {severity: "high"});
    const ready = op(4, -60, {protected: true, calls: [setGuardian()]});
    const done = op(5, -3600);
    const unset = op(6, 5000);
    const oldExecuted = op(7, -40 * 86400, {status: "executed", closedAt: now - 31 * 86400});
    const recentCancelled = op(8, -86400, {status: "cancelled", closedAt: now - 86400});
    const states: Record<Hex, number> = {
      [far.id]: OPERATION_STATE.Waiting,
      [soon.id]: OPERATION_STATE.Waiting,
      [soonHigh.id]: OPERATION_STATE.Waiting,
      [ready.id]: OPERATION_STATE.Ready,
      [done.id]: OPERATION_STATE.Done,
      [unset.id]: OPERATION_STATE.Unset,
    };
    const all = [far, soon, soonHigh, ready, done, unset, oldExecuted, recentCancelled];
    const ctx = seeded(all, (fn, id) => {
      const state = states[id];
      if (state === undefined) return new Error(`unexpected ${fn} ${id}`);
      if (fn === "getOperationState") return state;
      const target = all.find((o) => o.id === id);
      return state === OPERATION_STATE.Done ? 1n : state === OPERATION_STATE.Unset ? 0n : BigInt(target?.readyAt ?? 0);
    });

    const {conditions, snapshot} = await timelockQueueRule.check(ctx, NOW_BLOCK);
    const byKey = Object.fromEntries(conditions.map((c) => [c.key, c]));
    expect(Object.keys(byKey).sort()).toEqual(
      [
        `ethereum:timelock-queue:${soon.id}:soon`,
        `ethereum:timelock-queue:${soonHigh.id}:soon`,
        `ethereum:timelock-queue:${ready.id}:ready`,
      ].sort(),
    );
    expect(conditions.every((c) => c.kind === "condition" && c.key.startsWith("ethereum:timelock-queue:"))).toBe(true);
    expect(byKey[`ethereum:timelock-queue:${soon.id}:soon`]?.severity).toBe("high");
    expect(byKey[`ethereum:timelock-queue:${soonHigh.id}:soon`]?.severity).toBe("warning");
    const readyAlert = byKey[`ethereum:timelock-queue:${ready.id}:ready`];
    expect(readyAlert?.severity).toBe("critical");
    expect(field(readyAlert, "Guardian action")).toMatch(/Guardian cannot cancel/);
    // The soon reminder carries the cancel instruction again.
    const soonCancel = calldataFrom(byKey[`ethereum:timelock-queue:${soon.id}:soon`], "Cancel tx: calldata");
    expect(decodeFunctionData({abi: guardianControllerAbi, data: soonCancel}).functionName).toBe("cancel");

    const ops = readPendingOps(ctx.store, "ethereum");
    expect(ops[done.id]?.status).toBe("executed");
    expect(ops[unset.id]?.status).toBe("cancelled");
    expect(ops[oldExecuted.id]).toBeUndefined();
    expect(ops[recentCancelled.id]?.status).toBe("cancelled");
    expect(ops[far.id]?.status).toBe("pending");

    expect(snapshot["Pending Timelock operations"]).toBe("4");
    expect(snapshot["Next Timelock ETA"]).toMatch(/executable now\): op 4$/);
  });

  it("tells the Guardian to cancel before the ETA until it passes, and to cancel now after", async () => {
    const soon = op(1, 3600);
    const ready = op(2, -60);
    const recovery = op(3, -60, {protected: true, calls: [setGuardian()]});
    const all = [soon, ready, recovery];
    const ctx = seeded(all, (fn, id) => {
      const target = all.find((o) => o.id === id);
      if (!target) return new Error(`unexpected ${fn} ${id}`);
      if (fn === "getOperationState") return target === soon ? OPERATION_STATE.Waiting : OPERATION_STATE.Ready;
      return BigInt(target.readyAt);
    });
    const {conditions} = await timelockQueueRule.check(ctx, NOW_BLOCK);
    const byKey = Object.fromEntries(conditions.map((c) => [c.key, c]));
    const soonAlert = byKey[`ethereum:timelock-queue:${soon.id}:soon`];
    const readyAlert = byKey[`ethereum:timelock-queue:${ready.id}:ready`];
    const recoveryAlert = byKey[`ethereum:timelock-queue:${recovery.id}:ready`];
    expect(field(soonAlert, "Guardian action")).toMatch(/\(value 0\) before \d{4}-\d{2}-\d{2} /);
    expect(soonAlert?.note).toMatch(/cancel transaction above before the ETA\.$/);
    expect(field(readyAlert, "Guardian action")).toMatch(
      /\(value 0\) now: its ETA \(\d{4}-.*\) has passed$/,
    );
    expect(readyAlert?.note).toMatch(/cancel transaction above now: it can be cancelled until it is executed\.$/);
    expect(recoveryAlert?.note).toMatch(/Timelock\.cancel\(id\) now, before it is executed\.$/);
  });

  it("refreshes readyAt from getTimestamp", async () => {
    const shifted = op(1, 2 * 86400);
    const ctx = seeded([shifted], (fn) => (fn === "getOperationState" ? OPERATION_STATE.Waiting : BigInt(now + 600)));
    const {conditions} = await timelockQueueRule.check(ctx, NOW_BLOCK);
    expect(conditions.map((c) => c.key)).toEqual([`ethereum:timelock-queue:${shifted.id}:soon`]);
    expect(readPendingOps(ctx.store, "ethereum")[shifted.id]?.readyAt).toBe(now + 600);
  });

  it("keeps ops pending on read failures and falls back to the stored ETA", async () => {
    const ready = op(1, -10);
    const later = op(2, 5 * 86400);
    const ctx = seeded([ready, later], () => new Error("rpc down"));
    const {conditions} = await timelockQueueRule.check(ctx, NOW_BLOCK);
    const keys = conditions.map((c) => c.key);
    expect(keys).toContain(`ethereum:timelock-queue:${ready.id}:ready`);
    expect(keys).toContain("ethereum:timelock-queue:read-failed");
    expect(conditions.find((c) => c.key.endsWith("read-failed"))?.severity).toBe("warning");
    expect(readPendingOps(ctx.store, "ethereum")[ready.id]?.status).toBe("pending");
  });

  it("reports a ready op whose predecessor is not executed as blocked, not executable", async () => {
    const cancelledParent = keccak256(toHex("parent-cancelled"));
    const doneParent = keccak256(toHex("parent-done"));
    const unreadableParent = keccak256(toHex("parent-unreadable"));
    const recovery = op(1, -60, {predecessor: cancelledParent, protected: true, calls: [setGuardian()]});
    const free = op(2, -60, {predecessor: doneParent, severity: "high"});
    const unknown = op(3, -60, {predecessor: unreadableParent});
    const states: Record<Hex, number> = {
      [recovery.id]: OPERATION_STATE.Ready,
      [free.id]: OPERATION_STATE.Ready,
      [unknown.id]: OPERATION_STATE.Ready,
      [cancelledParent]: OPERATION_STATE.Unset,
      [doneParent]: OPERATION_STATE.Done,
    };
    const ctx = seeded([recovery, free, unknown], (fn, id) => {
      const state = states[id];
      if (state === undefined) return new Error(`unexpected ${fn} ${id}`);
      return fn === "getOperationState" ? state : BigInt(now - 60);
    });
    const {conditions} = await timelockQueueRule.check(ctx, NOW_BLOCK);
    expect(conditions.map((c) => [c.key, c.rule, c.severity])).toEqual([
      [`ethereum:timelock-queue:${recovery.id}:blocked`, "timelock-queue.blocked", "critical"],
      [`ethereum:timelock-queue:${free.id}:ready`, "timelock-queue.ready", "high"],
      [`ethereum:timelock-queue:${unknown.id}:ready`, "timelock-queue.ready", "critical"],
      ["ethereum:timelock-queue:read-failed", "timelock-queue.read-failed", "warning"],
    ]);
    const [blocked] = conditions;
    expect(blocked?.title).toBe("Timelock operation blocked by its predecessor: op 1");
    expect(field(blocked, "Predecessor")).toBe(`${cancelledParent} (not scheduled: cancelled or never proposed)`);
    expect(field(blocked, "Executable at")).not.toMatch(/executable now/);
    expect(field(blocked, "Guardian action")).toMatch(/Guardian cannot cancel/);
    expect(blocked?.note).toMatch(/TimelockUnexecutedPredecessor/);
    expect(blocked?.note).toMatch(/re-proposed with predecessor 0/);
    expect(field(conditions[3], "Failed reads")).toBe(`${unreadableParent} (predecessor of ${unknown.id})`);
    expect(readPendingOps(ctx.store, "ethereum")[recovery.id]?.status).toBe("pending");
  });

  it("does not drop an op scheduled after the checked block", async () => {
    const future = op(1, 2 * 86400, {scheduledBlock: NOW_BLOCK + 5n});
    const ctx = seeded([future], () => OPERATION_STATE.Unset);
    await timelockQueueRule.check(ctx, NOW_BLOCK);
    expect(readPendingOps(ctx.store, "ethereum")[future.id]?.status).toBe("pending");
  });

  it("returns nothing without a Timelock", async () => {
    const ctx = tlContext({addresses: tlAddresses({timelock: undefined})});
    expect(await timelockQueueRule.check(ctx, NOW_BLOCK)).toEqual({conditions: [], snapshot: {}});
  });

  it("tracks an op from scheduling through the queue to execution", async () => {
    const {id, logs} = single(setRebalancer);
    let state: number = OPERATION_STATE.Waiting;
    const client = fakeClient({
      read: (fn) => {
        if (fn === "getOperationState") return state;
        return state === OPERATION_STATE.Done ? 1n : BigInt(blockTime(BLOCK) + Number(DELAY));
      },
    });
    const ctx = tlContext({client});
    await timelockEventsRule.onLogs(ctx, logs, RANGE);
    // 2 days after scheduling: more than 24h left.
    const twoDays = BLOCK + BigInt((2 * 86400) / 12);
    expect((await timelockQueueRule.check(ctx, twoDays)).conditions).toEqual([]);
    // 2.5 days: within 24h, op is critical (pool admin) -> soon is high.
    const soon = (await timelockQueueRule.check(ctx, BLOCK + BigInt((2.5 * 86400) / 12))).conditions;
    expect(soon.map((c) => [c.key, c.severity])).toEqual([[`ethereum:timelock-queue:${id}:soon`, "high"]]);
    state = OPERATION_STATE.Ready;
    const ready = (await timelockQueueRule.check(ctx, BLOCK + BigInt((3 * 86400) / 12) + 1n)).conditions;
    expect(ready.map((c) => [c.key, c.severity])).toEqual([[`ethereum:timelock-queue:${id}:ready`, "critical"]]);
    state = OPERATION_STATE.Done;
    expect((await timelockQueueRule.check(ctx, BLOCK + 30000n)).conditions).toEqual([]);
    expect(readPendingOps(ctx.store, "ethereum")[id]?.status).toBe("executed");
  });
});
