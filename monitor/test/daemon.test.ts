import {existsSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {encodeFunctionData, parseUnits, zeroHash, type Hex, type Log} from "viem";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {saharaTokenAbi} from "../src/abi/external.ts";
import {liquidityManagerAbi, saharaTimelockAbi} from "../src/abi/generated.ts";
import {ConsoleSink} from "../src/alerts/console.ts";
import {AlertManager, RETRY_BASE_MS} from "../src/alerts/manager.ts";
import {TelegramSink} from "../src/alerts/telegram.ts";
import {FAILURE, readExec, readScan, readSent, SUCCESS} from "../src/ccip/store.ts";
import {createChainContext} from "../src/chain/client.ts";
import {configSchema, type Config} from "../src/config.ts";
import {
  daemonNamespace,
  defaultSinks,
  HEALTH_INTERVAL_MS,
  HEALTH_NAMESPACE,
  MAX_BACKOFF_MS,
  MutedAlerter,
  readChainState,
  scanChunk,
} from "../src/daemon.ts";
import {healthz} from "../src/health.ts";
import {redact, silentLogger} from "../src/log.ts";
import {readFlowsState} from "../src/rules/flows.ts";
import {backfillRules, eventRules, stateRules} from "../src/rules/index.ts";
import {RECONCILE_SCOPE, type ReconcileReport} from "../src/rules/reconcile.ts";
import {hashOperation, readPendingOps, timelockNamespace, type PendingOp} from "../src/rules/timelock.ts";
import {createStore} from "../src/store.ts";
import type {Alert} from "../src/types.ts";
import {loadReceipt} from "./helpers/abi-fixtures.ts";
import {
  BSC,
  ccAddr,
  ccipAddresses,
  ETH,
  execLogV2,
  fakeClient as ccipClient,
  insufficientBalanceError,
  MANAGER,
  OFFRAMP_V2,
  POOL,
  REGISTRY,
  releaseLog,
  ROUTER,
  SAHARA,
  T0 as CCIP_T0,
} from "./helpers/ccip-fakes.ts";
import {
  CaptureSink,
  condition,
  daemonConfig,
  fakeAddresses,
  logger,
  recordingStore,
  spyEventRule,
  spyStateRule,
  T0,
  testDaemon,
} from "./helpers/daemon-fakes.ts";
import {eventLog as tokenLog} from "./helpers/flows-fixtures.ts";
import {eventLog as timelockLog, scheduleLogs, TL} from "./helpers/timelock-fixtures.ts";

const POLL_MS = 10_000;
/** An ephemeral port for the status server. */
const HTTP = {host: "127.0.0.1", port: 0};

describe("rule lists", () => {
  it("runs every event rule, the Timelock rule first, and only Timelock and CCIP in the backfill", () => {
    expect(eventRules.map((rule) => rule.id)).toEqual([
      "timelock",
      "manager",
      "controller",
      "pool",
      "token",
      "registry",
      "router",
      "flows",
      "ccip",
    ]);
    expect(stateRules.map((rule) => rule.id)).toEqual([
      "state-token",
      "state-registry",
      "state-pool",
      "state-manager",
      "state-adapter",
      "state-inventory",
      "state-router",
      "state-timelock",
      "state-controller",
      "timelock-queue",
    ]);
    expect(backfillRules.map((rule) => rule.id)).toEqual(["timelock", "ccip"]);
  });
});

describe("cycle", () => {
  it("scans cursor+1..head, then the state rules, then tick, flush and save; delivery in the background", async () => {
    const order: string[] = [];
    const stored = recordingStore(order);
    stored.set(daemonNamespace("ethereum"), {cursor: 95n});
    const event: Alert = {key: "ethereum:spy:0xaa:1", kind: "event", severity: "high", rule: "spy", title: "Event"};
    const rule = spyEventRule("spy", {order, onLogs: (ctx) => ctx.alerter.emit(event)});
    const state = spyStateRule("state-spy", () => [condition("ethereum", "state-spy", "x")], order);
    const {daemon, sink, delivered} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store: stored,
      order,
      heads: {ethereum: 100n},
      eventRules: [rule],
      stateRules: [state],
    });
    order.length = 0;

    expect(await daemon.cycle("ethereum")).toBe(true);
    await delivered();
    expect(order).toEqual([
      "resolve:100",
      "fetch:96-100",
      "rule:spy:96-100",
      "state:state-spy:100",
      // The startup message is queued as soon as the starting cursor is known, before the scan's alerts. The flush
      // starts its delivery, and the commit saves at once: it never waits for a sink.
      `send:global:health:started:${T0}`,
      "save",
      // Each delivery is saved as it happens (a crash re-sends only a message in flight).
      "save",
      "send:ethereum:spy:0xaa:1",
      "save",
      "send:ethereum:state-spy:x",
      "save",
    ]);
    expect(readChainState(stored, "ethereum").cursor).toBe(100n);
    expect(sink.summary).toContain("firing:high:ethereum:state-spy:x");
    const status = daemon.status().chains[0]!;
    expect(status).toMatchObject({processedBlock: 100n, confirmedHead: 100n, lastCaughtUpAt: T0, cycleFailures: 0});
  });

  it("hands every chunk to every rule in ascending contiguous order, including chunks without logs", async () => {
    const a = spyEventRule("a");
    const b = spyEventRule("b");
    const store = createStore();
    store.set(daemonNamespace("ethereum"), {cursor: 100n});
    const {daemon, fetches} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store,
      heads: {ethereum: 125n},
      eventRules: [a, b],
    });
    await daemon.cycle("ethereum");

    const ranges = ["101-110", "111-120", "121-125"];
    expect(fetches.map((call) => `${call.range.from}-${call.range.to}`)).toEqual(ranges);
    // One fetch per chunk with the union of both rules' filters.
    expect(fetches.every((call) => call.filters === 2)).toBe(true);
    for (const rule of [a, b]) {
      expect(rule.calls.map((call) => `${call.range.from}-${call.range.to}`)).toEqual(ranges);
      expect(rule.calls.every((call) => call.logs === 0)).toBe(true);
    }
    expect(readChainState(store, "ethereum").cursor).toBe(125n);
  });

  it("scans at most 20 chunks per cycle, checks state at the head and continues next cycle", async () => {
    const state = spyStateRule("state-spy");
    const store = createStore();
    store.set(daemonNamespace("ethereum"), {cursor: 500n});
    const {daemon, fetches} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store,
      heads: {ethereum: 1_000n},
      eventRules: [spyEventRule("a")],
      stateRules: [state],
    });
    await daemon.cycle("ethereum");
    expect(fetches).toHaveLength(20);
    expect(readChainState(store, "ethereum").cursor).toBe(700n);
    expect(state.calls).toEqual([{chain: "ethereum", block: 1_000n}]);
    expect(daemon.status().chains[0]!.lastCaughtUpAt).toBeUndefined();

    await daemon.cycle("ethereum");
    expect(readChainState(store, "ethereum").cursor).toBe(900n);
    // Same head: the state rules already ran there.
    expect(state.calls).toHaveLength(1);
    await daemon.cycle("ethereum");
    expect(readChainState(store, "ethereum").cursor).toBe(1_000n);
    expect(daemon.status().chains[0]!.lastCaughtUpAt).toBe(T0);
  });

  it("does nothing when the head did not move; with the RPC behind it, no check and not caught up", async () => {
    const a = spyEventRule("a");
    const state = spyStateRule("state-spy");
    const store = createStore();
    store.set(daemonNamespace("ethereum"), {cursor: 100n});
    const {daemon, chains, clock, resolves} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store,
      heads: {ethereum: 100n},
      eventRules: [a],
      stateRules: [state],
    });
    await daemon.cycle("ethereum");
    expect(a.calls).toEqual([]);
    expect(state.calls).toHaveLength(1);
    expect(daemon.status().chains[0]!.lastCaughtUpAt).toBe(T0);

    clock.now += 5_000;
    chains.ethereum!.head = 90n;
    expect(await daemon.cycle("ethereum")).toBe(true);
    expect(a.calls).toEqual([]);
    expect(state.calls).toHaveLength(1);
    expect(resolves).toHaveLength(1);
    expect(readChainState(store, "ethereum").cursor).toBe(100n);
    expect(daemon.status().chains[0]!.lastCaughtUpAt).toBe(T0);

    clock.now += 5_000;
    chains.ethereum!.head = 100n;
    expect(await daemon.cycle("ethereum")).toBe(true);
    expect(daemon.status().chains[0]!.lastCaughtUpAt).toBe(T0 + 10_000);
  });

  it("stops at a failed chunk without advancing past it and replays it to every rule next cycle", async () => {
    const a = spyEventRule("a");
    const b = spyEventRule("b");
    const state = spyStateRule("state-spy");
    const store = createStore();
    store.set(daemonNamespace("ethereum"), {cursor: 100n});
    const {daemon} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store,
      heads: {ethereum: 125n},
      eventRules: [a, b],
      stateRules: [state],
      failChunks: [111n],
    });
    expect(await daemon.cycle("ethereum")).toBe(false);
    expect(readChainState(store, "ethereum").cursor).toBe(110n);
    expect(state.calls).toEqual([]);
    const health = daemon.status().chains[0]!;
    expect(health).toMatchObject({cycleFailures: 1, consecutiveFailures: 1, processedBlock: 110n});
    // The RPC URL (with its key) never reaches the status.
    expect(health.lastError).toContain("eth_getLogs failed");
    expect(health.lastError).not.toContain("secret-api-key");

    expect(await daemon.cycle("ethereum")).toBe(true);
    for (const rule of [a, b]) {
      expect(rule.calls.map((call) => `${call.range.from}-${call.range.to}`)).toEqual([
        "101-110",
        "111-120",
        "121-125",
      ]);
    }
    expect(readChainState(store, "ethereum").cursor).toBe(125n);
    expect(state.calls).toHaveLength(1);
  });

  it("stops at a rule that throws; the chunk is replayed to every rule, including those that saw it", async () => {
    let fail = true;
    const a = spyEventRule("a");
    const b = spyEventRule("b", {
      onLogs: (_ctx, _logs, range) => {
        if (fail && range.from === 111n) throw new Error("rule bug");
      },
    });
    const store = createStore();
    store.set(daemonNamespace("ethereum"), {cursor: 100n});
    const {daemon} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store,
      heads: {ethereum: 120n},
      eventRules: [a, b],
    });
    expect(await daemon.cycle("ethereum")).toBe(false);
    expect(readChainState(store, "ethereum").cursor).toBe(110n);
    expect(daemon.status().chains[0]!.lastError).toContain("rule b failed on blocks 111-120: rule bug");
    fail = false;
    await daemon.cycle("ethereum");
    expect(a.calls.map((call) => call.range.from)).toEqual([101n, 111n, 111n]);
    expect(b.calls.map((call) => call.range.from)).toEqual([101n, 111n, 111n]);
    expect(readChainState(store, "ethereum").cursor).toBe(120n);
  });

  it("backs off after failed address resolution and counts the failures", async () => {
    let failing = true;
    const store = createStore();
    store.set(daemonNamespace("ethereum"), {cursor: 90n});
    const {daemon} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store,
      heads: {ethereum: 100n},
      eventRules: [spyEventRule("a")],
      resolve: async () => {
        if (failing) throw new Error("Manager TOKEN() mismatch");
        return fakeAddresses();
      },
    });
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      expect(await daemon.cycle("ethereum")).toBe(false);
      delays.push(daemon.nextDelayMs("ethereum"));
    }
    expect(delays).toEqual([20_000, 40_000, 80_000, 160_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(daemon.status().chains[0]).toMatchObject({cycleFailures: 7, consecutiveFailures: 7, successfulCycles: 0});
    expect(readChainState(store, "ethereum").cursor).toBe(90n);

    failing = false;
    expect(await daemon.cycle("ethereum")).toBe(true);
    expect(daemon.nextDelayMs("ethereum")).toBe(POLL_MS);
    expect(daemon.status().chains[0]).toMatchObject({cycleFailures: 7, consecutiveFailures: 0});
    expect(daemon.status().chains[0]!.lastError).toBeUndefined();
  });

  it("schedules each chain independently: the poll interval after success, the backoff after failure", async () => {
    const {daemon, timers, chains} = testDaemon({heads: {ethereum: 100n, bsc: 50n}});
    chains.bsc!.head = new Error("bsc RPC down");
    await daemon.start();
    // Both chain loops start at once; the health loop waits 30 s.
    expect(timers.delays.sort()).toEqual([0, 0, HEALTH_INTERVAL_MS]);
    timers.fire(0);
    const sorted = () => timers.delays.sort((x, y) => x - y);
    await vi.waitFor(() => expect(sorted()).toEqual([POLL_MS, 2 * POLL_MS, HEALTH_INTERVAL_MS]));
    expect(daemon.status().chains.map((chain) => chain.successfulCycles)).toEqual([1, 0]);
    await daemon.stop();
    expect(timers.pending.size).toBe(0);
  });

  it("keeps a throwing state rule's conditions open (no sync) and syncs the others per rule", async () => {
    let fail = false;
    const flaky = spyStateRule("state-flaky", () => {
      if (fail) throw new Error("boom");
      return [condition("ethereum", "state-flaky", "x")];
    });
    const steady = spyStateRule("state-steady", () => [condition("ethereum", "state-steady", "y")]);
    const {daemon, chains, sink} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      heads: {ethereum: 100n},
      stateRules: [flaky, steady],
    });
    const sync = vi.spyOn(daemon.alerter, "sync");
    await daemon.cycle("ethereum");
    fail = true;
    chains.ethereum!.head = 101n;
    await daemon.cycle("ethereum");
    expect(daemon.alerter.openConditions().map((open) => open.alert.key)).toEqual([
      "ethereum:state-flaky:x",
      "ethereum:state-steady:y",
    ]);
    expect(sink.summary.filter((line) => line.startsWith("resolved"))).toEqual([]);
    const scopes = sync.mock.calls.map(([scope]) => scope);
    expect(scopes.filter((scope) => scope === "ethereum:state-flaky:")).toHaveLength(1);
    expect(scopes.filter((scope) => scope === "ethereum:state-steady:")).toHaveLength(2);
  });

  it("never syncs the scopes the flows, ccip and reconcile rules manage themselves", async () => {
    const flowsLike = spyEventRule("flows", {
      onLogs: (ctx) => ctx.alerter.emit(condition(ctx.name, "flows", "outflow-window:0xpool")),
    });
    const ccipLike = spyEventRule("ccip", {onLogs: (ctx) => ctx.alerter.emit(condition(ctx.name, "ccip", "ramps"))});
    const report = {status: "ok", conditions: []} as unknown as ReconcileReport;
    const {daemon, chains} = testDaemon({
      config: daemonConfig({reconciliation: {enabled: true}}),
      heads: {ethereum: 100n, bsc: 100n},
      eventRules: [flowsLike, ccipLike],
      stateRules: [spyStateRule("state-spy")],
      reconcile: async (_contexts, alerter) => {
        alerter.emit(condition("global", "reconcile", "backing", {chain: undefined}));
        return report;
      },
    });
    const sync = vi.spyOn(daemon.alerter, "sync");
    for (let i = 0; i < 3; i++) {
      for (const name of ["ethereum", "bsc"]) {
        chains[name]!.head = 100n + BigInt(i);
        await daemon.cycle(name);
      }
      await daemon.runReconcile();
      await daemon.healthTick();
    }
    const scopes = new Set(sync.mock.calls.map(([scope]) => scope));
    expect([...scopes].sort()).toEqual([
      "bsc:health:",
      "bsc:state-spy:",
      "ethereum:health:",
      "ethereum:state-spy:",
      "global:health:reconcile-stale",
    ]);
    for (const scope of scopes) {
      expect(scope.endsWith(":flows:") || scope.endsWith(":ccip:") || scope === RECONCILE_SCOPE).toBe(false);
    }
    expect(daemon.alerter.openConditions().map((open) => open.alert.key)).toEqual(
      expect.arrayContaining(["ethereum:flows:outflow-window:0xpool", "bsc:ccip:ramps", "global:reconcile:backing"]),
    );
  });

  it("gives every chain context the one store and alert manager", () => {
    const {daemon, store} = testDaemon();
    expect(daemon.contexts.map((ctx) => ctx.name)).toEqual(["ethereum", "bsc"]);
    for (const ctx of daemon.contexts) {
      expect(ctx.store).toBe(store);
      expect(ctx.alerter).toBe(daemon.alerter);
    }
  });
});

