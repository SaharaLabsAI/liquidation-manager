// Reconciliation blocked in the daemon: how long it has been (`health.reconcile`), health.reconcile-stale once longer
// than reconciliation.staleAfterSec, /healthz, the heartbeat and /metrics, and all of it carried over a restart.
// Codex repro: the finalized balanceOf read failing for 600 s (staleAfterSec 60) left only the reconcile.incomplete
// warning, /healthz 200 and the heartbeat running, although R − I could not be verified the whole time.
import {describe, expect, it, vi} from "vitest";

import {AlertManager} from "../src/alerts/manager.ts";
import {ccipGaps, emptyScanState, writeScan} from "../src/ccip/store.ts";
import {
  daemonNamespace,
  HEALTH_INTERVAL_MS,
  HEALTH_NAMESPACE,
  type HealthState,
  type Timers,
} from "../src/daemon.ts";
import {healthz, renderMetrics} from "../src/health.ts";
import {silentLogger} from "../src/log.ts";
import type {IncompleteReason, ReconcileReport} from "../src/rules/reconcile.ts";
import {createStore, type Store} from "../src/store.ts";
import type {BlockRange} from "../src/types.ts";
import {
  CaptureSink,
  daemonConfig,
  fillingCcipRule,
  T0,
  testDaemon,
  type Clock,
  type FakeChain,
} from "./helpers/daemon-fakes.ts";

const HEARTBEAT = "https://hc-ping.example.com/abcdefgh";
const STALE_KEY = "global:health:reconcile-stale";
const INCOMPLETE_KEY = "global:reconcile:incomplete";
const WEI = 10n ** 18n;

/** Daemon cursor and a ccip scan from block 1 at `cursor` on both chains; `gaps` on ethereum. */
function seeded(cursor = 100n, gaps: BlockRange[] = []): Store {
  const store = createStore();
  for (const chain of ["ethereum", "bsc"]) {
    store.set(daemonNamespace(chain), {cursor});
    writeScan(store, chain, {
      ...emptyScanState(),
      cursor: {from: 1n, to: cursor},
      gaps: chain === "ethereum" ? gaps.map((gap) => ({...gap, detectedAt: 0})) : [],
    });
  }
  return store;
}

/**
 * What reconciliation reads: the finalized block (the head), totalSupply (10B) and the pool's balance (5B), which fails
 * (an eth_call rate limit at the finalized block) while `reads.fail`.
 */
function balanceReads(fake: FakeChain, fail = false): {fail: boolean} {
  const reads = {fail};
  Object.assign(fake.client, {
    async getBlock({blockNumber, blockTag}: {blockNumber?: bigint; blockTag?: string}) {
      const number = blockTag === "finalized" ? (fake.head as bigint) : (blockNumber ?? 0n);
      return {number, timestamp: 1_700_000_000n + number * 12n};
    },
    async readContract({functionName}: {functionName: string}) {
      if (functionName === "totalSupply") return 10_000_000_000n * WEI;
      if (reads.fail) throw new Error("HTTP request failed: 429 Too Many Requests");
      return 5_000_000_000n * WEI;
    },
  });
  return reads;
}

const UNREACHABLE: IncompleteReason = {
  chain: "ethereum",
  reason: "ethereum unreachable: balance reads at block 160 failed: HTTP request failed: 429 Too Many Requests",
  blocking: true,
  cause: "unreachable",
};

/** A report as reconcile() returns it: incomplete with blocking `reasons`, else ok. */
function report(reasons: IncompleteReason[] = []): ReconcileReport {
  const status = reasons.some((reason) => reason.blocking) ? "incomplete" : "ok";
  return {status, incomplete: reasons, conditions: [], failed: [], stuck: []} as unknown as ReconcileReport;
}

type T = ReturnType<typeof testDaemon>;

const about = (t: T, key: string) => t.sink.summary.filter((line) => line.endsWith(key));
const openKeys = (t: T) => t.daemon.alerter.openConditions().map((open) => `${open.alert.severity}:${open.alert.key}`);

