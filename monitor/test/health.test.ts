import {describe, expect, it, vi} from "vitest";

import type {DeliveryFailure, DeliveryStats, OpenCondition, TargetStats} from "../src/alerts/manager.ts";
import {
  blockingFailures,
  carriedStaleSince,
  closeServer,
  createStatusServer,
  dailySummaryAlert,
  dueSummaryDate,
  escalateReadFailed,
  failingSinks,
  failingTargets,
  healthz,
  listen,
  readFailedSeverity,
  readsStale,
  reconcileStale,
  reconcileStaleConditions,
  registerHeartbeatSecret,
  renderMetrics,
  sendHeartbeat,
  staleTelemetryConditions,
  startupAlert,
  type ChainHealth,
  type MonitorStatus,
  type ReconcileHealth,
} from "../src/health.ts";
import {formatTimestamp} from "../src/format.ts";
import {redact, silentLogger} from "../src/log.ts";
import type {IncompleteReason, ReconcileReport} from "../src/rules/reconcile.ts";
import type {Alert, Severity} from "../src/types.ts";
import {daemonConfig, logger, T0} from "./helpers/daemon-fakes.ts";

const WEI = 10n ** 18n;

function chain(overrides: Partial<ChainHealth> = {}): ChainHealth {
  return {
    chain: "ethereum",
    staleAfterSec: 300,
    since: T0,
    processedBlock: 100n,
    confirmedHead: 103n,
    lastCaughtUpAt: T0,
    cycleFailures: 2,
    consecutiveFailures: 0,
    cycles: 10,
    successfulCycles: 8,
    ...overrides,
  };
}

function open(key: string, severity: Severity, title = key, openedAt = T0): OpenCondition {
  const alert: Alert = {key, kind: "condition", severity, rule: "state-x", chain: "ethereum", title};
  return {alert, openedAt, lastSentAt: openedAt};
}

/** A sink's stats from its targets' (counts summed, the longest failure). */
function sinkStats(targets: Record<string, Partial<TargetStats>>): DeliveryStats {
  const stats: DeliveryStats = {ok: 0, failed: 0, retries: 0, targets: {}};
  for (const [id, partial] of Object.entries(targets)) {
    const target: TargetStats = {ok: 0, failed: 0, retries: 0, undelivered: 0, ...partial};
    stats.targets[id] = target;
    stats.ok += target.ok;
    stats.failed += target.failed;
    stats.retries += target.retries;
    const {failing} = target;
    if (failing && (!stats.failing || failing.since < stats.failing.since)) stats.failing = failing;
  }
  return stats;
}

const CHANNEL = "-1001234567890";
const ONCALL = "-1009876543210/7";

function status(overrides: Partial<MonitorStatus> = {}): MonitorStatus {
  return {
    now: T0 + 10_000,
    chains: [chain(), chain({chain: "bsc", processedBlock: 50n, confirmedHead: 50n, cycleFailures: 0})],
    openConditions: [],
    deliveries: {telegram: sinkStats({[CHANNEL]: {ok: 5, failed: 1}})},
    decimals: 18,
    ...overrides,
  };
}

const report = {
  at: 1_793_150_000,
  status: "ok",
  required: 10_000_000_000n * WEI,
  chains: [],
  R: 10_000_000_100n * WEI + WEI / 2n,
  I: 40n * WEI,
  uncertain: 0n,
  margin: 60n * WEI + WEI / 2n,
  inFlight: [],
  byLane: {},
  failed: [{messageId: "0x01"}],
  stuck: [{messageId: "0x02"}, {messageId: "0x03"}],
  incomplete: [],
  conditions: [],
} as unknown as ReconcileReport;