describe("first start", () => {
  function opPending(id: Hex): PendingOp {
    return {
      id,
      calls: [],
      predecessor: zeroHash,
      salt: null,
      delay: 1n,
      scheduledAt: 1,
      readyAt: 2,
      txHash: zeroHash,
      summary: "x",
      severity: "high",
      protected: false,
      status: "pending",
      batch: false,
      scheduledBlock: 1n,
    };
  }

  it("without startBlock starts at the confirmed head and says what is not tracked", async () => {
    const a = spyEventRule("a");
    const {daemon, store, sink} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      heads: {ethereum: 500n},
      eventRules: [a],
      backfillRules: [a],
    });
    await daemon.cycle("ethereum");
    expect(readChainState(store, "ethereum")).toEqual({cursor: 500n});
    expect(a.calls.map((call) => `${call.range.from}-${call.range.to}`)).toEqual(["500-500"]);
    const started = sink.messages.find((m) => m.alert.rule === "health.started")!.alert;
    expect(started.fields?.find((field) => field.label === "ethereum")?.value).toBe(
      [
        "Starting cursor: block 499",
        "no backfill: Timelock proposals and CCIP messages before block 500 are not tracked – set startBlock",
        "Pending Timelock operations known: 0",
        "Historical event alerts suppressed: 0",
      ].join("\n"),
    );
  });

  it("backfills [startBlock, head] with only the backfill rules, muted, then scans normally", async () => {
    const event = (ctx: {name: string}, range: {from: bigint}): Alert => ({
      key: `${ctx.name}:timelock:${range.from}`,
      kind: "event",
      severity: "critical",
      rule: "timelock",
      title: "historical",
    });
    const timelockLike = spyEventRule("timelock", {
      onLogs: (ctx, _logs, range) => {
        ctx.alerter.emit(event(ctx, range));
        ctx.alerter.emit(condition(ctx.name, "timelock", "c"));
        ctx.alerter.sync(`${ctx.name}:timelock:`, []);
        ctx.alerter.resolve("ethereum:x:y");
      },
    });
    const ccipLike = spyEventRule("ccip");
    const other = spyEventRule("manager");
    const store = createStore();
    store.set(timelockNamespace("ethereum"), {ops: {"0x01": opPending("0x01"), "0x02": opPending("0x02")}});
    const {daemon, sink, chains} = testDaemon({
      config: daemonConfig({chains: {ethereum: {startBlock: 75}}}),
      store,
      heads: {ethereum: 100n},
      eventRules: [timelockLike, other, ccipLike],
      backfillRules: [timelockLike, ccipLike],
    });
    await daemon.cycle("ethereum");

    const ranges = ["75-84", "85-94", "95-100"];
    expect(timelockLike.calls.map((call) => `${call.range.from}-${call.range.to}`)).toEqual(ranges);
    expect(ccipLike.calls.map((call) => `${call.range.from}-${call.range.to}`)).toEqual(ranges);
    expect(other.calls).toEqual([]);
    expect(timelockLike.calls.every((call) => call.alerter instanceof MutedAlerter)).toBe(true);
    expect(readChainState(store, "ethereum")).toEqual({
      cursor: 100n,
      backfill: {from: 75n, to: 100n, next: 101n, done: true},
    });
    // Only the startup message went out; nothing from the backfill.
    expect(sink.summary).toEqual([`firing:info:global:health:started:${T0}`]);
    const fields = sink.messages[0]!.alert.fields!;
    expect(fields.find((field) => field.label === "ethereum")?.value).toBe(
      [
        "Starting cursor: block 100",
        "Backfill (Timelock and CCIP only, muted): blocks 75–100",
        "Pending Timelock operations known: 2",
        "Historical event alerts suppressed: 3",
      ].join("\n"),
    );

    // Normal scanning afterwards uses the real alerter.
    chains.ethereum!.head = 103n;
    await daemon.cycle("ethereum");
    expect(other.calls.map((call) => `${call.range.from}-${call.range.to}`)).toEqual(["101-103"]);
    const last = timelockLike.calls.at(-1)!;
    expect(last.alerter).toBe(daemon.alerter);
    expect(daemon.contexts[0]!.alerter).toBe(daemon.alerter);
    expect(sink.summary).toContain("firing:critical:ethereum:timelock:101");
  });

  it("persists backfill.next after every chunk and resumes there after a restart", async () => {
    const a = spyEventRule("timelock");
    const path = join(mkdtempSync(join(tmpdir(), "monitor-daemon-")), "state.json");
    const config = daemonConfig({stateFile: path, chains: {ethereum: {startBlock: 60}}});
    const first = testDaemon({
      config,
      store: createStore(path),
      heads: {ethereum: 100n},
      eventRules: [a],
      backfillRules: [a],
      failChunks: [80n],
    });
    expect(await first.daemon.cycle("ethereum")).toBe(false);
    // Saved to disk after each chunk: a crash here resumes at 80.
    expect(readChainState(createStore(path), "ethereum")).toEqual({
      backfill: {from: 60n, to: 100n, next: 80n, done: false},
    });
    expect(first.sink.messages).toEqual([]);

    const b = spyEventRule("timelock");
    const second = testDaemon({
      config,
      store: createStore(path),
      heads: {ethereum: 130n},
      eventRules: [b],
      backfillRules: [b],
    });
    await second.daemon.cycle("ethereum");
    // The backfill keeps its original end; the blocks after it are scanned normally in the same cycle.
    expect(b.calls.map((call) => `${call.range.from}-${call.range.to}`)).toEqual([
      "80-89",
      "90-99",
      "100-100",
      "101-110",
      "111-120",
      "121-130",
    ]);
    expect(readChainState(createStore(path), "ethereum")).toEqual({
      cursor: 130n,
      backfill: {from: 60n, to: 100n, next: 101n, done: true},
    });
    const value = second.sink.messages[0]!.alert.fields!.find((field) => field.label === "ethereum")!.value;
    expect(value).toContain("Backfill (Timelock and CCIP only, muted): blocks 60–100 (resumed at block 80)");
  });

  it("waits for every chain before the startup message, and reports resumed chains", async () => {
    const store = createStore();
    store.set(daemonNamespace("bsc"), {cursor: 40n, backfill: {from: 10n, to: 30n, next: 31n, done: true}});
    const {daemon, sink, chains} = testDaemon({store, heads: {ethereum: 100n, bsc: 50n}});
    chains.ethereum!.head = new Error("down");
    await daemon.cycle("bsc");
    await daemon.cycle("ethereum");
    expect(sink.messages.filter((m) => m.alert.rule === "health.started")).toEqual([]);
    chains.ethereum!.head = 100n;
    await daemon.cycle("ethereum");
    await daemon.cycle("bsc");
    const started = sink.messages.filter((m) => m.alert.rule === "health.started");
    expect(started).toHaveLength(1);
    expect(started[0]!.alert).toMatchObject({key: `global:health:started:${T0}`, kind: "event", severity: "info"});
    expect(started[0]!.alert.fields!.find((field) => field.label === "bsc")!.value).toBe(
      [
        "Starting cursor: block 40",
        "Resumed from the stored cursor (backfill blocks 10–30 completed earlier)",
        "Pending Timelock operations known: 0",
        "Historical event alerts suppressed: 0",
      ].join("\n"),
    );
  });

  it("ignores a startBlock above the confirmed head", async () => {
    const {daemon, store, sink} = testDaemon({
      config: daemonConfig({chains: {ethereum: {startBlock: 1_000}}}),
      heads: {ethereum: 100n},
    });
    await daemon.cycle("ethereum");
    expect(readChainState(store, "ethereum")).toEqual({cursor: 100n});
    const value = sink.messages[0]!.alert.fields![1]!.value;
    expect(value).toContain("no backfill: Timelock proposals and CCIP messages before block 100 are not tracked");
    expect(value).toContain("startBlock 1000 is above the confirmed head and was ignored");
  });
});

