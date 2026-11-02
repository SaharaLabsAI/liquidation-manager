import {describe, expect, it} from "vitest";
import {
  encodeEventTopics,
  keccak256,
  pad,
  parseUnits,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import {routerAbi, saharaTokenAbi, tokenAdminRegistryAbi, tokenPoolAbi} from "../src/abi/external.ts";
import {guardianControllerAbi, liquidityManagerAbi, saharaTimelockAbi} from "../src/abi/generated.ts";
import {
  controllerEventsRule,
  eventRules,
  managerEventsRule,
  poolEventsRule,
  registryEventsRule,
  remoteSelectors,
  routerEventsRule,
  tokenEventsRule,
} from "../src/rules/events.ts";
import type {Alert, EventRule} from "../src/types.ts";
import {
  allLogs,
  BSC_SELECTOR,
  encodedAddress,
  ETH_SELECTOR,
  EV,
  evAddr,
  evAddresses,
  evClient,
  evConfig,
  evContext,
  evSingleChainConfig,
  OTHER_SELECTOR,
  RANGE,
  TxBuilder,
  type EvContext,
} from "./helpers/events-fixtures.ts";

const SAHARA = (amount: string) => parseUnits(amount, 18);
const opId = (n: number): Hex => keccak256(toHex(`op-${n}`));
const topic = (abi: Parameters<typeof encodeEventTopics>[0]["abi"], eventName: string): Hex =>
  (encodeEventTopics({abi, eventName} as never) as Hex[])[0]!;

async function run(rule: EventRule, ctx: EvContext, ...txs: TxBuilder[]): Promise<Alert[]> {
  await rule.onLogs(ctx, allLogs(...txs), RANGE);
  return ctx.alerter.emitted;
}

/** Every event rule over the same logs, like the daemon does. */
async function runAll(ctx: EvContext, ...txs: TxBuilder[]): Promise<Alert[]> {
  const logs = allLogs(...txs);
  for (const rule of eventRules) await rule.onLogs(ctx, logs, RANGE);
  return ctx.alerter.emitted;
}

function field(alert: Alert | undefined, label: string): string | undefined {
  return alert?.fields?.find((entry) => entry.label === label)?.value;
}

function summary(alerts: Alert[]): Array<[string, string, string]> {
  return alerts.map((alert) => [alert.severity, alert.rule, alert.title]);
}

/** The CallExecuted the Timelock emits after a call to `target` returns. */
function executed(tx: TxBuilder, id: Hex, target: Address, index = 0n): TxBuilder {
  return tx.log(saharaTimelockAbi, EV.timelock, "CallExecuted", {id, index, target, value: 0n, data: "0x"});
}

function guardianAction(tx: TxBuilder, signature: string, guardian: Address = EV.guardian): TxBuilder {
  return tx.log(liquidityManagerAbi, EV.manager, "GuardianAction", {guardian, selector: toFunctionSelector(signature)});
}

function manager(tx: TxBuilder, eventName: string, args: Record<string, unknown>): TxBuilder {
  return tx.log(liquidityManagerAbi, EV.manager, eventName, args);
}

function pool(tx: TxBuilder, eventName: string, args: Record<string, unknown>, address: Address = EV.pool): TxBuilder {
  return tx.log(tokenPoolAbi, address, eventName, args);
}

const LOCKDOWN = {isEnabled: true, capacity: 0n, rate: 0n};
const LIMIT = {isEnabled: true, capacity: SAHARA("1000000"), rate: SAHARA("10")};

const SPEC = {
  typeAndVersion: "LockReleaseTokenPool 1.6.3-dev",
  router: EV.router,
  remoteChainSelector: BSC_SELECTOR,
  remoteToken: encodedAddress(EV.otherToken),
  remotePools: [encodedAddress(EV.stranger)],
  rateLimitAdmin: EV.controller,
};

describe("managerEventsRule", () => {
  it("requests every Manager log plus the Timelock CallExecuted logs for attribution", () => {
    const ctx = evContext();
    expect(managerEventsRule.filters(ctx)).toEqual([
      {address: EV.manager},
      {address: EV.timelock, topics: [topic(saharaTimelockAbi, "CallExecuted").toLowerCase()]},
    ]);
    // Before a Manager exists the CallExecuted filter still attributes token, registry and pool changes.
    expect(managerEventsRule.filters(evContext({addresses: evAddresses({manager: undefined})}))).toEqual([
      {address: EV.timelock, topics: [topic(saharaTimelockAbi, "CallExecuted").toLowerCase()]},
    ]);
    const none = evAddresses({manager: undefined, timelock: undefined});
    expect(managerEventsRule.filters(evContext({addresses: none}))).toEqual([]);
  });

  it("reports Funded and Recalled as info with amount, pool, adapter and operator", async () => {
    const ctx = evContext();
    const funded = manager(new TxBuilder(1), "Funded", {
      adapterId: 1n,
      pool: EV.pool,
      operator: EV.fundingOperator,
      adapter: EV.adapter,
      amount: SAHARA("1000"),
    });
    const recalled = manager(new TxBuilder(2), "Recalled", {
      adapterId: 1n,
      pool: EV.pool,
      operator: EV.recallOperator,
      adapter: EV.adapter,
      amount: SAHARA("500.5"),
    });
    const alerts = await run(managerEventsRule, ctx, funded, recalled);
    expect(summary(alerts)).toEqual([
      ["info", "manager.funded", "Funded Pool: 1,000 SAHARA"],
      ["info", "manager.recalled", "Recalled from Pool: 500.5 SAHARA"],
    ]);
    const [first] = alerts;
    expect(first?.key).toBe(`ethereum:manager:${funded.hash}:0`);
    expect(first?.kind).toBe("event");
    expect(field(first, "Adapter #1")).toBe(`Adapter #1 ${EV.adapter}`);
    expect(field(first, "Operator")).toBe(EV.fundingOperator);
    const codeFields = first?.fields?.filter((entry) => entry.label === "Pool" || entry.label === "Amount");
    expect(codeFields?.map((entry) => entry.code)).toEqual([true, true]);
    expect(first?.links).toEqual([{label: "Transaction", url: `https://explorer.example/tx/${funded.hash}`}]);
  });

  it("folds the config event of a Guardian call into one high GuardianAction alert", async () => {
    const ctx = evContext();
    const tx = manager(guardianAction(new TxBuilder(1), "pauseFunding()"), "FundingPausedSet", {paused: true});
    const alerts = await run(managerEventsRule, ctx, tx);
    expect(summary(alerts)).toEqual([["high", "manager.guardian-action", "Guardian paused funding"]]);
    const [alert] = alerts;
    expect(alert?.key).toBe(`ethereum:manager:${tx.hash}:0`);
    expect(field(alert, "Guardian")).toBe(`Guardian ${EV.guardian}`);
    expect(field(alert, "Function")).toBe("LiquidityManager.pauseFunding");
    expect(field(alert, "Effect")).toBe("Funding paused");
    expect(alert?.note).toContain("needs a Timelock operation");
  });

  it("attributes the same event to the Guardian or to the Timelock operation that executed it", async () => {
    const ctx = evContext();
    const byGuardian = manager(
      guardianAction(new TxBuilder(1), "suspendFundingOperator(address)"),
      "FundingOperatorSet",
      {operator: EV.fundingOperator, enabled: false},
    );
    const revoked = executed(
      manager(new TxBuilder(2), "FundingOperatorSet", {operator: EV.fundingOperator, enabled: false}),
      opId(2),
      EV.manager,
    );
    const granted = executed(
      manager(new TxBuilder(3), "FundingOperatorSet", {operator: EV.stranger, enabled: true}),
      opId(3),
      EV.manager,
    );
    const alerts = await run(managerEventsRule, ctx, byGuardian, revoked, granted);
    expect(summary(alerts)).toEqual([
      ["high", "manager.guardian-action", "Guardian suspended a funding operator"],
      ["high", "manager.config", `Funding operator revoked: ${EV.fundingOperator}`],
      ["critical", "manager.config", `Funding operator granted: ${EV.stranger}`],
    ]);
    expect(field(alerts[0], "Effect")).toBe(`Funding operator revoked: ${EV.fundingOperator}`);
    expect(field(alerts[0], "Timelock operation")).toBeUndefined();
    expect(field(alerts[1], "Timelock operation")).toBe(opId(2));
    expect(field(alerts[2], "Timelock operation")).toBe(opId(3));
  });

  it("tells raisePoolMinimum (Guardian) from setPoolThresholds (Timelock)", async () => {
    const ctx = evContext();
    const thresholds = {
      pool: EV.pool,
      minimum: SAHARA("2000"),
      refillTrigger: SAHARA("1000"),
      refillTarget: SAHARA("3000"),
    };
    const raised = manager(
      guardianAction(new TxBuilder(1), "raisePoolMinimum(address,uint256)"),
      "PoolThresholdsSet",
      thresholds,
    );
    const set = executed(manager(new TxBuilder(2), "PoolThresholdsSet", thresholds), opId(7), EV.manager, 2n);
    const alerts = await run(managerEventsRule, ctx, raised, set);
    expect(summary(alerts)).toEqual([
      ["high", "manager.guardian-action", "Guardian raised a pool minimum"],
      ["high", "manager.config", "Thresholds of Pool set: minimum 2,000 SAHARA"],
    ]);
    expect(alerts[0]?.note).toContain("max(minimum, trigger)");
    expect(field(alerts[0], "Minimum")).toBe("2,000 SAHARA");
    // Only call index 2 of the operation is in this transaction: numbered from 1, without a batch length.
    expect(field(alerts[1], "Timelock operation (call 3)")).toBe(opId(7));
  });

  it("gives each GuardianAction of a multi-call Guardian transaction its own alert", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1);
    manager(guardianAction(tx, "pauseFunding()"), "FundingPausedSet", {paused: true});
    manager(guardianAction(tx, "restrictAdapter(uint256,bool,bool)"), "AdapterStatusSet", {
      adapterId: 1n,
      fundingEnabled: false,
      recallEnabled: true,
    });
    const alerts = await run(managerEventsRule, ctx, tx);
    expect(summary(alerts)).toEqual([
      ["high", "manager.guardian-action", "Guardian paused funding"],
      ["high", "manager.guardian-action", "Guardian restricted an adapter"],
    ]);
    expect(alerts.map((alert) => alert.key)).toEqual([
      `ethereum:manager:${tx.hash}:0`,
      `ethereum:manager:${tx.hash}:2`,
    ]);
    expect(field(alerts[1], "Effect")).toBe("Adapter #1: funding disabled, recall enabled");
  });

  it("does not fold a Timelock call executed in the same transaction into a GuardianAction", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1);
    manager(guardianAction(tx, "pauseFunding()"), "FundingPausedSet", {paused: true});
    executed(manager(tx, "FundingOperatorSet", {operator: EV.stranger, enabled: true}), opId(1), EV.manager);
    const alerts = await run(managerEventsRule, ctx, tx);
    expect(summary(alerts)).toEqual([
      ["high", "manager.guardian-action", "Guardian paused funding"],
      ["critical", "manager.config", `Funding operator granted: ${EV.stranger}`],
    ]);
    expect(alerts[0]?.fields?.filter((entry) => entry.label === "Effect")).toHaveLength(1);
  });

  it("names unknown Guardian selectors instead of dropping the alert", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1).log(liquidityManagerAbi, EV.manager, "GuardianAction", {
      guardian: EV.guardian,
      selector: "0xdeadbeef",
    });
    manager(tx, "RecallPausedSet", {paused: true});
    const [alert] = await run(managerEventsRule, ctx, tx);
    expect(alert?.title).toBe("Guardian action 0xdeadbeef");
    expect(field(alert, "Function")).toBe("unknown selector 0xdeadbeef");
    expect(field(alert, "Effect")).toBe("Recall paused");
  });

  it("explains a (0, 0) Guardian budget reduction from the capacity the budget had before", async () => {
    const reduce = (n: number, signature: string, eventName: string, args: Record<string, unknown>) =>
      manager(guardianAction(new TxBuilder(n), signature), eventName, {capacity: 0n, rate: 0n, ...args});
    const aggregate = reduce(1, "reduceAggregateFundingBudget(uint256,uint256)", "AggregateFundingBudgetSet", {});
    const poolBudget = reduce(2, "reducePoolFundingBudget(address,uint256,uint256)", "PoolFundingBudgetSet", {
      pool: EV.pool,
    });
    const recall = reduce(3, "reduceRecallLimits(uint256,uint256,uint256)", "RecallLimitsSet", {maxRecallPerCall: 0n});
    // A non-zero reduction needs a configured budget: nothing to read.
    const partial = reduce(4, "reduceAggregateFundingBudget(uint256,uint256)", "AggregateFundingBudgetSet", {
      capacity: SAHARA("5"),
    });
    const budgets: Record<string, unknown> = {
      getAggregateFundingBudget: {capacity: SAHARA("20000000"), rate: SAHARA("10"), available: SAHARA("20000000")},
      getPoolFundingBudget: {capacity: 0n, rate: 0n, available: 0n},
      getRecallBudget: new Error("rpc down"),
    };
    const {client, reads} = evClient(({functionName}) => budgets[functionName]);
    const ctx = evContext({client});
    const alerts = await run(managerEventsRule, ctx, aggregate, poolBudget, recall, partial);
    expect(reads.map((read) => [read.functionName, read.args, read.blockNumber])).toEqual([
      ["getAggregateFundingBudget", [], aggregate.blockNumber - 1n],
      ["getPoolFundingBudget", [EV.pool], poolBudget.blockNumber - 1n],
      ["getRecallBudget", [], recall.blockNumber - 1n],
    ]);
    expect(summary(alerts)).toEqual([
      ["high", "manager.guardian-action", "Guardian reduced the aggregate funding budget"],
      ["high", "manager.guardian-action", "Guardian reduced a pool funding budget"],
      ["high", "manager.guardian-action", "Guardian reduced the recall limits"],
      ["high", "manager.guardian-action", "Guardian reduced the aggregate funding budget"],
    ]);
    const [configured, unconfigured, unknown, restricted] = alerts;
    // Configured before: the bucket stays initialized, so a restore starts empty; nothing to cancel.
    expect(field(configured, "Capacity before")).toBe("20,000,000 SAHARA");
    expect(configured?.note).toContain("a Timelock restore starts empty and refills at its rate");
    expect(configured?.note).not.toContain("cancel a queued first configuration");
    expect(field(unconfigured, "Capacity before")).toBe("0 SAHARA");
    expect(unconfigured?.note).toContain("leaves it unconfigured");
    expect(unconfigured?.note).toContain("cancel a queued first configuration");
    expect(field(unknown, "Capacity before")).toBe("unknown (read failed)");
    expect(unknown?.note).toContain("cancel a queued first configuration");
    expect(unknown?.note).toContain("a Timelock restore starts empty");
    expect(field(restricted, "Capacity before")).toBeUndefined();
    expect(restricted?.note).toBe("Guardian actions only restrict; undoing this needs a Timelock operation.");
    expect(ctx.log.warnings.map((entry) => entry.message)).toEqual([
      "events: cannot read the budget before a (0, 0) Guardian reduction",
    ]);
  });

  it("maps owner-path (Timelock) events to critical or high", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["GuardianSet", {previousGuardian: EV.guardian, newGuardian: EV.newGuardian}, "critical"],
      ["PoolSpecSet", {pool: EV.pool, spec: SPEC}, "critical"],
      ["PoolMigrationApprovalSet", {pool: EV.pool2, sourcePool: EV.pool}, "critical"],
      ["PoolMigrationApprovalSet", {pool: EV.pool2, sourcePool: zeroAddress}, "high"],
      ["AdapterRegistered", {adapterId: 3n, adapter: EV.stranger, pool: EV.pool2}, "critical"],
      ["AdapterReplaced", {adapterId: 1n, previousAdapter: EV.adapter, newAdapter: EV.stranger}, "critical"],
      ["ReservesMigrated", {to: EV.stranger, amount: SAHARA("5")}, "critical"],
      ["OwnershipTransferStarted", {previousOwner: EV.timelock, newOwner: EV.stranger}, "critical"],
      ["OwnershipTransferred", {previousOwner: EV.timelock, newOwner: EV.stranger}, "critical"],
      ["RecallOperatorSet", {operator: EV.recallOperator, enabled: true}, "critical"],
      ["RecallOperatorSet", {operator: EV.recallOperator, enabled: false}, "high"],
      ["FundingPausedSet", {paused: false}, "high"],
      ["RecallPausedSet", {paused: false}, "high"],
      ["MaxFundingPerCallSet", {maxFundingPerCall: SAHARA("10")}, "high"],
      ["AggregateFundingBudgetSet", {capacity: SAHARA("100"), rate: SAHARA("1")}, "high"],
      ["PoolFundingBudgetSet", {pool: EV.pool, capacity: SAHARA("100"), rate: SAHARA("1")}, "high"],
      ["RecallLimitsSet", {maxRecallPerCall: SAHARA("1"), capacity: SAHARA("100"), rate: SAHARA("1")}, "high"],
      ["AdapterStatusSet", {adapterId: 1n, fundingEnabled: true, recallEnabled: true}, "high"],
      ["TokenRecovered", {token: EV.otherToken, to: EV.stranger, amount: 7n}, "high"],
    ];
    const ctx = evContext();
    const txs = cases.map(([eventName, args], i) =>
      executed(manager(new TxBuilder(i + 1), eventName, args), opId(i), EV.manager),
    );
    const alerts = await run(managerEventsRule, ctx, ...txs);
    expect(alerts.map((alert) => alert.severity)).toEqual(cases.map(([, , severity]) => severity));
    expect(alerts.every((alert) => alert.rule === "manager.config")).toBe(true);
    expect(alerts.map((alert) => field(alert, "Timelock operation"))).toEqual(cases.map((_, i) => opId(i)));
    const spec = alerts[1];
    expect(spec?.title).toBe("Pool spec set for Pool");
    expect(field(spec, "Remote chain")).toBe(`bsc (${BSC_SELECTOR})`);
    expect(field(spec, "Remote token")).toBe(EV.otherToken);
    expect(field(spec, "Remote pools")).toBe(EV.stranger);
    expect(alerts[3]?.title).toBe("Migration approval of Pool 2 revoked");
  });

  it("folds the operator revocations of setGuardian into the GuardianSet alert", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1);
    manager(tx, "GuardianSet", {previousGuardian: EV.guardian, newGuardian: EV.newGuardian});
    manager(tx, "FundingOperatorSet", {operator: EV.newGuardian, enabled: false});
    manager(tx, "RecallOperatorSet", {operator: EV.newGuardian, enabled: false});
    executed(tx, opId(1), EV.manager);
    const alerts = await run(managerEventsRule, ctx, tx);
    expect(summary(alerts)).toEqual([["critical", "manager.config", `Manager Guardian set to ${EV.newGuardian}`]]);
    expect(alerts[0]?.fields?.filter((entry) => entry.label === "Also").map((entry) => entry.value)).toEqual([
      `Funding operator revoked: ${EV.newGuardian}`,
      `Recall operator revoked: ${EV.newGuardian}`,
    ]);
  });

  it("escalates owner-path events that no Timelock call produced", async () => {
    const tx = manager(new TxBuilder(1), "AdapterStatusSet", {
      adapterId: 1n,
      fundingEnabled: true,
      recallEnabled: true,
    });
    const ctx = evContext();
    const [alert] = await run(managerEventsRule, ctx, tx);
    expect(alert?.severity).toBe("critical");
    expect(field(alert, "Executed by")).toContain("not a Timelock operation");
    expect(alert?.note).toContain("outside the Timelock");

    // Without a resolved Timelock nothing can be concluded: the spec severity stands.
    const unknown = evContext({addresses: evAddresses({timelock: undefined})});
    const [plain] = await run(managerEventsRule, unknown, tx);
    expect(plain?.severity).toBe("high");
    expect(field(plain, "Executed by")).toContain("Timelock address not resolved");
  });

  it("only attributes a CallExecuted whose target is the Manager", async () => {
    const ctx = evContext();
    const tx = executed(manager(new TxBuilder(1), "FundingPausedSet", {paused: false}), opId(1), EV.pool);
    const [alert] = await run(managerEventsRule, ctx, tx);
    expect(alert?.severity).toBe("critical");
    expect(field(alert, "Timelock operation")).toBeUndefined();
  });

  it("ignores Manager-ABI events emitted by other contracts and survives undecodable logs", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1)
      .log(liquidityManagerAbi, EV.token, "OwnershipTransferred", {previousOwner: EV.timelock, newOwner: EV.stranger})
      .log(liquidityManagerAbi, EV.pool, "FundingPausedSet", {paused: true});
    expect(await run(managerEventsRule, ctx, tx)).toEqual([]);

    const broken = new TxBuilder(2).log(tokenPoolAbi, EV.manager, "RateLimitAdminSet", {rateLimitAdmin: EV.stranger});
    manager(broken, "FundingPausedSet", {paused: true});
    executed(broken, opId(2), EV.manager);
    const alerts = await run(managerEventsRule, ctx, broken);
    expect(summary(alerts)).toEqual([["high", "manager.config", "Funding paused"]]);
    expect(ctx.log.warnings.map((entry) => entry.message)).toEqual(["events: cannot decode Manager log"]);
  });
});

