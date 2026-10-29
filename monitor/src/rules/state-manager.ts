// State rules for the LiquidityManager and the reserves it controls: authorities and restrictions on the Manager, the
// Manager's own verification views (verifyHandover/verifyAdapter, which revert with the first broken safeguard),
// funding and recall budgets, adapter allowances and stranded balances, and pool inventory against the thresholds.
import {getAddress, zeroAddress, type Address} from "viem";

import {saharaTokenAbi} from "../abi/external.ts";
import {liquidityManagerAbi} from "../abi/generated.ts";
import {effectiveExpected, resolveRef} from "../config.ts";
import {formatDuration} from "../format.ts";
import type {AlertField, AlertLink, ChainContext} from "../types.ts";
import {addressField, addressLink, sameAddress} from "./common.ts";
import {
  activePools,
  amount,
  defineStateRule,
  keyOf,
  labelled,
  liveAdapters,
  READ_FAILED,
  yesNo,
  type StateCheck,
} from "./state-common.ts";

export const MANAGER_RULE = "state-manager";
export const ADAPTER_RULE = "state-adapter";
export const INVENTORY_RULE = "state-inventory";

interface Budget {
  capacity: bigint;
  rate: bigint;
  available: bigint;
}

export const managerStateRule = defineStateRule(MANAGER_RULE, async (check) => {
  const {ctx} = check;
  const manager = ctx.addresses.manager;
  if (!manager) return;
  const expected = effectiveExpected(ctx.config);
  const call = {address: manager, abi: liquidityManagerAbi} as const;
  const links = [addressLink(ctx, manager, "Manager")];
  const fundingOperators = expected.fundingOperators ?? [];
  const recallOperators = expected.recallOperators ?? [];
  const fundable = ctx.addresses.adapters.filter((entry) => entry.fundingEnabled);

  const [
    owner,
    pendingOwner,
    guardian,
    fundingPaused,
    recallPaused,
    maxFunding,
    maxRecall,
    aggregate,
    recall,
    handover,
    fundingFlags,
    recallFlags,
    poolBudgets,
    verified,
  ] = await Promise.all([
    check.read({...call, functionName: "owner"}),
    check.read({...call, functionName: "pendingOwner"}),
    check.read({...call, functionName: "guardian"}),
    check.read({...call, functionName: "fundingPaused"}),
    check.read({...call, functionName: "recallPaused"}),
    check.read({...call, functionName: "maxFundingPerCall"}),
    check.read({...call, functionName: "maxRecallPerCall"}),
    check.read({...call, functionName: "getAggregateFundingBudget"}),
    check.read({...call, functionName: "getRecallBudget"}),
    check.verify({...call, functionName: "verifyHandover"}),
    Promise.all(fundingOperators.map((op) => check.read({...call, functionName: "isFundingOperator", args: [op]}))),
    Promise.all(recallOperators.map((op) => check.read({...call, functionName: "isRecallOperator", args: [op]}))),
    Promise.all(
      fundable.map((entry) => check.read({...call, functionName: "getPoolFundingBudget", args: [entry.pool]})),
    ),
    Promise.all(fundable.map((entry) => check.verify({...call, functionName: "verifyAdapter", args: [entry.id]}))),
  ]);

  // Authorities. `ctx.addresses.timelock` defaults to owner() itself, so the owner is only checked against a
  // configured `contracts.timelock`; the GuardianController's TIMELOCK() is checked by state-controller.
  check.snapshot["Manager owner"] = owner === undefined ? READ_FAILED : labelled(ctx, owner);
  const configuredTimelock = ctx.config.contracts.timelock;
  if (owner !== undefined && configuredTimelock && !sameAddress(owner, configuredTimelock)) {
    check.raise({
      check: "owner",
      severity: "critical",
      title: `Manager owner is ${ctx.label(getAddress(owner))}, not the Timelock`,
      fields: [addressField(ctx, "Owner", owner), addressField(ctx, "Timelock", configuredTimelock)],
      links,
      note: "The owner configures everything, including migrateReserves. Every Manager operation bypasses the delay.",
    });
  }
  check.snapshot["Manager pending owner"] = pendingOwner === undefined ? READ_FAILED : labelled(ctx, pendingOwner);
  if (pendingOwner !== undefined && !sameAddress(pendingOwner, zeroAddress)) {
    check.raise({
      check: "pending-owner",
      severity: "critical",
      title: `Manager ownership transfer pending to ${ctx.label(getAddress(pendingOwner))}`,
      fields: [addressField(ctx, "Pending owner", pendingOwner)],
      links,
      note:
        "acceptOwnership() by the pending owner gives it full control of the reserves. Overwrite it with " +
        "transferOwnership(Timelock) through the Timelock if this was not intended.",
    });
  }
  check.snapshot["Guardian"] = guardian === undefined ? READ_FAILED : labelled(ctx, guardian);
  const expectedGuardian = resolveRef(expected.guardian, ctx.addresses, ctx.config);
  if (guardian !== undefined && expectedGuardian && !sameAddress(guardian, expectedGuardian)) {
    check.raise({
      check: "guardian",
      severity: "critical",
      title: `Manager Guardian is ${labelled(ctx, guardian)}, expected ${ctx.label(expectedGuardian)}`,
      fields: [addressField(ctx, "Guardian", guardian), addressField(ctx, "Expected", expectedGuardian)],
      links,
      note: "The Guardian can pause, restrict, cancel Timelock proposals and lock down the bridge.",
    });
  }

  // Restrictions (Guardian or Timelock): degraded operation, not a risk to funds.
  check.snapshot["Funding paused"] = fundingPaused === undefined ? READ_FAILED : yesNo(fundingPaused);
  check.snapshot["Recall paused"] = recallPaused === undefined ? READ_FAILED : yesNo(recallPaused);
  if (fundingPaused) {
    check.raise({
      check: "funding-paused",
      severity: "warning",
      title: "Manager funding is paused",
      links,
      note: "Pools are not refilled until the Timelock calls setFundingPaused(false).",
    });
  }
  if (recallPaused) {
    check.raise({
      check: "recall-paused",
      severity: "warning",
      title: "Manager recall is paused",
      links,
      note: "Pool inventory cannot be recalled until the Timelock calls setRecallPaused(false).",
    });
  }
  const operators: Array<[string, Address, boolean | undefined]> = [
    ...fundingOperators.map((op, i): [string, Address, boolean | undefined] => ["funding", op, fundingFlags[i]]),
    ...recallOperators.map((op, i): [string, Address, boolean | undefined] => ["recall", op, recallFlags[i]]),
  ];
  for (const [role, operator, enabled] of operators) {
    check.snapshot[`${role === "funding" ? "Funding" : "Recall"} operator ${operator}`] =
      enabled === undefined ? READ_FAILED : enabled ? "enabled" : "suspended";
    if (enabled !== false) continue;
    check.raise({
      check: `${role}-operator`,
      subject: `${role}-operator:${keyOf(operator)}`,
      severity: "warning",
      title: `${role === "funding" ? "Funding" : "Recall"} operator suspended: ${ctx.label(operator)}`,
      fields: [addressField(ctx, "Operator", operator)],
      links,
      note: `Re-enabling needs the Timelock (set${role === "funding" ? "Funding" : "Recall"}Operator(operator, true)).`,
    });
  }
  for (const entry of ctx.addresses.adapters) {
    check.snapshot[`Adapter #${entry.id} (${ctx.label(entry.pool)})`] =
      `funding ${entry.fundingEnabled ? "on" : "off"}, recall ${entry.recallEnabled ? "on" : "off"}`;
  }
  // Only the live pool's adapter: a retired adapter is expected to be disabled.
  for (const entry of liveAdapters(ctx)) {
    for (const [flag, enabled] of [
      ["funding", entry.fundingEnabled],
      ["recall", entry.recallEnabled],
    ] as const) {
      if (enabled) continue;
      const what = flag === "funding" ? "Funding" : "Recall";
      check.raise({
        check: `adapter-${flag}-disabled`,
        subject: `adapter:${entry.id}:${flag}-disabled`,
        severity: "warning",
        title: `${what} disabled for Adapter #${entry.id} (${ctx.label(entry.pool)})`,
        fields: [addressField(ctx, "Adapter", entry.adapter), addressField(ctx, "Pool", entry.pool)],
        links,
        note: "Re-enabling needs the Timelock (setAdapterStatus).",
      });
    }
  }

  // Verification views: the same checks fund() and registerAdapter() run, reverting with the first broken safeguard.
  check.snapshot["verifyHandover()"] = verifyText(handover);
  if (handover && !handover.ok) {
    check.raise({
      check: "verify-handover",
      severity: "critical",
      title: `verifyHandover() reverts: ${handover.revert.name}`,
      fields: [{label: "Revert", value: handover.revert.text, code: true}],
      links,
      note:
        "Token ownership or registry administration is not (only) with the Timelock: the token can be paused or " +
        "remapped outside the delay, and registerAdapter is blocked.",
    });
  }
  fundable.forEach((entry, i) => {
    const result = verified[i];
    check.snapshot[`verifyAdapter(#${entry.id})`] = verifyText(result);
    if (!result || result.ok) return;
    check.raise({
      check: "verify-adapter",
      subject: `verify-adapter:${entry.id}`,
      severity: "critical",
      title: `verifyAdapter(#${entry.id}) reverts: ${result.revert.name}`,
      fields: [
        addressField(ctx, "Adapter", entry.adapter),
        addressField(ctx, "Pool", entry.pool),
        {label: "Revert", value: result.revert.text, code: true},
      ],
      links: [...links, addressLink(ctx, entry.pool)],
      note: "A safeguard on the pool or adapter is broken and funding this pool fails until it is restored.",
    });
  });

  // Budgets.
  if (maxFunding !== undefined) check.snapshot["Max funding per call"] = amount(ctx, maxFunding);
  if (maxRecall !== undefined) check.snapshot["Max recall per call"] = amount(ctx, maxRecall);
  checkBudget(check, "aggregate", "Aggregate funding budget", aggregate, links);
  checkBudget(check, "recall", "Recall budget", recall, links);
  fundable.forEach((entry, i) => {
    checkBudget(check, `pool:${keyOf(entry.pool)}`, `Funding budget of ${ctx.label(entry.pool)}`, poolBudgets[i], [
      ...links,
      addressLink(ctx, entry.pool),
    ]);
  });
});