describe("stale telemetry", () => {
  it("raises high after staleAfterSec, critical after 3x, and resolves once caught up", async () => {
    const {daemon, chains, clock, sink, delivered} = testDaemon({config: daemonConfig({chains: {ethereum: {}}})});
    await daemon.cycle("ethereum");
    expect(daemon.status().chains[0]!.lastCaughtUpAt).toBe(T0);
    const stale = "ethereum:health:stale-telemetry";
    const states = () => sink.summary.filter((line) => line.endsWith(stale));

    chains.ethereum!.head = new Error("RPC timeout");
    clock.now += 60_000;
    await daemon.cycle("ethereum");
    expect(states()).toEqual([]);

    // A hung RPC never finishes a cycle: the health timer raises it on its own.
    clock.now += 1_000;
    await daemon.healthTick();
    expect(states()).toEqual([`firing:high:${stale}`]);
    const alert = sink.messages.find((m) => m.alert.key === stale)!.alert;
    expect(alert.rule).toBe("health.stale-telemetry");
    expect(alert.note).toContain("LiquidityManager.pauseRecall()");

    clock.now += 120_000;
    await daemon.healthTick();
    await delivered();
    expect(states()).toEqual([`firing:high:${stale}`, `firing:critical:${stale}`]);

    // Back at the same head: caught up, but the chain is still stale until the head advances.
    chains.ethereum!.head = 100n;
    await daemon.cycle("ethereum");
    await delivered();
    expect(states()).toEqual([`firing:high:${stale}`, `firing:critical:${stale}`]);
    chains.ethereum!.head = 101n;
    await daemon.cycle("ethereum");
    await delivered();
    expect(states()).toEqual([`firing:high:${stale}`, `firing:critical:${stale}`, `resolved:critical:${stale}`]);
  });

  it("raises it when the RPC answers with a head that stops advancing, and resolves once it moves again", async () => {
    const url = "https://hc-ping.example.com/abcdefgh";
    const fetch = vi.fn(async () => new Response("ok"));
    const event = spyEventRule("a");
    const state = spyStateRule("state-spy");
    const {daemon, chains, clock, sink} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}, alerts: {heartbeatUrl: url}, http: HTTP}),
      heads: {ethereum: 100n},
      eventRules: [event],
      stateRules: [state],
      fetch,
    });
    const stale = "ethereum:health:stale-telemetry";
    await daemon.cycle("ethereum");
    for (let i = 0; i < 6; i++) {
      clock.now += POLL_MS;
      expect(await daemon.cycle("ethereum")).toBe(true);
    }
    expect(sink.summary.filter((line) => line.endsWith(stale))).toEqual([]);
    expect(await daemon.heartbeat()).toBe(true);

    // A stuck node: every cycle still succeeds and is "caught up" to the frozen head.
    clock.now += POLL_MS;
    await daemon.cycle("ethereum");
    expect(sink.summary.filter((line) => line.endsWith(stale))).toEqual([`firing:high:${stale}`]);
    const alert = sink.messages.find((m) => m.alert.key === stale)!.alert;
    expect(alert.title).toBe("Stale telemetry: ethereum head not advancing for 1m");
    expect(healthz(daemon.status())).toMatchObject({code: 503, body: {status: "stale"}});
    expect(await daemon.heartbeat()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.calls).toHaveLength(1);

    chains.ethereum!.head = 101n;
    clock.now += POLL_MS;
    await daemon.cycle("ethereum");
    expect(sink.summary.filter((line) => line.endsWith(stale))).toEqual([
      `firing:high:${stale}`,
      `resolved:high:${stale}`,
    ]);
    expect(await daemon.heartbeat()).toBe(true);
  });

  it("raises it while the RPC stays behind the stored cursor (a syncing node), without state checks", async () => {
    const store = createStore();
    store.set(daemonNamespace("ethereum"), {cursor: 1_000_000n});
    const state = spyStateRule("state-spy");
    const {daemon, chains, clock, sink} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store,
      heads: {ethereum: 500_000n},
      stateRules: [state],
    });
    for (let i = 0; i < 8; i++) {
      chains.ethereum!.head = 500_000n + BigInt(i);
      expect(await daemon.cycle("ethereum")).toBe(true);
      clock.now += POLL_MS;
    }
    expect(sink.summary).toContain("firing:high:ethereum:health:stale-telemetry");
    const alert = sink.messages.find((m) => m.alert.rule === "health.stale-telemetry")!.alert;
    expect(alert.fields).toContainEqual({
      label: "RPC behind",
      value: "the confirmed head is 499993 blocks below the processed block",
    });
    expect(state.calls).toEqual([]);
    expect(healthz(daemon.status()).body.chains).toMatchObject({ethereum: {lagBlocks: -499_993}});
  });

  it("keeps a condition still open at a restart open, at its severity, while the RPC is still down", async () => {
    const store = createStore();
    const config = daemonConfig({chains: {ethereum: {}}});
    const clock = {now: T0};
    const stale = "ethereum:health:stale-telemetry";
    const first = testDaemon({config, store, clock});
    await first.daemon.cycle("ethereum");
    first.chains.ethereum!.head = new Error("RPC down");
    clock.now += 200_000;
    await first.daemon.cycle("ethereum");
    expect(first.sink.summary).toEqual([`firing:info:global:health:started:${T0}`, `firing:critical:${stale}`]);
    await first.daemon.stop();

    clock.now += 5_000;
    const second = testDaemon({config, store, clock});
    second.chains.ethereum!.head = new Error("RPC still down");
    await second.daemon.cycle("ethereum");
    clock.now += 30_000;
    await second.daemon.healthTick();
    expect(second.sink.summary).toEqual([]);
    expect(second.daemon.alerter.openConditions().map((open) => `${open.alert.severity}:${open.alert.key}`)).toEqual([
      `critical:${stale}`,
    ]);
    // Opened straight at critical (no health tick in between): the carried start keeps it critical.
    expect(second.daemon.status().chains[0]!.staleSince).toBe(T0 + 200_000 - 180_000 - 1_000);
    expect(healthz(second.daemon.status()).code).toBe(503);

    // Recovered: a real catch-up to an advancing head resolves it.
    second.chains.ethereum!.head = 101n;
    await second.daemon.cycle("ethereum");
    expect(second.sink.summary).toContain(`resolved:critical:${stale}`);
  });

  it("keeps a condition still open at a restart open while the head is still frozen at the cursor", async () => {
    const store = createStore();
    const config = daemonConfig({chains: {ethereum: {}}});
    const clock = {now: T0};
    const stale = "ethereum:health:stale-telemetry";
    const first = testDaemon({config, store, clock, heads: {ethereum: 100n}});
    await first.daemon.cycle("ethereum");
    for (let i = 0; i < 20; i++) {
      clock.now += POLL_MS;
      await first.daemon.cycle("ethereum");
    }
    expect(first.sink.summary.filter((line) => line.endsWith(stale))).toEqual([
      `firing:high:${stale}`,
      `firing:critical:${stale}`,
    ]);
    await first.daemon.stop();

    clock.now += 5_000;
    const second = testDaemon({config, store, clock, heads: {ethereum: 100n}});
    await second.daemon.cycle("ethereum");
    clock.now += POLL_MS;
    await second.daemon.cycle("ethereum");
    expect(second.sink.summary.filter((line) => line.endsWith(stale))).toEqual([]);
    expect(second.daemon.alerter.openConditions().map((open) => `${open.alert.severity}:${open.alert.key}`)).toEqual([
      `critical:${stale}`,
    ]);

    second.chains.ethereum!.head = 101n;
    await second.daemon.cycle("ethereum");
    expect(second.sink.summary.filter((line) => line.endsWith(stale))).toEqual([`resolved:critical:${stale}`]);
  });

  it("counts from the start for a chain that never caught up", async () => {
    const {daemon, chains, clock, sink} = testDaemon({config: daemonConfig({chains: {ethereum: {}}})});
    chains.ethereum!.head = new Error("down");
    clock.now += 61_000;
    await daemon.healthTick();
    expect(sink.summary).toEqual(["firing:high:ethereum:health:stale-telemetry"]);
  });
});

