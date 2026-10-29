// The daemon: one independent polling loop per chain (scan new confirmed blocks with every event rule, then check every
// state rule at the confirmed head, then replay a few chunks of CCIP blocks the ccip rule skipped), periodic
// reconciliation, the health timer (stale telemetry, daily summary), heartbeat and the /healthz and /metrics server.
// Strictly read-only: only public clients are built.
//
// Telemetry is stale when a chain's scan is (not caught up, or its head not advancing), or when a state rule's reads or
// the replay of a CCIP gap have failed for longer than `staleAfterSec`: how long is tracked per chain in
// `daemon:${chain}` (`reads` per rule, `gapFailures` per gap), so a restart keeps counting. Reconciliation, the only
// reader of the finalized balances, is stale once its runs have been blocked by a failure for longer than
// `reconciliation.staleAfterSec`, tracked in `health` (`reconcile`) the same way. As with failed reads, an age carried
// over a restart counts for /healthz and the heartbeat at once, and for alerts from the first fresh run (check) on.
//
// Persistence: one Store shared by every chain context, the alert manager and reconciliation (the ccip rule joins
// messages across chains through it). A chain's cursor (`daemon:${chain}`) only moves forward over contiguous ranges,
// after every event rule processed the chunk. Undelivered alerts are part of the saved state (the alert manager's
// outbox), so a save at any time is safe: a crash may replay a chunk (rules are idempotent, event alerts are deduped
// by key) and re-send a message whose delivery was not saved yet, but never drops an alert. Alerts are delivered in
// the background: no loop ever waits for Telegram, so an outage of it cannot stall scanning, reconciliation or health.
import type {Server} from "node:http";
import type {AddressInfo} from "node:net";

import {BaseError, zeroAddress, type PublicClient} from "viem";

import {ConsoleSink} from "./alerts/console.ts";
import {AlertManager} from "./alerts/manager.ts";
import {TelegramSink, type FetchLike} from "./alerts/telegram.ts";
import {resolveAddresses} from "./chain/addresses.ts";
import {confirmedHead, createChainClient, createChainContext} from "./chain/client.ts";
import {ccipGaps, readScan} from "./ccip/store.ts";
import {ccipEventsRule} from "./ccip/tracker.ts";
import {chunkRange, fetchLogs} from "./chain/scanner.ts";
import {reconcileStaleAfterSec, type ChainConfig, type Config} from "./config.ts";
import {
  blockingFailures,
  carriedStaleSince,
  chainStale,
  closeServer,
  createStatusServer,
  dailySummaryAlert,
  dueSummaryDate,
  escalateReadFailed,
  failingTargets,
  healthConditions,
  healthScope,
  isStale,
  listen,
  RECONCILE_STALE_KEY,
  reconcileStale,
  reconcileStaleConditions,
  registerHeartbeatSecret,
  sendHeartbeat,
  staleTelemetryKey,
  startupAlert,
  type ChainHealth,
  type GapFailure,
  type MonitorStatus,
  type ReconcileHealth,
  type ReconcileRuns,
  type StartupInfo,
  type StateReads,
} from "./health.ts";
import {redact, registerSecret, type Logger} from "./log.ts";
import {backfillRules, eventRules, stateRules} from "./rules/index.ts";
import {reconcile, RECONCILE_SCOPE, type ReconcileReport} from "./rules/reconcile.ts";
import {readFailedKey} from "./rules/state-common.ts";
import {readPendingOps} from "./rules/timelock.ts";
import {createStore, type Store} from "./store.ts";
import type {
  Alert,
  Alerter,
  AlertSink,
  BlockRange,
  ChainContext,
  EventRule,
  ResolvedAddresses,
  StateRule,
  Timers,
} from "./types.ts";

/** A cycle scans at most this many `maxLogRange` chunks, then checks state at the head and lets the others run. */
export const MAX_CHUNKS_PER_CYCLE = 20;
/** A cycle that caught up then replays at most this many chunks of CCIP blocks the ccip rule skipped. */
export const MAX_GAP_CHUNKS_PER_CYCLE = 5;
/**
 * That replay starts no chunk after this long, and a chunk's log fetch sends no request after this long (requests in
 * flight still complete): live blocks keep priority over history an RPC is slow to serve.
 */
export const GAP_REPLAY_BUDGET_MS = 30_000;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;
export const HEALTH_INTERVAL_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** `stop()` gives alert delivery this long before it saves what is left for the next start. */
export const STOP_DELIVERY_MS = 10_000;
export const HEALTH_NAMESPACE = "health";

export function daemonNamespace(chain: string): string {
  return `daemon:${chain}`;
}

/** The muted replay of `backfillRules` on a fresh state file. */
export interface Backfill {
  from: bigint;
  to: bigint;
  /** Next block to replay; persisted after every chunk so a restart resumes here. */
  next: bigint;
  done: boolean;
}

/** Store namespace `daemon:${chain}`. */
export interface DaemonChainState {
  /** Last fully processed block. */
  cursor?: bigint;
  backfill?: Backfill;
  /** Per state rule id: its last fully successful check and, while its reads fail, since when. */
  reads?: Record<string, StateReads>;
  /** CCIP gaps whose replay is failing, by the first block of the chunk that failed. */
  gapFailures?: Record<string, GapFailure>;
}

/** Store namespace `health`. */
export interface HealthState {
  lastSummaryDate?: string;
  /** The daemon's reconciliation runs, while reconciliation is enabled. */
  reconcile?: ReconcileRuns;
}

export function readChainState(store: Store, chain: string): DaemonChainState {
  return store.get<DaemonChainState>(daemonNamespace(chain), {});
}

export type {Timers};

const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DaemonOptions {
  config: Config;
  log: Logger;
  /** ConsoleSink only (no Telegram, no heartbeat) and an in-memory store. */
  dryRun?: boolean;
  // Injectable for tests.
  /** Clock in unix ms. */
  now?: () => number;
  timers?: Timers;
  /** Default: the state file (in-memory with dryRun). */
  store?: Store;
  /** Default: see `defaultSinks`. */
  sinks?: AlertSink[];
  createClient?: (name: string, chain: ChainConfig) => PublicClient;
  resolve?: typeof resolveAddresses;
  fetchLogs?: typeof fetchLogs;
  reconcile?: typeof reconcile;
  eventRules?: EventRule[];
  stateRules?: StateRule[];
  backfillRules?: EventRule[];
  /** HTTP for Telegram and the heartbeat. Default: global fetch. */
  fetch?: FetchLike;
  /** Console sink output. Default: stdout. */
  out?: (text: string) => void;
}

