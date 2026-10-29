import {encodeErrorResult, zeroAddress} from "viem";
import {describe, expect, it} from "vitest";

import {tokenPoolAbi} from "../src/abi/external.ts";
import {liquidityManagerAbi} from "../src/abi/generated.ts";
import {
  adapterStateRule,
  controllerStateRule,
  inventoryStateRule,
  managerStateRule,
  poolStateRule,
  registryStateRule,
  routerStateRule,
  stateRules,
  timelockStateRule,
  tokenStateRule,
} from "../src/rules/state.ts";
import {createStore} from "../src/store.ts";
import type {Alert} from "../src/types.ts";
import {
  A,
  BLOCK,
  BSC,
  bucket,
  deployment,
  addMigrationTarget,
  encodedAddress,
  expectedConfig,
  grant,
  key,
  lc,
  pool,
  revoke,
  ROLE,
  runRules,
  stateContext,
  tokens,
  type Deployment,
} from "./helpers/state-deployment.ts";

const P = lc(A.pool);

/** Runs every state rule against the model and returns key -> severity. */
async function run(model: Deployment, opts: Parameters<typeof stateContext>[1] = {}) {
  const {ctx, reads} = stateContext(model, opts);
  const result = await runRules(ctx);
  return {...result, reads, ctx};
}

function find(conditions: Alert[], wanted: string): Alert {
  const alert = conditions.find((condition) => condition.key === wanted);
  if (!alert) throw new Error(`no condition ${wanted}`);
  return alert;
}

describe("state rules: correctly configured deployment", () => {
  it("raises nothing and reads only at the given block", async () => {
    const {keys, reads} = await run(deployment());
    expect(keys).toEqual({});
    // The fake throws for any read at another block (which would surface as read-failed above).
    expect(reads.length).toBeGreaterThan(40);
  });

  it("exposes the rule ids the daemon syncs", () => {
    expect(stateRules.map((rule) => rule.id)).toEqual([
      "state-token",
      "state-registry",
      "state-pool",
      "state-manager",
      "state-adapter",
      "state-inventory",
      "state-router",
      "state-timelock",
      "state-controller",
    ]);
  });

  it("returns human-readable snapshots", async () => {
    const {snapshots} = await run(deployment());
    expect(snapshots["state-token"]).toEqual({"Token owner": `Timelock ${A.timelock}`, "Token paused": "no"});
    expect(snapshots["state-registry"]).toMatchObject({
      "Registry administrator": `Timelock ${A.timelock}`,
      "Registry pending administrator": "none (address(0))",
      "Registry pool": `Pool ${A.pool}`,
    });
    expect(snapshots["state-pool"]).toMatchObject({
      "Pool owner": `Timelock ${A.timelock}`,
      "Pool rebalancer": `Adapter #1 ${A.adapter}`,
      "Pool rateLimitAdmin": `GuardianController ${A.controller}`,
      "Pool supported chains": "bsc",
      "Pool remote token (bsc)": A.remoteToken,
      "Pool remote pools (bsc)": A.remotePool,
      "Pool outbound rate limit (bsc)":
        "enabled, capacity 1,000,000 SAHARA, rate 100 SAHARA/s, available 1,000,000 SAHARA",
    });
    expect(snapshots["state-manager"]).toMatchObject({
      "Manager pending owner": "none (address(0))",
      "Funding paused": "no",
      "verifyHandover()": "ok",
      "verifyAdapter(#1)": "ok",
      "Aggregate funding budget": "10,000,000 SAHARA of 10,000,000 SAHARA (refill 10 SAHARA/s)",
      "Funding budget of Pool": "9,000,000 SAHARA of 10,000,000 SAHARA (refill 10 SAHARA/s)",
      "Adapter #1 (Pool)": "funding on, recall on",
    });
    expect(snapshots["state-inventory"]).toEqual({
      "Manager balance": "100,000,000 SAHARA",
      "Pool balance": "8,000,000 SAHARA",
      "Pool thresholds": "minimum 1,000,000 SAHARA, trigger 5,000,000 SAHARA, target 10,000,000 SAHARA",
    });
    expect(snapshots["state-router"]).toEqual({
      "Router OnRamp to bsc": A.onRamp,
      "Router OffRamps from bsc": A.offRamp,
    });
    expect(snapshots["state-timelock"]).toMatchObject({
      "Timelock delay": "2d",
      "GuardianController CANCELLER_ROLE": "yes",
      "Timelock PROPOSER holders": `Governance Safe ${A.safe}`,
    });
    expect(snapshots["state-controller"]).toEqual({
      "GuardianController MANAGER()": `Manager ${A.manager}`,
      "GuardianController TIMELOCK()": `Timelock ${A.timelock}`,
    });
  });
});

