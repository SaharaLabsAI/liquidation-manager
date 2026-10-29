// Alert lifecycle: dedupes event alerts, tracks open conditions (firing -> reminders -> resolved) and delivers queued
// messages to the sinks' targets (each Telegram route, the console). State lives in store namespace "alerts" so a
// restart neither re-fires nor forgets anything.
//
// Durability: a message is queued in that namespace in the same `store.set` as the change that caused it (an event key
// marked sent, a condition opened, reminded or resolved). `flush()` moves the queue to the outbox, where a message
// stays until every target it is for delivered it or dropped it as undeliverable. So the store can be saved at any
// time, also while messages are in delivery: a restart delivers what is left, to the targets that had not taken it,
// before anything new. The owner saves after each delivery (`afterDelivery`), so only a message in flight at a crash
// is sent again (at least once). The same holds for each part of a message a sink sends in parts (`SendProgress`).
//
// Delivery runs in the background, so no caller waits for a sink: each target sends its outbox entries one at a time,
// strictly in emission order. A failure that can pass (DeliveryErrorKind "transient", or "route": the route needs an
// operator fix) keeps the message: the target pauses with exponential backoff (at least the sink's retry_after) and
// retries the same message, its later ones waiting behind it, while the other targets go on. A "message" failure drops
// it for that target only. Any failure marks the target failing (see `DeliveryFailure`), also across a restart. While a
// target is down its backlog stays bounded: see `#compact`.
import type {Config} from "../config.ts";
import type {Logger} from "../log.ts";
import {redact} from "../log.ts";
import type {Store} from "../store.ts";
import {DeliveryError, routeSeverity, SEVERITY_RANK} from "../types.ts";
import type {
  Alert,
  Alerter,
  AlertSink,
  DeliveryErrorKind,
  OutgoingMessage,
  SendProgress,
  Severity,
  Timers,
} from "../types.ts";

export const ALERTS_NAMESPACE = "alerts";

/** Event keys are remembered this long; a re-scan of older blocks would re-send (scanner cursors prevent that). */
export const EVENT_DEDUPE_MS = 7 * 24 * 3600 * 1000;

/** More info/warning messages than this waiting for one target are folded into a single digest message. */
export const DIGEST_THRESHOLD = 20;

/** Titles listed in a digest; the rest are counted. */
export const DIGEST_MAX_TITLES = 30;

/** A target retries a failed message after this long, doubled per failed attempt up to RETRY_MAX_MS. */
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 5 * 60 * 1000;

/**
 * The longest a target waits for a sink's retry_after (e.g. Telegram's after a 429), also one saved before a restart.
 * Anything longer (or not a number) is a broken reply: retrying earlier at worst earns another one.
 */
export const RETRY_AFTER_MAX_MS = 24 * 3600 * 1000;

/** setTimeout's longest delay (Node fires a longer one after 1 ms): a longer wait is armed in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Attempts at one message that fail with an unclassified error (not a DeliveryError: a sink bug, a failed console
 * write) before it is dropped for that target. Retried, in case it passes; but an error that recurs on every attempt
 * must not hold up that target's later messages, critical pages among them, for good. Logged at error level each time.
 */
export const MAX_UNCLASSIFIED_ATTEMPTS = 3;

export interface OpenCondition {
  /** Latest content of the condition (refreshed on every emit, so reminders show current values). */
  alert: Alert;
  /** Unix ms when the condition opened. */
  openedAt: number;
  /** Unix ms of the last firing or reminder message. */
  lastSentAt: number;
  /** Highest severity sent while open; a downgrade and the resolution are routed by it (see `routeSeverity`). */
  peakSeverity?: Severity;
}

interface AlertsState {
  /** Event key -> unix ms of the first emit. */
  sent: Record<string, number>;
  open: Record<string, OpenCondition>;
  /** Messages waiting for the next `flush()`, in emission order. */
  queue: OutgoingMessage[];
  /** Flushed messages not yet delivered (or dropped) by every target they are for, in emission order. */
  outbox: OutboxEntry[];
  /** Every configured target by key (`targetKey`): what of its delivery state outlives a restart. */
  targets: Record<string, StoredTarget>;
}

interface OutboxEntry {
  message: OutgoingMessage;
  /** Keys of the targets that have neither delivered nor dropped it yet. */
  targets: string[];
  /** Unix ms it entered the outbox. */
  at: number;
  /** A digest's content: a later fold for the same target merges into it. */
  digest?: DigestContent;
  /**
   * Target key -> parts of a multi-part message that target accepted while it has yet to take the rest: a retry, also
   * after a restart, sends only the rest (see `SendProgress`).
   */
  sent?: Record<string, number>;
}

interface StoredTarget {
  failing?: DeliveryFailure;
  /** Unix ms before which it is not retried (the sink's retry_after). */
  retryAt?: number;
}

