import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {describe, expect, it, vi} from "vitest";

import {
  ALERTS_NAMESPACE,
  AlertManager,
  DIGEST_THRESHOLD,
  EVENT_DEDUPE_MS,
  MAX_UNCLASSIFIED_ATTEMPTS,
  RETRY_AFTER_MAX_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  type OpenCondition,
} from "../src/alerts/manager.ts";
import {ConsoleSink} from "../src/alerts/console.ts";
import {renderTelegramChunks, TelegramSink, type FetchLike} from "../src/alerts/telegram.ts";
import type {Logger} from "../src/log.ts";
import {silentLogger} from "../src/log.ts";
import {createStore, type Store} from "../src/store.ts";
import {DeliveryError} from "../src/types.ts";
import type {Alert, AlertSink, OutgoingMessage, Severity} from "../src/types.ts";
import {ClockTimers, flushPromises, logger} from "./helpers/daemon-fakes.ts";

const REMINDERS = {critical: 3600, high: 4 * 3600, warning: 12 * 3600, info: 0};
const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);

class CaptureSink implements AlertSink {
  readonly name: string;
  readonly messages: OutgoingMessage[] = [];

  constructor(name = "capture") {
    this.name = name;
  }

  async send(message: OutgoingMessage): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}

function setup(
  options: {
    store?: Store;
    log?: Logger;
    sinks?: AlertSink[];
    clock?: {now: number};
    afterDelivery?: () => void;
  } = {},
) {
  const clock = options.clock ?? {now: T0};
  const sink = new CaptureSink();
  const store = options.store ?? createStore();
  const timers = new ClockTimers(clock);
  const manager = new AlertManager({
    sinks: options.sinks ?? [sink],
    store,
    reminderSec: REMINDERS,
    log: options.log ?? silentLogger,
    now: () => clock.now,
    timers,
    afterDelivery: options.afterDelivery,
  });
  return {manager, sink, store, clock, timers};
}

/** Flushes and waits until no send is in progress (what an awaited `flush()` did before background delivery). */
async function deliver(manager: AlertManager): Promise<void> {
  manager.flush();
  await manager.drain(60_000);
}

function condition(key: string, severity: Severity = "critical", extra: Partial<Alert> = {}): Alert {
  return {key, kind: "condition", severity, rule: "state-test", chain: "ethereum", title: `Condition ${key}`, ...extra};
}

function event(key: string, severity: Severity = "high", extra: Partial<Alert> = {}): Alert {
  return {key, kind: "event", severity, rule: "manager", chain: "ethereum", title: `Event ${key}`, ...extra};
}

function capturingLogger() {
  const warn = vi.fn();
  const error = vi.fn();
  const log: Logger = {...silentLogger, warn, error, child: () => log};
  return {log, warn, error};
}

const summary = (messages: OutgoingMessage[]) => messages.map((m) => `${m.status}:${m.alert.severity}:${m.alert.key}`);

interface StoredAlerts {
  queue: OutgoingMessage[];
  outbox: Array<{message: OutgoingMessage; targets: string[]; at: number; sent?: Record<string, number>}>;
  targets: Record<string, {failing?: unknown; retryAt?: number}>;
}

const stored = (store: Store) => store.get<StoredAlerts>(ALERTS_NAMESPACE, {queue: [], outbox: [], targets: {}});

describe("AlertManager events", () => {
  it("sends an event once per key, also after a restart on the same store, until 7 days pass", async () => {
    const {manager, sink, store, clock} = setup();
    manager.emit(event("ethereum:manager:0xaa:1"));
    manager.emit(event("ethereum:manager:0xaa:1"));
    await deliver(manager);
    expect(summary(sink.messages)).toEqual(["firing:high:ethereum:manager:0xaa:1"]);

    const restarted = setup({store, clock});
    restarted.manager.emit(event("ethereum:manager:0xaa:1"));
    await deliver(restarted.manager);
    expect(restarted.sink.messages).toEqual([]);

    clock.now += EVENT_DEDUPE_MS + 1000;
    restarted.manager.tick();
    restarted.manager.emit(event("ethereum:manager:0xaa:1"));
    await deliver(restarted.manager);
    expect(restarted.sink.messages).toHaveLength(1);
  });
});