describe("stale telemetry", () => {
  it("is high after staleAfterSec, critical after three times that, and names the recall pause", () => {
    expect(staleTelemetryConditions(chain(), T0 + 300_000)).toEqual([]);

    const [high] = staleTelemetryConditions(chain({consecutiveFailures: 3, lastError: "timeout"}), T0 + 301_000);
    expect(high).toMatchObject({
      key: "ethereum:health:stale-telemetry",
      kind: "condition",
      severity: "high",
      rule: "health.stale-telemetry",
      chain: "ethereum",
    });
    expect(high!.note).toContain("LiquidityManager.pauseRecall()");
    expect(high!.note).toContain("setRecallPaused(false)");
    expect(high!.note).toContain("Design §5");
    expect(high!.fields).toContainEqual({label: "Last error", value: "timeout", code: true});
    expect(high!.fields).toContainEqual({label: "Lag", value: "3 blocks"});

    expect(staleTelemetryConditions(chain(), T0 + 900_000)[0]!.severity).toBe("high");
    expect(staleTelemetryConditions(chain(), T0 + 901_000)[0]!.severity).toBe("critical");
  });

  it("is stale when the confirmed head stops advancing, although every cycle catches up", () => {
    const frozen = chain({processedBlock: 100n, confirmedHead: 100n, headAdvancedAt: T0, lastCaughtUpAt: T0 + 290_000});
    expect(staleTelemetryConditions(frozen, T0 + 300_000)).toEqual([]);
    const [alert] = staleTelemetryConditions(frozen, T0 + 301_000);
    expect(alert).toMatchObject({severity: "high", title: "Stale telemetry: ethereum head not advancing for 5m"});
    expect(alert!.fields).toContainEqual({label: "Head last advanced", value: "2026-10-28 00:30:00 UTC"});
    expect(staleTelemetryConditions(frozen, T0 + 901_000)[0]!.severity).toBe("critical");

    // A head that keeps advancing while the cursor does not is the usual "not caught up".
    const behind = chain({headAdvancedAt: T0 + 290_000, lastCaughtUpAt: T0});
    expect(staleTelemetryConditions(behind, T0 + 301_000)[0]!.title).toBe(
      "Stale telemetry: ethereum not caught up for 5m",
    );
  });

  it("names an RPC behind the processed block", () => {
    const behind = chain({processedBlock: 1_000n, confirmedHead: 900n, lastCaughtUpAt: undefined});
    const [alert] = staleTelemetryConditions(behind, T0 + 301_000);
    expect(alert!.fields).toContainEqual({
      label: "RPC behind",
      value: "the confirmed head is 100 blocks below the processed block",
    });
    expect(alert!.fields!.find((field) => field.label === "Lag")).toBeUndefined();
    expect(healthz(status({chains: [behind]})).body.chains).toMatchObject({ethereum: {lagBlocks: -100}});
  });

  it("keeps counting from a staleness carried over a restart until the first catch-up", () => {
    const restarted = chain({lastCaughtUpAt: undefined, since: T0, staleSince: T0 - 1_200_000});
    const [alert] = staleTelemetryConditions(restarted, T0 + 1_000);
    expect(alert!.severity).toBe("critical");
    expect(alert!.fields![0]!.value).toBe(
      "never since the start (2026-10-28 00:30:00 UTC); stale before it since about 2026-10-28 00:10:00 UTC",
    );
    expect(staleTelemetryConditions({...restarted, lastCaughtUpAt: T0 + 1_000}, T0 + 2_000)).toEqual([]);
  });

  it("carries over the latest staleness start that matches the open condition", () => {
    const S = 300_000;
    const stale = (severity: Severity, openedAt: number, lastSentAt: number) => ({
      alert: {...open("ethereum:health:stale-telemetry", severity).alert},
      openedAt,
      lastSentAt,
    });
    // Opened at high: it was just over staleAfterSec old then.
    expect(carriedStaleSince(stale("high", T0, T0 + 3_600_000), 300)).toBe(T0 - S - 1_000);
    // Escalated later: it opened at staleAfterSec and was over 3x old at its last message.
    expect(carriedStaleSince(stale("critical", T0, T0 + 2 * S), 300)).toBe(T0 - S - 1_000);
    // Opened straight at critical (e.g. after a hung cycle): over 3x old already then.
    expect(carriedStaleSince(stale("critical", T0, T0), 300)).toBe(T0 - 3 * S - 1_000);
  });

  it("counts from the start while the chain never caught up", () => {
    const fresh = chain({lastCaughtUpAt: undefined, since: T0, processedBlock: undefined});
    expect(staleTelemetryConditions(fresh, T0 + 300_000)).toEqual([]);
    const [alert] = staleTelemetryConditions(fresh, T0 + 301_000);
    expect(alert!.fields![0]!.value).toContain("never since the start");

    const backfilling = staleTelemetryConditions({...fresh, backfill: {next: 80n, to: 100n}}, T0 + 301_000);
    expect(backfilling[0]!.fields).toContainEqual({
      label: "Backfill",
      value: "first-start backfill in progress at block 80 of 100",
    });
  });

  it("caps a progressing first-start backfill at warning, but escalates one that keeps failing", () => {
    const backfill = chain({lastCaughtUpAt: undefined, since: T0, processedBlock: 80n, backfill: {next: 80n, to: 100n}});
    expect(staleTelemetryConditions(backfill, T0 + 301_000)[0]!.severity).toBe("warning");
    expect(staleTelemetryConditions(backfill, T0 + 901_000)[0]!.severity).toBe("warning");
    const failing = {...backfill, consecutiveFailures: 2, lastError: "timeout"};
    expect(staleTelemetryConditions(failing, T0 + 301_000)[0]!.severity).toBe("high");
    expect(staleTelemetryConditions(failing, T0 + 901_000)[0]!.severity).toBe("critical");
  });
});