describe("state-token / state-registry", () => {
  it("token paused", async () => {
    const model = deployment();
    model.token.paused = true;
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-token", "paused")]: "critical"});
    expect(find(conditions, key("state-token", "paused")).title).toBe("SAHARA token is paused");
  });

  it("token owner changed also fails verifyHandover", async () => {
    const model = deployment();
    model.token.owner = A.stranger;
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({
      [key("state-token", "owner")]: "critical",
      [key("state-manager", "verify-handover")]: "critical",
    });
    expect(find(conditions, key("state-manager", "verify-handover")).title).toBe(
      "verifyHandover() reverts: TokenOwnerMismatch",
    );
  });

  it("registry admin transfer pending", async () => {
    const model = deployment();
    model.registry.pendingAdministrator = A.stranger;
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({
      [key("state-registry", "pending-admin")]: "critical",
      [key("state-manager", "verify-handover")]: "critical",
    });
    const handover = find(conditions, key("state-manager", "verify-handover"));
    expect(handover.fields?.[0]?.value).toBe(`RegistryAdminTransferPending(pendingAdministrator = ${A.stranger})`);
  });

  it("registry administrator changed", async () => {
    const model = deployment();
    model.registry.administrator = A.stranger;
    const {keys} = await run(model);
    expect(keys).toEqual({
      [key("state-registry", "admin")]: "critical",
      [key("state-manager", "verify-handover")]: "critical",
    });
  });

  it("registry maps the token to no pool", async () => {
    const model = deployment();
    model.registry.tokenPool = zeroAddress;
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({
      [key("state-registry", "pool")]: "critical",
      [key("state-manager", "verify-adapter:1")]: "critical",
    });
    expect(find(conditions, key("state-manager", "verify-adapter:1")).title).toBe(
      "verifyAdapter(#1) reverts: PoolNotActiveInRegistry",
    );
  });

  it("registry maps the token to a pool the Manager does not know", async () => {
    const model = deployment();
    const rogue = {...pool(model)};
    model.pools[lc(A.stranger)] = rogue;
    model.registry.tokenPool = A.stranger;
    const {keys} = await run(model);
    // The rogue pool is watched (the registry pool always is) and has no adapter: rebalancer is not asserted.
    expect(keys).toEqual({
      [key("state-registry", "pool")]: "critical",
      [key("state-manager", "verify-adapter:1")]: "critical",
    });
  });
});