describe("controllerEventsRule", () => {
  it("requests ProposalCancelled and PoolLockedDown from the controller only", () => {
    expect(controllerEventsRule.filters(evContext())).toEqual([
      {
        address: EV.controller,
        topics: [
          [
            topic(guardianControllerAbi, "ProposalCancelled").toLowerCase(),
            topic(guardianControllerAbi, "PoolLockedDown").toLowerCase(),
          ],
        ],
      },
    ]);
    expect(controllerEventsRule.filters(evContext({addresses: evAddresses({controller: undefined})}))).toEqual([]);
  });

  it("describes a cancelled proposal from the timelock store", async () => {
    const ctx = evContext();
    const id = opId(1);
    ctx.store.set("timelock:ethereum", {
      ops: {
        [id]: {
          id,
          calls: [],
          predecessor: pad("0x00", {size: 32}),
          salt: null,
          delay: 172800n,
          scheduledAt: 1_700_000_000,
          readyAt: 1_700_172_800,
          txHash: opId(99),
          summary: "LiquidityManager.setRecallOperator(operator=0xabc…, enabled=true)",
          severity: "critical",
          protected: false,
          status: "cancelled",
        },
      },
    });
    const tx = new TxBuilder(1).log(guardianControllerAbi, EV.controller, "ProposalCancelled", {
      id,
      guardian: EV.guardian,
    });
    const [alert] = await run(controllerEventsRule, ctx, tx);
    expect(alert).toMatchObject({
      severity: "high",
      rule: "controller.proposal-cancelled",
      title: "Guardian cancelled Timelock operation: LiquidityManager.setRecallOperator",
      key: `ethereum:controller:${tx.hash}:0`,
    });
    expect(field(alert, "Operation id")).toBe(id);
    expect(field(alert, "Operation")).toContain("setRecallOperator(operator=");
    expect(field(alert, "Was executable at")).toBe("2023-11-16 22:13:20 UTC");
  });

  it("still alerts on a cancelled proposal the monitor never saw", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1).log(guardianControllerAbi, EV.controller, "ProposalCancelled", {
      id: opId(5),
      guardian: EV.guardian,
    });
    const [alert] = await run(controllerEventsRule, ctx, tx);
    expect(alert?.title).toBe("Guardian cancelled a Timelock operation");
    expect(field(alert, "Operation")).toContain("not tracked");
  });

  it("raises one critical per PoolLockedDown and folds the pool's rate-limit events into it", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1);
    pool(tx, "ConfigChanged", {config: LOCKDOWN});
    pool(tx, "ConfigChanged", {config: LOCKDOWN});
    pool(tx, "ChainConfigured", {
      remoteChainSelector: BSC_SELECTOR,
      outboundRateLimiterConfig: LOCKDOWN,
      inboundRateLimiterConfig: LOCKDOWN,
    });
    tx.log(guardianControllerAbi, EV.controller, "PoolLockedDown", {
      pool: EV.pool,
      remoteChainSelector: BSC_SELECTOR,
      guardian: EV.guardian,
    });
    const alerts = await runAll(ctx, tx);
    expect(summary(alerts)).toEqual([
      ["critical", "controller.lockdown", "Bridge halted: Guardian locked down Pool for bsc"],
    ]);
    expect(field(alerts[0], "Outbound limit")).toBe("capacity 0 SAHARA, rate 0 SAHARA/s (locked down)");
    expect(alerts[0]?.note).toContain("Timelock operation");
    expect(ctx.log.warnings).toEqual([]);
  });

  it("ignores controller events emitted by other addresses", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1).log(guardianControllerAbi, EV.stranger, "ProposalCancelled", {
      id: opId(1),
      guardian: EV.guardian,
    });
    expect(await run(controllerEventsRule, ctx, tx)).toEqual([]);
  });
});

