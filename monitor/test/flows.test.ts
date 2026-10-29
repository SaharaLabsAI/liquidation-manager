import {getAddress, maxUint256, pad, toFunctionSelector, type Address, type Log} from "viem";
import {describe, expect, it} from "vitest";

import {liquidityManagerAbi} from "../src/abi/generated.ts";
import {createStore} from "../src/store.ts";
import {
  endpointKind,
  flowEndpoints,
  flowsNamespace,
  flowsRule,
  readFlowsState,
  type FlowsState,
} from "../src/rules/flows.ts";
import type {Alert, BlockRange} from "../src/types.ts";
import {loadReceipt} from "./helpers/abi-fixtures.ts";
import {
  blockTime,
  eventLog,
  fakeClient,
  FL,
  flAddresses,
  flContext,
  tokens,
  TxBuilder,
  type FlowsContext,
  type FlowsLimits,
} from "./helpers/flows-fixtures.ts";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const LOCKED_OR_BURNED = "0xf33bc26b4413b0e7f19f1ea739fdf99098c0061f1f87d954b11f5293fad9ae10";
const RELEASED_OR_MINTED = "0xfc5e3a5bddc11d92c2dc20fae6f7d5eb989f056be35239f7de7e86150609abc0";
const LIQUIDITY_ADDED = "0xc17cea59c2955cb181b03393209566960365771dbba9dc3d510180e7cb312088";
const LIQUIDITY_REMOVED = "0xc2c3f06e49b9f15e7b4af9055e183b0d73362e033ad82a07dec9bf9840171719";
const LIQUIDITY_TRANSFERRED = "0x6fa7abcf1345d1d478e5ea0da6b5f26a90eadb0546ef15ed3833944fbfd1db62";

/** Real deployment (test/fixtures/ccip): SAHARA token and the Ethereum LockReleaseTokenPool. */
const REAL_TOKEN = getAddress("0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111");
const REAL_POOL = getAddress("0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4");

const WINDOW_SCOPE = "ethereum:flows:outflow-window:";
const windowKey = (pool: Address) => `${WINDOW_SCOPE}${getAddress(pool)}`;

function rangeOf(logs: readonly Log[], fallback = 100n): BlockRange {
  const blocks = logs.map((log) => log.blockNumber ?? fallback);
  const to = blocks.reduce((max, block) => (block > max ? block : max), fallback);
  const from = blocks.reduce((min, block) => (block < min ? block : min), to);
  return {from, to};
}

async function run(ctx: FlowsContext, logs: Log[], range: BlockRange = rangeOf(logs)): Promise<Alert[]> {
  const before = ctx.alerter.emitted.length;
  await flowsRule.onLogs(ctx, logs, range);
  return ctx.alerter.emitted.slice(before);
}

function field(alert: Alert | undefined, label: string): string | undefined {
  return alert?.fields?.find((f) => f.label === label)?.value;
}

function lastSync(ctx: FlowsContext) {
  const sync = ctx.alerter.syncs.at(-1);
  expect(sync?.scope).toBe(WINDOW_SCOPE);
  return sync!.active;
}