describe("restart on a lagging RPC", () => {
  it("runs no state rule below the stored cursor, so it never resolves a condition that still holds", async () => {
    const store = createStore();
    const config = daemonConfig({chains: {ethereum: {}}});
    const guardian = () =>
      spyStateRule("state-manager", (ctx, block) =>
        block >= 1_000n ? [condition(ctx.name, "state-manager", "guardian", {severity: "critical"})] : [],
      );
    const first = testDaemon({config, store, heads: {ethereum: 1_000n}, stateRules: [guardian()]});
    await first.daemon.cycle("ethereum");
    expect(first.sink.summary).toContain("firing:critical:ethereum:state-manager:guardian");

    const rule = guardian();
    const second = testDaemon({config, store, heads: {ethereum: 900n}, stateRules: [rule]});
    expect(await second.daemon.cycle("ethereum")).toBe(true);
    expect(rule.calls).toEqual([]);
    expect(second.sink.summary.filter((line) => line.startsWith("resolved"))).toEqual([]);
    expect(second.daemon.status().chains[0]!.lastCaughtUpAt).toBeUndefined();

    // The node catches up: state is checked again at (or past) the cursor.
    second.chains.ethereum!.head = 1_000n;
    await second.daemon.cycle("ethereum");
    expect(rule.calls).toEqual([{chain: "ethereum", block: 1_000n}]);
    expect(second.daemon.alerter.openConditions().map((open) => open.alert.key)).toContain(
      "ethereum:state-manager:guardian",
    );
  });
});