describe("state-pool", () => {
  it("pool owner changed", async () => {
    const model = deployment();
    pool(model).owner = A.stranger;
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({
      [key("state-pool", `${P}:owner`)]: "critical",
      [key("state-manager", "verify-adapter:1")]: "critical",
    });
    expect(find(conditions, key("state-pool", `${P}:owner`)).title).toBe(
      `Pool owner is ${A.stranger}, expected Timelock`,
    );
    expect(find(conditions, key("state-manager", "verify-adapter:1")).fields?.[2]?.value).toBe(
      `PoolOwnerMismatch(pool = Pool ${A.pool}, owner = ${A.stranger})`,
    );
  });

  it("rebalancer changed", async () => {
    const model = deployment();
    pool(model).rebalancer = A.stranger;
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({
      [key("state-pool", `${P}:rebalancer`)]: "critical",
      [key("state-manager", "verify-adapter:1")]: "critical",
    });
    expect(find(conditions, key("state-pool", `${P}:rebalancer`)).rule).toBe("state-pool.rebalancer");
  });

  it("rateLimitAdmin changed", async () => {
    const model = deployment();
    pool(model).rateLimitAdmin = A.stranger;
    const {keys} = await run(model);
    expect(keys).toEqual({
      [key("state-pool", `${P}:rate-limit-admin`)]: "critical",
      [key("state-manager", "verify-adapter:1")]: "critical",
    });
  });

  it("Router changed", async () => {
    const model = deployment();
    pool(model).router = A.stranger;
    const {keys} = await run(model);
    expect(keys).toEqual({
      [key("state-pool", `${P}:router`)]: "critical",
      [key("state-manager", "verify-adapter:1")]: "critical",
    });
  });

  it("typeAndVersion changed", async () => {
    const model = deployment();
    pool(model).typeAndVersion = "LockReleaseTokenPool 1.7.0";
    const {keys} = await run(model);
    expect(keys).toEqual({
      [key("state-pool", `${P}:type-and-version`)]: "critical",
      [key("state-manager", "verify-adapter:1")]: "critical",
    });
  });

  it("remote pool added", async () => {
    const model = deployment();
    pool(model).remotePools[BSC.toString()]?.push(encodedAddress(A.stranger));
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({
      [key("state-pool", `${P}:remote-pools`)]: "critical",
      [key("state-manager", "verify-adapter:1")]: "critical",
    });
    const alert = find(conditions, key("state-pool", `${P}:remote-pools`));
    expect(alert.title).toBe("Pool remote pools for bsc differ from the spec (+1 / -0)");
    expect(alert.fields?.find((field) => field.label === "Added")?.value).toBe(A.stranger);
  });

  it("remote token changed", async () => {
    const model = deployment();
    pool(model).remoteToken[BSC.toString()] = encodedAddress(A.stranger);
    const {keys} = await run(model);
    expect(keys).toEqual({
      [key("state-pool", `${P}:remote-token`)]: "critical",
      [key("state-manager", "verify-adapter:1")]: "critical",
    });
  });

  it("an extra supported chain without rate limits", async () => {
    const model = deployment();
    pool(model).chains.push(999n);
    const {keys} = await run(model);
    expect(keys).toEqual({
      [key("state-pool", `${P}:chains`)]: "critical",
      // The CCIP pool answers a zero (disabled) bucket for the new lane: unlimited in both directions.
      [key("state-pool", `${P}:999:outbound`)]: "critical",
      [key("state-pool", `${P}:999:inbound`)]: "critical",
      [key("state-manager", "verify-adapter:1")]: "critical",
    });
  });

  it("Guardian lockdown: one condition for both directions", async () => {
    const model = deployment();
    pool(model).outbound[BSC.toString()] = bucket(0n, 0n);
    pool(model).inbound[BSC.toString()] = bucket(0n, 0n);
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-pool", `${P}:${BSC}:lockdown`)]: "critical"});
    expect(find(conditions, key("state-pool", `${P}:${BSC}:lockdown`)).title).toBe(
      "Bridge locked down on Pool for bsc (outbound and inbound)",
    );
  });

  it("disabled bucket", async () => {
    const model = deployment();
    pool(model).inbound[BSC.toString()] = bucket(0n, 0n, false);
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-pool", `${P}:${BSC}:inbound`)]: "critical"});
    expect(find(conditions, key("state-pool", `${P}:${BSC}:inbound`)).rule).toBe("state-pool.rate-limit-disabled");
  });

  it("rate limit differs from the expected limit", async () => {
    const model = deployment();
    pool(model).outbound[BSC.toString()] = bucket(tokens(2_000_000), tokens(100));
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-pool", `${P}:${BSC}:outbound`)]: "high"});
    const alert = find(conditions, key("state-pool", `${P}:${BSC}:outbound`));
    expect(alert.fields?.find((field) => field.label === "Current")?.value).toBe(
      "enabled, capacity 2,000,000 SAHARA, rate 100 SAHARA/s",
    );
  });

  it("rate limits are only compared when expected", async () => {
    const model = deployment();
    pool(model).outbound[BSC.toString()] = bucket(tokens(2_000_000), tokens(100));
    const {rateLimits: _ignored, ...expected} = expectedConfig();
    const {keys} = await run(model, {expected});
    expect(keys).toEqual({});
  });
});

