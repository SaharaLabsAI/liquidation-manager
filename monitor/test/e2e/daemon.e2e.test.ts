// End-to-end scenarios for the daemon: the real entry point (`node src/cli.ts run`) as a child process against anvil
// (the contracts in their post-handover state) and the Telegram mock. These test the wiring – config loading, the
// muted first-start backfill, cursor and rule order, alert delivery (also through a Telegram outage and a restart
// during it), /healthz and /metrics, signals and restart, the one-shot commands – not the rules again: every assertion
// is on what an operator sees (Telegram messages, HTTP status, exit codes, stdout/stderr, the state file).
//
// The scenarios share one anvil node, one deployment and one state file, and run in order: each builds on the chain
// and monitor state the previous ones left.
import {existsSync, readFileSync, rmSync} from "node:fs";
import {join} from "node:path";

import {encodeFunctionData, zeroHash, type Hex, type TransactionReceipt} from "viem";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {guardianControllerAbi, saharaTimelockAbi} from "../../src/abi/generated.ts";
import {anvilAvailable, startAnvil, type Anvil} from "./helpers/anvil.ts";
import {CHAIN, CHAT_ID, KNOWN_MOCK_CONDITIONS, writeE2EConfig, type E2EConfig} from "./helpers/config.ts";
import {deploySystem, encodeManager, tokens, type E2EDeployment, type TimelockOp} from "./helpers/deploy.ts";
import {deserializeState} from "../../src/store.ts";
import {
  runCli,
  savedCursor,
  savedReads,
  startMonitor,
  waitForSavedCursor,
  type CliResult,
  type MonitorProcess,
} from "./helpers/monitor-process.ts";
import {
  FAKE_BOT_TOKEN,
  firstLine,
  startTelegramMock,
  type TelegramMessage,
  type TelegramMock,
} from "./helpers/telegram-mock.ts";

/**
 * Generous: the sink keeps to Telegram's ~20 messages per minute per chat, and the first daemon sends about that many,
 * so a late message may wait for the window.
 */
const WAIT_MS = 90_000;

/** Message header prefixes (emoji + severity) as TelegramSink renders them. */
const HEADER = {
  critical: "🚨 <b>CRITICAL</b>",
  high: "🔴 <b>HIGH</b>",
  warning: "🟠 <b>WARNING</b>",
  info: "🔵 <b>INFO</b>",
  resolved: "✅ <b>RESOLVED</b>",
} as const;

/** The pinned /metrics names (README "HTTP endpoints"). */
const CHAIN_METRICS = [
  "sahara_monitor_chain_processed_block",
  "sahara_monitor_chain_confirmed_head",
  "sahara_monitor_chain_lag_blocks",
  "sahara_monitor_chain_last_caught_up_timestamp_seconds",
  "sahara_monitor_chain_stale",
  "sahara_monitor_chain_state_reads_stale",
  "sahara_monitor_chain_cycle_failures_total",
];
const RECONCILE_METRICS = [
  "sahara_monitor_reconcile_complete",
  "sahara_monitor_reconcile_backing_tokens",
  "sahara_monitor_reconcile_inflight_tokens",
  "sahara_monitor_reconcile_margin_tokens",
  "sahara_monitor_reconcile_failed_messages",
  "sahara_monitor_reconcile_stuck_messages",
  "sahara_monitor_reconcile_last_run_timestamp_seconds",
  "sahara_monitor_reconcile_stale",
  "sahara_monitor_reconcile_blocked_seconds",
];

interface Healthz {
  status: string;
  chains: Record<
    string,
    {
      processedBlock: number | null;
      confirmedHead: number | null;
      lagBlocks: number | null;
      lastCaughtUpAt: string | null;
      headAdvancedAt: string | null;
      stale: boolean;
      readsStale: boolean;
      failingReads: Record<string, {since: string; lastOkAt: string | null; forSec: number}>;
      ccipGaps: Array<{from: number; to: number}>;
      cycleFailures: number;
    }
  >;
  deliveries: Record<string, DeliveryHealth & {targets: Record<string, DeliveryHealth & TargetBacklog>}>;
}

interface DeliveryHealth {
  ok: number;
  failed: number;
  retries: number;
  failing: boolean;
  failingSince?: string;
  failingKind?: string;
  lastError?: string;
}

interface TargetBacklog {
  outboxMessages: number;
  outboxOldestAgeSec: number;
}

