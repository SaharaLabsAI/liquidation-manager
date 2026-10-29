// State rules for the contracts this repository does not deploy: the SAHARA token, the CCIP TokenAdminRegistry and the
// CCIP Router. Their owners can pause the token, remap the token to another pool, or change which OffRamps may release
// pool liquidity, so each is compared with the expected configuration every cycle.
import {getAddress, zeroAddress, type Address} from "viem";

import {routerAbi, saharaTokenAbi, tokenAdminRegistryAbi} from "../abi/external.ts";
import {liquidityManagerAbi} from "../abi/generated.ts";
import {effectiveExpected, resolveRef} from "../config.ts";
import {addressField, addressLink, chainNameForSelector, includesAddress, sameAddress} from "./common.ts";
import {
  defineStateRule,
  hexMinus,
  keyOf,
  labelled,
  READ_FAILED,
  remoteSelectorsOf,
  yesNo,
  type StateCheck,
} from "./state-common.ts";

export const TOKEN_RULE = "state-token";
export const REGISTRY_RULE = "state-registry";
export const ROUTER_RULE = "state-router";

/** Token `owner()` and `paused()`. */
export const tokenStateRule = defineStateRule(TOKEN_RULE, async (check) => {
  const {ctx} = check;
  const token = ctx.addresses.token;
  const expected = effectiveExpected(ctx.config);
  const call = {address: token, abi: saharaTokenAbi} as const;
  const [owner, paused] = await Promise.all([
    check.read({...call, functionName: "owner"}),
    check.read({...call, functionName: "paused"}),
  ]);
  const links = [addressLink(ctx, token, "Token")];

  check.snapshot["Token owner"] = owner === undefined ? READ_FAILED : labelled(ctx, owner);
  const expectedOwner = resolveRef(expected.tokenOwner, ctx.addresses, ctx.config);
  if (owner !== undefined && expectedOwner && !sameAddress(owner, expectedOwner)) {
    check.raise({
      check: "owner",
      severity: "critical",
      title: `Token owner is ${ctx.label(getAddress(owner))}, expected ${ctx.label(expectedOwner)}`,
      fields: [addressField(ctx, "Owner", owner), addressField(ctx, "Expected", expectedOwner)],
      links,
      note:
        "The token owner can pause SAHARA, halting transfers and bridge settlement on this chain. " +
        "verifyHandover() fails while the token is not owned by the Timelock.",
    });
  }

  check.snapshot["Token paused"] = paused === undefined ? READ_FAILED : yesNo(paused);
  if (paused !== undefined && paused !== expected.tokenPaused) {
    check.raise({
      check: "paused",
      severity: "critical",
      title: paused ? "SAHARA token is paused" : "SAHARA token is not paused (expected paused)",
      fields: [{label: "paused()", value: String(paused), code: true}],
      links,
      note: paused
        ? "Transfers, funding, recalls and CCIP bridge settlement on this chain are halted until the owner unpauses."
        : "The configuration expects the token to be paused (expected.tokenPaused).",
    });
  }
});

/** TokenAdminRegistry `getTokenConfig(token)`: administrator, pending administrator and pool mapping. */
export const registryStateRule = defineStateRule(REGISTRY_RULE, async (check) => {
  const {ctx} = check;
  const {registry, token} = ctx.addresses;
  const config = await check.read({
    address: registry,
    abi: tokenAdminRegistryAbi,
    functionName: "getTokenConfig",
    args: [token],
  });
  if (!config) {
    check.snapshot["Registry administrator"] = READ_FAILED;
    return;
  }
  const expected = effectiveExpected(ctx.config);
  const links = [addressLink(ctx, registry, "Registry")];

  check.snapshot["Registry administrator"] = labelled(ctx, config.administrator);
  check.snapshot["Registry pending administrator"] = labelled(ctx, config.pendingAdministrator);
  check.snapshot["Registry pool"] = labelled(ctx, config.tokenPool);

  const expectedAdmin = resolveRef(expected.registryAdmin, ctx.addresses, ctx.config);
  if (expectedAdmin && !sameAddress(config.administrator, expectedAdmin)) {
    check.raise({
      check: "admin",
      severity: "critical",
      title:
        `Registry administrator is ${ctx.label(getAddress(config.administrator))}, ` +
        `expected ${ctx.label(expectedAdmin)}`,
      fields: [
        addressField(ctx, "Administrator", config.administrator),
        addressField(ctx, "Expected", expectedAdmin),
      ],
      links,
      note: "The registry administrator can map SAHARA to any pool (setPool). verifyHandover() fails meanwhile.",
    });
  }

  if (!sameAddress(config.pendingAdministrator, zeroAddress)) {
    check.raise({
      check: "pending-admin",
      severity: "critical",
      title: `Registry admin transfer pending to ${ctx.label(getAddress(config.pendingAdministrator))}`,
      fields: [
        addressField(ctx, "Pending administrator", config.pendingAdministrator),
        addressField(ctx, "Administrator", config.administrator),
      ],
      links,
      note:
        "acceptAdminRole by the pending administrator hands over control of the pool mapping. " +
        "verifyHandover() fails (RegistryAdminTransferPending), blocking registerAdapter.",
    });
  }

  checkRegistryPool(check, config.tokenPool);
});

/**
 * With a Manager that has adapters, the registry must map the token to one of the registered pools (two coexist during
 * a migration). Otherwise it must map to the configured pool or a configured extra pool. `ctx.addresses.pools` cannot
 * be used: it always contains the registry pool itself.
 */