function verifyText(result: {ok: true} | {ok: false; revert: {text: string}} | undefined): string {
  if (!result) return READ_FAILED;
  return result.ok ? "ok" : `reverts: ${result.revert.text}`;
}

/** Capacity 0 is unconfigured (or fully restricted) and only shown; otherwise exhausted → high, low → warning. */
function checkBudget(check: StateCheck, id: string, title: string, budget: Budget | undefined, links: AlertLink[]) {
  const {ctx} = check;
  if (!budget) {
    check.snapshot[title] = READ_FAILED;
    return;
  }
  check.snapshot[title] = budget.capacity
    ? `${amount(ctx, budget.available)} of ${amount(ctx, budget.capacity)} (refill ${amount(ctx, budget.rate)}/s)`
    : "capacity 0 (unconfigured or reduced to 0)";
  if (budget.capacity === 0n) return;
  const fields: AlertField[] = [
    {label: "Available", value: amount(ctx, budget.available), code: true},
    {label: "Capacity", value: amount(ctx, budget.capacity), code: true},
    {label: "Refill", value: `${amount(ctx, budget.rate)}/s`, code: true},
  ];
  const lowPct = ctx.config.limits.budgetLowPct;
  // budgetLowPct may be fractional: compare in basis points.
  const low = budget.available * 10_000n < budget.capacity * BigInt(Math.round(lowPct * 100));
  if (budget.available === 0n) {
    check.raise({
      check: "budget-exhausted",
      subject: `budget:${id}`,
      severity: "high",
      title: `${title} exhausted (0 of ${amount(ctx, budget.capacity)})`,
      fields,
      links,
      note: refillNote(budget, budget.capacity),
    });
  } else if (low) {
    const pct = Number((budget.available * 10_000n) / budget.capacity) / 100;
    check.raise({
      check: "budget-low",
      subject: `budget:${id}`,
      severity: "warning",
      title: `${title} low: ${amount(ctx, budget.available)} of ${amount(ctx, budget.capacity)} (${pct}%)`,
      fields,
      links,
      note: `Below ${lowPct}% of capacity. ${refillNote(budget, budget.capacity - budget.available)}`,
    });
  }
}