describe("state-manager", () => {
  it("Guardian replaced", async () => {
    const model = deployment();
    model.manager.guardian = A.stranger;
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-manager", "guardian")]: "critical"});
    expect(find(conditions, key("state-manager", "guardian")).title).toBe(
      `Manager Guardian is Guardian ${A.stranger}, expected Expected Guardian`,
    );
  });

  it("ownership transfer pending", async () => {
    const model = deployment();
    model.manager.pendingOwner = A.stranger;
    const {keys} = await run(model);
    expect(keys).toEqual({[key("state-manager", "pending-owner")]: "critical"});
  });

  it("owner is not the configured Timelock", async () => {
    const model = deployment();
    model.manager.owner = A.stranger;
    const {keys} = await run(model);
    expect(keys).toEqual({
      [key("state-manager", "owner")]: "critical",
      // The Manager now checks every authority against its new owner.
      [key("state-manager", "verify-handover")]: "critical",
      [key("state-manager", "verify-adapter:1")]: "critical",
    });
  });

  it("restrictions: pause, suspended operator, disabled adapter", async () => {
    const model = deployment();
    model.manager.fundingPaused = true;
    model.manager.recallOperators = [];
    const adapter = model.manager.adapters[0];
    if (!adapter) throw new Error("fixture");
    adapter.fundingEnabled = false;
    const {keys, reads} = await run(model);
    expect(keys).toEqual({
      [key("state-manager", "funding-paused")]: "warning",
      [key("state-manager", `recall-operator:${lc(A.recallOperator)}`)]: "warning",
      [key("state-manager", "adapter:1:funding-disabled")]: "warning",
    });
    // verifyAdapter and the pool budget only matter for fundable adapters.
    expect(reads.some((read) => read.functionName === "verifyAdapter")).toBe(false);
    expect(reads.some((read) => read.functionName === "getPoolFundingBudget")).toBe(false);
  });

  it("budget exhausted (high) and low (warning); capacity 0 is not alerted", async () => {
    const model = deployment();
    model.manager.aggregate.available = 0n;
    const poolBudget = model.manager.poolBudgets[P];
    if (!poolBudget) throw new Error("fixture");
    poolBudget.available = tokens(1_000_000);
    model.manager.recall = {capacity: 0n, rate: 0n, available: 0n};
    const {keys, conditions, snapshots} = await run(model);
    expect(keys).toEqual({
      [key("state-manager", "budget:aggregate")]: "high",
      [key("state-manager", `budget:pool:${P}`)]: "warning",
    });
    expect(find(conditions, key("state-manager", "budget:aggregate")).title).toBe(
      "Aggregate funding budget exhausted (0 of 10,000,000 SAHARA)",
    );
    expect(find(conditions, key("state-manager", `budget:pool:${P}`)).title).toBe(
      "Funding budget of Pool low: 1,000,000 SAHARA of 10,000,000 SAHARA (10%)",
    );
    expect(snapshots["state-manager"]?.["Recall budget"]).toBe("capacity 0 (unconfigured or reduced to 0)");
  });

  it("fractional budgetLowPct", async () => {
    const model = deployment();
    const poolBudget = model.manager.poolBudgets[P];
    if (!poolBudget) throw new Error("fixture");
    poolBudget.available = tokens(1_240_000); // 12.4%
    expect((await run(model, {limits: {budgetLowPct: 12.5}})).keys).toEqual({
      [key("state-manager", `budget:pool:${P}`)]: "warning",
    });
    expect((await run(model, {limits: {budgetLowPct: 12.3}})).keys).toEqual({});
  });
});