describe("poolEventsRule", () => {
  it("requests only the handled pool events from every watched pool", () => {
    const [filter, ...rest] = poolEventsRule.filters(evContext());
    expect(rest).toEqual([]);
    expect(filter?.address).toEqual([EV.pool, EV.pool2]);
    const topics = filter?.topics?.[0] as Hex[];
    expect(topics).toHaveLength(16);
    expect(topics).toContain(topic(tokenPoolAbi, "LiquidityAdded").toLowerCase());
    expect(topics).not.toContain(topic(tokenPoolAbi, "LockedOrBurned").toLowerCase());
    expect(topics).not.toContain(topic(tokenPoolAbi, "ReleasedOrMinted").toLowerCase());
    expect(poolEventsRule.filters(evContext({addresses: evAddresses({pools: []})}))).toEqual([]);
  });

  it("ignores liquidity moved by the pool's adapter and alerts on anyone else", async () => {
    const ctx = evContext();
    const byAdapter = pool(new TxBuilder(1), "LiquidityAdded", {provider: EV.adapter, amount: SAHARA("10")});
    const added = pool(new TxBuilder(2), "LiquidityAdded", {provider: EV.stranger, amount: SAHARA("10")});
    const removed = pool(new TxBuilder(3), "LiquidityRemoved", {provider: EV.stranger, amount: SAHARA("3")});
    // Adapter #1 is registered for Pool, not for Pool 2.
    const wrongPool = pool(new TxBuilder(4), "LiquidityRemoved", {provider: EV.adapter, amount: SAHARA("1")}, EV.pool2);
    const alerts = await run(poolEventsRule, ctx, byAdapter, added, removed, wrongPool);
    expect(summary(alerts)).toEqual([
      ["critical", "pool.liquidity", `Liquidity added to Pool by ${EV.stranger}, not its adapter`],
      ["critical", "pool.liquidity", `Liquidity removed from Pool by ${EV.stranger}, not its adapter`],
      ["critical", "pool.liquidity", "Liquidity removed from Pool 2 by Adapter #1, not its adapter"],
    ]);
    expect(field(alerts[0], "Amount")).toBe("10 SAHARA");
    expect(field(alerts[2], "Registered adapter")).toBe(`Adapter #2 ${EV.adapter2}`);
  });

  it("rates liquidity moved by the expected rebalancer of a pool without an adapter as high", async () => {
    const rebalancer = evAddr(0x34);
    const ethereum = evConfig.chains.ethereum!;
    const config = {
      ...evConfig,
      chains: {...evConfig.chains, ethereum: {...ethereum, expected: {...ethereum.expected, rebalancer}}},
    };
    // Before the handover: no adapter for Pool, Adapter #2 for Pool 2.
    const addresses = evAddresses({
      adapters: [{id: 2n, adapter: EV.adapter2, pool: EV.pool2, fundingEnabled: true, recallEnabled: true}],
    });
    const ctx = evContext({config, addresses});
    const byRebalancer = pool(new TxBuilder(1), "LiquidityAdded", {provider: rebalancer, amount: SAHARA("10")});
    const byStranger = pool(new TxBuilder(2), "LiquidityRemoved", {provider: EV.stranger, amount: SAHARA("3")});
    const removed = {provider: rebalancer, amount: SAHARA("1")};
    const withAdapter = pool(new TxBuilder(3), "LiquidityRemoved", removed, EV.pool2);
    const byAdapter = pool(new TxBuilder(4), "LiquidityAdded", {provider: EV.adapter2, amount: SAHARA("1")}, EV.pool2);
    const alerts = await run(poolEventsRule, ctx, byRebalancer, byStranger, withAdapter, byAdapter);
    expect(summary(alerts)).toEqual([
      ["high", "pool.liquidity", `Liquidity added to Pool by the expected rebalancer ${rebalancer}`],
      ["critical", "pool.liquidity", `Liquidity removed from Pool by ${EV.stranger}, not its adapter`],
      ["critical", "pool.liquidity", `Liquidity removed from Pool 2 by ${rebalancer}, not its adapter`],
    ]);
    expect(field(alerts[0], "Registered adapter")).toBe("none");
    expect(field(alerts[0], "Amount")).toBe("10 SAHARA");
    expect(alerts[0]?.note).toContain("No adapter is registered for this pool yet");
    expect(field(alerts[1], "Registered adapter")).toBe("none");
    expect(field(alerts[2], "Registered adapter")).toBe(`Adapter #2 ${EV.adapter2}`);

    // With the default expectation ("adapter") nothing resolves before the handover: every provider pages.
    const plain = evContext({addresses});
    const [alert] = await run(poolEventsRule, plain, byRebalancer);
    expect(alert?.severity).toBe("critical");
  });

  it("accepts liquidity moved by an adapter the Manager funded through in the same transaction", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1);
    pool(tx, "LiquidityAdded", {provider: EV.oldAdapter, amount: SAHARA("10")});
    manager(tx, "Funded", {adapterId: 1n, pool: EV.pool, operator: EV.fundingOperator, adapter: EV.oldAdapter,
      amount: SAHARA("10")});
    expect(await run(poolEventsRule, ctx, tx)).toEqual([]);
  });

  it("alerts critical on authority and remote-configuration changes with the Timelock operation", async () => {
    const ctx = evContext();
    const txs = [
      executed(
        pool(new TxBuilder(1), "RebalancerSet", {oldRebalancer: EV.adapter, newRebalancer: EV.stranger}),
        opId(1),
        EV.pool,
      ),
      executed(pool(new TxBuilder(2), "RateLimitAdminSet", {rateLimitAdmin: EV.stranger}), opId(2), EV.pool),
      executed(
        pool(new TxBuilder(3), "RouterUpdated", {oldRouter: EV.router, newRouter: EV.stranger}),
        opId(3),
        EV.pool,
      ),
      executed(pool(new TxBuilder(4), "ChainRemoved", {remoteChainSelector: BSC_SELECTOR}), opId(4), EV.pool),
      executed(pool(new TxBuilder(5), "RemotePoolRemoved", {remoteChainSelector: BSC_SELECTOR,
        remotePoolAddress: encodedAddress(EV.stranger)}), opId(5), EV.pool),
      executed(pool(new TxBuilder(6), "OwnershipTransferRequested", {from: EV.timelock, to: EV.stranger}), opId(6),
        EV.pool),
      pool(new TxBuilder(7), "OwnershipTransferred", {from: EV.timelock, to: EV.stranger}),
      executed(
        pool(new TxBuilder(8), "LiquidityTransferred", {from: EV.pool2, amount: SAHARA("42")}),
        opId(8),
        EV.pool,
      ),
    ];
    const alerts = await run(poolEventsRule, ctx, ...txs);
    expect(summary(alerts)).toEqual([
      ["critical", "pool.config", `Rebalancer of Pool changed to ${EV.stranger}`],
      ["critical", "pool.config", `Rate limit admin of Pool changed to ${EV.stranger}`],
      ["critical", "pool.config", `Router of Pool changed to ${EV.stranger}`],
      ["critical", "pool.config", "Pool removed remote chain bsc"],
      ["critical", "pool.config", "Remote pool removed from Pool for bsc"],
      ["critical", "pool.config", `Ownership transfer of Pool requested to ${EV.stranger}`],
      ["critical", "pool.config", `Ownership of Pool transferred to ${EV.stranger}`],
      ["critical", "pool.config", "42 SAHARA transferred into Pool from Pool 2"],
    ]);
    expect(field(alerts[0], "Timelock operation")).toBe(opId(1));
    expect(field(alerts[6], "Executed by")).toContain("not a Timelock operation");
    expect(field(alerts[4], "Remote pool")).toBe(EV.stranger);
  });

  it("reports one high alert per rate-limit change (ConfigChanged folded into ChainConfigured)", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1);
    pool(tx, "ConfigChanged", {config: LIMIT});
    pool(tx, "ConfigChanged", {config: LIMIT});
    pool(tx, "ChainConfigured", {remoteChainSelector: BSC_SELECTOR, outboundRateLimiterConfig: LIMIT,
      inboundRateLimiterConfig: LIMIT});
    executed(tx, opId(1), EV.pool);
    const lockdownByTimelock = new TxBuilder(2);
    pool(lockdownByTimelock, "ChainConfigured", {remoteChainSelector: BSC_SELECTOR, outboundRateLimiterConfig: LOCKDOWN,
      inboundRateLimiterConfig: LOCKDOWN});
    const disabled = new TxBuilder(3);
    pool(disabled, "ChainConfigured", {remoteChainSelector: BSC_SELECTOR,
      outboundRateLimiterConfig: {isEnabled: false, capacity: 0n, rate: 0n}, inboundRateLimiterConfig: LIMIT});
    const orphan = pool(new TxBuilder(4), "ConfigChanged", {config: LIMIT});
    const alerts = await run(poolEventsRule, ctx, tx, lockdownByTimelock, disabled, orphan);
    expect(summary(alerts)).toEqual([
      ["high", "pool.rate-limits", "Rate limits of Pool changed for bsc"],
      ["high", "pool.rate-limits", "Rate limits of Pool set to lockdown (bridge halted) for bsc"],
      ["high", "pool.rate-limits", "Rate limits of Pool disabled (unlimited) for bsc"],
      ["high", "pool.rate-limits", "Rate limits of Pool changed"],
    ]);
    expect(alerts[0]?.key).toBe(`ethereum:pool:${tx.hash}:2`);
    expect(field(alerts[0], "Outbound limit")).toBe("capacity 1,000,000 SAHARA, rate 10 SAHARA/s");
    expect(field(alerts[0], "Timelock operation")).toBe(opId(1));
    expect(field(alerts[3], "New limit")).toBe("capacity 1,000,000 SAHARA, rate 10 SAHARA/s");
  });

  it("only folds rate-limit events into a lockdown of the same pool and chain", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1);
    pool(tx, "ChainConfigured", {remoteChainSelector: BSC_SELECTOR, outboundRateLimiterConfig: LIMIT,
      inboundRateLimiterConfig: LIMIT}, EV.pool2);
    tx.log(guardianControllerAbi, EV.controller, "PoolLockedDown", {pool: EV.pool, remoteChainSelector: BSC_SELECTOR,
      guardian: EV.guardian});
    const alerts = await run(poolEventsRule, ctx, tx);
    expect(summary(alerts)).toEqual([["high", "pool.rate-limits", "Rate limits of Pool 2 changed for bsc"]]);
  });

  it("reports applyChainUpdates once per added chain, with its remote pools", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1);
    pool(tx, "RemotePoolAdded", {remoteChainSelector: BSC_SELECTOR, remotePoolAddress: encodedAddress(EV.stranger)});
    pool(tx, "ChainAdded", {remoteChainSelector: BSC_SELECTOR, remoteToken: encodedAddress(EV.otherToken),
      outboundRateLimiterConfig: LIMIT, inboundRateLimiterConfig: LIMIT});
    executed(tx, opId(1), EV.pool);
    const single = pool(new TxBuilder(2), "RemotePoolAdded", {remoteChainSelector: BSC_SELECTOR,
      remotePoolAddress: encodedAddress(EV.unwatchedPool)});
    const alerts = await run(poolEventsRule, ctx, tx, single);
    expect(summary(alerts)).toEqual([
      ["critical", "pool.config", "Pool added remote chain bsc"],
      ["critical", "pool.config", "Remote pool added to Pool for bsc"],
    ]);
    expect(field(alerts[0], "Remote pool")).toBe(EV.stranger);
    expect(field(alerts[0], "Remote token")).toBe(EV.otherToken);
    expect(field(alerts[0], "Timelock operation")).toBe(opId(1));
    expect(field(alerts[1], "Remote pool")).toBe(EV.unwatchedPool);
  });

  it("reports allow-list changes as high", async () => {
    const ctx = evContext();
    const tx = pool(new TxBuilder(1), "AllowListAdd", {sender: EV.stranger});
    const alerts = await run(poolEventsRule, ctx, tx);
    expect(summary(alerts)).toEqual([["high", "pool.allowlist", `${EV.stranger} added to the allow list of Pool`]]);
  });

  it("leaves bridge legs to flows and ignores unwatched pools and other contracts", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1);
    pool(tx, "OutboundRateLimitConsumed", {remoteChainSelector: BSC_SELECTOR, token: EV.token, amount: SAHARA("1")});
    pool(tx, "LockedOrBurned", {remoteChainSelector: BSC_SELECTOR, token: EV.token, sender: EV.onRamp,
      amount: SAHARA("1")});
    pool(tx, "ReleasedOrMinted", {remoteChainSelector: BSC_SELECTOR, token: EV.token, sender: EV.offRamp,
      recipient: EV.stranger, amount: SAHARA("1")});
    pool(tx, "RebalancerSet", {oldRebalancer: EV.adapter, newRebalancer: EV.stranger}, EV.unwatchedPool);
    tx.log(routerAbi, EV.router, "OwnershipTransferred", {from: EV.stranger, to: EV.stranger});
    expect(await run(poolEventsRule, ctx, tx)).toEqual([]);
    expect(ctx.log.warnings).toEqual([]);
  });

  it("warns about an undecodable pool log and keeps going", async () => {
    const ctx = evContext();
    const tx = pool(new TxBuilder(1), "AllowListAdd", {sender: EV.stranger});
    const [log] = tx.logs;
    if (!log) throw new Error("fixture");
    log.data = "0x1234";
    pool(tx, "AllowListRemove", {sender: EV.stranger});
    const alerts = await run(poolEventsRule, ctx, tx);
    expect(summary(alerts)).toEqual([["high", "pool.allowlist", `${EV.stranger} removed from the allow list of Pool`]]);
    expect(ctx.log.warnings.map((entry) => entry.message)).toEqual(["events: cannot process pool log"]);
  });
});