/**
 * Telegram when configured (not in a dry run), plus the console in a dry run, at debug level, or when Telegram is not
 * configured (a monitor without any sink would only log).
 */
export function defaultSinks(
  config: Config,
  log: Logger,
  options: {dryRun?: boolean; fetch?: FetchLike; out?: (text: string) => void} = {},
): AlertSink[] {
  const sinks: AlertSink[] = [];
  const telegram = options.dryRun ? undefined : config.telegram;
  if (telegram) {
    sinks.push(
      new TelegramSink({
        botToken: telegram.botToken,
        apiUrl: telegram.apiUrl,
        routes: telegram.routes,
        log: log.child({sink: "telegram"}),
        fetch: options.fetch,
      }),
    );
  }
  if (!telegram || config.logLevel === "debug") sinks.push(new ConsoleSink(options.out ? {write: options.out} : {}));
  return sinks;
}

/** Config-only addresses for a context whose chain was not resolved yet; no rule runs before the first resolve. */
export function unresolvedAddresses(chain: ChainConfig): ResolvedAddresses {
  return {
    token: chain.contracts.token,
    registry: chain.contracts.registry,
    registryPool: zeroAddress,
    adapters: [],
    adapterHistory: [],
    pools: [],
    legacyWallets: [],
    endpoints: [],
    labels: {},
  };
}

/** Error text for logs and alerts: viem's short message (its full message lists the RPC URL), redacted. */
export function errorText(error: unknown): string {
  if (error instanceof BaseError) {
    const {shortMessage, details} = error;
    return redact(details && details !== shortMessage ? `${shortMessage} ${details}` : shortMessage);
  }
  return redact(error instanceof Error ? error.message : String(error));
}

/** Drops everything rules raise during the backfill and counts the event alerts it suppressed. */
export class MutedAlerter implements Alerter {
  suppressed = 0;

  emit(alert: Alert): void {
    if (alert.kind === "event") this.suppressed++;
  }

  sync(): void {}

  resolve(): void {}
}

export interface ScanOptions {
  fetchLogs?: typeof fetchLogs;
  /** Called once every rule processed a chunk: record progress here. */
  onChunk?: (chunk: BlockRange) => void | Promise<void>;
  /** Checked before each chunk; true stops the scan early (shutdown). */
  stopped?: () => boolean;
}

/**
 * One chunk: fetches the union of every rule's filters once and hands the logs to every rule in order, also when there
 * are none (flows ages its outflow window there). Filters are recomputed per chunk: the ccip rule requests the ramps
 * it learned at the end of the previous one. Throws on the first failure; the caller must not advance past the chunk.
 * `stopped` ends the log fetch early (a time budget, see `fetchLogs`).
 */
export async function scanChunk(
  ctx: ChainContext,
  rules: readonly EventRule[],
  chunk: BlockRange,
  fetch: typeof fetchLogs = fetchLogs,
  stopped?: () => boolean,
): Promise<number> {
  const filters = rules.flatMap((rule) => rule.filters(ctx));
  const logs = await fetch(ctx.client, filters, chunk, {maxRange: ctx.config.maxLogRange, log: ctx.log, stopped});
  for (const rule of rules) {
    try {
      await rule.onLogs(ctx, logs, chunk);
    } catch (error) {
      throw new Error(`rule ${rule.id} failed on blocks ${chunk.from}-${chunk.to}: ${errorText(error)}`, {
        cause: error,
      });
    }
  }
  return logs.length;
}

/** `range` in ascending `maxLogRange` chunks (see `scanChunk`). */
export async function scanRange(
  ctx: ChainContext,
  rules: readonly EventRule[],
  range: BlockRange,
  options: ScanOptions = {},
): Promise<void> {
  for (const chunk of chunkRange(range, ctx.config.maxLogRange)) {
    if (options.stopped?.()) return;
    await scanChunk(ctx, rules, chunk, options.fetchLogs);
    await options.onChunk?.(chunk);
  }
}

/**
 * Runs `task` again `task`'s returned delay after each run finished, so runs never overlap. `stop()` cancels the wait
 * and awaits a run in progress.
 */
class Loop {
  readonly #timers: Timers;
  readonly #task: () => Promise<number>;
  readonly #fallbackMs: number;
  readonly #log: Logger;
  #handle: unknown;
  #armed = false;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(timers: Timers, log: Logger, fallbackMs: number, task: () => Promise<number>) {
    this.#timers = timers;
    this.#log = log;
    this.#fallbackMs = fallbackMs;
    this.#task = task;
  }

  get started(): boolean {
    return this.#armed || this.#running !== undefined;
  }

  start(delayMs: number): void {
    if (this.#stopped || this.started) return;
    this.#arm(delayMs);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#armed) this.#timers.clearTimeout(this.#handle);
    this.#armed = false;
    await this.#running;
  }

  #arm(delayMs: number): void {
    this.#armed = true;
    this.#handle = this.#timers.setTimeout(() => {
      this.#armed = false;
      this.#run();
    }, delayMs);
  }

  #run(): void {
    this.#running = this.#task()
      .catch((error: unknown) => {
        this.#log.error("loop task failed", {error: errorText(error)});
        return this.#fallbackMs;
      })
      .then((next) => {
        this.#running = undefined;
        if (!this.#stopped) this.#arm(next);
      });
  }
}

interface ChainRuntime {
  name: string;
  chain: ChainConfig;
  ctx: ChainContext;
  log: Logger;
  health: ChainHealth;
  /** Mirror of `daemon:${chain}`; written back with `#persistChain`. */
  state: DaemonChainState;
  /** Block the addresses were last resolved at. */
  resolvedAt?: bigint;
  /** Block the state rules last ran at: they run once per new confirmed head. */
  checkedAt?: bigint;
  /** Highest confirmed head read since the start (`health.headAdvancedAt` is when it last rose). */
  highestHead?: bigint;
  /** Latest snapshot per state rule. */
  snapshots: Record<string, Record<string, string>>;
  startup?: StartupInfo;
  /** Event alerts the muted backfill dropped on this start. */
  suppressed: number;
  inFlight?: Promise<boolean>;
  loop: Loop;
}