describe("failed state reads", () => {
  // As the state rules raise it (state-common.ts finish()).
  const readFailed: Alert = {
    key: "ethereum:state-token:read-failed",
    kind: "condition",
    severity: "warning",
    rule: "state-token.read-failed",
    chain: "ethereum",
    title: "Cannot verify state-token: 2 read(s) failed",
    fields: [{label: "Failed reads", value: "Token.owner()\nToken.paused()", code: true}],
    note: "Conditions open from the last cycle stay open until the reads succeed again.",
  };

  it("is warning up to staleAfterSec, high after it and critical after three times that", () => {
    expect(readFailedSeverity(0, 300)).toBe("warning");
    expect(readFailedSeverity(300, 300)).toBe("warning");
    expect(readFailedSeverity(301, 300)).toBe("high");
    expect(readFailedSeverity(900, 300)).toBe("high");
    expect(readFailedSeverity(901, 300)).toBe("critical");
  });

  it("escalates the read-failed condition by the failures' age, with the last success and the recall note", () => {
    const reads = {okAt: T0 - 5_000, failingSince: T0};
    const fresh = escalateReadFailed(readFailed, reads, T0 + 300_000, 300);
    expect(fresh.severity).toBe("warning");
    expect(fresh.note).toBe(readFailed.note);
    expect(fresh.fields).toEqual([
      ...readFailed.fields!,
      {label: "Failing for", value: "5m since 2026-10-28 00:30:00 UTC (limit 5m)"},
      {label: "Last successful read", value: "2026-10-28 00:29:55 UTC"},
    ]);

    const high = escalateReadFailed(readFailed, reads, T0 + 301_000, 300);
    expect(high).toMatchObject({key: readFailed.key, rule: readFailed.rule, title: readFailed.title, severity: "high"});
    expect(high.note).toContain("what state-token verifies is unknown, which is stale telemetry");
    expect(high.note).toContain("LiquidityManager.pauseRecall()");
    expect(high.note).toContain(readFailed.note);

    // Never succeeded; applied again to an escalated alert, the fields are replaced, not repeated.
    const critical = escalateReadFailed(high, {failingSince: T0}, T0 + 901_000, 300);
    expect(critical.severity).toBe("critical");
    expect(critical.fields!.map((field) => field.label)).toEqual([
      "Failed reads",
      "Failing for",
      "Last successful read",
    ]);
    expect(critical.fields!.at(-1)).toEqual({label: "Last successful read", value: "none recorded"});
  });

  it("makes the chain stale for /healthz and /metrics once a rule's reads failed for more than staleAfterSec", () => {
    const failing = chain({reads: {"state-token": {okAt: T0 - 5_000, failingSince: T0}, "state-pool": {okAt: T0}}});
    const at = (now: number) => status({now, chains: [failing]});
    expect(readsStale(failing, T0 + 300_000)).toBe(false);
    expect(healthz(at(T0 + 300_000))).toMatchObject({
      code: 200,
      body: {
        status: "ok",
        chains: {
          ethereum: {
            stale: false,
            readsStale: false,
            readsFailingForSec: 300,
            failingReads: {
              "state-token": {
                since: new Date(T0).toISOString(),
                lastOkAt: new Date(T0 - 5_000).toISOString(),
                forSec: 300,
              },
            },
          },
        },
      },
    });
    expect(renderMetrics(at(T0 + 300_000))).toContain('sahara_monitor_chain_state_reads_stale{chain="ethereum"} 0');

    // The scan is fresh (caught up at T0 + 300 s): only the reads make the chain stale.
    const stale = status({now: T0 + 301_000, chains: [{...failing, lastCaughtUpAt: T0 + 300_000}]});
    expect(healthz(stale)).toMatchObject({
      code: 503,
      body: {
        status: "stale",
        chains: {ethereum: {stale: false, staleForSec: 1, readsStale: true, readsFailingForSec: 301}},
      },
    });
    const metrics = renderMetrics(stale);
    expect(metrics).toContain('sahara_monitor_chain_state_reads_stale{chain="ethereum"} 1');
    expect(metrics).toContain('sahara_monitor_chain_stale{chain="ethereum"} 0');
  });

  it("lists the CCIP blocks not scanned yet and the last replay error in /healthz", () => {
    const gaps = chain({ccipGaps: [{from: 400n, to: 500n}], ccipGapError: "eth_getLogs failed"});
    expect(healthz(status({chains: [gaps]})).body.chains).toMatchObject({
      ethereum: {ccipGaps: [{from: 400, to: 500}], ccipGapError: "eth_getLogs failed"},
    });
  });
});

