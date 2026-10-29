// State rule for every watched CCIP pool: the authorities that can move pool liquidity (owner, rebalancer,
// rateLimitAdmin), and for live pools (registry pool, fundable migration target) the remote configuration the Manager
// pins in its pool spec and the rate limits of each supported chain (a Guardian lockdown, a disabled bucket and drift
// from the expected limits). A retired pool's lanes are unreachable, so they are only shown in the snapshot.
import {getAddress, type Address, type Hex} from "viem";

import {tokenPoolAbi} from "../abi/external.ts";
import {liquidityManagerAbi} from "../abi/generated.ts";
import {effectiveExpected, resolveRef, toUnits} from "../config.ts";
import type {AlertField, ChainContext} from "../types.ts";
import {addressField, addressLink, chainNameForSelector, sameAddress} from "./common.ts";
import {
  amount,
  defineStateRule,
  hexMinus,
  isLivePool,
  keyOf,
  labelled,
  READ_FAILED,
  remoteAddressText,
  type StateCheck,
} from "./state-common.ts";

export const POOL_RULE = "state-pool";

type Direction = "outbound" | "inbound";

interface Bucket {
  isEnabled: boolean;
  capacity: bigint;
  rate: bigint;
  tokens: bigint;
}

interface ExpectedLimit {
  enabled: boolean;
  capacity: bigint;
  rate: bigint;
}

export const poolStateRule = defineStateRule(POOL_RULE, async (check) => {
  await Promise.all(check.ctx.addresses.pools.map((pool) => checkPool(check, getAddress(pool))));
});

async function checkPool(check: StateCheck, pool: Address): Promise<void> {
  const {ctx} = check;
  const name = ctx.label(pool);
  const expected = effectiveExpected(ctx.config);
  const manager = ctx.addresses.manager;
  const call = {address: pool, abi: tokenPoolAbi} as const;
  const [owner, rebalancer, rateLimitAdmin, router, typeAndVersion, chains, specResult] = await Promise.all([
    check.read({...call, functionName: "owner"}),
    check.read({...call, functionName: "getRebalancer"}),
    check.read({...call, functionName: "getRateLimitAdmin"}),
    check.read({...call, functionName: "getRouter"}),
    check.read({...call, functionName: "typeAndVersion"}),
    check.read({...call, functionName: "getSupportedChains"}),
    manager
      ? check.read({address: manager, abi: liquidityManagerAbi, functionName: "getPoolSpec", args: [pool]})
      : undefined,
  ]);
  const links = [addressLink(ctx, pool)];
  const subject = keyOf(pool);

  // Authorities: each can redirect or unlock pool liquidity.
  const authorities: Array<{
    check: string;
    what: string;
    actual: Address | undefined;
    expected: Address | undefined;
    note: string;
  }> = [
    {
      check: "owner",
      what: "owner",
      actual: owner,
      expected: resolveRef(expected.poolOwner, ctx.addresses, ctx.config, {pool}),
      note: "The pool owner can set the rebalancer, Router, remote pools and rate limits, and move liquidity.",
    },
    {
      check: "rebalancer",
      what: "rebalancer",
      actual: rebalancer,
      expected: resolveRef(expected.rebalancer, ctx.addresses, ctx.config, {pool}),
      note:
        "The rebalancer can withdraw the whole pool inventory (withdrawLiquidity). Funding through the adapter fails.",
    },
    {
      check: "rate-limit-admin",
      what: "rateLimitAdmin",
      actual: rateLimitAdmin,
      expected: resolveRef(expected.rateLimitAdmin, ctx.addresses, ctx.config, {pool}),
      note:
        "The rateLimitAdmin can lift or zero the bridge rate limits; a Guardian lockdown through the " +
        "GuardianController no longer works. Funding through the adapter fails.",
    },
  ];
  for (const authority of authorities) {
    check.snapshot[`${name} ${authority.what}`] =
      authority.actual === undefined ? READ_FAILED : labelled(ctx, authority.actual);
    if (authority.actual === undefined || !authority.expected) continue;
    if (sameAddress(authority.actual, authority.expected)) continue;
    check.raise({
      check: authority.check,
      subject: `${subject}:${authority.check}`,
      severity: "critical",
      title:
        `${name} ${authority.what} is ${ctx.label(getAddress(authority.actual))}, ` +
        `expected ${ctx.label(authority.expected)}`,
      fields: [
        addressField(ctx, "Pool", pool),
        addressField(ctx, authority.what, authority.actual),
        addressField(ctx, "Expected", authority.expected),
      ],
      links,
      note: authority.note,
    });
  }
  if (router !== undefined) check.snapshot[`${name} Router`] = labelled(ctx, router);
  if (typeAndVersion !== undefined) check.snapshot[`${name} typeAndVersion`] = typeAndVersion;
  const chainNames = (selectors: readonly bigint[]) =>
    selectors.map((selector) => chainNameForSelector(ctx, selector)).join(", ") || "none";
  check.snapshot[`${name} supported chains`] = chains === undefined ? READ_FAILED : chainNames(chains);

  // Remote configuration pinned by the Manager's pool spec.
  const [spec, specSet] = specResult ?? [undefined, false];
  if (manager && specResult) check.snapshot[`${name} Manager spec`] = specSet ? "set" : "not set";
  const live = isLivePool(ctx, pool);
  if (spec && specSet && live) {
    const remote = spec.remoteChainSelector;
    const remoteName = chainNameForSelector(ctx, remote);
    const specField = (label: string, value: string): AlertField => ({label, value, code: true});
    if (router !== undefined && !sameAddress(router, spec.router)) {
      check.raise({
        check: "router",
        subject: `${subject}:router`,
        severity: "critical",
        title: `${name} Router changed to ${ctx.label(getAddress(router))}`,
        fields: [
          addressField(ctx, "Pool", pool),
          addressField(ctx, "Router", router),
          addressField(ctx, "Spec", spec.router),
        ],
        links,
        note: "The Router decides which OnRamps/OffRamps may lock and release pool liquidity. Funding fails.",
      });
    }
    if (typeAndVersion !== undefined && typeAndVersion !== spec.typeAndVersion) {
      check.raise({
        check: "type-and-version",
        subject: `${subject}:type-and-version`,
        severity: "critical",
        title: `${name} typeAndVersion is "${typeAndVersion}", spec requires "${spec.typeAndVersion}"`,
        fields: [
          addressField(ctx, "Pool", pool),
          specField("typeAndVersion", typeAndVersion),
          specField("Spec", spec.typeAndVersion),
        ],
        links,
        note: "The contract at the pool address is not the pinned pool version. Funding fails.",
      });
    }
    if (chains !== undefined && (chains.length !== 1 || chains[0] !== remote)) {
      check.raise({
        check: "chains",
        subject: `${subject}:chains`,
        severity: "critical",
        title: `${name} supported chains differ from the spec (${remoteName} only)`,
        fields: [
          addressField(ctx, "Pool", pool),
          specField("Supported", `${chainNames(chains)} (${chains.join(", ") || "-"})`),
          specField("Spec", `${remoteName} (${remote})`),
        ],
        links,
        note:
          "Pool liquidity is reachable from a lane the Manager did not approve, or the lane was removed. " +
          "Funding fails.",
      });
    }
    if (chains?.includes(remote)) await checkRemote(check, pool, remote, spec.remoteToken, spec.remotePools);
  }

  // Rate limits of every supported chain.
  if (chains) await Promise.all(chains.map((selector) => checkRateLimits(check, pool, selector, live)));
}

