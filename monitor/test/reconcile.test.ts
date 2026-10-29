import {parseUnits, type Address, type Hex} from "viem";
import {describe, expect, it} from "vitest";

import {
  emptyScanState,
  writeExec,
  writeScan,
  writeSent,
  type ExecRecord,
  type ScanState,
  type SentRecord,
} from "../src/ccip/store.ts";
import {configSchema, type Config} from "../src/config.ts";
import {formatTimestamp} from "../src/format.ts";
import {formatReconcileReport, reconcile, RECONCILE_SCOPE} from "../src/rules/reconcile.ts";
import {createStore, type Store} from "../src/store.ts";
import {
  BSC,
  ccAddr,
  ccipConfig,
  ccipContext,
  ETH,
  fakeClient,
  MANAGER,
  OFFRAMP_V2,
  ONRAMP_V2,
  POOL,
  recordingAlerter,
  T0,
  type ChainName,
  type FakeClientOptions,
} from "./helpers/ccip-fakes.ts";

const units = (whole: string | number) => parseUnits(String(whole), 18);
const TEN_B = units("10000000000");
const NOW = T0 + 100_000;

const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const tx = (n: number): Hex => `0x${(5000 + n).toString(16).padStart(64, "0")}`;

function sent(n: number, from: ChainName, amount: bigint, overrides: Partial<SentRecord> = {}): SentRecord {
  const to = from === "ethereum" ? "bsc" : "ethereum";
  return {
    messageId: id(n),
    sourceChain: from,
    destSelector: from === "ethereum" ? BSC : ETH,
    destChain: to,
    amount,
    receiver: ccAddr(0x700 + n),
    sender: ccAddr(0x800),
    pool: POOL,
    onRamp: ONRAMP_V2[from],
    kind: "OnRamp 2.0.0",
    sequenceNumber: BigInt(n),
    sentBlock: 500n,
    sentAt: NOW - 600,
    txHash: tx(n),
    logIndex: 0,
    ...overrides,
  };
}

function failed(n: number, on: ChainName, block: bigint, overrides: Partial<ExecRecord> = {}): ExecRecord {
  return {
    messageId: id(n),
    sourceChain: on === "ethereum" ? "bsc" : "ethereum",
    sourceSelector: on === "ethereum" ? BSC : ETH,
    sequenceNumber: BigInt(n),
    kind: "OffRamp 2.0.0",
    offRamp: OFFRAMP_V2[on],
    sahara: "sent",
    attempts: [
      {state: 3, block, txHash: tx(100 + n), logIndex: 1, at: NOW - 3000, reason: "TokenHandlingError(target=…)"},
    ],
    ...overrides,
  };
}

interface ChainSetup {
  balances?: Partial<Record<"manager" | "pool", bigint>>;
  totalSupply?: bigint | Error;
  balanceError?: Error;
  client?: Omit<FakeClientOptions, "chain" | "read">;
  /** ccip rule cursor; null = never scanned. */
  cursor?: {from: bigint; to: bigint} | null;
  sent?: SentRecord[];
  exec?: ExecRecord[];
  scan?: Partial<ScanState>;
}

