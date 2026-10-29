// Event rules: configuration, authority and liquidity events of the Manager, GuardianController, pools, token,
// TokenAdminRegistry and Router (design §5, review response §7). Token flows and bridge legs are the flows rule's job,
// live-state assertions the state rules'. Every rule receives the union of all fetched logs, so each one checks the
// emitting address first: `OwnershipTransferred` has the same topic0 on the Manager, token, pools and Router.
//
// Attribution: the Manager emits the same event on the Guardian and the owner (Timelock) path, e.g.
// `suspendFundingOperator` vs `setFundingOperator(x, false)`. Guardian functions emit `GuardianAction` from their
// modifier, immediately before their single config event; owner calls run inside `Timelock.execute`, which emits
// `CallExecuted` after each call returns. So a config event right after a `GuardianAction` is a Guardian restriction,
// and any other one is attributed to the first later `CallExecuted` targeting the emitting contract.
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeEventTopics,
  getAddress,
  pad,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type Log,
} from "viem";

import {routerAbi, saharaTokenAbi, tokenAdminRegistryAbi, tokenPoolAbi} from "../abi/external.ts";
import {guardianControllerAbi, liquidityManagerAbi, saharaTimelockAbi} from "../abi/generated.ts";
import {effectiveExpected, resolveRef} from "../config.ts";
import {formatAmount, formatTimestamp} from "../format.ts";
import type {Alert, AlertField, BlockRange, ChainContext, EventRule, LogFilter, Severity} from "../types.ts";
import {
  addressField,
  chainNameForSelector,
  groupByTx,
  includesAddress,
  logKey,
  otherChainSelectors,
  sameAddress,
  txLink,
} from "./common.ts";

// ----------------------------------------------------------------------------------------------------------------
// Topics and decoders
// ----------------------------------------------------------------------------------------------------------------

function topic0(abi: Abi, eventName: string): Hex {
  const [topic] = encodeEventTopics({abi, eventName} as never) as Hex[];
  if (!topic) throw new Error(`no topic for ${eventName}`);
  return topic.toLowerCase() as Hex;
}

function topicsOf(abi: Abi, names: readonly string[]): Hex[] {
  return names.map((name) => topic0(abi, name));
}

function hasTopic0(log: Log, topics: ReadonlySet<string>): boolean {
  const topic = log.topics[0];
  return !!topic && topics.has(topic.toLowerCase());
}

const CALL_EXECUTED_TOPIC = topic0(saharaTimelockAbi, "CallExecuted");
const FLOW_TOPICS = new Set(topicsOf(liquidityManagerAbi, ["Funded", "Recalled"]));

const PROPOSAL_CANCELLED_TOPIC = topic0(guardianControllerAbi, "ProposalCancelled");
const POOL_LOCKED_DOWN_TOPIC = topic0(guardianControllerAbi, "PoolLockedDown");
const CONTROLLER_TOPICS = [PROPOSAL_CANCELLED_TOPIC, POOL_LOCKED_DOWN_TOPIC];
const CONTROLLER_TOPIC_SET = new Set<string>(CONTROLLER_TOPICS);

/** Pool events this module handles. The bridge legs (LockedOrBurned, ReleasedOrMinted, ...) belong to flows. */
const POOL_TOPICS = topicsOf(tokenPoolAbi, [
  "LiquidityAdded",
  "LiquidityRemoved",
  "LiquidityTransferred",
  "RebalancerSet",
  "RateLimitAdminSet",
  "RouterUpdated",
  "ChainAdded",
  "ChainConfigured",
  "ChainRemoved",
  "RemotePoolAdded",
  "RemotePoolRemoved",
  "AllowListAdd",
  "AllowListRemove",
  "ConfigChanged",
  "OwnershipTransferRequested",
  "OwnershipTransferred",
]);
const POOL_TOPIC_SET = new Set<string>(POOL_TOPICS);

const TOKEN_TOPICS = topicsOf(saharaTokenAbi, ["Paused", "Unpaused", "OwnershipTransferred"]);
const TOKEN_TOPIC_SET = new Set<string>(TOKEN_TOPICS);

const REGISTRY_TOPICS = topicsOf(tokenAdminRegistryAbi, [
  "PoolSet",
  "AdministratorTransferRequested",
  "AdministratorTransferred",
]);
const REGISTRY_TOPIC_SET = new Set<string>(REGISTRY_TOPICS);

const ROUTER_RAMP_TOPICS = topicsOf(routerAbi, ["OnRampSet", "OffRampAdded", "OffRampRemoved"]);
const ROUTER_OWNER_TOPICS = topicsOf(routerAbi, ["OwnershipTransferRequested", "OwnershipTransferred"]);
const ROUTER_TOPIC_SET = new Set<string>([...ROUTER_RAMP_TOPICS, ...ROUTER_OWNER_TOPICS]);

/** Manager function name by selector, to name the function behind a `GuardianAction`. */
const MANAGER_FUNCTIONS = new Map<string, string>(
  liquidityManagerAbi
    .filter((item) => item.type === "function")
    .map((item) => [toFunctionSelector(item).toLowerCase(), item.name]),
);

function decodeManager(log: Log) {
  return decodeEventLog({abi: liquidityManagerAbi, data: log.data, topics: log.topics, strict: true});
}

function decodeController(log: Log) {
  return decodeEventLog({abi: guardianControllerAbi, data: log.data, topics: log.topics, strict: true});
}

function decodePool(log: Log) {
  return decodeEventLog({abi: tokenPoolAbi, data: log.data, topics: log.topics, strict: true});
}

function decodeToken(log: Log) {
  return decodeEventLog({abi: saharaTokenAbi, data: log.data, topics: log.topics, strict: true});
}

function decodeRegistry(log: Log) {
  return decodeEventLog({abi: tokenAdminRegistryAbi, data: log.data, topics: log.topics, strict: true});
}

function decodeRouter(log: Log) {
  return decodeEventLog({abi: routerAbi, data: log.data, topics: log.topics, strict: true});
}

type ManagerEvent = ReturnType<typeof decodeManager>;
type PoolEvent = ReturnType<typeof decodePool>;
type RouterEvent = ReturnType<typeof decodeRouter>;

interface Decoded<E> {
  log: Log;
  event: E;
}

// ----------------------------------------------------------------------------------------------------------------
// Display helpers
// ----------------------------------------------------------------------------------------------------------------

function tokens(ctx: ChainContext, raw: bigint): string {
  return formatAmount(raw, ctx.global.token.decimals, ctx.global.token.symbol);
}

function perSecond(ctx: ChainContext, raw: bigint): string {
  return `${tokens(ctx, raw)}/s`;
}

function chainName(ctx: ChainContext, selector: bigint): string {
  return chainNameForSelector(ctx, selector);
}

function chainField(ctx: ChainContext, label: string, selector: bigint): AlertField {
  const name = chainNameForSelector(ctx, selector);
  return {label, value: name === selector.toString() ? name : `${name} (${selector})`};
}

/** A remote-chain address carried as `abi.encode(address)` bytes (pool specs, remote pools); raw hex otherwise. */
function remoteAddress(value: Hex): string {
  if (value.length !== 2 + 64) return value;
  try {
    const [address] = decodeAbiParameters([{type: "address"}], value);
    return getAddress(address);
  } catch {
    return value;
  }
}

interface RateLimitConfig {
  isEnabled: boolean;
  capacity: bigint;
  rate: bigint;
}

function isLockdown(config: RateLimitConfig): boolean {
  return config.isEnabled && config.capacity === 0n && config.rate === 0n;
}

function rateLimitText(ctx: ChainContext, config: RateLimitConfig): string {
  if (!config.isEnabled) return "disabled (unlimited)";
  const text = `capacity ${tokens(ctx, config.capacity)}, rate ${perSecond(ctx, config.rate)}`;
  return isLockdown(config) ? `${text} (locked down)` : text;
}