describe("AlertManager conditions", () => {
  it("opens, holds silently, re-fires on severity changes and resolves with the open duration", async () => {
    const {manager, sink, clock} = setup();
    manager.emit(condition("ethereum:state-test:a", "warning"));
    await deliver(manager);
    clock.now += 60_000;
    manager.emit(condition("ethereum:state-test:a", "warning"));
    await deliver(manager);
    expect(summary(sink.messages)).toEqual(["firing:warning:ethereum:state-test:a"]);

    clock.now += 60_000;
    manager.emit(condition("ethereum:state-test:a", "critical"));
    clock.now += 60_000;
    manager.emit(condition("ethereum:state-test:a", "high"));
    await deliver(manager);
    expect(summary(sink.messages.slice(1))).toEqual([
      "firing:critical:ethereum:state-test:a",
      "firing:high:ethereum:state-test:a",
    ]);
    // The downgrade still reaches the routes the critical message reached.
    expect(sink.messages.map((m) => m.routeSeverity)).toEqual([undefined, undefined, "critical"]);
    expect(manager.openConditions()).toEqual([
      {
        alert: condition("ethereum:state-test:a", "high"),
        openedAt: T0,
        lastSentAt: T0 + 180_000,
        peakSeverity: "critical",
      },
    ]);

    clock.now += 60_000;
    manager.sync("ethereum:state-test:", []);
    manager.resolve("ethereum:state-test:a"); // already resolved: no second message
    await deliver(manager);
    const resolved = sink.messages.at(-1);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.alert.severity).toBe("high");
    expect(resolved?.routeSeverity).toBe("critical");
    expect(resolved?.openForSec).toBe(240);
    expect(manager.openConditions()).toEqual([]);
    expect(sink.messages).toHaveLength(4);
  });

  it("keeps the latest content of a held condition for reminders and the resolved message", async () => {
    const {manager, sink, clock} = setup();
    const fields = (value: string) => ({fields: [{label: "Balance", value}]});
    manager.emit(condition("ethereum:state-test:a", "critical", fields("100 SAHARA")));
    manager.emit(condition("ethereum:state-test:a", "critical", fields("90 SAHARA")));
    clock.now += 3600_000;
    manager.tick();
    await deliver(manager);
    expect(sink.messages.map((m) => m.alert.fields?.[0]?.value)).toEqual(["100 SAHARA", "90 SAHARA"]);
  });

  it("sync opens new conditions, resolves missing ones in scope only, and ignores keys outside the scope", async () => {
    const {log, warn} = capturingLogger();
    const {manager, sink} = setup({log});
    manager.sync("ethereum:state-token:", [condition("ethereum:state-token:owner")]);
    manager.sync("ethereum:state-pool:", [condition("ethereum:state-pool:0x1:owner")]);
    manager.sync("bsc:state-token:", [condition("bsc:state-token:owner")]);
    await deliver(manager);
    expect(sink.messages).toHaveLength(3);

    manager.sync("ethereum:state-token:", [condition("ethereum:state-pool:0x1:router")]);
    await deliver(manager);
    expect(warn).toHaveBeenCalledWith(
      "condition key outside sync scope ignored",
      expect.objectContaining({key: "ethereum:state-pool:0x1:router"}),
    );
    expect(summary(sink.messages.slice(3))).toEqual(["resolved:critical:ethereum:state-token:owner"]);
    expect(manager.openConditions().map((open) => open.alert.key)).toEqual([
      "ethereum:state-pool:0x1:owner",
      "bsc:state-token:owner",
    ]);
  });

  it("sync keeps the most severe copy of a duplicated key instead of flapping", async () => {
    const {manager, sink} = setup();
    const active = [condition("ethereum:x:a", "critical"), condition("ethereum:x:a", "warning")];
    manager.sync("ethereum:x:", active);
    manager.sync("ethereum:x:", active);
    await deliver(manager);
    expect(summary(sink.messages)).toEqual(["firing:critical:ethereum:x:a"]);
  });

  it("sends reminders per severity interval and never when the interval is 0", async () => {
    const {manager, sink, clock} = setup();
    manager.emit(condition("ethereum:x:crit", "critical"));
    manager.emit(condition("ethereum:x:info", "info"));
    await deliver(manager);

    clock.now += 3599_000;
    manager.tick();
    await deliver(manager);
    expect(sink.messages).toHaveLength(2);

    clock.now += 1000;
    manager.tick();
    manager.tick(); // not due again right away
    await deliver(manager);
    expect(summary(sink.messages.slice(2))).toEqual(["reminder:critical:ethereum:x:crit"]);
    expect(sink.messages[2]?.openForSec).toBe(3600);

    clock.now += 3600_000;
    manager.tick();
    await deliver(manager);
    expect(sink.messages.slice(3).map((m) => [m.status, m.openForSec])).toEqual([["reminder", 7200]]);

    clock.now += 100 * 3600_000;
    manager.tick();
    await deliver(manager);
    expect(sink.messages.filter((m) => m.alert.key === "ethereum:x:info")).toHaveLength(1);
  });

  it("restores open conditions after a restart: no re-fire, same reminder schedule and duration", async () => {
    const store = createStore();
    const clock = {now: T0};
    const first = setup({store, clock});
    first.manager.emit(condition("ethereum:x:a", "critical"));
    await deliver(first.manager);

    clock.now += 1800_000;
    const second = setup({store, clock});
    expect(second.manager.openConditions()).toEqual([
      {alert: condition("ethereum:x:a", "critical"), openedAt: T0, lastSentAt: T0, peakSeverity: "critical"},
    ]);
    second.manager.sync("ethereum:x:", [condition("ethereum:x:a", "critical")]);
    second.manager.tick();
    await deliver(second.manager);
    expect(second.sink.messages).toEqual([]);

    clock.now += 1800_000;
    second.manager.tick();
    await deliver(second.manager);
    expect(summary(second.sink.messages)).toEqual(["reminder:critical:ethereum:x:a"]);

    clock.now += 600_000;
    second.manager.sync("ethereum:x:", []);
    await deliver(second.manager);
    expect(second.sink.messages.at(-1)).toMatchObject({status: "resolved", openForSec: 4200});

    const third = setup({store, clock});
    expect(third.manager.openConditions()).toEqual([]);
  });

  it("routes a downgrade and the resolution by the peak severity, also after a restart", async () => {
    const store = createStore();
    const clock = {now: T0};
    const first = setup({store, clock});
    first.manager.emit(condition("ethereum:x:a", "critical"));
    first.manager.emit(condition("ethereum:x:a", "warning"));
    first.manager.emit(condition("ethereum:x:a", "high"));
    await deliver(first.manager);
    expect(first.sink.messages.map((m) => [m.alert.severity, m.routeSeverity])).toEqual([
      ["critical", undefined],
      ["warning", "critical"],
      ["high", "critical"],
    ]);

    // An entry without a valid peakSeverity (older state files): its stored severity is the peak.
    const raw = store.get<{open: Record<string, OpenCondition>}>(ALERTS_NAMESPACE, {open: {}});
    const legacy = {...raw.open["ethereum:x:a"]!, alert: condition("ethereum:x:b", "high"), peakSeverity: 1};
    store.set(ALERTS_NAMESPACE, {...raw, open: {...raw.open, "ethereum:x:b": legacy}});
    const second = setup({store, clock});
    expect(second.manager.openConditions().map((open) => open.peakSeverity)).toEqual(["critical", undefined]);
    // Reminders follow the current severity.
    clock.now += 4 * 3600_000;
    second.manager.tick();
    second.manager.sync("ethereum:x:", []);
    await deliver(second.manager);
    expect(second.sink.messages.map((m) => [m.status, m.alert.key, m.routeSeverity])).toEqual([
      ["reminder", "ethereum:x:a", undefined],
      ["reminder", "ethereum:x:b", undefined],
      ["resolved", "ethereum:x:a", "critical"],
      ["resolved", "ethereum:x:b", undefined],
    ]);
  });

  it("never folds a message routed as critical/high into the digest", async () => {
    const {manager, sink} = setup();
    manager.emit(condition("ethereum:x:down", "critical"));
    await deliver(manager);
    for (let i = 0; i < 25; i++) manager.emit(event(`e:${i}`, "info"));
    manager.emit(condition("ethereum:x:down", "warning"));
    await deliver(manager);
    expect(sink.messages.slice(1).map((m) => (m.alert.rule === "digest" ? "digest" : m.alert.key))).toEqual([
      "digest",
      "ethereum:x:down",
    ]);
  });

  it("drops an open condition without sending anything", async () => {
    const {manager, sink, store} = setup();
    manager.emit(condition("ethereum:x:a"));
    await deliver(manager);
    expect(manager.drop("ethereum:x:a")).toBe(true);
    expect(manager.drop("ethereum:x:a")).toBe(false);
    manager.tick();
    await deliver(manager);
    expect(summary(sink.messages)).toEqual(["firing:critical:ethereum:x:a"]);
    expect(setup({store}).manager.openConditions()).toEqual([]);
  });

  it("persists through store.set without saving, and reads a corrupt namespace as empty", () => {
    const store = createStore();
    const set = vi.spyOn(store, "set");
    const save = vi.spyOn(store, "save");
    const {manager} = setup({store});
    manager.emit(condition("ethereum:x:a"));
    expect(set).toHaveBeenCalledWith(ALERTS_NAMESPACE, expect.anything());
    expect(save).not.toHaveBeenCalled();

    const calls = set.mock.calls.length;
    manager.emit(condition("ethereum:x:a")); // unchanged: the store stays clean
    expect(set.mock.calls.length).toBe(calls);

    store.set(ALERTS_NAMESPACE, {sent: "nope", open: {k: {alert: 1}}});
    expect(setup({store}).manager.openConditions()).toEqual([]);
  });
});