describe("tokenEventsRule", () => {
  it("requests only Paused, Unpaused and OwnershipTransferred", () => {
    expect(tokenEventsRule.filters(evContext())).toEqual([
      {
        address: EV.token,
        topics: [
          [
            topic(saharaTokenAbi, "Paused").toLowerCase(),
            topic(saharaTokenAbi, "Unpaused").toLowerCase(),
            topic(saharaTokenAbi, "OwnershipTransferred").toLowerCase(),
          ],
        ],
      },
    ]);
  });

  it("alerts on pause (critical), unpause (high) and ownership transfer (critical)", async () => {
    const ctx = evContext();
    const paused = new TxBuilder(1).log(saharaTokenAbi, EV.token, "Paused", {account: EV.timelock});
    executed(paused, opId(1), EV.token);
    const unpaused = new TxBuilder(2).log(saharaTokenAbi, EV.token, "Unpaused", {account: EV.timelock});
    const owner = new TxBuilder(3).log(saharaTokenAbi, EV.token, "OwnershipTransferred", {
      previousOwner: EV.timelock,
      newOwner: EV.stranger,
    });
    const alerts = await run(tokenEventsRule, ctx, paused, unpaused, owner);
    expect(summary(alerts)).toEqual([
      ["critical", "token.paused", "SAHARA token paused: transfers and bridge settlement halted"],
      ["high", "token.unpaused", "SAHARA token unpaused"],
      ["critical", "token.owner", `SAHARA token ownership transferred to ${EV.stranger}`],
    ]);
    expect(field(alerts[0], "Timelock operation")).toBe(opId(1));
    expect(alerts[0]?.key).toBe(`ethereum:token:${paused.hash}:0`);
  });

  it("ignores transfers and the same events from other contracts", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1)
      .log(saharaTokenAbi, EV.token, "Transfer", {from: EV.manager, to: EV.adapter, value: SAHARA("1")})
      .log(saharaTokenAbi, EV.token, "Approval", {owner: EV.adapter, spender: EV.pool, value: SAHARA("1")})
      .log(liquidityManagerAbi, EV.manager, "OwnershipTransferred", {previousOwner: EV.timelock, newOwner: EV.stranger})
      .log(saharaTokenAbi, EV.otherToken, "Paused", {account: EV.stranger});
    expect(await run(tokenEventsRule, ctx, tx)).toEqual([]);
    expect(ctx.log.warnings).toEqual([]);
  });
});