describe("blocked reconciliation", () => {
  const blocked: ReconcileHealth = {
    staleAfterSec: 900,
    failures: 0,
    completeAt: T0 - 300_000,
    blockedSince: T0,
    reasons: ["ethereum unreachable: balance reads at block 160 failed: HTTP request failed: 429"],
  };

  it("is high once blocked for more than staleAfterSec and critical after three times that", () => {
    expect(reconcileStale(blocked, T0 + 900_000)).toBe(false);
    expect(reconcileStaleConditions(blocked, T0 + 900_000)).toEqual([]);
    expect(reconcileStale(blocked, T0 + 901_000)).toBe(true);
    const [high] = reconcileStaleConditions(blocked, T0 + 901_000);
    expect(high).toMatchObject({
      key: "global:health:reconcile-stale",
      kind: "condition",
      severity: "high",
      rule: "health.reconcile-stale",
      title: "Reconciliation blocked for 15m: R − I not verified",
    });
    expect(high!.chain).toBeUndefined();
    expect(high!.fields).toEqual([
      {label: "Blocked for", value: "15m since 2026-10-28 00:30:00 UTC (limit 15m)"},
      {label: "Last complete reconciliation", value: "2026-10-28 00:25:00 UTC"},
      {label: "Blocking reasons", value: blocked.reasons![0]},
    ]);
    expect(high!.note).toContain("Design §5: disable recall when in-flight obligations cannot be bounded");
    expect(high!.note).toContain("LiquidityManager.pauseRecall()");
    expect(reconcileStaleConditions(blocked, T0 + 2_700_000)[0]!.severity).toBe("high");
    expect(reconcileStaleConditions(blocked, T0 + 2_701_000)[0]!.severity).toBe("critical");

    // Not blocked: nothing, however old the last complete run; a run that threw: its error.
    expect(reconcileStaleConditions({staleAfterSec: 900, failures: 0, completeAt: T0}, T0 + 86_400_000)).toEqual([]);
    expect(reconcileStale(undefined, T0)).toBe(false);
    const threw = {staleAfterSec: 900, failures: 4, blockedSince: T0, error: "boom"};
    expect(reconcileStaleConditions(threw, T0 + 901_000)[0]!.fields!.slice(1)).toEqual([
      {label: "Last complete reconciliation", value: "none recorded"},
      {label: "Last error", value: "boom", code: true},
    ]);
  });

  it("counts every blocking reason as a failure except CCIP tracking disabled by config and CCIP gaps", () => {
    const reason = (cause: IncompleteReason["cause"], blocking = true): IncompleteReason => ({
      reason: cause,
      blocking,
      cause,
    });
    const incomplete = [
      reason("unreachable"),
      reason("ccip-disabled"),
      reason("ccip-not-started"),
      reason("ccip-scan-behind"),
      reason("ccip-gap"),
      reason("ramps-unreadable", false),
      reason("unknown-destination", false),
    ];
    const failures = blockingFailures({...report, status: "incomplete", incomplete});
    expect(failures.map((entry) => entry.cause)).toEqual(["unreachable", "ccip-not-started", "ccip-scan-behind"]);
    expect(blockingFailures({...report, status: "incomplete", incomplete: [reason("ccip-disabled")]})).toEqual([]);
  });

  it("makes /healthz 503 stale and shows it in /metrics once stale, with the reasons and error redacted", () => {
    registerHeartbeatSecret("https://rpc.example.com/v2/reconcile-secret-key");
    const runs = {...blocked, failures: 2, error: "fetch https://rpc.example.com/v2/reconcile-secret-key failed"};
    const fresh = status({now: T0 + 900_000, chains: [chain({lastCaughtUpAt: T0 + 900_000})], reconcileHealth: runs});
    expect(healthz(fresh)).toMatchObject({
      code: 200,
      body: {
        status: "ok",
        reconcile: {
          stale: false,
          blockedSince: new Date(T0).toISOString(),
          blockedForSec: 900,
          lastCompleteAt: new Date(T0 - 300_000).toISOString(),
          failures: 2,
          reasons: blocked.reasons,
          error: "fetch <redacted> failed",
        },
      },
    });
    expect(Object.keys(healthz(fresh).body)).toEqual(["status", "chains", "reconcile", "deliveries"]);
    const metrics = renderMetrics(fresh);
    expect(metrics).toContain("\nsahara_monitor_reconcile_stale 0\n");
    expect(metrics).toContain("\nsahara_monitor_reconcile_blocked_seconds 900\n");
    expect(metrics).toContain("\nsahara_monitor_reconcile_failures_total 2\n");

    const stale = {...fresh, now: T0 + 901_000};
    expect(healthz(stale)).toMatchObject({code: 503, body: {status: "stale", reconcile: {stale: true}}});
    expect(healthz(stale).body.chains).toMatchObject({ethereum: {stale: false, readsStale: false}});
    expect(renderMetrics(stale)).toContain("\nsahara_monitor_reconcile_stale 1\n");
    // Disabled: no block and no sample.
    expect(healthz(status()).body).not.toHaveProperty("reconcile");
    expect(renderMetrics(status())).not.toMatch(/^sahara_monitor_reconcile_(stale|blocked_seconds|failures_total) /m);
  });

  it("is in the daily summary, in capitals once stale, and in the startup message when persisted as blocked", () => {
    const config = daemonConfig({reconciliation: {enabled: true}});
    const line = (now: number, runs: ReconcileHealth) =>
      dailySummaryAlert({date: "2026-10-28", config, status: status({now, reconcileHealth: runs}), snapshots: {}})
        .fields!.find((field) => field.label === "Reconciliation")!.value;
    expect(line(T0 + 600_000, blocked)).toBe(
      `not run yet; blocked for 10m since 2026-10-28 00:30:00 UTC (limit 15m): ${blocked.reasons![0]}`,
    );
    expect(line(T0 + 901_000, {...blocked, reasons: undefined, error: "boom"})).toBe(
      "not run yet; BLOCKED for 15m since 2026-10-28 00:30:00 UTC (limit 15m): boom",
    );
    expect(line(T0, {staleAfterSec: 900, failures: 0})).toBe("not run yet");

    const dropped: Alert = {key: "global:reconcile:failed", kind: "condition", severity: "high", rule: "x", title: "B"};
    const started = startupAlert(T0 + 60_000, [], {reconcile: blocked, dropped: [dropped]});
    expect(started.fields!.map((field) => field.label)).toEqual([
      "Started at",
      "Reconciliation",
      "Open conditions dropped (no longer evaluated: chain removed, reconciliation or CCIP disabled)",
    ]);
    expect(started.fields![1]!.value.split("\n")).toEqual([
      "Blocked for 1m since 2026-10-28 00:30:00 UTC (limit 15m) at the start, still counted until a run completes",
      blocked.reasons![0],
    ]);
    expect(startupAlert(T0, [], {reconcile: {staleAfterSec: 900, failures: 0}}).fields).toHaveLength(1);
  });
});