function refillNote(budget: Budget, deficit: bigint): string {
  if (budget.rate === 0n) return "The refill rate is 0: it only recovers through a Timelock reconfiguration.";
  const seconds = (deficit + budget.rate - 1n) / budget.rate;
  return `Refills to capacity in ${formatDuration(seconds)}.`;
}

/** Every adapter ever registered: no allowance to any watched pool, no SAHARA held between operations. */
export const adapterStateRule = defineStateRule(ADAPTER_RULE, async (check) => {
  const {ctx} = check;
  const token = ctx.addresses.token;
  const pools = ctx.addresses.pools.map((pool) => getAddress(pool));
  const call = {address: token, abi: saharaTokenAbi} as const;
  await Promise.all(
    ctx.addresses.adapterHistory.map(async (raw) => {
      const adapter = getAddress(raw);
      const name = ctx.label(adapter);
      const [balance, allowances] = await Promise.all([
        check.read({...call, functionName: "balanceOf", args: [adapter]}),
        Promise.all(pools.map((pool) => check.read({...call, functionName: "allowance", args: [adapter, pool]}))),
      ]);
      const links = [addressLink(ctx, adapter)];
      check.snapshot[`${name} balance`] = balance === undefined ? READ_FAILED : amount(ctx, balance);
      if (balance !== undefined && balance > 0n) {
        check.raise({
          check: "balance",
          subject: `balance:${keyOf(adapter)}`,
          severity: "warning",
          title: `Tokens stuck in ${name}: ${amount(ctx, balance)}`,
          fields: [addressField(ctx, "Adapter", adapter), {label: "Balance", value: amount(ctx, balance), code: true}],
          links,
          note:
            "The adapter has no rescue function: SAHARA sent to it outside fund/recall stays there. Count it in " +
            "reconciliation and find the sender.",
        });
      }
      pools.forEach((pool, i) => {
        const allowance = allowances[i];
        if (allowance === undefined || allowance === 0n) return;
        check.raise({
          check: "allowance",
          subject: `allowance:${keyOf(adapter)}:${keyOf(pool)}`,
          severity: "critical",
          title: `${name} has a non-zero allowance to ${ctx.label(pool)}: ${amount(ctx, allowance)}`,
          fields: [
            addressField(ctx, "Adapter", adapter),
            addressField(ctx, "Spender", pool),
            {label: "Allowance", value: amount(ctx, allowance), code: true},
          ],
          links: [...links, addressLink(ctx, pool)],
          note:
            "fund() leaves zero allowance or reverts, so this should be impossible. Funding through this adapter " +
            "reverts with NonZeroAllowance; investigate the transaction that set it.",
        });
      });
    }),
  );
});