describe("conditions no rule evaluates any more", () => {
  it("are dropped at the start without a RESOLVED, and listed in the startup message", async () => {
    const store = createStore();
    const reminderSec = daemonConfig().alerts.reminderSec;
    const seed = new AlertManager({sinks: [], store, reminderSec, log: silentLogger, now: () => T0});
    const keep = ["ethereum:state-pool:0x1:owner", "global:health:other", "ethereum:ccip:ramps"];
    const drop = ["global:reconcile:backing", "bsc:ccip:ramps", "polygon:state-token:owner"];
    for (const key of [...keep, ...drop]) seed.emit(condition("x", "x", "x", {key, severity: "critical"}));
    const log = logger();
    const {daemon, sink, clock, delivered} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}, bsc: {ccip: {enabled: false}}}}),
      store,
      log,
      // A state rule keeps the ethereum condition open (a sync would resolve it otherwise).
      stateRules: [
        spyStateRule("state-pool", () => [condition("ethereum", "state-pool", "0x1:owner", {severity: "critical"})]),
      ],
    });
    expect(daemon.alerter.openConditions().map((open) => open.alert.key).sort()).toEqual([...keep].sort());
    expect(log.lines).toContainEqual(
      expect.objectContaining({level: "warn", fields: {keys: expect.arrayContaining(drop)}}),
    );

    await daemon.cycle("ethereum");
    await daemon.cycle("bsc");
    clock.now += 2 * 3600_000;
    await daemon.healthTick();
    await delivered();
    const reminded = sink.messages.filter((m) => m.status === "reminder").map((m) => m.alert.key);
    expect(reminded.sort()).toEqual([...keep].sort());
    expect(sink.summary.filter((line) => line.startsWith("resolved"))).toEqual([]);
    const started = sink.messages.find((m) => m.alert.rule === "health.started")!.alert;
    expect(started.fields!.at(-1)!.value.split("\n")).toHaveLength(3);
  });
});