describe("state-manager: verifyAdapter/verifyHandover revert decoding", () => {
  const managerKey = (fn: string) => `${lc(A.manager)}.${fn}`;
  const rebalancerRevert = () =>
    encodeErrorResult({abi: liquidityManagerAbi, errorName: "PoolRebalancerMismatch", args: [A.pool, A.stranger]});

  it("decodes raw revert data on a JSON-RPC style error", async () => {
    const model = deployment();
    model.failures[managerKey("verifyAdapter")] = Object.assign(new Error("execution reverted"), {
      code: 3,
      data: rebalancerRevert(),
    });
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-manager", "verify-adapter:1")]: "critical"});
    const alert = find(conditions, key("state-manager", "verify-adapter:1"));
    expect(alert.title).toBe("verifyAdapter(#1) reverts: PoolRebalancerMismatch");
    expect(alert.fields?.find((field) => field.label === "Revert")?.value).toBe(
      `PoolRebalancerMismatch(pool = Pool ${A.pool}, rebalancer = ${A.stranger})`,
    );
  });

  it("decodes revert data nested in error.cause.data.data", async () => {
    const model = deployment();
    model.failures[managerKey("verifyHandover")] = new Error("call failed", {
      cause: {code: 3, message: "execution reverted", data: {data: rebalancerRevert()}},
    });
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-manager", "verify-handover")]: "critical"});
    expect(find(conditions, key("state-manager", "verify-handover")).title).toBe(
      "verifyHandover() reverts: PoolRebalancerMismatch",
    );
  });

  it("decodes pool errors bubbled through _verifyPool", async () => {
    const model = deployment();
    model.failures[managerKey("verifyAdapter")] = Object.assign(new Error("execution reverted"), {
      data: encodeErrorResult({abi: tokenPoolAbi, errorName: "ChainNotAllowed", args: [10n]}),
    });
    const {conditions} = await run(model);
    // ChainNotAllowed(uint64) from the pool ABI.
    expect(find(conditions, key("state-manager", "verify-adapter:1")).title).toBe(
      "verifyAdapter(#1) reverts: ChainNotAllowed",
    );
  });

  it("an unknown selector is still a revert", async () => {
    const model = deployment();
    model.failures[managerKey("verifyAdapter")] = Object.assign(new Error("execution reverted"), {data: "0xdeadbeef"});
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-manager", "verify-adapter:1")]: "critical"});
    expect(find(conditions, key("state-manager", "verify-adapter:1")).title).toBe("verifyAdapter(#1) reverts: unknown");
  });

  it("a revert without data is still a revert", async () => {
    const model = deployment();
    model.failures[managerKey("verifyAdapter")] = new Error("execution reverted");
    const {keys} = await run(model);
    expect(keys).toEqual({[key("state-manager", "verify-adapter:1")]: "critical"});
  });

  it("an RPC failure is read-failed, not a revert", async () => {
    const model = deployment();
    model.failures[managerKey("verifyAdapter")] = new Error("fetch failed: ECONNRESET");
    const {keys, conditions, snapshots} = await run(model);
    expect(keys).toEqual({[key("state-manager", "read-failed")]: "warning"});
    expect(find(conditions, key("state-manager", "read-failed")).fields?.[0]?.value).toBe("Manager.verifyAdapter(1)");
    expect(snapshots["state-manager"]?.["verifyAdapter(#1)"]).toBe("unavailable (read failed)");
  });
});

describe("state-adapter / state-inventory", () => {
  it("non-zero adapter allowance", async () => {
    const model = deployment();
    model.token.allowances[`${lc(A.adapter)}:${P}`] = 5n;
    const {keys} = await run(model);
    expect(keys).toEqual({[key("state-adapter", `allowance:${lc(A.adapter)}:${P}`)]: "critical"});
  });

  it("tokens stuck in an adapter", async () => {
    const model = deployment();
    model.token.balances[lc(A.adapter)] = tokens(3);
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-adapter", `balance:${lc(A.adapter)}`)]: "warning"});
    expect(find(conditions, key("state-adapter", `balance:${lc(A.adapter)}`)).title).toBe(
      "Tokens stuck in Adapter #1: 3 SAHARA",
    );
  });

  it("pool below the refill trigger (warning) and below the minimum (critical) share one key", async () => {
    const model = deployment();
    model.token.balances[P] = tokens(4_000_000);
    const below = await run(model);
    expect(below.keys).toEqual({[key("state-inventory", P)]: "warning"});
    expect(find(below.conditions, key("state-inventory", P)).title).toBe(
      "Pool below refill trigger: fund up to target (6,000,000 SAHARA)",
    );

    model.token.balances[P] = tokens(500_000);
    const critical = await run(model);
    expect(critical.keys).toEqual({[key("state-inventory", P)]: "critical"});
  });

  it("a raised minimum above the trigger is the effective trigger", async () => {
    const model = deployment();
    const thresholds = model.manager.thresholds[P];
    if (!thresholds) throw new Error("fixture");
    thresholds.minimum = tokens(9_000_000); // raisePoolMinimum: above trigger (5M), below target (10M)
    const {keys} = await run(model);
    expect(keys).toEqual({[key("state-inventory", P)]: "critical"});
  });
});

