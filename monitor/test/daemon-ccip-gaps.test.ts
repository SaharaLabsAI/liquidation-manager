// The daemon replays the CCIP blocks the ccip rule skipped (`ccipGaps`, e.g. while ccip.enabled was false): after the
// forward scan caught up and the state rules ran, at most MAX_GAP_CHUNKS_PER_CYCLE chunks per cycle, muted like the
// first-start backfill, with the progress kept in the rule's own state and shown in /healthz and the startup message.
import type {Hex} from "viem";
import {describe, expect, it, vi} from "vitest";

import {
  ccipGaps,
  emptyScanState,
  executionStatus,
  FAILURE,
  readExec,
  readScan,
  writeScan,
} from "../src/ccip/store.ts";
import {ccipEventsRule} from "../src/ccip/tracker.ts";
import {fetchLogs} from "../src/chain/scanner.ts";
import {configSchema} from "../src/config.ts";
import {daemonNamespace, GAP_REPLAY_BUDGET_MS, MAX_GAP_CHUNKS_PER_CYCLE, MutedAlerter} from "../src/daemon.ts";
import {healthz, renderMetrics} from "../src/health.ts";
import type {Store} from "../src/store.ts";
import {createStore} from "../src/store.ts";
import type {Alert, BlockRange} from "../src/types.ts";
import {
  BSC,
  ccipAddresses,
  ETH,
  execLogV2,
  fakeClient,
  insufficientBalanceError,
  OFFRAMP_V2,
  POOL,
  REGISTRY,
  ROUTER,
  SAHARA,
  txHash,
} from "./helpers/ccip-fakes.ts";
import {daemonConfig, fillingCcipRule, spyEventRule, spyStateRule, T0, testDaemon} from "./helpers/daemon-fakes.ts";

const HEARTBEAT = "https://hc-ping.example.com/abcdefgh";
const GAP_KEY = "ethereum:health:ccip-gap-replay";

/** Daemon cursor `cursor` and a ccip scan over 1–`cursor` with `gaps`. */
function seeded(gaps: BlockRange[], cursor = 100n): Store {
  const store = createStore();
  store.set(daemonNamespace("ethereum"), {cursor});
  writeScan(store, "ethereum", {
    ...emptyScanState(),
    cursor: {from: 1n, to: cursor},
    gaps: gaps.map((gap) => ({...gap, detectedAt: 0})),
  });
  return store;
}

function eventAlert(range: BlockRange): Alert {
  return {
    key: `ethereum:ccip:${range.from}`,
    kind: "event",
    severity: "critical",
    rule: "ccip.message-failed",
    title: `failure in ${range.from}-${range.to}`,
  };
}