describe("flowsRule.filters", () => {
  it("requests Transfers from/to every endpoint, endpoint Approvals and the accounting events", () => {
    const ctx = flContext();
    const filters = flowsRule.filters(ctx);
    const endpointTopics = flowEndpoints(ctx).map((address) => pad(address.toLowerCase() as `0x${string}`, {size: 32}));
    expect(endpointTopics).toHaveLength(7);
    expect(filters).toEqual([
      {address: FL.token, topics: [[TRANSFER, APPROVAL], endpointTopics]},
      {address: FL.token, topics: [TRANSFER, null, endpointTopics]},
      {address: [FL.manager, FL.pool, FL.newPool], topics: [expect.any(Array)]},
    ]);
    const accounting = (filters[2]!.topics![0] as string[]).map((t) => t.toLowerCase());
    // Verified 1.6.3-dev pool events (src/abi/VERIFICATION.md), not the pre-1.5 Locked/Released.
    const poolTopics = [
      LOCKED_OR_BURNED,
      RELEASED_OR_MINTED,
      LIQUIDITY_ADDED,
      LIQUIDITY_REMOVED,
      LIQUIDITY_TRANSFERRED,
    ];
    for (const topic of poolTopics) expect(accounting).toContain(topic);
    expect(accounting).toHaveLength(8);
  });

  it("lists each endpoint once, including contracts missing from addresses.endpoints", () => {
    const ctx = flContext({addresses: {endpoints: [FL.pool, FL.pool.toLowerCase() as Address]}});
    const endpoints = flowEndpoints(ctx);
    expect(new Set(endpoints.map((a) => a.toLowerCase())).size).toBe(endpoints.length);
    expect(endpoints).toEqual(expect.arrayContaining([FL.manager, FL.adapter, FL.oldAdapter, FL.newPool, FL.legacy]));
    expect(endpoints).not.toContain(FL.extra);
  });

  it("requests nothing without endpoints, Manager or pools", () => {
    const ctx = flContext({
      addresses: {
        manager: undefined,
        adapters: [],
        adapterHistory: [],
        pools: [],
        legacyWallets: [],
        endpoints: [],
      },
    });
    expect(flowsRule.filters(ctx)).toEqual([]);
  });

  it("classifies endpoints", () => {
    const ctx = flContext();
    expect(endpointKind(ctx, FL.manager.toLowerCase())).toBe("manager");
    expect(endpointKind(ctx, FL.oldAdapter)).toBe("adapter");
    expect(endpointKind(ctx, FL.newPool)).toBe("pool");
    expect(endpointKind(ctx, FL.legacy)).toBe("legacy");
    expect(endpointKind(ctx, FL.extra)).toBe("endpoint");
    expect(endpointKind(ctx, FL.user)).toBeUndefined();
  });
});

describe("flowsRule: accounted flows raise nothing", () => {
  it("fund: Manager -> adapter, approve, provideLiquidity, approve 0, Funded", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(1, 100n).fund(tokens(1_000_000));
    expect(await run(ctx, tx.logs)).toEqual([]);
    expect(ctx.log.warnings).toEqual([]);
  });

  it("recall: withdrawLiquidity to the adapter, adapter -> Manager, Recalled", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(1, 100n).recall(tokens(250_000));
    expect(await run(ctx, tx.logs)).toEqual([]);
  });

  it("several operations in one transaction, including equal amounts", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(1, 100n)
      .fund(tokens(500))
      .fund(tokens(500))
      .recall(tokens(500))
      .fund(tokens(1), {adapter: FL.oldAdapter, pool: FL.newPool, adapterId: 2n});
    expect(await run(ctx, tx.logs)).toEqual([]);
  });

  it("migrateReserves to an outside address (the Manager rule alerts ReservesMigrated)", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(1, 100n).migrate(FL.stranger, tokens(9_000_000_000));
    expect(await run(ctx, tx.logs)).toEqual([]);
  });

  it("user bridge lock and release (synthetic, OnRamp/OffRamp order)", async () => {
    const ctx = flContext();
    const lock = new TxBuilder(1, 100n).lock(FL.user, tokens(42));
    const release = new TxBuilder(2, 101n).release(FL.user, tokens(41));
    expect(await run(ctx, [...lock.logs, ...release.logs])).toEqual([]);
  });

  it("transferLiquidity from the old pool to the new pool (the pool rule alerts it)", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(1, 100n).transferLiquidity(FL.pool, FL.newPool, tokens(3_000_000));
    expect(await run(ctx, tx.logs)).toEqual([]);
  });

  it("transferLiquidity into a pool that is not watched yet: the old pool's LiquidityRemoved covers it", async () => {
    const ctx = flContext({addresses: {pools: [FL.pool], endpoints: [FL.manager, FL.adapter, FL.pool]}});
    const tx = new TxBuilder(1, 100n).transferLiquidity(FL.pool, FL.newPool, tokens(3_000_000));
    expect(await run(ctx, tx.logs)).toEqual([]);
  });

  it("ignores zero-value transfers (address poisoning) and unrelated Manager events", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(1, 100n)
      .transfer(FL.manager, FL.stranger, 0n)
      .transfer(FL.stranger, FL.pool, 0n)
      .guardianAction(toFunctionSelector("pauseFunding()"))
      .transfer(FL.user, FL.stranger, tokens(5));
    expect(await run(ctx, tx.logs)).toEqual([]);
  });
});