describe("pool migration", () => {
  const NEW_POOL = A.pool2;
  const NEW_ADAPTER = A.adapter2;
  const NP = lc(NEW_POOL);

  it("mid-migration (registry still on the old pool, target pre-funded): nothing to report", async () => {
    const model = deployment();
    addMigrationTarget(model, NEW_POOL, NEW_ADAPTER, tokens(8_000_000));
    const {keys, snapshots} = await run(model);
    expect(keys).toEqual({});
    expect(snapshots["state-manager"]).toMatchObject({"verifyAdapter(#1)": "ok", "verifyAdapter(#2)": "ok"});
  });

  it("an unfunded migration target is a warning, not a bridge outage", async () => {
    const model = deployment();
    addMigrationTarget(model, NEW_POOL, NEW_ADAPTER, 0n);
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-inventory", NP)]: "warning"});
    expect(find(conditions, key("state-inventory", NP)).rule).toBe("state-inventory.below-minimum");
  });

  it("after the cutover the retired pool's lanes are not asserted, its authorities are", async () => {
    const model = deployment();
    addMigrationTarget(model, NEW_POOL, NEW_ADAPTER, tokens(8_000_000));
    model.registry.tokenPool = NEW_POOL;
    delete model.manager.migrationSources[NP];
    const retired = model.manager.adapters[0];
    if (!retired) throw new Error("fixture");
    retired.fundingEnabled = false;
    retired.recallEnabled = false;
    // Old pool drained and locked down: no inventory, lockdown or adapter-status alerts.
    model.token.balances[P] = 0n;
    pool(model).outbound[BSC.toString()] = bucket(0n, 0n);
    pool(model).inbound[BSC.toString()] = bucket(0n, 0n);
    expect((await run(model)).keys).toEqual({});

    pool(model).rebalancer = A.stranger;
    expect((await run(model)).keys).toEqual({[key("state-pool", `${P}:rebalancer`)]: "critical"});
  });
});

describe("state-router", () => {
  it("OffRamp set changed: lists added and removed", async () => {
    const model = deployment();
    model.router.offRamps = [
      {sourceChainSelector: BSC, offRamp: A.offRamp2},
      {sourceChainSelector: 999n, offRamp: A.otherLaneOffRamp},
    ];
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-router", `off-ramps:${BSC}`)]: "high"});
    const alert = find(conditions, key("state-router", `off-ramps:${BSC}`));
    expect(alert.title).toBe("Router OffRamps from bsc changed (+1 / -1)");
    expect(alert.fields?.find((field) => field.label === "Added")?.value).toBe(A.offRamp2);
    expect(alert.fields?.find((field) => field.label === "Removed")?.value).toBe(A.offRamp);
  });

  it("OnRamp changed", async () => {
    const model = deployment();
    model.router.onRamps[BSC.toString()] = A.stranger;
    const {keys} = await run(model);
    expect(keys).toEqual({[key("state-router", `on-ramp:${BSC}`)]: "high"});
  });
});

describe("state-timelock / state-controller", () => {
  it("delay changed", async () => {
    const model = deployment();
    model.timelock.minDelay = 3600n;
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-timelock", "min-delay")]: "critical"});
    expect(find(conditions, key("state-timelock", "min-delay")).title).toBe("Timelock delay is 1h, expected 2d");
  });

  it("expected proposer lost its role", async () => {
    const model = deployment();
    revoke(model, ROLE.PROPOSER, A.safe);
    const {keys} = await run(model);
    expect(keys).toEqual({[key("state-timelock", `missing-role:PROPOSER:${lc(A.safe)}`)]: "critical"});
  });

  it("Guardian or operator holding a Timelock role", async () => {
    const model = deployment();
    grant(model, ROLE.PROPOSER, A.guardian);
    grant(model, ROLE.CANCELLER, A.fundingOperator);
    const {keys} = await run(model);
    expect(keys).toEqual({
      [key("state-timelock", `forbidden-role:PROPOSER:${lc(A.guardian)}`)]: "critical",
      [key("state-timelock", `forbidden-role:CANCELLER:${lc(A.fundingOperator)}`)]: "critical",
    });
  });

  it("controller without CANCELLER_ROLE raises one condition", async () => {
    const model = deployment();
    revoke(model, ROLE.CANCELLER, A.controller);
    const {keys, conditions} = await run(model);
    expect(keys).toEqual({[key("state-timelock", `missing-role:CANCELLER:${lc(A.controller)}`)]: "critical"});
    expect(find(conditions, key("state-timelock", `missing-role:CANCELLER:${lc(A.controller)}`)).rule).toBe(
      "state-timelock.controller-canceller",
    );
  });

  it("controller holding EXECUTOR", async () => {
    const model = deployment();
    grant(model, ROLE.EXECUTOR, A.controller);
    const {keys} = await run(model);
    expect(keys).toEqual({[key("state-timelock", `forbidden-role:EXECUTOR:${lc(A.controller)}`)]: "critical"});
  });

  it("controller bound to another Manager", async () => {
    const model = deployment();
    model.controller.MANAGER = A.stranger;
    const {keys} = await run(model);
    expect(keys).toEqual({[key("state-controller", "manager")]: "critical"});
  });
});

