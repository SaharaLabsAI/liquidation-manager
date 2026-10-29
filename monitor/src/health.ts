// Health of the daemon: the stale-telemetry condition, the escalation of failed state reads, /healthz and /metrics, the
// heartbeat (dead-man's switch) and the startup and daily summary messages. Everything here works on a cached status
// snapshot the daemon keeps current: the HTTP handlers never wait on RPC or alert delivery, so a hung RPC still shows
// up as stale instead of a hung probe.
//
// A chain is stale (/healthz 503, heartbeat withheld) when its scan is (`isStale`: not caught up, or the head not
// advancing), when a state rule's reads have failed for longer than `staleAfterSec` (`readsStale`), or when the replay
// of CCIP blocks its ccip rule skipped has failed for that long (`ccipGapReplayStale`: the in-flight amount I cannot
// be bounded). Together they bound how old any verified state is: state rules run at every new confirmed head, so
// while the head advances the reads are attempted, and while it does not the scan goes stale. Reconciliation, which
// alone reads the finalized balances, is stale the same way once its runs have been blocked by a failure for longer
// than `reconciliation.staleAfterSec` (`reconcileStale`).
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";

import {formatUnits} from "viem";

import type {DeliveryFailure, DeliveryStats, OpenCondition, TargetStats} from "./alerts/manager.ts";
import type {FetchLike} from "./alerts/telegram.ts";
import type {Config} from "./config.ts";
import {formatAmount, formatDuration, formatTimestamp} from "./format.ts";
import {redact, registerSecret, type Logger} from "./log.ts";
import type {IncompleteCause, IncompleteReason, ReconcileReport} from "./rules/reconcile.ts";
import {INVENTORY_RULE, MANAGER_RULE} from "./rules/state.ts";
import type {Alert, AlertField, BlockRange, Severity} from "./types.ts";

export const STALE_RULE = "health.stale-telemetry";
export const CCIP_GAP_RULE = "health.ccip-gap-replay";
export const RECONCILE_STALE_RULE = "health.reconcile-stale";
/** The health.reconcile-stale condition, and its sync scope: the other "global:health:" keys are not synced. */
export const RECONCILE_STALE_KEY = "global:health:reconcile-stale";
export const STARTED_RULE = "health.started";
export const SUMMARY_RULE = "health.daily-summary";
const QUEUE_RULE = "timelock-queue";

const SEVERITIES: Severity[] = ["critical", "high", "warning", "info"];

/** Design §5's response, in the note of every health condition that means stale telemetry. */
const PAUSE_RECALL =
  "Design §5: disable recall when in-flight obligations cannot be bounded or telemetry is stale: the Guardian calls " +
  "LiquidityManager.pauseRecall() on each chain's Manager (re-enabling is a Timelock operation, " +
  "setRecallPaused(false)).";

/** Sync scope of a chain's health conditions. */
export function healthScope(chain: string): string {
  return `${chain}:health:`;
}

export function staleTelemetryKey(chain: string): string {
  return `${healthScope(chain)}stale-telemetry`;
}

/** One state rule's reads on a chain (store namespace `daemon:${chain}`, so a restart keeps counting). Unix ms. */
export interface StateReads {
  /** Last check whose reads all succeeded. */
  okAt?: number;
  /** The earliest of `failing`: how long the rule's oldest unverified value has gone unread; unset while none fails. */
  failingSince?: number;
  /**
   * Each failing read (as StateRule `reads` names it) since its first failure, until it succeeds or a check has no
   * failure at all; "*" for the rule as a whole (it threw, ended early or names no reads).
   */
  failing?: Record<string, number>;
}

/**
 * A CCIP gap whose replay failed, by the first block of the chunk that failed (store namespace `daemon:${chain}`, so a
 * restart keeps counting). Unix ms.
 */
export interface GapFailure {
  /** First failed replay since the chunk last replayed. */
  since: number;
  /** Failed replays in a row (the backoff doubles per failure). */
  failures: number;
  failedAt: number;
  /** Redacted. */
  error: string;
}

/** What the daemon knows about one chain's polling loop. Times are unix ms. */
export interface ChainHealth {
  chain: string;
  staleAfterSec: number;
  /** When the daemon started watching: staleness counts from here until the first catch-up. */
  since: number;
  /**
   * A stale-telemetry condition still open at the start: staleness counts from here (its openedAt − staleAfterSec)
   * instead of `since` until the first catch-up, so a restart neither resolves nor downgrades it.
   */
  staleSince?: number;
  /** Last fully processed block (the daemon cursor; during a backfill, the last backfilled block). */
  processedBlock?: bigint;
  confirmedHead?: bigint;
  /**
   * When the confirmed head last rose above every head read since the start (the first read counts; with `staleSince`
   * carried over a restart it starts there, and only a head above the stored cursor counts). A head that stops
   * advancing (a stuck or lagging RPC node) makes the chain stale although every cycle succeeds.
   */
  headAdvancedAt?: number;
  /** End of the last successful cycle that left the cursor at the confirmed head (not with the RPC behind it). */
  lastCaughtUpAt?: number;
  cycleFailures: number;
  /** Failures since the last successful cycle (drives the backoff). */
  consecutiveFailures: number;
  /** Redacted error of the last failed cycle; cleared by a successful one. */
  lastError?: string;
  /** First-start backfill in progress: next block to replay and its end. */
  backfill?: {next: bigint; to: bigint};
  /** Cycles finished, successful or not. */
  cycles: number;
  successfulCycles: number;
  /** State rules by id; one whose reads have failed for more than `staleAfterSec` makes the chain stale. */
  reads?: Record<string, StateReads>;
  /** CCIP blocks below the cursor the ccip rule has not scanned (replayed muted, a few chunks per cycle). */
  ccipGaps?: BlockRange[];
  /** Redacted error of the last failed replay of a CCIP gap; cleared once no gap's replay is failing. */
  ccipGapError?: string;
  /** Gaps whose replay is failing, by block (see `GapFailure`); one failing for more than `staleAfterSec` is stale. */
  gapFailures?: Record<string, GapFailure>;
}