describe("reconciliation", () => {
  it("runs only when enabled and once every chain caught up; failures are counted", async () => {
    const calls: Array<{contexts: number; sameAlerter: boolean}> = [];
    let fail = false;
    const report = {status: "ok", conditions: [], R: 1n, I: 0n} as unknown as ReconcileReport;
    const {daemon, chains} = testDaemon({
      config: daemonConfig({reconciliation: {enabled: true, intervalSec: 60}}),
      reconcile: async (contexts, alerter) => {
        calls.push({contexts: contexts.length, sameAlerter: alerter === daemon.alerter});
        if (fail) throw new Error("reconcile bug");
        return report;
      },
    });
    chains.bsc!.head = new Error("down");
    await daemon.cycle("ethereum");
    await daemon.cycle("bsc");
    expect(await daemon.runReconcile()).toBeUndefined();
    expect(calls).toEqual([]);

    chains.bsc!.head = 100n;
    await daemon.cycle("bsc");
    expect(await daemon.runReconcile()).toBe(report);
    expect(calls).toEqual([{contexts: 2, sameAlerter: true}]);
    expect(daemon.lastReport).toBe(report);

    fail = true;
    expect(await daemon.runReconcile()).toBeUndefined();
    expect(daemon.reconcileFailures).toBe(1);
    expect(daemon.lastReport).toBe(report);
  });

  it("is skipped while a chain has not caught up since the start or is stale", async () => {
    const reconcile = vi.fn(async () => ({status: "ok", conditions: []}) as unknown as ReconcileReport);
    const store = createStore();
    store.set(daemonNamespace("bsc"), {cursor: 1_000n});
    const {daemon, chains, clock} = testDaemon({
      config: daemonConfig({reconciliation: {enabled: true, intervalSec: 60}}),
      store,
      heads: {ethereum: 100n, bsc: 900n},
      reconcile,
    });
    // bsc's RPC is behind its stored cursor (a restart onto a lagging node): its balances predate what was processed.
    await daemon.cycle("ethereum");
    await daemon.cycle("bsc");
    expect(await daemon.runReconcile()).toBeUndefined();

    chains.bsc!.head = 1_000n;
    await daemon.cycle("bsc");
    expect(await daemon.runReconcile()).toBeDefined();
    expect(reconcile).toHaveBeenCalledTimes(1);

    // A head frozen for longer than staleAfterSec (a stuck node): its balances never change.
    for (let i = 0; i < 7; i++) {
      clock.now += POLL_MS;
      chains.ethereum!.head = 101n + BigInt(i);
      await daemon.cycle("ethereum");
      await daemon.cycle("bsc");
    }
    expect(await daemon.runReconcile()).toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(1);

    chains.bsc!.head = 1_001n;
    await daemon.cycle("bsc");
    expect(await daemon.runReconcile()).toBeDefined();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("never runs when disabled", async () => {
    const reconcile = vi.fn();
    const {daemon} = testDaemon({reconcile});
    await daemon.cycle("ethereum");
    await daemon.cycle("bsc");
    expect(await daemon.runReconcile()).toBeUndefined();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("starts its own loop once every chain succeeded, every intervalSec", async () => {
    const reconcile = vi.fn(async () => ({status: "ok", conditions: []}) as unknown as ReconcileReport);
    const {daemon, timers} = testDaemon({
      config: daemonConfig({reconciliation: {enabled: true, intervalSec: 120}}),
      reconcile,
    });
    await daemon.start();
    timers.fire(0);
    await vi.waitFor(() => expect(timers.delays).toContain(0));
    timers.fire(0);
    await vi.waitFor(() => expect(timers.delays).toContain(120_000));
    expect(reconcile).toHaveBeenCalledTimes(1);
    await daemon.stop();
  });
});

describe("daily summary", () => {
  it("is sent once per UTC day at or after dailySummaryUtc, also across restarts", async () => {
    const store = createStore();
    const config = daemonConfig({alerts: {dailySummaryUtc: "01:00"}, chains: {ethereum: {}}});
    const state = spyStateRule("state-inventory");
    const {daemon, clock, sink} = testDaemon({config, store, stateRules: [state]});
    const summaryKeys = (messages: typeof sink.messages) =>
      messages.filter((m) => m.alert.rule === "health.daily-summary").map((m) => m.alert.key);
    const summaries = () => summaryKeys(sink.messages);

    await daemon.cycle("ethereum");
    await daemon.healthTick();
    expect(summaries()).toEqual([]);

    clock.now = Date.UTC(2026, 9, 28, 1, 0, 0);
    await daemon.healthTick();
    await daemon.healthTick();
    expect(summaries()).toEqual(["global:health:daily-summary:2026-10-28"]);
    expect(store.get(HEALTH_NAMESPACE, {})).toEqual({lastSummaryDate: "2026-10-28"});
    const summary = sink.messages.find((m) => m.alert.rule === "health.daily-summary")!.alert;
    expect(summary.fields?.map((field) => field.label)).toEqual(
      expect.arrayContaining(["ethereum", "ethereum · state-inventory value", "Reconciliation", "Open conditions"]),
    );

    const restarted = testDaemon({config, store, clock});
    await restarted.daemon.cycle("ethereum");
    await restarted.daemon.healthTick();
    expect(restarted.sink.messages.filter((m) => m.alert.rule === "health.daily-summary")).toEqual([]);

    clock.now = Date.UTC(2026, 9, 29, 3, 0, 0);
    await restarted.daemon.healthTick();
    expect(summaryKeys(restarted.sink.messages)).toEqual(["global:health:daily-summary:2026-10-29"]);
  });
});

describe("heartbeat", () => {
  it("is withheld while a target fails, until its kept alert is delivered", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const critical = (subject: string) => condition("ethereum", "state-spy", subject, {severity: "critical"});
    let active: Alert[] = [];
    const {daemon, chains, sink, timers, delivered} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}, alerts: {heartbeatUrl: "https://hc-ping.example.com/abcdefgh"}}),
      fetch,
      stateRules: [spyStateRule("state-spy", () => active)],
    });
    await daemon.cycle("ethereum");
    await delivered();
    expect(await daemon.heartbeat()).toBe(true);

    sink.fail = true;
    active = [critical("a")];
    chains.ethereum!.head = 101n;
    await daemon.cycle("ethereum");
    await delivered();
    expect(daemon.status().deliveries.capture).toMatchObject({
      failed: 0,
      retries: 1,
      failing: {severity: "critical", kind: "transient"},
      targets: {capture: {undelivered: 1}},
    });
    expect(await daemon.heartbeat()).toBe(false);
    expect(healthz(daemon.status())).toMatchObject({code: 503, body: {status: "delivery-failing"}});
    expect(fetch).toHaveBeenCalledTimes(1);

    // Back up: the next cycle's alert waits behind the kept one until the retry delivers both, in order.
    sink.fail = false;
    active = [critical("a"), critical("b")];
    chains.ethereum!.head = 102n;
    await daemon.cycle("ethereum");
    await delivered();
    expect(await daemon.heartbeat()).toBe(false);
    expect(timers.fire(RETRY_BASE_MS)).toBe(1);
    await delivered();
    expect(sink.summary.slice(-2)).toEqual([
      "firing:critical:ethereum:state-spy:a",
      "firing:critical:ethereum:state-spy:b",
    ]);
    expect(await daemon.heartbeat()).toBe(true);
    expect(healthz(daemon.status()).code).toBe(200);
  });

  it("pings only while every chain is caught up and fresh, and keeps the URL out of the logs", async () => {
    const url = "https://hc-ping.example.com/0b1c2d3e-secret-check-id";
    const fetch = vi.fn(async () => new Response("ok"));
    const log = logger();
    const {daemon, clock, chains} = testDaemon({
      config: daemonConfig({alerts: {heartbeatUrl: url}}),
      fetch,
      log,
    });
    expect(redact(`GET ${url} failed`)).toBe("GET <redacted> failed");
    expect(await daemon.heartbeat()).toBe(false);
    await daemon.cycle("ethereum");
    expect(await daemon.heartbeat()).toBe(false);
    await daemon.cycle("bsc");
    expect(await daemon.heartbeat()).toBe(true);
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({method: "GET"}));

    chains.bsc!.head = new Error("down");
    clock.now += 61_000;
    await daemon.cycle("bsc");
    expect(await daemon.heartbeat()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${url}`));
    chains.ethereum!.head = 101n;
    chains.bsc!.head = 101n;
    await daemon.cycle("ethereum");
    await daemon.cycle("bsc");
    expect(await daemon.heartbeat()).toBe(false);
    const text = JSON.stringify(log.lines, (_key, value: unknown) => (typeof value === "bigint" ? `${value}` : value));
    expect(text).not.toContain("secret-check-id");
  });

  it("is never sent in a dry run", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const {daemon} = testDaemon({
      config: daemonConfig({alerts: {heartbeatUrl: "https://hc-ping.example.com/abcdefgh"}}),
      fetch,
      dryRun: true,
    });
    await daemon.cycle("ethereum");
    await daemon.cycle("bsc");
    expect(await daemon.heartbeat()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("http status server", () => {
  it("serves /healthz and /metrics from the cached status", async () => {
    const {daemon, chains, clock} = testDaemon({config: daemonConfig({http: HTTP}), heads: {ethereum: 100n, bsc: 50n}});
    await daemon.start();
    const base = `http://127.0.0.1:${daemon.address!.port}`;
    await daemon.cycle("ethereum");
    await daemon.cycle("bsc");
    let response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {status: string; chains: Record<string, Record<string, unknown>>};
    expect(body.status).toBe("ok");
    expect(body.chains.ethereum).toMatchObject({processedBlock: 100, confirmedHead: 100, lagBlocks: 0, stale: false});

    response = await fetch(`${base}/metrics`);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const metrics = await response.text();
    expect(metrics).toContain('sahara_monitor_chain_processed_block{chain="bsc"} 50');
    expect(metrics).toContain('sahara_monitor_alert_deliveries_total{sink="capture",target="capture",result="ok"} 1');

    // A hung RPC: the cycle does not finish, the endpoint still answers from the cached status.
    let release!: () => void;
    chains.ethereum!.gate = new Promise((resolve) => (release = resolve));
    const hung = daemon.cycle("ethereum");
    clock.now += 61_000;
    response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(503);
    expect(((await response.json()) as {status: string}).status).toBe("stale");
    expect((await fetch(`${base}/nope`)).status).toBe(404);

    chains.ethereum!.gate = undefined;
    release();
    await hung;
    await daemon.stop();
  });
});