describe.skipIf(!anvilAvailable())("e2e daemon (node src/cli.ts run)", () => {
  let anvil: Anvil | undefined;
  let telegram: TelegramMock | undefined;
  let e2e: E2EConfig | undefined;
  let d: E2EDeployment;
  /** A Manager config call scheduled before the first start, inside the backfill range: known only via the backfill. */
  let preStart: TimelockOp;
  /** The protected setGuardian recovery (scenario 5); stays pending. */
  let recovery: TimelockOp;
  let fundReceipt: TransactionReceipt;
  let recallReceipt: TransactionReceipt;
  /** The running daemon. */
  let monitor: MonitorProcess | undefined;
  /** Output of every process spawned, for the secret checks. */
  const transcripts: Array<{name: string; stdout: () => string; stderr: () => string}> = [];
  const daemons: MonitorProcess[] = [];
  /** Transactions the first daemon alerted: the restarted one must not alert any of them again. */
  const alerted: Hex[] = [];

  beforeAll(async () => {
    anvil = await startAnvil();
    telegram = await startTelegramMock();
    d = await deploySystem(anvil);
    preStart = await d.scheduleTimelockCall(
      d.addresses.manager,
      encodeManager("setMaxFundingPerCall", [tokens(4_000_000)]),
    );
    // Backfill exactly the pre-start schedule: the setup history before it is not replayed.
    e2e = await writeE2EConfig({deployment: d, telegram, startBlock: d.readyBlock + 1n});
  });

  afterAll(async () => {
    await Promise.all(daemons.map((daemon) => daemon.stop("SIGKILL")));
    await telegram?.close();
    await anvil?.stop();
    if (e2e) rmSync(e2e.dir, {recursive: true, force: true});
  });

  const config = (): E2EConfig => {
    if (!e2e) throw new Error("no e2e config");
    return e2e;
  };
  const mock = (): TelegramMock => {
    if (!telegram) throw new Error("no telegram mock");
    return telegram;
  };
  const node = (): Anvil => {
    if (!anvil) throw new Error("no anvil");
    return anvil;
  };
  const spawnDaemon = (): MonitorProcess => {
    const daemon = startMonitor(config(), ["run"]);
    daemons.push(daemon);
    transcripts.push({name: `run #${daemons.length}`, stdout: daemon.stdout, stderr: daemon.stderr});
    return daemon;
  };
  const cli = async (args: string[], options: Partial<E2EConfig> = {}): Promise<CliResult> => {
    const result = await runCli({...config(), ...options}, args);
    transcripts.push({name: args.join(" "), stdout: () => result.stdout, stderr: () => result.stderr});
    return result;
  };
  const statusUrl = (path: string) => `http://127.0.0.1:${config().httpPort}${path}`;
  const waitFor = (predicate: (message: TelegramMessage) => boolean) => mock().waitFor(predicate, WAIT_MS);
  /** Every message about `hash` delivered so far. */
  const messagesAbout = (hash: Hex) => mock().messages.filter((message) => mentions(message, hash));
  const caughtUp = (block: bigint) => waitForSavedCursor(config().stateFile, CHAIN, block);
  /** The saved cursor only: alerts may still wait in the outbox. */
  const scanned = (block: bigint) =>
    waitForSavedCursor(config().stateFile, CHAIN, block, undefined, {delivered: false});

  it("starts with a muted backfill, announces itself and reports healthy once caught up", async () => {
    const head = await node().blockNumber();
    expect(preStart.receipt.blockNumber).toBe(head);
    monitor = spawnDaemon();
    const listening = await monitor.waitForLog((line) => line.msg === "status server listening");
    expect(listening.port).toBe(config().httpPort);

    const started = await waitFor((message) => ruleOf(message) === "health.started");
    expect(firstLine(started.text)).toBe(`${HEADER.info} · <b>Monitor started</b>`);
    expect(started).toMatchObject({chat_id: CHAT_ID, parse_mode: "HTML", disable_notification: true});
    expect(started.text).toContain(`Starting cursor: block ${head}`);
    expect(started.text).toContain(`Backfill (Timelock and CCIP only, muted): blocks ${head}–${head}`);
    // The pre-start operation is known; its timelock.scheduled alert was the one historical alert suppressed.
    expect(started.text).toContain("Pending Timelock operations known: 1");
    expect(started.text).toContain("Historical event alerts suppressed: 1");

    // First cycle saved: nothing but the startup message and the conditions the mocks always raise.
    await caughtUp(head);
    expect(mock().messages.map(ruleOf).sort()).toEqual(
      ["health.started", ...KNOWN_MOCK_CONDITIONS.map((condition) => condition.rule)].sort(),
    );
    for (const message of mock().messages.filter((m) => ruleOf(m) !== "health.started")) {
      expect(firstLine(message.text).startsWith(`${HEADER.warning} · ${CHAIN} · `)).toBe(true);
    }

    // /healthz answers 200 from the start (staleness counts from the boot), so wait for the catch-up itself.
    const health = await waitForHealthz(statusUrl("/healthz"), (body) => body.chains[CHAIN]?.lastCaughtUpAt !== null);
    expect(health.code).toBe(200);
    expect(health.body.status).toBe("ok");
    expect(health.body.chains[CHAIN]).toMatchObject({
      processedBlock: Number(head),
      confirmedHead: Number(head),
      lagBlocks: 0,
      stale: false,
      cycleFailures: 0,
    });
    expect(health.body.chains[CHAIN]?.headAdvancedAt).not.toBeNull();
    // The mocks' failing reads are tracked from the first cycle, still within staleAfterSec.
    expect(health.body.chains[CHAIN]).toMatchObject({readsStale: false, ccipGaps: []});
    expect(Object.keys(health.body.chains[CHAIN]?.failingReads ?? {}).sort()).toEqual(
      KNOWN_MOCK_CONDITIONS.map((condition) => condition.rule.replace(/\.read-failed$/, "")).sort(),
    );
    for (const read of Object.values(health.body.chains[CHAIN]?.failingReads ?? {})) {
      expect(read.lastOkAt).toBeNull();
      expect(read.forSec).toBeLessThan(900);
    }
    expect(health.body.deliveries.telegram).toMatchObject({failed: 0, failing: false});
    // Reconciliation is disabled in the e2e config: no reconciliation block (nor health.reconcile-stale).
    expect(health.body).not.toHaveProperty("reconcile");

    const response = await fetch(statusUrl("/metrics"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    const metrics = await response.text();
    expect(metrics).toMatch(/^sahara_monitor_up 1$/m);
    for (const name of CHAIN_METRICS) expect(metrics).toMatch(new RegExp(`^${name}\\{chain="${CHAIN}"\\} \\S+$`, "m"));
    expect(sample(metrics, "sahara_monitor_chain_processed_block", {chain: CHAIN})).toBe(Number(head));
    expect(sample(metrics, "sahara_monitor_chain_confirmed_head", {chain: CHAIN})).toBe(Number(head));
    expect(sample(metrics, "sahara_monitor_chain_lag_blocks", {chain: CHAIN})).toBe(0);
    expect(sample(metrics, "sahara_monitor_chain_stale", {chain: CHAIN})).toBe(0);
    expect(sample(metrics, "sahara_monitor_chain_state_reads_stale", {chain: CHAIN})).toBe(0);
    expect(sample(metrics, "sahara_monitor_chain_cycle_failures_total", {chain: CHAIN})).toBe(0);
    expect(sample(metrics, "sahara_monitor_chain_last_caught_up_timestamp_seconds", {chain: CHAIN})).toBeGreaterThan(
      Date.now() / 1000 - 60,
    );
    expect(sample(metrics, "sahara_monitor_open_conditions", {severity: "critical"})).toBe(0);
    expect(sample(metrics, "sahara_monitor_open_conditions", {severity: "high"})).toBe(0);
    expect(sample(metrics, "sahara_monitor_open_conditions", {severity: "warning"})).toBe(KNOWN_MOCK_CONDITIONS.length);
    expect(sample(metrics, "sahara_monitor_open_conditions", {severity: "info"})).toBe(0);
    const route = {sink: "telegram", target: CHAT_ID};
    expect(sample(metrics, "sahara_monitor_alert_deliveries_total", {...route, result: "ok"})).toBe(
      1 + KNOWN_MOCK_CONDITIONS.length,
    );
    expect(sample(metrics, "sahara_monitor_alert_deliveries_total", {...route, result: "failed"})).toBe(0);
    expect(sample(metrics, "sahara_monitor_alert_delivery_retries_total", route)).toBe(0);
    expect(sample(metrics, "sahara_monitor_alert_sink_failing", route)).toBe(0);
    expect(sample(metrics, "sahara_monitor_alert_outbox_messages", route)).toBe(0);
    expect(sample(metrics, "sahara_monitor_alert_outbox_oldest_age_seconds", route)).toBe(0);
    expect(health.body.deliveries.telegram?.targets[CHAT_ID]).toMatchObject({failing: false, outboxMessages: 0});
    // Reconciliation is disabled in the e2e config: the metrics are declared, without a sample.
    for (const name of RECONCILE_METRICS) {
      expect(metrics).toContain(`# TYPE ${name} gauge`);
      expect(metrics).not.toMatch(new RegExp(`^${name}[ {]`, "m"));
    }
    expect(metrics).toContain("# TYPE sahara_monitor_reconcile_failures_total counter");
    expect(metrics).not.toMatch(/^sahara_monitor_reconcile_failures_total /m);
  });

  it("check: exit 0 on the healthy deployment, with reconciliation disabled and only the mock conditions", async () => {
    const result = await cli(["check"]);
    expect(result.code).toBe(0);
    const {addresses} = d;
    expect(result.stdout).toMatch(new RegExp(`^== ${CHAIN} at confirmed block \\d+ ==$`, "m"));
    expect(result.stdout).toContain(`  Manager: ${addresses.manager} (Manager)`);
    expect(result.stdout).toContain(`  GuardianController: ${addresses.controller} (GuardianController)`);
    expect(result.stdout).toContain("== Reconciliation: disabled ==");
    expect(result.stdout).toContain(`== Violated conditions: ${KNOWN_MOCK_CONDITIONS.length} ==`);
    for (const condition of KNOWN_MOCK_CONDITIONS) {
      expect(result.stdout).toContain(`(rule ${condition.rule}, key ${condition.key})`);
    }
    expect(result.stdout).toContain("Result: no critical/high condition – exit 0");

    const missing = await cli(["check"], {path: join(config().dir, "missing.yaml")});
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("cannot load the configuration");
  });

  it("alerts fund and recall by the operators as info, without a flows alert for their transfers", async () => {
    fundReceipt = await d.fund(tokens(1_000_000));
    recallReceipt = await d.recall(tokens(400_000));
    const funded = await waitFor(event("manager.funded", fundReceipt));
    const recalled = await waitFor(event("manager.recalled", recallReceipt));
    expect(firstLine(funded.text)).toBe(`${HEADER.info} · ${CHAIN} · <b>Funded Pool: 1,000,000 SAHARA</b>`);
    expect(firstLine(recalled.text)).toBe(`${HEADER.info} · ${CHAIN} · <b>Recalled from Pool: 400,000 SAHARA</b>`);
    for (const message of [funded, recalled]) {
      expect(message).toMatchObject({parse_mode: "HTML", disable_notification: true});
    }
    expect(funded.text).toContain(`Operator: <code>Funding operator ${d.accounts.fundingOperator.address}</code>`);
    expect(recalled.text).toContain(`Operator: <code>Recall operator ${d.accounts.recallOperator.address}</code>`);

    // Everything up to the recall block was delivered: one message per transaction, no flows.* (transfer, approval).
    await caughtUp(recallReceipt.blockNumber);
    expect(messagesAbout(fundReceipt.transactionHash).map(ruleOf)).toEqual(["manager.funded"]);
    expect(messagesAbout(recallReceipt.transactionHash).map(ruleOf)).toEqual(["manager.recalled"]);
    alerted.push(fundReceipt.transactionHash, recallReceipt.transactionHash);
  });

  it("alerts a direct SAHARA transfer into the pool as flows.pool-inflow (high)", async () => {
    const transfer = await d.directTransferToPool(tokens(1_000));
    const message = await waitFor(event("flows.pool-inflow", transfer));
    expect(firstLine(message.text)).toBe(`${HEADER.high} · ${CHAIN} · <b>Direct transfer to Pool: 1,000 SAHARA</b>`);
    expect(message).toMatchObject({parse_mode: "HTML", disable_notification: false});
    expect(message.text).toContain(`From: <code>${d.accounts.attacker.address}</code>`);
    expect(message.text).toContain("bypasses provideLiquidity");
    alerted.push(transfer.transactionHash);
  });

  it("folds a Guardian action into exactly one manager.guardian-action alert", async () => {
    const action = await d.guardianPauseFunding();
    const message = await waitFor(event("manager.guardian-action", action));
    expect(firstLine(message.text)).toBe(`${HEADER.high} · ${CHAIN} · <b>Guardian paused funding</b>`);
    expect(message.text).toContain("Function: <code>LiquidityManager.pauseFunding</code>");
    expect(message.text).toContain("Effect: Funding paused");
    expect(message.disable_notification).toBe(false);
    // The state rules see the pause at the same head.
    const paused = await waitFor((m) => ruleOf(m) === "state-manager.funding-paused");
    expect(firstLine(paused.text)).toBe(`${HEADER.warning} · ${CHAIN} · <b>Manager funding is paused</b>`);

    // No separate manager.config alert for the FundingPausedSet the Guardian call emitted.
    await caughtUp(action.blockNumber);
    expect(messagesAbout(action.transactionHash).map(ruleOf)).toEqual(["manager.guardian-action"]);
    alerted.push(action.transactionHash);
  });

  it("alerts Timelock schedules (with Guardian cancel calldata), executions and a protected setGuardian", async () => {
    const {addresses, accounts} = d;
    // Restore funding through the Timelock.
    const data = encodeManager("setFundingPaused", [false]);
    const op = await d.scheduleTimelockCall(addresses.manager, data);
    const scheduled = await waitFor((m) => ruleOf(m) === "timelock.scheduled" && m.text.includes(op.id));
    expect(firstLine(scheduled.text)).toBe(
      `${HEADER.high} · ${CHAIN} · <b>Timelock operation scheduled: LiquidityManager.setFundingPaused</b>`,
    );
    expect(scheduled.disable_notification).toBe(false);
    // The exact Guardian Safe transaction: GuardianController.cancel(target, value, data, predecessor, salt) ...
    const cancel = encodeFunctionData({
      abi: guardianControllerAbi,
      functionName: "cancel",
      args: [addresses.manager, 0n, data, zeroHash, op.salt],
    });
    expect(scheduled.text).toContain(`Cancel tx: to: <code>GuardianController ${addresses.controller}</code>`);
    expect(scheduled.text).toContain(`Cancel tx: calldata: <code>${cancel}</code>`);
    // ... which works: simulated from the Guardian (eth_call, nothing is sent) it does not revert.
    await d.anvil.client.call({account: accounts.guardian.address, to: addresses.controller, data: cancel});

    // Past the delay (the pre-start operation is ready too), governance executes both.
    const executedOp = await d.executeTimelockCall(op);
    const executed = await waitFor((m) => ruleOf(m) === "timelock.executed" && m.text.includes(op.id));
    expect(firstLine(executed.text)).toBe(
      `${HEADER.high} · ${CHAIN} · <b>Timelock operation executed: LiquidityManager.setFundingPaused</b>`,
    );
    const unpaused = await waitFor(
      (m) => firstLine(m.text) === `${HEADER.resolved} · ${CHAIN} · <b>Manager funding is paused</b>`,
    );
    expect(ruleOf(unpaused)).toBe("state-manager.funding-paused");

    const executedPreStart = await d.executeTimelockCall(preStart);
    const known = await waitFor((m) => ruleOf(m) === "timelock.executed" && m.text.includes(preStart.id));
    expect(firstLine(known.text)).toBe(
      `${HEADER.high} · ${CHAIN} · <b>Timelock operation executed: LiquidityManager.setMaxFundingPerCall</b>`,
    );
    // The muted backfill recorded its scheduling (no "not seen" note) without ever sending the scheduled alert.
    expect(known.text).not.toContain("Scheduling not seen by the monitor");
    expect(mock().messages.some((m) => ruleOf(m) === "timelock.scheduled" && m.text.includes(preStart.id))).toBe(false);

    // Protected Guardian recovery: critical, and the Guardian cannot cancel it.
    recovery = await d.scheduleSetGuardian(accounts.replacementGuardian.address);
    const critical = await waitFor((m) => ruleOf(m) === "timelock.scheduled" && m.text.includes(recovery.id));
    expect(firstLine(critical.text)).toBe(
      `${HEADER.critical} · ${CHAIN} · <b>Guardian recovery scheduled on Timelock (protected setGuardian)</b>`,
    );
    expect(critical).toMatchObject({parse_mode: "HTML", disable_notification: false});
    expect(critical.text).toContain(
      "Guardian cannot cancel (protected setGuardian); only the Governance Safe can cancel via Timelock.cancel(id)",
    );
    expect(critical.text).not.toContain("Cancel tx: calldata");

    alerted.push(
      op.receipt.transactionHash,
      executedOp.transactionHash,
      executedPreStart.transactionHash,
      recovery.receipt.transactionHash,
    );
  });

  it("alerts a pool outflow without a bridge release as critical, delivered through a 429", async () => {
    const before = mock().requests.length;
    mock().failNext(1, {kind: "rate-limit", retryAfterSec: 1});
    const outflow = await d.transferOutOfPool(tokens(2_000));
    const message = await waitFor(event("flows.pool-outflow", outflow));
    expect(firstLine(message.text)).toBe(
      `${HEADER.critical} · ${CHAIN} · <b>Unexplained outflow from Pool: 2,000 SAHARA</b>`,
    );
    expect(message).toMatchObject({parse_mode: "HTML", disable_notification: false});
    expect(message.text).toContain("GuardianController.lockdown(pool)");
    // The 429 went to some message (this one, unless another was queued first); none was lost.
    expect(mock().requests.slice(before).filter((request) => request.status === 429)).toHaveLength(1);
    await caughtUp(outflow.blockNumber);
    const metrics = await (await fetch(statusUrl("/metrics"))).text();
    const route = {sink: "telegram", target: CHAT_ID};
    expect(sample(metrics, "sahara_monitor_alert_deliveries_total", {...route, result: "failed"})).toBe(0);
    alerted.push(outflow.transactionHash);
  });

  it("stops on SIGTERM and resumes from the stored cursor without repeating an alert", async () => {
    const {stateFile} = config();
    const first = monitor;
    if (!first) throw new Error("no daemon running");
    const stopped = await first.stop("SIGTERM");
    expect(stopped).toMatchObject({code: 0, signal: null});
    expect(stopped.elapsedMs).toBeLessThan(5_000);
    const messages = first.logs().map((line) => line.msg);
    expect(messages).toContain("stopping");
    expect(messages).toContain("monitor stopped");
    const cursor = savedCursor(stateFile, CHAIN);
    expect(cursor).toBe(await node().blockNumber());
    // The mocks' read failures are saved with when they began, every other state rule with its last success.
    const reads = savedReads(stateFile, CHAIN) ?? {};
    const failing = Object.entries(reads).filter(([, entry]) => entry.failingSince !== undefined);
    expect(failing.map(([rule]) => rule).sort()).toEqual(["state-pool", "state-router"]);
    expect(Object.values(reads).filter((entry) => entry.okAt !== undefined).length).toBeGreaterThan(0);

    const lastId = mock().messages.at(-1)?.message_id ?? 0;
    const earlier = new Set(mock().messages.map((message) => message.text));
    // While the monitor is down: the restart must pick this up from the stored cursor.
    const missed = await d.directTransferToPool(tokens(3_000));

    monitor = spawnDaemon();
    const restarted = await waitFor((m) => m.message_id > lastId && ruleOf(m) === "health.started");
    expect(restarted.text).toContain(`Starting cursor: block ${cursor}`);
    expect(restarted.text).toContain(
      `Resumed from the stored cursor (backfill blocks ${preStart.receipt.blockNumber}–` +
        `${preStart.receipt.blockNumber} completed earlier)`,
    );
    expect(restarted.text).not.toContain("Backfill (");
    expect(restarted.text).not.toContain("no backfill");
    expect(restarted.text).toContain("Pending Timelock operations known: 1");
    expect(restarted.text).toContain("Historical event alerts suppressed: 0");
    await waitFor(event("flows.pool-inflow", missed));

    // And it still alerts new events.
    const recall = await d.recall(tokens(100_000));
    await waitFor(event("manager.recalled", recall));
    await caughtUp(recall.blockNumber);
    const after = mock().messages.filter((message) => message.message_id > lastId);
    expect(after.map(ruleOf)).toEqual(["health.started", "flows.pool-inflow", "manager.recalled"]);
    for (const message of after) {
      expect(earlier.has(message.text)).toBe(false);
      for (const hash of alerted) expect(mentions(message, hash)).toBe(false);
    }

    const second = await monitor.stop("SIGTERM");
    expect(second).toMatchObject({code: 0, signal: null});
    expect(second.elapsedMs).toBeLessThan(5_000);
    expect(savedCursor(stateFile, CHAIN)).toBe(recall.blockNumber);
    // The failures kept counting from before the restart (no read-failed message above: neither resolved nor re-sent).
    const carried = savedReads(stateFile, CHAIN) ?? {};
    for (const [rule, entry] of failing) expect(carried[rule]?.failingSince).toBe(entry.failingSince);
  });

  it("keeps alerts through a Telegram outage and a restart during it, and delivers each once it recovers", async () => {
    const {stateFile} = config();
    const route = {sink: "telegram", target: CHAT_ID};
    const lastId = mock().messages.at(-1)?.message_id ?? 0;
    monitor = spawnDaemon();
    const first = monitor;
    await waitFor((m) => m.message_id > lastId && ruleOf(m) === "health.started");
    await caughtUp(await node().blockNumber());

    // Telegram answers 502 to everything: the alert is kept, the route is failing, /healthz is 503.
    mock().outage({kind: "bad-gateway"});
    const transfer = await d.directTransferToPool(tokens(500));
    const failing = await waitForHealthz(
      statusUrl("/healthz"),
      (body) => body.deliveries.telegram?.targets[CHAT_ID]?.failing === true,
    );
    expect(failing.code).toBe(503);
    expect(failing.body.status).toBe("delivery-failing");
    expect(failing.body.deliveries.telegram?.targets[CHAT_ID]).toMatchObject({
      failingKind: "transient",
      lastError: expect.stringContaining("502 Bad Gateway"),
      outboxMessages: 1,
    });
    // The loops do not wait for Telegram: the transfer's block is scanned and saved meanwhile.
    await scanned(transfer.blockNumber);
    let metrics = await (await fetch(statusUrl("/metrics"))).text();
    expect(sample(metrics, "sahara_monitor_alert_sink_failing", route)).toBe(1);
    expect(sample(metrics, "sahara_monitor_alert_outbox_messages", route)).toBe(1);
    expect(sample(metrics, "sahara_monitor_alert_delivery_retries_total", route)).toBeGreaterThanOrEqual(1);
    expect(sample(metrics, "sahara_monitor_alert_deliveries_total", {...route, result: "failed"})).toBe(0);

    // A deploy during the outage: the stop does not wait for Telegram, and the alert and the failure are saved.
    const stopped = await first.stop("SIGTERM");
    expect(stopped).toMatchObject({code: 0, signal: null});
    expect(stopped.elapsedMs).toBeLessThan(15_000);
    const saved = savedAlerts(stateFile);
    expect(saved.outbox.map((entry) => entry.targets)).toEqual([[`telegram:${CHAT_ID}`]]);
    expect(saved.outbox.some((entry) => mentionsText(entry.message.alert, transfer.transactionHash))).toBe(true);
    expect(saved.targets[`telegram:${CHAT_ID}`]?.failing).toMatchObject({kind: "transient"});
    expect(messagesAbout(transfer.transactionHash)).toEqual([]);

    // Now connections are refused; one more alert while the monitor is down.
    await mock().offline();
    const recall = await d.recall(tokens(50_000));
    monitor = spawnDaemon();
    await monitor.waitForLog((line) => line.msg === "status server listening");
    // Failing from the start (kept in the state file), before any new attempt.
    const restarted = await fetch(statusUrl("/healthz"));
    expect(restarted.status).toBe(503);
    expect(((await restarted.json()) as Healthz).status).toBe("delivery-failing");
    await monitor.waitForLog((line) => line.msg.startsWith("alert delivery failing"));
    await scanned(recall.blockNumber);
    expect((await fetch(statusUrl("/healthz"))).status).toBe(503);

    // Telegram is back: the next retry delivers everything, each message once, in order.
    mock().outage(undefined);
    await mock().online();
    const inflow = await waitFor(event("flows.pool-inflow", transfer));
    const recalled = await waitFor(event("manager.recalled", recall));
    const startedAgain = mock().messages.filter((m) => m.message_id > lastId && ruleOf(m) === "health.started");
    expect(startedAgain).toHaveLength(2);
    expect(inflow.message_id).toBeLessThan(startedAgain[1]!.message_id);
    expect(startedAgain[1]!.message_id).toBeLessThan(recalled.message_id);
    expect(messagesAbout(transfer.transactionHash)).toHaveLength(1);
    expect(messagesAbout(recall.transactionHash)).toHaveLength(1);
    const healthy = await waitForHealthz(statusUrl("/healthz"), (body) => body.status === "ok");
    expect(healthy.code).toBe(200);
    expect(healthy.body.deliveries.telegram?.targets[CHAT_ID]).toMatchObject({failing: false, outboxMessages: 0});
    metrics = await (await fetch(statusUrl("/metrics"))).text();
    expect(sample(metrics, "sahara_monitor_alert_sink_failing", route)).toBe(0);
    expect(sample(metrics, "sahara_monitor_alert_outbox_messages", route)).toBe(0);
    await monitor.waitForLog((line) => line.msg === "alert delivery recovered" && line.target === CHAT_ID);
    alerted.push(transfer.transactionHash, recall.transactionHash);

    const second = await monitor.stop("SIGTERM");
    expect(second).toMatchObject({code: 0, signal: null});
    expect(savedAlerts(stateFile)).toMatchObject({outbox: [], targets: {[`telegram:${CHAT_ID}`]: {}}});
    expect(savedAlerts(stateFile).targets[`telegram:${CHAT_ID}`]?.failing).toBeUndefined();
  });

  it("test-alert: delivers an info test message, also through a 429, and fails without telegram", async () => {
    const lastId = mock().messages.at(-1)?.message_id ?? 0;
    const sentTest = () =>
      mock().messages.filter(
        (m) => m.message_id > lastId && m.text.includes("Test alert from the SAHARA liquidity monitor"),
      );

    const plain = await cli(["test-alert"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(`chat ${CHAT_ID}: ok`);
    expect(plain.stdout).toContain("It is info severity, so it arrives silently (disable_notification");
    expect(sentTest()).toHaveLength(1);
    expect(sentTest()[0]).toMatchObject({chat_id: CHAT_ID, parse_mode: "HTML", disable_notification: true});

    const before = mock().requests.length;
    mock().failNext(1, {kind: "rate-limit", retryAfterSec: 1});
    const limited = await cli(["test-alert"]);
    expect(limited.code).toBe(0);
    expect(limited.stdout).toContain(`chat ${CHAT_ID}: ok`);
    expect(mock().requests.slice(before).map((request) => request.status)).toEqual([429, 200]);
    expect(sentTest()).toHaveLength(2);

    const bare = await writeE2EConfig({deployment: d, httpPort: false});
    try {
      const result = await cli(["test-alert"], {path: bare.path, env: bare.env});
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("No telegram section is configured");
    } finally {
      rmSync(bare.dir, {recursive: true, force: true});
    }
  });

  it("check: reads the state file without writing it and exits 1 on a high condition", async () => {
    const {stateFile} = config();
    const state = readFileSync(stateFile, "utf8");
    // 12 h before the protected recovery's ETA: the queue rule, which knows the operation only from the state file,
    // raises "executable within 24h" at high (one below the operation's critical).
    const readyAt = await d.anvil.client.readContract({
      address: d.addresses.timelock,
      abi: saharaTimelockAbi,
      functionName: "getTimestamp",
      args: [recovery.id],
    });
    await node().warpTo(readyAt - 12n * 3600n);

    const result = await cli(["check"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("== Reconciliation: disabled ==");
    expect(result.stdout).toContain(
      `[HIGH] ${CHAIN} · Timelock operation executable within 24h: LiquidityManager.setGuardian`,
    );
    expect(result.stdout).toContain(`(rule timelock-queue.soon, key ${CHAIN}:timelock-queue:${recovery.id}:soon)`);
    expect(result.stdout).toMatch(/^Result: \d+ critical\/high conditions? – exit 1$/m);
    expect(readFileSync(stateFile, "utf8")).toBe(state);
  });

  it("scan: replays a block range to stdout without sending or saving anything", async () => {
    const {stateFile} = config();
    const state = readFileSync(stateFile, "utf8");
    const requests = mock().requests.length;
    const from = fundReceipt.blockNumber;
    const to = recallReceipt.blockNumber;
    const result = await cli(["scan", "--chain", CHAIN, "--from", String(from), "--to", String(to)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Scanning ${CHAIN} blocks ${from}-${to} (addresses resolved at block ${to})`);
    expect(result.stdout).toContain(`[INFO] ${CHAIN} · Funded Pool: 1,000,000 SAHARA`);
    expect(result.stdout).toContain(`[INFO] ${CHAIN} · Recalled from Pool: 400,000 SAHARA`);
    expect(result.stdout).not.toContain("(rule flows.");
    expect(mock().requests.length).toBe(requests);
    expect(readFileSync(stateFile, "utf8")).toBe(state);
  });

  it("never writes the bot token or the RPC URL to any output or message", () => {
    expect(transcripts.length).toBeGreaterThan(daemons.length);
    for (const transcript of transcripts) {
      for (const text of [transcript.stdout(), transcript.stderr()]) {
        expect(text, transcript.name).not.toContain(FAKE_BOT_TOKEN);
        expect(text, transcript.name).not.toContain(node().rpcUrl);
      }
    }
    for (const message of mock().messages) {
      expect(message.text).not.toContain(FAKE_BOT_TOKEN);
      expect(message.text).not.toContain(node().rpcUrl);
    }
    expect(existsSync(config().stateFile)).toBe(true);
  });
});

/** The alert manager's namespace in the saved state file. */
function savedAlerts(stateFile: string): {
  outbox: Array<{message: {alert: Record<string, unknown>}; targets: string[]}>;
  targets: Record<string, {failing?: Record<string, unknown>}>;
} {
  const state = deserializeState(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  return state.alerts as ReturnType<typeof savedAlerts>;
}

/** Whether an alert (as saved) mentions the transaction anywhere (its links carry the hash). */
function mentionsText(alert: Record<string, unknown>, hash: Hex): boolean {
  return JSON.stringify(alert).toLowerCase().includes(hash.toLowerCase());
}

/** The rule id from a message's footer line (`<i>rule manager.funded</i>`). */
function ruleOf(message: TelegramMessage): string | undefined {
  return /<i>rule ([^<]+)<\/i>/.exec(message.text)?.[1];
}

/** Whether a message links the transaction (explorer tx links carry the hash). */
function mentions(message: TelegramMessage, hash: Hex): boolean {
  return message.text.toLowerCase().includes(hash.toLowerCase());
}

/** The event alert of `rule` for a transaction. */
function event(rule: string, receipt: TransactionReceipt): (message: TelegramMessage) => boolean {
  return (message) => ruleOf(message) === rule && mentions(message, receipt.transactionHash);
}

/** The value of one Prometheus sample, e.g. `name{chain="local"} 12`; NaN when absent. */
function sample(metrics: string, name: string, labels: Record<string, string>): number {
  const selector = Object.entries(labels)
    .map(([label, value]) => `${label}="${value}"`)
    .join(",");
  const line = metrics.split("\n").find((text) => text.startsWith(`${name}{${selector}} `));
  return line === undefined ? Number.NaN : Number(line.slice(line.lastIndexOf(" ") + 1));
}

/** Polls /healthz until `ready(body)`; returns the last answer. */
async function waitForHealthz(
  url: string,
  ready: (body: Healthz) => boolean,
  timeoutMs = 30_000,
): Promise<{code: number; body: Healthz}> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(url);
    const body = (await response.json()) as Healthz;
    if (ready(body)) return {code: response.status, body};
    if (Date.now() > deadline) throw new Error(`/healthz not ready within ${timeoutMs} ms: ${JSON.stringify(body)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