/**
 * The daemon's reconciliation runs (store namespace `health`, so a restart keeps counting). Unix ms, each the start of
 * a run. A run is blocked when it threw or was incomplete for a reason that is a failure (`blockingFailures`); a run
 * that evaluated R − I, or was incomplete only for reasons that are not, ends it; a skipped run changes nothing.
 */
export interface ReconcileRuns {
  /** Last run that evaluated R − I (ok or breach). */
  completeAt?: number;
  /** First blocked run since the last one that was not; unset while not blocked. */
  blockedSince?: number;
  /** The last blocked run's reasons that are failures (`IncompleteReason.reason`). */
  reasons?: string[];
  /** Redacted error of the last blocked run, when it threw. */
  error?: string;
}

/** What the daemon knows about reconciliation while it is enabled. */
export interface ReconcileHealth extends ReconcileRuns {
  /** `reconciliation.staleAfterSec` (default 3 × intervalSec). */
  staleAfterSec: number;
  /** Runs that threw since the start. */
  failures: number;
}

export interface MonitorStatus {
  now: number;
  chains: ChainHealth[];
  openConditions: OpenCondition[];
  deliveries: Record<string, DeliveryStats>;
  /** Last reconciliation report, if any ran. */
  reconcile?: ReconcileReport;
  /** Unset while reconciliation is disabled. */
  reconcileHealth?: ReconcileHealth;
  decimals: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Stale telemetry

/**
 * Seconds since the chain was last caught up (since the start, or `staleSince`, while it never was), or since its
 * confirmed head last advanced when that is earlier.
 */
export function staleForSec(chain: ChainHealth, now: number): number {
  return Math.max(0, Math.floor((now - freshAt(chain)) / 1000));
}

function freshAt(chain: ChainHealth): number {
  const caughtUp = chain.lastCaughtUpAt ?? chain.staleSince ?? chain.since;
  return chain.headAdvancedAt !== undefined && chain.headAdvancedAt < caughtUp ? chain.headAdvancedAt : caughtUp;
}

export function isStale(chain: ChainHealth, now: number): boolean {
  return staleForSec(chain, now) > chain.staleAfterSec;
}

/**
 * `ChainHealth.staleSince` for a stale-telemetry condition still open at a restart: the latest staleness start that
 * matches it. Its age exceeded `staleAfterSec` when it opened and, once critical, three times that when last sent.
 */
export function carriedStaleSince(
  open: Pick<OpenCondition, "alert" | "openedAt" | "lastSentAt">,
  staleAfterSec: number,
): number {
  const limitMs = staleAfterSec * 1000;
  const opened = open.openedAt - limitMs;
  return (open.alert.severity === "critical" ? Math.min(opened, open.lastSentAt - 3 * limitMs) : opened) - 1000;
}

/** Lag in blocks, when both ends are known; negative while the RPC is behind the processed block. */
export function lagBlocks(chain: ChainHealth): bigint | undefined {
  if (chain.processedBlock === undefined || chain.confirmedHead === undefined) return undefined;
  return chain.confirmedHead - chain.processedBlock;
}

/**
 * `${chain}:health:stale-telemetry`: high once the chain has not been caught up, or its confirmed head has not
 * advanced, for `staleAfterSec`; critical after three times that. Design §5: "Disable recall when in-flight
 * obligations cannot be bounded or telemetry is stale." A first-start backfill that is still progressing (no failed
 * cycle in a row) caps it at warning: it is expected on every fresh deployment and must not train operators to mute it.
 */
export function staleTelemetryConditions(chain: ChainHealth, now: number): Alert[] {
  const age = staleForSec(chain, now);
  if (age <= chain.staleAfterSec) return [];
  const backfilling = chain.backfill !== undefined && chain.consecutiveFailures === 0;
  let severity: Severity = age > 3 * chain.staleAfterSec ? "critical" : "high";
  if (backfilling) severity = "warning";
  const lag = lagBlocks(chain);
  const time = (ms: number) => formatTimestamp(Math.floor(ms / 1000));
  // Cycles still catch up, to a head that no longer moves: the RPC node is stuck or far behind the chain.
  const headStuck =
    chain.headAdvancedAt !== undefined &&
    chain.lastCaughtUpAt !== undefined &&
    now - chain.lastCaughtUpAt <= chain.staleAfterSec * 1000;
  let caughtUp: string;
  if (chain.lastCaughtUpAt !== undefined) caughtUp = time(chain.lastCaughtUpAt);
  else if (chain.staleSince !== undefined) {
    caughtUp = `never since the start (${time(chain.since)}); stale before it since about ${time(chain.staleSince)}`;
  } else caughtUp = `never since the start (${time(chain.since)})`;
  const fields: AlertField[] = [
    {label: "Last caught up", value: caughtUp},
    {label: "Stale for", value: `${formatDuration(age)} (limit ${formatDuration(chain.staleAfterSec)})`},
    {label: "Processed block", value: chain.processedBlock?.toString() ?? "none", code: true},
    {label: "Confirmed head", value: chain.confirmedHead?.toString() ?? "unknown", code: true},
  ];
  if (chain.headAdvancedAt !== undefined) {
    fields.push({label: "Head last advanced", value: time(chain.headAdvancedAt)});
  }
  if (lag !== undefined && lag < 0n) {
    fields.push({label: "RPC behind", value: `the confirmed head is ${-lag} blocks below the processed block`});
  } else if (lag !== undefined) fields.push({label: "Lag", value: `${lag} blocks`});
  if (chain.backfill) {
    fields.push({
      label: "Backfill",
      value: `first-start backfill in progress at block ${chain.backfill.next} of ${chain.backfill.to}`,
    });
  }
  fields.push({label: "Failed cycles in a row", value: String(chain.consecutiveFailures)});
  if (chain.lastError) fields.push({label: "Last error", value: chain.lastError, code: true});
  return [
    {
      key: `${healthScope(chain.chain)}stale-telemetry`,
      kind: "condition",
      severity,
      rule: STALE_RULE,
      chain: chain.chain,
      title: headStuck
        ? `Stale telemetry: ${chain.chain} head not advancing for ${formatDuration(age)}`
        : `Stale telemetry: ${chain.chain} not caught up for ${formatDuration(age)}`,
      fields,
      note:
        "Design §5: disable recall when in-flight obligations cannot be bounded or telemetry is stale. While this " +
        "chain is not monitored the in-flight amount I cannot be bounded, so recall must stay disabled until it " +
        "recovers: the Guardian calls LiquidityManager.pauseRecall() on each chain's Manager (re-enabling is a " +
        "Timelock operation, setRecallPaused(false)). Check the RPC endpoints and the monitor logs.",
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Failed state reads

/** A state rule whose reads are failing: since when (unix ms), its last success and the seconds in between. */
export interface FailingRead {
  rule: string;
  since: number;
  okAt?: number;
  forSec: number;
}

/** State rules whose reads are failing, longest first. */
export function failingReads(chain: ChainHealth, now: number): FailingRead[] {
  const failing: FailingRead[] = [];
  for (const [rule, reads] of Object.entries(chain.reads ?? {})) {
    if (reads.failingSince === undefined) continue;
    const forSec = Math.max(0, Math.floor((now - reads.failingSince) / 1000));
    failing.push({rule, since: reads.failingSince, ...(reads.okAt !== undefined ? {okAt: reads.okAt} : {}), forSec});
  }
  return failing.sort((a, b) => b.forSec - a.forSec || a.rule.localeCompare(b.rule));
}

/** Seconds the longest-failing state rule's reads have failed (0 while every rule's reads succeed). */
export function readsFailingForSec(chain: ChainHealth, now: number): number {
  return failingReads(chain, now)[0]?.forSec ?? 0;
}

/**
 * A state rule's reads have failed for more than `staleAfterSec`: what it verifies (owners, roles, pauses, the Router's
 * ramps, rate limits, budgets, inventory, the Timelock queue) is unknown, which is stale telemetry as much as a stuck
 * scan.
 */
export function readsStale(chain: ChainHealth, now: number): boolean {
  return readsFailingForSec(chain, now) > chain.staleAfterSec;
}

/** Severity of a read-failed condition whose reads failed for `ageSec`: as health.stale-telemetry, from warning. */
export function readFailedSeverity(ageSec: number, staleAfterSec: number): Severity {
  if (ageSec > 3 * staleAfterSec) return "critical";
  return ageSec > staleAfterSec ? "high" : "warning";
}

const READ_FIELDS = ["Failing for", "Last successful read"];

/**
 * A state rule's `${chain}:${rule}:read-failed` condition at the age of its failures (`reads.failingSince`): warning,
 * high once they have lasted more than `staleAfterSec`, critical after three times that, with when the reads last
 * succeeded and, once stale, the recall note of health.stale-telemetry.
 */
export function escalateReadFailed(alert: Alert, reads: StateReads, now: number, staleAfterSec: number): Alert {
  const since = reads.failingSince ?? now;
  const age = Math.max(0, Math.floor((now - since) / 1000));
  const severity = readFailedSeverity(age, staleAfterSec);
  const time = (ms: number) => formatTimestamp(Math.floor(ms / 1000));
  const fields: AlertField[] = [
    ...(alert.fields ?? []).filter((field) => !READ_FIELDS.includes(field.label)),
    {
      label: "Failing for",
      value: `${formatDuration(age)} since ${time(since)} (limit ${formatDuration(staleAfterSec)})`,
    },
    {label: "Last successful read", value: reads.okAt === undefined ? "none recorded" : time(reads.okAt)},
  ];
  const escalated: Alert = {...alert, severity, fields};
  if (severity !== "warning") {
    const stale =
      `These reads have failed for longer than staleAfterSec: what ${alert.rule.replace(/\.read-failed$/, "")} ` +
      `verifies is unknown, which is stale telemetry. ${PAUSE_RECALL} Check that the RPC endpoints answer eth_call ` +
      "at the confirmed head (rate limits, a pruned node) and the monitor logs.";
    escalated.note = alert.note ? `${stale} ${alert.note}` : stale;
  }
  return escalated;
}

// ---------------------------------------------------------------------------------------------------------------
// Failed replay of CCIP gaps

/** Seconds the longest-failing CCIP gap replay has failed (0 while none is failing). */
export function ccipGapFailingForSec(chain: ChainHealth, now: number): number {
  const since = Math.min(...Object.values(chain.gapFailures ?? {}).map((failure) => failure.since));
  return Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
}

/**
 * The replay of a CCIP gap has failed for more than `staleAfterSec`: what was sent or executed there is unknown, so the
 * in-flight amount I cannot be bounded, which is stale telemetry as much as a stuck scan.
 */
export function ccipGapReplayStale(chain: ChainHealth, now: number): boolean {
  return ccipGapFailingForSec(chain, now) > chain.staleAfterSec;
}

/**
 * `${chain}:health:ccip-gap-replay`: high once the replay of a CCIP gap has failed for `staleAfterSec`, critical after
 * three times that (as health.stale-telemetry). Reconciliation is incomplete meanwhile (a warning), which an on-call
 * route for high and critical alerts would never see.
 */
export function ccipGapReplayConditions(chain: ChainHealth, now: number): Alert[] {
  const age = ccipGapFailingForSec(chain, now);
  if (age <= chain.staleAfterSec) return [];
  const time = (ms: number) => formatTimestamp(Math.floor(ms / 1000));
  const failing = Object.entries(chain.gapFailures ?? {}).sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const fields: AlertField[] = [
    {label: "Blocks not scanned", value: chain.ccipGaps?.length ? gapsText(chain.ccipGaps) : "unknown"},
    {label: "Failing for", value: `${formatDuration(age)} (limit ${formatDuration(chain.staleAfterSec)})`},
    {
      label: "Failing replays",
      value: failing
        .map(([block, failure]) => `from block ${block}: ${failure.failures} attempt(s) since ${time(failure.since)}`)
        .join("\n"),
    },
  ];
  if (chain.ccipGapError) fields.push({label: "Last error", value: chain.ccipGapError, code: true});
  return [
    {
      key: `${healthScope(chain.chain)}ccip-gap-replay`,
      kind: "condition",
      severity: age > 3 * chain.staleAfterSec ? "critical" : "high",
      rule: CCIP_GAP_RULE,
      chain: chain.chain,
      title: `CCIP blocks on ${chain.chain} cannot be replayed for ${formatDuration(age)}: in-flight amount unbounded`,
      fields,
      note:
        "These blocks were skipped by the ccip rule (e.g. tracking disabled for a while): what was sent or executed " +
        "there is unknown, so the in-flight amount I cannot be bounded and reconciliation is incomplete. " +
        `${PAUSE_RECALL} The replay retries with backoff: check that an RPC endpoint serves eth_getLogs for these ` +
        "blocks (full history, its range limit) and the monitor logs.",
    },
  ];
}

/** Stale for /healthz and the heartbeat: the chain's scan, a state rule's reads or the replay of a CCIP gap. */
export function chainStale(chain: ChainHealth, now: number): boolean {
  return isStale(chain, now) || readsStale(chain, now) || ccipGapReplayStale(chain, now);
}

/** Every health condition of a chain, synced under `healthScope(chain)`. */
export function healthConditions(chain: ChainHealth, now: number): Alert[] {
  return [...staleTelemetryConditions(chain, now), ...ccipGapReplayConditions(chain, now)];
}

// ---------------------------------------------------------------------------------------------------------------
// Blocked reconciliation

/**
 * Whether a blocking reason is a failure that blocks reconciliation (only blocking reasons are looked at). Not: CCIP
 * tracking disabled by config (an operator choice: the reconcile.incomplete warning stays) and CCIP gaps (a replay in
 * progress can take hours; one that keeps failing raises health.ccip-gap-replay). Exhaustive, so a new cause has to be
 * classified here.
 */
const FAILURE: Record<IncompleteCause, boolean> = {
  "unreachable": true,
  "ccip-disabled": false,
  "ccip-not-started": true,
  "ccip-scan-behind": true,
  "ccip-gap": false,
  "ramps-unreadable": true,
  "unlinked-txs": true,
  "ramp-backfill": true,
  "unlinked-locks": true,
  "unknown-destination": true,
  "released-ahead": true,
};

/** The reasons of a reconciliation that block it because something failed. */
export function blockingFailures(report: ReconcileReport): IncompleteReason[] {
  return report.incomplete.filter((reason) => reason.blocking && FAILURE[reason.cause]);
}

/** Seconds reconciliation has been blocked (0 while it is not). */
export function reconcileBlockedForSec(runs: ReconcileRuns, now: number): number {
  return runs.blockedSince === undefined ? 0 : Math.max(0, Math.floor((now - runs.blockedSince) / 1000));
}

/**
 * Reconciliation has been blocked for more than `reconciliation.staleAfterSec`: R − I at the finalized blocks, which no
 * other check reads, is unverified, which is stale telemetry as much as a stuck scan.
 */
export function reconcileStale(health: ReconcileHealth | undefined, now: number): boolean {
  return health !== undefined && reconcileBlockedForSec(health, now) > health.staleAfterSec;
}

/**
 * `global:health:reconcile-stale`: high once reconciliation has been blocked for more than its staleAfterSec, critical
 * after three times that (as health.stale-telemetry). Meanwhile a blocked run is only the reconcile.incomplete warning
 * (or, when it throws, a log line), which an on-call route for high and critical alerts would never see.
 */
export function reconcileStaleConditions(health: ReconcileHealth, now: number): Alert[] {
  const age = reconcileBlockedForSec(health, now);
  if (health.blockedSince === undefined || age <= health.staleAfterSec) return [];
  const time = (ms: number) => formatTimestamp(Math.floor(ms / 1000));
  const limit = formatDuration(health.staleAfterSec);
  const fields: AlertField[] = [
    {label: "Blocked for", value: `${formatDuration(age)} since ${time(health.blockedSince)} (limit ${limit})`},
    {
      label: "Last complete reconciliation",
      value: health.completeAt === undefined ? "none recorded" : time(health.completeAt),
    },
  ];
  if (health.reasons?.length) fields.push({label: "Blocking reasons", value: health.reasons.join("\n")});
  if (health.error !== undefined) fields.push({label: "Last error", value: health.error, code: true});
  return [
    {
      key: RECONCILE_STALE_KEY,
      kind: "condition",
      severity: age > 3 * health.staleAfterSec ? "critical" : "high",
      rule: RECONCILE_STALE_RULE,
      title: `Reconciliation blocked for ${formatDuration(age)}: R − I not verified`,
      fields,
      note:
        "No reconciliation has evaluated R − I at the finalized blocks for longer than reconciliation.staleAfterSec: " +
        "the backing and the in-flight amount I are unverified, which is stale telemetry. " +
        `${PAUSE_RECALL} Check the blocking reasons or the error: that the RPC endpoints answer eth_call at the ` +
        "finalized block (rate limits, a pruned node), `npm run check` and the monitor logs.",
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// /healthz and /metrics

/** Sinks with a target whose alerts are not getting through (see `DeliveryFailure`). */
export function failingSinks(status: Pick<MonitorStatus, "deliveries">): string[] {
  return Object.entries(status.deliveries)
    .filter(([, stats]) => stats.failing)
    .map(([sink]) => sink);
}

/** Those targets, as "<sink> <target id>" (e.g. "telegram -1001234567890"). */
export function failingTargets(status: Pick<MonitorStatus, "deliveries">): string[] {
  return Object.entries(status.deliveries).flatMap(([sink, stats]) =>
    Object.entries(stats.targets)
      .filter(([, target]) => target.failing)
      .map(([id]) => `${sink} ${id}`),
  );
}

/** Seconds the oldest message a target has yet to deliver has waited (0 when none). */
export function oldestUndeliveredAgeSec(target: TargetStats, now: number): number {
  const at = target.oldestUndeliveredAt;
  return at === undefined ? 0 : Math.max(0, Math.floor((now - at) / 1000));
}

/**
 * 503 while a chain is stale ("stale": its scan, or a state rule's reads or a CCIP gap's replay for more than
 * staleAfterSec), reconciliation has been blocked for more than its staleAfterSec ("stale" too) or an alert target is
 * failing ("delivery-failing": its alerts are held back for a retry, or one was dropped), else 200 "ok".
 */
export function healthz(status: MonitorStatus): {code: number; body: Record<string, unknown>} {
  const runs = status.reconcileHealth;
  const stale = status.chains.some((chain) => chainStale(chain, status.now)) || reconcileStale(runs, status.now);
  const failing = failingSinks(status).length > 0;
  const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
  const chains = Object.fromEntries(
    status.chains.map((chain) => {
      const lag = lagBlocks(chain);
      const entry: Record<string, unknown> = {
        processedBlock: chain.processedBlock === undefined ? null : Number(chain.processedBlock),
        confirmedHead: chain.confirmedHead === undefined ? null : Number(chain.confirmedHead),
        lagBlocks: lag === undefined ? null : Number(lag),
        lastCaughtUpAt: iso(chain.lastCaughtUpAt),
        headAdvancedAt: iso(chain.headAdvancedAt),
        staleForSec: staleForSec(chain, status.now),
        stale: isStale(chain, status.now),
        readsStale: readsStale(chain, status.now),
        readsFailingForSec: readsFailingForSec(chain, status.now),
        failingReads: Object.fromEntries(
          failingReads(chain, status.now).map((read) => [
            read.rule,
            {since: iso(read.since), lastOkAt: iso(read.okAt), forSec: read.forSec},
          ]),
        ),
        ccipGaps: (chain.ccipGaps ?? []).map((gap) => ({from: Number(gap.from), to: Number(gap.to)})),
        ccipGapReplayStale: ccipGapReplayStale(chain, status.now),
        ccipGapFailingForSec: ccipGapFailingForSec(chain, status.now),
        cycleFailures: chain.cycleFailures,
      };
      if (chain.lastError) entry.lastError = redact(chain.lastError);
      if (chain.ccipGapError) entry.ccipGapError = redact(chain.ccipGapError);
      return [chain.chain, entry];
    }),
  );
  const failure = (entry: Record<string, unknown>, failing: DeliveryFailure | undefined) => {
    entry.failing = failing !== undefined;
    if (!failing) return entry;
    entry.failingSince = iso(failing.since);
    entry.failingKind = failing.kind;
    entry.lastError = redact(failing.error);
    return entry;
  };
  const deliveries = Object.fromEntries(
    Object.entries(status.deliveries).map(([sink, stats]) => {
      const targets = Object.fromEntries(
        Object.entries(stats.targets).map(([id, target]) => [
          id,
          {
            ...failure({ok: target.ok, failed: target.failed, retries: target.retries}, target.failing),
            outboxMessages: target.undelivered,
            outboxOldestAgeSec: oldestUndeliveredAgeSec(target, status.now),
          },
        ]),
      );
      return [sink, {...failure({ok: stats.ok, failed: stats.failed, retries: stats.retries}, stats.failing), targets}];
    }),
  );
  const state = stale ? "stale" : failing ? "delivery-failing" : "ok";
  const body: Record<string, unknown> = {status: state, chains};
  if (runs) {
    const reconcile: Record<string, unknown> = {
      stale: reconcileStale(runs, status.now),
      blockedSince: iso(runs.blockedSince),
      blockedForSec: reconcileBlockedForSec(runs, status.now),
      lastCompleteAt: iso(runs.completeAt),
      failures: runs.failures,
    };
    if (runs.reasons) reconcile.reasons = runs.reasons.map((reason) => redact(reason));
    if (runs.error !== undefined) reconcile.error = redact(runs.error);
    body.reconcile = reconcile;
  }
  body.deliveries = deliveries;
  return {code: stale || failing ? 503 : 200, body};
}

interface Sample {
  labels?: Record<string, string>;
  value: number;
}

function sampleValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  return String(value);
}

function labelText(labels: Record<string, string> | undefined): string {
  if (!labels) return "";
  const pairs = Object.entries(labels).map(
    ([name, value]) => `${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`,
  );
  return `{${pairs.join(",")}}`;
}

function tokens(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

/** Prometheus text exposition format (0.0.4). */
export function renderMetrics(status: MonitorStatus): string {
  const lines: string[] = [];
  const metric = (name: string, type: "gauge" | "counter", help: string, samples: Sample[]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const sample of samples) lines.push(`${name}${labelText(sample.labels)} ${sampleValue(sample.value)}`);
  };
  const perChain = (pick: (chain: ChainHealth) => number | bigint | undefined): Sample[] =>
    status.chains.flatMap((chain) => {
      const value = pick(chain);
      return value === undefined ? [] : [{labels: {chain: chain.chain}, value: Number(value)}];
    });

  metric("sahara_monitor_up", "gauge", "1 while the monitor is running.", [{value: 1}]);
  metric(
    "sahara_monitor_chain_processed_block",
    "gauge",
    "Last fully processed block.",
    perChain((chain) => chain.processedBlock),
  );
  metric(
    "sahara_monitor_chain_confirmed_head",
    "gauge",
    "Latest block minus the configured confirmations.",
    perChain((chain) => chain.confirmedHead),
  );
  metric(
    "sahara_monitor_chain_lag_blocks",
    "gauge",
    "Confirmed head minus processed block (negative while the RPC is behind the processed block).",
    perChain(lagBlocks),
  );
  metric(
    "sahara_monitor_chain_last_caught_up_timestamp_seconds",
    "gauge",
    "Unix time the chain was last caught up to its confirmed head (0: never since the start).",
    perChain((chain) => (chain.lastCaughtUpAt === undefined ? 0 : chain.lastCaughtUpAt / 1000)),
  );
  metric(
    "sahara_monitor_chain_stale",
    "gauge",
    "1 when the chain has not been caught up, or its confirmed head has not advanced, for more than staleAfterSec.",
    perChain((chain) => (isStale(chain, status.now) ? 1 : 0)),
  );
  metric(
    "sahara_monitor_chain_state_reads_stale",
    "gauge",
    "1 when a state rule's reads have failed for more than staleAfterSec (the chain counts as stale for /healthz and " +
      "the heartbeat).",
    perChain((chain) => (readsStale(chain, status.now) ? 1 : 0)),
  );
  metric(
    "sahara_monitor_chain_ccip_gap_replay_stale",
    "gauge",
    "1 when the replay of CCIP blocks the ccip rule skipped has failed for more than staleAfterSec (the chain counts " +
      "as stale for /healthz and the heartbeat).",
    perChain((chain) => (ccipGapReplayStale(chain, status.now) ? 1 : 0)),
  );
  metric(
    "sahara_monitor_chain_cycle_failures_total",
    "counter",
    "Polling cycles that failed (RPC, address resolution or log scan).",
    perChain((chain) => chain.cycleFailures),
  );
  const open = new Map<Severity, number>(SEVERITIES.map((severity) => [severity, 0]));
  for (const condition of status.openConditions) {
    open.set(condition.alert.severity, (open.get(condition.alert.severity) ?? 0) + 1);
  }
  metric(
    "sahara_monitor_open_conditions",
    "gauge",
    "Open alert conditions by severity.",
    SEVERITIES.map((severity) => ({labels: {severity}, value: open.get(severity) ?? 0})),
  );
  const perTarget = (pick: (target: TargetStats) => number): Sample[] =>
    Object.entries(status.deliveries).flatMap(([sink, stats]) =>
      Object.entries(stats.targets).map(([target, entry]) => ({labels: {sink, target}, value: pick(entry)})),
    );
  metric(
    "sahara_monitor_alert_deliveries_total",
    "counter",
    "Alert messages per sink, target (e.g. a Telegram chat id) and result: ok (delivered) or failed (dropped as " +
      "undeliverable for that target).",
    Object.entries(status.deliveries).flatMap(([sink, stats]) =>
      Object.entries(stats.targets).flatMap(([target, entry]) => [
        {labels: {sink, target, result: "ok"}, value: entry.ok},
        {labels: {sink, target, result: "failed"}, value: entry.failed},
      ]),
    ),
  );
  metric(
    "sahara_monitor_alert_delivery_retries_total",
    "counter",
    "Failed delivery attempts whose message was kept and retried later (network, server, rate limit or route errors).",
    perTarget((target) => target.retries),
  );
  metric(
    "sahara_monitor_alert_sink_failing",
    "gauge",
    "1 while the target's alerts are not getting through: an attempt failed (its message kept for a retry, or " +
      "dropped) and nothing of that severity or above was delivered to it since. Kept across a restart.",
    perTarget((target) => (target.failing ? 1 : 0)),
  );
  metric(
    "sahara_monitor_alert_outbox_messages",
    "gauge",
    "Alert messages the target has yet to deliver (kept in the state file across a restart).",
    perTarget((target) => target.undelivered),
  );
  metric(
    "sahara_monitor_alert_outbox_oldest_age_seconds",
    "gauge",
    "Seconds the oldest alert message the target has yet to deliver has waited (0 when none).",
    perTarget((target) => oldestUndeliveredAgeSec(target, status.now)),
  );

  const report = status.reconcile;
  const reconcileSample = (value: number | undefined): Sample[] =>
    report && value !== undefined ? [{value}] : [];
  const reportTokens = (value: bigint | undefined) =>
    value === undefined ? undefined : tokens(value, status.decimals);
  metric(
    "sahara_monitor_reconcile_complete",
    "gauge",
    "1 when the last reconciliation computed both R and I.",
    reconcileSample(report ? (report.status === "incomplete" ? 0 : 1) : undefined),
  );
  metric(
    "sahara_monitor_reconcile_backing_tokens",
    "gauge",
    "R: reserves across both chains in whole tokens (last reconciliation).",
    reconcileSample(reportTokens(report?.R)),
  );
  metric(
    "sahara_monitor_reconcile_inflight_tokens",
    "gauge",
    "I: principal in flight between the chains in whole tokens (last reconciliation).",
    reconcileSample(reportTokens(report?.I)),
  );
  metric(
    "sahara_monitor_reconcile_margin_tokens",
    "gauge",
    "R - I - requiredBacking in whole tokens; negative is a backing breach (last reconciliation).",
    reconcileSample(reportTokens(report?.margin)),
  );
  metric(
    "sahara_monitor_reconcile_failed_messages",
    "gauge",
    "SAHARA CCIP messages awaiting manual execution (last reconciliation).",
    reconcileSample(report?.failed.length),
  );
  metric(
    "sahara_monitor_reconcile_stuck_messages",
    "gauge",
    "SAHARA CCIP messages without any execution after stuckAfterSec (last reconciliation).",
    reconcileSample(report?.stuck.length),
  );
  metric(
    "sahara_monitor_reconcile_last_run_timestamp_seconds",
    "gauge",
    "Unix time of the last reconciliation.",
    reconcileSample(report?.at),
  );
  const runs = status.reconcileHealth;
  const runsSample = (pick: (health: ReconcileHealth) => number): Sample[] => (runs ? [{value: pick(runs)}] : []);
  metric(
    "sahara_monitor_reconcile_stale",
    "gauge",
    "1 when reconciliation has been blocked (runs failing, or unable to read a chain's balances or CCIP messages) " +
      "for more than reconciliation.staleAfterSec (/healthz 503, heartbeat withheld).",
    runsSample((health) => (reconcileStale(health, status.now) ? 1 : 0)),
  );
  metric(
    "sahara_monitor_reconcile_blocked_seconds",
    "gauge",
    "Seconds reconciliation has been blocked (0 while it is not); kept across a restart.",
    runsSample((health) => reconcileBlockedForSec(health, status.now)),
  );
  metric(
    "sahara_monitor_reconcile_failures_total",
    "counter",
    "Reconciliation runs that threw since the start.",
    runsSample((health) => health.failures),
  );
  return `${lines.join("\n")}\n`;
}

/** Serves GET /healthz and GET /metrics from `status()`, which must return cached values without awaiting. */
export function createStatusServer(status: () => MonitorStatus, log: Logger): Server {
  return createServer((request, response) => {
    try {
      const path = (request.url ?? "/").split("?")[0];
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, {allow: "GET"}).end();
        return;
      }
      if (path === "/healthz") {
        const {code, body} = healthz(status());
        response.writeHead(code, {"content-type": "application/json"}).end(JSON.stringify(body));
      } else if (path === "/metrics") {
        const text = renderMetrics(status());
        response.writeHead(200, {"content-type": "text/plain; version=0.0.4; charset=utf-8"}).end(text);
      } else {
        response.writeHead(404, {"content-type": "text/plain"}).end("not found\n");
      }
    } catch (error) {
      log.error("status request failed", {error: redact(error instanceof Error ? error.message : String(error))});
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
}

export function listen(server: Server, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server.address() as AddressInfo);
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Heartbeat

export const HEARTBEAT_TIMEOUT_MS = 10_000;

/** The heartbeat URL usually embeds the check's secret id: keep it (and its path) out of every log line. */
export function registerHeartbeatSecret(url: string | undefined): void {
  if (!url) return;
  registerSecret(url);
  try {
    const parsed = new URL(url);
    registerSecret(`${parsed.pathname}${parsed.search}`);
  } catch {
    // Validated by the config schema; nothing more to hide.
  }
}

/** One GET to the dead-man's switch. Failures are only logged: the missing ping is the alert. */
export async function sendHeartbeat(url: string, fetch: FetchLike, log: Logger): Promise<boolean> {
  try {
    const response = await fetch(url, {method: "GET", signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS)});
    await response.body?.cancel().catch(() => {});
    if (!response.ok) {
      log.warn("heartbeat rejected", {status: response.status});
      return false;
    }
    return true;
  } catch (error) {
    log.warn("heartbeat failed", {error: redact(error instanceof Error ? error.message : String(error))});
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Startup message

export interface StartupInfo {
  chain: string;
  /** Last processed block when normal scanning starts. */
  cursor: bigint;
  /** backfill: replayed muted on this start; fresh: no startBlock (or above the head); resumed: cursor was stored. */
  mode: "backfill" | "fresh" | "resumed";
  /** The backfill range (this start's, or the one completed when the state file was created). */
  backfill?: {from: bigint; to: bigint; resumedAt?: bigint};
  /** A configured startBlock above the confirmed head, ignored. */
  ignoredStartBlock?: number;
  pendingTimelockOps: number;
  /** Event alerts dropped by the muted backfill on this start. */
  suppressed: number;
  /** CCIP blocks the ccip rule has not scanned, replayed muted in the background (see `ChainHealth.ccipGaps`). */
  ccipGaps?: BlockRange[];
}

export interface StartupOptions {
  dryRun?: boolean;
  /** Open conditions dropped at the start because no rule evaluates them any more (`AlertManager.drop`). */
  dropped?: Alert[];
  /** Reconciliation as persisted at the start: listed while it was blocked. */
  reconcile?: ReconcileHealth;
}

function startupLines(info: StartupInfo): string[] {
  const lines = [`Starting cursor: block ${info.cursor}`];
  const range = info.backfill ? `blocks ${info.backfill.from}–${info.backfill.to}` : "";
  if (info.mode === "backfill" && info.backfill) {
    const resumed = info.backfill.resumedAt !== undefined ? ` (resumed at block ${info.backfill.resumedAt})` : "";
    lines.push(`Backfill (Timelock and CCIP only, muted): ${range}${resumed}`);
  } else if (info.mode === "fresh") {
    lines.push(
      `no backfill: Timelock proposals and CCIP messages before block ${info.cursor + 1n} are not tracked – set ` +
        "startBlock",
    );
    if (info.ignoredStartBlock !== undefined) {
      lines.push(`startBlock ${info.ignoredStartBlock} is above the confirmed head and was ignored`);
    }
  } else {
    lines.push(
      info.backfill
        ? `Resumed from the stored cursor (backfill ${range} completed earlier)`
        : "Resumed from the stored cursor (this state file started without a backfill)",
    );
  }
  if (info.ccipGaps?.length) {
    lines.push(
      `CCIP blocks not scanned yet (replayed muted in the background; reconciliation is incomplete until done): ` +
        gapsText(info.ccipGaps),
    );
  }
  lines.push(`Pending Timelock operations known: ${info.pendingTimelockOps}`);
  lines.push(`Historical event alerts suppressed: ${info.suppressed}`);
  return lines;
}

/** "400–500, 700–710 (112 blocks)". */
function gapsText(gaps: readonly BlockRange[]): string {
  const blocks = gaps.reduce((sum, gap) => sum + gap.to - gap.from + 1n, 0n);
  return `${gaps.map((gap) => `${gap.from}–${gap.to}`).join(", ")} (${blocks} block${blocks === 1n ? "" : "s"})`;
}

/** One info event per process start, sent once every chain has its starting cursor. */
export function startupAlert(bootAt: number, chains: StartupInfo[], options: StartupOptions = {}): Alert {
  const fields: AlertField[] = [
    {label: "Started at", value: formatTimestamp(Math.floor(bootAt / 1000))},
    ...chains.map((info) => ({label: info.chain, value: startupLines(info).join("\n")})),
  ];
  const runs = options.reconcile;
  if (runs?.blockedSince !== undefined) {
    const lines = [`Blocked ${blockedSpan(runs, bootAt)} at the start, still counted until a run completes`];
    if (runs.error !== undefined) lines.push(`Last error: ${runs.error}`);
    lines.push(...(runs.reasons ?? []));
    fields.push({label: "Reconciliation", value: lines.join("\n")});
  }
  if (options.dropped?.length) {
    fields.push({
      label: "Open conditions dropped (no longer evaluated: chain removed, reconciliation or CCIP disabled)",
      value: options.dropped
        .map((alert) => `${alert.severity.toUpperCase()}${alert.chain ? ` ${alert.chain}` : ""}: ${alert.title}`)
        .join("\n"),
    });
  }
  return {
    key: `global:health:started:${bootAt}`,
    kind: "event",
    severity: "info",
    rule: STARTED_RULE,
    title: `Monitor started${options.dryRun ? " (dry run)" : ""}`,
    fields,
    note:
      "Read-only monitor. Event alerts of backfilled history are suppressed: Timelock operations still pending are " +
      "raised by the queue rule as they approach their ETA, and failed or stuck CCIP messages by reconciliation.",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Daily summary

/**
 * The UTC date ("YYYY-MM-DD") whose summary is due at `now`: at or after `timeUtc` ("HH:MM") and not yet sent.
 * Undefined when disabled, too early, or already sent.
 */
export function dueSummaryDate(
  now: number,
  timeUtc: string | undefined,
  lastSent: string | undefined,
): string | undefined {
  if (!timeUtc) return undefined;
  const today = new Date(now);
  const date = today.toISOString().slice(0, 10);
  if (lastSent !== undefined && lastSent >= date) return undefined;
  const [hours = 0, minutes = 0] = timeUtc.split(":").map(Number);
  const scheduled = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hours, minutes);
  return now >= scheduled ? date : undefined;
}

export interface SummaryInput {
  date: string;
  status: MonitorStatus;
  /** Latest state-rule snapshots: chain -> rule id -> entries. */
  snapshots: Record<string, Record<string, Record<string, string>>>;
  config: Config;
}

/** Snapshot entries worth a daily look: pool inventory and thresholds, budgets, pauses, the Timelock queue. */
function summarySnapshot(rule: string, key: string): boolean {
  if (rule === INVENTORY_RULE || rule === QUEUE_RULE) return true;
  if (rule !== MANAGER_RULE) return false;
  return /budget|per call|paused/i.test(key);
}

function chainLine(chain: ChainHealth, now: number): string {
  const lag = lagBlocks(chain);
  const block = chain.processedBlock === undefined ? "no block processed yet" : `block ${chain.processedBlock}`;
  const lagText = lag === undefined ? "" : ` (lag ${lag})`;
  const state = isStale(chain, now)
    ? `STALE for ${formatDuration(staleForSec(chain, now))}`
    : chain.lastCaughtUpAt === undefined
      ? "not caught up yet"
      : `caught up ${formatTimestamp(Math.floor(chain.lastCaughtUpAt / 1000))}`;
  const parts = [`${block}${lagText}, ${state}, ${chain.cycleFailures} failed cycles`];
  const failing = failingReads(chain, now);
  if (failing.length) {
    const what = readsStale(chain, now) ? "STATE READS STALE" : "state reads failing";
    parts.push(`${what}: ${failing.map((read) => `${read.rule} for ${formatDuration(read.forSec)}`).join(", ")}`);
  }
  if (chain.ccipGaps?.length) parts.push(`CCIP blocks not scanned yet: ${gapsText(chain.ccipGaps)}`);
  return parts.join("; ");
}

function reconcileLine(status: MonitorStatus, config: Config): string {
  if (!config.reconciliation.enabled) return "disabled";
  const runs = status.reconcileHealth;
  let blocked = "";
  if (runs?.blockedSince !== undefined) {
    const why = runs.error ?? runs.reasons?.join("; ");
    blocked = `; ${reconcileStale(runs, status.now) ? "BLOCKED" : "blocked"} ${blockedSpan(runs, status.now)}`;
    if (why) blocked += `: ${why}`;
  }
  const report = status.reconcile;
  if (!report) return `not run yet${blocked}`;
  const amount = (value: bigint | undefined) =>
    value === undefined ? "unknown" : formatAmount(value, config.token.decimals, config.token.symbol);
  const text = {ok: "OK", breach: "BACKING BREACH", incomplete: "INCOMPLETE"}[report.status];
  return (
    `${text} at ${formatTimestamp(report.at)}: R ${amount(report.R)}, I ${amount(report.I)}, ` +
    `margin ${amount(report.margin)}; ${report.failed.length} failed, ${report.stuck.length} stuck messages${blocked}`
  );
}

/** "for 4m since 2026-10-28 00:30:00 UTC (limit 3m)". */
function blockedSpan(runs: ReconcileHealth, now: number): string {
  const since = formatTimestamp(Math.floor((runs.blockedSince ?? now) / 1000));
  const age = formatDuration(reconcileBlockedForSec(runs, now));
  return `for ${age} since ${since} (limit ${formatDuration(runs.staleAfterSec)})`;
}

export function dailySummaryAlert(input: SummaryInput): Alert {
  const {status, snapshots, config} = input;
  const fields: AlertField[] = [];
  for (const chain of status.chains) {
    fields.push({label: chain.chain, value: chainLine(chain, status.now)});
    for (const [rule, entries] of Object.entries(snapshots[chain.chain] ?? {})) {
      for (const [key, value] of Object.entries(entries)) {
        if (summarySnapshot(rule, key)) fields.push({label: `${chain.chain} · ${key}`, value});
      }
    }
  }
  fields.push({label: "Reconciliation", value: reconcileLine(status, config)});

  const bySeverity = new Map<Severity, OpenCondition[]>(SEVERITIES.map((severity) => [severity, []]));
  for (const open of status.openConditions) bySeverity.get(open.alert.severity)?.push(open);
  fields.push({
    label: "Open conditions",
    value: SEVERITIES.map((severity) => `${severity} ${bySeverity.get(severity)?.length ?? 0}`).join(", "),
  });
  const deliveries = Object.entries(status.deliveries);
  if (deliveries.length) {
    fields.push({
      label: "Deliveries",
      value: deliveries
        .map(([sink, {ok, failed, failing, targets}]) => {
          const waiting = Object.values(targets).reduce((sum, target) => sum + target.undelivered, 0);
          const undelivered = waiting ? `, ${waiting} undelivered` : "";
          const since = failing ? `, FAILING since ${formatTimestamp(Math.floor(failing.since / 1000))}` : "";
          return `${sink} ${ok} ok, ${failed} failed${undelivered}${since}`;
        })
        .join("; "),
    });
  }

  const urgent = [...(bySeverity.get("critical") ?? []), ...(bySeverity.get("high") ?? [])];
  const openFor = (open: OpenCondition) => formatDuration(Math.max(0, Math.floor((status.now - open.openedAt) / 1000)));
  const note = urgent.length
    ? [
        "Open critical/high conditions:",
        ...urgent.map(
          (open) =>
            `• ${open.alert.severity.toUpperCase()}${open.alert.chain ? ` ${open.alert.chain}` : ""}: ` +
            `${open.alert.title} (open ${openFor(open)})`,
        ),
      ].join("\n")
    : "No critical or high condition is open.";
  const title = urgent.length
    ? `Daily summary ${input.date}: ${urgent.length} critical/high condition${urgent.length === 1 ? "" : "s"} open`
    : `Daily summary ${input.date}: no critical/high condition open`;
  return {
    key: `global:health:daily-summary:${input.date}`,
    kind: "event",
    severity: "info",
    rule: SUMMARY_RULE,
    title,
    fields,
    note,
  };
}
