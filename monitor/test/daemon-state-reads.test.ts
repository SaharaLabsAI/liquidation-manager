// Failed state reads in the daemon: tracked per chain and rule in `daemon:${chain}`.reads, the read-failed condition
// escalated by their age, the chain stale for /healthz, the heartbeat and /metrics once they last longer than
// staleAfterSec, and all of it carried over a restart. Codex repro: owner()/paused() failing for 600 s with
// staleAfterSec 60 stayed a warning, /healthz 200 and the heartbeat kept going.
import {describe, expect, it, vi} from "vitest";

import {daemonNamespace, readChainState} from "../src/daemon.ts";
import {healthz, renderMetrics} from "../src/health.ts";
import type {ReconcileReport} from "../src/rules/reconcile.ts";
import {tokenStateRule} from "../src/rules/state.ts";
import {createStore} from "../src/store.ts";
import type {StateRule} from "../src/types.ts";
import {addr} from "./helpers/chain-fakes.ts";
import {condition, daemonConfig, spyStateRule, T0, testDaemon, type FakeChain} from "./helpers/daemon-fakes.ts";

const POLL_MS = 10_000;
const KEY = "ethereum:state-token:read-failed";
const HEARTBEAT = "https://hc-ping.example.com/abcdefgh";

/** The token's owner() and paused() fail (an eth_call rate limit) while `reads.fail`; else owner 0x…99, not paused. */
function tokenReads(fake: FakeChain): {fail: boolean} {
  const reads = {fail: true};
  Object.assign(fake.client, {
    async readContract({functionName}: {functionName: string}) {
      if (reads.fail) throw new Error("HTTP request failed: 429 Too Many Requests");
      return functionName === "owner" ? addr(0x99) : false;
    },
  });
  return reads;
}

/** One cycle `ms` later at the next head (the scan keeps working). */
async function next(t: ReturnType<typeof testDaemon>, ms: number): Promise<void> {
  t.clock.now += ms;
  t.chains.ethereum!.head = (t.chains.ethereum!.head as bigint) + 1n;
  expect(await t.daemon.cycle("ethereum")).toBe(true);
}

const about = (t: ReturnType<typeof testDaemon>, key: string) => t.sink.summary.filter((line) => line.endsWith(key));

/** `state-token` reads failing since T0: both of its reads (of the token at 0x…10). */
const failingSinceT0 = {
  failingSince: T0,
  failing: {[`${addr(0x10)}.owner()`]: T0, [`${addr(0x10)}.paused()`]: T0},
};

