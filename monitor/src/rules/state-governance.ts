// State rules for the governance contracts: the Timelock's delay and role holders (the Guardian, operators and the
// GuardianController must never be able to propose, execute or administer), and the GuardianController's bindings.
import {getAddress, keccak256, stringToHex, zeroAddress, zeroHash, type Address, type Hex} from "viem";

import {guardianControllerAbi, liquidityManagerAbi, saharaTimelockAbi} from "../abi/generated.ts";
import {effectiveExpected, resolveRef, type AddressRef} from "../config.ts";
import {formatDuration} from "../format.ts";
import {addressField, addressLink, sameAddress} from "./common.ts";
import {defineStateRule, keyOf, labelled, READ_FAILED, yesNo, type StateCheck} from "./state-common.ts";

export const TIMELOCK_RULE = "state-timelock";
export const CONTROLLER_RULE = "state-controller";

/** OpenZeppelin TimelockController role ids (fixed constants, so not read every cycle). */
const ROLES = {
  ADMIN: zeroHash,
  PROPOSER: keccak256(stringToHex("PROPOSER_ROLE")),
  EXECUTOR: keccak256(stringToHex("EXECUTOR_ROLE")),
  CANCELLER: keccak256(stringToHex("CANCELLER_ROLE")),
} as const satisfies Record<string, Hex>;

type RoleName = keyof typeof ROLES;

const EXPECTED_ROLE_KEYS: Array<[RoleName, "admins" | "proposers" | "executors" | "cancellers"]> = [
  ["ADMIN", "admins"],
  ["PROPOSER", "proposers"],
  ["EXECUTOR", "executors"],
  ["CANCELLER", "cancellers"],
];

/**
 * Accounts that must hold no Timelock role but CANCELLER for the controller: a Guardian or operator that could
 * propose, execute or administer would escape the delay, and one holding CANCELLER directly could cancel its own
 * removal (the GuardianController's protected-call check would be bypassed).
 */
const FORBIDDEN_FOR_RESTRICTED: RoleName[] = ["ADMIN", "PROPOSER", "EXECUTOR", "CANCELLER"];
const FORBIDDEN_FOR_CONTROLLER: RoleName[] = ["ADMIN", "PROPOSER", "EXECUTOR"];