describe("AlertManager delivery", () => {
  it("delivers in order; a target that is down keeps its messages without holding up the others", async () => {
    const {log, warn, error} = capturingLogger();
    const good = new CaptureSink("good");
    const attempts: string[] = [];
    const down: AlertSink = {
      name: "bad",
      send: async (message) => {
        attempts.push(message.alert.key);
        throw new DeliveryError("connect ECONNREFUSED", "transient");
      },
    };
    const {manager, store} = setup({sinks: [down, good], log});
    manager.emit(event("e:1"));
    manager.emit(condition("e:c:1", "warning"));
    manager.emit(event("e:2", "critical"));
    await deliver(manager);
    expect(good.messages.map((m) => m.alert.key)).toEqual(["e:1", "e:c:1", "e:2"]);
    expect(attempts).toEqual(["e:1"]);
    // One failed attempt at its oldest message; the others wait behind it (no attempt yet), all kept.
    expect(manager.stats.bad?.targets.bad).toMatchObject({ok: 0, failed: 0, retries: 1, undelivered: 3});
    expect(stored(store).outbox.map((entry) => [entry.message.alert.key, entry.targets])).toEqual([
      ["e:1", ["bad:bad"]],
      ["e:c:1", ["bad:bad"]],
      ["e:2", ["bad:bad"]],
    ]);
    expect(warn).toHaveBeenCalledWith(
      "alert delivery failing; its alerts are kept and retried with backoff",
      expect.objectContaining({
        sink: "bad",
        target: "bad",
        kind: "transient",
        undelivered: 3,
        retryInMs: RETRY_BASE_MS,
      }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("marks a target failing when it drops a message, until it delivers at that severity or above", async () => {
    const {log, error} = capturingLogger();
    const rejected = new Set<string>();
    const sent: string[] = [];
    // Like an on-call route that rejects these messages themselves (e.g. 400 "message is too long").
    const sink: AlertSink = {
      name: "telegram",
      targets: ["oncall"],
      send: async (message) => {
        if (rejected.has(message.alert.severity)) {
          throw new DeliveryError(`400 Bad Request: message is too long (${message.alert.severity})`, "message");
        }
        sent.push(message.alert.key);
      },
    };
    const {manager, clock, store} = setup({sinks: [sink], log});
    manager.emit(event("e:info:1", "info"));
    await deliver(manager);
    expect(manager.stats).toEqual({
      telegram: {ok: 1, failed: 0, retries: 0, targets: {oncall: {ok: 1, failed: 0, retries: 0, undelivered: 0}}},
    });

    rejected.add("high").add("critical");
    manager.emit(event("e:high:1", "high"));
    await deliver(manager);
    clock.now += 60_000;
    manager.emit(event("e:crit:1", "critical"));
    await deliver(manager);
    const failing = {since: T0, severity: "critical", error: "400 Bad Request: message is too long (critical)"};
    expect(manager.stats.telegram).toEqual({
      ok: 1,
      failed: 2,
      retries: 0,
      failing: {...failing, kind: "message"},
      targets: {oncall: {ok: 1, failed: 2, retries: 0, undelivered: 0, failing: {...failing, kind: "message"}}},
    });
    // Dropped for this target only: nothing waits for it.
    expect(stored(store).outbox).toEqual([]);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(
      "alert dropped for a target that cannot take it",
      expect.objectContaining({sink: "telegram", target: "oncall", key: "e:crit:1", kind: "message"}),
    );

    // Lower severities arrive, but say nothing about the dropped critical; nor does a high.
    rejected.delete("high");
    manager.emit(event("e:info:2", "info"));
    manager.emit(event("e:high:2", "high"));
    await deliver(manager);
    expect(manager.stats.telegram?.failing).toMatchObject({severity: "critical"});

    // A copy: callers cannot clear it.
    delete manager.stats.telegram!.failing;
    expect(manager.stats.telegram?.failing).toBeDefined();

    // Kept across a restart.
    const restarted = setup({store, clock, sinks: [sink], log});
    expect(restarted.manager.stats.telegram?.targets.oncall?.failing).toEqual({...failing, kind: "message"});

    rejected.clear();
    restarted.manager.emit(event("e:crit:2", "critical"));
    await deliver(restarted.manager);
    expect(restarted.manager.stats.telegram).toEqual({
      ok: 1,
      failed: 0,
      retries: 0,
      targets: {oncall: {ok: 1, failed: 0, retries: 0, undelivered: 0}},
    });
    expect(sent).toEqual(["e:info:1", "e:info:2", "e:high:2", "e:crit:2"]);
  });

  it("sends overlapping flushes in order, without the caller waiting for a slow sink", async () => {
    const received: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: AlertSink = {
      name: "slow",
      send: async (message) => {
        if (message.alert.key === "e:1") await gate;
        received.push(message.alert.key);
      },
    };
    const {manager} = setup({sinks: [slow]});
    manager.emit(event("e:1"));
    manager.flush();
    manager.emit(event("e:2"));
    manager.flush();
    expect(manager.pending).toBe(0);
    await flushPromises();
    expect(received).toEqual([]);
    release();
    await manager.drain(60_000);
    expect(received).toEqual(["e:1", "e:2"]);
  });

  it("folds more than 20 info/warning messages into one digest and keeps critical/high individual", async () => {
    const {manager, sink} = setup();
    manager.emit(event("e:crit", "critical"));
    for (let i = 0; i < 25; i++) manager.emit(event(`e:w:${i}`, i % 2 ? "warning" : "info"));
    manager.emit(event("e:high", "high"));
    for (let i = 0; i < 15; i++) manager.emit(event(`e:i:${i}`, "info"));
    await deliver(manager);

    expect(sink.messages.map((m) => m.alert.rule === "digest" ? "digest" : m.alert.key)).toEqual([
      "e:crit",
      "digest",
      "e:high",
    ]);
    const digest = sink.messages[1]?.alert;
    expect(digest).toMatchObject({kind: "event", rule: "digest", severity: "warning"});
    expect(digest?.title).toContain("40");
    const lines = digest?.note?.split("\n") ?? [];
    expect(lines).toHaveLength(31);
    expect(lines[0]).toBe("• INFO ethereum: Event e:w:0");
    expect(lines[30]).toBe("… and 10 more");
    expect(digest?.fields).toEqual([
      {label: "Info firing", value: "28"},
      {label: "Warning firing", value: "12"},
    ]);
  });

  it("uses info severity for an all-info digest and leaves 20 messages individual", async () => {
    const {manager, sink} = setup();
    for (let i = 0; i < 21; i++) manager.emit(event(`e:${i}`, "info"));
    await deliver(manager);
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]?.alert).toMatchObject({rule: "digest", severity: "info"});
    expect(sink.messages[0]?.alert.note?.split("\n")).toHaveLength(21);

    for (let i = 0; i < 20; i++) manager.emit(event(`f:${i}`, "warning"));
    await deliver(manager);
    expect(sink.messages).toHaveLength(21);
  });
});

describe("AlertManager outbox", () => {
  it("stores a message until every target took it; a restart sends it only to the targets that had not", async () => {
    const store = createStore();
    const fast = new CaptureSink("fast");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: AlertSink = {name: "slow", send: () => gate};
    const {manager} = setup({store, sinks: [fast, slow]});
    manager.emit(event("e:1"));
    expect(stored(store).queue.map((m) => m.alert.key)).toEqual(["e:1"]);
    manager.flush();
    await vi.waitFor(() => expect(fast.messages).toHaveLength(1));
    const saved = store.get(ALERTS_NAMESPACE, {});
    expect(saved).toMatchObject({
      queue: [],
      outbox: [{message: {alert: {key: "e:1"}}, targets: ["slow:slow"], at: T0}],
    });

    // The process dies here: a restart on what was saved.
    const crashed = createStore();
    crashed.set(ALERTS_NAMESPACE, saved);
    const again = [new CaptureSink("fast"), new CaptureSink("slow")];
    const restarted = setup({store: crashed, sinks: again});
    restarted.manager.emit(event("e:1")); // replayed by its rule: still deduped
    await deliver(restarted.manager);
    expect(again.map((sink) => summary(sink.messages))).toEqual([[], ["firing:high:e:1"]]);
    expect(stored(crashed)).toMatchObject({queue: [], outbox: []});

    release();
    await manager.drain(60_000);
    expect(stored(store).outbox).toEqual([]);
  });

  it("restores the outbox ahead of the queue, folds a restored burst into a digest, and drains both", async () => {
    const store = createStore();
    const held: AlertSink = {name: "capture", send: () => new Promise(() => {})};
    const {manager} = setup({store, sinks: [held]});
    manager.emit(event("e:0", "critical"));
    manager.flush();
    for (let i = 0; i < 25; i++) manager.emit(event(`e:info:${i}`, "info"));

    const restarted = setup({store});
    restarted.manager.emit(event("e:new", "high"));
    await deliver(restarted.manager);
    expect(restarted.sink.messages.map((m) => (m.alert.rule === "digest" ? "digest" : m.alert.key))).toEqual([
      "e:0",
      "digest",
      "e:new",
    ]);
    expect(restarted.sink.messages[1]?.alert.title).toContain("25");
    expect(stored(store)).toMatchObject({queue: [], outbox: []});
  });

  it("drops stored messages for sinks no longer configured, corrupt ones, and ones a target rejects", async () => {
    const store = createStore();
    const valid = (key: string) => ({alert: event(key), status: "firing"});
    store.set(ALERTS_NAMESPACE, {
      sent: {},
      open: {},
      queue: [{alert: {key: "q:bad"}, status: "firing"}, valid("q:1")],
      outbox: [
        {message: valid("o:telegram-only"), sinks: ["telegram"]},
        {message: valid("o:1"), sinks: ["telegram", "capture"]},
        {message: {...valid("o:bad"), status: "sent"}, sinks: ["capture"]},
        {message: valid("o:no-sinks"), sinks: "capture"},
      ],
    });
    const {manager, sink} = setup({store});
    await deliver(manager);
    expect(summary(sink.messages)).toEqual(["firing:high:o:1", "firing:high:q:1"]);

    const rejecting: AlertSink = {
      name: "capture",
      send: async () => {
        throw new DeliveryError("400 Bad Request: message is too long", "message");
      },
    };
    const failing = setup({store, sinks: [rejecting]});
    failing.manager.emit(event("e:1"));
    await deliver(failing.manager);
    expect(failing.manager.stats.capture).toMatchObject({failed: 1, failing: {kind: "message"}});
    expect(stored(store)).toMatchObject({queue: [], outbox: []});
  });
});

/** Deterministic PRNG (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function turns(rng: () => number, max: number): Promise<void> {
  for (let i = Math.floor(rng() * (max + 1)); i > 0; i--) await turn();
}

const messageId = (message: OutgoingMessage) => `${message.status}:${message.alert.key}`;

/** A sink taking a random number of turns per message; records each message once it has delivered it. */
class SlowSink implements AlertSink {
  readonly name: string;
  readonly delivered: string[] = [];
  readonly #rng: () => number;

  constructor(name: string, rng: () => number) {
    this.name = name;
    this.#rng = rng;
  }

  async send(message: OutgoingMessage): Promise<void> {
    await turns(this.#rng, 3);
    this.delivered.push(messageId(message));
  }
}

interface Snapshot {
  seed: number;
  alerts: unknown;
  /** Messages emitted before the save. */
  emitted: number;
  /** Messages each sink had delivered before the save. */
  delivered: number[];
}

/**
 * Three "loops" emit events and open/resolve conditions and commit like the daemon (flush, then save) while two slow
 * sinks deliver (each delivery saved, like the daemon does) and a timer saves at random moments. Every save is a
 * possible crash point.
 */
async function interleave(seed: number): Promise<{emitted: string[]; sinks: SlowSink[]; snapshots: Snapshot[]}> {
  const rng = random(seed);
  const store = createStore();
  const sinks = [new SlowSink("a", random(seed * 7 + 1)), new SlowSink("b", random(seed * 13 + 2))];
  const emitted: string[] = [];
  const snapshots: Snapshot[] = [];
  const {manager} = setup({store, sinks, afterDelivery: () => save()});
  const save = () => {
    store.save();
    const delivered = sinks.map((sink) => sink.delivered.length);
    snapshots.push({seed, alerts: store.get(ALERTS_NAMESPACE, undefined), emitted: emitted.length, delivered});
  };
  let running = true;
  const loop = async (id: number) => {
    let open = false;
    for (let round = 0; round < 8; round++) {
      const key = `e:${id}:${round}`;
      manager.emit(event(key, rng() < 0.5 ? "high" : "critical"));
      emitted.push(`firing:${key}`);
      if (rng() < 0.5) {
        const subject = `c:${id}`;
        if (open) manager.resolve(subject);
        else manager.emit(condition(subject));
        emitted.push(`${open ? "resolved" : "firing"}:${subject}`);
        open = !open;
      }
      await turns(rng, 2);
      manager.flush();
      save();
      await turns(rng, 2);
    }
  };
  const timer = async () => {
    while (running) {
      await turns(rng, 3);
      save();
    }
  };
  const saving = timer();
  await Promise.all([loop(0), loop(1), loop(2)]);
  running = false;
  await saving;
  await deliver(manager);
  return {emitted, sinks, snapshots};
}

describe("AlertManager outbox (random interleavings)", () => {
  it("loses, reorders or repeats nothing at any save: a restart re-sends only what was not delivered", async () => {
    let checked = 0;
    let undelivered = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const {emitted, sinks, snapshots} = await interleave(seed);
      // Uninterrupted, every sink gets every message once, in emission order.
      for (const sink of sinks) expect(sink.delivered, `seed ${seed}`).toEqual(emitted);

      for (const snapshot of snapshots) {
        const store = createStore();
        if (snapshot.alerts !== undefined) store.set(ALERTS_NAMESPACE, snapshot.alerts);
        const replay = sinks.map((sink) => new CaptureSink(sink.name));
        const restarted = setup({store, sinks: replay});
        await deliver(restarted.manager);
        replay.forEach((sink, i) => {
          const done = snapshot.delivered[i] ?? 0;
          const got = sink.messages.map(messageId);
          const context = `seed ${seed}, sink ${sink.name}, ${done}/${snapshot.emitted} delivered at the save`;
          // Exactly what was emitted and not yet delivered, in order; plus, at most, the message whose delivery had
          // completed but was not yet recorded (in flight at the crash: at least once).
          const rest = emitted.slice(done, snapshot.emitted);
          const withInFlight = done > 0 ? emitted.slice(done - 1, snapshot.emitted) : rest;
          expect([rest, withInFlight], context).toContainEqual(got);
          if (rest.length) undelivered++;
        });
        checked++;
      }
    }
    // Every loop round saves (3 x 8 per seed), the timer more; most saves happen with messages still undelivered.
    expect(checked).toBeGreaterThan(40 * 24);
    expect(undelivered).toBeGreaterThan(checked / 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Telegram outages: the real TelegramSink against a Bot API stand-in, on a test clock (retries fire as it advances).

const TOKEN = "123456789:outage-test-token-0000";
const CHANNEL = "-1001111111111";
const ONCALL = "-1002222222222";

const okReply = () => new Response(JSON.stringify({ok: true, result: {message_id: 1}}), {status: 200});

function apiError(status: number, description: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ok: false, error_code: status, description, ...extra}), {status});
}

/** Bot API stand-in: answers each sendMessage with `reply(chat, token)` and records what it accepted. */
class BotApi {
  reply: (chat: string, token: string) => Response | Error | "hang" = () => okReply();
  readonly requests: Array<{chat: string; at: number; result: number | string}> = [];
  /** Accepted messages: chat and first line (the header with the title). */
  readonly delivered: Array<{chat: string; head: string; text: string}> = [];
  readonly #clock: {now: number};

  constructor(clock: {now: number}) {
    this.#clock = clock;
  }

  readonly fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as {chat_id: string; text: string};
    const answer = this.reply(body.chat_id, /\/bot([^/]+)\//.exec(url)?.[1] ?? "");
    const result = answer === "hang" ? "hang" : answer instanceof Error ? "error" : answer.status;
    this.requests.push({chat: body.chat_id, at: this.#clock.now, result});
    if (answer === "hang") return new Promise<Response>(() => {});
    if (answer instanceof Error) throw answer;
    if (answer.ok) this.delivered.push({chat: body.chat_id, head: body.text.split("\n")[0] ?? "", text: body.text});
    return answer;
  };

  /** Titles accepted in a chat, in order. */
  titles(chat: string): string[] {
    return this.delivered
      .filter((entry) => entry.chat === chat)
      .map((entry) => /<b>([^<]*)<\/b>$/.exec(entry.head)?.[1] ?? "");
  }
}

/** A channel for everything and an on-call group for high/critical, as in production. */
function telegram(
  api: BotApi,
  clock: {now: number},
  options: {token?: string; oncall?: string} = {},
): TelegramSink {
  return new TelegramSink({
    botToken: options.token ?? TOKEN,
    apiUrl: "https://api.telegram.org",
    routes: [
      {chatId: CHANNEL, minSeverity: "info"},
      {chatId: options.oncall ?? ONCALL, minSeverity: "high"},
    ],
    log: silentLogger,
    fetch: api.fetch,
    // The in-call backoff passes on the test clock.
    sleep: async (ms) => {
      clock.now += ms;
    },
    now: () => clock.now,
  });
}

const title = (key: string) => `Event ${key}`;

describe("AlertManager during a Telegram outage", () => {
  it("keeps every alert of a 1 h outage (refused, then 502) and delivers each once per route, in order", async () => {
    const clock = {now: T0};
    const api = new BotApi(clock);
    const log = logger();
    const {manager, timers, store} = setup({clock, sinks: [telegram(api, clock)], log});
    api.reply = () => new Error("connect ECONNREFUSED 149.154.167.220:443");
    const all: string[] = [];
    const urgent: string[] = [];
    for (let minute = 0; minute < 60; minute += 5) {
      if (minute === 30) api.reply = () => apiError(502, "Bad Gateway");
      const key = `e:${minute}`;
      const severity: Severity = minute % 15 === 0 ? "critical" : "info";
      manager.emit(event(key, severity));
      all.push(title(key));
      if (severity === "critical") urgent.push(title(key));
      manager.flush();
      await timers.advance(5 * 60_000);
    }
    expect(api.delivered).toEqual([]);
    const down = manager.stats.telegram!;
    expect(down.targets[CHANNEL]).toMatchObject({
      ok: 0,
      failed: 0,
      undelivered: 12,
      oldestUndeliveredAt: T0,
      failing: {severity: "critical", kind: "transient", error: expect.stringContaining("502 Bad Gateway")},
    });
    expect(down.targets[ONCALL]).toMatchObject({undelivered: 4, failing: {kind: "transient"}});
    // From the first failed attempt (after the sink's few seconds of in-call retries).
    expect(down.failing!.since - T0).toBeLessThan(10_000);
    expect(stored(store).outbox).toHaveLength(12);
    // Backoff (5 s doubling to 5 min) bounds the attempts: three requests each (the sink's short in-call retries).
    const attempts = api.requests.filter((request) => request.chat === CHANNEL).length / 3;
    expect(attempts).toBeGreaterThan(8);
    expect(attempts).toBeLessThan(20);

    api.reply = () => okReply();
    await timers.advance(RETRY_MAX_MS);
    expect(api.titles(CHANNEL)).toEqual(all);
    expect(api.titles(ONCALL)).toEqual(urgent);
    expect(manager.stats.telegram?.failing).toBeUndefined();
    expect(manager.stats.telegram?.targets[CHANNEL]).toMatchObject({ok: 12, failed: 0, undelivered: 0});
    expect(stored(store).outbox).toEqual([]);
    expect(stored(store).targets).toEqual({[`telegram:${CHANNEL}`]: {}, [`telegram:${ONCALL}`]: {}});

    // A warning per target when it started failing and an info when it recovered; every retry at debug level only.
    const notable = log.lines.filter((line) => line.level !== "debug");
    expect(notable.filter((line) => line.level === "warn").map((line) => line.fields?.target).sort()).toEqual(
      [CHANNEL, ONCALL].sort(),
    );
    const recovered = notable.filter((line) => line.message === "alert delivery recovered");
    expect(recovered.map((line) => line.fields?.target).sort()).toEqual([CHANNEL, ONCALL].sort());
    const channel = recovered.find((line) => line.fields?.target === CHANNEL)!;
    expect(channel.fields).toMatchObject({sink: "telegram", undelivered: 11});
    expect(channel.fields?.failingForSec).toBeGreaterThanOrEqual(3600);
    expect(notable.filter((line) => !["warn", "info"].includes(line.level) || line.message.includes("retry"))).toEqual(
      [],
    );
    expect(log.lines.filter((line) => line.message === "alert delivery retry failed").length).toBeGreaterThan(10);
  });

  it("never re-sends to the channel while the on-call route fails, and delivers there once it is fixed", async () => {
    const clock = {now: T0};
    const api = new BotApi(clock);
    const {manager, timers} = setup({clock, sinks: [telegram(api, clock)]});
    const kicked = "Forbidden: bot was kicked from the supergroup chat";
    api.reply = (chat) => (chat === ONCALL ? apiError(403, kicked) : okReply());
    manager.emit(event("e:1", "critical"));
    manager.emit(event("e:2", "info"));
    manager.emit(event("e:3", "high"));
    manager.flush();
    await timers.advance(60_000);
    expect(api.titles(CHANNEL)).toEqual([title("e:1"), title("e:2"), title("e:3")]);
    expect(api.titles(ONCALL)).toEqual([]);
    const stats = manager.stats.telegram!;
    expect(stats.targets[CHANNEL]).toEqual({ok: 3, failed: 0, retries: 0, undelivered: 0});
    expect(stats.targets[ONCALL]).toMatchObject({ok: 0, retries: 4, undelivered: 2, failing: {kind: "route"}});
    // The head message is retried with backoff (no in-call retry for a 403): 5 s, 10 s, 20 s, ...
    const times = api.requests.filter((request) => request.chat === ONCALL).map((request) => request.at);
    expect(times.slice(1).map((at, i) => at - times[i]!)).toEqual([5_000, 10_000, 20_000]);

    // The bot is added back: the next retry delivers both, in order; the channel sees nothing again.
    api.reply = () => okReply();
    await timers.advance(RETRY_MAX_MS);
    expect(api.titles(ONCALL)).toEqual([title("e:1"), title("e:3")]);
    expect(api.titles(CHANNEL)).toEqual([title("e:1"), title("e:2"), title("e:3")]);
    expect(manager.stats.telegram?.failing).toBeUndefined();
  });

  it("delivers after a restart in the middle of the outage, failing from the start until then", async () => {
    const clock = {now: T0};
    const api = new BotApi(clock);
    const store = createStore();
    const first = setup({clock, store, sinks: [telegram(api, clock)]});
    api.reply = () => apiError(502, "Bad Gateway");
    first.manager.emit(event("e:1", "critical"));
    first.manager.flush();
    await first.timers.advance(10 * 60_000);
    expect(api.delivered).toEqual([]);

    // The process dies (no stop) and starts again on what was saved.
    const second = setup({clock, store, sinks: [telegram(api, clock)]});
    const restored = second.manager.stats.telegram!;
    const since = first.manager.stats.telegram!.failing!.since;
    expect(restored.failing).toMatchObject({since, severity: "critical", kind: "transient"});
    expect(restored.targets[ONCALL]).toMatchObject({undelivered: 1, failing: {kind: "transient"}});
    expect(restored.targets[CHANNEL]).toMatchObject({undelivered: 1, failing: {kind: "transient"}});
    second.manager.emit(event("e:2", "high"));
    second.manager.flush();
    await second.timers.advance(60_000);
    expect(second.manager.stats.telegram?.failing).toMatchObject({since});

    api.reply = () => okReply();
    await second.timers.advance(RETRY_MAX_MS);
    expect(api.titles(CHANNEL)).toEqual([title("e:1"), title("e:2")]);
    expect(api.titles(ONCALL)).toEqual([title("e:1"), title("e:2")]);
    expect(second.manager.stats.telegram?.failing).toBeUndefined();
    expect(stored(store).outbox).toEqual([]);
  });

  it("drops a message the on-call route rejects (400) for that route only, failing across a restart", async () => {
    const clock = {now: T0};
    const api = new BotApi(clock);
    const store = createStore();
    const first = setup({clock, store, sinks: [telegram(api, clock)]});
    api.reply = (chat) => (chat === ONCALL ? apiError(400, "Bad Request: message is too long") : okReply());
    first.manager.emit(event("e:1", "critical"));
    first.manager.emit(event("e:2", "info"));
    await deliver(first.manager);
    expect(api.titles(CHANNEL)).toEqual([title("e:1"), title("e:2")]);
    expect(api.requests.filter((request) => request.chat === ONCALL)).toHaveLength(1);
    expect(first.manager.stats.telegram?.targets[ONCALL]).toMatchObject({
      failed: 1,
      undelivered: 0,
      failing: {severity: "critical", kind: "message", error: expect.stringContaining("message is too long")},
    });
    expect(stored(store).outbox).toEqual([]);
    expect(first.timers.pending.size).toBe(0);

    const second = setup({clock, store, sinks: [telegram(api, clock)]});
    api.reply = () => okReply();
    second.manager.emit(event("e:3", "high"));
    await deliver(second.manager);
    // A high reached it, but says nothing about the dropped critical.
    expect(second.manager.stats.telegram?.targets[ONCALL]?.failing).toMatchObject({severity: "critical"});
    second.manager.emit(event("e:4", "critical"));
    await deliver(second.manager);
    expect(second.manager.stats.telegram?.failing).toBeUndefined();
    expect(api.titles(ONCALL)).toEqual([title("e:3"), title("e:4")]);
  });

  it("keeps a message rate limited with retry_after 3600, retried no earlier, also across a restart", async () => {
    const clock = {now: T0};
    const api = new BotApi(clock);
    const store = createStore();
    let limited = true;
    api.reply = () =>
      limited ? apiError(429, "Too Many Requests: retry after 3600", {parameters: {retry_after: 3600}}) : okReply();
    const first = setup({clock, store, sinks: [telegram(api, clock)]});
    first.manager.emit(event("e:1", "critical"));
    first.manager.flush();
    await first.timers.advance(1_000);
    expect(api.requests.map((request) => request.result)).toEqual([429, 429]);
    expect(first.timers.delays).toEqual([3_600_000, 3_600_000]);
    expect(stored(store).targets[`telegram:${CHANNEL}`]?.retryAt).toBe(T0 + 3_600_000);
    expect(first.manager.stats.telegram?.targets[CHANNEL]).toMatchObject({
      undelivered: 1,
      failing: {kind: "transient"},
    });

    // Restarted ten minutes in: still waits for the retry_after.
    await first.timers.advance(10 * 60_000);
    const second = setup({clock, store, sinks: [telegram(api, clock)]});
    second.manager.flush();
    await second.timers.advance(3_600_000 - 11 * 60_000);
    expect(api.requests).toHaveLength(2);
    limited = false;
    await second.timers.advance(60_000);
    expect(api.requests.slice(2).map((request) => request.at)).toEqual([T0 + 3_600_000, T0 + 3_600_000]);
    expect(api.titles(CHANNEL)).toEqual([title("e:1")]);
    expect(api.titles(ONCALL)).toEqual([title("e:1")]);
    expect(stored(store).targets[`telegram:${CHANNEL}`]).toEqual({});
  });

  it("keeps the messages while the bot token is wrong (401), delivered after the fix and a restart", async () => {
    const clock = {now: T0};
    const api = new BotApi(clock);
    const store = createStore();
    api.reply = (_chat, token) => (token === TOKEN ? okReply() : apiError(401, "Unauthorized"));
    const first = setup({clock, store, sinks: [telegram(api, clock, {token: "123456789:wrong-token-00000"})]});
    first.manager.emit(event("e:1", "critical"));
    first.manager.emit(event("e:2", "info"));
    first.manager.flush();
    await first.timers.advance(30 * 60_000);
    expect(api.delivered).toEqual([]);
    expect(first.manager.stats.telegram?.targets[CHANNEL]).toMatchObject({
      undelivered: 2,
      failing: {kind: "route", error: expect.stringContaining("401 Unauthorized")},
    });
    expect(await first.manager.stop(10_000)).toBe(2);

    const second = setup({clock, store, sinks: [telegram(api, clock)]});
    second.manager.flush();
    await second.manager.drain(60_000);
    expect(api.titles(CHANNEL)).toEqual([title("e:1"), title("e:2")]);
    expect(api.titles(ONCALL)).toEqual([title("e:1")]);
    expect(second.manager.stats.telegram?.failing).toBeUndefined();
  });

  it("hands the messages of a route whose chat id was fixed to the new chat, not the channel", async () => {
    const clock = {now: T0};
    const api = new BotApi(clock);
    const store = createStore();
    const OLD = "-123456";
    api.reply = (chat) =>
      chat === OLD
        ? apiError(400, "Bad Request: group chat was upgraded to a supergroup chat", {
            parameters: {migrate_to_chat_id: Number(ONCALL)},
          })
        : okReply();
    const first = setup({clock, store, sinks: [telegram(api, clock, {oncall: OLD})]});
    first.manager.emit(event("e:1", "critical"));
    first.manager.flush();
    await first.timers.advance(60_000);
    expect(first.manager.stats.telegram?.targets[OLD]).toMatchObject({
      undelivered: 1,
      failing: {kind: "route", error: expect.stringContaining(`the chat is now ${ONCALL}`)},
    });

    const log = logger();
    const second = setup({clock, store, sinks: [telegram(api, clock)], log});
    const warnings = log.lines.filter((line) => line.level === "warn").map((line) => [line.message, line.fields]);
    expect(warnings).toContainEqual([
      "alerts not delivered to targets no longer configured go to the targets added since",
      {targets: [`telegram:${OLD}`]},
    ]);
    await deliver(second.manager);
    expect(api.titles(ONCALL)).toEqual([title("e:1")]);
    expect(api.titles(CHANNEL)).toEqual([title("e:1")]);
    expect(Object.keys(stored(store).targets)).toEqual([`telegram:${CHANNEL}`, `telegram:${ONCALL}`]);
  });

  it("stops within its bound while a send hangs, and at once while targets wait for a retry", async () => {
    const clock = {now: T0};
    const api = new BotApi(clock);
    api.reply = () => "hang";
    const hung = setup({clock, sinks: [telegram(api, clock)]});
    hung.manager.emit(event("e:1", "critical"));
    hung.manager.flush();
    let done = false;
    const stopping = hung.manager.stop(10_000).then((left) => {
      done = true;
      return left;
    });
    await flushPromises();
    expect(done).toBe(false);
    await hung.timers.advance(10_000);
    expect(await stopping).toBe(1);
    expect(hung.timers.pending.size).toBe(0);

    api.reply = () => apiError(502, "Bad Gateway");
    const paused = setup({clock, sinks: [telegram(api, clock)]});
    paused.manager.emit(event("e:2", "critical"));
    await deliver(paused.manager);
    expect(paused.timers.pending.size).toBe(2);
    expect(await paused.manager.stop(10_000)).toBe(1);
    expect(paused.timers.pending.size).toBe(0);
    // Nothing is sent after the stop.
    const sent = api.requests.length;
    paused.manager.emit(event("e:3", "critical"));
    paused.manager.flush();
    await paused.timers.advance(RETRY_MAX_MS);
    expect(api.requests).toHaveLength(sent);
  });

  it("retries an unclassified error a few times, then drops the message for that target", async () => {
    const clock = {now: T0};
    const log = logger();
    let attempts = 0;
    const buggy: AlertSink = {
      name: "buggy",
      send: async () => {
        attempts++;
        throw new TypeError("Cannot read properties of undefined (reading 'length')");
      },
    };
    const {manager, timers} = setup({clock, sinks: [buggy], log});
    manager.emit(event("e:1", "critical"));
    manager.emit(event("e:2", "critical"));
    manager.flush();
    await timers.advance(60_000);
    expect(attempts).toBe(2 * MAX_UNCLASSIFIED_ATTEMPTS);
    expect(manager.stats.buggy?.targets.buggy).toMatchObject({
      failed: 2,
      retries: 2 * (MAX_UNCLASSIFIED_ATTEMPTS - 1),
      undelivered: 0,
      failing: {kind: "unclassified", severity: "critical"},
    });
    const errors = log.lines.filter((line) => line.level === "error").map((line) => line.message);
    expect(errors).toEqual([
      "alert delivery failed with an unclassified error, retrying",
      "alert delivery failed with an unclassified error, retrying",
      "alert dropped for a target that cannot take it",
      "alert delivery failed with an unclassified error, retrying",
      "alert delivery failed with an unclassified error, retrying",
      "alert dropped for a target that cannot take it",
    ]);
  });

  it("moves the outbox of a state file from before per-target delivery to the targets that admit it", async () => {
    const clock = {now: T0};
    const api = new BotApi(clock);
    const store = createStore();
    const message = (alert: Alert): OutgoingMessage => ({alert, status: "firing"});
    store.set(ALERTS_NAMESPACE, {
      sent: {},
      open: {},
      queue: [],
      outbox: [
        {message: message(event("o:crit", "critical")), sinks: ["telegram"]},
        {message: message(event("o:info", "info")), sinks: ["telegram", "console"]},
        {message: message(event("o:gone", "high")), sinks: ["slack"]},
      ],
      // Never written by that version; junk is ignored.
      targets: {[`telegram:${CHANNEL}`]: {failing: {since: "yesterday"}}},
    });
    const printed: string[] = [];
    const console = new ConsoleSink({write: (text) => printed.push(text)});
    const {manager} = setup({clock, store, sinks: [telegram(api, clock), console]});
    expect(stored(store).outbox).toEqual([
      {message: message(event("o:crit", "critical")), targets: [`telegram:${CHANNEL}`, `telegram:${ONCALL}`], at: T0},
      {message: message(event("o:info", "info")), targets: [`telegram:${CHANNEL}`, "console:stdout"], at: T0},
    ]);
    expect(stored(store).targets).toEqual({
      [`telegram:${CHANNEL}`]: {},
      [`telegram:${ONCALL}`]: {},
      "console:stdout": {},
    });
    expect(manager.stats.telegram?.failing).toBeUndefined();
    await deliver(manager);
    expect(api.titles(CHANNEL)).toEqual([title("o:crit"), title("o:info")]);
    expect(api.titles(ONCALL)).toEqual([title("o:crit")]);
    expect(printed).toHaveLength(1);
    expect(stored(store).outbox).toEqual([]);
  });

  it("bounds a 24 h outage's backlog: digests, one reminder per condition, critical/high in order", async () => {
    const clock = {now: T0};
    const api = new BotApi(clock);
    const {manager, timers, store} = setup({clock, sinks: [telegram(api, clock)]});
    // The channel is down for a day; the on-call group works.
    api.reply = (chat) => (chat === CHANNEL ? apiError(502, "Bad Gateway") : okReply());
    const highs: string[] = [];
    let infos = 0;
    let largest = 0;
    const STEP = 5 * 60_000;
    for (let step = 0; step < (24 * 3600_000) / STEP; step++) {
      // A busy chain: three info events every five minutes, a high one every hour.
      for (let i = 0; i < 3; i++) manager.emit(event(`info:${step}:${i}`, "info"));
      infos += 3;
      if (step % 12 === 6) {
        manager.emit(event(`high:${step}`, "high"));
        highs.push(title(`high:${step}`));
      }
      // A critical condition open all day: reminded every hour.
      manager.sync("ethereum:z:", [condition("ethereum:z:down", "critical")]);
      // W fires and resolves at warning while the channel is down; Y escalates, resolves and re-opens at warning.
      const w = step >= 1 && step < 3 ? [condition("ethereum:w:low", "warning")] : [];
      manager.sync("ethereum:w:", w);
      const y = step === 3 ? "warning" : step === 4 ? "critical" : step >= 6 ? "warning" : undefined;
      manager.sync("ethereum:y:", y ? [condition("ethereum:y:gap", y)] : []);
      manager.tick();
      manager.flush();
      largest = Math.max(largest, JSON.stringify(stored(store).outbox).length);
      await timers.advance(STEP);
    }
    const backlog = manager.stats.telegram!.targets[CHANNEL]!;
    // 864 info messages, 24 highs, 24 reminders and the conditions' messages, held in a few dozen entries.
    expect(infos).toBe(864);
    expect(backlog.undelivered).toBeLessThanOrEqual(DIGEST_THRESHOLD + 1 + 24 + 6);
    expect(largest).toBeLessThan(100_000);
    // The on-call group got everything for it on time (reminders each hour included).
    expect(api.titles(ONCALL).filter((text) => text.startsWith("Event high:"))).toEqual(highs);
    expect(api.delivered.filter((entry) => entry.chat === ONCALL && entry.head.includes("REMINDER"))).toHaveLength(23);

    api.reply = () => okReply();
    await timers.advance(10 * 60_000);
    expect(manager.stats.telegram?.targets[CHANNEL]).toMatchObject({undelivered: 0});
    const channel = api.delivered.filter((entry) => entry.chat === CHANNEL);
    const heads = channel.map((entry) => entry.head);
    // Critical/high individually and in order; only the latest reminder of the open condition.
    expect(api.titles(CHANNEL).filter((text) => text.startsWith("Event high:"))).toEqual(highs);
    // One reminder per open condition: Z, and Y once re-opened.
    expect(heads.filter((head) => head.includes("REMINDER"))).toEqual([
      expect.stringContaining("ethereum:y:gap"),
      expect.stringContaining("ethereum:z:down"),
    ]);
    // Every info message is in a digest (none individual beyond the last fold's leftovers).
    const digests = channel.filter((entry) => entry.head.includes("(digest)"));
    expect(digests.length).toBeGreaterThanOrEqual(1);
    const count = (head: string) => Number(/<b>(\d+) info\/warning alerts/.exec(head)?.[1]);
    const folded = digests.reduce((sum, entry) => sum + count(entry.head), 0);
    const individual = heads.filter((head) => /Event info:/.test(head)).length;
    // Plus W's firing and resolution and Y's first warning.
    expect(folded + individual).toBe(infos + 3);
    expect(individual).toBeLessThanOrEqual(DIGEST_THRESHOLD);
    // W fired and resolved inside the backlog: its digest line shows the latest state.
    const first = digests[0]!.text;
    expect(first).toContain("• WARNING ethereum: Condition ethereum:w:low (resolved)");
    expect(first).not.toMatch(/Condition ethereum:w:low$/m);
    // Y's re-opening at warning comes after its critical messages, never folded into a digest before them.
    const label = (head: string) => (head.includes("(digest)") ? "digest" : /<b>([^<]+)<\/b>/.exec(head)?.[1]);
    const about = channel.filter(({head, text}) => head.includes("ethereum:y:gap") || text.includes("ethereum:y:gap"));
    const sequence = ["digest", "CRITICAL", "RESOLVED", "WARNING", "REMINDER WARNING"];
    expect(about.map(({head}) => label(head))).toEqual(sequence);
    expect(first).toMatch(/^• WARNING ethereum: Condition ethereum:y:gap$/m);
    expect(stored(store).outbox).toEqual([]);
  });
});

describe("AlertManager delivery edge cases", () => {
  /** Node's setTimeout limit: a longer delay fires after 1 ms (with a TimeoutOverflowWarning). */
  const MAX_TIMER_MS = 2 ** 31 - 1;

  it("resumes a multi-part message after the parts the chat took, across a stop or a crash in its retry", async () => {
    // A long calldata field: the message goes out in two parts.
    const long = event("e:long", "info", {fields: [{label: "Calldata", value: "ab".repeat(3000), code: true}]});
    const chunks = renderTelegramChunks({alert: long, status: "firing"});
    expect(chunks).toHaveLength(2);
    for (const restart of ["stop", "crash"] as const) {
      const clock = {now: T0};
      const api = new BotApi(clock);
      const path = join(mkdtempSync(join(tmpdir(), "monitor-alerts-")), "state.json");
      const store = createStore(path);
      const first = setup({clock, store, sinks: [telegram(api, clock)], afterDelivery: () => store.save()});
      // The channel accepts part 1; part 2 meets 502s (the sink's in-call retries), so the target waits for a retry.
      api.reply = () => (api.delivered.length ? apiError(502, "Bad Gateway") : okReply());
      first.manager.emit(long);
      await deliver(first.manager);
      expect(api.delivered.map((entry) => entry.text)).toEqual(chunks.slice(0, 1));
      expect(first.timers.delays).toEqual([RETRY_BASE_MS]);
      const key = `telegram:${CHANNEL}`;
      expect(stored(store).outbox).toMatchObject([{targets: [key], sent: {[key]: 1}}]);
      if (restart === "stop") {
        expect(await first.manager.stop(10_000)).toBe(1);
        store.save();
      }

      // Restarted on what was saved, with Telegram back and a burst to fold: part 2 only, then the digest.
      api.reply = () => okReply();
      const second = setup({clock, store: createStore(path), sinks: [telegram(api, clock)]});
      for (let i = 0; i < DIGEST_THRESHOLD + 5; i++) second.manager.emit(event(`e:info:${i}`, "info"));
      await deliver(second.manager);
      expect(api.delivered.slice(0, 2).map((entry) => entry.text), restart).toEqual(chunks);
      expect(api.titles(CHANNEL).slice(2), restart).toEqual([`${DIGEST_THRESHOLD + 5} info/warning alerts (digest)`]);
      expect(stored(second.store).outbox).toEqual([]);
    }
  });

  it("keeps the cause of a dropped critical in failing while a later, less severe outage comes and goes", async () => {
    const clock = {now: T0};
    let mode: "reject" | "down" | "up" = "reject";
    const sink: AlertSink = {
      name: "telegram",
      targets: ["oncall"],
      send: async () => {
        if (mode === "reject") throw new DeliveryError("400 Bad Request: message is too long", "message");
        if (mode === "down") throw new DeliveryError("sendMessage failed: 502 Bad Gateway", "transient");
      },
    };
    const store = createStore();
    const {manager, timers} = setup({clock, store, sinks: [sink]});
    manager.emit(event("e:crit", "critical"));
    await deliver(manager);
    clock.now += 60_000;
    mode = "down";
    manager.emit(event("e:high", "high"));
    await deliver(manager);
    mode = "up";
    await timers.advance(RETRY_MAX_MS);
    // Still failing (a high says nothing about the dropped critical), and for the reason that still holds.
    const failing = {since: T0, severity: "critical", kind: "message", error: "400 Bad Request: message is too long"};
    expect(manager.stats.telegram?.targets.oncall).toEqual({ok: 1, failed: 1, retries: 1, undelivered: 0, failing});

    const log = logger();
    const restarted = setup({clock, store, sinks: [sink], log});
    expect(restarted.manager.stats.telegram?.failing).toEqual(failing);
    const warning = log.lines.find((line) => line.message.startsWith("alert delivery was failing"));
    expect(warning?.fields).toMatchObject({target: "oncall", error: failing.error});
  });

  it("waits at most RETRY_AFTER_MAX_MS for a huge or non-finite retry_after, no timer beyond 2^31 - 1 ms", async () => {
    const cases: Array<[number, number]> = [
      [30 * 24 * 3600_000, RETRY_AFTER_MAX_MS],
      [Number.POSITIVE_INFINITY, RETRY_AFTER_MAX_MS],
      [Number.NaN, RETRY_BASE_MS],
    ];
    for (const [retryAfterMs, wait] of cases) {
      const clock = {now: T0};
      const attempts: number[] = [];
      let limited = true;
      const sink: AlertSink = {
        name: "telegram",
        targets: ["c"],
        send: async () => {
          attempts.push(clock.now);
          if (limited) throw new DeliveryError(`429 retry after ${retryAfterMs} ms`, "transient", retryAfterMs);
        },
      };
      const store = createStore();
      const {manager, timers} = setup({clock, store, sinks: [sink]});
      manager.emit(event("e:1", "critical"));
      await deliver(manager);
      const context = String(retryAfterMs);
      expect(timers.delays, context).toEqual([wait]);
      expect(stored(store).targets["telegram:c"]?.retryAt, context).toBe(T0 + wait);
      await timers.advance(wait - 1);
      expect(attempts, context).toEqual([T0]);
      limited = false;
      await timers.advance(1);
      expect(attempts, context).toEqual([T0, T0 + wait]);
      expect(manager.stats.telegram?.targets.c, context).toMatchObject({ok: 1, undelivered: 0});
    }

    // A retryAt saved that far ahead (by an earlier version) waits no longer either.
    const clock = {now: T0};
    const store = createStore();
    const message: OutgoingMessage = {alert: event("e:2", "critical"), status: "firing"};
    store.set(ALERTS_NAMESPACE, {
      sent: {},
      open: {},
      queue: [],
      outbox: [{message, targets: ["capture:capture"], at: T0}],
      targets: {"capture:capture": {retryAt: T0 + 30 * 24 * 3600_000}},
    });
    const {manager, sink, timers} = setup({clock, store});
    manager.flush();
    expect(timers.delays.every((ms) => ms <= MAX_TIMER_MS)).toBe(true);
    await timers.advance(RETRY_AFTER_MAX_MS - 1);
    expect(sink.messages).toEqual([]);
    await timers.advance(1);
    expect(summary(sink.messages)).toEqual(["firing:critical:e:2"]);
  });

  it("arms one real timer for a retry_after beyond setTimeout's range, never an overflowing one", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(`${warning.name}: ${warning.message}`);
    process.on("warning", onWarning);
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const sink: AlertSink = {
        name: "telegram",
        targets: ["c"],
        send: async () => {
          throw new DeliveryError("429 retry after 2592000 s", "transient", 30 * 24 * 3600_000);
        },
      };
      const store = createStore();
      const manager = new AlertManager({sinks: [sink], store, reminderSec: REMINDERS, log: silentLogger});
      manager.emit(event("e:1", "critical"));
      manager.flush();
      await flushPromises();
      // Long enough for an overflowing timer (clamped to 1 ms by Node) to fire and re-arm many times.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const armed = spy.mock.calls.map(([, ms]) => ms ?? 0).filter((ms) => ms >= 60_000);
      await manager.stop(0);
      expect(armed.filter((ms) => ms === RETRY_AFTER_MAX_MS)).toHaveLength(1);
      expect(armed.filter((ms) => ms > MAX_TIMER_MS)).toEqual([]);
    } finally {
      spy.mockRestore();
      process.off("warning", onWarning);
    }
    expect(warnings.filter((warning) => warning.startsWith("TimeoutOverflowWarning"))).toEqual([]);
  });

  it("keeps a page the on-call route cannot take for lack of rights (400), delivered once it may post", async () => {
    const clock = {now: T0};
    const api = new BotApi(clock);
    const {manager, timers} = setup({clock, sinks: [telegram(api, clock)]});
    const denied = "Bad Request: have no write access to the chat";
    api.reply = (chat) => (chat === ONCALL ? apiError(400, denied) : okReply());
    manager.emit(event("e:1", "critical"));
    await deliver(manager);
    expect(manager.stats.telegram?.targets[ONCALL]).toMatchObject({
      failed: 0,
      undelivered: 1,
      failing: {kind: "route", error: expect.stringContaining(denied)},
    });

    api.reply = () => okReply();
    await timers.advance(RETRY_MAX_MS);
    expect(api.titles(ONCALL)).toEqual([title("e:1")]);
    expect(api.titles(CHANNEL)).toEqual([title("e:1")]);
    expect(manager.stats.telegram?.failing).toBeUndefined();
  });
});