async function checkRemote(
  check: StateCheck,
  pool: Address,
  remote: bigint,
  specToken: Hex,
  specPools: readonly Hex[],
): Promise<void> {
  const {ctx} = check;
  const name = ctx.label(pool);
  const remoteName = chainNameForSelector(ctx, remote);
  const call = {address: pool, abi: tokenPoolAbi} as const;
  const [remoteToken, remotePools] = await Promise.all([
    check.read({...call, functionName: "getRemoteToken", args: [remote]}),
    check.read({...call, functionName: "getRemotePools", args: [remote]}),
  ]);
  const links = [addressLink(ctx, pool)];
  const subject = keyOf(pool);

  if (remoteToken !== undefined) {
    check.snapshot[`${name} remote token (${remoteName})`] = remoteAddressText(remoteToken);
    if (remoteToken.toLowerCase() !== specToken.toLowerCase()) {
      check.raise({
        check: "remote-token",
        subject: `${subject}:remote-token`,
        severity: "critical",
        title: `${name} remote token for ${remoteName} differs from the spec`,
        fields: [
          addressField(ctx, "Pool", pool),
          {label: "Remote token", value: remoteAddressText(remoteToken), code: true},
          {label: "Spec", value: remoteAddressText(specToken), code: true},
        ],
        links,
        note: "Incoming messages are matched against the wrong remote token. Funding fails.",
      });
    }
  }
  if (remotePools !== undefined) {
    check.snapshot[`${name} remote pools (${remoteName})`] = remotePools.map(remoteAddressText).join(", ") || "none";
    const added = hexMinus(remotePools, specPools);
    const removed = hexMinus(specPools, remotePools);
    if (added.length || removed.length) {
      const fields: AlertField[] = [addressField(ctx, "Pool", pool)];
      if (added.length) fields.push({label: "Added", value: added.map(remoteAddressText).join("\n"), code: true});
      if (removed.length) fields.push({label: "Removed", value: removed.map(remoteAddressText).join("\n"), code: true});
      check.raise({
        check: "remote-pools",
        subject: `${subject}:remote-pools`,
        severity: "critical",
        title: `${name} remote pools for ${remoteName} differ from the spec (+${added.length} / -${removed.length})`,
        fields,
        links,
        note: "An added remote pool can send messages that release liquidity from this pool. Funding fails.",
      });
    }
  }
}