function checkRegistryPool(check: StateCheck, tokenPool: Address): void {
  const {ctx} = check;
  const links = [addressLink(ctx, ctx.addresses.registry, "Registry")];
  const registered = ctx.addresses.adapters.map((entry) => entry.pool);
  const configured = [ctx.config.contracts.pool, ...ctx.config.reserves.extraPools].filter(
    (pool): pool is Address => pool !== undefined,
  );

  if (sameAddress(tokenPool, zeroAddress)) {
    check.raise({
      check: "pool",
      severity: "critical",
      title: "Registry maps SAHARA to no pool",
      fields: [addressField(ctx, "Registry", ctx.addresses.registry)],
      links,
      note: "CCIP transfers of SAHARA to and from this chain fail until a pool is set.",
    });
    return;
  }
  const allowed = ctx.addresses.manager && registered.length ? registered : configured;
  if (!allowed.length || includesAddress(allowed, tokenPool)) return;
  check.raise({
    check: "pool",
    severity: "critical",
    title: ctx.addresses.manager && registered.length
      ? "Registry maps SAHARA to a pool not registered in the Manager"
      : "Registry maps SAHARA to an unexpected pool",
    fields: [
      addressField(ctx, "Registry pool", tokenPool),
      {label: "Expected one of", value: allowed.map((pool) => labelled(ctx, pool)).join("\n"), code: true},
    ],
    links: [...links, addressLink(ctx, tokenPool)],
    note:
      "Bridge transfers now lock and release through this pool. Funding the registered pool is blocked " +
      "(PoolNotActiveInRegistry) unless a migration approval covers it.",
  });
}

/** Router `getOnRamp(remote)` and the OffRamps authorised for the remote chain, against the expected set. */
export const routerStateRule = defineStateRule(ROUTER_RULE, async (check) => {
  const {ctx} = check;
  const router = ctx.addresses.router;
  if (!router) return;
  const expected = effectiveExpected(ctx.config);
  const remotes = remoteSelectorsOf(ctx, await specSelectors(check));
  if (!remotes.length) return;

  const call = {address: router, abi: routerAbi} as const;
  const [offRamps, ...onRamps] = await Promise.all([
    check.read({...call, functionName: "getOffRamps"}),
    ...remotes.map((selector) => check.read({...call, functionName: "getOnRamp", args: [selector]})),
  ]);
  const links = [addressLink(ctx, router, "Router")];

  remotes.forEach((selector, i) => {
    const chain = chainNameForSelector(ctx, selector);
    const onRamp = onRamps[i];
    check.snapshot[`Router OnRamp to ${chain}`] = onRamp === undefined ? READ_FAILED : labelled(ctx, onRamp);
    if (onRamp !== undefined && expected.onRamp && !sameAddress(onRamp, expected.onRamp)) {
      check.raise({
        check: "on-ramp",
        subject: `on-ramp:${selector}`,
        severity: "high",
        title: `Router OnRamp to ${chain} changed`,
        fields: [addressField(ctx, "OnRamp", onRamp), addressField(ctx, "Expected", expected.onRamp)],
        links,
        note: "Chainlink changed the OnRamp for this lane. Confirm with Chainlink, then update expected.onRamp.",
      });
    }

    if (!offRamps) {
      check.snapshot[`Router OffRamps from ${chain}`] = READ_FAILED;
      return;
    }
    const actual = offRamps
      .filter((entry) => entry.sourceChainSelector === selector)
      .map((entry) => getAddress(entry.offRamp));
    check.snapshot[`Router OffRamps from ${chain}`] = actual.length
      ? actual.map((offRamp) => labelled(ctx, offRamp)).join(", ")
      : "none";
    if (!expected.offRamps) return;
    const added = hexMinus(actual, expected.offRamps);
    const removed = hexMinus(expected.offRamps, actual);
    if (!added.length && !removed.length) return;
    const fields = [
      {label: "Authorised now", value: actual.map((a) => labelled(ctx, a)).join("\n") || "none", code: true},
    ];
    if (added.length) fields.push({label: "Added", value: added.map((a) => labelled(ctx, a)).join("\n"), code: true});
    if (removed.length) {
      fields.push({label: "Removed", value: removed.map((a) => labelled(ctx, a)).join("\n"), code: true});
    }
    check.raise({
      check: "off-ramps",
      subject: `off-ramps:${selector}`,
      severity: "high",
      title: `Router OffRamps from ${chain} changed (+${added.length} / -${removed.length})`,
      fields,
      links,
      note:
        "Chainlink changed the OffRamps authorised to release pool liquidity. Confirm the new ramps with Chainlink, " +
        "then update expected.offRamps.",
    });
  });
});

/** `remoteChainSelector` of every set Manager pool spec of a registered or registry pool. */
async function specSelectors(check: StateCheck): Promise<bigint[]> {
  const {ctx} = check;
  const manager = ctx.addresses.manager;
  if (!manager) return [];
  const pools = new Map<string, Address>();
  for (const pool of [...ctx.addresses.adapters.map((entry) => entry.pool), ctx.addresses.registryPool]) {
    if (!sameAddress(pool, zeroAddress)) pools.set(keyOf(pool), pool);
  }
  const specs = await Promise.all(
    [...pools.values()].map((pool) =>
      check.read({address: manager, abi: liquidityManagerAbi, functionName: "getPoolSpec", args: [pool]}),
    ),
  );
  return specs.flatMap((result) => (result && result[1] ? [result[0].remoteChainSelector] : []));
}