/** Cycles of every chain at a new head every 10 s up to `untilMs` after T0 (and the timers `extra` runs then). */
async function stepUntil(t: T, untilMs: number, extra: (at: number) => Promise<void> = async () => {}): Promise<void> {
  while (t.clock.now - T0 < untilMs) {
    t.clock.now += 10_000;
    for (const [name, fake] of Object.entries(t.chains)) {
      fake.head = (fake.head as bigint) + 1n;
      expect(await t.daemon.cycle(name)).toBe(true);
    }
    await extra((t.clock.now - T0) / 1000);
  }
}

/** As the daemon's timers would: cycles every 10 s, reconciliation every `intervalSec`, the health tick every 30 s. */
function runUntil(t: T, untilMs: number, intervalSec: number): Promise<void> {
  return stepUntil(t, untilMs, async (at) => {
    if (at % intervalSec === 0) await t.daemon.runReconcile();
    if (at % 30 === 0) await t.daemon.healthTick();
  });
}

/** Seconds since T0 of every chain's first cycle and a first (blocked) reconciliation at T0. */
async function firstRun(t: T): Promise<ReconcileReport | undefined> {
  for (const name of Object.keys(t.chains)) expect(await t.daemon.cycle(name)).toBe(true);
  return t.daemon.runReconcile();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Defaults (intervalSec 300, staleAfterSec 900): one blocked run at T0, a health tick 100 s later (nothing to page),
 * a stop of `downtimeMin`, then a new daemon on the same state file, started with its loops on ManualTimers. `tick()`
 * fires its first health tick 30 s after the start, before any cycle or run. Runs are blocked while `blocked`.
 */
async function restartAfterOneBlockedRun(downtimeMin: number) {
  const state = {blocked: true};
  const clock = {now: T0};
  const options = {
    config: daemonConfig({
      reconciliation: {enabled: true},
      alerts: {heartbeatUrl: HEARTBEAT},
      chains: {ethereum: {staleAfterSec: 300}, bsc: {staleAfterSec: 300}},
    }),
    store: seeded(),
    clock,
    fetch: vi.fn(async () => new Response("ok")),
    reconcile: async () => report(state.blocked ? [UNREACHABLE] : []),
  };
  const first = testDaemon(options);
  await firstRun(first);
  clock.now += 100_000;
  await first.daemon.healthTick();
  await first.daemon.stop();
  expect(about(first, STALE_KEY)).toEqual([]);

  clock.now += downtimeMin * 60_000;
  const second = testDaemon(options);
  await second.daemon.start();
  return {
    second,
    clock,
    options,
    get blocked() {
      return state.blocked;
    },
    set blocked(value: boolean) {
      state.blocked = value;
    },
    async tick() {
      clock.now += HEALTH_INTERVAL_MS;
      expect(second.timers.fire(HEALTH_INTERVAL_MS)).toBe(1);
      await settle();
    },
  };
}

/** Timers on the test clock, each late by up to `jitterMs` (seeded), fired in due order. */
class JitteredTimers implements Timers {
  readonly #clock: Clock;
  readonly #jitterMs: number;
  readonly #pending = new Map<number, {dueAt: number; callback: () => void}>();
  #next = 1;
  #seed: number;

  constructor(clock: Clock, seed: number, jitterMs: number) {
    this.#clock = clock;
    this.#seed = seed;
    this.#jitterMs = jitterMs;
  }

  /** 0 ≤ random < 1 (mulberry32). */
  random(): number {
    this.#seed = (this.#seed + 0x6d2b79f5) | 0;
    let x = Math.imul(this.#seed ^ (this.#seed >>> 15), 1 | this.#seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#pending.set(id, {dueAt: this.#clock.now + ms + Math.floor(this.random() * this.#jitterMs), callback});
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#pending.delete(handle as number);
  }

  /** Resolves `ms` of test time later, on time (an RPC request hanging until its timeout). */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#pending.set(this.#next++, {dueAt: this.#clock.now + ms, callback: () => resolve()});
    });
  }

  /** Fires every timer due up to `until` (unix ms), each once the work it started has settled, then `after()`. */
  async runUntil(until: number, before: () => void, after: () => void): Promise<void> {
    for (;;) {
      const [id, entry] = [...this.#pending].sort(([, a], [, b]) => a.dueAt - b.dueAt)[0] ?? [];
      if (id === undefined || !entry || entry.dueAt > until) return;
      this.#pending.delete(id);
      this.#clock.now = Math.max(this.#clock.now, entry.dueAt);
      before();
      entry.callback();
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      after();
    }
  }
}

