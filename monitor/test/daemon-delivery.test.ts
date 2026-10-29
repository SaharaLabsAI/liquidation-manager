import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {describe, expect, it, vi} from "vitest";

import {ALERTS_NAMESPACE, RETRY_BASE_MS} from "../src/alerts/manager.ts";
import {daemonNamespace, readChainState, STOP_DELIVERY_MS} from "../src/daemon.ts";
import {healthz} from "../src/health.ts";
import type {ReconcileReport} from "../src/rules/reconcile.ts";
import {createStore, deserializeState} from "../src/store.ts";
import {DeliveryError} from "../src/types.ts";
import type {Alert, AlertSink, ChainContext, OutgoingMessage} from "../src/types.ts";
import {daemonConfig, logger, spyEventRule, T0, testDaemon} from "./helpers/daemon-fakes.ts";

/** `count` high events per chunk: `${chain}:spy:${from}`, then `${chain}:spy:${from}:2`, ... */
function chunkEvents(count = 1) {
  return spyEventRule("spy", {
    onLogs: (ctx: ChainContext, _logs, range) => {
      for (let i = 1; i <= count; i++) {
        const key = `${ctx.name}:spy:${range.from}${i > 1 ? `:${i}` : ""}`;
        const alert: Alert = {key, kind: "event", severity: "high", rule: "spy", title: "E"};
        ctx.alerter.emit(alert);
      }
    },
  });
}

function gate(): {promise: Promise<void>; release: () => void} {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return {promise, release};
}

describe("alert delivery across concurrent commits", () => {
  it("re-sends after a crash an alert another loop's save recorded while it was still in delivery", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "monitor-outbox-")), "state.json");
    const config = daemonConfig();
    const seed = createStore(path);
    seed.set(daemonNamespace("ethereum"), {cursor: 100n});
    seed.set(daemonNamespace("bsc"), {cursor: 100n});
    seed.save();

    const first = testDaemon({config, store: createStore(path), eventRules: [chunkEvents()]});
    await first.daemon.cycle("ethereum");
    await first.daemon.cycle("bsc");
    expect(first.sink.summary).toHaveLength(1); // the startup message

    // A (ethereum) and B (bsc) are both held by the sink; bsc's cycle waits until A is in delivery.
    const a = gate();
    const b = gate();
    const rpc = gate();
    first.sink.holds.set("ethereum:spy:101", a.promise);
    first.sink.holds.set("bsc:spy:101", b.promise);
    first.chains.ethereum!.head = 101n;
    first.chains.bsc!.head = 101n;
    first.chains.bsc!.gate = rpc.promise;
    const ethereum = first.daemon.cycle("ethereum");
    void first.daemon.cycle("bsc");
    await vi.waitFor(() => expect(first.order).toContain("send:ethereum:spy:101"));
    first.chains.bsc!.gate = undefined;
    rpc.release();
    // bsc scanned 101, queued B and its commit flushed it behind A.
    await vi.waitFor(() => expect(readChainState(first.store, "bsc").cursor).toBe(101n));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(first.daemon.alerter.pending).toBe(0);

    // Ethereum's cycle does not wait for A. A is delivered and saved, while B is still in flight. Then the process
    // dies.
    await ethereum;
    a.release();
    await vi.waitFor(() => expect(first.sink.summary.slice(1)).toEqual(["firing:high:ethereum:spy:101"]));
    // The save recorded bsc's progress and B as sent, and keeps B (and only B) in the outbox.
    const saved = deserializeState(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
    expect(saved[daemonNamespace("bsc")]).toEqual({cursor: 101n});
    expect(saved[ALERTS_NAMESPACE]).toMatchObject({
      sent: {"ethereum:spy:101": expect.any(Number), "bsc:spy:101": expect.any(Number)},
      queue: [],
      outbox: [{message: {alert: {key: "bsc:spy:101"}, status: "firing"}, targets: ["capture:capture"]}],
    });

    const second = testDaemon({config, store: createStore(path), eventRules: [chunkEvents()]});
    second.chains.ethereum!.head = 101n;
    second.chains.bsc!.head = 101n;
    await second.daemon.cycle("ethereum");
    await second.daemon.cycle("bsc");
    await second.delivered();
    const spy = second.sink.summary.filter((line) => line.includes(":spy:"));
    expect(spy).toEqual(["firing:high:bsc:spy:101"]);
  });

  it("saves each delivery at once, so a crash during a slow burst re-sends only what was not delivered", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "monitor-outbox-")), "state.json");
    const config = daemonConfig({chains: {ethereum: {}}});
    const seed = createStore(path);
    seed.set(daemonNamespace("ethereum"), {cursor: 100n});
    seed.save();

    const first = testDaemon({config, store: createStore(path), eventRules: [chunkEvents(3)]});
    await first.daemon.cycle("ethereum");
    // The second message of the burst hangs (e.g. Telegram retrying): its commit cannot finish.
    first.sink.holds.set("ethereum:spy:101:2", new Promise(() => {}));
    first.chains.ethereum!.head = 101n;
    void first.daemon.cycle("ethereum");
    await vi.waitFor(() => expect(first.order).toContain("send:ethereum:spy:101:2"));
    expect(first.sink.summary.slice(1)).toEqual(["firing:high:ethereum:spy:101"]);

    const saved = deserializeState(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
    const outbox = saved[ALERTS_NAMESPACE]?.outbox as Array<{message: {alert: {key: string}}}>;
    expect(outbox.map((entry) => entry.message.alert.key)).toEqual(["ethereum:spy:101:2", "ethereum:spy:101:3"]);

    const second = testDaemon({config, store: createStore(path), eventRules: [chunkEvents(3)]});
    second.chains.ethereum!.head = 101n;
    await second.daemon.cycle("ethereum");
    await second.delivered();
    expect(second.sink.summary.filter((line) => line.includes(":spy:"))).toEqual([
      "firing:high:ethereum:spy:101:2",
      "firing:high:ethereum:spy:101:3",
    ]);
  });
});