describe("registryEventsRule", () => {
  it("restricts the filter to the SAHARA token (topic1)", () => {
    const [filter] = registryEventsRule.filters(evContext());
    expect(filter?.address).toBe(EV.registry);
    expect(filter?.topics?.[0]).toEqual([
      topic(tokenAdminRegistryAbi, "PoolSet").toLowerCase(),
      topic(tokenAdminRegistryAbi, "AdministratorTransferRequested").toLowerCase(),
      topic(tokenAdminRegistryAbi, "AdministratorTransferred").toLowerCase(),
    ]);
    expect(filter?.topics?.[1]).toBe(pad(EV.token.toLowerCase() as Hex, {size: 32}));
  });

  it("alerts critical on the token's registry changes and ignores other tokens", async () => {
    const ctx = evContext();
    const poolSet = new TxBuilder(1).log(tokenAdminRegistryAbi, EV.registry, "PoolSet", {
      token: EV.token,
      previousPool: EV.pool,
      newPool: EV.pool2,
    });
    executed(poolSet, opId(1), EV.registry);
    const removed = new TxBuilder(2).log(tokenAdminRegistryAbi, EV.registry, "PoolSet", {
      token: EV.token,
      previousPool: EV.pool2,
      newPool: zeroAddress,
    });
    const requested = new TxBuilder(3).log(tokenAdminRegistryAbi, EV.registry, "AdministratorTransferRequested", {
      token: EV.token,
      currentAdmin: EV.timelock,
      newAdmin: EV.stranger,
    });
    const transferred = new TxBuilder(4).log(tokenAdminRegistryAbi, EV.registry, "AdministratorTransferred", {
      token: EV.token,
      newAdmin: EV.stranger,
    });
    const otherToken = new TxBuilder(5).log(tokenAdminRegistryAbi, EV.registry, "PoolSet", {
      token: EV.otherToken,
      previousPool: zeroAddress,
      newPool: EV.stranger,
    });
    const alerts = await run(registryEventsRule, ctx, poolSet, removed, requested, transferred, otherToken);
    expect(summary(alerts)).toEqual([
      ["critical", "registry.pool", "Registry now maps SAHARA to Pool 2"],
      ["critical", "registry.pool", "Registry pool of SAHARA removed: bridging disabled"],
      ["critical", "registry.admin", `Registry admin transfer of SAHARA requested to ${EV.stranger}`],
      ["critical", "registry.admin", `Registry admin of SAHARA is now ${EV.stranger}`],
    ]);
    expect(field(alerts[0], "Timelock operation")).toBe(opId(1));
    expect(field(alerts[0], "Previous pool")).toBe(`Pool ${EV.pool}`);
  });
});