describe("reconciliation blocked", () => {
  it("escalates a finalized balance read failing for 600 s, while the scan and state reads work", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const t = testDaemon({
      config: daemonConfig({reconciliation: {enabled: true, intervalSec: 60}, alerts: {heartbeatUrl: HEARTBEAT}}),
      store: seeded(),
      eventRules: [fillingCcipRule()],
      fetch,
    });
    const reads = balanceReads(t.chains.ethereum!, true);
    balanceReads(t.chains.bsc!);
    expect((await firstRun(t))?.status).toBe("incomplete");
    expect(about(t, INCOMPLETE_KEY)).toEqual([`firing:warning:${INCOMPLETE_KEY}`]);
    expect(about(t, STALE_KEY)).toEqual([]);

    // reconciliation.staleAfterSec defaults to 3 × intervalSec: 180 s.
    await runUntil(t, 180_000, 60);
    expect(about(t, STALE_KEY)).toEqual([]);
    expect(healthz(t.daemon.status())).toMatchObject({
      code: 200,
      body: {reconcile: {stale: false, blockedForSec: 180}},
    });
    expect(await t.daemon.heartbeat()).toBe(true);

    await runUntil(t, 240_000, 60);
    expect(about(t, STALE_KEY)).toEqual([`firing:high:${STALE_KEY}`]);
    const high = t.sink.messages.find((message) => message.alert.key === STALE_KEY)!.alert;
    expect(high.rule).toBe("health.reconcile-stale");
    expect(high.title).toBe("Reconciliation blocked for 3m: R − I not verified");
    expect(high.fields).toEqual([
      {label: "Blocked for", value: "3m since 2026-10-28 00:30:00 UTC (limit 3m)"},
      {label: "Last complete reconciliation", value: "none recorded"},
      {label: "Blocking reasons", value: expect.stringMatching(/^ethereum unreachable: balance reads at block \d+/)},
    ]);
    expect(high.note).toContain("LiquidityManager.pauseRecall()");
    expect(healthz(t.daemon.status())).toMatchObject({
      code: 503,
      body: {
        status: "stale",
        chains: {ethereum: {stale: false, readsStale: false}, bsc: {stale: false}},
        reconcile: {stale: true, blockedSince: new Date(T0).toISOString(), blockedForSec: 240, lastCompleteAt: null},
      },
    });
    const metrics = renderMetrics(t.daemon.status());
    expect(metrics).toContain("\nsahara_monitor_reconcile_stale 1\n");
    expect(metrics).toContain("\nsahara_monitor_reconcile_blocked_seconds 240\n");
    expect(await t.daemon.heartbeat()).toBe(false);

    // Critical after 3 × 180 s, up to 600 s; the state reads and the scan never went stale.
    await runUntil(t, 600_000, 60);
    expect(about(t, STALE_KEY)).toEqual([`firing:high:${STALE_KEY}`, `firing:critical:${STALE_KEY}`]);
    expect(about(t, INCOMPLETE_KEY)).toEqual([`firing:warning:${INCOMPLETE_KEY}`]);
    expect(t.sink.summary.filter((line) => line.includes("stale-telemetry") || line.includes("read-failed"))).toEqual(
      [],
    );
    expect(healthz(t.daemon.status()).code).toBe(503);
    expect(await t.daemon.heartbeat()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(t.store.get<HealthState>(HEALTH_NAMESPACE, {}).reconcile).toEqual({
      blockedSince: T0,
      reasons: [expect.stringMatching(/^ethereum unreachable: /)],
    });

    reads.fail = false;
    expect((await t.daemon.runReconcile())?.status).toBe("ok");
    expect(about(t, STALE_KEY)).toEqual([
      `firing:high:${STALE_KEY}`,
      `firing:critical:${STALE_KEY}`,
      `resolved:critical:${STALE_KEY}`,
    ]);
    expect(healthz(t.daemon.status())).toMatchObject({
      code: 200,
      body: {reconcile: {stale: false, blockedSince: null, blockedForSec: 0, lastCompleteAt: expect.any(String)}},
    });
    expect(await t.daemon.heartbeat()).toBe(true);
    expect(t.store.get<HealthState>(HEALTH_NAMESPACE, {}).reconcile).toEqual({completeAt: t.clock.now});
  });

  it("escalates a reconciliation that throws (no alert of its own) and counts its failures", async () => {
    let fail = true;
    const t = testDaemon({
      config: daemonConfig({reconciliation: {enabled: true, intervalSec: 60}, alerts: {heartbeatUrl: HEARTBEAT}}),
      fetch: vi.fn(async () => new Response("ok")),
      reconcile: async () => {
        if (fail) throw new Error("reconcile bug at https://rpc0.example.com/v2/secret-api-key-ethereum");
        return report();
      },
    });
    expect(await firstRun(t)).toBeUndefined();
    await runUntil(t, 180_000, 60);
    expect(t.sink.summary.filter((line) => !line.includes("health:started"))).toEqual([]);
    expect(t.daemon.reconcileFailures).toBe(4);

    await runUntil(t, 210_000, 60);
    expect(about(t, STALE_KEY)).toEqual([`firing:high:${STALE_KEY}`]);
    const high = t.sink.messages.at(-1)!.alert;
    expect(high.fields).toEqual([
      {label: "Blocked for", value: "3m since 2026-10-28 00:30:00 UTC (limit 3m)"},
      {label: "Last complete reconciliation", value: "none recorded"},
      {label: "Last error", value: "reconcile bug at <redacted>", code: true},
    ]);
    expect(healthz(t.daemon.status())).toMatchObject({
      code: 503,
      body: {reconcile: {stale: true, error: "reconcile bug at <redacted>", failures: 4}},
    });
    expect(renderMetrics(t.daemon.status())).toContain("\nsahara_monitor_reconcile_failures_total 4\n");
    expect(await t.daemon.heartbeat()).toBe(false);

    fail = false;
    await runUntil(t, 240_000, 60);
    expect(about(t, STALE_KEY)).toEqual([`firing:high:${STALE_KEY}`, `resolved:high:${STALE_KEY}`]);
    expect(healthz(t.daemon.status())).toMatchObject({code: 200, body: {reconcile: {stale: false, failures: 4}}});
    expect(await t.daemon.heartbeat()).toBe(true);
  });

  it("never pages one blocked run followed by a good one with default timings, whatever the timer order", async () => {
    // intervalSec 300, staleAfterSec 3 × 300: every other run blocked, each up to 60 s long, timers up to 5 s late.
    for (const seed of [1, 2, 3, 4]) {
      const clock = {now: T0};
      const timers = new JitteredTimers(clock, seed, 5_000);
      let runs = 0;
      const t = testDaemon({
        config: daemonConfig({
          reconciliation: {enabled: true},
          alerts: {heartbeatUrl: HEARTBEAT},
          chains: {ethereum: {pollIntervalSec: 15, staleAfterSec: 300}, bsc: {pollIntervalSec: 15, staleAfterSec: 300}},
        }),
        clock,
        timers,
        fetch: vi.fn(async () => new Response("ok")),
        reconcile: async () => {
          clock.now += Math.floor(timers.random() * 60_000);
          return report(runs++ % 2 === 0 ? [UNREACHABLE] : []);
        },
      });
      await t.daemon.start();
      const codes = new Set<number>();
      let longest = 0;
      await timers.runUntil(
        T0 + 2 * 3600_000,
        () => {
          for (const fake of Object.values(t.chains)) fake.head = 1_000n + BigInt(Math.floor((clock.now - T0) / 3_000));
        },
        () => {
          const {code, body} = healthz(t.daemon.status());
          codes.add(code);
          longest = Math.max(longest, (body.reconcile as {blockedForSec: number}).blockedForSec);
        },
      );
      await t.daemon.stop();
      expect(runs, `seed ${seed}`).toBeGreaterThan(20);
      expect(longest, `seed ${seed}`).toBeGreaterThan(300);
      expect(longest, `seed ${seed}`).toBeLessThanOrEqual(900);
      expect(about(t, STALE_KEY), `seed ${seed}`).toEqual([]);
      expect([...codes], `seed ${seed}`).toEqual([200]);
    }
  });

  it("counts the runs' durations: at the 2 × intervalSec minimum a slow blocked run and a good one page", async () => {
    // The span runs from the start of the blocked run to the end of the good one: intervalSec plus both runs'
    // durations. A run timing out on its RPC URLs takes minutes ((rpcRetryCount + 1) × rpcTimeoutMs per hanging
    // request and URL): 121 s here, then 2 s good runs. R − I was unverified for 183 s: more than the minimum for
    // intervalSec 60 (120 s), well within the default timings (300 / 900).
    const cases = [
      {
        reconciliation: {intervalSec: 60, staleAfterSec: 120},
        paged: [`firing:high:${STALE_KEY}`, `resolved:high:${STALE_KEY}`],
      },
      {reconciliation: {}, paged: []},
    ];
    for (const {reconciliation, paged} of cases) {
      const clock = {now: T0};
      const timers = new JitteredTimers(clock, 1, 0);
      let runs = 0;
      const t = testDaemon({
        config: daemonConfig({
          reconciliation: {enabled: true, ...reconciliation},
          chains: {ethereum: {staleAfterSec: 300}, bsc: {staleAfterSec: 300}},
        }),
        clock,
        timers,
        reconcile: async () => {
          const blocked = runs++ === 0;
          await timers.sleep(blocked ? 121_000 : 2_000);
          return report(blocked ? [UNREACHABLE] : []);
        },
      });
      await t.daemon.start();
      const heads = () => {
        for (const fake of Object.values(t.chains)) fake.head = 1_000n + BigInt(Math.floor((clock.now - T0) / 3_000));
      };
      await timers.runUntil(T0 + 3600_000, heads, () => {});
      // A run may still wait on a test timer.
      const stopped = t.daemon.stop();
      await timers.runUntil(clock.now + 3600_000, () => {}, () => {});
      await stopped;
      expect(runs).toBeGreaterThan(10);
      expect(about(t, STALE_KEY), JSON.stringify(reconciliation)).toEqual(paged);
    }
  });

  it("pages only after more than staleAfterSec (3 blocked runs by default), critical after 3 × that", async () => {
    const t = testDaemon({
      config: daemonConfig({
        reconciliation: {enabled: true},
        chains: {ethereum: {staleAfterSec: 300}, bsc: {staleAfterSec: 300}},
      }),
      reconcile: async () => report([UNREACHABLE]),
    });
    expect(t.daemon.status().reconcileHealth).toEqual({staleAfterSec: 900, failures: 0});
    await firstRun(t);
    const every300 = async (at: number) => {
      if (at % 300 === 0) await t.daemon.runReconcile();
    };
    await stepUntil(t, 900_000, every300);
    await t.daemon.healthTick();
    expect(about(t, STALE_KEY)).toEqual([]);
    expect(healthz(t.daemon.status()).code).toBe(200);

    t.clock.now += 1_000;
    await t.daemon.healthTick();
    expect(about(t, STALE_KEY)).toEqual([`firing:high:${STALE_KEY}`]);
    expect(healthz(t.daemon.status()).code).toBe(503);

    t.clock.now -= 1_000;
    await stepUntil(t, 2_700_000, every300);
    await t.daemon.healthTick();
    expect(about(t, STALE_KEY)).toEqual([`firing:high:${STALE_KEY}`]);
    t.clock.now += 1_000;
    await t.daemon.healthTick();
    expect(about(t, STALE_KEY)).toEqual([`firing:high:${STALE_KEY}`, `firing:critical:${STALE_KEY}`]);

    // An explicit limit.
    const custom = testDaemon({config: daemonConfig({reconciliation: {enabled: true, staleAfterSec: 1_200}})});
    expect(custom.daemon.status().reconcileHealth?.staleAfterSec).toBe(1_200);
  });

  it("never pages CCIP tracking disabled by config: an operator choice, the incomplete warning only", async () => {
    const t = testDaemon({
      config: daemonConfig({
        reconciliation: {enabled: true, intervalSec: 60},
        alerts: {heartbeatUrl: HEARTBEAT},
        chains: {ethereum: {}, bsc: {ccip: {enabled: false}}},
      }),
      store: seeded(),
      eventRules: [fillingCcipRule()],
      fetch: vi.fn(async () => new Response("ok")),
    });
    balanceReads(t.chains.ethereum!);
    balanceReads(t.chains.bsc!);
    await firstRun(t);
    await runUntil(t, 3600_000, 60);
    expect(t.daemon.lastReport?.incomplete).toEqual([
      expect.objectContaining({chain: "bsc", blocking: true, cause: "ccip-disabled"}),
    ]);
    expect(about(t, INCOMPLETE_KEY)).toEqual([`firing:warning:${INCOMPLETE_KEY}`]);
    expect(about(t, STALE_KEY)).toEqual([]);
    expect(healthz(t.daemon.status())).toMatchObject({
      code: 200,
      body: {reconcile: {stale: false, blockedSince: null}},
    });
    expect(await t.daemon.heartbeat()).toBe(true);
  });

  it("never pages a CCIP gap whose replay progresses, however long it takes", async () => {
    const t = testDaemon({
      config: daemonConfig({reconciliation: {enabled: true, intervalSec: 60}, alerts: {heartbeatUrl: HEARTBEAT}}),
      store: seeded(100_000n, [{from: 11n, to: 90_000n}]),
      heads: {ethereum: 100_000n, bsc: 100_000n},
      eventRules: [fillingCcipRule()],
      fetch: vi.fn(async () => new Response("ok")),
    });
    balanceReads(t.chains.ethereum!);
    balanceReads(t.chains.bsc!);
    await firstRun(t);
    await runUntil(t, 3600_000, 60);
    // 50 blocks a cycle: an hour in, still far from done.
    const [gap] = ccipGaps(t.store, "ethereum");
    expect(gap!.from).toBeGreaterThan(10_000n);
    expect(t.daemon.lastReport?.incomplete).toEqual([
      expect.objectContaining({chain: "ethereum", blocking: true, cause: "ccip-gap"}),
    ]);
    expect(about(t, INCOMPLETE_KEY)).toEqual([`firing:warning:${INCOMPLETE_KEY}`]);
    expect(t.sink.summary.filter((line) => line.includes(":health:"))).toEqual([
      `firing:info:global:health:started:${T0}`,
    ]);
    expect(healthz(t.daemon.status())).toMatchObject({
      code: 200,
      body: {reconcile: {stale: false, blockedSince: null}},
    });
    expect(await t.daemon.heartbeat()).toBe(true);
  });

  it("keeps counting across a restart: 503 before any run, no message, critical from the 1st failure", async () => {
    const store = seeded();
    const clock = {now: T0};
    const fetch = vi.fn(async () => new Response("ok"));
    const config = daemonConfig({reconciliation: {enabled: true, intervalSec: 60}, alerts: {heartbeatUrl: HEARTBEAT}});
    const options = {config, store, clock, eventRules: [fillingCcipRule()], fetch};
    const first = testDaemon(options);
    balanceReads(first.chains.ethereum!, true);
    balanceReads(first.chains.bsc!);
    await firstRun(first);
    await runUntil(first, 210_000, 60);
    expect(about(first, STALE_KEY)).toEqual([`firing:high:${STALE_KEY}`]);
    await first.daemon.stop();

    clock.now += 10_000;
    const heads = {ethereum: first.chains.ethereum!.head as bigint, bsc: first.chains.bsc!.head as bigint};
    const second = testDaemon({...options, heads});
    const reads = balanceReads(second.chains.ethereum!, true);
    balanceReads(second.chains.bsc!);
    // Before any cycle or run of the new process: the persisted age still counts.
    expect(healthz(second.daemon.status())).toMatchObject({
      code: 503,
      body: {status: "stale", reconcile: {stale: true, blockedSince: new Date(T0).toISOString(), blockedForSec: 220}},
    });
    expect(renderMetrics(second.daemon.status())).toContain("\nsahara_monitor_reconcile_blocked_seconds 220\n");
    for (const name of ["ethereum", "bsc"]) await second.daemon.cycle(name);
    await second.daemon.healthTick();
    expect(about(second, STALE_KEY)).toEqual([]);
    expect(openKeys(second)).toContain(`high:${STALE_KEY}`);
    expect(await second.daemon.heartbeat()).toBe(false);
    const started = second.sink.messages.find((message) => message.alert.rule === "health.started")!.alert;
    const field = started.fields!.at(-1)!;
    expect(field.label).toBe("Reconciliation");
    expect(field.value.split("\n")).toEqual([
      "Blocked for 3m since 2026-10-28 00:30:00 UTC (limit 3m) at the start, still counted until a run completes",
      expect.stringMatching(/^ethereum unreachable: balance reads at block \d+ failed: /),
    ]);

    // 541 s after the first blocked run, not after the restart.
    await runUntil(second, 540_000, 60);
    expect(about(second, STALE_KEY)).toEqual([]);
    await runUntil(second, 570_000, 60);
    expect(about(second, STALE_KEY)).toEqual([`firing:critical:${STALE_KEY}`]);

    reads.fail = false;
    await runUntil(second, 600_000, 60);
    expect(about(second, STALE_KEY)).toEqual([`firing:critical:${STALE_KEY}`, `resolved:critical:${STALE_KEY}`]);
    expect(healthz(second.daemon.status()).code).toBe(200);
    expect(await second.daemon.heartbeat()).toBe(true);
  });

  it("pages nothing from an age carried over a restart before a run of the new process", async () => {
    // Defaults (intervalSec 300, staleAfterSec 900): one blocked run, never paged, then a stop longer than the limit
    // (and than 3 × it). The first health tick (30 s after the start) comes before the catch-up and the first run.
    for (const downtimeMin of [20, 50]) {
      const restart = await restartAfterOneBlockedRun(downtimeMin);
      const {second} = restart;
      await restart.tick();
      expect(about(second, STALE_KEY), `${downtimeMin} min`).toEqual([]);
      // The carried age still counts where no message is sent.
      const blockedForSec = 100 + downtimeMin * 60 + 30;
      expect(healthz(second.daemon.status())).toMatchObject({
        code: 503,
        body: {reconcile: {stale: true, blockedSince: new Date(T0).toISOString(), blockedForSec}},
      });
      for (const name of ["ethereum", "bsc"]) expect(await second.daemon.cycle(name)).toBe(true);
      expect(await second.daemon.heartbeat()).toBe(false);

      // The RPC was fixed during the stop: the first run completes, and nothing was ever open.
      restart.blocked = false;
      expect((await second.daemon.runReconcile())?.status).toBe("ok");
      await second.daemon.healthTick();
      expect(about(second, STALE_KEY), `${downtimeMin} min`).toEqual([]);
      expect(healthz(second.daemon.status()).code).toBe(200);
      expect(await second.daemon.heartbeat()).toBe(true);
      await second.daemon.stop();
    }
  });

  it("pages a carried age once the first run after a restart is blocked; an open condition waits too", async () => {
    // Past 3 × the limit (3130 s > 2700 s): critical straight from the first run, still nothing before it.
    const long = await restartAfterOneBlockedRun(50);
    await long.tick();
    for (const name of ["ethereum", "bsc"]) await long.second.daemon.cycle(name);
    expect(about(long.second, STALE_KEY)).toEqual([]);
    await long.second.daemon.runReconcile();
    expect(about(long.second, STALE_KEY)).toEqual([`firing:critical:${STALE_KEY}`]);
    await long.second.daemon.stop();

    const restart = await restartAfterOneBlockedRun(20);
    const {second, clock, options} = restart;
    await restart.tick();
    expect(about(second, STALE_KEY)).toEqual([]);
    for (const name of ["ethereum", "bsc"]) await second.daemon.cycle(name);
    // A fresh blocked run: the age carried over the stop (1330 s > 900 s) pages at once, as fresh failed reads do.
    await second.daemon.runReconcile();
    expect(about(second, STALE_KEY)).toEqual([`firing:high:${STALE_KEY}`]);
    await second.daemon.stop();

    // Open (high) at a second stop of 30 min: past 3 × the limit, but not escalated (nor resolved) before a fresh run.
    clock.now += 30 * 60_000;
    const third = testDaemon(options);
    await third.daemon.start();
    clock.now += HEALTH_INTERVAL_MS;
    expect(third.timers.fire(HEALTH_INTERVAL_MS)).toBe(1);
    await settle();
    expect(about(third, STALE_KEY)).toEqual([]);
    expect(openKeys(third)).toContain(`high:${STALE_KEY}`);
    expect(healthz(third.daemon.status()).code).toBe(503);
    for (const name of ["ethereum", "bsc"]) await third.daemon.cycle(name);
    restart.blocked = false;
    await third.daemon.runReconcile();
    expect(about(third, STALE_KEY)).toEqual([`resolved:high:${STALE_KEY}`]);
    await third.daemon.stop();
  });

  it("forgets the blocked age and drops the condition, without RESOLVED, once reconciliation is disabled", async () => {
    const store = seeded();
    const clock = {now: T0};
    const enabled = daemonConfig({reconciliation: {enabled: true, intervalSec: 60}});
    const first = testDaemon({config: enabled, store, clock, eventRules: [fillingCcipRule()]});
    balanceReads(first.chains.ethereum!, true);
    balanceReads(first.chains.bsc!);
    await firstRun(first);
    await runUntil(first, 210_000, 60);
    expect(openKeys(first)).toContain(`high:${STALE_KEY}`);
    await first.daemon.stop();

    const second = testDaemon({
      config: daemonConfig({reconciliation: {enabled: false}, alerts: {heartbeatUrl: HEARTBEAT}}),
      store,
      clock,
      heads: {ethereum: first.chains.ethereum!.head as bigint, bsc: first.chains.bsc!.head as bigint},
      fetch: vi.fn(async () => new Response("ok")),
    });
    expect(openKeys(second)).not.toContain(`high:${STALE_KEY}`);
    expect(store.get<HealthState>(HEALTH_NAMESPACE, {}).reconcile).toBeUndefined();
    expect(second.daemon.status().reconcileHealth).toBeUndefined();
    expect(healthz(second.daemon.status()).code).toBe(200);
    expect(healthz(second.daemon.status()).body).not.toHaveProperty("reconcile");
    for (const name of ["ethereum", "bsc"]) await second.daemon.cycle(name);
    await second.daemon.healthTick();
    expect(about(second, STALE_KEY)).toEqual([]);
    const started = second.sink.messages.find((message) => message.alert.rule === "health.started")!.alert;
    expect(started.fields!.map((field) => field.label)).not.toContain("Reconciliation");
    expect(started.fields!.at(-1)!.value.split("\n")).toEqual([
      expect.stringMatching(/^WARNING: Reconciliation incomplete: ethereum unreachable: /),
      "HIGH: Reconciliation blocked for 3m: R − I not verified",
    ]);
    expect(await second.daemon.heartbeat()).toBe(true);
  });

  it("drops a condition open without a persisted blocked age (older state file) rather than resolve it", async () => {
    const store = createStore();
    const reminderSec = daemonConfig().alerts.reminderSec;
    const seed = new AlertManager({sinks: [new CaptureSink()], store, reminderSec, log: silentLogger, now: () => T0});
    seed.emit({key: STALE_KEY, kind: "condition", severity: "critical", rule: "health.reconcile-stale", title: "x"});
    await seed.flush();
    const t = testDaemon({
      config: daemonConfig({reconciliation: {enabled: true}}),
      store,
      reconcile: async () => report(),
    });
    expect(openKeys(t)).toEqual([]);
    await t.daemon.healthTick();
    for (const name of ["ethereum", "bsc"]) await t.daemon.cycle(name);
    await t.daemon.runReconcile();
    expect(about(t, STALE_KEY)).toEqual([]);
    const started = t.sink.messages.find((message) => message.alert.rule === "health.started")!.alert;
    expect(started.fields!.at(-1)!.value).toBe("CRITICAL: x");
  });
});