function setup(chains: Partial<Record<ChainName, ChainSetup>>, opts: {config?: Config; store?: Store} = {}) {
  const store = opts.store ?? createStore();
  const config = opts.config ?? ccipConfig;
  const alerter = recordingAlerter();
  const fakes = {} as Record<ChainName, ReturnType<typeof fakeClient>>;
  const contexts = (["ethereum", "bsc"] as const).map((chain) => {
    const spec = chains[chain] ?? {};
    const balances = {manager: units("3000000000"), pool: units("2000000000"), ...spec.balances};
    const fake = fakeClient({
      chain,
      ...spec.client,
      read: (call) => {
        if (call.functionName === "totalSupply") return spec.totalSupply ?? TEN_B;
        if (call.functionName === "balanceOf") {
          if (spec.balanceError) return spec.balanceError;
          const [holder] = call.args as [Address];
          if (holder.toLowerCase() === MANAGER[chain].toLowerCase()) return balances.manager;
          if (holder.toLowerCase() === POOL.toLowerCase()) return balances.pool;
          return 0n;
        }
        return undefined;
      },
    });
    fakes[chain] = fake;
    if (spec.cursor !== null) {
      writeScan(store, chain, {...emptyScanState(), cursor: spec.cursor ?? {from: 1n, to: 5_000n}, ...spec.scan});
    }
    writeSent(store, chain, Object.fromEntries((spec.sent ?? []).map((record) => [record.messageId, record])));
    writeExec(store, chain, Object.fromEntries((spec.exec ?? []).map((record) => [record.messageId, record])));
    return ccipContext(chain, {client: fake.client, store, config});
  });
  const run = () => reconcile(contexts, alerter, config, {now: () => NOW * 1000});
  return {store, alerter, contexts, fakes, run};
}

/** Healthy split: R = 10B + 1,000 (ETH 5B; BSC 4B + 1B + 1,000). */
const healthyBsc: ChainSetup = {balances: {manager: units("4000000000"), pool: units("1000001000")}};