export const timelockStateRule = defineStateRule(TIMELOCK_RULE, async (check) => {
  const {ctx} = check;
  const timelock = ctx.addresses.timelock;
  if (!timelock) return;
  const expected = effectiveExpected(ctx.config);
  const links = [addressLink(ctx, timelock, "Timelock")];
  const call = {address: timelock, abi: saharaTimelockAbi} as const;

  const roleCache = new Map<string, Promise<boolean | undefined>>();
  const hasRole = (role: RoleName, account: Address) => {
    const cacheKey = `${role}:${keyOf(account)}`;
    let pending = roleCache.get(cacheKey);
    if (!pending) {
      pending = check.read({...call, functionName: "hasRole", args: [ROLES[role], account]});
      roleCache.set(cacheKey, pending);
    }
    return pending;
  };

  const manager = ctx.addresses.manager;
  const [minDelay, liveGuardian] = await Promise.all([
    check.read({...call, functionName: "getMinDelay"}),
    manager ? check.read({address: manager, abi: liquidityManagerAbi, functionName: "guardian"}) : undefined,
  ]);

  check.snapshot["Timelock delay"] = minDelay === undefined ? READ_FAILED : formatDuration(minDelay);
  const wantDelay = expected.timelockDelaySec;
  if (minDelay !== undefined && wantDelay !== undefined && minDelay !== BigInt(wantDelay)) {
    check.raise({
      check: "min-delay",
      severity: "critical",
      title: `Timelock delay is ${formatDuration(minDelay, true)}, expected ${formatDuration(wantDelay, true)}`,
      fields: [
        {label: "getMinDelay()", value: `${minDelay} s`, code: true},
        {label: "Expected", value: `${wantDelay} s`, code: true},
      ],
      links,
      note: "A shorter delay leaves the Guardian less time to cancel a malicious proposal.",
    });
  }

  // The GuardianController must hold CANCELLER_ROLE: checked first so it owns the shared missing-role key.
  const controller = ctx.addresses.controller;
  if (controller) {
    const holds = await hasRole("CANCELLER", controller);
    check.snapshot["GuardianController CANCELLER_ROLE"] = holds === undefined ? READ_FAILED : yesNo(holds);
    if (holds === false) {
      check.raise({
        check: "controller-canceller",
        subject: `missing-role:CANCELLER:${keyOf(controller)}`,
        severity: "critical",
        title: "GuardianController lacks CANCELLER_ROLE: the Guardian cannot cancel proposals",
        fields: [addressField(ctx, "GuardianController", controller)],
        links,
        note: "Restore it with a Timelock grantRole(CANCELLER_ROLE, controller) operation.",
      });
    }
  }

  // Expected holders.
  const resolve = (ref: AddressRef) => resolveRef(ref, ctx.addresses, ctx.config);
  const expectedRoles = expected.timelockRoles ?? {};
  await Promise.all(
    EXPECTED_ROLE_KEYS.map(async ([role, key]) => {
      const refs = expectedRoles[key];
      if (!refs) return;
      const holders = refs.map(resolve).filter((a): a is Address => a !== undefined);
      const results = await Promise.all(holders.map((holder) => hasRole(role, holder)));
      check.snapshot[`Timelock ${role} holders`] = holders
        .map((holder, i) => {
          const result = results[i];
          return `${labelled(ctx, holder)}${result === undefined ? " (read failed)" : result ? "" : " (MISSING)"}`;
        })
        .join(", ") || "none expected";
      holders.forEach((holder, i) => {
        if (results[i] !== false) return;
        check.raise({
          check: "missing-role",
          subject: `missing-role:${role}:${keyOf(holder)}`,
          severity: "critical",
          title: `${ctx.label(holder)} no longer holds the Timelock ${role} role`,
          fields: [addressField(ctx, "Account", holder), {label: "Role", value: `${role}_ROLE`}],
          links,
          note: roleNote(role),
        });
      });
    }),
  );

  // Accounts that must not hold roles.
  const restricted = new Map<string, {account: Address; what: string; roles: RoleName[]}>();
  const addRestricted = (account: string | undefined, what: string, roles: RoleName[]) => {
    if (!account || sameAddress(account, zeroAddress) || restricted.has(keyOf(account))) return;
    restricted.set(keyOf(account), {account: getAddress(account), what, roles});
  };
  addRestricted(liveGuardian, "Guardian", FORBIDDEN_FOR_RESTRICTED);
  const expectedGuardian = resolveRef(expected.guardian, ctx.addresses, ctx.config);
  addRestricted(expectedGuardian, "expected Guardian", FORBIDDEN_FOR_RESTRICTED);
  for (const operator of expected.fundingOperators ?? []) {
    addRestricted(operator, "funding operator", FORBIDDEN_FOR_RESTRICTED);
  }
  for (const operator of expected.recallOperators ?? []) {
    addRestricted(operator, "recall operator", FORBIDDEN_FOR_RESTRICTED);
  }
  addRestricted(controller, "GuardianController", FORBIDDEN_FOR_CONTROLLER);
  await Promise.all(
    [...restricted.values()].map(async ({account, what, roles}) => {
      const results = await Promise.all(roles.map((role) => hasRole(role, account)));
      roles.forEach((role, i) => {
        if (results[i] !== true) return;
        check.raise({
          check: "forbidden-role",
          subject: `forbidden-role:${role}:${keyOf(account)}`,
          severity: "critical",
          title: `The ${what} holds the Timelock ${role} role`,
          fields: [addressField(ctx, "Account", account), {label: "Role", value: `${role}_ROLE`}],
          links,
          note:
            role === "CANCELLER"
              ? "Holding CANCELLER_ROLE directly lets it cancel any proposal, including its own removal."
              : "A restricted role must not be able to schedule, execute or administer Timelock operations. " +
                "Revoke it through the Timelock (revokeRole).",
        });
      });
    }),
  );
});

function roleNote(role: RoleName): string {
  switch (role) {
    case "ADMIN":
      return "The Timelock must administer itself, so role changes go through the delay.";
    case "PROPOSER":
      return "Governance can no longer schedule operations (including a Guardian replacement).";
    case "EXECUTOR":
      return "Scheduled operations cannot be executed by this account.";
    case "CANCELLER":
      return "This account can no longer cancel proposals.";
  }
}

/** GuardianController `MANAGER()` and `TIMELOCK()` are immutable bindings to this deployment. */
export const controllerStateRule = defineStateRule(CONTROLLER_RULE, async (check) => {
  const {ctx} = check;
  const controller = ctx.addresses.controller;
  if (!controller) return;
  const call = {address: controller, abi: guardianControllerAbi} as const;
  const [boundManager, boundTimelock] = await Promise.all([
    check.read({...call, functionName: "MANAGER"}),
    check.read({...call, functionName: "TIMELOCK"}),
  ]);
  bindingCheck(check, controller, "MANAGER()", "manager", boundManager, ctx.addresses.manager, "Manager");
  bindingCheck(check, controller, "TIMELOCK()", "timelock", boundTimelock, ctx.addresses.timelock, "Timelock");
});

function bindingCheck(
  check: StateCheck,
  controller: Address,
  view: string,
  subject: string,
  actual: Address | undefined,
  expected: Address | undefined,
  what: string,
): void {
  const {ctx} = check;
  check.snapshot[`GuardianController ${view}`] = actual === undefined ? READ_FAILED : labelled(ctx, actual);
  if (actual === undefined || !expected || sameAddress(actual, expected)) return;
  check.raise({
    check: subject,
    severity: "critical",
    title: `GuardianController ${view} is ${labelled(ctx, actual)}, not the ${what}`,
    fields: [
      addressField(ctx, "GuardianController", controller),
      addressField(ctx, view, actual),
      addressField(ctx, what, expected),
    ],
    links: [addressLink(ctx, controller, "GuardianController")],
    note:
      "The controller answers to another deployment's Guardian: lockdown and proposal cancellation do not protect " +
      "this one. Deploy a controller bound to this Manager and Timelock.",
  });
}