describe("flowsRule: real CCIP receipts", () => {
  const realCtx = (limits: FlowsLimits = {}) =>
    flContext({
      limits,
      addresses: flAddresses({
        token: REAL_TOKEN,
        pools: [REAL_POOL],
        registryPool: REAL_POOL,
        adapters: [{id: 1n, adapter: FL.adapter, pool: REAL_POOL, fundingEnabled: true, recallEnabled: true}],
        endpoints: [FL.manager, FL.adapter, REAL_POOL],
        labels: {[REAL_POOL.toLowerCase()]: "Pool", [FL.manager.toLowerCase()]: "Manager"},
      }),
    });

  it("user lock through OnRamp 2.0.0 (eth-send-v2) is a bridge lock", async () => {
    const {logs} = loadReceipt("eth-send-v2.json");
    const ctx = realCtx();
    expect(await run(ctx, logs)).toEqual([]);
  });

  it("a large lock raises a warning", async () => {
    const {fixture, logs} = loadReceipt("eth-send-v2.json");
    const ctx = realCtx({largeTransfer: "10000"});
    const alerts = await run(ctx, logs);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      key: `ethereum:flows:${fixture.transactionHash}:${0x129}`,
      severity: "warning",
      rule: "flows.large-transfer",
      title: "Large bridge lock into Pool: 37,201.29 SAHARA",
    });
    expect(field(alerts[0], "Check (warning)")).toMatch(/bridge lock to bsc/);
  });

  it("release through OffRamp 2.0.0 (eth-exec-v2) is a bridge release and enters the outflow window", async () => {
    const {fixture, logs} = loadReceipt("eth-exec-v2.json");
    const ctx = realCtx({outflowWindowAmount: "1000000"});
    expect(await run(ctx, logs)).toEqual([]);
    const state = readFlowsState(ctx);
    expect(state.outflows[REAL_POOL]).toEqual([
      {
        key: `${fixture.transactionHash}:${0x1b6}`,
        timestamp: blockTime(BigInt(fixture.blockNumber)),
        amount: BigInt("0xd780600ecef6630f71"),
        kind: "release",
      },
    ]);
    expect(lastSync(ctx)).toEqual([]);
  });
});