export class Daemon {
  readonly config: Config;
  readonly store: Store;
  readonly alerter: AlertManager;
  readonly #log: Logger;
  readonly #dryRun: boolean;
  readonly #now: () => number;
  readonly #timers: Timers;
  readonly #resolve: typeof resolveAddresses;
  readonly #fetchLogs: typeof fetchLogs;
  readonly #reconcile: typeof reconcile;
  readonly #eventRules: readonly EventRule[];
  readonly #stateRules: readonly StateRule[];
  readonly #backfillRules: readonly EventRule[];
  readonly #fetch: FetchLike;
  readonly #chains: ChainRuntime[];
  readonly #bootAt: number;
  readonly #healthLoop: Loop;
  readonly #heartbeatLoop: Loop;
  readonly #reconcileLoop: Loop;
  /** Open conditions dropped at the start (no rule evaluates them any more); listed in the startup message. */
  readonly #dropped: Alert[];
  /** Reconciliation blocked before the start (listed in the startup message). */
  readonly #blockedAtStart: ReconcileHealth | undefined;
  #startupSent = false;
  #report: ReconcileReport | undefined;
  /** Mirror of `health.reconcile`; written back with `#trackReconcile`. */
  #reconcileRuns: ReconcileRuns;
  #reconcileFailures = 0;
  /**
   * A reconciliation run returned in this process. Until then health.reconcile-stale is not synced between runs: the
   * blocked age carried over a restart is old evidence (the RPC may have been fixed during the stop), as a state
   * rule's failed reads are until its next check.
   */
  #reconcileRan = false;
  #reconciling: Promise<ReconcileReport | undefined> | undefined;
  #started = false;
  #stopping = false;
  #stopped: Promise<void> | undefined;
  #server: Server | undefined;
  #address: AddressInfo | undefined;