describe("failed reads", () => {
  it("raise read-failed and keep last cycle's conditions open", async () => {
    const model = deployment();
    const store = createStore();
    pool(model).owner = A.stranger;
    const first = await runRules(stateContext(model, {store}).ctx, [poolStateRule]);
    expect(first.keys).toEqual({[key("state-pool", `${P}:owner`)]: "critical"});

    // The owner read fails: the open condition must not be resolved by omission.
    model.failures[`${P}.owner`] = new Error("upstream timeout");
    const second = await runRules(stateContext(model, {store}).ctx, [poolStateRule]);
    expect(second.keys).toEqual({
      [key("state-pool", `${P}:owner`)]: "critical",
      [key("state-pool", "read-failed")]: "warning",
    });
    expect(find(second.conditions, key("state-pool", "read-failed")).fields?.[0]?.value).toBe("Pool.owner()");

    // Reads recover and the owner was fixed: everything resolves.
    delete model.failures[`${P}.owner`];
    pool(model).owner = A.timelock;
    const third = await runRules(stateContext(model, {store}).ctx, [poolStateRule]);
    expect(third.keys).toEqual({});
  });

  it("a read failing on one pool does not keep another pool's fixed condition open", async () => {
    const model = deployment();
    addMigrationTarget(model, A.pool2, A.adapter2, tokens(8_000_000));
    const store = createStore();
    pool(model).owner = A.stranger;
    const first = await runRules(stateContext(model, {store}).ctx, [poolStateRule]);
    expect(first.keys).toEqual({[key("state-pool", `${P}:owner`)]: "critical"});

    // Pool fixed, while the replacement pool's owner() fails on every cycle.
    pool(model).owner = A.timelock;
    model.failures[`${lc(A.pool2)}.owner`] = new Error("execution reverted: missing view");
    const second = await runRules(stateContext(model, {store}).ctx, [poolStateRule]);
    expect(second.keys).toEqual({[key("state-pool", "read-failed")]: "warning"});
  });

  it("a rule never rejects", async () => {
    const model = deployment();
    model.failures[`${lc(A.registry)}.getTokenConfig`] = new Error("boom");
    model.failures[`${lc(A.token)}.owner`] = new Error("boom");
    const {ctx} = stateContext(model);
    await expect(registryStateRule.check(ctx, BLOCK)).resolves.toMatchObject({
      conditions: [{key: key("state-registry", "read-failed"), severity: "warning"}],
    });
    const token = await tokenStateRule.check(ctx, BLOCK);
    expect(token.conditions.map((alert) => alert.key)).toEqual([key("state-token", "read-failed")]);
    expect(token.snapshot["Token owner"]).toBe("unavailable (read failed)");
  });
});

describe("without a Manager", () => {
  it("checks only what is configured and reads nothing Manager-related", async () => {
    const model = deployment();
    const {ctx, reads} = stateContext(model, {withManager: false});
    const result = await runRules(ctx);
    expect(result.keys).toEqual({});
    expect(reads.some((read) => read.address === A.manager || read.address === A.timelock)).toBe(false);
    const managerRules = [managerStateRule, inventoryStateRule, adapterStateRule];
    for (const rule of [...managerRules, timelockStateRule, controllerStateRule]) {
      expect(result.snapshots[rule.id]).toEqual({});
    }
  });

  it("asserts literal expected addresses", async () => {
    const model = deployment();
    pool(model).owner = A.stranger;
    model.token.paused = true;
    const {ctx} = stateContext(model, {withManager: false, expected: {poolOwner: A.timelock, tokenOwner: A.timelock}});
    const result = await runRules(ctx, [tokenStateRule, poolStateRule, routerStateRule]);
    expect(result.keys).toEqual({
      [key("state-token", "paused")]: "critical",
      [key("state-pool", `${P}:owner`)]: "critical",
    });
  });
});