describe("flowsRule: anomalies", () => {
  it("direct transfer to a pool (no LiquidityAdded or lock) is high", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(7, 100n).transfer(FL.user, FL.pool, tokens(1_000));
    const alerts = await run(ctx, tx.logs);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      key: `ethereum:flows:${tx.hash}:0`,
      kind: "event",
      severity: "high",
      rule: "flows.pool-inflow",
      chain: "ethereum",
      title: "Direct transfer to Pool: 1,000 SAHARA",
    });
    expect(field(alerts[0], "Check (high)")).toMatch(/bypasses provideLiquidity and increases releasable inventory/);
    expect(field(alerts[0], "Accounting events in tx")).toBe("none");
    expect(alerts[0]!.links?.[0]?.url).toBe(`https://etherscan.io/tx/${tx.hash}`);
    expect(alerts[0]!.fields?.find((f) => f.label === "From")?.code).toBe(true);
  });

  it("a lock of a different amount does not explain a pool inflow", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(7, 100n).transfer(FL.user, FL.pool, tokens(1_000)).lockedOrBurned(FL.pool, tokens(999));
    const alerts = await run(ctx, tx.logs);
    expect(alerts.map((a) => a.rule)).toEqual(["flows.pool-inflow"]);
  });

  it("a lock of another token does not explain a pool inflow", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(7, 100n)
      .transfer(FL.user, FL.pool, tokens(1_000))
      .lockedOrBurned(FL.pool, tokens(1_000), undefined, FL.stranger);
    expect((await run(ctx, tx.logs)).map((a) => a.rule)).toEqual(["flows.pool-inflow"]);
  });

  it("direct transfer to an adapter is high and unrecoverable", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(8, 100n).transfer(FL.user, FL.adapter, tokens(5));
    const alerts = await run(ctx, tx.logs);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "high",
      rule: "flows.adapter-inflow",
      title: "SAHARA sent directly to Adapter #1: 5 SAHARA",
    });
    expect(alerts[0]!.note).toMatch(/Unrecoverable: the adapter has no rescue/);
  });

  it("unexplained Manager outflow is critical", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(9, 100n).transfer(FL.manager, FL.stranger, tokens(1_000));
    const alerts = await run(ctx, tx.logs);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      key: `ethereum:flows:${tx.hash}:0`,
      severity: "critical",
      rule: "flows.manager-outflow",
      title: "Unexplained outflow from Manager: 1,000 SAHARA",
    });
    expect(field(alerts[0], "Amount")).toBe("1,000 SAHARA (raw 1000000000000000000000)");
  });

  it("a Funded of a different amount does not explain the Manager leg", async () => {
    const ctx = flContext();
    const amount = tokens(1_000);
    const tx = new TxBuilder(10, 100n)
      .transfer(FL.manager, FL.adapter, amount)
      .approval(FL.adapter, FL.pool, amount)
      .transfer(FL.adapter, FL.pool, amount)
      .liquidityAdded(FL.pool, FL.adapter, amount)
      .approval(FL.adapter, FL.pool, 0n)
      .fundedEvent(amount - 1n);
    const alerts = await run(ctx, tx.logs);
    const manager = alerts.find((a) => a.key === `ethereum:flows:${tx.hash}:0`);
    expect(manager).toMatchObject({severity: "critical", rule: "flows.manager-outflow"});
    expect(field(manager, "Check (high)")).toMatch(/to Adapter #1 outside a Funded\/Recalled operation/);
    expect(field(manager, "Accounting events in tx")).toBe(
      "Pool LiquidityAdded 1,000 SAHARA by Adapter #1; Funded 999.999999999999999999 SAHARA to Pool via adapter #1",
    );
    // The adapter -> pool leg and the approval are not covered either.
    expect(alerts.find((a) => a.key === `ethereum:flows:${tx.hash}:2`)).toMatchObject({rule: "flows.adapter-outflow"});
    expect(alerts.find((a) => a.key === `ethereum:flows:${tx.hash}:1`)).toMatchObject({rule: "flows.approval"});
  });

  it("an extra same-amount Manager -> adapter transfer inside a fund is flagged exactly once", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(11, 100n).fund(tokens(500)).transfer(FL.manager, FL.adapter, tokens(500));
    const alerts = await run(ctx, tx.logs);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      key: `ethereum:flows:${tx.hash}:6`,
      severity: "critical",
      rule: "flows.manager-outflow",
    });
    // Both sides of the one transfer are in the same alert.
    expect(field(alerts[0], "Check (high)")).toMatch(/Adapter #1/);
  });

  it("explanations are only accepted from the Manager and watched pools", async () => {
    const ctx = flContext();
    const amount = tokens(77);
    const hash = new TxBuilder(12, 100n).hash;
    const logs = [
      ...new TxBuilder(12, 100n).transfer(FL.manager, FL.stranger, amount).logs,
      // Look-alike events from attacker contracts.
      eventLog(liquidityManagerAbi, FL.stranger, "ReservesMigrated", {to: FL.stranger, amount}, {
        txHash: hash,
        blockNumber: 100n,
        logIndex: 1,
      }),
    ];
    const pool = new TxBuilder(13, 100n, {firstLogIndex: 10}).transfer(FL.user, FL.pool, amount).logs;
    const fakeLock = new TxBuilder(13, 100n, {firstLogIndex: 11}).lockedOrBurned(FL.stranger, amount).logs;
    const alerts = await run(ctx, [...logs, ...pool, ...fakeLock]);
    expect(alerts.map((a) => a.rule).sort()).toEqual(["flows.manager-outflow", "flows.pool-inflow"]);
  });

  it("adapter outflow outside fund/recall is critical", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(14, 100n).transfer(FL.oldAdapter, FL.stranger, tokens(3));
    const alerts = await run(ctx, tx.logs);
    expect(alerts[0]).toMatchObject({
      severity: "critical",
      rule: "flows.adapter-outflow",
      title: "Unexplained outflow from Adapter (retired): 3 SAHARA",
    });
  });

  it("pool outflow without a release or withdrawal is critical; a release must name the recipient", async () => {
    const ctx = flContext();
    const bare = new TxBuilder(15, 100n).transfer(FL.pool, FL.stranger, tokens(10));
    const wrongRecipient = new TxBuilder(16, 100n)
      .transfer(FL.pool, FL.stranger, tokens(10))
      .releasedOrMinted(FL.pool, FL.user, tokens(10));
    const alerts = await run(ctx, [...bare.logs, ...wrongRecipient.logs]);
    expect(alerts.map((a) => [a.severity, a.rule, a.title])).toEqual([
      ["critical", "flows.pool-outflow", "Unexplained outflow from Pool: 10 SAHARA"],
      ["critical", "flows.pool-outflow", "Unexplained outflow from Pool: 10 SAHARA"],
    ]);
    expect(alerts[1]!.note).toMatch(/GuardianController\.lockdown\(pool\)/);
  });

  it("a withdrawal to a non-adapter rebalancer is left to the pool rule", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(17, 100n)
      .transfer(FL.pool, FL.stranger, tokens(10))
      .liquidityRemoved(FL.pool, FL.stranger, tokens(10));
    expect(await run(ctx, tx.logs)).toEqual([]);
  });

  it("a large release raises a warning", async () => {
    const ctx = flContext({limits: {largeTransfer: "1000"}});
    const small = new TxBuilder(18, 100n).release(FL.user, tokens(999));
    const large = new TxBuilder(19, 100n).release(FL.user, tokens(1000));
    const alerts = await run(ctx, [...small.logs, ...large.logs]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      key: `ethereum:flows:${large.hash}:1`,
      severity: "warning",
      rule: "flows.large-transfer",
      title: "Large bridge release from Pool: 1,000 SAHARA",
    });
    expect(field(alerts[0], "Check (warning)")).toMatch(/bridge release from bsc, via 0x0{38}71/);
  });
});