describe("stop", () => {
  it("stops scheduling, waits for the in-flight cycle, flushes, saves and closes the server", async () => {
    const order: string[] = [];
    const store = recordingStore(order);
    const {daemon, chains, timers} = testDaemon({
      config: daemonConfig({http: HTTP, chains: {ethereum: {}}}),
      store,
      order,
      stateRules: [spyStateRule("state-spy", () => [condition("ethereum", "state-spy", "x")], order)],
    });
    await daemon.start();
    let release!: () => void;
    chains.ethereum!.gate = new Promise((resolve) => (release = resolve));
    timers.fire(0);
    await vi.waitFor(() => expect(chains.ethereum!.headCalls).toBe(1));
    order.length = 0;

    const stopped = daemon.stop();
    let done = false;
    void stopped.then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    expect(timers.pending.size).toBe(0);

    chains.ethereum!.gate = undefined;
    release();
    await stopped;
    expect(order.indexOf("send:ethereum:state-spy:x")).toBeLessThan(order.lastIndexOf("save"));
    expect(order.at(-1)).toBe("save");
    // Nothing was rescheduled, and the port is closed.
    expect(timers.pending.size).toBe(0);
    await expect(fetch(`http://127.0.0.1:${daemon.address!.port}/healthz`)).rejects.toThrow();
  });
});