describe("routerEventsRule", () => {
  const selectorTopic = (selector: bigint) => pad(toHex(selector), {size: 32});
  const rampTopics = ["OnRampSet", "OffRampAdded", "OffRampRemoved"].map((name) =>
    topic(routerAbi, name).toLowerCase(),
  );
  const ownerTopics = ["OwnershipTransferRequested", "OwnershipTransferred"].map((name) =>
    topic(routerAbi, name).toLowerCase(),
  );

  it("restricts ramp events to the remote selector of the counterpart chain", () => {
    expect(routerEventsRule.filters(evContext())).toEqual([
      {address: EV.router, topics: [rampTopics, [selectorTopic(BSC_SELECTOR)]]},
      {address: EV.router, topics: [ownerTopics]},
    ]);
    expect(routerEventsRule.filters(evContext({name: "bsc"}))).toEqual([
      {address: EV.router, topics: [rampTopics, [selectorTopic(ETH_SELECTOR)]]},
      {address: EV.router, topics: [ownerTopics]},
    ]);
    expect(routerEventsRule.filters(evContext({addresses: evAddresses({router: undefined})}))).toEqual([]);
  });

  it("alerts on remote-lane ramp changes once per transaction and ignores other lanes", async () => {
    const ctx = evContext();
    const upgrade = new TxBuilder(1)
      .log(routerAbi, EV.router, "OnRampSet", {destChainSelector: BSC_SELECTOR, onRamp: EV.onRamp})
      .log(routerAbi, EV.router, "OffRampRemoved", {sourceChainSelector: BSC_SELECTOR, offRamp: EV.stranger})
      .log(routerAbi, EV.router, "OffRampAdded", {sourceChainSelector: BSC_SELECTOR, offRamp: EV.offRamp})
      .log(routerAbi, EV.router, "OffRampAdded", {sourceChainSelector: OTHER_SELECTOR, offRamp: EV.stranger});
    const onRampOnly = new TxBuilder(2).log(routerAbi, EV.router, "OnRampSet", {
      destChainSelector: BSC_SELECTOR,
      onRamp: EV.onRamp,
    });
    const otherLane = new TxBuilder(3).log(routerAbi, EV.router, "OffRampAdded", {
      sourceChainSelector: OTHER_SELECTOR,
      offRamp: EV.stranger,
    });
    const otherRouter = new TxBuilder(4).log(routerAbi, EV.stranger, "OffRampAdded", {
      sourceChainSelector: BSC_SELECTOR,
      offRamp: EV.stranger,
    });
    const alerts = await run(routerEventsRule, ctx, upgrade, onRampOnly, otherLane, otherRouter);
    expect(summary(alerts)).toEqual([
      ["high", "router.ramps", "Chainlink changed the OffRamps authorised to release pool liquidity"],
      ["high", "router.ramps", "Chainlink changed the OnRamp for bsc"],
    ]);
    expect(alerts[0]?.fields).toEqual([
      {label: "OnRamp set (to bsc)", value: EV.onRamp, code: true},
      {label: "OffRamp removed (from bsc)", value: EV.stranger, code: true},
      {label: "OffRamp added (from bsc)", value: EV.offRamp, code: true},
    ]);
    expect(alerts[0]?.key).toBe(`ethereum:router:${upgrade.hash}:0`);
  });

  it("alerts high on Router ownership transfers", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1).log(routerAbi, EV.router, "OwnershipTransferRequested", {
      from: EV.stranger,
      to: EV.onRamp,
    });
    const alerts = await run(routerEventsRule, ctx, tx);
    expect(summary(alerts)).toEqual([["high", "router.owner", `Router ownership transfer requested to ${EV.onRamp}`]]);
  });

  it("learns the remote selector from the Manager pool spec when no other chain is configured", async () => {
    const reads = evClient(({functionName, args}) => {
      if (functionName !== "getPoolSpec") return new Error(`unexpected ${functionName}`);
      return args[0] === EV.pool ? [SPEC, true] : [SPEC, false];
    });
    const ctx = evContext({config: evSingleChainConfig, client: reads.client});
    expect(remoteSelectors(ctx)).toEqual(new Set());
    // No selector known: an empty topic OR-array would match every lane, so only ownership is watched.
    expect(routerEventsRule.filters(ctx)).toEqual([{address: EV.router, topics: [ownerTopics]}]);

    await routerEventsRule.onLogs(ctx, [], RANGE);
    expect(reads.reads.map((read) => [read.functionName, read.args[0], read.blockNumber])).toEqual([
      ["getPoolSpec", EV.pool, RANGE.to],
      ["getPoolSpec", EV.pool2, RANGE.to],
    ]);
    expect(remoteSelectors(ctx)).toEqual(new Set([BSC_SELECTOR]));
    expect(routerEventsRule.filters(ctx)[0]).toEqual({
      address: EV.router,
      topics: [rampTopics, [selectorTopic(BSC_SELECTOR)]],
    });

    // Read once per pool; a later PoolSpecSet seen by the Manager rule updates the set.
    await routerEventsRule.onLogs(ctx, [], RANGE);
    expect(reads.reads).toHaveLength(2);
    const spec = executed(manager(new TxBuilder(1), "PoolSpecSet", {pool: EV.pool2, spec: {...SPEC,
      remoteChainSelector: OTHER_SELECTOR}}), opId(1), EV.manager);
    await managerEventsRule.onLogs(ctx, allLogs(spec), RANGE);
    expect(remoteSelectors(ctx)).toEqual(new Set([BSC_SELECTOR, OTHER_SELECTOR]));
  });

  it("keeps working when the pool spec cannot be read", async () => {
    const reads = evClient(() => new Error("execution reverted"));
    const ctx = evContext({config: evSingleChainConfig, client: reads.client});
    const tx = new TxBuilder(1).log(routerAbi, EV.router, "OwnershipTransferred", {from: EV.stranger, to: EV.onRamp});
    const alerts = await run(routerEventsRule, ctx, tx);
    expect(summary(alerts)).toEqual([["high", "router.owner", `Router ownership transferred to ${EV.onRamp}`]]);
    expect(ctx.log.warnings.length).toBe(2);
  });
});