describe("/healthz", () => {
  it("is 200 ok while every chain is fresh and 503 stale otherwise, with redacted errors", () => {
    expect(healthz(status())).toEqual({
      code: 200,
      body: {
        status: "ok",
        chains: {
          ethereum: {
            processedBlock: 100,
            confirmedHead: 103,
            lagBlocks: 3,
            lastCaughtUpAt: new Date(T0).toISOString(),
            headAdvancedAt: null,
            staleForSec: 10,
            stale: false,
            readsStale: false,
            readsFailingForSec: 0,
            failingReads: {},
            ccipGaps: [],
            ccipGapReplayStale: false,
            ccipGapFailingForSec: 0,
            cycleFailures: 2,
          },
          bsc: expect.objectContaining({lagBlocks: 0, stale: false}),
        },
        deliveries: {
          telegram: {
            ok: 5,
            failed: 1,
            retries: 0,
            failing: false,
            targets: {
              [CHANNEL]: {ok: 5, failed: 1, retries: 0, failing: false, outboxMessages: 0, outboxOldestAgeSec: 0},
            },
          },
        },
      },
    });
    registerHeartbeatSecret("https://rpc.example.com/v2/healthz-secret-key");
    const stale = status({
      now: T0 + 301_000,
      chains: [chain({lastError: "fetch https://rpc.example.com/v2/healthz-secret-key failed"})],
    });
    const result = healthz(stale);
    expect(result.code).toBe(503);
    expect(result.body.status).toBe("stale");
    expect(JSON.stringify(result.body)).not.toContain("healthz-secret-key");
  });

  it("is 503 delivery-failing while a target fails, even with every chain fresh; shows each target's backlog", () => {
    const failing: DeliveryFailure = {
      since: T0,
      severity: "critical",
      error: "403 Forbidden: bot was kicked",
      kind: "route",
    };
    const deliveries = {
      telegram: sinkStats({
        [CHANNEL]: {ok: 5, undelivered: 0},
        [ONCALL]: {ok: 1, retries: 4, failing, undelivered: 3, oldestUndeliveredAt: T0 - 50_000},
      }),
      console: sinkStats({stdout: {ok: 7}}),
    };
    const result = healthz(status({deliveries}));
    expect(result.code).toBe(503);
    expect(result.body.status).toBe("delivery-failing");
    expect(result.body.deliveries).toEqual({
      telegram: {
        ok: 6,
        failed: 0,
        retries: 4,
        failing: true,
        failingSince: new Date(T0).toISOString(),
        failingKind: "route",
        lastError: "403 Forbidden: bot was kicked",
        targets: {
          [CHANNEL]: {ok: 5, failed: 0, retries: 0, failing: false, outboxMessages: 0, outboxOldestAgeSec: 0},
          [ONCALL]: {
            ok: 1,
            failed: 0,
            retries: 4,
            failing: true,
            failingSince: new Date(T0).toISOString(),
            failingKind: "route",
            lastError: "403 Forbidden: bot was kicked",
            outboxMessages: 3,
            outboxOldestAgeSec: 60,
          },
        },
      },
      console: {
        ok: 7,
        failed: 0,
        retries: 0,
        failing: false,
        targets: {stdout: {ok: 7, failed: 0, retries: 0, failing: false, outboxMessages: 0, outboxOldestAgeSec: 0}},
      },
    });
    expect(failingSinks({deliveries})).toEqual(["telegram"]);
    expect(failingTargets({deliveries})).toEqual([`telegram ${ONCALL}`]);
    // Staleness wins the status text.
    const stale = status({now: T0 + 301_000, deliveries: {telegram: sinkStats({[CHANNEL]: {failed: 1, failing}})}});
    expect(healthz(stale).body.status).toBe("stale");
  });
});