describe("CCIP gap replay", () => {
  it("runs after the forward scan and the state rules: only the ccip rule, muted, 5 chunks a cycle", async () => {
    const order: string[] = [];
    const flows = spyEventRule("flows", {order});
    const ccip = spyEventRule("ccip", {order, onLogs: (ctx, _logs, range) => ctx.alerter.emit(eventAlert(range))});
    const t = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store: seeded([
        {from: 11n, to: 50n},
        {from: 61n, to: 75n},
      ]),
      order,
      heads: {ethereum: 110n},
      eventRules: [flows, ccip],
      stateRules: [spyStateRule("state-spy", () => [], order)],
    });
    expect(MAX_GAP_CHUNKS_PER_CYCLE).toBe(5);
    expect(await t.daemon.cycle("ethereum")).toBe(true);
    expect(order.filter((entry) => entry.startsWith("rule:") || entry.startsWith("state:"))).toEqual([
      "rule:flows:101-110",
      "rule:ccip:101-110",
      "state:state-spy:110",
      "rule:ccip:11-20",
      "rule:ccip:21-30",
      "rule:ccip:31-40",
      "rule:ccip:41-50",
      "rule:ccip:61-70",
    ]);
    expect(ccip.calls[0]!.alerter).toBe(t.daemon.alerter);
    for (const call of ccip.calls.slice(1)) expect(call.alerter).toBeInstanceOf(MutedAlerter);
    // Only the live chunk's alert was sent.
    expect(t.sink.summary.filter((line) => line.includes(":ccip:"))).toEqual(["firing:critical:ethereum:ccip:101"]);
  });

  it("waits until the forward scan caught up, and never runs while CCIP tracking is disabled", async () => {
    const order: string[] = [];
    const ccip = spyEventRule("ccip", {order});
    const t = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store: seeded([{from: 11n, to: 20n}]),
      order,
      heads: {ethereum: 400n},
      eventRules: [ccip],
    });
    await t.daemon.cycle("ethereum");
    expect(ccip.calls.map((call) => `${call.range.from}-${call.range.to}`)).toHaveLength(20);
    expect(ccip.calls.at(-1)!.range).toEqual({from: 291n, to: 300n});
    await t.daemon.cycle("ethereum");
    expect(ccip.calls.at(-1)!.range).toEqual({from: 11n, to: 20n});

    const disabled = spyEventRule("ccip");
    const off = testDaemon({
      config: daemonConfig({chains: {ethereum: {ccip: {enabled: false}}}}),
      store: seeded([{from: 11n, to: 20n}]),
      heads: {ethereum: 110n},
      eventRules: [disabled],
    });
    await off.daemon.cycle("ethereum");
    expect(disabled.calls.map((call) => call.range)).toEqual([{from: 101n, to: 110n}]);
    expect(healthz(off.daemon.status()).body.chains).toMatchObject({ethereum: {ccipGaps: []}});
  });

  it("logs a failed replay, shows it in /healthz and retries next cycle without failing the cycle", async () => {
    const ccip = spyEventRule("ccip");
    const t = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store: seeded([{from: 11n, to: 20n}]),
      heads: {ethereum: 100n},
      eventRules: [ccip],
      failChunks: [11n],
    });
    expect(await t.daemon.cycle("ethereum")).toBe(true);
    const chain = healthz(t.daemon.status()).body.chains as Record<string, Record<string, unknown>>;
    expect(chain.ethereum!.ccipGapError).toContain("eth_getLogs failed");
    expect(chain.ethereum!.ccipGapError).not.toContain("secret-api-key");
    expect(t.daemon.status().chains[0]!.consecutiveFailures).toBe(0);

    // The next cycle, a poll interval later (a gap that keeps failing waits longer, see below).
    t.clock.now += 10_000;
    t.chains.ethereum!.head = 101n;
    expect(await t.daemon.cycle("ethereum")).toBe(true);
    expect(ccip.calls.at(-1)!.range).toEqual({from: 11n, to: 20n});
    expect(healthz(t.daemon.status()).body.chains).not.toHaveProperty("ethereum.ccipGapError");
  });

  it("replays the other gaps when one cannot be fetched, and retries that one with backoff", async () => {
    // Codex repro: an old gap the provider no longer serves blocked every later gap (the first throw ended the replay).
    const ccip = fillingCcipRule();
    const t = testDaemon({
      config: daemonConfig({chains: {ethereum: {}}}),
      store: seeded([
        {from: 11n, to: 20n},
        {from: 51n, to: 60n},
      ]),
      eventRules: [ccip],
      failChunks: [11n],
      failAlways: true,
    });
    expect(await t.daemon.cycle("ethereum")).toBe(true);
    expect(ccipGaps(t.store, "ethereum")).toEqual([{from: 11n, to: 20n}]);
    expect(ccip.calls.map((call) => call.range)).toEqual([{from: 51n, to: 60n}]);

    // Retried at the next cycle (10 s), then after 20 s, 40 s, ...: the poll interval doubled per failure.
    const attempts: number[] = [];
    for (let s = 10; s <= 150; s += 10) {
      t.clock.now = T0 + s * 1000;
      expect(await t.daemon.cycle("ethereum")).toBe(true);
      if (t.fetches.at(-1)?.range.from === 11n) attempts.push(s);
      t.fetches.length = 0;
    }
    expect(attempts).toEqual([10, 30, 70, 150]);
    expect(healthz(t.daemon.status()).body.chains).toMatchObject({
      ethereum: {ccipGaps: [{from: 11, to: 20}], ccipGapError: expect.stringContaining("eth_getLogs failed")},
    });
  });

  it("escalates a replay that keeps failing like stale telemetry, also across a restart", async () => {
    // Codex repro: eth_getLogs rejected for old blocks left only a reconcile.incomplete warning, /healthz 200 and the
    // heartbeat running, although the in-flight amount I could not be bounded.
    let broken = true;
    const replay = async (_client: unknown, _filters: unknown, range: BlockRange) => {
      if (broken && range.to <= 100n) throw new Error("history not available: block range too old");
      return [];
    };
    const fetch = vi.fn(async () => new Response("ok"));
    const store = seeded([{from: 11n, to: 20n}]);
    const config = daemonConfig({chains: {ethereum: {}}, alerts: {heartbeatUrl: HEARTBEAT}});
    const options = {config, store, eventRules: [fillingCcipRule()], fetchLogs: replay as typeof fetchLogs, fetch};
    const t = testDaemon(options);
    const about = () => t.sink.summary.filter((line) => line.endsWith(GAP_KEY));
    const next = async (ms: number) => {
      t.clock.now += ms;
      t.chains.ethereum!.head = (t.chains.ethereum!.head as bigint) + 1n;
      expect(await t.daemon.cycle("ethereum")).toBe(true);
    };
    await t.daemon.cycle("ethereum");
    // staleAfterSec is 60: no condition and healthy up to 60 s.
    for (let i = 0; i < 6; i++) await next(10_000);
    expect(about()).toEqual([]);
    expect(healthz(t.daemon.status()).code).toBe(200);
    expect(await t.daemon.heartbeat()).toBe(true);

    await next(1_000);
    expect(about()).toEqual([`firing:high:${GAP_KEY}`]);
    const high = t.sink.messages.at(-1)!.alert;
    expect(high.rule).toBe("health.ccip-gap-replay");
    expect(high.fields).toContainEqual({label: "Blocks not scanned", value: "11–20 (10 blocks)"});
    expect(high.fields?.find((field) => field.label === "Last error")?.value).toContain("block range too old");
    expect(high.note).toContain("LiquidityManager.pauseRecall()");
    expect(healthz(t.daemon.status())).toMatchObject({
      code: 503,
      body: {status: "stale", chains: {ethereum: {stale: false, ccipGapReplayStale: true, ccipGapFailingForSec: 61}}},
    });
    const metrics = renderMetrics(t.daemon.status());
    expect(metrics).toContain('sahara_monitor_chain_ccip_gap_replay_stale{chain="ethereum"} 1');
    expect(await t.daemon.heartbeat()).toBe(false);
    await t.daemon.healthTick();
    expect(about()).toHaveLength(1);

    // Critical after 180 s, counted from the first failure, also by a new process on the same state file.
    await t.daemon.stop();
    const restarted = testDaemon({...options, clock: t.clock, heads: {ethereum: t.chains.ethereum!.head as bigint}});
    expect(healthz(restarted.daemon.status()).code).toBe(503);
    restarted.clock.now = T0 + 181_000;
    await restarted.daemon.healthTick();
    expect(restarted.sink.summary.filter((line) => line.endsWith(GAP_KEY))).toEqual([`firing:critical:${GAP_KEY}`]);
    const critical = restarted.sink.messages.at(-1)!.alert;
    expect(critical.fields).toContainEqual({
      label: "Last error",
      value: "history not available: block range too old",
      code: true,
    });

    // Fetchable again: the next attempt (backoff is at most 5 minutes) fills the gap and resolves it.
    broken = false;
    restarted.clock.now += 5 * 60_000;
    restarted.chains.ethereum!.head = (restarted.chains.ethereum!.head as bigint) + 1n;
    expect(await restarted.daemon.cycle("ethereum")).toBe(true);
    expect(ccipGaps(store, "ethereum")).toEqual([]);
    expect(restarted.sink.summary.filter((line) => line.endsWith(GAP_KEY))).toEqual([
      `firing:critical:${GAP_KEY}`,
      `resolved:critical:${GAP_KEY}`,
    ]);
    expect(healthz(restarted.daemon.status()).code).toBe(200);
    expect(await restarted.daemon.heartbeat()).toBe(true);
  });

  it("bounds a replay whose eth_getLogs times out, so it never starves the live scan", async () => {
    // Codex repro: every failing request split the range again, ~11 rounds of rpcTimeoutMs × attempts per cycle, every
    // cycle; stale-telemetry flapped while the live RPC was fine.
    const config = daemonConfig({chains: {ethereum: {staleAfterSec: 300, pollIntervalSec: 15, maxLogRange: 500}}});
    const store = seeded([{from: 501n, to: 1_000n}], 2_000n);
    const t = testDaemon({config, store, eventRules: [fillingCcipRule()], fetchLogs});
    t.chains.ethereum!.head = 2_000n;
    Object.assign(t.chains.ethereum!.client, {
      async request({params}: {params: [{fromBlock: Hex}]}) {
        if (BigInt(params[0].fromBlock) > 2_000n) return [];
        // Each historical request times out after 20 s while the chain moves on and the health timer runs.
        t.clock.now += 20_000;
        t.chains.ethereum!.head = (t.chains.ethereum!.head as bigint) + 2n;
        await t.daemon.healthTick();
        throw new Error("The request took too long to respond.");
      },
    });
    const cycleMs: number[] = [];
    while (t.clock.now < T0 + 30 * 60_000) {
      const start = t.clock.now;
      expect(await t.daemon.cycle("ethereum")).toBe(true);
      cycleMs.push(t.clock.now - start);
      t.clock.now += 15_000;
      t.chains.ethereum!.head = (t.chains.ethereum!.head as bigint) + 1n;
    }
    expect(Math.max(...cycleMs)).toBeLessThanOrEqual(GAP_REPLAY_BUDGET_MS + 2 * 20_000);
    expect(t.sink.summary.filter((line) => line.includes("stale-telemetry"))).toEqual([]);
    // Backed off: a few attempts in 30 minutes, not one per cycle.
    expect(cycleMs.length).toBeGreaterThan(90);
    expect(cycleMs.filter((ms) => ms > 0).length).toBeLessThanOrEqual(10);
    expect(readScan(t.store, "ethereum").gaps).toHaveLength(1);
    expect(healthz(t.daemon.status()).body.chains).toMatchObject({
      ethereum: {ccipGapError: expect.stringContaining("The request took too long to respond.")},
    });
    // Still failing, so escalated: the in-flight amount cannot be bounded.
    expect(t.sink.summary.filter((line) => line.endsWith(GAP_KEY)).at(-1)).toBe(`firing:critical:${GAP_KEY}`);
  });

  it("fills the blocks skipped while tracking was off with the real ccip rule, without paging history", async () => {
    // A SAHARA failure on Ethereum in blocks scanned while ccip.enabled was false (ccip cursor 100–399, daemon 600).
    const messageId = "0xe70919efc1c62d574d9067333f31573db8863e61f6c9e9cba1bca49046591db8";
    const failure = execLogV2(
      OFFRAMP_V2.ethereum,
      {
        sourceChainSelector: BSC,
        messageNumber: 5n,
        messageId,
        state: FAILURE,
        returnData: insufficientBalanceError(SAHARA, POOL, 0n, 1n),
      },
      {txHash: txHash("in-gap"), block: 450n, logIndex: 1},
    );
    const eth = fakeClient({chain: "ethereum", logs: [failure], head: 700n});
    const bsc = fakeClient({chain: "bsc", head: 1_000n});
    const chain = (chainId: number, selector: bigint, name: "ethereum" | "bsc") => ({
      chainId,
      chainSelector: selector.toString(),
      rpcUrls: [`http://localhost:${8545 + chainId}`],
      explorerUrl: "https://explorer.example.com",
      confirmations: 0,
      maxLogRange: 20,
      contracts: {token: SAHARA, registry: REGISTRY[name], router: ROUTER[name], pool: POOL},
    });
    const config = configSchema.parse({
      reconciliation: {enabled: false},
      chains: {ethereum: chain(1, ETH, "ethereum"), bsc: chain(56, BSC, "bsc")},
    });
    const store = createStore();
    store.set(daemonNamespace("ethereum"), {cursor: 600n});
    store.set(daemonNamespace("bsc"), {cursor: 1_000n});
    writeScan(store, "ethereum", {...emptyScanState(), cursor: {from: 100n, to: 399n}});
    const t = testDaemon({
      config,
      store,
      eventRules: [ccipEventsRule],
      fetchLogs,
      createClient: (name) => (name === "ethereum" ? eth : bsc).client,
      resolve: async (_client, entry) => ccipAddresses(entry === config.chains.ethereum ? "ethereum" : "bsc"),
    });

    await t.daemon.cycle("bsc");
    await t.daemon.cycle("ethereum");
    // Announced before the forward scan recorded the gap.
    const started = t.sink.messages.find((message) => message.alert.rule === "health.started")!.alert;
    expect(started.fields!.find((field) => field.label === "ethereum")!.value).toContain(
      "CCIP blocks not scanned yet (replayed muted in the background; reconciliation is incomplete until done): " +
        "400–600 (201 blocks)",
    );
    // 601–700 forward, then 5 chunks of 20 blocks of the gap: the failure is known, not paged.
    expect(ccipGaps(store, "ethereum")).toEqual([{from: 500n, to: 600n}]);
    expect(executionStatus(readExec(store, "ethereum")[messageId])).toBe("failed");
    expect(t.sink.messages.filter((message) => message.alert.rule.startsWith("ccip"))).toEqual([]);
    expect(healthz(t.daemon.status()).body.chains).toMatchObject({ethereum: {ccipGaps: [{from: 500, to: 600}]}});

    eth.options.head = 701n;
    await t.daemon.cycle("ethereum");
    expect(ccipGaps(store, "ethereum")).toEqual([{from: 600n, to: 600n}]);
    eth.options.head = 702n;
    await t.daemon.cycle("ethereum");
    expect(ccipGaps(store, "ethereum")).toEqual([]);
    expect(healthz(t.daemon.status()).body.chains).toMatchObject({ethereum: {ccipGaps: []}});
    expect(t.sink.messages.filter((message) => message.alert.rule.startsWith("ccip"))).toEqual([]);
  });
});