describe("event rules together", () => {
  it("alert once per log: only the owning rule reports a shared topic0", async () => {
    const ctx = evContext();
    const tx = new TxBuilder(1)
      .log(liquidityManagerAbi, EV.manager, "OwnershipTransferStarted", {previousOwner: EV.timelock,
        newOwner: EV.stranger})
      .log(saharaTimelockAbi, EV.timelock, "CallExecuted", {id: opId(1), index: 0n, target: EV.manager, value: 0n,
        data: "0x"})
      .log(saharaTokenAbi, EV.token, "OwnershipTransferred", {previousOwner: EV.timelock, newOwner: EV.stranger})
      .log(saharaTimelockAbi, EV.timelock, "CallExecuted", {id: opId(1), index: 1n, target: EV.token, value: 0n,
        data: "0x"})
      .log(tokenPoolAbi, EV.pool, "OwnershipTransferRequested", {from: EV.timelock, to: EV.stranger})
      .log(saharaTimelockAbi, EV.timelock, "CallExecuted", {id: opId(1), index: 2n, target: EV.pool, value: 0n,
        data: "0x"});
    const alerts = await runAll(ctx, tx);
    expect(summary(alerts)).toEqual([
      ["critical", "manager.config", `Manager ownership transfer started to ${EV.stranger}`],
      ["critical", "pool.config", `Ownership transfer of Pool requested to ${EV.stranger}`],
      ["critical", "token.owner", `SAHARA token ownership transferred to ${EV.stranger}`],
    ]);
    // Numbered from 1 with the batch length, as "Call N/M" in timelock.executed; the first call is numbered too.
    expect(field(alerts[0], "Timelock operation (call 1/3)")).toBe(opId(1));
    expect(field(alerts[1], "Timelock operation (call 3/3)")).toBe(opId(1));
    expect(field(alerts[2], "Timelock operation (call 2/3)")).toBe(opId(1));
    expect(new Set(alerts.map((alert) => alert.key)).size).toBe(3);
    expect(ctx.log.warnings).toEqual([]);
  });

  it("uses unique rule ids", () => {
    expect(eventRules.map((rule) => rule.id)).toEqual(["manager", "controller", "pool", "token", "registry", "router"]);
  });
});