describe("reconcile", () => {
  it("passes when R − I covers the required backing, with in-flight messages at the snapshots", async () => {
    const {run, alerter, fakes} = setup({
      ethereum: {sent: [sent(1, "ethereum", units(500))]},
      bsc: healthyBsc,
    });
    const report = await run();

    expect(report.status).toBe("ok");
    expect(report.R).toBe(TEN_B + units(1000));
    expect(report.I).toBe(units(500));
    expect(report.margin).toBe(units(500));
    expect(report.inFlight).toMatchObject([{status: "pending", messageId: id(1)}]);
    expect(report.byLane).toEqual({"ethereum→bsc": units(500)});
    expect(report.chains.map((chain) => [chain.chain, chain.block, chain.blockSource, chain.total])).toEqual([
      ["ethereum", 1_000n, "finalized", units("5000000000")],
      ["bsc", 1_000n, "finalized", units("5000001000")],
    ]);
    expect(report.chains[0]!.balances).toEqual([
      {address: MANAGER.ethereum, label: "Manager", balance: units("3000000000")},
      {address: POOL, label: "Pool", balance: units("2000000000")},
    ]);
    // Every balance is read at the snapshot block.
    expect(
      fakes.ethereum.reads.filter((read) => read.functionName === "balanceOf").map((read) => read.blockNumber),
    ).toEqual([1_000n, 1_000n]);
    expect(alerter.syncs).toEqual([{scope: RECONCILE_SCOPE, active: []}]);
  });

  it("raises a critical backing breach when R − I falls below the required backing", async () => {
    const {run, alerter} = setup({
      ethereum: {sent: [sent(1, "ethereum", units(2000))]},
      bsc: healthyBsc,
    });
    const report = await run();
    expect(report.status).toBe("breach");
    expect(report.margin).toBe(-units(1000));
    const [breach] = alerter.syncs[0]!.active;
    expect(breach).toMatchObject({
      key: "global:reconcile:backing",
      kind: "condition",
      severity: "critical",
      title: "Backing breach: R − I is 1,000 SAHARA below the required 10,000,000,000 SAHARA",
    });
    expect(breach!.chain).toBeUndefined();
    expect(breach!.fields).toEqual(
      expect.arrayContaining([
        {label: "R (reserves)", value: "10,000,001,000 SAHARA", code: true},
        {label: "I (in flight)", value: "2,000 SAHARA", code: true},
        {label: "Margin (R − I − required)", value: "-1,000 SAHARA", code: true},
        {label: "ethereum reserves", value: "5,000,000,000 SAHARA at block 1000 (finalized)"},
        {label: "In flight ethereum→bsc", value: "2,000 SAHARA"},
      ]),
    );
  });

  it("does not count messages sent after the source snapshot or executed by the destination snapshot", async () => {
    const executed: ExecRecord = {
      ...failed(2, "bsc", 900n),
      attempts: [{state: 2, block: 900n, txHash: tx(9), logIndex: 0, at: NOW - 100}],
    };
    const {run} = setup({
      ethereum: {sent: [sent(1, "ethereum", units(5000), {sentBlock: 1_001n}), sent(2, "ethereum", units(7000))]},
      bsc: {...healthyBsc, exec: [executed]},
    });
    const report = await run();
    expect(report.I).toBe(0n);
    expect(report.status).toBe("ok");
  });

  it("caps snapshots at the last block scanned for CCIP messages; falls back without a finalized tag", async () => {
    const {run, fakes} = setup({
      ethereum: {client: {finalized: new Error("unknown block tag finalized"), head: 1_500n}},
      bsc: {...healthyBsc, cursor: {from: 1n, to: 800n}},
    });
    const report = await run();
    const [eth, bsc] = report.chains;
    expect(eth).toMatchObject({block: 1_497n, blockSource: "confirmed", headBlock: 1_497n});
    expect(eth!.notes[0]).toBe(
      '"finalized" block unavailable (unknown block tag finalized); used the confirmed head (latest − 3)',
    );
    expect(bsc).toMatchObject({block: 800n, blockSource: "scanned", headBlock: 1_000n, timestamp: T0});
    expect(
      new Set(fakes.bsc.reads.filter((read) => read.functionName !== "getOffRamps").map((read) => read.blockNumber)),
    ).toEqual(new Set([800n]));
    expect(report.status).toBe("ok");
  });

  it("does not evaluate R − I while a capped source misses locks its counterpart already released", async () => {
    // BSC's CCIP scan stopped at 5,000 (finalized 6,000; every block at T0). A BSC→ETH message locked after 5,000 was
    // released on ETH: ETH's balance lacks it, BSC's snapshot does not hold the lock and no send record exists.
    const release = (at: number): ExecRecord => ({
      ...failed(1, "ethereum", 900n),
      sahara: "release",
      attempts: [{state: 2, block: 900n, txHash: tx(21), logIndex: 0, at}],
      release: {pool: POOL, recipient: ccAddr(0x701), amount: units(5000), txHash: tx(21), logIndex: 1},
    });
    const lagging: ChainSetup = {...healthyBsc, cursor: {from: 1n, to: 5_000n}, client: {finalized: 6_000n}};
    const lagged = setup({
      ethereum: {balances: {pool: units("2000000000") - units(5000)}, exec: [release(NOW - 100)]},
      bsc: lagging,
    });
    const report = await lagged.run();
    expect(report.status).toBe("incomplete");
    expect(report.R).toBe(TEN_B - units(4000));
    expect(report.I).toBeUndefined();
    expect(report.margin).toBeUndefined();
    expect(report.incomplete).toEqual([
      {
        chain: "bsc",
        reason:
          "bsc: CCIP scan behind its finalized block (snapshot capped at block 5000, finalized 6000): 1 release(s) " +
          "on ethereum (5,000 SAHARA) of messages bsc has not scanned yet",
        blocking: true,
        cause: "ccip-scan-behind",
      },
    ]);
    expect(lagged.alerter.syncs[0]!.active.map((alert) => [alert.key, alert.severity])).toEqual([
      ["global:reconcile:incomplete", "warning"],
    ]);

    // A release at the capped block's timestamp may still be from a lock after it.
    const boundary = await setup({ethereum: {exec: [release(T0)]}, bsc: lagging}).run();
    expect(boundary.incomplete.map((reason) => reason.blocking)).toEqual([true]);

    // A release before the capped block's timestamp is a lock the scan saw (or one sent before tracking): evaluated.
    const earlier = await setup({ethereum: {exec: [release(T0 - 100)]}, bsc: lagging}).run();
    expect(earlier.status).toBe("ok");
    expect(earlier.incomplete).toEqual([]);
    expect(earlier.margin).toBe(units(1000));
  });

  it("reports failed messages outstanding (counted in I) and stuck messages", async () => {
    const otherToken = failed(9, "ethereum", 950n, {sahara: null});
    const {run, alerter} = setup({
      ethereum: {
        sent: [
          sent(3, "ethereum", units(50), {sentAt: NOW - 3 * 3600}),
          sent(4, "ethereum", units(60), {sentAt: NOW - 600}),
        ],
        exec: [failed(2, "ethereum", 900n), otherToken],
      },
      bsc: {...healthyBsc, sent: [sent(2, "bsc", units(300), {sentAt: NOW - 10 * 3600})]},
    });
    const report = await run();

    expect(report.failed).toMatchObject([
      {messageId: id(2), sourceChain: "bsc", destChain: "ethereum", amount: units(300)},
    ]);
    expect(report.stuck).toMatchObject([{messageId: id(3), ageSec: 3 * 3600}]);
    expect(report.I).toBe(units(410));
    expect(report.inFlight.find((entry) => entry.messageId === id(2))?.status).toBe("failed");

    const active = alerter.syncs[0]!.active;
    expect(active.map((alert) => [alert.key, alert.severity])).toEqual([
      ["global:reconcile:failed", "critical"],
      [`global:reconcile:stuck:${id(3)}`, "warning"],
    ]);
    expect(active[0]!.title).toBe("1 failed CCIP message(s) awaiting manual execution: 300 SAHARA");
    expect(active[0]!.links).toEqual([{label: `CCIP 0x0000…0002`, url: `https://ccip.chain.link/msg/${id(2)}`}]);
    expect(active[1]!.title).toBe("CCIP message not executed after 3h: 50 SAHARA ethereum→bsc");
  });

  it("flags a chain whose fixed totalSupply changed", async () => {
    const {run, alerter} = setup({ethereum: {}, bsc: {...healthyBsc, totalSupply: TEN_B + 1n}});
    await run();
    expect(alerter.syncs[0]!.active).toEqual([
      expect.objectContaining({
        key: "global:reconcile:supply:bsc",
        chain: "bsc",
        severity: "critical",
        title: "SAHARA totalSupply changed on bsc: 10,000,000,000.000000000000000001 SAHARA",
      }),
    ]);
  });

  it("reports an unreachable chain as incomplete and keeps an open breach instead of resolving it", async () => {
    const store = createStore();
    const first = setup({ethereum: {sent: [sent(1, "ethereum", units(2000))]}, bsc: healthyBsc}, {store});
    await first.run();
    expect(first.alerter.syncs[0]!.active.map((alert) => alert.key)).toEqual(["global:reconcile:backing"]);

    const second = setup(
      {
        ethereum: {sent: [sent(1, "ethereum", units(2000))]},
        bsc: {...healthyBsc, client: {finalized: new Error("fetch failed"), head: new Error("fetch failed")}},
      },
      {store},
    );
    const report = await second.run();
    expect(report.status).toBe("incomplete");
    expect(report.R).toBeUndefined();
    expect(report.I).toBeUndefined();
    expect(report.chains[1]).toMatchObject({ok: false, error: "fetch failed"});
    expect(report.incomplete).toContainEqual({
      chain: "bsc",
      reason: "bsc unreachable: fetch failed",
      blocking: true,
      cause: "unreachable",
    });

    const active = second.alerter.syncs[0]!.active;
    expect(active.map((alert) => [alert.key, alert.severity])).toEqual([
      ["global:reconcile:backing", "critical"],
      ["global:reconcile:incomplete", "warning"],
    ]);
    expect(active[0]!.note).toContain("Not re-evaluated in the latest reconciliation: R or I unknown.");
    expect(active[1]!.title).toBe("Reconciliation incomplete: bsc unreachable: fetch failed");
  });

  it("does not evaluate R − I while a CCIP scan gap is open, and keeps an open breach", async () => {
    const store = createStore();
    const first = setup({ethereum: {sent: [sent(1, "ethereum", units(2000))]}, bsc: healthyBsc}, {store});
    expect((await first.run()).status).toBe("breach");

    // Tracking was off for blocks 400–500: whatever was locked there is unknown, so no I and no margin.
    const gap = {from: 400n, to: 500n, detectedAt: NOW - 60};
    const second = setup({ethereum: {scan: {gaps: [gap]}}, bsc: healthyBsc}, {store});
    const report = await second.run();
    expect(report.status).toBe("incomplete");
    expect(report.I).toBeUndefined();
    expect(report.margin).toBeUndefined();
    expect(report.incomplete).toEqual([
      {
        chain: "ethereum",
        reason:
          "ethereum: blocks 400–500 were not scanned for CCIP messages; what was sent or executed there is unknown " +
          "until they are scanned",
        blocking: true,
        cause: "ccip-gap",
      },
    ]);
    const active = second.alerter.syncs[0]!.active;
    expect(active.map((alert) => [alert.key, alert.severity])).toEqual([
      ["global:reconcile:backing", "critical"],
      ["global:reconcile:incomplete", "warning"],
    ]);
    expect(active[0]!.note).toContain("Not re-evaluated in the latest reconciliation: R or I unknown.");
  });

  it("treats failed balance reads like an unreachable chain", async () => {
    const {run} = setup({ethereum: {balanceError: new Error("missing trie node")}, bsc: healthyBsc});
    const report = await run();
    expect(report.status).toBe("incomplete");
    expect(report.chains[0]!.error).toBe("balance reads at block 1000 failed: missing trie node");
    expect(report.incomplete).toEqual([
      {
        chain: "ethereum",
        reason: "ethereum unreachable: balance reads at block 1000 failed: missing trie node",
        blocking: true,
        cause: "unreachable",
      },
    ]);
  });

  it("is incomplete while a chain's CCIP tracking is disabled or has not started", async () => {
    const raw = {
      chains: Object.fromEntries(
        Object.entries(ccipConfig.chains).map(([name, chain]) => [
          name,
          {
            chainId: chain.chainId,
            chainSelector: chain.chainSelector.toString(),
            rpcUrls: chain.rpcUrls,
            explorerUrl: chain.explorerUrl,
            contracts: chain.contracts,
            ccip: {enabled: name !== "bsc"},
          },
        ]),
      ),
    };
    const disabled = setup({ethereum: {}, bsc: healthyBsc}, {config: configSchema.parse(raw)});
    const report = await disabled.run();
    expect(report.status).toBe("incomplete");
    expect(report.R).toBe(TEN_B + units(1000));
    expect(report.I).toBeUndefined();
    expect(report.incomplete[0]).toMatchObject({chain: "bsc", blocking: true, cause: "ccip-disabled"});
    expect(report.incomplete[0]!.reason).toContain("CCIP tracking disabled");

    const notStarted = setup({ethereum: {cursor: null}, bsc: healthyBsc});
    expect((await notStarted.run()).incomplete).toContainEqual({
      chain: "ethereum",
      reason: "ethereum: no blocks scanned for CCIP messages yet",
      blocking: true,
      cause: "ccip-not-started",
    });
  });

  it("evaluates R − I with unverifiable parts counted, and says so", async () => {
    const {run, alerter} = setup({
      ethereum: {
        sent: [sent(5, "ethereum", units(40), {destChain: null, destSelector: 42n})],
        scan: {rampsError: "rpc down"},
      },
      bsc: healthyBsc,
    });
    const report = await run();
    expect(report.status).toBe("ok");
    expect(report.I).toBe(units(40));
    expect(report.uncertain).toBe(units(40));
    const incomplete = alerter.syncs[0]!.active.find((alert) => alert.key === "global:reconcile:incomplete")!;
    expect(incomplete.title).toBe("Reconciliation uncertain: ethereum: Router ramps unreadable (rpc down)");
    expect(incomplete.fields?.map((field) => field.value)).toEqual([
      "ethereum: Router ramps unreadable (rpc down)",
      "ethereum: 1 message(s) to unconfigured chain selector(s) 42, counted as in flight",
    ]);
  });

  it("stops counting an unlinked lock or a message to an unknown chain once acknowledged", async () => {
    const lock = {txHash: tx(40), logIndex: 2, block: 450n, pool: POOL, amount: units(1500), remoteSelector: BSC, at: 1};
    const chains = {
      ethereum: {
        sent: [sent(5, "ethereum", units(40), {destChain: null, destSelector: 42n})],
        scan: {unlinked: [lock]},
      },
      bsc: healthyBsc,
    };
    // Counted however old: 1,540 in flight exceeds the 1,000 margin.
    const before = await setup(chains).run();
    expect(before).toMatchObject({status: "breach", I: units(1540), uncertain: units(1540)});

    const acknowledged = [
      {chain: "ethereum", txHash: tx(40), note: "phantom lock: tx reorged out (checked 2026-10-27)"},
      {chain: "ethereum", messageId: id(5), note: "executed on chain 42 (CCIP explorer)"},
    ];
    const config = configSchema.parse({...rawConfig(), reconciliation: {acknowledged}});
    const {run, alerter} = setup(chains, {config});
    const report = await run();
    expect(report).toMatchObject({status: "ok", I: 0n, uncertain: 0n, margin: units(1000), incomplete: []});
    expect(report.inFlight.map((entry) => [entry.status, entry.amount])).toEqual([
      ["acknowledged", units(40)],
      ["acknowledged", units(1500)],
    ]);
    expect(alerter.syncs[0]!.active).toEqual([]);
    const text = formatReconcileReport(report, ccipConfig);
    expect(text).toContain("I (in flight): 0 SAHARA (0 entries, 0 failed)");
    expect(text).toContain("[acknowledged: phantom lock: tx reorged out (checked 2026-10-27)]");
  });

  it("formats a plain-text report", async () => {
    const {run} = setup({
      ethereum: {sent: [sent(1, "ethereum", units(500))], exec: [failed(2, "ethereum", 900n)]},
      bsc: {...healthyBsc, sent: [sent(2, "bsc", units(300))]},
    });
    const text = formatReconcileReport(await run(), ccipConfig);
    expect(text.split("\n")).toEqual(
      expect.arrayContaining([
        `SAHARA reconciliation at ${formatTimestamp(NOW)}: OK`,
        "ethereum: block 1000 (finalized, 2025-10-09 08:53:20 UTC), CCIP tracking enabled",
        `  Manager ${MANAGER.ethereum}: 3,000,000,000 SAHARA`,
        `  Pool ${POOL}: 2,000,000,000 SAHARA`,
        "  Reserves: 5,000,000,000 SAHARA",
        "  totalSupply: 10,000,000,000 SAHARA",
        "  note: CCIP messages tracked from block 1",
        "R (reserves): 10,000,001,000 SAHARA",
        "I (in flight): 800 SAHARA (2 entries, 1 failed)",
        "  ethereum→bsc: 500 SAHARA",
        "  bsc→ethereum: 300 SAHARA",
        "Required: 10,000,000,000 SAHARA",
        "Margin (R − I − required): 200 SAHARA",
        "Failed messages awaiting manual execution:",
      ]),
    );
    expect(text).toContain("[failed: TokenHandlingError(target=…)]");
  });
});

/** The test configuration as raw (unparsed) input. */
function rawConfig() {
  return {
    chains: Object.fromEntries(
      Object.entries(ccipConfig.chains).map(([name, chain]) => [
        name,
        {
          chainId: chain.chainId,
          chainSelector: chain.chainSelector.toString(),
          rpcUrls: chain.rpcUrls,
          explorerUrl: chain.explorerUrl,
          contracts: chain.contracts,
        },
      ]),
    ),
  };
}