  constructor(options: DaemonOptions) {
    const {config, log} = options;
    this.config = config;
    this.#log = log;
    this.#dryRun = options.dryRun ?? false;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? realTimers;
    this.#resolve = options.resolve ?? resolveAddresses;
    this.#fetchLogs = options.fetchLogs ?? fetchLogs;
    this.#reconcile = options.reconcile ?? reconcile;
    this.#eventRules = options.eventRules ?? eventRules;
    this.#stateRules = options.stateRules ?? stateRules;
    this.#backfillRules = options.backfillRules ?? backfillRules;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#bootAt = this.#now();

    // parseConfig registered the parts of the RPC URLs that may carry keys; the heartbeat URL is the check's secret.
    for (const chain of Object.values(config.chains)) for (const url of chain.rpcUrls) registerSecret(url);
    registerHeartbeatSecret(config.alerts.heartbeatUrl);

    // One store, one alert manager and one sink set for every chain and for reconciliation.
    this.store = options.store ?? createStore(this.#dryRun ? undefined : config.stateFile);
    this.alerter = new AlertManager({
      sinks: options.sinks ?? defaultSinks(config, log, {dryRun: this.#dryRun, fetch: options.fetch, out: options.out}),
      store: this.store,
      reminderSec: config.alerts.reminderSec,
      log: log.child({component: "alerts"}),
      now: this.#now,
      timers: this.#timers,
      // Records each delivery (and failure) at once: a crash re-sends only a message in flight, also during a long
      // burst, and a failing target stays failing.
      afterDelivery: () => this.#save(),
    });

    // Blocked before the restart: keep counting (a fresh start would send a false RESOLVED); disabled: forgotten.
    const health = this.store.get<HealthState>(HEALTH_NAMESPACE, {});
    if (health.reconcile && !config.reconciliation.enabled) {
      delete health.reconcile;
      this.store.set(HEALTH_NAMESPACE, health);
    }
    this.#reconcileRuns = health.reconcile ?? {};
    this.#blockedAtStart = this.#reconcileRuns.blockedSince === undefined ? undefined : this.#reconcileHealth();
    this.#dropped = this.#dropUnevaluated();
    const open = new Map(this.alerter.openConditions().map((entry) => [entry.alert.key, entry]));

    const ruleIds = new Set(this.#stateRules.map((rule) => rule.id));
    const createClient =
      options.createClient ??
      ((name: string, chain: ChainConfig) =>
        createChainClient(chain, {name, timeoutMs: chain.rpcTimeoutMs, retryCount: chain.rpcRetryCount}));
    this.#chains = Object.entries(config.chains).map(([name, chain]) => {
      const chainLog = log.child({chain: name});
      const ctx = createChainContext({
        name,
        chain,
        global: config,
        client: createClient(name, chain),
        alerter: this.alerter,
        store: this.store,
        log: chainLog,
        addresses: unresolvedAddresses(chain),
      });
      const state = readChainState(this.store, name);
      const pollMs = chain.pollIntervalSec * 1000;
      const loop = new Loop(this.#timers, chainLog, pollMs, async () =>
        (await this.cycle(name)) ? pollMs : this.nextDelayMs(name),
      );
      const runtime: ChainRuntime = {
        name,
        chain,
        ctx,
        log: chainLog,
        state,
        health: {
          chain: name,
          staleAfterSec: chain.staleAfterSec,
          since: this.#bootAt,
          cycleFailures: 0,
          consecutiveFailures: 0,
          cycles: 0,
          successfulCycles: 0,
        },
        snapshots: {},
        suppressed: 0,
        loop,
      };
      runtime.health.processedBlock = processedBlock(state);
      // Failed reads keep counting across a restart (no false recovery); a rule no longer run cannot keep it stale.
      if (state.reads) {
        for (const id of Object.keys(state.reads)) if (!ruleIds.has(id)) delete state.reads[id];
        runtime.health.reads = structuredClone(state.reads);
      }
      runtime.health.ccipGaps = this.#unscannedCcip(runtime);
      // Failed replays keep counting too, while there is anything to replay.
      if (state.gapFailures && chain.ccip.enabled) {
        runtime.health.gapFailures = structuredClone(state.gapFailures);
        const latest = Object.values(state.gapFailures).sort((a, b) => b.failedAt - a.failedAt)[0];
        if (latest) runtime.health.ccipGapError = latest.error;
      } else delete state.gapFailures;
      // Still stale before the restart: keep counting from then (a fresh `since` would send a false RESOLVED), also
      // through a catch-up to a head still frozen at the stored cursor: only a head above it is an advance.
      const stale = open.get(staleTelemetryKey(name));
      if (stale) {
        runtime.health.staleSince = Math.min(this.#bootAt, carriedStaleSince(stale, chain.staleAfterSec));
        runtime.health.headAdvancedAt = runtime.health.staleSince;
        runtime.highestHead = state.cursor;
      }
      return runtime;
    });

    const intervalMs = config.reconciliation.intervalSec * 1000;
    this.#reconcileLoop = new Loop(this.#timers, log, intervalMs, async () => {
      await this.runReconcile();
      return intervalMs;
    });
    this.#healthLoop = new Loop(this.#timers, log, HEALTH_INTERVAL_MS, async () => {
      await this.healthTick();
      return HEALTH_INTERVAL_MS;
    });
    this.#heartbeatLoop = new Loop(this.#timers, log, HEARTBEAT_INTERVAL_MS, async () => {
      await this.heartbeat();
      return HEARTBEAT_INTERVAL_MS;
    });
  }

  /** Every chain context (the order of `config.chains`). */
  get contexts(): ChainContext[] {
    return this.#chains.map((runtime) => runtime.ctx);
  }

  /** The status server's address once listening. */
  get address(): AddressInfo | undefined {
    return this.#address;
  }

  get lastReport(): ReconcileReport | undefined {
    return this.#report;
  }

  get reconcileFailures(): number {
    return this.#reconcileFailures;
  }

  /** Latest state-rule snapshots of a chain, by rule id. */
  snapshots(chain: string): Record<string, Record<string, string>> {
    return structuredClone(this.#runtime(chain).snapshots);
  }

  /** Cached status for /healthz, /metrics and the daily summary. Never awaits anything. */
  status(): MonitorStatus {
    const status: MonitorStatus = {
      now: this.#now(),
      chains: this.#chains.map((runtime) => ({...runtime.health})),
      openConditions: this.alerter.openConditions(),
      deliveries: this.alerter.stats,
      decimals: this.config.token.decimals,
    };
    if (this.#report) status.reconcile = this.#report;
    const runs = this.#reconcileHealth();
    if (runs) status.reconcileHealth = runs;
    return status;
  }

  /** Delay before the next cycle of a chain: the poll interval, doubled per consecutive failure up to 5 minutes. */
  nextDelayMs(chain: string): number {
    const runtime = this.#runtime(chain);
    const failures = runtime.health.consecutiveFailures;
    return Math.min(this.#pollMs(runtime) * 2 ** failures, Math.max(MAX_BACKOFF_MS, this.#pollMs(runtime)));
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    if (this.config.http) {
      this.#server = createStatusServer(() => this.status(), this.#log.child({component: "http"}));
      this.#address = await listen(this.#server, this.config.http.host, this.config.http.port);
      this.#log.info("status server listening", {host: this.#address.address, port: this.#address.port});
    }
    if (!this.alerter.stats.telegram) this.#log.warn("telegram not configured or disabled: alerts go to stdout only");
    this.#log.info("monitor started", {chains: this.#chains.map((runtime) => runtime.name), dryRun: this.#dryRun});
    for (const runtime of this.#chains) runtime.loop.start(0);
    this.#healthLoop.start(HEALTH_INTERVAL_MS);
    if (this.config.alerts.heartbeatUrl && !this.#dryRun) this.#heartbeatLoop.start(HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stops scheduling, waits for running cycles and reconciliation, flushes, gives alert delivery up to
   * STOP_DELIVERY_MS (retries are cancelled; what is not delivered by then stays in the outbox for the next start),
   * saves and closes the status server.
   */
  stop(): Promise<void> {
    this.#stopped ??= (async () => {
      this.#stopping = true;
      await Promise.all([
        ...this.#chains.map((runtime) => runtime.loop.stop()),
        this.#healthLoop.stop(),
        this.#heartbeatLoop.stop(),
        this.#reconcileLoop.stop(),
      ]);
      // Cycles and reconciliations started directly (not by a loop) are awaited too.
      await Promise.all([...this.#chains.map((runtime) => runtime.inFlight), this.#reconciling]);
      this.#commit();
      const left = await this.alerter.stop(STOP_DELIVERY_MS);
      if (left) this.#log.warn("alerts not delivered yet are kept for the next start", {messages: left});
      this.#save();
      if (this.#server) await closeServer(this.#server);
      this.#log.info("monitor stopped");
    })();
    return this.#stopped;
  }

  /**
   * One cycle of a chain: confirmed head -> (first start: backfill) -> resolve addresses -> scan the new blocks ->
   * state rules at the head -> health -> tick -> flush -> save. Never throws; returns whether the cycle succeeded.
   */
  cycle(chain: string): Promise<boolean> {
    const runtime = this.#runtime(chain);
    if (runtime.inFlight) return runtime.inFlight;
    const run = this.#cycle(runtime).finally(() => {
      runtime.inFlight = undefined;
    });
    runtime.inFlight = run;
    return run;
  }

  /**
   * Reconciliation (when enabled) while every chain has caught up since the start and is not stale: balances read
   * from a stuck or lagging RPC are old, and syncing them could resolve conditions that still hold (the last report
   * and its conditions stay as they are). Failed state reads do not skip it: its own reads are fresh or fail on their
   * own (an incomplete report). Returns the report, or undefined when skipped or failed (failures are logged and
   * counted). A run that fails or is blocked by a failure starts or extends the blocked span (`#trackReconcile`), and
   * health.reconcile-stale is synced right after: the first run after a restart pages a carried age at once if it is
   * still blocked, or resolves a condition still open if it is not.
   */
  runReconcile(): Promise<ReconcileReport | undefined> {
    if (!this.config.reconciliation.enabled) return Promise.resolve(undefined);
    const now = this.#now();
    const behind = this.#chains.filter(
      (runtime) => runtime.health.lastCaughtUpAt === undefined || isStale(runtime.health, now),
    );
    if (behind.length) {
      this.#log.debug("reconciliation skipped: a chain is stale or not caught up yet", {
        chains: behind.map((runtime) => runtime.name),
      });
      return Promise.resolve(undefined);
    }
    if (this.#reconciling) return this.#reconciling;
    const run = (async () => {
      const at = this.#now();
      try {
        const report = await this.#reconcile(this.contexts, this.alerter, this.config, {now: this.#now});
        this.#report = report;
        this.#trackReconcile(at, {report});
        this.#log.info("reconciliation", {status: report.status, R: report.R, I: report.I, margin: report.margin});
        return report;
      } catch (error) {
        this.#reconcileFailures++;
        const text = errorText(error);
        this.#trackReconcile(at, {error: text});
        this.#log.error("reconciliation failed", {error: text, failures: this.#reconcileFailures});
        return undefined;
      } finally {
        this.#reconcileRan = true;
        this.#syncReconcileStale();
        this.#commit();
      }
    })().finally(() => {
      this.#reconciling = undefined;
    });
    this.#reconciling = run;
    return run;
  }

  /**
   * Stale-telemetry conditions of every chain (so a hung RPC still raises them) and of reconciliation (between its
   * runs, once one returned in this process: see `#reconcileRan`), the daily summary, then a commit.
   */
  async healthTick(): Promise<void> {
    const now = this.#now();
    for (const runtime of this.#chains) {
      this.alerter.sync(healthScope(runtime.name), healthConditions(runtime.health, now));
    }
    if (this.#reconcileRan) this.#syncReconcileStale();
    this.#maybeDailySummary();
    this.alerter.tick();
    this.#commit();
  }

  /**
   * Pings the heartbeat URL while every chain is caught up and fresh (its scan, every state rule's reads and the replay
   * of its CCIP gaps), reconciliation is not stale and no alert target is failing (a dead Telegram chat must stop the
   * dead-man's switch too, also after a restart: the failure is kept until the target delivers). Returns whether a
   * ping succeeded.
   */
  async heartbeat(): Promise<boolean> {
    const url = this.config.alerts.heartbeatUrl;
    if (!url || this.#dryRun) return false;
    const now = this.#now();
    const fresh = this.#chains.every(
      (runtime) => runtime.health.lastCaughtUpAt !== undefined && !chainStale(runtime.health, now),
    );
    if (!fresh) {
      this.#log.debug("heartbeat skipped: a chain is stale or not caught up yet");
      return false;
    }
    if (reconcileStale(this.#reconcileHealth(), now)) {
      this.#log.debug("heartbeat skipped: reconciliation blocked for longer than its staleAfterSec");
      return false;
    }
    const failing = failingTargets({deliveries: this.alerter.stats});
    if (failing.length) {
      this.#log.debug("heartbeat skipped: alert delivery failing", {targets: failing});
      return false;
    }
    return sendHeartbeat(url, this.#fetch, this.#log.child({component: "heartbeat"}));
  }

  #runtime(chain: string): ChainRuntime {
    const runtime = this.#chains.find((entry) => entry.name === chain);
    if (!runtime) throw new Error(`unknown chain ${chain}`);
    return runtime;
  }

  #pollMs(runtime: ChainRuntime): number {
    return runtime.chain.pollIntervalSec * 1000;
  }

  /** The reconciliation runs with their limit, for the health checks; undefined while reconciliation is disabled. */
  #reconcileHealth(): ReconcileHealth | undefined {
    if (!this.config.reconciliation.enabled) return undefined;
    return {
      ...structuredClone(this.#reconcileRuns),
      staleAfterSec: reconcileStaleAfterSec(this.config.reconciliation),
      failures: this.#reconcileFailures,
    };
  }

  /**
   * Records a run that started at `at`. One that threw or was incomplete for a reason that is a failure
   * (`blockingFailures`: not CCIP tracking disabled by config, not CCIP gaps) starts or extends the blocked span; any
   * other run ends it (a complete one has no blocking reason).
   */
  #trackReconcile(at: number, result: {report: ReconcileReport} | {error: string}): void {
    const runs = this.#reconcileRuns;
    const complete = "report" in result && result.report.status !== "incomplete";
    if (complete) runs.completeAt = at;
    const failures = "report" in result && !complete ? blockingFailures(result.report) : [];
    if ("report" in result && !failures.length) {
      delete runs.blockedSince;
      delete runs.reasons;
      delete runs.error;
    } else {
      runs.blockedSince ??= at;
      if ("error" in result) {
        runs.error = result.error;
        delete runs.reasons;
      } else {
        runs.reasons = failures.map((reason) => reason.reason);
        delete runs.error;
      }
    }
    const state = this.store.get<HealthState>(HEALTH_NAMESPACE, {});
    this.store.set<HealthState>(HEALTH_NAMESPACE, {...state, reconcile: runs});
  }

  /**
   * health.reconcile-stale under its own key; never while reconciliation is disabled (dropped at the start then). After
   * each run, and between runs once one returned in this process.
   */
  #syncReconcileStale(): void {
    const health = this.#reconcileHealth();
    if (health) this.alerter.sync(RECONCILE_STALE_KEY, reconcileStaleConditions(health, this.#now()));
  }

  #persistChain(runtime: ChainRuntime): void {
    this.store.set(daemonNamespace(runtime.name), runtime.state);
    runtime.health.processedBlock = processedBlock(runtime.state);
  }

  async #cycle(runtime: ChainRuntime): Promise<boolean> {
    const {health} = runtime;
    let ok = false;
    let head: bigint | undefined;
    try {
      head = await confirmedHead(runtime.ctx.client, runtime.chain.confirmations);
      health.confirmedHead = head;
      if (runtime.highestHead === undefined || head > runtime.highestHead) {
        runtime.highestHead = head;
        health.headAdvancedAt = this.#now();
      }
      if (runtime.state.cursor === undefined) {
        // Interrupted by a shutdown: the backfill resumes from `backfill.next` on the next start.
        if (!(await this.#bootstrap(runtime, head))) return false;
      } else if (!runtime.startup) {
        runtime.startup = this.#startupInfo(runtime, {cursor: runtime.state.cursor, mode: "resumed"});
      }
      this.#maybeAnnounce();

      const cursor = runtime.state.cursor!;
      if (head < cursor) runtime.log.debug("RPC behind the stored cursor, waiting", {head, cursor});
      const scan = head > cursor;
      // Never below the cursor: an RPC behind it (e.g. after a restart) shows older state, and syncing that would
      // resolve conditions that still hold.
      const check = head >= cursor && (runtime.checkedAt === undefined || head > runtime.checkedAt);
      if (scan || check) await this.#resolveAt(runtime, head);
      if (scan) await this.#scan(runtime, head);
      if (check && !this.#stopping) await this.#checkState(runtime, head);
      // History last, and only once caught up: live blocks keep priority.
      if (!this.#stopping && runtime.state.cursor === head) await this.#fillCcipGaps(runtime);
      ok = true;
    } catch (error) {
      health.cycleFailures++;
      health.consecutiveFailures++;
      health.lastError = errorText(error);
      runtime.log.error("cycle failed", {
        error: health.lastError,
        consecutiveFailures: health.consecutiveFailures,
        retryInMs: this.nextDelayMs(runtime.name),
      });
    } finally {
      this.#finishCycle(runtime, ok, head);
    }
    if (ok) this.#maybeStartReconcile();
    return ok;
  }

  #finishCycle(runtime: ChainRuntime, ok: boolean, head: bigint | undefined): void {
    const {health} = runtime;
    const now = this.#now();
    health.cycles++;
    if (ok) {
      health.successfulCycles++;
      health.consecutiveFailures = 0;
      delete health.lastError;
      // Not with the RPC behind the cursor: nothing past what was already processed could be verified.
      if (head !== undefined && runtime.state.cursor === head) health.lastCaughtUpAt = now;
    }
    health.ccipGaps = this.#unscannedCcip(runtime);
    this.alerter.sync(healthScope(runtime.name), healthConditions(health, now));
    this.#maybeDailySummary();
    this.alerter.tick();
    this.#commit();
  }

  async #resolveAt(runtime: ChainRuntime, block: bigint): Promise<void> {
    if (runtime.resolvedAt === block) return;
    runtime.ctx.addresses = await this.#resolve(runtime.ctx.client, runtime.chain, block, {log: runtime.log});
    runtime.resolvedAt = block;
  }

  /** cursor+1 .. min(head, cursor + 20 chunks); the cursor follows every completed chunk. */
  async #scan(runtime: ChainRuntime, head: bigint): Promise<void> {
    const cursor = runtime.state.cursor!;
    const cap = cursor + BigInt(MAX_CHUNKS_PER_CYCLE) * BigInt(runtime.chain.maxLogRange);
    await scanRange(runtime.ctx, this.#eventRules, {from: cursor + 1n, to: head < cap ? head : cap}, {
      fetchLogs: this.#fetchLogs,
      stopped: () => this.#stopping,
      onChunk: (chunk) => {
        runtime.state.cursor = chunk.to;
        this.#persistChain(runtime);
      },
    });
  }

  /**
   * Every state rule at `head`, each synced under its own scope. A rule that throws is logged and not synced, so its
   * open conditions stay open (neither confirmed nor resolved).
   *
   * Every rule's reads are tracked in `state.reads` (`trackReads`): each read from its first failure until it
   * succeeds, so the rule's failure age is that of its oldest unverified value. The read-failed condition is synced at
   * that age (`escalateReadFailed`: high after staleAfterSec, critical after three times that), and a failure older
   * than staleAfterSec makes the chain stale. Every rule counts: each verifies an authority, a pause, a limit, the
   * Router's ramps or the Timelock queue, and a rule whose reads keep failing cannot be told from one whose subject
   * changed.
   */
  async #checkState(runtime: ChainRuntime, head: bigint): Promise<void> {
    const reads = runtime.state.reads ?? {};
    for (const rule of this.#stateRules) {
      const now = this.#now();
      const key = readFailedKey(runtime.name, rule.id);
      let result: StateCheckResult | undefined;
      try {
        result = await rule.check(runtime.ctx, head);
        runtime.snapshots[rule.id] = result.snapshot;
      } catch (error) {
        runtime.log.error("state rule failed", {rule: rule.id, error: errorText(error)});
      }
      const entry = (reads[rule.id] ??= {});
      trackReads(entry, result, key, now);
      if (!result) continue;
      const {conditions} = result;
      const staleAfterSec = runtime.chain.staleAfterSec;
      this.alerter.sync(
        `${runtime.name}:${rule.id}:`,
        conditions.map((alert) => (alert.key === key ? escalateReadFailed(alert, entry, now, staleAfterSec) : alert)),
      );
    }
    runtime.checkedAt = head;
    if (!Object.keys(reads).length) return;
    runtime.state.reads = reads;
    runtime.health.reads = structuredClone(reads);
    this.#persistChain(runtime);
  }

  /**
   * Replays the CCIP blocks the ccip rule skipped (`ccipGaps`, e.g. while `ccip.enabled` was false), lowest first
   * (failing ones last), at most MAX_GAP_CHUNKS_PER_CYCLE chunks and GAP_REPLAY_BUDGET_MS per cycle, muted like the
   * first-start backfill: what was sent or executed there must be known (reconciliation is incomplete until it is), not
   * paged as new (reconciliation reports the messages still failed or stuck). The rule removes each chunk it scanned
   * from its gaps, so progress is saved with the store. Only the ccip rule: the daemon cursor is contiguous, so no
   * other rule skipped blocks.
   *
   * A chunk that fails is logged without failing the cycle, and its gap is retried after the poll interval, doubled
   * per failure up to MAX_BACKOFF_MS, after the gaps that replay: one gap an RPC cannot serve never holds up the
   * others. Failures are kept in `state.gapFailures` until the chunk replays or leaves the gaps; one older than
   * staleAfterSec raises health.ccip-gap-replay and makes the chain stale.
   */
  async #fillCcipGaps(runtime: ChainRuntime): Promise<void> {
    const rule = this.#eventRules.find((entry) => entry.id === ccipEventsRule.id);
    const gaps = rule && runtime.chain.ccip.enabled ? ccipGaps(this.store, runtime.name) : [];
    // A failure stays while its block still starts a gap (replayed chunks leave the gap).
    const failures = Object.fromEntries(
      Object.entries(runtime.state.gapFailures ?? {}).filter(([block]) => gaps.some((gap) => `${gap.from}` === block)),
    );
    try {
      if (rule && gaps.length) await this.#replayGaps(runtime, rule, gaps, failures);
    } finally {
      const failing = Object.values(failures).sort((a, b) => b.failedAt - a.failedAt);
      const stored = runtime.state.gapFailures !== undefined;
      if (failing.length) {
        runtime.state.gapFailures = failures;
        runtime.health.gapFailures = structuredClone(failures);
        runtime.health.ccipGapError = failing[0]!.error;
      } else {
        delete runtime.state.gapFailures;
        delete runtime.health.gapFailures;
        delete runtime.health.ccipGapError;
      }
      if (stored || failing.length) this.#persistChain(runtime);
    }
  }

  /** The replay of `#fillCcipGaps`: adds each chunk that fails to `failures` and removes each one that replays. */
  async #replayGaps(
    runtime: ChainRuntime,
    rule: EventRule,
    gaps: BlockRange[],
    failures: Record<string, GapFailure>,
  ): Promise<void> {
    const start = this.#now();
    const spent = (since: number) => this.#stopping || this.#now() - since >= GAP_REPLAY_BUDGET_MS;
    const due = gaps
      .map((gap) => ({gap, failure: failures[`${gap.from}`]}))
      .filter(({failure}) => !failure || start >= failure.failedAt + this.#backoffMs(runtime, failure.failures))
      .sort((a, b) => Number(a.failure !== undefined) - Number(b.failure !== undefined));
    const ctx: ChainContext = {...runtime.ctx, alerter: new MutedAlerter()};
    const size = BigInt(runtime.chain.maxLogRange);
    let left = MAX_GAP_CHUNKS_PER_CYCLE;
    let replayed: BlockRange | undefined;
    for (const {gap} of due) {
      const cap = gap.from + BigInt(left) * size - 1n;
      for (const chunk of chunkRange({from: gap.from, to: gap.to < cap ? gap.to : cap}, runtime.chain.maxLogRange)) {
        if (spent(start)) break;
        left--;
        const chunkStart = this.#now();
        try {
          await scanChunk(ctx, [rule], chunk, this.#fetchLogs, () => spent(chunkStart));
        } catch (error) {
          if (this.#stopping) return;
          const previous = failures[`${chunk.from}`];
          const failure: GapFailure = {
            since: previous?.since ?? chunkStart,
            failures: (previous?.failures ?? 0) + 1,
            failedAt: this.#now(),
            error: errorText(error),
          };
          failures[`${chunk.from}`] = failure;
          runtime.log.warn("ccip: replay of skipped blocks failed, retrying with backoff", {
            from: chunk.from,
            to: chunk.to,
            failures: failure.failures,
            retryInMs: this.#backoffMs(runtime, failure.failures),
            error: failure.error,
          });
          break;
        }
        delete failures[`${chunk.from}`];
        replayed = {from: replayed?.from ?? chunk.from, to: chunk.to};
      }
      if (left === 0 || spent(start)) break;
    }
    if (!replayed) return;
    const remaining = ccipGaps(this.store, runtime.name);
    const fields = {
      from: replayed.from,
      to: replayed.to,
      chunks: MAX_GAP_CHUNKS_PER_CYCLE - left,
      remainingGaps: remaining.length,
    };
    if (remaining.length) runtime.log.debug("ccip: replayed skipped blocks", fields);
    else runtime.log.info("ccip: every skipped block replayed; reconciliation can complete", fields);
  }

  /** Wait before retrying a CCIP gap whose replay failed `failures` times in a row: as `nextDelayMs` for cycles. */
  #backoffMs(runtime: ChainRuntime, failures: number): number {
    const pollMs = this.#pollMs(runtime);
    return Math.min(pollMs * 2 ** (failures - 1), Math.max(MAX_BACKOFF_MS, pollMs));
  }

  /**
   * CCIP blocks below the cursor the ccip rule has not scanned, which `#fillCcipGaps` replays: its recorded gaps and,
   * while its cursor lags the daemon's (tracking was disabled, so its next chunk records them as a gap), the blocks in
   * between. None while tracking is disabled.
   */
  #unscannedCcip(runtime: ChainRuntime): BlockRange[] {
    if (!runtime.chain.ccip.enabled) return [];
    const scan = readScan(this.store, runtime.name);
    const gaps = scan.gaps.map((gap) => ({from: gap.from, to: gap.to}));
    const cursor = runtime.state.cursor;
    if (scan.cursor && cursor !== undefined && scan.cursor.to < cursor) {
      gaps.push({from: scan.cursor.to + 1n, to: cursor});
    }
    return gaps;
  }

  /**
   * First start on this state file. With `startBlock` at or below the confirmed head, replays only the backfill rules
   * (Timelock, CCIP) over [startBlock, head] with a muted alerter, persisting `backfill.next` after each chunk; then
   * cursor = head. Without, cursor = head - 1 and nothing earlier is tracked. Returns false when stopped midway.
   */
  async #bootstrap(runtime: ChainRuntime, head: bigint): Promise<boolean> {
    const {chain, state} = runtime;
    let backfill = state.backfill;
    let resumedAt: bigint | undefined;
    if (backfill) {
      resumedAt = backfill.next;
    } else {
      const startBlock = chain.startBlock;
      if (startBlock === undefined || BigInt(startBlock) > head) {
        if (startBlock !== undefined) {
          runtime.log.warn("startBlock is above the confirmed head, ignored", {startBlock, head});
        }
        state.cursor = head - 1n;
        this.#persistChain(runtime);
        runtime.startup = this.#startupInfo(runtime, {
          cursor: state.cursor,
          mode: "fresh",
          ...(startBlock !== undefined ? {ignoredStartBlock: startBlock} : {}),
        });
        runtime.log.info("first start without backfill", {cursor: state.cursor});
        return true;
      }
      backfill = {from: BigInt(startBlock), to: head, next: BigInt(startBlock), done: false};
      state.backfill = backfill;
      this.#persistChain(runtime);
    }

    // At the current head, not `backfill.to`: a resumed backfill's end may be older than a pruned node keeps state.
    await this.#resolveAt(runtime, head);
    // A separate context: the muted alerter can never leak into the normal cycles through ctx.alerter.
    const muted = new MutedAlerter();
    const ctx: ChainContext = {...runtime.ctx, alerter: muted};
    const current = backfill;
    runtime.health.backfill = {next: current.next, to: current.to};
    runtime.log.info("backfill", {from: current.next, to: current.to, resumed: resumedAt !== undefined});
    try {
      await scanRange(ctx, this.#backfillRules, {from: current.next, to: current.to}, {
        fetchLogs: this.#fetchLogs,
        stopped: () => this.#stopping,
        onChunk: (chunk) => {
          current.next = chunk.to + 1n;
          runtime.health.backfill = {next: current.next, to: current.to};
          this.#persistChain(runtime);
          this.#commit();
        },
      });
    } finally {
      runtime.suppressed += muted.suppressed;
    }
    if (current.next <= current.to) return false;

    current.done = true;
    delete runtime.health.backfill;
    state.cursor = current.to;
    this.#persistChain(runtime);
    runtime.startup = this.#startupInfo(runtime, {
      cursor: current.to,
      mode: "backfill",
      backfill: {from: current.from, to: current.to, ...(resumedAt !== undefined ? {resumedAt} : {})},
    });
    runtime.log.info("backfill complete", {from: current.from, to: current.to, suppressed: runtime.suppressed});
    return true;
  }

  #startupInfo(
    runtime: ChainRuntime,
    info: Pick<StartupInfo, "cursor" | "mode" | "backfill" | "ignoredStartBlock">,
  ): StartupInfo {
    const stored = runtime.state.backfill;
    const backfill = info.backfill ?? (stored ? {from: stored.from, to: stored.to} : undefined);
    const result: StartupInfo = {
      chain: runtime.name,
      cursor: info.cursor,
      mode: info.mode,
      pendingTimelockOps: 0,
      suppressed: runtime.suppressed,
    };
    if (backfill) result.backfill = backfill;
    if (info.ignoredStartBlock !== undefined) result.ignoredStartBlock = info.ignoredStartBlock;
    return result;
  }

  /** The startup message, once every chain has its starting cursor. */
  #maybeAnnounce(): void {
    if (this.#startupSent || this.#chains.some((runtime) => !runtime.startup)) return;
    this.#startupSent = true;
    const infos = this.#chains.map((runtime) => {
      const ops = Object.values(readPendingOps(this.store, runtime.name));
      const gaps = this.#unscannedCcip(runtime);
      return {
        ...runtime.startup!,
        pendingTimelockOps: ops.filter((op) => op.status === "pending").length,
        ...(gaps.length ? {ccipGaps: gaps} : {}),
      };
    });
    const options = {dryRun: this.#dryRun, dropped: this.#dropped, reconcile: this.#blockedAtStart};
    this.alerter.emit(startupAlert(this.#bootAt, infos, options));
  }

  /**
   * Drops (without a "resolved" message, which would be a false all-clear) the open conditions no rule evaluates any
   * more, which would otherwise be reminded forever: those of a chain removed from (or renamed in) `chains`, of
   * reconciliation when disabled, and of the CCIP rule on a chain with `ccip.enabled: false`. Also
   * health.reconcile-stale without a persisted blocked span (a state file from before it was kept): the first run
   * would resolve it whatever it finds, its blocked span starting again at 0.
   */
  #dropUnevaluated(): Alert[] {
    const dropped: Alert[] = [];
    for (const {alert} of this.alerter.openConditions()) {
      if (this.#evaluated(alert.key) || !this.alerter.drop(alert.key)) continue;
      dropped.push(alert);
    }
    if (dropped.length) {
      this.#log.warn("dropped open conditions that are no longer evaluated", {keys: dropped.map(({key}) => key)});
    }
    return dropped;
  }

  #evaluated(key: string): boolean {
    if (key.startsWith(RECONCILE_SCOPE)) return this.config.reconciliation.enabled;
    if (key === RECONCILE_STALE_KEY) {
      return this.config.reconciliation.enabled && this.#reconcileRuns.blockedSince !== undefined;
    }
    const [chain = "", rule] = key.split(":");
    if (chain === "global") return true;
    const config = this.config.chains[chain];
    if (!config) return false;
    return rule !== ccipEventsRule.id || config.ccip.enabled;
  }

  #maybeStartReconcile(): void {
    if (!this.#started || this.#stopping || !this.config.reconciliation.enabled || this.#reconcileLoop.started) return;
    if (this.#chains.some((runtime) => runtime.health.lastCaughtUpAt === undefined)) return;
    this.#reconcileLoop.start(0);
  }

  /** Once per UTC day at or after `alerts.dailySummaryUtc`, after every chain finished a first cycle. */
  #maybeDailySummary(): void {
    const now = this.#now();
    const state = this.store.get<HealthState>(HEALTH_NAMESPACE, {});
    const date = dueSummaryDate(now, this.config.alerts.dailySummaryUtc, state.lastSummaryDate);
    if (!date || this.#chains.some((runtime) => runtime.health.cycles === 0)) return;
    const snapshots = Object.fromEntries(this.#chains.map((runtime) => [runtime.name, runtime.snapshots]));
    this.alerter.emit(dailySummaryAlert({date, status: this.status(), snapshots, config: this.config}));
    this.store.set<HealthState>(HEALTH_NAMESPACE, {...state, lastSummaryDate: date});
  }

  /**
   * Flushes (the queued alerts move to the outbox and go out in the background), then saves, also while earlier
   * messages are still in delivery: every message a target has not taken yet is in the saved state (the alert
   * manager's outbox) and is delivered after a restart. Each delivery is saved as it happens (`afterDelivery`). Never
   * waits for a sink.
   */
  #commit(): void {
    this.alerter.flush();
    this.#save();
  }

  #save(): void {
    try {
      this.store.save();
    } catch (error) {
      this.#log.error("cannot save the state file", {error: errorText(error)});
    }
  }
}