/** Inventory of the live and fundable registered pools against the Manager's thresholds. */
export const inventoryStateRule = defineStateRule(INVENTORY_RULE, async (check) => {
  const {ctx} = check;
  const manager = ctx.addresses.manager;
  if (!manager) return;
  const token = ctx.addresses.token;
  const pools = activePools(ctx);
  const [managerBalance, ...states] = await Promise.all([
    check.read({address: token, abi: saharaTokenAbi, functionName: "balanceOf", args: [manager]}),
    ...pools.map((pool) =>
      Promise.all([
        check.read({address: token, abi: saharaTokenAbi, functionName: "balanceOf", args: [pool]}),
        check.read({address: manager, abi: liquidityManagerAbi, functionName: "getPoolThresholds", args: [pool]}),
      ]),
    ),
  ]);
  check.snapshot["Manager balance"] = managerBalance === undefined ? READ_FAILED : amount(ctx, managerBalance);

  pools.forEach((pool, i) => {
    const [balance, thresholdsResult] = states[i] ?? [undefined, undefined];
    const name = ctx.label(pool);
    check.snapshot[`${name} balance`] = balance === undefined ? READ_FAILED : amount(ctx, balance);
    if (!thresholdsResult) {
      check.snapshot[`${name} thresholds`] = READ_FAILED;
      return;
    }
    const [thresholds, isSet] = thresholdsResult;
    if (!isSet) {
      check.snapshot[`${name} thresholds`] = "not set";
      return;
    }
    const {minimum, refillTrigger, refillTarget} = thresholds;
    check.snapshot[`${name} thresholds`] =
      `minimum ${amount(ctx, minimum)}, trigger ${amount(ctx, refillTrigger)}, target ${amount(ctx, refillTarget)}`;
    if (balance === undefined) return;
    // raisePoolMinimum may lift the minimum above the trigger/target: keepers use max(minimum, trigger).
    const trigger = minimum > refillTrigger ? minimum : refillTrigger;
    const target = minimum > refillTarget ? minimum : refillTarget;
    if (balance >= trigger) return;
    const fields = inventoryFields(ctx, pool, balance, minimum, refillTrigger, refillTarget, target, managerBalance);
    const links = [addressLink(ctx, pool), addressLink(ctx, manager, "Manager")];
    // Only the registry pool carries bridge releases; a migration target being pre-funded is not urgent.
    const bridging = sameAddress(pool, ctx.addresses.registryPool);
    if (balance < minimum) {
      check.raise({
        check: "below-minimum",
        subject: keyOf(pool),
        severity: bridging ? "critical" : "warning",
        title: `${name} below minimum: ${amount(ctx, balance)} < ${amount(ctx, minimum)}`,
        fields,
        links,
        note: bridging
          ? "Inbound bridge releases may fail for lack of liquidity. Fund up to the target now; check for " +
            "unexplained outflows."
          : "Not the registry pool yet: fund it up to the target before the cutover.",
      });
    } else {
      check.raise({
        check: "below-trigger",
        subject: keyOf(pool),
        severity: "warning",
        title: `${name} below refill trigger: fund up to target (${amount(ctx, target - balance)})`,
        fields,
        links,
      });
    }
  });
});

function inventoryFields(
  ctx: ChainContext,
  pool: Address,
  balance: bigint,
  minimum: bigint,
  trigger: bigint,
  target: bigint,
  effectiveTarget: bigint,
  managerBalance: bigint | undefined,
): AlertField[] {
  const fields: AlertField[] = [
    addressField(ctx, "Pool", pool),
    {label: "Balance", value: amount(ctx, balance), code: true},
    {label: "Minimum", value: amount(ctx, minimum), code: true},
    {label: "Refill trigger", value: amount(ctx, trigger), code: true},
    {label: "Refill target", value: amount(ctx, target), code: true},
    {label: "Fund up to target", value: amount(ctx, effectiveTarget - balance), code: true},
  ];
  if (managerBalance !== undefined) {
    fields.push({label: "Manager balance", value: amount(ctx, managerBalance), code: true});
  }
  return fields;
}