describe("failed state reads", () => {
  it("escalate after staleAfterSec and 3 × staleAfterSec and make the chain stale while the scan works", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const t = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}, alerts: {heartbeatUrl: HEARTBEAT}}),
      stateRules: [tokenStateRule],
      fetch,
    });
    const reads = tokenReads(t.chains.ethereum!);
    await t.daemon.cycle("ethereum");
    expect(about(t, KEY)).toEqual([`firing:warning:${KEY}`]);
    expect(await t.daemon.heartbeat()).toBe(true);

    // staleAfterSec is 60: still a warning and healthy at 60 s.
    for (let i = 0; i < 6; i++) await next(t, POLL_MS);
    expect(about(t, KEY)).toEqual([`firing:warning:${KEY}`]);
    expect(healthz(t.daemon.status()).code).toBe(200);
    expect(await t.daemon.heartbeat()).toBe(true);

    await next(t, 1_000);
    expect(about(t, KEY)).toEqual([`firing:warning:${KEY}`, `firing:high:${KEY}`]);
    const high = t.sink.messages.at(-1)!.alert;
    expect(high.fields?.find((field) => field.label === "Failed reads")?.value).toMatch(/owner\(\)\n.*paused\(\)/);
    expect(high.fields).toContainEqual({label: "Failing for", value: "1m since 2026-10-28 00:30:00 UTC (limit 1m)"});
    expect(high.note).toContain("LiquidityManager.pauseRecall()");
    expect(healthz(t.daemon.status())).toMatchObject({
      code: 503,
      body: {status: "stale", chains: {ethereum: {stale: false, readsStale: true, readsFailingForSec: 61}}},
    });
    expect(renderMetrics(t.daemon.status())).toContain('sahara_monitor_chain_state_reads_stale{chain="ethereum"} 1');
    expect(await t.daemon.heartbeat()).toBe(false);

    // High up to 180 s, critical after.
    while (t.clock.now - T0 < 180_000) await next(t, Math.min(POLL_MS, 180_000 - (t.clock.now - T0)));
    expect(about(t, KEY)).toHaveLength(2);
    await next(t, 1_000);
    expect(about(t, KEY)).toEqual([`firing:warning:${KEY}`, `firing:high:${KEY}`, `firing:critical:${KEY}`]);

    // Up to 600 s: stays critical (no reminder due yet), stale, no heartbeat; the scan itself never went stale.
    while (t.clock.now - T0 < 600_000) await next(t, POLL_MS);
    expect(about(t, KEY)).toHaveLength(3);
    expect(healthz(t.daemon.status()).code).toBe(503);
    expect(await t.daemon.heartbeat()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(t.sink.summary.filter((line) => line.includes("stale-telemetry"))).toEqual([]);
    expect(readChainState(t.store, "ethereum").reads).toEqual({"state-token": failingSinceT0});

    reads.fail = false;
    await next(t, POLL_MS);
    expect(about(t, KEY)).toEqual([
      `firing:warning:${KEY}`,
      `firing:high:${KEY}`,
      `firing:critical:${KEY}`,
      `resolved:critical:${KEY}`,
    ]);
    expect(healthz(t.daemon.status())).toMatchObject({
      code: 200,
      body: {chains: {ethereum: {readsStale: false, readsFailingForSec: 0, failingReads: {}}}},
    });
    expect(await t.daemon.heartbeat()).toBe(true);
    expect(readChainState(t.store, "ethereum").reads).toEqual({"state-token": {okAt: t.clock.now}});
  });

  it("hold back the warning for a failure shorter than alerts.transientFailureGraceSec", async () => {
    const t = testDaemon({
      config: daemonConfig({chains: {ethereum: {staleAfterSec: 180}}, alerts: {transientFailureGraceSec: 60}}),
      stateRules: [tokenStateRule],
    });
    const reads = tokenReads(t.chains.ethereum!);
    // An RPC blip of 50 s: tracked for /healthz, never sent, so nothing to resolve either.
    await t.daemon.cycle("ethereum");
    for (let i = 0; i < 5; i++) await next(t, POLL_MS);
    expect(readChainState(t.store, "ethereum").reads?.["state-token"]?.failingSince).toBe(T0);
    reads.fail = false;
    await next(t, POLL_MS);
    expect(about(t, KEY)).toEqual([]);

    // A failure that lasts: the warning once it has failed for 60 s, then the usual escalation at staleAfterSec.
    reads.fail = true;
    const since = t.clock.now + POLL_MS;
    while (t.clock.now - since < 50_000) await next(t, POLL_MS);
    expect(about(t, KEY)).toEqual([]);
    await next(t, POLL_MS);
    expect(about(t, KEY)).toEqual([`firing:warning:${KEY}`]);
    while (t.clock.now - since <= 180_000) await next(t, POLL_MS);
    expect(about(t, KEY)).toEqual([`firing:warning:${KEY}`, `firing:high:${KEY}`]);
    reads.fail = false;
    await next(t, POLL_MS);
    expect(about(t, KEY)).toEqual([`firing:warning:${KEY}`, `firing:high:${KEY}`, `resolved:high:${KEY}`]);
  });

  it("keep counting across a restart: stale before any check, no message, critical from the 1st failure", async () => {
    const store = createStore();
    const config = daemonConfig({chains: {ethereum: {}}, alerts: {heartbeatUrl: HEARTBEAT}});
    const clock = {now: T0};
    const fetch = vi.fn(async () => new Response("ok"));
    const first = testDaemon({config, store, clock, stateRules: [tokenStateRule], fetch});
    tokenReads(first.chains.ethereum!);
    await first.daemon.cycle("ethereum");
    await next(first, 61_000);
    expect(about(first, KEY)).toEqual([`firing:warning:${KEY}`, `firing:high:${KEY}`]);
    await first.daemon.stop();
    expect(readChainState(store, "ethereum").reads).toEqual({"state-token": failingSinceT0});

    clock.now += 5_000;
    const second = testDaemon({config, store, clock, stateRules: [tokenStateRule], fetch, heads: {ethereum: 101n}});
    const reads = tokenReads(second.chains.ethereum!);
    // Before any cycle of the new process: the persisted failure still counts.
    expect(healthz(second.daemon.status())).toMatchObject({
      code: 503,
      body: {status: "stale", chains: {ethereum: {readsStale: true, readsFailingForSec: 66}}},
    });
    await second.daemon.cycle("ethereum");
    expect(about(second, KEY)).toEqual([]);
    expect(second.daemon.alerter.openConditions().map((open) => `${open.alert.severity}:${open.alert.key}`)).toEqual([
      `high:${KEY}`,
    ]);
    expect(await second.daemon.heartbeat()).toBe(false);

    // 181 s after the first failure, not after the restart.
    await next(second, T0 + 181_000 - clock.now);
    expect(about(second, KEY)).toEqual([`firing:critical:${KEY}`]);

    reads.fail = false;
    await next(second, POLL_MS);
    expect(about(second, KEY)).toEqual([`firing:critical:${KEY}`, `resolved:critical:${KEY}`]);
    expect(await second.daemon.heartbeat()).toBe(true);
  });

  it("are tracked per read: different reads failing on alternate checks are each verified within a poll", async () => {
    // Codex repro: owner() failed on even checks and paused() on odd ones, so the rule never had a check without a
    // failure: critical after 180 s, /healthz 503 and no heartbeat, although no value was more than 10 s old.
    const fetch = vi.fn(async () => new Response("ok"));
    const t = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}, alerts: {heartbeatUrl: HEARTBEAT}}),
      stateRules: [tokenStateRule],
      fetch,
    });
    let check = 0;
    Object.assign(t.chains.ethereum!.client, {
      async readContract({functionName}: {functionName: string}) {
        if (functionName === (check % 2 === 0 ? "owner" : "paused")) throw new Error("HTTP request failed: 429");
        return functionName === "owner" ? addr(0x99) : false;
      },
    });
    await t.daemon.cycle("ethereum");
    for (let i = 0; i < 30; i++) {
      check++;
      await next(t, POLL_MS);
    }
    expect(about(t, KEY)).toEqual([`firing:warning:${KEY}`]);
    expect(healthz(t.daemon.status())).toMatchObject({code: 200, body: {chains: {ethereum: {readsFailingForSec: 0}}}});
    expect(await t.daemon.heartbeat()).toBe(true);
    const reads = readChainState(t.store, "ethereum").reads?.["state-token"];
    expect(reads?.failingSince).toBe(t.clock.now);
    expect(Object.keys(reads?.failing ?? {})).toEqual([expect.stringMatching(/\.owner\(\)$/)]);
  });

  it("keep a read that was not made counting: one only made when another succeeded still escalates", async () => {
    // A rule reads gate(), and gated(gate) only with its result: gate() and gated(gate) fail on alternate checks.
    let check = 0;
    const rule: StateRule = {
      id: "state-gated",
      async check(ctx) {
        const reads = check % 2 === 0 ? {ok: [], failed: ["gate()"]} : {ok: ["gate()"], failed: ["gated(gate)"]};
        const alert = condition(ctx.name, "state-gated", "read-failed", {severity: "warning"});
        return {conditions: [alert], snapshot: {}, reads: {...reads, complete: true}};
      },
    };
    const t = testDaemon({config: daemonConfig({chains: {ethereum: {}}}), stateRules: [rule]});
    await t.daemon.cycle("ethereum");
    for (let i = 0; i < 6; i++) {
      check++;
      await next(t, POLL_MS);
    }
    // gate() failed again at 60 s, so gated(gate) was not read: it still counts from its failure at 10 s.
    expect(readChainState(t.store, "ethereum").reads?.["state-gated"]).toEqual({
      failingSince: T0 + 10_000,
      failing: {"gate()": T0 + 60_000, "gated(gate)": T0 + 10_000},
    });
    expect(healthz(t.daemon.status()).code).toBe(200);
    await next(t, 11_000);
    expect(healthz(t.daemon.status())).toMatchObject({
      code: 503,
      body: {chains: {ethereum: {readsStale: true, failingReads: {"state-gated": {forSec: 61}}}}},
    });
    expect(t.sink.summary).toContain("firing:high:ethereum:state-gated:read-failed");
  });

  it("count a state rule that throws as failing reads, without syncing its conditions", async () => {
    let fail = false;
    const flaky = spyStateRule("state-flaky", () => {
      if (fail) throw new Error("boom");
      return [];
    });
    const t = testDaemon({config: daemonConfig({chains: {ethereum: {}}}), stateRules: [flaky]});
    await t.daemon.cycle("ethereum");
    fail = true;
    await next(t, POLL_MS);
    await next(t, 60_000);
    expect(healthz(t.daemon.status()).code).toBe(200);
    await next(t, 1_000);
    expect(healthz(t.daemon.status())).toMatchObject({
      code: 503,
      body: {chains: {ethereum: {readsStale: true, failingReads: {"state-flaky": {forSec: 61}}}}},
    });
    expect(t.daemon.alerter.openConditions()).toEqual([]);
  });

  it("carry a failure persisted before per-read tracking over to the reads still failing", async () => {
    const store = createStore();
    store.set(daemonNamespace("ethereum"), {cursor: 100n, reads: {"state-token": {failingSince: T0 - 120_000}}});
    const t = testDaemon({config: daemonConfig({chains: {ethereum: {}}}), store, stateRules: [tokenStateRule]});
    const reads = tokenReads(t.chains.ethereum!);
    await t.daemon.cycle("ethereum");
    // Both reads are unverified since then at least.
    expect(readChainState(store, "ethereum").reads).toEqual({
      "state-token": {
        failingSince: T0 - 120_000,
        failing: {[`${addr(0x10)}.owner()`]: T0 - 120_000, [`${addr(0x10)}.paused()`]: T0 - 120_000},
      },
    });
    expect(about(t, KEY)).toEqual([`firing:high:${KEY}`]);
    reads.fail = false;
    await next(t, POLL_MS);
    expect(readChainState(store, "ethereum").reads).toEqual({"state-token": {okAt: t.clock.now}});
  });

  it("forget a failure persisted for a rule that is no longer run", async () => {
    const store = createStore();
    store.set(daemonNamespace("ethereum"), {cursor: 100n, reads: {"state-gone": {failingSince: T0 - 3_600_000}}});
    const t = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store,
      stateRules: [spyStateRule("state-spy")],
    });
    expect(healthz(t.daemon.status()).code).toBe(200);
    await t.daemon.cycle("ethereum");
    expect(readChainState(store, "ethereum").reads).toEqual({"state-spy": {okAt: T0}});
  });

  it("do not skip reconciliation: its own reads are fresh or fail on their own", async () => {
    const report = {status: "ok", conditions: []} as unknown as ReconcileReport;
    const reconcile = vi.fn(async () => report);
    const t = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}, reconciliation: {enabled: true}}),
      stateRules: [tokenStateRule],
      reconcile,
    });
    tokenReads(t.chains.ethereum!);
    await t.daemon.cycle("ethereum");
    await next(t, 61_000);
    expect(healthz(t.daemon.status()).code).toBe(503);
    expect(await t.daemon.runReconcile()).toBe(report);
  });
});