describe("flowsRule: legacy wallets and extra endpoints", () => {
  it("legacy wallet -> Manager is one info alert (migration step 3)", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(20, 100n).transfer(FL.legacy, FL.manager, tokens(2_000_000_000));
    const alerts = await run(ctx, tx.logs);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "info",
      rule: "flows.reserve-migration",
      title: "Legacy wallet 1 moved 2,000,000,000 SAHARA to the Manager",
    });
    expect(alerts[0]!.fields?.filter((f) => f.label.startsWith("Check"))).toHaveLength(2);
  });

  it("legacy wallet outflow elsewhere is high; inflow is info", async () => {
    const ctx = flContext();
    const out = new TxBuilder(21, 100n).transfer(FL.legacy, FL.stranger, tokens(1));
    const inflow = new TxBuilder(22, 100n).transfer(FL.stranger, FL.extra, tokens(2));
    const alerts = await run(ctx, [...out.logs, ...inflow.logs]);
    expect(alerts.map((a) => [a.severity, a.rule, a.title])).toEqual([
      ["high", "flows.endpoint-outflow", "Outflow from Legacy wallet 1: 1 SAHARA"],
      ["info", "flows.endpoint-inflow", "Inflow to Endpoint 1: 2 SAHARA"],
    ]);
  });

  it("legacy wallet -> pool is high on both sides", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(23, 100n).transfer(FL.legacy, FL.pool, tokens(1));
    const alerts = await run(ctx, tx.logs);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("high");
    expect(alerts[0]!.fields?.filter((f) => f.label === "Check (high)")).toHaveLength(2);
  });

  it("direct inflow to the Manager outside a recall is info", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(24, 100n).transfer(FL.user, FL.manager, tokens(1));
    const alerts = await run(ctx, tx.logs);
    expect(alerts.map((a) => [a.severity, a.rule])).toEqual([["info", "flows.manager-inflow"]]);
  });

  it("migrateReserves to an extra endpoint reports only the inflow", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(25, 100n).migrate(FL.extra, tokens(5));
    const alerts = await run(ctx, tx.logs);
    expect(alerts.map((a) => [a.severity, a.rule])).toEqual([["info", "flows.endpoint-inflow"]]);
  });
});