interface DigestContent {
  /** Messages folded in. */
  total: number;
  /** Highest routing severity among them (info or warning). */
  severity: Severity;
  /** Messages per "Severity status" label, in first-seen order. */
  counts: Record<string, number>;
  /**
   * One line per alert key, in first-seen order, for the first DIGEST_MAX_TITLES keys: the key's latest message, so a
   * condition that fired and resolved in the backlog reads as resolved.
   */
  lines: DigestLine[];
  /** Messages about keys without a line. */
  more: number;
}

interface DigestLine {
  key: string;
  text: string;
  /** Messages it stands for. */
  count: number;
}

/** Deliveries since start (for /metrics). */
export interface DeliveryCounts {
  /** Messages delivered. */
  ok: number;
  /** Messages dropped as undeliverable ("message" failures, or unclassified ones MAX_UNCLASSIFIED_ATTEMPTS times). */
  failed: number;
  /** Failed attempts whose message was kept for a retry. */
  retries: number;
}

/** One target: its deliveries since start, its failure (kept across a restart) and its backlog. */
export interface TargetStats extends DeliveryCounts {
  failing?: DeliveryFailure;
  /** Messages it has yet to deliver. */
  undelivered: number;
  /** Unix ms the oldest of them entered the outbox. */
  oldestUndeliveredAt?: number;
}

/** One sink: its targets by id, and their counts summed. */
export interface DeliveryStats extends DeliveryCounts {
  /** While any target is failing: the one failing longest, at the highest severity among them. */
  failing?: DeliveryFailure;
  targets: Record<string, TargetStats>;
}

/**
 * Set while a target's alerts are not getting through: an attempt failed (its message kept for a retry, or dropped)
 * and nothing at the failed routing severity or above was delivered to it since. A target delivers in order, so a kept
 * message clears it once delivered itself; a dropped one keeps it until a later delivery at its severity or above
 * (routes admit by severity, so that delivery reached every route the dropped one should have). Kept across a restart.
 * Withholds the heartbeat and fails /healthz.
 */
export interface DeliveryFailure {
  /** Unix ms of the first failure since the target last delivered. */
  since: number;
  /** Highest routing severity among the failed messages. */
  severity: Severity;
  /**
   * Redacted error of the latest failure at `severity`: what keeps the target failing. A later failure of a less
   * severe message (after a more severe one was dropped) does not replace it.
   */
  error: string;
  /** What that failure was ("unclassified": not a DeliveryError). */
  kind: DeliveryErrorKind | "unclassified";
}

const FAILURE_KINDS: ReadonlyArray<DeliveryFailure["kind"]> = ["transient", "route", "message", "unclassified"];

export interface AlertManagerOptions {
  sinks: AlertSink[];
  store: Store;
  /** Reminder interval per severity in seconds; 0 = never remind. */
  reminderSec: Config["alerts"]["reminderSec"];
  log: Logger;
  /** Clock in unix ms (injectable for tests). */
  now?: () => number;
  /** Retry waits and `drain` timeouts. Default: setTimeout. */
  timers?: Timers;
  /**
   * Called each time a target delivered, dropped or failed to deliver a message, once the stored outbox and failure
   * say so: save the store here, so a restart neither sends it to that target again nor forgets the failure.
   */
  afterDelivery?: () => void;
}

/** A sink's target as the manager drives it. */
interface Target {
  /** `${sink}:${id}`: its key in the stored state. */
  key: string;
  id: string;
  sink: AlertSink;
  counts: DeliveryCounts;
  /** Failed attempts in a row (sets the backoff). */
  failures: number;
  /** Unclassified failures of the message it is retrying. */
  unclassified: number;
  /** The failure kind this process last logged a warning for (once per outage, not per retry). */
  warned?: DeliveryFailure["kind"];
  /** The entry it is sending or will retry: never folded into a digest. */
  attempted?: OutboxEntry;
  /** A send loop is running. */
  running: boolean;
  /** Paused until `at`; `handle` is the timer (none while stopping: nothing is retried then). */
  retry?: {at: number; handle: unknown};
}