function isZeroAddress(address: string): boolean {
  return sameAddress(address, zeroAddress);
}

function warnLog(ctx: ChainContext, message: string, log: Log, error: unknown): void {
  ctx.log.warn(message, {error, tx: log.transactionHash, logIndex: log.logIndex, address: log.address});
}

// ----------------------------------------------------------------------------------------------------------------
// Timelock attribution
// ----------------------------------------------------------------------------------------------------------------

interface TimelockCall {
  id: Hex;
  index: bigint;
  target: Address;
  logIndex: number;
}

/** The Timelock `CallExecuted` logs of one transaction, in log order. */
function timelockCalls(ctx: ChainContext, txLogs: readonly Log[]): TimelockCall[] {
  const timelock = ctx.addresses.timelock;
  if (!timelock) return [];
  const calls: TimelockCall[] = [];
  for (const log of txLogs) {
    if (!sameAddress(log.address, timelock) || log.topics[0]?.toLowerCase() !== CALL_EXECUTED_TOPIC) continue;
    try {
      const {args} = decodeEventLog({
        abi: saharaTimelockAbi,
        eventName: "CallExecuted",
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      calls.push({id: args.id, index: args.index, target: args.target, logIndex: log.logIndex ?? 0});
    } catch (error) {
      warnLog(ctx, "events: cannot decode Timelock CallExecuted", log, error);
    }
  }
  return calls;
}

/**
 * The Timelock call that emitted `log`: OpenZeppelin emits `CallExecuted` after each call returns, so it is the first
 * later `CallExecuted` whose target is the emitting contract.
 */
function timelockCallFor(calls: readonly TimelockCall[], log: Log): TimelockCall | undefined {
  const logIndex = log.logIndex ?? -1;
  return calls.find((call) => call.logIndex > logIndex && sameAddress(call.target, log.address));
}

/** "Timelock operation: <id>" when a Timelock call produced `log`, else who we know it was not. */
function attributionField(ctx: ChainContext, call: TimelockCall | undefined): AlertField {
  if (call) {
    const label = call.index === 0n ? "Timelock operation" : `Timelock operation (call #${call.index})`;
    return {label, value: call.id, code: true};
  }
  if (!ctx.addresses.timelock) return {label: "Executed by", value: "unknown (Timelock address not resolved)"};
  return {label: "Executed by", value: "not a Timelock operation (no matching CallExecuted in this transaction)"};
}

// ----------------------------------------------------------------------------------------------------------------
// Remote selectors (Router filters)
// ----------------------------------------------------------------------------------------------------------------

/** Store namespace of this module: remote chain selectors of the Manager's pool specs, by lowercase pool. */
function eventsNamespace(chain: string): string {
  return `events:${chain}`;
}

interface EventsState {
  /** `null`: the Manager has no spec for the pool (read once, refreshed by PoolSpecSet). */
  specSelectors?: Record<string, bigint | null>;
}

function readEventsState(ctx: ChainContext): EventsState {
  return ctx.store.get<EventsState>(eventsNamespace(ctx.name), {});
}

function rememberSpecSelectors(ctx: ChainContext, entries: Record<string, bigint | null>): void {
  if (Object.keys(entries).length === 0) return;
  const state = readEventsState(ctx);
  ctx.store.set<EventsState>(eventsNamespace(ctx.name), {
    ...state,
    specSelectors: {...state.specSelectors, ...entries},
  });
}

/**
 * CCIP selectors of the counterpart lane: the other configured chains' selectors plus the `remoteChainSelector` of
 * the Manager's pool spec for every watched pool (learned from `getPoolSpec` and `PoolSpecSet`).
 */
export function remoteSelectors(ctx: ChainContext): Set<bigint> {
  const selectors = new Set<bigint>(otherChainSelectors(ctx));
  const specs = readEventsState(ctx).specSelectors ?? {};
  for (const [pool, selector] of Object.entries(specs)) {
    if (selector !== null && selector !== undefined && includesAddress(ctx.addresses.pools, pool)) {
      selectors.add(BigInt(selector));
    }
  }
  return selectors;
}

/** Reads the pool spec selector of registered pools not seen yet (once per pool; PoolSpecSet keeps it current). */
async function refreshSpecSelectors(ctx: ChainContext, blockNumber: bigint): Promise<void> {
  const manager = ctx.addresses.manager;
  if (!manager) return;
  const known = readEventsState(ctx).specSelectors ?? {};
  const found: Record<string, bigint | null> = {};
  for (const {pool} of ctx.addresses.adapters) {
    const key = pool.toLowerCase();
    if (key in known || key in found) continue;
    try {
      const [spec, isSet] = await ctx.client.readContract({
        address: manager,
        abi: liquidityManagerAbi,
        functionName: "getPoolSpec",
        args: [pool],
        blockNumber,
      });
      found[key] = isSet ? spec.remoteChainSelector : null;
    } catch (error) {
      ctx.log.warn("events: getPoolSpec failed; Router ramp filter uses the configured chains only", {error, pool});
    }
  }
  rememberSpecSelectors(ctx, found);
}

function selectorTopic(selector: bigint): Hex {
  return pad(toHex(selector), {size: 32});
}

function addressTopic(address: Address): Hex {
  return pad(address.toLowerCase() as Hex, {size: 32});
}

// ----------------------------------------------------------------------------------------------------------------
// Manager
// ----------------------------------------------------------------------------------------------------------------

const MANAGER_RULE = "manager";

type FlowEvent = Extract<ManagerEvent, {eventName: "Funded" | "Recalled"}>;

interface GuardianGroup {
  log: Log;
  guardian: Address;
  selector: Hex;
  /** The config event the Guardian function emitted (exactly one per function). */
  events: Array<Decoded<ManagerEvent>>;
}

interface OwnerGroup {
  log: Log;
  event: ManagerEvent;
  call: TimelockCall | undefined;
  /** Follow-on events of the same call, e.g. the operator roles `setGuardian` revokes from the new Guardian. */
  extra: Array<Decoded<ManagerEvent>>;
}

type ManagerItem =
  | {type: "guardian"; group: GuardianGroup}
  | {type: "owner"; group: OwnerGroup}
  | {type: "flow"; log: Log; event: FlowEvent};

/** Severity of a Manager config event on the owner (Timelock) path. */
function ownerSeverity(event: ManagerEvent): Severity {
  switch (event.eventName) {
    case "GuardianSet":
    case "PoolSpecSet":
    case "AdapterRegistered":
    case "AdapterReplaced":
    case "ReservesMigrated":
    case "OwnershipTransferStarted":
    case "OwnershipTransferred":
      return "critical";
    case "PoolMigrationApprovalSet":
      return isZeroAddress(event.args.sourcePool) ? "high" : "critical";
    case "FundingOperatorSet":
    case "RecallOperatorSet":
      return event.args.enabled ? "critical" : "high";
    default:
      return "high";
  }
}

/** One-line description and detail fields of a Manager config event. */
function describeManagerEvent(ctx: ChainContext, event: ManagerEvent): {title: string; fields: AlertField[]} {
  switch (event.eventName) {
    case "GuardianSet": {
      const {previousGuardian, newGuardian} = event.args;
      return {
        title: isZeroAddress(newGuardian)
          ? "Manager Guardian removed"
          : `Manager Guardian set to ${ctx.label(newGuardian)}`,
        fields: [
          addressField(ctx, "Previous Guardian", previousGuardian),
          addressField(ctx, "New Guardian", newGuardian),
        ],
      };
    }
    case "FundingOperatorSet":
    case "RecallOperatorSet": {
      const {operator, enabled} = event.args;
      const role = event.eventName === "FundingOperatorSet" ? "Funding" : "Recall";
      return {
        title: `${role} operator ${enabled ? "granted" : "revoked"}: ${ctx.label(operator)}`,
        fields: [addressField(ctx, `${role} operator`, operator), {label: "Enabled", value: String(enabled)}],
      };
    }
    case "FundingPausedSet":
      return {title: event.args.paused ? "Funding paused" : "Funding unpaused", fields: []};
    case "RecallPausedSet":
      return {title: event.args.paused ? "Recall paused" : "Recall unpaused", fields: []};
    case "MaxFundingPerCallSet": {
      const value = tokens(ctx, event.args.maxFundingPerCall);
      return {title: `Max funding per call set to ${value}`, fields: [{label: "Max per call", value, code: true}]};
    }
    case "AggregateFundingBudgetSet": {
      const {capacity, rate} = event.args;
      return {
        title: `Aggregate funding budget set to ${tokens(ctx, capacity)}`,
        fields: [
          {label: "Capacity", value: tokens(ctx, capacity), code: true},
          {label: "Refill rate", value: perSecond(ctx, rate), code: true},
        ],
      };
    }
    case "PoolFundingBudgetSet": {
      const {pool, capacity, rate} = event.args;
      return {
        title: `Funding budget of ${ctx.label(pool)} set to ${tokens(ctx, capacity)}`,
        fields: [
          addressField(ctx, "Pool", pool),
          {label: "Capacity", value: tokens(ctx, capacity), code: true},
          {label: "Refill rate", value: perSecond(ctx, rate), code: true},
        ],
      };
    }
    case "RecallLimitsSet": {
      const {maxRecallPerCall, capacity, rate} = event.args;
      return {
        title: `Recall limits set: ${tokens(ctx, maxRecallPerCall)} per call, ${tokens(ctx, capacity)} budget`,
        fields: [
          {label: "Max per call", value: tokens(ctx, maxRecallPerCall), code: true},
          {label: "Capacity", value: tokens(ctx, capacity), code: true},
          {label: "Refill rate", value: perSecond(ctx, rate), code: true},
        ],
      };
    }
    case "PoolSpecSet": {
      const {pool, spec} = event.args;
      return {
        title: `Pool spec set for ${ctx.label(pool)}`,
        fields: [
          addressField(ctx, "Pool", pool),
          {label: "typeAndVersion", value: spec.typeAndVersion},
          addressField(ctx, "Router", spec.router),
          chainField(ctx, "Remote chain", spec.remoteChainSelector),
          {label: "Remote token", value: remoteAddress(spec.remoteToken), code: true},
          {label: "Remote pools", value: spec.remotePools.map(remoteAddress).join(", ") || "none", code: true},
          addressField(ctx, "Rate limit admin", spec.rateLimitAdmin),
        ],
      };
    }
    case "PoolThresholdsSet": {
      const {pool, minimum, refillTrigger, refillTarget} = event.args;
      return {
        title: `Thresholds of ${ctx.label(pool)} set: minimum ${tokens(ctx, minimum)}`,
        fields: [
          addressField(ctx, "Pool", pool),
          {label: "Minimum", value: tokens(ctx, minimum), code: true},
          {label: "Refill trigger", value: tokens(ctx, refillTrigger), code: true},
          {label: "Refill target", value: tokens(ctx, refillTarget), code: true},
        ],
      };
    }
    case "PoolMigrationApprovalSet": {
      const {pool, sourcePool} = event.args;
      const revoked = isZeroAddress(sourcePool);
      return {
        title: revoked
          ? `Migration approval of ${ctx.label(pool)} revoked`
          : `Migration approved: ${ctx.label(pool)} may be funded while the registry maps ${ctx.label(sourcePool)}`,
        fields: [addressField(ctx, "Pool", pool), addressField(ctx, "Source pool", sourcePool)],
      };
    }
    case "AdapterRegistered": {
      const {adapterId, adapter, pool} = event.args;
      return {
        title: `Adapter #${adapterId} registered for ${ctx.label(pool)}`,
        fields: [addressField(ctx, `Adapter #${adapterId}`, adapter), addressField(ctx, "Pool", pool)],
      };
    }
    case "AdapterReplaced": {
      const {adapterId, previousAdapter, newAdapter} = event.args;
      return {
        title: `Adapter #${adapterId} replaced by ${ctx.label(newAdapter)}`,
        fields: [addressField(ctx, "Previous adapter", previousAdapter), addressField(ctx, "New adapter", newAdapter)],
      };
    }
    case "AdapterStatusSet": {
      const {adapterId, fundingEnabled, recallEnabled} = event.args;
      const onOff = (enabled: boolean) => (enabled ? "enabled" : "disabled");
      const status = `funding ${onOff(fundingEnabled)}, recall ${onOff(recallEnabled)}`;
      return {title: `Adapter #${adapterId}: ${status}`, fields: [{label: `Adapter #${adapterId}`, value: status}]};
    }
    case "ReservesMigrated": {
      const {to, amount} = event.args;
      return {
        title: `Manager reserves migrated: ${tokens(ctx, amount)} to ${ctx.label(to)}`,
        fields: [{label: "Amount", value: tokens(ctx, amount), code: true}, addressField(ctx, "To", to)],
      };
    }
    case "TokenRecovered": {
      const {token, to, amount} = event.args;
      return {
        title: `Manager recovered a non-reserve token to ${ctx.label(to)}`,
        fields: [
          addressField(ctx, "Token", token),
          addressField(ctx, "To", to),
          {label: "Amount (base units)", value: amount.toString(), code: true},
        ],
      };
    }
    case "OwnershipTransferStarted":
      return {
        title: `Manager ownership transfer started to ${ctx.label(event.args.newOwner)}`,
        fields: [
          addressField(ctx, "Current owner", event.args.previousOwner),
          addressField(ctx, "Pending owner", event.args.newOwner),
        ],
      };
    case "OwnershipTransferred":
      return {
        title: `Manager ownership transferred to ${ctx.label(event.args.newOwner)}`,
        fields: [
          addressField(ctx, "Previous owner", event.args.previousOwner),
          addressField(ctx, "New owner", event.args.newOwner),
        ],
      };
    default:
      return {title: `Manager ${event.eventName}`, fields: []};
  }
}

const GUARDIAN_TITLES: Record<string, string> = {
  pauseFunding: "Guardian paused funding",
  pauseRecall: "Guardian paused recall",
  suspendFundingOperator: "Guardian suspended a funding operator",
  suspendRecallOperator: "Guardian suspended a recall operator",
  restrictAdapter: "Guardian restricted an adapter",
  revokePoolMigrationApproval: "Guardian revoked a pool migration approval",
  reduceMaxFundingPerCall: "Guardian reduced the max funding per call",
  reduceAggregateFundingBudget: "Guardian reduced the aggregate funding budget",
  reducePoolFundingBudget: "Guardian reduced a pool funding budget",
  reduceRecallLimits: "Guardian reduced the recall limits",
  raisePoolMinimum: "Guardian raised a pool minimum",
};

type BudgetEvent = Extract<
  ManagerEvent,
  {eventName: "AggregateFundingBudgetSet" | "PoolFundingBudgetSet" | "RecallLimitsSet"}
>;

/**
 * A (0, 0) budget event. The Manager emits it alike for a never-configured budget (left unconfigured, so its first
 * configuration starts full) and a configured one (reconfigured to 0, so a restore starts empty); any other reduction
 * needs a configured budget.
 */
function zeroBudgetEvent(event: ManagerEvent | undefined): BudgetEvent | undefined {
  if (
    (event?.eventName === "AggregateFundingBudgetSet" || event?.eventName === "PoolFundingBudgetSet" ||
      event?.eventName === "RecallLimitsSet") &&
    event.args.capacity === 0n &&
    event.args.rate === 0n
  ) {
    return event;
  }
  return undefined;
}

/** Capacity of the reduced budget at the block before `log` (undefined when the read fails). */
async function capacityBefore(
  ctx: ChainContext,
  manager: Address,
  log: Log,
  event: BudgetEvent,
): Promise<bigint | undefined> {
  if (log.blockNumber === null) return undefined;
  const blockNumber = log.blockNumber - 1n;
  try {
    let budget: {capacity: bigint};
    if (event.eventName === "PoolFundingBudgetSet") {
      budget = await ctx.client.readContract({
        address: manager,
        abi: liquidityManagerAbi,
        functionName: "getPoolFundingBudget",
        args: [event.args.pool],
        blockNumber,
      });
    } else {
      budget = await ctx.client.readContract({
        address: manager,
        abi: liquidityManagerAbi,
        functionName: event.eventName === "AggregateFundingBudgetSet" ? "getAggregateFundingBudget" : "getRecallBudget",
        blockNumber,
      });
    }
    return budget.capacity;
  } catch (error) {
    warnLog(ctx, "events: cannot read the budget before a (0, 0) Guardian reduction", log, error);
    return undefined;
  }
}

/** `before`: capacity of the budget before a (0, 0) reduction (undefined when unknown). */
function guardianNote(fn: string | undefined, event: ManagerEvent | undefined, before: bigint | undefined): string {
  const notes = ["Guardian actions only restrict; undoing this needs a Timelock operation."];
  if (fn === "raisePoolMinimum") {
    notes.push(
      "The minimum may now exceed the published refill trigger/target: keepers fund up to max(minimum, trigger).",
    );
  }
  if (zeroBudgetEvent(event)) {
    const configured = "A configured budget stays configured: a Timelock restore starts empty and refills at its rate.";
    const unconfigured =
      "A (0, 0) reduction of a never-configured budget leaves it unconfigured: its first configuration would start " +
      "full, so cancel a queued first configuration instead.";
    if (before === undefined) notes.push(`Capacity before unknown (read failed). ${unconfigured} ${configured}`);
    else if (before > 0n) notes.push(`The budget had capacity > 0 before. ${configured}`);
    else notes.push(`The budget had capacity 0 before, so it was probably never configured. ${unconfigured}`);
  }
  return notes.join(" ");
}

function guardianAlert(ctx: ChainContext, txHash: Hex, group: GuardianGroup, before?: bigint): Alert {
  const fn = MANAGER_FUNCTIONS.get(group.selector.toLowerCase());
  const fields: AlertField[] = [
    addressField(ctx, "Guardian", group.guardian),
    {label: "Function", value: fn ? `LiquidityManager.${fn}` : `unknown selector ${group.selector}`, code: true},
  ];
  for (const {event} of group.events) {
    const described = describeManagerEvent(ctx, event);
    fields.push({label: "Effect", value: described.title}, ...described.fields);
  }
  if (zeroBudgetEvent(group.events[0]?.event)) {
    const value = before === undefined ? "unknown (read failed)" : tokens(ctx, before);
    fields.push({label: "Capacity before", value, code: before !== undefined});
  }
  return {
    key: logKey(ctx, MANAGER_RULE, group.log),
    kind: "event",
    severity: "high",
    rule: "manager.guardian-action",
    chain: ctx.name,
    title: (fn && GUARDIAN_TITLES[fn]) ?? `Guardian action ${fn ?? group.selector}`,
    fields,
    links: [txLink(ctx, txHash)],
    note: guardianNote(fn, group.events[0]?.event, before),
  };
}

function ownerAlert(ctx: ChainContext, txHash: Hex, group: OwnerGroup): Alert {
  const described = describeManagerEvent(ctx, group.event);
  let severity = ownerSeverity(group.event);
  const fields: AlertField[] = [...described.fields];
  for (const {event} of group.extra) fields.push({label: "Also", value: describeManagerEvent(ctx, event).title});
  fields.push(attributionField(ctx, group.call));
  let note: string | undefined;
  if (!group.call && ctx.addresses.timelock) {
    // Only the owner can emit these, so the owner is not the Timelock (or this is the deployment transaction).
    severity = "critical";
    note = "Manager configuration changed outside the Timelock: check Manager.owner() now.";
  }
  return {
    key: logKey(ctx, MANAGER_RULE, group.log),
    kind: "event",
    severity,
    rule: "manager.config",
    chain: ctx.name,
    title: described.title,
    fields,
    links: [txLink(ctx, txHash)],
    note,
  };
}

function flowAlert(ctx: ChainContext, txHash: Hex, log: Log, event: FlowEvent): Alert {
  const {adapterId, pool, operator, adapter, amount} = event.args;
  const funded = event.eventName === "Funded";
  return {
    key: logKey(ctx, MANAGER_RULE, log),
    kind: "event",
    severity: "info",
    rule: funded ? "manager.funded" : "manager.recalled",
    chain: ctx.name,
    title: funded
      ? `Funded ${ctx.label(pool)}: ${tokens(ctx, amount)}`
      : `Recalled from ${ctx.label(pool)}: ${tokens(ctx, amount)}`,
    fields: [
      {label: "Amount", value: tokens(ctx, amount), code: true},
      addressField(ctx, "Pool", pool),
      addressField(ctx, `Adapter #${adapterId}`, adapter),
      addressField(ctx, "Operator", operator),
    ],
    links: [txLink(ctx, txHash)],
  };
}

/** Whether `event` is an operator revocation `setGuardian` performs for the new Guardian in the same call. */
function isGuardianRoleRevocation(event: ManagerEvent, newGuardian: Address): boolean {
  return (
    (event.eventName === "FundingOperatorSet" || event.eventName === "RecallOperatorSet") &&
    !event.args.enabled &&
    sameAddress(event.args.operator, newGuardian)
  );
}

async function processManagerTx(
  ctx: ChainContext,
  manager: Address,
  txHash: Hex,
  txLogs: readonly Log[],
): Promise<void> {
  const calls = timelockCalls(ctx, txLogs);
  const items: ManagerItem[] = [];
  // A GuardianAction waiting for the one config event its function emits next.
  let open: GuardianGroup | undefined;
  let lastGuardianSet: {group: OwnerGroup; newGuardian: Address} | undefined;
  const specs: Record<string, bigint | null> = {};

  for (const log of txLogs) {
    if (sameAddress(log.address, ctx.addresses.timelock) && log.topics[0]?.toLowerCase() === CALL_EXECUTED_TOPIC) {
      open = undefined;
      lastGuardianSet = undefined;
      continue;
    }
    if (!sameAddress(log.address, manager)) continue;
    let event: ManagerEvent;
    try {
      event = decodeManager(log);
    } catch (error) {
      warnLog(ctx, "events: cannot decode Manager log", log, error);
      continue;
    }
    switch (event.eventName) {
      case "GuardianAction":
        open = {log, guardian: event.args.guardian, selector: event.args.selector, events: []};
        items.push({type: "guardian", group: open});
        break;
      case "Funded":
      case "Recalled":
        open = undefined;
        items.push({type: "flow", log, event});
        break;
      default: {
        if (event.eventName === "PoolSpecSet") {
          specs[event.args.pool.toLowerCase()] = event.args.spec.remoteChainSelector;
        }
        if (open) {
          open.events.push({log, event});
          open = undefined;
          break;
        }
        const call = timelockCallFor(calls, log);
        if (
          lastGuardianSet &&
          lastGuardianSet.group.call === call &&
          isGuardianRoleRevocation(event, lastGuardianSet.newGuardian)
        ) {
          lastGuardianSet.group.extra.push({log, event});
          break;
        }
        const group: OwnerGroup = {log, event, call, extra: []};
        items.push({type: "owner", group});
        lastGuardianSet = event.eventName === "GuardianSet" ? {group, newGuardian: event.args.newGuardian} : undefined;
      }
    }
  }

  rememberSpecSelectors(ctx, specs);
  for (const item of items) {
    try {
      if (item.type === "guardian") {
        const [first] = item.group.events;
        const budget = zeroBudgetEvent(first?.event);
        const before = first && budget ? await capacityBefore(ctx, manager, first.log, budget) : undefined;
        ctx.alerter.emit(guardianAlert(ctx, txHash, item.group, before));
      } else if (item.type === "owner") ctx.alerter.emit(ownerAlert(ctx, txHash, item.group));
      else ctx.alerter.emit(flowAlert(ctx, txHash, item.log, item.event));
    } catch (error) {
      ctx.log.warn("events: cannot build Manager alert", {error, tx: txHash});
    }
  }
}

/**
 * Manager events: Funded/Recalled (info), one high alert per GuardianAction with the config event it caused, and
 * owner-path config events (critical for authority and fund movements, high otherwise).
 */
export const managerEventsRule: EventRule = {
  id: MANAGER_RULE,
  filters(ctx: ChainContext): LogFilter[] {
    const {manager, timelock} = ctx.addresses;
    const filters: LogFilter[] = [];
    if (manager) filters.push({address: manager});
    // Timelock attribution for every rule of this module (also before a Manager exists) must not depend on the
    // timelock rule being wired; the scanner dedupes overlapping logs.
    if (timelock) filters.push({address: timelock, topics: [CALL_EXECUTED_TOPIC]});
    return filters;
  },
  async onLogs(ctx: ChainContext, logs: Log[]): Promise<void> {
    const manager = ctx.addresses.manager;
    if (!manager) return;
    for (const [txHash, txLogs] of groupByTx(logs)) {
      if (!txLogs.some((log) => sameAddress(log.address, manager))) continue;
      try {
        await processManagerTx(ctx, manager, txHash, txLogs);
      } catch (error) {
        ctx.log.warn("events: failed to process Manager transaction", {error, tx: txHash});
      }
    }
  },
};

// ----------------------------------------------------------------------------------------------------------------
// GuardianController
// ----------------------------------------------------------------------------------------------------------------

const CONTROLLER_RULE = "controller";

/** The fields this module reads from the timelock rule's pending-op records (store namespace `timelock:${chain}`). */
interface StoredTimelockOp {
  summary?: string;
  readyAt?: number;
  status?: string;
}

function storedTimelockOp(ctx: ChainContext, id: Hex): StoredTimelockOp | undefined {
  const state = ctx.store.get<{ops?: Record<string, StoredTimelockOp>}>(`timelock:${ctx.name}`, {ops: {}});
  const wanted = id.toLowerCase();
  for (const [key, op] of Object.entries(state.ops ?? {})) if (key.toLowerCase() === wanted) return op;
  return undefined;
}

function proposalCancelledAlert(ctx: ChainContext, txHash: Hex, log: Log, id: Hex, guardian: Address): Alert {
  const op = storedTimelockOp(ctx, id);
  const summary = typeof op?.summary === "string" ? op.summary : undefined;
  const fields: AlertField[] = [
    {label: "Operation id", value: id, code: true},
    {label: "Operation", value: summary ?? "not tracked by the monitor (scheduled before monitoring started?)"},
    addressField(ctx, "Guardian", guardian),
  ];
  if (typeof op?.readyAt === "number") fields.push({label: "Was executable at", value: formatTimestamp(op.readyAt)});
  const head = summary?.split("(")[0];
  return {
    key: logKey(ctx, CONTROLLER_RULE, log),
    kind: "event",
    severity: "high",
    rule: "controller.proposal-cancelled",
    chain: ctx.name,
    title: head ? `Guardian cancelled Timelock operation: ${head}` : "Guardian cancelled a Timelock operation",
    fields,
    links: [txLink(ctx, txHash)],
    note: "If this was not an agreed cancellation, the Governance Safe must re-propose the operation.",
  };
}

function lockdownAlert(
  ctx: ChainContext,
  txHash: Hex,
  log: Log,
  args: {pool: Address; remoteChainSelector: bigint; guardian: Address},
  txLogs: readonly Log[],
): Alert {
  const {pool, remoteChainSelector, guardian} = args;
  const fields: AlertField[] = [
    addressField(ctx, "Pool", pool),
    chainField(ctx, "Remote chain", remoteChainSelector),
    addressField(ctx, "Guardian", guardian),
  ];
  // Show the limits the pool now reports (its ChainConfigured is folded into this alert by the pool rule).
  for (const other of txLogs) {
    if (!sameAddress(other.address, pool) || !hasTopic0(other, POOL_TOPIC_SET)) continue;
    try {
      const event = decodePool(other);
      if (event.eventName === "ChainConfigured" && event.args.remoteChainSelector === remoteChainSelector) {
        fields.push(
          {label: "Outbound limit", value: rateLimitText(ctx, event.args.outboundRateLimiterConfig)},
          {label: "Inbound limit", value: rateLimitText(ctx, event.args.inboundRateLimiterConfig)},
        );
      }
    } catch {
      // Reported by the pool rule.
    }
  }
  return {
    key: logKey(ctx, CONTROLLER_RULE, log),
    kind: "event",
    severity: "critical",
    rule: "controller.lockdown",
    chain: ctx.name,
    title: `Bridge halted: Guardian locked down ${ctx.label(pool)} for ${chainName(ctx, remoteChainSelector)}`,
    fields,
    links: [txLink(ctx, txHash)],
    note:
      "Both rate-limit buckets are now enabled with zero capacity and zero refill: no bridge transfers through this " +
      "pool for that chain. Restoration needs a Timelock operation (pool owner setChainRateLimiterConfig; buckets " +
      "restart empty).",
  };
}

/** GuardianController: ProposalCancelled (high) and PoolLockedDown (critical). */
export const controllerEventsRule: EventRule = {
  id: CONTROLLER_RULE,
  filters(ctx: ChainContext): LogFilter[] {
    const controller = ctx.addresses.controller;
    return controller ? [{address: controller, topics: [CONTROLLER_TOPICS]}] : [];
  },
  async onLogs(ctx: ChainContext, logs: Log[]): Promise<void> {
    const controller = ctx.addresses.controller;
    if (!controller) return;
    for (const [txHash, txLogs] of groupByTx(logs)) {
      for (const log of txLogs) {
        if (!sameAddress(log.address, controller) || !hasTopic0(log, CONTROLLER_TOPIC_SET)) continue;
        try {
          const event = decodeController(log);
          if (event.eventName === "ProposalCancelled") {
            ctx.alerter.emit(proposalCancelledAlert(ctx, txHash, log, event.args.id, event.args.guardian));
          } else {
            ctx.alerter.emit(lockdownAlert(ctx, txHash, log, event.args, txLogs));
          }
        } catch (error) {
          warnLog(ctx, "events: cannot process GuardianController log", log, error);
        }
      }
    }
  },
};

// ----------------------------------------------------------------------------------------------------------------
// Pools
// ----------------------------------------------------------------------------------------------------------------

const POOL_RULE = "pool";

/** `${pool}:${selector}` of every PoolLockedDown the GuardianController emitted in the transaction. */
function lockdownsInTx(ctx: ChainContext, txLogs: readonly Log[]): Set<string> {
  const result = new Set<string>();
  const controller = ctx.addresses.controller;
  if (!controller) return result;
  for (const log of txLogs) {
    if (!sameAddress(log.address, controller) || log.topics[0]?.toLowerCase() !== POOL_LOCKED_DOWN_TOPIC) continue;
    try {
      const event = decodeController(log);
      if (event.eventName === "PoolLockedDown") {
        result.add(`${event.args.pool.toLowerCase()}:${event.args.remoteChainSelector}`);
      }
    } catch (error) {
      warnLog(ctx, "events: cannot decode PoolLockedDown", log, error);
    }
  }
  return result;
}

/** `${adapter}:${pool}` of every Manager Funded/Recalled in the transaction. */
function managerFlowsInTx(ctx: ChainContext, txLogs: readonly Log[]): Set<string> {
  const result = new Set<string>();
  const manager = ctx.addresses.manager;
  if (!manager) return result;
  for (const log of txLogs) {
    if (!sameAddress(log.address, manager) || !hasTopic0(log, FLOW_TOPICS)) continue;
    try {
      const event = decodeManager(log);
      if (event.eventName === "Funded" || event.eventName === "Recalled") {
        result.add(`${event.args.adapter.toLowerCase()}:${event.args.pool.toLowerCase()}`);
      }
    } catch (error) {
      warnLog(ctx, "events: cannot decode Manager flow log", log, error);
    }
  }
  return result;
}

function poolAlert(
  ctx: ChainContext,
  txHash: Hex,
  log: Log,
  alert: {severity: Severity; rule: string; title: string; fields: AlertField[]; note?: string},
): Alert {
  return {
    key: logKey(ctx, POOL_RULE, log),
    kind: "event",
    chain: ctx.name,
    links: [txLink(ctx, txHash)],
    ...alert,
  };
}

function liquidityAlert(
  ctx: ChainContext,
  txHash: Hex,
  log: Log,
  event: Extract<PoolEvent, {eventName: "LiquidityAdded" | "LiquidityRemoved"}>,
  flows: ReadonlySet<string>,
): Alert | undefined {
  const pool = getAddress(log.address);
  const {provider, amount} = event.args;
  const adapter = ctx.addresses.adapters.find((entry) => sameAddress(entry.pool, pool))?.adapter;
  // The Manager's Funded/Recalled alert covers liquidity moved by the pool's adapter. A Funded/Recalled naming the
  // provider covers an adapter replaced later in the scanned range.
  if (sameAddress(provider, adapter) || flows.has(`${provider.toLowerCase()}:${pool.toLowerCase()}`)) return undefined;
  const verb = event.eventName === "LiquidityAdded" ? "added to" : "removed from";
  // Before the handover no adapter is registered and the legacy rebalancer (expected.rebalancer) moves liquidity by
  // design: still worth a look, but not a page.
  const expectedRebalancer = resolveRef(effectiveExpected(ctx.config).rebalancer, ctx.addresses, ctx.config, {pool});
  if (!adapter && sameAddress(provider, expectedRebalancer)) {
    return poolAlert(ctx, txHash, log, {
      severity: "high",
      rule: "pool.liquidity",
      title: `Liquidity ${verb} ${ctx.label(pool)} by the expected rebalancer ${ctx.label(provider)}`,
      fields: [
        addressField(ctx, "Pool", pool),
        addressField(ctx, "Provider", provider),
        {label: "Amount", value: tokens(ctx, amount), code: true},
        {label: "Registered adapter", value: "none"},
      ],
      note: "No adapter is registered for this pool yet, so the configured rebalancer moves liquidity directly. Confirm the move was planned.",
    });
  }
  return poolAlert(ctx, txHash, log, {
    severity: "critical",
    rule: "pool.liquidity",
    title: `Liquidity ${verb} ${ctx.label(pool)} by ${ctx.label(provider)}, not its adapter`,
    fields: [
      addressField(ctx, "Pool", pool),
      addressField(ctx, "Provider", provider),
      {label: "Amount", value: tokens(ctx, amount), code: true},
      adapter ? addressField(ctx, "Registered adapter", adapter) : {label: "Registered adapter", value: "none"},
    ],
    note:
      "Only the pool's rebalancer can provide or withdraw liquidity, so someone other than the Manager's adapter " +
      "holds the rebalancer role. Check getRebalancer() and the Timelock queue.",
  });
}

function rateLimitAlert(
  ctx: ChainContext,
  txHash: Hex,
  log: Log,
  selector: bigint | undefined,
  configs: Array<{label: string; config: RateLimitConfig}>,
  call: TimelockCall | undefined,
): Alert {
  const pool = getAddress(log.address);
  const where = selector === undefined ? "" : ` for ${chainName(ctx, selector)}`;
  let change = "changed";
  if (configs.length > 0 && configs.every(({config}) => isLockdown(config))) change = "set to lockdown (bridge halted)";
  else if (configs.some(({config}) => !config.isEnabled)) change = "disabled (unlimited)";
  const fields: AlertField[] = [addressField(ctx, "Pool", pool)];
  if (selector !== undefined) fields.push(chainField(ctx, "Remote chain", selector));
  for (const {label, config} of configs) fields.push({label, value: rateLimitText(ctx, config)});
  fields.push(attributionField(ctx, call));
  return poolAlert(ctx, txHash, log, {
    severity: "high",
    rule: "pool.rate-limits",
    title: `Rate limits of ${ctx.label(pool)} ${change}${where}`,
    fields,
  });
}

/** Alert for a pool admin event other than liquidity and rate limits. */
function poolConfigAlert(
  ctx: ChainContext,
  txHash: Hex,
  log: Log,
  event: PoolEvent,
  call: TimelockCall | undefined,
  remotePools: Array<Decoded<PoolEvent>> = [],
): Alert | undefined {
  const pool = getAddress(log.address);
  const name = ctx.label(pool);
  let severity: Severity = "critical";
  let rule = "pool.config";
  let title: string;
  const fields: AlertField[] = [addressField(ctx, "Pool", pool)];
  switch (event.eventName) {
    case "LiquidityTransferred":
      title = `${tokens(ctx, event.args.amount)} transferred into ${name} from ${ctx.label(event.args.from)}`;
      fields.push(addressField(ctx, "From pool", event.args.from), {
        label: "Amount",
        value: tokens(ctx, event.args.amount),
        code: true,
      });
      break;
    case "RebalancerSet":
      title = `Rebalancer of ${name} changed to ${ctx.label(event.args.newRebalancer)}`;
      fields.push(
        addressField(ctx, "Previous rebalancer", event.args.oldRebalancer),
        addressField(ctx, "New rebalancer", event.args.newRebalancer),
      );
      break;
    case "RateLimitAdminSet":
      title = `Rate limit admin of ${name} changed to ${ctx.label(event.args.rateLimitAdmin)}`;
      fields.push(addressField(ctx, "New rate limit admin", event.args.rateLimitAdmin));
      break;
    case "RouterUpdated":
      title = `Router of ${name} changed to ${ctx.label(event.args.newRouter)}`;
      fields.push(
        addressField(ctx, "Previous router", event.args.oldRouter),
        addressField(ctx, "New router", event.args.newRouter),
      );
      break;
    case "ChainAdded":
      title = `${name} added remote chain ${chainName(ctx, event.args.remoteChainSelector)}`;
      fields.push(
        chainField(ctx, "Remote chain", event.args.remoteChainSelector),
        {label: "Remote token", value: remoteAddress(event.args.remoteToken), code: true},
        {label: "Outbound limit", value: rateLimitText(ctx, event.args.outboundRateLimiterConfig)},
        {label: "Inbound limit", value: rateLimitText(ctx, event.args.inboundRateLimiterConfig)},
      );
      for (const {event: added} of remotePools) {
        if (added.eventName === "RemotePoolAdded") {
          fields.push({label: "Remote pool", value: remoteAddress(added.args.remotePoolAddress), code: true});
        }
      }
      break;
    case "ChainRemoved":
      title = `${name} removed remote chain ${chainName(ctx, event.args.remoteChainSelector)}`;
      fields.push(chainField(ctx, "Remote chain", event.args.remoteChainSelector));
      break;
    case "RemotePoolAdded":
    case "RemotePoolRemoved": {
      const added = event.eventName === "RemotePoolAdded";
      const where = chainName(ctx, event.args.remoteChainSelector);
      title = `Remote pool ${added ? "added to" : "removed from"} ${name} for ${where}`;
      fields.push(chainField(ctx, "Remote chain", event.args.remoteChainSelector), {
        label: "Remote pool",
        value: remoteAddress(event.args.remotePoolAddress),
        code: true,
      });
      break;
    }
    case "AllowListAdd":
    case "AllowListRemove": {
      const added = event.eventName === "AllowListAdd";
      severity = "high";
      rule = "pool.allowlist";
      title = `${ctx.label(event.args.sender)} ${added ? "added to" : "removed from"} the allow list of ${name}`;
      fields.push(addressField(ctx, "Sender", event.args.sender));
      break;
    }
    case "OwnershipTransferRequested":
      title = `Ownership transfer of ${name} requested to ${ctx.label(event.args.to)}`;
      fields.push(
        addressField(ctx, "Current owner", event.args.from),
        addressField(ctx, "Pending owner", event.args.to),
      );
      break;
    case "OwnershipTransferred":
      title = `Ownership of ${name} transferred to ${ctx.label(event.args.to)}`;
      fields.push(addressField(ctx, "Previous owner", event.args.from), addressField(ctx, "New owner", event.args.to));
      break;
    default:
      return undefined;
  }
  fields.push(attributionField(ctx, call));
  return poolAlert(ctx, txHash, log, {severity, rule, title, fields});
}

function processPoolTx(ctx: ChainContext, txHash: Hex, txLogs: readonly Log[]): void {
  const lockdowns = lockdownsInTx(ctx, txLogs);
  const flows = managerFlowsInTx(ctx, txLogs);
  const calls = timelockCalls(ctx, txLogs);
  const emit = (alert: Alert | undefined) => {
    if (alert) ctx.alerter.emit(alert);
  };
  // setChainRateLimiterConfig emits ConfigChanged(outbound), ConfigChanged(inbound), then ChainConfigured;
  // applyChainUpdates emits RemotePoolAdded per remote pool, then ChainAdded. Each is reported once, by its last event.
  const pendingConfigs = new Map<string, Array<Decoded<PoolEvent>>>();
  const pendingRemotePools = new Map<string, Array<Decoded<PoolEvent>>>();

  for (const log of txLogs) {
    if (!includesAddress(ctx.addresses.pools, log.address) || !hasTopic0(log, POOL_TOPIC_SET)) continue;
    const pool = log.address.toLowerCase();
    try {
      const event = decodePool(log);
      switch (event.eventName) {
        case "LiquidityAdded":
        case "LiquidityRemoved":
          emit(liquidityAlert(ctx, txHash, log, event, flows));
          break;
        case "ConfigChanged":
          pendingConfigs.set(pool, [...(pendingConfigs.get(pool) ?? []), {log, event}]);
          break;
        case "ChainConfigured": {
          pendingConfigs.delete(pool);
          const selector = event.args.remoteChainSelector;
          if (lockdowns.has(`${pool}:${selector}`)) break; // folded into the controller's lockdown alert
          emit(
            rateLimitAlert(
              ctx,
              txHash,
              log,
              selector,
              [
                {label: "Outbound limit", config: event.args.outboundRateLimiterConfig},
                {label: "Inbound limit", config: event.args.inboundRateLimiterConfig},
              ],
              timelockCallFor(calls, log),
            ),
          );
          break;
        }
        case "RemotePoolAdded": {
          const key = `${pool}:${event.args.remoteChainSelector}`;
          pendingRemotePools.set(key, [...(pendingRemotePools.get(key) ?? []), {log, event}]);
          break;
        }
        case "ChainAdded": {
          const key = `${pool}:${event.args.remoteChainSelector}`;
          const remotePools = pendingRemotePools.get(key) ?? [];
          pendingRemotePools.delete(key);
          pendingConfigs.delete(pool); // the initial limits are in ChainAdded itself
          emit(poolConfigAlert(ctx, txHash, log, event, timelockCallFor(calls, log), remotePools));
          break;
        }
        default:
          emit(poolConfigAlert(ctx, txHash, log, event, timelockCallFor(calls, log)));
      }
    } catch (error) {
      warnLog(ctx, "events: cannot process pool log", log, error);
    }
  }

  // Leftovers: a remote pool added on its own, or a rate-limit change without its ChainConfigured.
  for (const entries of pendingRemotePools.values()) {
    for (const {log, event} of entries) emit(poolConfigAlert(ctx, txHash, log, event, timelockCallFor(calls, log)));
  }
  for (const entries of pendingConfigs.values()) {
    const [first] = entries;
    if (!first) continue;
    const configs = entries.flatMap(({event}) =>
      event.eventName === "ConfigChanged" ? [{label: "New limit", config: event.args.config}] : [],
    );
    emit(rateLimitAlert(ctx, txHash, first.log, undefined, configs, timelockCallFor(calls, first.log)));
  }
}

/**
 * Pool events of every watched pool: liquidity moved by anyone but the pool's adapter (critical), authority and
 * remote-configuration changes (critical), rate limits and the allow list (high).
 */
export const poolEventsRule: EventRule = {
  id: POOL_RULE,
  filters(ctx: ChainContext): LogFilter[] {
    const pools = ctx.addresses.pools;
    return pools.length > 0 ? [{address: [...pools], topics: [POOL_TOPICS]}] : [];
  },
  async onLogs(ctx: ChainContext, logs: Log[]): Promise<void> {
    if (ctx.addresses.pools.length === 0) return;
    for (const [txHash, txLogs] of groupByTx(logs)) {
      if (!txLogs.some((log) => includesAddress(ctx.addresses.pools, log.address))) continue;
      try {
        processPoolTx(ctx, txHash, txLogs);
      } catch (error) {
        ctx.log.warn("events: failed to process pool transaction", {error, tx: txHash});
      }
    }
  },
};

// ----------------------------------------------------------------------------------------------------------------
// Token
// ----------------------------------------------------------------------------------------------------------------

const TOKEN_RULE = "token";

/** SAHARA token: Paused (critical), Unpaused (high), OwnershipTransferred (critical). */
export const tokenEventsRule: EventRule = {
  id: TOKEN_RULE,
  filters(ctx: ChainContext): LogFilter[] {
    return [{address: ctx.addresses.token, topics: [TOKEN_TOPICS]}];
  },
  async onLogs(ctx: ChainContext, logs: Log[]): Promise<void> {
    const token = ctx.addresses.token;
    const symbol = ctx.global.token.symbol;
    for (const [txHash, txLogs] of groupByTx(logs)) {
      if (!txLogs.some((log) => sameAddress(log.address, token) && hasTopic0(log, TOKEN_TOPIC_SET))) continue;
      const calls = timelockCalls(ctx, txLogs);
      for (const log of txLogs) {
        if (!sameAddress(log.address, token) || !hasTopic0(log, TOKEN_TOPIC_SET)) continue;
        try {
          const event = decodeToken(log);
          const call = timelockCallFor(calls, log);
          const base = {
            key: logKey(ctx, TOKEN_RULE, log),
            kind: "event" as const,
            chain: ctx.name,
            links: [txLink(ctx, txHash)],
          };
          switch (event.eventName) {
            case "Paused":
              ctx.alerter.emit({
                ...base,
                severity: "critical",
                rule: "token.paused",
                title: `${symbol} token paused: transfers and bridge settlement halted`,
                fields: [addressField(ctx, "Paused by", event.args.account), attributionField(ctx, call)],
                note: "Every SAHARA transfer reverts, including pool locks/releases, funding and recall.",
              });
              break;
            case "Unpaused":
              ctx.alerter.emit({
                ...base,
                severity: "high",
                rule: "token.unpaused",
                title: `${symbol} token unpaused`,
                fields: [addressField(ctx, "Unpaused by", event.args.account), attributionField(ctx, call)],
              });
              break;
            case "OwnershipTransferred":
              ctx.alerter.emit({
                ...base,
                severity: "critical",
                rule: "token.owner",
                title: `${symbol} token ownership transferred to ${ctx.label(event.args.newOwner)}`,
                fields: [
                  addressField(ctx, "Previous owner", event.args.previousOwner),
                  addressField(ctx, "New owner", event.args.newOwner),
                  attributionField(ctx, call),
                ],
              });
              break;
            default:
              break;
          }
        } catch (error) {
          warnLog(ctx, "events: cannot process token log", log, error);
        }
      }
    }
  },
};

// ----------------------------------------------------------------------------------------------------------------
// TokenAdminRegistry
// ----------------------------------------------------------------------------------------------------------------

const REGISTRY_RULE = "registry";

/** TokenAdminRegistry entries of the SAHARA token: PoolSet and administrator transfers (critical). */
export const registryEventsRule: EventRule = {
  id: REGISTRY_RULE,
  filters(ctx: ChainContext): LogFilter[] {
    return [{address: ctx.addresses.registry, topics: [REGISTRY_TOPICS, addressTopic(ctx.addresses.token)]}];
  },
  async onLogs(ctx: ChainContext, logs: Log[]): Promise<void> {
    const {registry, token} = ctx.addresses;
    const symbol = ctx.global.token.symbol;
    const isOurs = (log: Log) => sameAddress(log.address, registry) && hasTopic0(log, REGISTRY_TOPIC_SET);
    for (const [txHash, txLogs] of groupByTx(logs)) {
      if (!txLogs.some(isOurs)) continue;
      const calls = timelockCalls(ctx, txLogs);
      for (const log of txLogs) {
        if (!isOurs(log)) continue;
        try {
          const event = decodeRegistry(log);
          if (!sameAddress(event.args.token, token)) continue; // another token's registry entry
          const attribution = attributionField(ctx, timelockCallFor(calls, log));
          const base = {
            key: logKey(ctx, REGISTRY_RULE, log),
            kind: "event" as const,
            severity: "critical" as const,
            chain: ctx.name,
            links: [txLink(ctx, txHash)],
          };
          switch (event.eventName) {
            case "PoolSet": {
              const {previousPool, newPool} = event.args;
              ctx.alerter.emit({
                ...base,
                rule: "registry.pool",
                title: isZeroAddress(newPool)
                  ? `Registry pool of ${symbol} removed: bridging disabled`
                  : `Registry now maps ${symbol} to ${ctx.label(newPool)}`,
                fields: [
                  addressField(ctx, "Previous pool", previousPool),
                  addressField(ctx, "New pool", newPool),
                  attribution,
                ],
                note: "CCIP uses the registry pool for every SAHARA transfer on this chain.",
              });
              break;
            }
            case "AdministratorTransferRequested":
              ctx.alerter.emit({
                ...base,
                rule: "registry.admin",
                title: `Registry admin transfer of ${symbol} requested to ${ctx.label(event.args.newAdmin)}`,
                fields: [
                  addressField(ctx, "Current admin", event.args.currentAdmin),
                  addressField(ctx, "Pending admin", event.args.newAdmin),
                  attribution,
                ],
              });
              break;
            case "AdministratorTransferred":
              ctx.alerter.emit({
                ...base,
                rule: "registry.admin",
                title: `Registry admin of ${symbol} is now ${ctx.label(event.args.newAdmin)}`,
                fields: [addressField(ctx, "New admin", event.args.newAdmin), attribution],
              });
              break;
            default:
              break;
          }
        } catch (error) {
          warnLog(ctx, "events: cannot process registry log", log, error);
        }
      }
    }
  },
};

// ----------------------------------------------------------------------------------------------------------------
// Router
// ----------------------------------------------------------------------------------------------------------------

const ROUTER_RULE = "router";

type RampEvent = Extract<RouterEvent, {eventName: "OnRampSet" | "OffRampAdded" | "OffRampRemoved"}>;

function rampAlert(ctx: ChainContext, txHash: Hex, ramps: Array<Decoded<RampEvent>>): Alert | undefined {
  const [first] = ramps;
  if (!first) return undefined;
  const fields: AlertField[] = ramps.map(({event}) => {
    if (event.eventName === "OnRampSet") {
      const where = chainName(ctx, event.args.destChainSelector);
      return {label: `OnRamp set (to ${where})`, value: getAddress(event.args.onRamp), code: true};
    }
    const where = chainName(ctx, event.args.sourceChainSelector);
    const verb = event.eventName === "OffRampAdded" ? "added" : "removed";
    return {label: `OffRamp ${verb} (from ${where})`, value: getAddress(event.args.offRamp), code: true};
  });
  const offRamps = ramps.some(({event}) => event.eventName !== "OnRampSet");
  const onRampChain = first.event.eventName === "OnRampSet" ? chainName(ctx, first.event.args.destChainSelector) : "";
  return {
    key: logKey(ctx, ROUTER_RULE, first.log),
    kind: "event",
    severity: "high",
    rule: "router.ramps",
    chain: ctx.name,
    title: offRamps
      ? "Chainlink changed the OffRamps authorised to release pool liquidity"
      : `Chainlink changed the OnRamp for ${onRampChain}`,
    fields,
    links: [txLink(ctx, txHash)],
    note: "Confirm this is an announced CCIP lane upgrade, then update expected.onRamp/offRamps in the config.",
  };
}

/**
 * Router changes on the counterpart lane: OnRampSet/OffRampAdded/OffRampRemoved for a remote selector and ownership
 * transfers (high). The Router is Chainlink's; these are changes to who may lock and release pool liquidity.
 */
export const routerEventsRule: EventRule = {
  id: ROUTER_RULE,
  filters(ctx: ChainContext): LogFilter[] {
    const router = ctx.addresses.router;
    if (!router) return [];
    const filters: LogFilter[] = [];
    const selectors = [...remoteSelectors(ctx)];
    // An empty topic OR-array matches anything on many nodes: without a remote selector, watch no ramps at all.
    if (selectors.length > 0) {
      filters.push({address: router, topics: [ROUTER_RAMP_TOPICS, selectors.map(selectorTopic)]});
    }
    filters.push({address: router, topics: [ROUTER_OWNER_TOPICS]});
    return filters;
  },
  async onLogs(ctx: ChainContext, logs: Log[], range: BlockRange): Promise<void> {
    const router = ctx.addresses.router;
    if (!router) return;
    try {
      await refreshSpecSelectors(ctx, range.to);
    } catch (error) {
      ctx.log.warn("events: cannot refresh pool spec selectors", {error});
    }
    const remote = remoteSelectors(ctx);
    for (const [txHash, txLogs] of groupByTx(logs)) {
      const ramps: Array<Decoded<RampEvent>> = [];
      for (const log of txLogs) {
        if (!sameAddress(log.address, router) || !hasTopic0(log, ROUTER_TOPIC_SET)) continue;
        try {
          const event = decodeRouter(log);
          switch (event.eventName) {
            case "OnRampSet":
              if (remote.has(event.args.destChainSelector)) ramps.push({log, event});
              break;
            case "OffRampAdded":
            case "OffRampRemoved":
              if (remote.has(event.args.sourceChainSelector)) ramps.push({log, event});
              break;
            case "OwnershipTransferRequested":
            case "OwnershipTransferred": {
              const requested = event.eventName === "OwnershipTransferRequested";
              ctx.alerter.emit({
                key: logKey(ctx, ROUTER_RULE, log),
                kind: "event",
                severity: "high",
                rule: "router.owner",
                chain: ctx.name,
                title: requested
                  ? `Router ownership transfer requested to ${ctx.label(event.args.to)}`
                  : `Router ownership transferred to ${ctx.label(event.args.to)}`,
                fields: [addressField(ctx, "From", event.args.from), addressField(ctx, "To", event.args.to)],
                links: [txLink(ctx, txHash)],
              });
              break;
            }
            default:
              break;
          }
        } catch (error) {
          warnLog(ctx, "events: cannot process Router log", log, error);
        }
      }
      try {
        const alert = rampAlert(ctx, txHash, ramps);
        if (alert) ctx.alerter.emit(alert);
      } catch (error) {
        ctx.log.warn("events: cannot build Router ramp alert", {error, tx: txHash});
      }
    }
  },
};

/** Every event rule of this module, in a stable order. */
export const eventRules: EventRule[] = [
  managerEventsRule,
  controllerEventsRule,
  poolEventsRule,
  tokenEventsRule,
  registryEventsRule,
  routerEventsRule,
];