describe("flowsRule: approvals", () => {
  it("approvals by an endpoint outside a fund are high; zero approvals are ignored", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(30, 100n)
      .approval(FL.legacy, FL.stranger, tokens(1_000))
      .approval(FL.manager, FL.stranger, maxUint256)
      .approval(FL.adapter, FL.pool, tokens(5))
      .approval(FL.legacy, FL.stranger, 0n)
      .approval(FL.user, FL.stranger, tokens(1));
    const alerts = await run(ctx, tx.logs);
    expect(alerts.map((a) => [a.key, a.severity, a.rule])).toEqual([0, 1, 2].map((i) => [
      `ethereum:flows:${tx.hash}:${i}`,
      "high",
      "flows.approval",
    ]));
    expect(alerts.map((a) => a.title)).toEqual([
      `Approval by Legacy wallet 1: ${FL.stranger} may spend 1,000 SAHARA`,
      `Approval by Manager: ${FL.stranger} may spend unlimited`,
      "Approval by Adapter #1: Pool may spend 5 SAHARA",
    ]);
    expect(field(alerts[1], "Allowance")).toBe("unlimited");
  });

  it("a second adapter approval in a fund transaction is flagged", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(31, 100n).fund(tokens(5)).approval(FL.adapter, FL.pool, tokens(5));
    const alerts = await run(ctx, tx.logs);
    expect(alerts.map((a) => a.key)).toEqual([`ethereum:flows:${tx.hash}:6`]);
  });
});

describe("flowsRule: robustness", () => {
  it("an undecodable log is skipped with a warning and the rest is processed", async () => {
    const ctx = flContext();
    const good = new TxBuilder(40, 100n).transfer(FL.manager, FL.stranger, tokens(1));
    const bad = new TxBuilder(41, 100n).transfer(FL.manager, FL.stranger, tokens(1));
    const broken = {...bad.logs[0]!, data: "0x01"} as Log;
    const alerts = await run(ctx, [broken, ...good.logs]);
    expect(alerts.map((a) => a.key)).toEqual([`ethereum:flows:${good.hash}:0`]);
    expect(ctx.log.warnings.map((w) => w.message)).toEqual(["flows: cannot decode log"]);
  });

  it("ignores removed logs and token logs of other contracts", async () => {
    const ctx = flContext();
    const tx = new TxBuilder(42, 100n).transfer(FL.manager, FL.stranger, tokens(1));
    const removed = {...tx.logs[0]!, removed: true} as Log;
    const otherToken = {...tx.logs[0]!, address: FL.stranger.toLowerCase()} as Log;
    expect(await run(ctx, [removed, otherToken])).toEqual([]);
  });

  it("emits transfer alerts even when block timestamps are unavailable", async () => {
    const ctx = flContext({client: fakeClient({failGetBlock: true}), limits: {outflowWindowAmount: "1"}});
    const tx = new TxBuilder(43, 100n).transfer(FL.pool, FL.stranger, tokens(10));
    const alerts = await run(ctx, tx.logs);
    expect(alerts.map((a) => a.rule)).toEqual(["flows.pool-outflow"]);
    expect(ctx.log.warnings.map((w) => w.message)).toEqual([
      "flows: block timestamps unavailable for pool outflows",
      "flows: block timestamp unavailable for the window end",
    ]);
    // The outflow still counts (wall-clock time), so the window condition opens.
    expect(lastSync(ctx).map((a) => a.key)).toEqual([windowKey(FL.pool)]);
  });
});