const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class AlertManager implements Alerter {
  readonly #targets: Target[];
  readonly #store: Store;
  readonly #reminderSec: Config["alerts"]["reminderSec"];
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #timers: Timers;
  readonly #afterDelivery: () => void;
  #state: AlertsState;
  #digestSeq = 0;
  /** `drain` calls waiting for every send loop to end. */
  readonly #waiters = new Set<() => void>();
  /** `stop` began: nothing is retried any more. */
  #closing = false;
  /** `stop` ended: nothing is sent any more. */
  #stopped = false;

  constructor(options: AlertManagerOptions) {
    this.#targets = options.sinks.flatMap((sink) =>
      (sink.targets ?? [sink.name]).map(
        (id): Target => ({
          key: targetKey(sink.name, id),
          id,
          sink,
          counts: {ok: 0, failed: 0, retries: 0},
          failures: 0,
          unclassified: 0,
          running: false,
        }),
      ),
    );
    this.#store = options.store;
    this.#reminderSec = options.reminderSec;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? realTimers;
    this.#afterDelivery = options.afterDelivery ?? (() => {});
    const loaded = loadState(
      this.#store.get<unknown>(ALERTS_NAMESPACE, undefined),
      this.#targets.map((target) => ({
        key: target.key,
        sink: target.sink.name,
        admits: (message: OutgoingMessage) => admits(target, message),
      })),
      this.#now(),
    );
    this.#state = loaded.state;
    if (loaded.replaced.length) {
      this.#log.warn("alerts not delivered to targets no longer configured go to the targets added since", {
        targets: loaded.replaced,
      });
    }
    if (loaded.dropped) {
      this.#log.warn("alerts not delivered to targets no longer configured are dropped", {messages: loaded.dropped});
    }
    const undelivered = this.#state.outbox.length + this.#state.queue.length;
    if (undelivered) {
      this.#log.warn("alerts not delivered before the last shutdown are sent again", {messages: undelivered});
    }
    for (const target of this.#targets) {
      const failing = this.#state.targets[target.key]?.failing;
      if (!failing) continue;
      this.#log.warn("alert delivery was failing before the last shutdown, and counts as failing until it delivers", {
        sink: target.sink.name,
        target: target.id,
        failingSince: new Date(failing.since).toISOString(),
        kind: failing.kind,
        error: failing.error,
      });
    }
    if (this.#pruneSent() || loaded.changed) this.#persist();
  }

  emit(alert: Alert): void {
    if (alert.kind === "event") this.#emitEvent(alert);
    else this.#emitCondition(alert);
  }

  sync(scope: string, active: Alert[]): void {
    // One key may appear once per sync; keeping the most severe copy avoids flapping between two severities.
    const byKey = new Map<string, Alert>();
    for (const alert of active) {
      if (!alert.key.startsWith(scope)) {
        this.#log.warn("condition key outside sync scope ignored", {scope, key: alert.key, rule: alert.rule});
        continue;
      }
      const condition: Alert = alert.kind === "condition" ? alert : {...alert, kind: "condition"};
      const previous = byKey.get(alert.key);
      if (previous) {
        this.#log.warn("duplicate condition key in sync", {scope, key: alert.key});
        if (SEVERITY_RANK[previous.severity] >= SEVERITY_RANK[condition.severity]) continue;
      }
      byKey.set(alert.key, condition);
    }
    for (const condition of byKey.values()) this.#emitCondition(condition);
    for (const key of Object.keys(this.#state.open)) {
      if (key.startsWith(scope) && !byKey.has(key)) this.resolve(key);
    }
  }

  resolve(key: string): void {
    const open = this.#state.open[key];
    if (!open) return;
    delete this.#state.open[key];
    this.#log.info("condition resolved", {key, severity: open.alert.severity});
    this.#enqueue({
      alert: open.alert,
      status: "resolved",
      openForSec: this.#openForSec(open),
      ...peakRoute(open, open.alert.severity),
    });
  }

  /**
   * Forgets an open condition without sending anything: for a condition no rule evaluates any more, where a
   * "resolved" message would be a false all-clear. Returns whether it was open.
   */
  drop(key: string): boolean {
    const open = this.#state.open[key];
    if (!open) return false;
    delete this.#state.open[key];
    this.#persist();
    return true;
  }

  /** Queues reminders that are due and forgets expired event keys. Call once per cycle, before `flush()`. */
  tick(): void {
    const now = this.#now();
    let changed = this.#pruneSent();
    for (const open of Object.values(this.#state.open)) {
      const intervalSec = this.#reminderSec[open.alert.severity];
      if (!(intervalSec > 0) || now - open.lastSentAt < intervalSec * 1000) continue;
      open.lastSentAt = now;
      changed = true;
      this.#state.queue.push({alert: open.alert, status: "reminder", openForSec: this.#openForSec(open)});
    }
    if (changed) this.#persist();
  }

  /**
   * Moves the queued messages to the outbox, each for every target that admits it, bounds each target's backlog
   * (`#compact`), persists, and starts delivery in the background for every target with something to send that is
   * neither sending nor waiting for a retry. Never waits for a sink (see `drain` and `stop`), never throws for one.
   */
  flush(): void {
    if (this.#state.queue.length) {
      const at = this.#now();
      for (const message of this.#state.queue) {
        const targets = this.#targets.filter((target) => admits(target, message)).map((target) => target.key);
        if (targets.length) this.#state.outbox.push({message, targets, at});
      }
      this.#state.queue = [];
      for (const target of this.#targets) this.#compact(target);
      this.#persist();
    }
    for (const target of this.#targets) this.#start(target);
  }

  /**
   * Resolves true once no send is in progress (every target delivered what it has, or waits for a retry), or false
   * after `timeoutMs`: a bounded wait for the end of a run (`stop`, the CLI) and for tests.
   */
  drain(timeoutMs: number): Promise<boolean> {
    if (this.#idle()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = () => {
        this.#timers.clearTimeout(handle);
        resolve(true);
      };
      const handle = this.#timers.setTimeout(() => {
        this.#waiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  /**
   * Ends delivery for a shutdown: pending retries are cancelled and nothing is retried any more; sends in progress get
   * up to `timeoutMs` (a target that is delivering goes on with its next messages meanwhile); then nothing more is
   * sent. Whatever is left stays in the outbox for the next start. Returns the messages left (not delivered to every
   * target they are for).
   */
  async stop(timeoutMs: number): Promise<number> {
    this.#closing = true;
    for (const target of this.#targets) {
      if (!target.retry) continue;
      if (target.retry.handle !== undefined) this.#timers.clearTimeout(target.retry.handle);
      target.retry.handle = undefined;
    }
    await this.drain(timeoutMs);
    this.#stopped = true;
    return this.#state.outbox.length;
  }

  /** Currently open conditions (copies), oldest first. */
  openConditions(): OpenCondition[] {
    return Object.values(this.#state.open)
      .map((open) => structuredClone(open))
      .sort((a, b) => a.openedAt - b.openedAt);
  }

  /** Messages waiting for the next `flush()`. */
  get pending(): number {
    return this.#state.queue.length;
  }

  /** Deliveries per sink name and target id (copies): counts since start, failures and backlogs. */
  get stats(): Record<string, DeliveryStats> {
    const result: Record<string, DeliveryStats> = {};
    for (const target of this.#targets) {
      const entries = this.#state.outbox.filter((entry) => entry.targets.includes(target.key));
      const failing = this.#state.targets[target.key]?.failing;
      const stats: TargetStats = {...target.counts, undelivered: entries.length};
      if (entries.length) stats.oldestUndeliveredAt = Math.min(...entries.map((entry) => entry.at));
      if (failing) stats.failing = {...failing};
      const sink = (result[target.sink.name] ??= {ok: 0, failed: 0, retries: 0, targets: {}});
      sink.targets[target.id] = stats;
      sink.ok += stats.ok;
      sink.failed += stats.failed;
      sink.retries += stats.retries;
      if (!failing) continue;
      const worst = sink.failing;
      if (!worst || failing.since < worst.since) {
        sink.failing = {...failing, severity: higher(failing.severity, worst?.severity ?? "info")};
      } else worst.severity = higher(worst.severity, failing.severity);
    }
    return result;
  }

  #emitEvent(alert: Alert): void {
    if (this.#state.sent[alert.key] !== undefined) {
      this.#log.debug("duplicate event alert skipped", {key: alert.key});
      return;
    }
    this.#state.sent[alert.key] = this.#now();
    this.#log.info("event alert", {key: alert.key, severity: alert.severity, rule: alert.rule, title: alert.title});
    this.#enqueue({alert, status: "firing"});
  }

  #emitCondition(alert: Alert): void {
    const now = this.#now();
    const open = this.#state.open[alert.key];
    if (!open) {
      this.#state.open[alert.key] = {
        alert: structuredClone(alert),
        openedAt: now,
        lastSentAt: now,
        peakSeverity: alert.severity,
      };
      this.#log.info("condition opened", {key: alert.key, severity: alert.severity, title: alert.title});
      this.#enqueue({alert, status: "firing"});
      return;
    }
    if (open.alert.severity !== alert.severity) {
      this.#log.info("condition severity changed", {key: alert.key, from: open.alert.severity, to: alert.severity});
      // A downgrade still reaches the routes that were paged at the peak; later reminders follow the new severity.
      const route = peakRoute(open, alert.severity);
      if (SEVERITY_RANK[alert.severity] > SEVERITY_RANK[open.peakSeverity ?? open.alert.severity]) {
        open.peakSeverity = alert.severity;
      } else open.peakSeverity ??= open.alert.severity;
      open.alert = structuredClone(alert);
      open.lastSentAt = now;
      this.#enqueue({alert, status: "firing", ...route});
      return;
    }
    // Still open at the same severity: nothing to send (reminders come from tick()), but keep the content current
    // without dirtying the store on every poll when nothing changed.
    if (JSON.stringify(open.alert) !== JSON.stringify(alert)) {
      open.alert = structuredClone(alert);
      this.#persist();
    }
  }

  #openForSec(open: OpenCondition): number {
    return Math.max(0, Math.floor((this.#now() - open.openedAt) / 1000));
  }

  /** Drops event keys older than the dedupe window. Returns whether anything was removed. */
  #pruneSent(): boolean {
    const cutoff = this.#now() - EVENT_DEDUPE_MS;
    let changed = false;
    for (const [key, at] of Object.entries(this.#state.sent)) {
      if (at < cutoff) {
        delete this.#state.sent[key];
        changed = true;
      }
    }
    return changed;
  }

  #persist(): void {
    this.#store.set(ALERTS_NAMESPACE, this.#state);
  }

  /** Queues `message` and persists it with the change that caused it (made by the caller just before). */
  #enqueue(message: OutgoingMessage): void {
    this.#state.queue.push(message);
    this.#persist();
  }

  // --- delivery ----------------------------------------------------------------------------------------------------

  /** The target's oldest entry it has yet to deliver. */
  #head(target: Target): OutboxEntry | undefined {
    return this.#state.outbox.find((entry) => entry.targets.includes(target.key));
  }

  #undelivered(target: Target): number {
    return this.#state.outbox.filter((entry) => entry.targets.includes(target.key)).length;
  }

  #stored(target: Target): StoredTarget {
    return (this.#state.targets[target.key] ??= {});
  }

  #idle(): boolean {
    return this.#targets.every((target) => !target.running);
  }

  /** Starts the target's send loop unless it runs or waits for a retry, has nothing to send, or delivery stopped. */
  #start(target: Target): void {
    if (target.running || target.retry || this.#stopped || !this.#head(target)) return;
    // A retry_after from before a restart still holds.
    const retryAt = this.#state.targets[target.key]?.retryAt;
    if (retryAt !== undefined && retryAt > this.#now()) {
      this.#pause(target, retryAt - this.#now());
      return;
    }
    target.running = true;
    this.#run(target)
      .catch((error: unknown) => {
        this.#log.error("alert delivery loop failed", {
          sink: target.sink.name,
          target: target.id,
          error: redact(String(error)),
        });
      })
      .finally(() => {
        target.running = false;
        // A flush while the loop was ending added work it did not see.
        this.#start(target);
        if (!this.#idle()) return;
        for (const waiter of [...this.#waiters]) {
          this.#waiters.delete(waiter);
          waiter();
        }
      });
  }

  /** Sends the target's entries in order until none is left, a failure pauses it, or delivery is stopped. */
  async #run(target: Target): Promise<void> {
    for (let entry = this.#head(target); entry && !this.#stopped; entry = this.#head(target)) {
      if (entry !== target.attempted) target.unclassified = 0;
      target.attempted = entry;
      const progress: SendProgress = {
        sent: entry.sent?.[target.key] ?? 0,
        onPart: (sent) => this.#sentPart(target, entry, sent),
      };
      try {
        await target.sink.send(entry.message, target.id, progress);
      } catch (error) {
        if (this.#failed(target, entry, error)) continue;
        return;
      }
      this.#delivered(target, entry);
    }
  }

  /** The target accepted the first `sent` parts of the entry's message: saved, so no retry or restart repeats them. */
  #sentPart(target: Target, entry: OutboxEntry, sent: number): void {
    (entry.sent ??= {})[target.key] = sent;
    this.#persist();
    this.#afterDelivery();
  }

  #delivered(target: Target, entry: OutboxEntry): void {
    target.counts.ok++;
    target.failures = 0;
    target.attempted = undefined;
    this.#release(entry, target.key);
    const stored = this.#stored(target);
    delete stored.retryAt;
    const {failing} = stored;
    if (failing && SEVERITY_RANK[routeSeverity(entry.message)] >= SEVERITY_RANK[failing.severity]) {
      delete stored.failing;
      target.warned = undefined;
      this.#log.info("alert delivery recovered", {
        sink: target.sink.name,
        target: target.id,
        failingForSec: Math.max(0, Math.floor((this.#now() - failing.since) / 1000)),
        undelivered: this.#undelivered(target),
      });
    }
    this.#persist();
    this.#afterDelivery();
  }

  /**
   * A failed attempt at the target's oldest entry: drops it for this target ("message", or unclassified too often) or
   * keeps it and pauses the target for a retry. Either way the target is failing. Returns whether it was dropped.
   */
  #failed(target: Target, entry: OutboxEntry, error: unknown): boolean {
    const now = this.#now();
    const {message} = entry;
    const severity = routeSeverity(message);
    const classified = error instanceof DeliveryError ? error : undefined;
    const kind = classified?.kind ?? "unclassified";
    const text = redact(error instanceof Error ? error.message : String(error));
    if (!classified) target.unclassified++;
    const drop = kind === "message" || target.unclassified >= MAX_UNCLASSIFIED_ATTEMPTS;
    const stored = this.#stored(target);
    const previous = stored.failing;
    // While a more severe message dropped earlier keeps the target failing, that stays the cause shown.
    const cause: Pick<DeliveryFailure, "error" | "kind"> =
      previous && SEVERITY_RANK[severity] < SEVERITY_RANK[previous.severity] ? previous : {error: text, kind};
    stored.failing = {
      since: previous?.since ?? now,
      severity: higher(severity, previous?.severity ?? severity),
      error: cause.error,
      kind: cause.kind,
    };
    const fields = {
      sink: target.sink.name,
      target: target.id,
      key: message.alert.key,
      status: message.status,
      kind,
      error: text,
    };
    if (drop) {
      target.counts.failed++;
      target.failures = 0;
      target.attempted = undefined;
      delete stored.retryAt;
      this.#release(entry, target.key);
      this.#log.error("alert dropped for a target that cannot take it", fields);
    } else {
      target.counts.retries++;
      target.failures++;
      const backoff = Math.min(RETRY_BASE_MS * 2 ** (target.failures - 1), RETRY_MAX_MS);
      const retryAfter = classified?.retryAfterMs;
      // Not a positive number: no wait asked for. Beyond RETRY_AFTER_MAX_MS: cut to it.
      const wait = retryAfter !== undefined && retryAfter > 0 ? Math.min(retryAfter, RETRY_AFTER_MAX_MS) : 0;
      const delay = Math.max(backoff, wait);
      if (retryAfter !== undefined) stored.retryAt = now + delay;
      else delete stored.retryAt;
      const detail = {...fields, undelivered: this.#undelivered(target), retryInMs: delay};
      if (!classified) {
        this.#log.error("alert delivery failed with an unclassified error, retrying", {
          ...detail,
          attempts: target.unclassified,
        });
      } else if (target.warned !== kind) {
        // Once per outage (or change of cause) and process; the retries are logged at debug level.
        target.warned = kind;
        this.#log.warn(
          kind === "route"
            ? "alert delivery failing: the route needs a fix (bot token, chat id, the bot's membership or rights); " +
                "its alerts are kept and retried"
            : "alert delivery failing; its alerts are kept and retried with backoff",
          detail,
        );
      } else this.#log.debug("alert delivery retry failed", detail);
      this.#pause(target, delay);
    }
    this.#persist();
    this.#afterDelivery();
    return drop;
  }

  /**
   * Retries the target in `delayMs`; while stopping it stays paused instead (its messages wait for the next start). A
   * wait beyond setTimeout's range wakes up early, and `#start` pauses again until the stored `retryAt`.
   */
  #pause(target: Target, delayMs: number): void {
    const handle = this.#closing
      ? undefined
      : this.#timers.setTimeout(
          () => {
            target.retry = undefined;
            this.#start(target);
          },
          Math.min(delayMs, MAX_TIMER_MS),
        );
    target.retry = {at: this.#now() + delayMs, handle};
  }

  /** `key`'s target is done with `entry` (delivered or dropped it); once every target is, it leaves the outbox. */
  #release(entry: OutboxEntry, key: string): void {
    entry.targets = entry.targets.filter((other) => other !== key);
    if (entry.sent) {
      delete entry.sent[key];
      if (!Object.keys(entry.sent).length) delete entry.sent;
    }
    if (!entry.targets.length) this.#state.outbox = this.#state.outbox.filter((other) => other !== entry);
  }

  /**
   * Bounds a target's backlog (a burst, or anything raised while it is down):
   * - A reminder supersedes an earlier reminder of the same condition the target has not delivered yet.
   * - More than DIGEST_THRESHOLD info/warning messages are folded into one digest message (merged with a digest left
   *   from an earlier fold) for this target alone, placed where the first of them was. Critical and high messages (by
   *   routing severity) always stay individual and in order, and so does an info/warning message about an alert key
   *   that has a critical/high message between the first folded message and itself: the digest goes before that one,
   *   and must not show the condition in a later state than the critical/high message after it does.
   * The entry the target is sending or retrying, or has taken part of, is never touched. What stays unbounded is
   * critical/high messages: state transitions and events, one reminder per open condition.
   */
  #compact(target: Target): void {
    const entries = this.#state.outbox.filter(
      (entry) => entry !== target.attempted && !entry.sent?.[target.key] && entry.targets.includes(target.key),
    );
    const reminded = new Set<string>();
    const live: OutboxEntry[] = [];
    for (const entry of entries.reverse()) {
      const {alert, status} = entry.message;
      if (status === "reminder" && reminded.has(alert.key)) {
        this.#release(entry, target.key);
        continue;
      }
      if (status === "reminder") reminded.add(alert.key);
      live.unshift(entry);
    }

    const folded: OutboxEntry[] = [];
    const after = new Set<string>();
    for (const entry of live) {
      const {key} = entry.message.alert;
      if (isMajor(entry.message)) {
        if (folded.length) after.add(key);
      } else if (!after.has(key)) folded.push(entry);
    }
    const first = folded[0];
    if (!first || folded.length <= DIGEST_THRESHOLD) return;
    const content: DigestContent = {total: 0, severity: "info", counts: {}, lines: [], more: 0};
    for (const entry of folded) foldInto(content, entry);
    const digest: OutboxEntry = {message: this.#digestMessage(content), targets: [target.key], at: first.at};
    digest.digest = content;
    this.#state.outbox.splice(this.#state.outbox.indexOf(first), 0, digest);
    for (const entry of folded) this.#release(entry, target.key);
  }

  #digestMessage(content: DigestContent): OutgoingMessage {
    const lines = content.lines.map((line) => line.text);
    if (content.more) lines.push(`… and ${content.more} more`);
    return {
      alert: {
        key: `digest:${this.#now()}:${this.#digestSeq++}`,
        kind: "event",
        // The highest severity it contains, so routes with minSeverity "warning" still receive it.
        severity: content.severity,
        rule: "digest",
        title: `${content.total} info/warning alerts (digest)`,
        fields: Object.entries(content.counts).map(([label, count]) => ({label, value: String(count)})),
        note: lines.join("\n"),
      },
      status: "firing",
    };
  }
}