async function checkRateLimits(check: StateCheck, pool: Address, selector: bigint, live: boolean): Promise<void> {
  const {ctx} = check;
  const name = ctx.label(pool);
  const chain = chainNameForSelector(ctx, selector);
  const call = {address: pool, abi: tokenPoolAbi, args: [selector]} as const;
  const [outbound, inbound] = await Promise.all([
    check.read({...call, functionName: "getCurrentOutboundRateLimiterState"}),
    check.read({...call, functionName: "getCurrentInboundRateLimiterState"}),
  ]);
  const expected = effectiveExpected(ctx.config).rateLimits;
  const decimals = ctx.global.token.decimals;
  const links = [addressLink(ctx, pool)];
  const subject = `${keyOf(pool)}:${selector}`;

  const buckets: Array<[Direction, Bucket | undefined]> = [
    ["outbound", outbound],
    ["inbound", inbound],
  ];
  const locked: Direction[] = [];
  for (const [direction, bucket] of buckets) {
    check.snapshot[`${name} ${direction} rate limit (${chain})`] =
      bucket === undefined ? READ_FAILED : bucketText(ctx, bucket, true);
    if (!bucket || !live) continue;
    if (bucket.isEnabled && bucket.capacity === 0n && bucket.rate === 0n) {
      locked.push(direction);
      continue;
    }
    const want = expected?.[direction];
    const target: ExpectedLimit | undefined = want && {
      enabled: want.enabled,
      capacity: toUnits(want.capacity, decimals),
      rate: toUnits(want.rate, decimals),
    };
    if (!bucket.isEnabled) {
      check.raise({
        check: "rate-limit-disabled",
        subject: `${subject}:${direction}`,
        severity: "critical",
        title: `${name} ${direction} rate limit for ${chain} is disabled (unlimited)`,
        fields: [addressField(ctx, "Pool", pool), {label: "Bucket", value: bucketText(ctx, bucket, false), code: true}],
        links,
        note: "Bridge transfers in this direction are unlimited; a compromised lane can drain the pool at once.",
      });
    } else if (
      target &&
      (bucket.isEnabled !== target.enabled || bucket.capacity !== target.capacity || bucket.rate !== target.rate)
    ) {
      check.raise({
        check: "rate-limit-mismatch",
        subject: `${subject}:${direction}`,
        severity: "high",
        title: `${name} ${direction} rate limit for ${chain} differs from the expected limit`,
        fields: [
          addressField(ctx, "Pool", pool),
          {label: "Current", value: bucketText(ctx, bucket, false), code: true},
          {label: "Expected", value: bucketText(ctx, {...target, isEnabled: target.enabled}, false), code: true},
        ],
        links,
        note: "Review the Timelock operation that changed it, or update expected.rateLimits.",
      });
    }
  }
  if (locked.length) {
    check.raise({
      check: "lockdown",
      subject: `${subject}:lockdown`,
      severity: "critical",
      title: `Bridge locked down on ${name} for ${chain} (${locked.join(" and ")})`,
      fields: [
        addressField(ctx, "Pool", pool),
        {label: "Locked directions", value: locked.join(", ")},
      ],
      links,
      note:
        "Rate limits are enabled with zero capacity and zero refill: no bridge transfers in these directions. " +
        "Restoring them needs a Timelock operation (setChainRateLimiterConfig starts the buckets empty).",
    });
  }
}

function bucketText(
  ctx: ChainContext,
  bucket: Omit<Bucket, "tokens"> & {tokens?: bigint},
  withTokens: boolean,
): string {
  if (!bucket.isEnabled) return "disabled (unlimited)";
  const parts = [`capacity ${amount(ctx, bucket.capacity)}`, `rate ${amount(ctx, bucket.rate)}/s`];
  if (withTokens && bucket.tokens !== undefined) parts.push(`available ${amount(ctx, bucket.tokens)}`);
  return `enabled, ${parts.join(", ")}`;
}