describe("/metrics", () => {
  const NAMES = [
    "sahara_monitor_up",
    "sahara_monitor_chain_processed_block",
    "sahara_monitor_chain_confirmed_head",
    "sahara_monitor_chain_lag_blocks",
    "sahara_monitor_chain_last_caught_up_timestamp_seconds",
    "sahara_monitor_chain_stale",
    "sahara_monitor_chain_state_reads_stale",
    "sahara_monitor_chain_ccip_gap_replay_stale",
    "sahara_monitor_chain_cycle_failures_total",
    "sahara_monitor_open_conditions",
    "sahara_monitor_alert_deliveries_total",
    "sahara_monitor_alert_delivery_retries_total",
    "sahara_monitor_alert_sink_failing",
    "sahara_monitor_alert_outbox_messages",
    "sahara_monitor_alert_outbox_oldest_age_seconds",
    "sahara_monitor_reconcile_complete",
    "sahara_monitor_reconcile_backing_tokens",
    "sahara_monitor_reconcile_inflight_tokens",
    "sahara_monitor_reconcile_margin_tokens",
    "sahara_monitor_reconcile_failed_messages",
    "sahara_monitor_reconcile_stuck_messages",
    "sahara_monitor_reconcile_last_run_timestamp_seconds",
    "sahara_monitor_reconcile_stale",
    "sahara_monitor_reconcile_blocked_seconds",
    "sahara_monitor_reconcile_failures_total",
  ];

  it("exposes exactly the contract's metric names with HELP and TYPE", () => {
    const text = renderMetrics(status({reconcile: report, reconcileHealth: {staleAfterSec: 900, failures: 0}}));
    const typed = [...text.matchAll(/^# TYPE (\S+) (gauge|counter)$/gm)].map((match) => match[1]);
    expect(typed).toEqual(NAMES);
    const sampled = new Set([...text.matchAll(/^([a-z_]+)(?:\{| )/gm)].map((match) => match[1]));
    expect([...sampled].sort()).toEqual([...NAMES].sort());
    expect(text.endsWith("\n")).toBe(true);
  });

  it("renders per-chain, per-severity, per-sink and reconciliation samples", () => {
    const text = renderMetrics(
      status({
        now: T0 + 301_000,
        chains: [chain(), chain({chain: "bsc", lastCaughtUpAt: undefined, processedBlock: undefined})],
        openConditions: [open("a", "critical"), open("b", "warning"), open("c", "warning")],
        reconcile: report,
      }),
    );
    const lines = text.split("\n").filter((line) => !line.startsWith("#"));
    expect(lines).toEqual(
      expect.arrayContaining([
        "sahara_monitor_up 1",
        'sahara_monitor_chain_processed_block{chain="ethereum"} 100',
        'sahara_monitor_chain_confirmed_head{chain="bsc"} 103',
        'sahara_monitor_chain_lag_blocks{chain="ethereum"} 3',
        `sahara_monitor_chain_last_caught_up_timestamp_seconds{chain="ethereum"} ${T0 / 1000}`,
        'sahara_monitor_chain_last_caught_up_timestamp_seconds{chain="bsc"} 0',
        'sahara_monitor_chain_stale{chain="ethereum"} 1',
        'sahara_monitor_chain_cycle_failures_total{chain="ethereum"} 2',
        'sahara_monitor_open_conditions{severity="critical"} 1',
        'sahara_monitor_open_conditions{severity="high"} 0',
        'sahara_monitor_open_conditions{severity="warning"} 2',
        'sahara_monitor_open_conditions{severity="info"} 0',
        `sahara_monitor_alert_deliveries_total{sink="telegram",target="${CHANNEL}",result="ok"} 5`,
        `sahara_monitor_alert_deliveries_total{sink="telegram",target="${CHANNEL}",result="failed"} 1`,
        `sahara_monitor_alert_delivery_retries_total{sink="telegram",target="${CHANNEL}"} 0`,
        `sahara_monitor_alert_sink_failing{sink="telegram",target="${CHANNEL}"} 0`,
        `sahara_monitor_alert_outbox_messages{sink="telegram",target="${CHANNEL}"} 0`,
        `sahara_monitor_alert_outbox_oldest_age_seconds{sink="telegram",target="${CHANNEL}"} 0`,
        "sahara_monitor_reconcile_complete 1",
        "sahara_monitor_reconcile_backing_tokens 10000000100.5",
        "sahara_monitor_reconcile_inflight_tokens 40",
        "sahara_monitor_reconcile_margin_tokens 60.5",
        "sahara_monitor_reconcile_failed_messages 1",
        "sahara_monitor_reconcile_stuck_messages 2",
        "sahara_monitor_reconcile_last_run_timestamp_seconds 1793150000",
      ]),
    );
    // No processed block on bsc: no processed/lag sample for it.
    expect(text).not.toContain('sahara_monitor_chain_processed_block{chain="bsc"}');
    expect(text).not.toContain('sahara_monitor_chain_lag_blocks{chain="bsc"}');

    const failing: DeliveryFailure = {since: T0, severity: "high", error: "x", kind: "transient"};
    const backlog = {failing, retries: 3, undelivered: 4, oldestUndeliveredAt: T0 - 90_000};
    const down = renderMetrics(status({deliveries: {telegram: sinkStats({[CHANNEL]: {ok: 2}, [ONCALL]: backlog})}}));
    expect(down.split("\n")).toEqual(
      expect.arrayContaining([
        `sahara_monitor_alert_sink_failing{sink="telegram",target="${CHANNEL}"} 0`,
        `sahara_monitor_alert_sink_failing{sink="telegram",target="${ONCALL}"} 1`,
        `sahara_monitor_alert_delivery_retries_total{sink="telegram",target="${ONCALL}"} 3`,
        `sahara_monitor_alert_outbox_messages{sink="telegram",target="${ONCALL}"} 4`,
        `sahara_monitor_alert_outbox_oldest_age_seconds{sink="telegram",target="${ONCALL}"} 100`,
      ]),
    );
  });

  it("omits reconciliation samples before the first run and R/I/margin when unknown", () => {
    expect(renderMetrics(status())).not.toMatch(/^sahara_monitor_reconcile_/m);
    const incomplete = {...report, status: "incomplete", R: undefined, I: undefined, margin: undefined};
    const text = renderMetrics(status({reconcile: incomplete as ReconcileReport}));
    expect(text).toContain("sahara_monitor_reconcile_complete 0");
    expect(text).not.toMatch(/^sahara_monitor_reconcile_(backing|inflight|margin)_tokens /m);
  });
});

describe("status server", () => {
  it("answers 405 to other methods, 404 to other paths and 500 when the status fails", async () => {
    let fail = false;
    const server = createStatusServer(() => {
      if (fail) throw new Error("boom");
      return status();
    }, silentLogger);
    const address = await listen(server, "127.0.0.1", 0);
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/healthz`, {method: "POST"})).status).toBe(405);
      expect((await fetch(`${base}/`)).status).toBe(404);
      expect((await fetch(`${base}/healthz?verbose=1`)).status).toBe(200);
      fail = true;
      expect((await fetch(`${base}/metrics`)).status).toBe(500);
    } finally {
      await closeServer(server);
    }
  });
});

describe("heartbeat", () => {
  it("returns true on 2xx and only logs failures, without the URL", async () => {
    const url = "https://hc-ping.example.com/heartbeat-secret-0123";
    registerHeartbeatSecret(url);
    expect(redact(url)).toBe("<redacted>");
    const log = logger();
    expect(await sendHeartbeat(url, async () => new Response("ok"), log)).toBe(true);
    expect(await sendHeartbeat(url, async () => new Response("no", {status: 500}), log)).toBe(false);
    const failing = vi.fn(async () => {
      throw new Error(`getaddrinfo ENOTFOUND ${url}`);
    });
    expect(await sendHeartbeat(url, failing, log)).toBe(false);
    expect(log.lines.map((line) => line.message)).toEqual(["heartbeat rejected", "heartbeat failed"]);
    expect(JSON.stringify(log.lines)).not.toContain("heartbeat-secret-0123");
  });
});

describe("startup message", () => {
  it("lists every chain's cursor, backfill, pending Timelock operations and suppressed alerts", () => {
    const alert = startupAlert(
      T0,
      [
        {
          chain: "ethereum",
          cursor: 100n,
          mode: "backfill",
          backfill: {from: 50n, to: 100n, resumedAt: 70n},
          pendingTimelockOps: 2,
          suppressed: 7,
        },
        {chain: "bsc", cursor: 499n, mode: "fresh", pendingTimelockOps: 0, suppressed: 0},
      ],
      {dryRun: true},
    );
    expect(alert).toMatchObject({
      key: `global:health:started:${T0}`,
      kind: "event",
      severity: "info",
      rule: "health.started",
      title: "Monitor started (dry run)",
    });
    expect(alert.chain).toBeUndefined();
    expect(alert.fields!.map((field) => field.label)).toEqual(["Started at", "ethereum", "bsc"]);
    expect(alert.fields!.slice(1)).toEqual([
      {
        label: "ethereum",
        value: [
          "Starting cursor: block 100",
          "Backfill (Timelock and CCIP only, muted): blocks 50–100 (resumed at block 70)",
          "Pending Timelock operations known: 2",
          "Historical event alerts suppressed: 7",
        ].join("\n"),
      },
      {
        label: "bsc",
        value: [
          "Starting cursor: block 499",
          "no backfill: Timelock proposals and CCIP messages before block 500 are not tracked – set startBlock",
          "Pending Timelock operations known: 0",
          "Historical event alerts suppressed: 0",
        ].join("\n"),
      },
    ]);
  });
});

describe("startup message with CCIP gaps", () => {
  it("lists the CCIP blocks to replay in the background", () => {
    const alert = startupAlert(T0, [
      {
        chain: "ethereum",
        cursor: 700n,
        mode: "resumed",
        pendingTimelockOps: 0,
        suppressed: 0,
        ccipGaps: [
          {from: 400n, to: 600n},
          {from: 650n, to: 650n},
        ],
      },
    ]);
    expect(alert.fields![1]!.value.split("\n")).toEqual([
      "Starting cursor: block 700",
      "Resumed from the stored cursor (this state file started without a backfill)",
      "CCIP blocks not scanned yet (replayed muted in the background; reconciliation is incomplete until done): " +
        "400–600, 650–650 (202 blocks)",
      "Pending Timelock operations known: 0",
      "Historical event alerts suppressed: 0",
    ]);
  });
});

describe("startup message with dropped conditions", () => {
  it("lists the open conditions dropped because no rule evaluates them any more", () => {
    const backing: Alert = {
      key: "global:reconcile:backing",
      kind: "condition",
      severity: "critical",
      rule: "reconcile.backing",
      title: "Backing breach",
    };
    const ramps: Alert = {...backing, key: "bsc:ccip:ramps", severity: "warning", chain: "bsc", title: "Ramps unread"};
    const alert = startupAlert(T0, [], {dropped: [backing, ramps]});
    expect(alert.fields!.at(-1)).toEqual({
      label: "Open conditions dropped (no longer evaluated: chain removed, reconciliation or CCIP disabled)",
      value: "CRITICAL: Backing breach\nWARNING bsc: Ramps unread",
    });
  });
});

describe("daily summary", () => {
  it("is due once per UTC day at or after the configured time", () => {
    const at = (hours: number, minutes = 0, day = 28) => Date.UTC(2026, 9, day, hours, minutes);
    expect(dueSummaryDate(at(12), undefined, undefined)).toBeUndefined();
    expect(dueSummaryDate(at(0, 59), "01:00", undefined)).toBeUndefined();
    expect(dueSummaryDate(at(1), "01:00", undefined)).toBe("2026-10-28");
    expect(dueSummaryDate(at(23, 59), "01:00", "2026-10-27")).toBe("2026-10-28");
    expect(dueSummaryDate(at(23, 59), "01:00", "2026-10-28")).toBeUndefined();
    expect(dueSummaryDate(at(0, 30, 29), "01:00", "2026-10-28")).toBeUndefined();
    expect(dueSummaryDate(at(1, 0, 29), "01:00", "2026-10-28")).toBe("2026-10-29");
  });

  it("summarises chains, inventory and budgets, reconciliation and open critical/high conditions", () => {
    const config = daemonConfig({reconciliation: {enabled: true}});
    const alert = dailySummaryAlert({
      date: "2026-10-28",
      config,
      status: status({
        reconcile: report,
        openConditions: [
          open("a", "critical", "Pool below minimum", T0 - 3_600_000),
          open("b", "high", "Budget exhausted"),
          open("c", "warning", "Operator suspended"),
        ],
      }),
      snapshots: {
        ethereum: {
          "state-inventory": {"Manager balance": "100 SAHARA", "Pool balance": "8,000,000 SAHARA"},
          "state-manager": {
            "Manager owner": "Timelock",
            "Aggregate funding budget": "10 of 20 SAHARA",
            "Recall budget": "not configured (capacity 0)",
            "Funding budget of Pool": "5 of 10 SAHARA",
            "Recall paused": "no",
          },
          "state-token": {"Token owner": "Timelock"},
          "timelock-queue": {"Pending Timelock operations": "1"},
        },
      },
    });
    expect(alert).toMatchObject({
      key: "global:health:daily-summary:2026-10-28",
      kind: "event",
      severity: "info",
      rule: "health.daily-summary",
      title: "Daily summary 2026-10-28: 2 critical/high conditions open",
    });
    const labels = alert.fields!.map((field) => field.label);
    expect(labels).toEqual([
      "ethereum",
      "ethereum · Manager balance",
      "ethereum · Pool balance",
      "ethereum · Aggregate funding budget",
      "ethereum · Recall budget",
      "ethereum · Funding budget of Pool",
      "ethereum · Recall paused",
      "ethereum · Pending Timelock operations",
      "bsc",
      "Reconciliation",
      "Open conditions",
      "Deliveries",
    ]);
    const value = (label: string) => alert.fields!.find((field) => field.label === label)!.value;
    expect(value("ethereum")).toBe("block 100 (lag 3), caught up 2026-10-28 00:30:00 UTC, 2 failed cycles");
    expect(value("Reconciliation")).toBe(
      "OK at 2026-10-28 01:13:20 UTC: R 10,000,000,100.5 SAHARA, I 40 SAHARA, margin 60.5 SAHARA; " +
        "1 failed, 2 stuck messages",
    );
    expect(value("Open conditions")).toBe("critical 1, high 1, warning 1, info 0");
    expect(alert.note).toBe(
      [
        "Open critical/high conditions:",
        "• CRITICAL ethereum: Pool below minimum (open 1h)",
        "• HIGH ethereum: Budget exhausted (open 10s)",
      ].join("\n"),
    );
  });

  it("says when nothing urgent is open and when reconciliation is disabled", () => {
    const alert = dailySummaryAlert({
      date: "2026-10-28",
      config: daemonConfig({reconciliation: {enabled: false}}),
      status: status(),
      snapshots: {},
    });
    expect(alert.title).toBe("Daily summary 2026-10-28: no critical/high condition open");
    expect(alert.note).toBe("No critical or high condition is open.");
    expect(alert.fields!.find((field) => field.label === "Reconciliation")!.value).toBe("disabled");
  });

  it("names failing state reads, stale ones in capitals, and CCIP blocks not scanned yet", () => {
    const summary = (now: number) =>
      dailySummaryAlert({
        date: "2026-10-28",
        config: daemonConfig(),
        status: status({
          now,
          chains: [
            chain({
              lastCaughtUpAt: now,
              reads: {"state-pool": {failingSince: T0}, "state-router": {failingSince: T0 + 60_000}, "state-token": {}},
              ccipGaps: [{from: 400n, to: 500n}],
            }),
          ],
        }),
        snapshots: {},
      }).fields![0]!.value;
    const caughtUp = (now: number) => `caught up ${formatTimestamp(Math.floor(now / 1000))}`;
    expect(summary(T0 + 120_000)).toBe(
      `block 100 (lag 3), ${caughtUp(T0 + 120_000)}, 2 failed cycles; ` +
        "state reads failing: state-pool for 2m, state-router for 1m; " +
        "CCIP blocks not scanned yet: 400–500 (101 blocks)",
    );
    expect(summary(T0 + 301_000)).toContain("STATE READS STALE: state-pool for 5m, state-router for 4m");
  });

  it("flags a sink with a failing target, and its undelivered messages", () => {
    const failing: DeliveryFailure = {since: T0, severity: "high", error: "x", kind: "transient"};
    const alert = dailySummaryAlert({
      date: "2026-10-28",
      config: daemonConfig(),
      status: status({
        deliveries: {
          telegram: sinkStats({[CHANNEL]: {ok: 5, failed: 1}, [ONCALL]: {failing, undelivered: 2}}),
          console: sinkStats({stdout: {ok: 3}}),
        },
      }),
      snapshots: {},
    });
    expect(alert.fields!.find((field) => field.label === "Deliveries")!.value).toBe(
      "telegram 5 ok, 1 failed, 2 undelivered, FAILING since 2026-10-28 00:30:00 UTC; console 3 ok, 0 failed",
    );
  });
});