/** A target's key in the stored state. */
function targetKey(sink: string, id: string): string {
  return `${sink}:${id}`;
}

function admits(target: Target, message: OutgoingMessage): boolean {
  return target.sink.admits?.(message, target.id) ?? true;
}

/** Routed as critical or high: always delivered individually. */
function isMajor(message: OutgoingMessage): boolean {
  return SEVERITY_RANK[routeSeverity(message)] >= SEVERITY_RANK.high;
}

function higher(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** Adds an outbox entry (a message, or an earlier digest) to a digest's content. */
function foldInto(content: DigestContent, entry: OutboxEntry): void {
  const add = (key: string, text: string, count: number) => {
    const line = content.lines.find((other) => other.key === key);
    if (line) {
      line.text = text;
      line.count += count;
    } else if (content.lines.length < DIGEST_MAX_TITLES) content.lines.push({key, text, count});
    else content.more += count;
  };
  const {digest} = entry;
  if (digest) {
    content.total += digest.total;
    content.severity = higher(content.severity, digest.severity);
    for (const [label, count] of Object.entries(digest.counts)) {
      content.counts[label] = (content.counts[label] ?? 0) + count;
    }
    for (const line of digest.lines) add(line.key, line.text, line.count);
    content.more += digest.more;
    return;
  }
  const {alert, status} = entry.message;
  content.total++;
  content.severity = higher(content.severity, routeSeverity(entry.message));
  const label = `${capitalize(alert.severity)} ${status}`;
  content.counts[label] = (content.counts[label] ?? 0) + 1;
  const chain = alert.chain ? ` ${alert.chain}` : "";
  const suffix = status === "firing" ? "" : ` (${status})`;
  add(alert.key, `• ${alert.severity.toUpperCase()}${chain}: ${alert.title}${suffix}`, 1);
}

interface TargetRef {
  key: string;
  sink: string;
  admits(message: OutgoingMessage): boolean;
}

interface LoadedState {
  state: AlertsState;
  /** Targets no longer configured whose messages went to targets of their sink added since. */
  replaced: string[];
  /** Outbox entries dropped: no configured target is left for them. */
  dropped: number;
  /** The stored namespace needs writing back (its targets changed). */
  changed: boolean;
}

/**
 * Reads the stored namespace for the configured `targets`. An outbox entry from before per-target delivery (`sinks`:
 * sink names) goes to that sink's targets that admit it. A target no longer configured hands its entries to the
 * targets of its sink added since the last start that admit them (e.g. a route whose chatId was fixed after Telegram
 * moved the group to a supergroup); without any, they are dropped for it.
 */
function loadState(raw: unknown, targets: readonly TargetRef[], now: number): LoadedState {
  const state: AlertsState = {sent: {}, open: {}, queue: [], outbox: [], targets: {}};
  for (const target of targets) state.targets[target.key] = {};
  const loaded: LoadedState = {state, replaced: [], dropped: 0, changed: false};
  if (!isRecord(raw)) return loaded;
  if (isRecord(raw.sent)) {
    for (const [key, at] of Object.entries(raw.sent)) if (typeof at === "number") state.sent[key] = at;
  }
  if (isRecord(raw.open)) {
    for (const [key, open] of Object.entries(raw.open)) {
      if (!isRecord(open) || !isRecord(open.alert)) continue;
      if (typeof open.openedAt !== "number" || typeof open.lastSentAt !== "number") continue;
      state.open[key] = {alert: open.alert as unknown as Alert, openedAt: open.openedAt, lastSentAt: open.lastSentAt};
      if (typeof open.peakSeverity === "string" && open.peakSeverity in SEVERITY_RANK) {
        state.open[key].peakSeverity = open.peakSeverity as Severity;
      }
    }
  }
  if (Array.isArray(raw.queue)) {
    for (const message of raw.queue) if (isMessage(message)) state.queue.push(message);
  }
  const stored = isRecord(raw.targets) ? raw.targets : undefined;
  const configured = new Set(targets.map((target) => target.key));
  const added = stored ? targets.filter((target) => !(target.key in stored)) : [];
  const replaced = new Set<string>();
  if (Array.isArray(raw.outbox)) {
    for (const entry of raw.outbox) {
      if (!isRecord(entry) || !isMessage(entry.message)) continue;
      const {message} = entry;
      let keys: string[];
      if (Array.isArray(entry.targets)) {
        const listed = entry.targets.filter((key): key is string => typeof key === "string");
        keys = listed.filter((key) => configured.has(key));
        for (const gone of listed.filter((key) => !configured.has(key))) {
          const sink = gone.slice(0, gone.indexOf(":"));
          const heirs = added.filter((target) => target.sink === sink && target.admits(message));
          if (heirs.length) replaced.add(gone);
          for (const heir of heirs) if (!keys.includes(heir.key)) keys.push(heir.key);
        }
      } else if (Array.isArray(entry.sinks)) {
        const sinks: unknown[] = entry.sinks;
        keys = targets
          .filter((target) => sinks.includes(target.sink) && target.admits(message))
          .map((target) => target.key);
      } else continue;
      if (!keys.length) {
        loaded.dropped++;
        continue;
      }
      const restored: OutboxEntry = {message, targets: keys, at: typeof entry.at === "number" ? entry.at : now};
      if (isDigestContent(entry.digest)) restored.digest = entry.digest;
      // Parts taken by a target that is still configured (a target's heir has taken none).
      const sent = Object.entries(isRecord(entry.sent) ? entry.sent : {}).filter(
        (pair): pair is [string, number] => keys.includes(pair[0]) && Number.isInteger(pair[1]) && Number(pair[1]) > 0,
      );
      if (sent.length) restored.sent = Object.fromEntries(sent);
      state.outbox.push(restored);
    }
  }
  for (const target of targets) {
    const saved = stored?.[target.key];
    if (!isRecord(saved)) continue;
    if (isFailure(saved.failing)) state.targets[target.key]!.failing = saved.failing;
    if (typeof saved.retryAt === "number" && Number.isFinite(saved.retryAt)) {
      state.targets[target.key]!.retryAt = Math.min(saved.retryAt, now + RETRY_AFTER_MAX_MS);
    }
  }
  loaded.replaced = [...replaced];
  loaded.changed = !stored || Object.keys(stored).sort().join("\n") !== [...configured].sort().join("\n");
  return loaded;
}

/** A stored message that can still be routed and rendered. */
function isMessage(value: unknown): value is OutgoingMessage {
  if (!isRecord(value) || !isRecord(value.alert)) return false;
  const {alert, status, routeSeverity: route} = value;
  return (
    typeof alert.key === "string" &&
    typeof alert.title === "string" &&
    typeof alert.severity === "string" &&
    alert.severity in SEVERITY_RANK &&
    (route === undefined || (typeof route === "string" && route in SEVERITY_RANK)) &&
    (status === "firing" || status === "reminder" || status === "resolved")
  );
}

function isFailure(value: unknown): value is DeliveryFailure {
  return (
    isRecord(value) &&
    typeof value.since === "number" &&
    typeof value.error === "string" &&
    typeof value.severity === "string" &&
    value.severity in SEVERITY_RANK &&
    FAILURE_KINDS.some((kind) => kind === value.kind)
  );
}

function isDigestContent(value: unknown): value is DigestContent {
  return (
    isRecord(value) &&
    typeof value.total === "number" &&
    typeof value.more === "number" &&
    typeof value.severity === "string" &&
    value.severity in SEVERITY_RANK &&
    isRecord(value.counts) &&
    Object.values(value.counts).every((count) => typeof count === "number") &&
    Array.isArray(value.lines) &&
    value.lines.every(
      (line) =>
        isRecord(line) &&
        typeof line.key === "string" &&
        typeof line.text === "string" &&
        typeof line.count === "number",
    )
  );
}

/** `routeSeverity` for a message about `open` at `severity`, when the condition was more severe before. */
function peakRoute(open: OpenCondition, severity: Severity): Pick<OutgoingMessage, "routeSeverity"> {
  const peak = open.peakSeverity ?? open.alert.severity;
  return SEVERITY_RANK[peak] > SEVERITY_RANK[severity] ? {routeSeverity: peak} : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