describe("flowsRule: outflow window", () => {
  const limits = {outflowWindowAmount: "1000", outflowWindowSec: 3600};

  it("opens when the pool outflow within the window reaches the limit and resolves when it drains", async () => {
    const store = createStore();
    const ctx = flContext({limits, store});

    // t = +1200 s: release 600 (below the limit).
    await run(ctx, new TxBuilder(50, 100n).release(FL.user, tokens(600)).logs, {from: 90n, to: 110n});
    expect(lastSync(ctx)).toEqual([]);

    // t = +2400 s: recall 400 -> 1,000 within one hour.
    const recall = new TxBuilder(51, 200n).recall(tokens(400));
    expect(await run(ctx, recall.logs, {from: 111n, to: 200n})).toEqual([]);
    const [condition] = lastSync(ctx);
    expect(condition).toMatchObject({
      key: windowKey(FL.pool),
      kind: "condition",
      severity: "high",
      rule: "flows.outflow-window",
      chain: "ethereum",
      title: "Pool outflow 1,000 SAHARA within 1h",
    });
    expect(field(condition, "Transfers")).toBe("2 (1 bridge release, 1 recall)");
    expect(field(condition, "Largest")).toBe("600 SAHARA");
    expect(ctx.alerter.open.has(windowKey(FL.pool))).toBe(true);

    // Restart: a fresh alerter and context over the same store re-declare the open condition (no logs, t = +3600).
    const restarted = flContext({limits, store});
    await run(restarted, [], {from: 201n, to: 300n});
    expect(lastSync(restarted).map((a) => a.key)).toEqual([windowKey(FL.pool)]);

    // t = +4800 s: the release at +1200 left the window -> 400 remains, condition resolved.
    await run(restarted, [], {from: 301n, to: 400n});
    expect(lastSync(restarted)).toEqual([]);
    const state = store.get<FlowsState>(flowsNamespace("ethereum"), {outflows: {}});
    expect(state.outflows[FL.pool]?.map((e) => [e.kind, e.amount])).toEqual([["recall", tokens(400)]]);

    // t = +6000 s: everything aged out and the pool entry is dropped.
    await run(restarted, [], {from: 401n, to: 500n});
    expect(readFlowsState(restarted).outflows).toEqual({});
  });

  it("resolves through the alerter when the window drains", async () => {
    const ctx = flContext({limits});
    await run(ctx, new TxBuilder(52, 100n).release(FL.user, tokens(1000)).logs, {from: 100n, to: 100n});
    expect(ctx.alerter.open.has(windowKey(FL.pool))).toBe(true);
    await run(ctx, [], {from: 101n, to: 500n});
    expect(ctx.alerter.resolved).toEqual([windowKey(FL.pool)]);
  });

  it("counts every pool outflow (release, transferLiquidity, unexplained) per pool", async () => {
    const ctx = flContext({limits});
    const logs = [
      ...new TxBuilder(53, 100n).release(FL.user, tokens(300)).logs,
      ...new TxBuilder(54, 100n).transferLiquidity(FL.pool, FL.newPool, tokens(300)).logs,
      ...new TxBuilder(55, 101n).transfer(FL.pool, FL.stranger, tokens(400)).logs,
      ...new TxBuilder(56, 101n).release(FL.user, tokens(999), FL.newPool).logs,
    ];
    await run(ctx, logs, {from: 100n, to: 101n});
    const active = lastSync(ctx);
    expect(active.map((a) => a.key)).toEqual([windowKey(FL.pool)]);
    expect(field(active[0], "Transfers")).toBe("3 (1 bridge release, 1 withdrawal, 1 unexplained)");
    expect(readFlowsState(ctx).outflows[FL.newPool]?.map((e) => e.amount)).toEqual([tokens(999)]);
  });

  it("does not double-count a rescanned range", async () => {
    const ctx = flContext({limits});
    const logs = new TxBuilder(57, 100n).release(FL.user, tokens(600)).logs;
    await run(ctx, logs, {from: 100n, to: 100n});
    await run(ctx, logs, {from: 100n, to: 100n});
    expect(readFlowsState(ctx).outflows[FL.pool]).toHaveLength(1);
    expect(lastSync(ctx)).toEqual([]);
  });

  it("uses the RPC's log blockTimestamp instead of fetching blocks", async () => {
    const client = fakeClient();
    const ctx = flContext({limits, client});
    const tx = new TxBuilder(58, 100n, {blockTimestamp: 1_800_000_000}).release(FL.user, tokens(5));
    await run(ctx, tx.logs, {from: 100n, to: 100n});
    expect(client.blocks).toEqual([]);
    expect(readFlowsState(ctx).outflows[FL.pool]?.[0]?.timestamp).toBe(1_800_000_000);
  });

  it("fetches the window end block only when there is something in the window", async () => {
    const client = fakeClient();
    const ctx = flContext({limits, client});
    await run(ctx, [], {from: 1n, to: 50n});
    expect(client.blocks).toEqual([]);
    expect(lastSync(ctx)).toEqual([]);
  });

  it("without outflowWindowAmount: no window, stored entries cleared, conditions resolved", async () => {
    const store = createStore();
    const enabled = flContext({limits, store});
    await run(enabled, new TxBuilder(59, 100n).release(FL.user, tokens(5000)).logs, {from: 100n, to: 100n});
    expect(lastSync(enabled)).toHaveLength(1);

    const disabled = flContext({store, alerter: enabled.alerter});
    await run(disabled, new TxBuilder(60, 101n).release(FL.user, tokens(5000)).logs, {from: 101n, to: 101n});
    expect(lastSync(disabled)).toEqual([]);
    expect(enabled.alerter.resolved).toEqual([windowKey(FL.pool)]);
    expect(readFlowsState(disabled).outflows).toEqual({});
  });
});