describe("sinks and dry run", () => {
  const telegram = {botToken: "123456:telegram-test-token", routes: [{chatId: "-100123"}]};

  it("uses Telegram when configured, adds the console at debug level, and the console only in a dry run", () => {
    const names = (sinks: Array<{name: string}>) => sinks.map((sink) => sink.name);
    expect(names(defaultSinks(daemonConfig({telegram}), silentLogger))).toEqual(["telegram"]);
    expect(names(defaultSinks(daemonConfig({telegram, logLevel: "debug"}), silentLogger))).toEqual([
      "telegram",
      "console",
    ]);
    expect(names(defaultSinks(daemonConfig({telegram}), silentLogger, {dryRun: true}))).toEqual(["console"]);
    expect(names(defaultSinks(daemonConfig(), silentLogger))).toEqual(["console"]);
    expect(defaultSinks(daemonConfig({telegram}), silentLogger)[0]).toBeInstanceOf(TelegramSink);
    expect(defaultSinks(daemonConfig(), silentLogger)[0]).toBeInstanceOf(ConsoleSink);
  });

  it("neither reads nor writes the state file in a dry run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monitor-dry-"));
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({[daemonNamespace("ethereum")]: {cursor: {$bigint: "10"}}}));
    const config = daemonConfig({stateFile: path, chains: {ethereum: {}}});
    const {daemon} = testDaemon({config, dryRun: true, store: undefined, heads: {ethereum: 100n}});
    await daemon.cycle("ethereum");
    expect(readChainState(daemon.store, "ethereum").cursor).toBe(99n + 1n);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      [daemonNamespace("ethereum")]: {cursor: {$bigint: "10"}},
    });
    const fresh = join(dir, "other.json");
    const second = testDaemon({config: daemonConfig({stateFile: fresh}), dryRun: true, store: undefined});
    await second.daemon.cycle("ethereum");
    expect(existsSync(fresh)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Replay idempotency with the real rules

const USER = ccAddr(0x777);
const BLOCK_TIME = CCIP_T0;

describe("replay idempotency (real event rules)", () => {
  beforeEach(() => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime((BLOCK_TIME + 600) * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function replayLogs() {
    const send = loadReceipt("eth-send-v2.json");
    const block = BigInt(send.fixture.blockNumber);
    const amount = parseUnits("5000", 18);
    const tx = (label: string): Hex => `0x${label.padEnd(64, "0")}` as Hex;
    const logs: Log[] = [...send.logs];

    // A release from BSC executed by OffRamp 2.0.0: flows (pool outflow window) and ccip (exec record).
    const release = tx("a1");
    logs.push(
      tokenLog(saharaTokenAbi, SAHARA, "Transfer", {from: POOL, to: USER, value: amount}, {
        txHash: release,
        blockNumber: block + 1n,
        logIndex: 1,
      }),
      releaseLog(
        {remoteChainSelector: BSC, offRamp: OFFRAMP_V2.ethereum, recipient: USER, amount},
        {txHash: release, block: block + 1n, logIndex: 2},
      ),
      execLogV2(
        OFFRAMP_V2.ethereum,
        {sourceChainSelector: BSC, messageNumber: 7n, messageId: tx("e1"), state: SUCCESS},
        {txHash: release, block: block + 1n, logIndex: 3},
      ),
    );
    // A release that failed for lack of pool inventory: ccip failure alert.
    logs.push(
      execLogV2(
        OFFRAMP_V2.ethereum,
        {
          sourceChainSelector: BSC,
          messageNumber: 8n,
          messageId: tx("e2"),
          state: FAILURE,
          returnData: insufficientBalanceError(SAHARA, POOL, 0n, amount),
        },
        {txHash: tx("a2"), block: block + 2n, logIndex: 0},
      ),
    );
    // A direct transfer into the pool (flows: high, bypasses provideLiquidity).
    logs.push(
      tokenLog(saharaTokenAbi, SAHARA, "Transfer", {from: USER, to: POOL, value: amount}, {
        txHash: tx("a3"),
        blockNumber: block + 3n,
        logIndex: 0,
      }),
    );
    // Two Timelock operations: one stays pending, one is executed in the same chunk.
    const pause = {
      target: MANAGER.ethereum,
      value: 0n,
      data: encodeFunctionData({abi: liquidityManagerAbi, functionName: "setFundingPaused", args: [true]}),
    };
    const budget = {
      target: MANAGER.ethereum,
      value: 0n,
      data: encodeFunctionData({abi: liquidityManagerAbi, functionName: "setMaxFundingPerCall", args: [1n]}),
    };
    const pending = hashOperation(pause, zeroHash, zeroHash);
    const executed = hashOperation(budget, zeroHash, zeroHash);
    const schedule = (id: Hex, call: typeof pause, hash: Hex, firstLogIndex: number) =>
      scheduleLogs(id, [call], {
        predecessor: zeroHash,
        salt: zeroHash,
        delay: 172_800n,
        txHash: hash,
        blockNumber: block + 4n,
        firstLogIndex,
      });
    logs.push(...schedule(pending, pause, tx("b1"), 0), ...schedule(executed, budget, tx("b2"), 1));
    logs.push(
      timelockLog(saharaTimelockAbi, "CallExecuted", {id: executed, index: 0n, ...budget}, {
        txHash: tx("b3"),
        blockNumber: block + 5n,
        logIndex: 0,
      }),
    );
    return {logs, block, pending, executed};
  }

  it("sends nothing new and counts nothing twice when a chunk is fed to every rule again", async () => {
    const {logs, block, pending, executed} = replayLogs();
    const config = configSchema.parse({
      chains: {
        ethereum: {
          chainId: 1,
          chainSelector: ETH.toString(),
          rpcUrls: ["http://localhost:8545"],
          explorerUrl: "https://etherscan.io",
          contracts: {token: SAHARA, registry: REGISTRY.ethereum, router: ROUTER.ethereum, pool: POOL},
          limits: {outflowWindowAmount: "1000", largeTransfer: "1000"},
        },
        bsc: {
          chainId: 56,
          chainSelector: BSC.toString(),
          rpcUrls: ["http://localhost:8546"],
          explorerUrl: "https://bscscan.com",
          contracts: {token: SAHARA, registry: REGISTRY.bsc, router: ROUTER.bsc, pool: POOL},
        },
      },
    });
    const store = createStore();
    const sink = new CaptureSink();
    const alerter = new AlertManager({sinks: [sink], store, reminderSec: config.alerts.reminderSec, log: silentLogger});
    const fake = ccipClient({chain: "ethereum", logs});
    const addresses = ccipAddresses("ethereum", {
      manager: MANAGER.ethereum,
      timelock: TL.timelock,
      controller: TL.controller,
    });
    const ctx = createChainContext({
      name: "ethereum",
      chain: config.chains.ethereum!,
      global: config,
      client: fake.client,
      alerter,
      store,
      log: silentLogger,
      addresses,
    });
    const chunk = {from: block, to: block + 9n};
    const namespaces = [
      "flows:ethereum",
      "timelock:ethereum",
      "ccip:sent:ethereum",
      "ccip:exec:ethereum",
      "ccip:scan:ethereum",
      "events:ethereum",
      "alerts",
    ];
    const snapshot = () => JSON.stringify(namespaces.map((ns) => store.get(ns, null)), (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );

    await scanChunk(ctx, eventRules, chunk);
    alerter.flush();
    await alerter.drain(60_000);
    const firstMessages = sink.summary;
    const firstState = snapshot();

    // The first pass exercised every rule's state.
    expect(readFlowsState(ctx).outflows[POOL]).toHaveLength(1);
    const ops = readPendingOps(store, "ethereum");
    expect(ops[pending]?.status).toBe("pending");
    expect(ops[executed]?.status).toBe("executed");
    expect(Object.keys(readSent(store, "ethereum"))).toHaveLength(1);
    expect(Object.keys(readExec(store, "ethereum"))).toHaveLength(2);
    expect(readScan(store, "ethereum").cursor).toEqual(chunk);
    const rules = new Set(sink.messages.map((message) => message.alert.rule.split(".")[0]));
    expect([...rules]).toEqual(expect.arrayContaining(["flows", "ccip", "timelock"]));
    expect(firstMessages.some((line) => line.includes(":ethereum:flows:outflow-window:"))).toBe(true);

    await scanChunk(ctx, eventRules, chunk);
    alerter.flush();
    await alerter.drain(60_000);
    expect(sink.summary).toEqual(firstMessages);
    expect(snapshot()).toEqual(firstState);
    expect(readScan(store, "ethereum").gaps).toEqual([]);
  });
});