type StateCheckResult = Awaited<ReturnType<StateRule["check"]>>;

/** Every read of a state rule, as `StateReads.failing` names a rule failing as a whole. */
const ALL_READS = "*";

/**
 * Updates a state rule's `StateReads` with one check (`result` undefined: the rule threw). A failed read counts from
 * its first failure until it succeeds; one the check did not make (e.g. made only with a value that failed) keeps
 * counting. A check that threw, ended early or names no reads but returned its read-failed condition (`failedKey`)
 * counts as every read failing, so a read failing after it counts from then at the latest. A check without any
 * failure ends every failure.
 */
function trackReads(
  entry: StateReads,
  result: StateCheckResult | undefined,
  failedKey: string,
  now: number,
): void {
  // A state file from before per-read tracking: the rule's failure as a whole.
  const failing = entry.failing ?? (entry.failingSince === undefined ? {} : {[ALL_READS]: entry.failingSince});
  const reads = result?.reads;
  let clean = false;
  if (reads) {
    for (const read of reads.ok) delete failing[read];
    for (const read of reads.failed) failing[read] ??= failing[ALL_READS] ?? now;
    if (reads.complete) delete failing[ALL_READS];
    else failing[ALL_READS] ??= now;
    clean = reads.complete && !reads.failed.length;
  } else if (result && !result.conditions.some((alert) => alert.key === failedKey)) {
    clean = true;
  } else {
    failing[ALL_READS] ??= now;
  }
  const since = clean ? [] : Object.values(failing);
  if (since.length) {
    entry.failing = failing;
    entry.failingSince = Math.min(...since);
  } else {
    entry.okAt = now;
    delete entry.failing;
    delete entry.failingSince;
  }
}

function processedBlock(state: DaemonChainState): bigint | undefined {
  if (state.cursor !== undefined) return state.cursor;
  return state.backfill && state.backfill.next > state.backfill.from ? state.backfill.next - 1n : undefined;
}