/** The state file as saved. */
function savedState(path: string): Record<string, Record<string, unknown>> {
  return deserializeState(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
}

function stateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "monitor-outage-")), "state.json");
}

/** A Telegram-like sink with two routes whose sends never complete (a request that never answers). */
function hangingSink(sent: string[]): AlertSink {
  return {
    name: "telegram",
    targets: ["-100channel", "-100oncall"],
    admits: (message: OutgoingMessage, target: string) => target === "-100channel" || message.alert.severity !== "info",
    send: (message: OutgoingMessage, target: string) => {
      sent.push(`${target}:${message.alert.key}`);
      return new Promise<void>(() => {});
    },
  };
}

describe("a Telegram outage", () => {
  it("never holds up the chain loops, saves, reconciliation or the health timer", async () => {
    const path = stateFile();
    const config = daemonConfig({chains: {ethereum: {}}, reconciliation: {enabled: true, intervalSec: 60}});
    const seed = createStore(path);
    seed.set(daemonNamespace("ethereum"), {cursor: 100n});
    seed.save();
    const report = {status: "ok", conditions: [], R: 1n, I: 0n} as unknown as ReconcileReport;
    const reconciled: number[] = [];
    const sent: string[] = [];
    const {daemon, chains, clock} = testDaemon({
      config,
      store: createStore(path),
      eventRules: [chunkEvents()],
      sinks: [hangingSink(sent)],
      reconcile: async () => {
        reconciled.push(clock.now);
        return report;
      },
    });
    for (let head = 101n; head <= 105n; head++) {
      chains.ethereum!.head = head;
      clock.now += 10_000;
      expect(await daemon.cycle("ethereum")).toBe(true);
      // The cursor advances and is saved although no alert has been delivered.
      expect(savedState(path)[daemonNamespace("ethereum")]).toEqual({cursor: head});
      await daemon.healthTick();
      expect(await daemon.runReconcile()).toBe(report);
    }
    expect(reconciled).toHaveLength(5);
    // One send in flight per route (hung), the rest waiting in the saved outbox.
    expect(sent).toEqual([`-100channel:global:health:started:${T0}`, "-100oncall:ethereum:spy:101"]);
    const outbox = savedState(path)[ALERTS_NAMESPACE]?.outbox as Array<{message: OutgoingMessage}>;
    expect(outbox.map((entry) => entry.message.alert.key)).toEqual([
      `global:health:started:${T0}`,
      "ethereum:spy:101",
      "ethereum:spy:102",
      "ethereum:spy:103",
      "ethereum:spy:104",
      "ethereum:spy:105",
    ]);
    const status = daemon.status();
    expect(status.deliveries.telegram?.targets["-100oncall"]).toMatchObject({
      undelivered: 5,
      oldestUndeliveredAt: T0 + 10_000,
    });
    expect(healthz({...status, now: clock.now}).body.deliveries).toMatchObject({
      telegram: {targets: {"-100channel": {outboxMessages: 6, outboxOldestAgeSec: 40}}},
    });
  });

  it("keeps the heartbeat withheld and /healthz 503 after a restart until the kept alert is delivered", async () => {
    const path = stateFile();
    const url = "https://hc-ping.example.com/outage-check";
    const config = daemonConfig({chains: {ethereum: {}}, alerts: {heartbeatUrl: url}});
    const seed = createStore(path);
    seed.set(daemonNamespace("ethereum"), {cursor: 100n});
    seed.save();
    const fetch = vi.fn(async () => new Response("ok"));

    const first = testDaemon({config, store: createStore(path), eventRules: [chunkEvents()], fetch});
    const badGateway = "sendMessage to chat -100 failed after 3 attempts: 502 Bad Gateway";
    first.sink.failWith = new DeliveryError(badGateway, "transient");
    first.chains.ethereum!.head = 101n;
    await first.daemon.cycle("ethereum");
    await first.delivered();
    expect(await first.daemon.heartbeat()).toBe(false);
    expect(first.sink.messages).toEqual([]);
    // The failure (of its oldest message, the startup one) is saved with the outbox: the process can die now.
    expect(savedState(path)[ALERTS_NAMESPACE]?.targets).toEqual({
      "capture:capture": {failing: expect.objectContaining({kind: "transient", severity: "info", since: T0})},
    });

    // Restarted while Telegram is still down: failing from the start, before any attempt.
    const log = logger();
    const second = testDaemon({
      config,
      store: createStore(path),
      eventRules: [chunkEvents()],
      fetch,
      log,
      clock: {now: T0 + 60_000},
    });
    second.sink.failWith = new DeliveryError("connect ECONNREFUSED", "transient");
    expect(healthz(second.daemon.status())).toMatchObject({code: 503, body: {status: "delivery-failing"}});
    second.chains.ethereum!.head = 101n;
    await second.daemon.cycle("ethereum");
    await second.delivered();
    expect(await second.daemon.heartbeat()).toBe(false);
    expect(healthz(second.daemon.status())).toMatchObject({
      code: 503,
      body: {deliveries: {capture: {failing: true, targets: {capture: {failing: true, outboxMessages: 3}}}}},
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(log.lines.map((line) => line.message)).toContain(
      "alert delivery was failing before the last shutdown, and counts as failing until it delivers",
    );

    // Telegram is back: the retry delivers everything in order, and the heartbeat resumes.
    second.sink.failWith = undefined;
    expect(second.timers.fire(RETRY_BASE_MS)).toBe(1);
    await second.delivered();
    expect(second.sink.summary).toEqual([
      `firing:info:global:health:started:${T0}`,
      "firing:high:ethereum:spy:101",
      `firing:info:global:health:started:${T0 + 60_000}`,
    ]);
    expect(await second.daemon.heartbeat()).toBe(true);
    expect(healthz(second.daemon.status()).code).toBe(200);
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({method: "GET"}));
  });

  it("stops within STOP_DELIVERY_MS while a send hangs, saving what is left for the next start", async () => {
    const path = stateFile();
    const config = daemonConfig({chains: {ethereum: {}}});
    const seed = createStore(path);
    seed.set(daemonNamespace("ethereum"), {cursor: 100n});
    seed.save();
    const sent: string[] = [];
    const {daemon, chains, timers} = testDaemon({
      config,
      store: createStore(path),
      eventRules: [chunkEvents()],
      sinks: [hangingSink(sent)],
    });
    chains.ethereum!.head = 101n;
    await daemon.cycle("ethereum");
    let stopped = false;
    const stopping = daemon.stop().then(() => (stopped = true));
    await vi.waitFor(() => expect(timers.delays).toEqual([STOP_DELIVERY_MS]));
    expect(stopped).toBe(false);
    expect(timers.fire(STOP_DELIVERY_MS)).toBe(1);
    await stopping;
    expect(timers.pending.size).toBe(0);
    const outbox = savedState(path)[ALERTS_NAMESPACE]?.outbox as Array<{message: OutgoingMessage; targets: string[]}>;
    expect(outbox.map((entry) => [entry.message.alert.key, entry.targets])).toEqual([
      [`global:health:started:${T0}`, ["telegram:-100channel"]],
      ["ethereum:spy:101", ["telegram:-100channel", "telegram:-100oncall"]],
    ]);
  });

  it("stops at once while targets wait for a retry, cancelling it", async () => {
    const {daemon, chains, sink, timers, delivered} = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      eventRules: [chunkEvents()],
    });
    sink.fail = true;
    await daemon.cycle("ethereum");
    chains.ethereum!.head = 101n;
    await daemon.cycle("ethereum");
    await delivered();
    expect(timers.delays).toContain(RETRY_BASE_MS);
    await daemon.stop();
    expect(timers.pending.size).toBe(0);
    // The startup message and the alerts of blocks 100 and 101, kept for the next start.
    expect(daemon.status().deliveries.capture?.targets.capture).toMatchObject({undelivered: 3});
  });
});
