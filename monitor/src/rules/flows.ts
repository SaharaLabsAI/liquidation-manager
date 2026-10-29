// SAHARA flow monitoring (design §5: "monitor all SAHARA inflows", "abnormal outflows … trigger incident response").
// Every Transfer and Approval touching a reserve endpoint (Manager, adapters, pools, legacy wallets, extra endpoints)
// must be accounted for, in the same transaction, by an event of the contract that moved it: Manager
// Funded/Recalled/ReservesMigrated, pool LiquidityAdded/LiquidityRemoved/LiquidityTransferred and the bridge legs
// LockedOrBurned/ReleasedOrMinted. Explanations are accepted only from the Manager and the watched pools (anyone can
// emit a look-alike event), amounts must match exactly, and each explanation accounts for one transfer, so a second
// transfer hidden in a fund transaction is still flagged. Pool outflows also feed a per-pool sliding window (store
// namespace `flows:${chain}`) that raises a condition when the total reaches `limits.outflowWindowAmount`.
import {decodeEventLog, encodeEventTopics, getAddress, maxUint256, pad, type Address, type Hex, type Log} from "viem";

import {saharaTokenAbi, tokenPoolAbi} from "../abi/external.ts";
import {liquidityManagerAbi} from "../abi/generated.ts";
import {toUnits} from "../config.ts";
import {formatAmount, formatDuration, formatTimestamp} from "../format.ts";
import {
  SEVERITY_RANK,
  type Alert,
  type AlertField,
  type AlertLink,
  type BlockRange,
  type ChainContext,
  type EventRule,
  type LogFilter,
  type Severity,
} from "../types.ts";
import {
  addressField,
  addressLink,
  blockTimestamps,
  chainNameForSelector,
  groupByTx,
  includesAddress,
  logKey,
  sameAddress,
  txLink,
} from "./common.ts";

const RULE = "flows";

export type EndpointKind = "manager" | "adapter" | "pool" | "legacy" | "endpoint";

/** What accounts for one side of a transfer. */
export type ExplanationKind =
  | "fund"
  | "recall"
  | "migrate"
  | "provide"
  | "withdraw"
  | "transfer-liquidity"
  | "lock"
  | "release";

function topic0(abi: typeof saharaTokenAbi | typeof tokenPoolAbi | typeof liquidityManagerAbi, eventName: string): Hex {
  const [topic] = encodeEventTopics({abi, eventName} as never) as Hex[];
  if (!topic) throw new Error(`no topic for ${eventName}`);
  return topic;
}

const TRANSFER_TOPIC = topic0(saharaTokenAbi, "Transfer");
const APPROVAL_TOPIC = topic0(saharaTokenAbi, "Approval");
const MANAGER_TOPICS = ["Funded", "Recalled", "ReservesMigrated"].map((name) => topic0(liquidityManagerAbi, name));
// The 1.6.3-dev pool emits LockedOrBurned/ReleasedOrMinted; the pre-1.5 Locked/Released never fire (VERIFICATION.md).
const POOL_TOPICS = [
  "LiquidityAdded",
  "LiquidityRemoved",
  "LiquidityTransferred",
  "LockedOrBurned",
  "ReleasedOrMinted",
].map((name) => topic0(tokenPoolAbi, name));

function hasTopic(log: Log, topics: readonly Hex[]): boolean {
  const first = log.topics[0]?.toLowerCase();
  return !!first && topics.some((topic) => topic.toLowerCase() === first);
}

function addressTopic(address: Address): Hex {
  return pad(address.toLowerCase() as Hex, {size: 32});
}

export function flowsNamespace(chain: string): string {
  return `flows:${chain}`;
}

// ----------------------------------------------------------------------------------------------------------------
// Endpoints
// ----------------------------------------------------------------------------------------------------------------

/** Every reserve endpoint of the chain (checksummed, each once): `addresses.endpoints` plus every listed contract. */
export function flowEndpoints(ctx: ChainContext): Address[] {
  const a = ctx.addresses;
  const all = [
    ...a.endpoints,
    ...(a.manager ? [a.manager] : []),
    ...a.adapterHistory,
    ...a.adapters.map((entry) => entry.adapter),
    ...a.pools,
    ...a.legacyWallets,
  ];
  const unique = new Map<string, Address>();
  for (const address of all) unique.set(address.toLowerCase(), getAddress(address));
  return [...unique.values()];
}

export function endpointKind(ctx: ChainContext, address: string): EndpointKind | undefined {
  const a = ctx.addresses;
  if (sameAddress(address, a.manager)) return "manager";
  if (includesAddress(a.adapterHistory, address) || a.adapters.some((entry) => sameAddress(entry.adapter, address))) {
    return "adapter";
  }
  if (includesAddress(a.pools, address)) return "pool";
  if (includesAddress(a.legacyWallets, address)) return "legacy";
  if (includesAddress(a.endpoints, address)) return "endpoint";
  return undefined;
}

// ----------------------------------------------------------------------------------------------------------------
// Per-transaction decoding
// ----------------------------------------------------------------------------------------------------------------

interface Explanation {
  kind: ExplanationKind;
  /** The endpoint whose side of a transfer this accounts for. */
  endpoint: Address;
  direction: "in" | "out";
  /** The other party of the transfer; undefined matches anyone (a bridge lock does not name the user). */
  counterparty?: Address;
  amount: bigint;
  /** Bridge legs: remote chain and the OnRamp/OffRamp that called the pool. */
  remoteChainSelector?: bigint;
  ramp?: Address;
  used: boolean;
}

interface ExpectedApproval {
  owner: Address;
  spender: Address;
  amount: bigint;
  used: boolean;
}

interface TokenTransfer {
  log: Log;
  from: Address;
  to: Address;
  value: bigint;
}

interface TokenApproval {
  log: Log;
  owner: Address;
  spender: Address;
  value: bigint;
}

interface TxScan {
  hash: Hex;
  transfers: TokenTransfer[];
  approvals: TokenApproval[];
  explanations: Explanation[];
  expectedApprovals: ExpectedApproval[];
  /** One line per accounting event, shown with unexplained flows. */
  events: string[];
}

/** One pool outflow, for the sliding window. */
interface PoolOutflow {
  pool: Address;
  key: string;
  log: Log;
  amount: bigint;
  kind: ExplanationKind | "unexplained";
}

function amountText(ctx: ChainContext, raw: bigint): string {
  return formatAmount(raw, ctx.global.token.decimals, ctx.global.token.symbol);
}

/** Every significant digit, so an amount mismatch between a transfer and an event is visible. */
function exactAmount(ctx: ChainContext, raw: bigint): string {
  const {decimals, symbol} = ctx.global.token;
  return formatAmount(raw, decimals, symbol, decimals);
}

function decodeTx(ctx: ChainContext, hash: Hex, txLogs: readonly Log[]): TxScan {
  const scan: TxScan = {hash, transfers: [], approvals: [], explanations: [], expectedApprovals: [], events: []};
  const {token, manager, pools} = ctx.addresses;
  const explain = (entry: Omit<Explanation, "used">) => scan.explanations.push({...entry, used: false});
  for (const log of txLogs) {
    try {
      if (sameAddress(log.address, token) && hasTopic(log, [TRANSFER_TOPIC, APPROVAL_TOPIC])) {
        const event = decodeEventLog({abi: saharaTokenAbi, data: log.data, topics: log.topics, strict: true});
        if (event.eventName === "Transfer") {
          const {from, to, value} = event.args;
          scan.transfers.push({log, from: getAddress(from), to: getAddress(to), value});
        } else if (event.eventName === "Approval") {
          const {owner, spender, value} = event.args;
          scan.approvals.push({log, owner: getAddress(owner), spender: getAddress(spender), value});
        }
      } else if (manager && sameAddress(log.address, manager) && hasTopic(log, MANAGER_TOPICS)) {
        const event = decodeEventLog({abi: liquidityManagerAbi, data: log.data, topics: log.topics, strict: true});
        const self = getAddress(log.address);
        if (event.eventName === "Funded") {
          // Manager -> adapter, adapter approves the pool, pool pulls adapter -> pool, allowance reset to 0.
          const {adapterId, adapter, pool, amount} = event.args;
          explain({kind: "fund", endpoint: self, direction: "out", counterparty: adapter, amount});
          explain({kind: "fund", endpoint: adapter, direction: "in", counterparty: self, amount});
          explain({kind: "fund", endpoint: adapter, direction: "out", counterparty: pool, amount});
          explain({kind: "fund", endpoint: pool, direction: "in", counterparty: adapter, amount});
          scan.expectedApprovals.push({owner: adapter, spender: pool, amount, used: false});
          scan.events.push(`Funded ${exactAmount(ctx, amount)} to ${ctx.label(pool)} via adapter #${adapterId}`);
        } else if (event.eventName === "Recalled") {
          // Pool pays its rebalancer (adapter), which forwards to the Manager in the same call.
          const {adapterId, adapter, pool, amount} = event.args;
          explain({kind: "recall", endpoint: pool, direction: "out", counterparty: adapter, amount});
          explain({kind: "recall", endpoint: adapter, direction: "in", counterparty: pool, amount});
          explain({kind: "recall", endpoint: adapter, direction: "out", counterparty: self, amount});
          explain({kind: "recall", endpoint: self, direction: "in", counterparty: adapter, amount});
          scan.events.push(`Recalled ${exactAmount(ctx, amount)} from ${ctx.label(pool)} via adapter #${adapterId}`);
        } else if (event.eventName === "ReservesMigrated") {
          const {to, amount} = event.args;
          explain({kind: "migrate", endpoint: self, direction: "out", counterparty: to, amount});
          scan.events.push(`ReservesMigrated ${exactAmount(ctx, amount)} to ${ctx.label(to)}`);
        }
      } else if (includesAddress(pools, log.address) && hasTopic(log, POOL_TOPICS)) {
        const event = decodeEventLog({abi: tokenPoolAbi, data: log.data, topics: log.topics, strict: true});
        const pool = getAddress(log.address);
        const where = ctx.label(pool);
        switch (event.eventName) {
          case "LiquidityAdded": {
            const {provider, amount} = event.args;
            explain({kind: "provide", endpoint: pool, direction: "in", counterparty: provider, amount});
            scan.events.push(`${where} LiquidityAdded ${exactAmount(ctx, amount)} by ${ctx.label(provider)}`);
            break;
          }
          case "LiquidityRemoved": {
            const {provider, amount} = event.args;
            explain({kind: "withdraw", endpoint: pool, direction: "out", counterparty: provider, amount});
            scan.events.push(`${where} LiquidityRemoved ${exactAmount(ctx, amount)} to ${ctx.label(provider)}`);
            break;
          }
          case "LiquidityTransferred": {
            // transferLiquidity: this (new) pool pulled from `from` with withdrawLiquidity.
            const {from, amount} = event.args;
            explain({kind: "transfer-liquidity", endpoint: pool, direction: "in", counterparty: from, amount});
            scan.events.push(`${where} LiquidityTransferred ${exactAmount(ctx, amount)} from ${ctx.label(from)}`);
            break;
          }
          case "LockedOrBurned": {
            const {remoteChainSelector, token: eventToken, sender, amount} = event.args;
            if (!sameAddress(eventToken, token)) break;
            // `sender` is the OnRamp; the user is the `from` of the Transfer into the pool, which the event omits.
            explain({kind: "lock", endpoint: pool, direction: "in", amount, remoteChainSelector, ramp: sender});
            const lane = chainNameForSelector(ctx, remoteChainSelector);
            scan.events.push(`${where} LockedOrBurned ${exactAmount(ctx, amount)} to ${lane}`);
            break;
          }
          case "ReleasedOrMinted": {
            const {remoteChainSelector, token: eventToken, sender, recipient, amount} = event.args;
            if (!sameAddress(eventToken, token)) break;
            explain({
              kind: "release",
              endpoint: pool,
              direction: "out",
              counterparty: recipient,
              amount,
              remoteChainSelector,
              ramp: sender,
            });
            scan.events.push(
              `${where} ReleasedOrMinted ${exactAmount(ctx, amount)} from ` +
                `${chainNameForSelector(ctx, remoteChainSelector)} to ${ctx.label(recipient)}`,
            );
            break;
          }
          default:
            break;
        }
      }
    } catch (error) {
      ctx.log.warn("flows: cannot decode log", {error, tx: log.transactionHash, logIndex: log.logIndex});
    }
  }
  return scan;
}

/** Kinds reported by the Manager; preferred over the pool's own event for the same leg (names the operation). */
const MANAGER_KINDS: ReadonlySet<ExplanationKind> = new Set(["fund", "recall", "migrate"]);

/**
 * Consumes the explanation for one side of a transfer: a named counterparty first (Manager operations before pool
 * events), then an anonymous one (bridge lock), so a lock never absorbs a transfer that an exact event accounts for.
 */
function take(
  scan: TxScan,
  endpoint: Address,
  direction: "in" | "out",
  counterparty: Address,
  amount: bigint,
): Explanation | undefined {
  const fits = (e: Explanation) =>
    !e.used && e.direction === direction && e.amount === amount && sameAddress(e.endpoint, endpoint);
  const named = scan.explanations.filter(
    (e) => fits(e) && e.counterparty !== undefined && sameAddress(e.counterparty, counterparty),
  );
  const match =
    named.find((e) => MANAGER_KINDS.has(e.kind)) ??
    named[0] ??
    scan.explanations.find((e) => fits(e) && e.counterparty === undefined);
  if (match) match.used = true;
  return match;
}

// ----------------------------------------------------------------------------------------------------------------
// Classification
// ----------------------------------------------------------------------------------------------------------------

interface Finding {
  severity: Severity;
  rule: string;
  title: string;
  /** One line for the alert body. */
  detail: string;
  note?: string;
}

function largeThreshold(ctx: ChainContext): bigint | undefined {
  const value = ctx.config.limits.largeTransfer;
  return value === undefined ? undefined : toUnits(value, ctx.global.token.decimals);
}

function bridgeDetail(ctx: ChainContext, explanation: Explanation): string {
  const lane =
    explanation.remoteChainSelector === undefined ? "" : chainNameForSelector(ctx, explanation.remoteChainSelector);
  const ramp = explanation.ramp ? `, via ${ctx.label(explanation.ramp)}` : "";
  return explanation.kind === "lock" ? `bridge lock to ${lane}${ramp}` : `bridge release from ${lane}${ramp}`;
}

function largeBridgeFinding(ctx: ChainContext, transfer: TokenTransfer, explanation: Explanation): Finding | undefined {
  const threshold = largeThreshold(ctx);
  if (threshold === undefined || transfer.value < threshold) return undefined;
  const lock = explanation.kind === "lock";
  const pool = ctx.label(lock ? transfer.to : transfer.from);
  return {
    severity: "warning",
    rule: `${RULE}.large-transfer`,
    title: `Large bridge ${lock ? "lock into" : "release from"} ${pool}: ${amountText(ctx, transfer.value)}`,
    detail: `${bridgeDetail(ctx, explanation)}; at or above the large-transfer threshold ${amountText(ctx, threshold)}`,
    note: lock
      ? "Expect the matching release on the destination chain; reconciliation counts it as in flight until then."
      : "Check that a matching lock exists on the source chain (reconciliation R - I).",
  };
}

/** The sending endpoint's side of a transfer. */
function classifyOutflow(
  ctx: ChainContext,
  kind: EndpointKind,
  transfer: TokenTransfer,
  explanation: Explanation | undefined,
): Finding | undefined {
  const {from, to, value} = transfer;
  const amount = amountText(ctx, value);
  const name = ctx.label(from);
  switch (kind) {
    case "manager":
      if (explanation) return undefined;
      return {
        severity: "critical",
        rule: `${RULE}.manager-outflow`,
        title: `Unexplained outflow from Manager: ${amount}`,
        detail: `${amount} left the Manager to ${ctx.label(to)} without a matching Funded or ReservesMigrated event`,
        note:
          "The Manager moves SAHARA only in fund (Funded, to its adapter) and migrateReserves (ReservesMigrated). " +
          "Treat as a compromise: inspect the transaction, the token owner and paused(), and the Manager owner.",
      };
    case "adapter":
      if (explanation) return undefined;
      return {
        severity: "critical",
        rule: `${RULE}.adapter-outflow`,
        title: `Unexplained outflow from ${name}: ${amount}`,
        detail: `${amount} left ${name} to ${ctx.label(to)} outside a Funded/Recalled operation`,
        note: "An adapter only moves SAHARA inside Manager.fund and Manager.recall. Inspect the transaction now.",
      };
    case "pool":
      if (explanation?.kind === "release") return largeBridgeFinding(ctx, transfer, explanation);
      // A withdrawal to anything but the adapter (e.g. transferLiquidity to a new pool) is alerted by the pool rule.
      if (explanation) return undefined;
      return {
        severity: "critical",
        rule: `${RULE}.pool-outflow`,
        title: `Unexplained outflow from ${name}: ${amount}`,
        detail:
          `${amount} left ${name} to ${ctx.label(to)} without a matching ReleasedOrMinted (bridge release) or ` +
          "LiquidityRemoved (rebalancer withdrawal)",
        note:
          "Pool inventory backs bridge releases. If this is not understood, the Guardian can halt the bridge with " +
          "GuardianController.lockdown(pool); check reconciliation (R - I).",
      };
    case "legacy":
    case "endpoint":
      if (sameAddress(to, ctx.addresses.manager)) {
        return {
          severity: "info",
          rule: `${RULE}.reserve-migration`,
          title: `${name} moved ${amount} to the Manager`,
          detail: `${name} -> Manager: expected legacy reserve migration (handover step 3)`,
        };
      }
      return {
        severity: "high",
        rule: `${RULE}.endpoint-outflow`,
        title: `Outflow from ${name}: ${amount}`,
        detail: `${amount} left reserve endpoint ${name} to ${ctx.label(to)}`,
        note: "Reserve wallets should only send to the Manager (migration). Confirm with the wallet owners.",
      };
  }
}

/** The receiving endpoint's side of a transfer. */
function classifyInflow(
  ctx: ChainContext,
  kind: EndpointKind,
  transfer: TokenTransfer,
  explanation: Explanation | undefined,
): Finding | undefined {
  const {from, to, value} = transfer;
  const amount = amountText(ctx, value);
  const name = ctx.label(to);
  switch (kind) {
    case "manager":
      if (explanation) return undefined;
      return {
        severity: "info",
        rule: `${RULE}.manager-inflow`,
        title: `Direct inflow to Manager: ${amount}`,
        detail: `${amount} from ${ctx.label(from)} to the Manager outside a recall`,
      };
    case "adapter":
      if (explanation) return undefined;
      return {
        severity: "high",
        rule: `${RULE}.adapter-inflow`,
        title: `SAHARA sent directly to ${name}: ${amount}`,
        detail: `${amount} from ${ctx.label(from)} to ${name} outside a Funded/Recalled operation`,
        note:
          "Unrecoverable: the adapter has no rescue function, so these tokens stay there. They are not usable " +
          "reserves; exclude them from capacity planning.",
      };
    case "pool":
      if (explanation?.kind === "lock") return largeBridgeFinding(ctx, transfer, explanation);
      if (explanation) return undefined;
      return {
        severity: "high",
        rule: `${RULE}.pool-inflow`,
        title: `Direct transfer to ${name}: ${amount}`,
        detail:
          `${amount} from ${ctx.label(from)} to ${name} without LiquidityAdded, LiquidityTransferred or a bridge ` +
          "lock: bypasses provideLiquidity and increases releasable inventory",
        note:
          "Releasable pool inventory grew outside the Manager budgets. Identify the sender and check reconciliation " +
          "(R - I).",
      };
    case "legacy":
    case "endpoint":
      return {
        severity: "info",
        rule: `${RULE}.endpoint-inflow`,
        title: `Inflow to ${name}: ${amount}`,
        detail: `${amount} from ${ctx.label(from)} to reserve endpoint ${name}`,
      };
  }
}

function bySeverity(a: Finding, b: Finding): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
}

function transferAlert(ctx: ChainContext, scan: TxScan, transfer: TokenTransfer, findings: Finding[]): Alert {
  // Stable sort: on equal severity the sender's finding (listed first) names the alert.
  const sorted = [...findings].sort(bySeverity);
  const [primary] = sorted as [Finding, ...Finding[]];
  const fields: AlertField[] = [
    addressField(ctx, "From", transfer.from),
    addressField(ctx, "To", transfer.to),
    {label: "Amount", value: `${amountText(ctx, transfer.value)} (raw ${transfer.value})`, code: true},
  ];
  for (const finding of sorted) fields.push({label: `Check (${finding.severity})`, value: finding.detail});
  if (SEVERITY_RANK[primary.severity] >= SEVERITY_RANK.high) {
    fields.push({label: "Accounting events in tx", value: scan.events.length ? scan.events.join("; ") : "none"});
  }
  const links: AlertLink[] = [txLink(ctx, scan.hash)];
  for (const address of [transfer.from, transfer.to]) {
    if (endpointKind(ctx, address)) links.push(addressLink(ctx, address));
  }
  const note = sorted.find((finding) => finding.note)?.note;
  return {
    key: logKey(ctx, RULE, transfer.log),
    kind: "event",
    severity: primary.severity,
    rule: primary.rule,
    chain: ctx.name,
    title: primary.title,
    fields,
    links,
    ...(note ? {note} : {}),
  };
}

function approvalAlert(ctx: ChainContext, scan: TxScan, approval: TokenApproval): Alert {
  const value = approval.value === maxUint256 ? "unlimited" : amountText(ctx, approval.value);
  return {
    key: logKey(ctx, RULE, approval.log),
    kind: "event",
    severity: "high",
    rule: `${RULE}.approval`,
    chain: ctx.name,
    title: `Approval by ${ctx.label(approval.owner)}: ${ctx.label(approval.spender)} may spend ${value}`,
    fields: [
      addressField(ctx, "Owner", approval.owner),
      addressField(ctx, "Spender", approval.spender),
      {label: "Allowance", value: approval.value === maxUint256 ? "unlimited" : `${value} (raw ${approval.value})`},
    ],
    links: [txLink(ctx, scan.hash), addressLink(ctx, approval.owner)],
    note:
      "Reserve endpoints never approve SAHARA except the adapter inside Manager.fund (reset to 0 in the same call). " +
      "The spender can move these reserves: confirm intent and revoke if unexpected.",
  };
}

function processTx(ctx: ChainContext, hash: Hex, txLogs: readonly Log[], outflows: PoolOutflow[]): void {
  const scan = decodeTx(ctx, hash, txLogs);
  for (const transfer of scan.transfers) {
    // Zero-value transfers move nothing, and OZ v5 lets anyone emit one from any address (address poisoning).
    if (transfer.value === 0n || sameAddress(transfer.from, transfer.to)) continue;
    const fromKind = endpointKind(ctx, transfer.from);
    const toKind = endpointKind(ctx, transfer.to);
    if (!fromKind && !toKind) continue;
    const findings: Finding[] = [];
    if (fromKind) {
      const explanation = take(scan, transfer.from, "out", transfer.to, transfer.value);
      const finding = classifyOutflow(ctx, fromKind, transfer, explanation);
      if (finding) findings.push(finding);
      if (fromKind === "pool") {
        outflows.push({
          pool: transfer.from,
          key: `${hash}:${transfer.log.logIndex}`,
          log: transfer.log,
          amount: transfer.value,
          kind: explanation?.kind ?? "unexplained",
        });
      }
    }
    if (toKind) {
      const explanation = take(scan, transfer.to, "in", transfer.from, transfer.value);
      const finding = classifyInflow(ctx, toKind, transfer, explanation);
      if (finding) findings.push(finding);
    }
    if (findings.length) ctx.alerter.emit(transferAlert(ctx, scan, transfer, findings));
  }
  for (const approval of scan.approvals) {
    if (approval.value === 0n || !endpointKind(ctx, approval.owner)) continue;
    const expected = scan.expectedApprovals.find(
      (entry) =>
        !entry.used &&
        entry.amount === approval.value &&
        sameAddress(entry.owner, approval.owner) &&
        sameAddress(entry.spender, approval.spender),
    );
    if (expected) {
      expected.used = true;
      continue;
    }
    ctx.alerter.emit(approvalAlert(ctx, scan, approval));
  }
}

// ----------------------------------------------------------------------------------------------------------------
// Outflow window
// ----------------------------------------------------------------------------------------------------------------

export interface OutflowEntry {
  /** `${txHash}:${logIndex}` of the Transfer (dedupes rescans). */
  key: string;
  /** Block timestamp (unix seconds). */
  timestamp: number;
  amount: bigint;
  kind: ExplanationKind | "unexplained";
}

export interface FlowsState {
  /** Pool outflows still inside the window, by checksummed pool address. */
  outflows: Record<string, OutflowEntry[]>;
}

export function readFlowsState(ctx: Pick<ChainContext, "store" | "name">): FlowsState {
  const state = ctx.store.get<FlowsState>(flowsNamespace(ctx.name), {outflows: {}});
  return {outflows: state.outflows ?? {}};
}

const OUTFLOW_KIND_LABEL: Record<OutflowEntry["kind"], string> = {
  release: "bridge release",
  recall: "recall",
  withdraw: "withdrawal",
  fund: "fund",
  migrate: "migration",
  provide: "provide",
  "transfer-liquidity": "liquidity transfer",
  lock: "lock",
  unexplained: "unexplained",
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function logTimestampAt(logs: readonly Log[], blockNumber: bigint): number | undefined {
  for (const log of logs) {
    const raw = (log as Log & {blockTimestamp?: Hex | bigint | number}).blockTimestamp;
    if (log.blockNumber === blockNumber && raw !== undefined && raw !== null) return Number(BigInt(raw));
  }
  return undefined;
}

function windowCondition(
  ctx: ChainContext,
  pool: Address,
  entries: OutflowEntry[],
  total: bigint,
  threshold: bigint,
  windowSec: number,
  reference: number,
): Alert {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const label = OUTFLOW_KIND_LABEL[entry.kind];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const breakdown = [...counts].map(([label, count]) => `${count} ${label}`).join(", ");
  const largest = entries.reduce((max, entry) => (entry.amount > max ? entry.amount : max), 0n);
  return {
    key: `${ctx.name}:${RULE}:outflow-window:${pool}`,
    kind: "condition",
    severity: "high",
    rule: `${RULE}.outflow-window`,
    chain: ctx.name,
    title: `${ctx.label(pool)} outflow ${amountText(ctx, total)} within ${formatDuration(windowSec)}`,
    fields: [
      addressField(ctx, "Pool", pool),
      {label: "Outflow in window", value: amountText(ctx, total), code: true},
      {label: "Threshold", value: `${amountText(ctx, threshold)} per ${formatDuration(windowSec)}`},
      {label: "Window", value: `${formatTimestamp(reference - windowSec)} to ${formatTimestamp(reference)}`},
      {label: "Transfers", value: `${entries.length} (${breakdown})`},
      {label: "Largest", value: amountText(ctx, largest), code: true},
    ],
    links: [addressLink(ctx, pool)],
    note:
      "Abnormal pool outflow. Check the releases against source-chain locks (reconciliation R - I). If they are not " +
      "backed, the Guardian can halt the bridge with GuardianController.lockdown(pool) and pause recall.",
  };
}

/**
 * Adds this range's pool outflows to the window, prunes it at the block time of `range.to`, and declares the open
 * window conditions. Runs on every range (also without logs), so conditions resolve once the window drains.
 */
async function updateOutflowWindow(
  ctx: ChainContext,
  outflows: readonly PoolOutflow[],
  logs: readonly Log[],
  range: BlockRange,
): Promise<void> {
  const scope = `${ctx.name}:${RULE}:outflow-window:`;
  const namespace = flowsNamespace(ctx.name);
  const {outflowWindowAmount, outflowWindowSec} = ctx.config.limits;
  const state = readFlowsState(ctx);
  if (outflowWindowAmount === undefined) {
    if (Object.keys(state.outflows).length) ctx.store.set<FlowsState>(namespace, {outflows: {}});
    ctx.alerter.sync(scope, []);
    return;
  }
  const hasStored = Object.values(state.outflows).some((entries) => entries.length > 0);
  if (!outflows.length && !hasStored) {
    ctx.alerter.sync(scope, []);
    return;
  }

  let times = new Map<bigint, number>();
  if (outflows.length) {
    try {
      times = await blockTimestamps(ctx, outflows.map((outflow) => outflow.log));
    } catch (error) {
      ctx.log.warn("flows: block timestamps unavailable for pool outflows", {error});
    }
  }
  let reference = times.get(range.to) ?? logTimestampAt(logs, range.to);
  if (reference === undefined) {
    try {
      reference = Number((await ctx.client.getBlock({blockNumber: range.to})).timestamp);
    } catch (error) {
      ctx.log.warn("flows: block timestamp unavailable for the window end", {error, block: range.to});
    }
  }

  for (const outflow of outflows) {
    const pool = getAddress(outflow.pool);
    const entries = (state.outflows[pool] ??= []);
    if (entries.some((entry) => entry.key === outflow.key)) continue;
    const blockNumber = outflow.log.blockNumber;
    entries.push({
      key: outflow.key,
      // Without its block time: the range end (or the wall clock) is never earlier than the block, so the entry
      // stays in the window at least as long as it should.
      timestamp: (blockNumber !== null ? times.get(blockNumber) : undefined) ?? reference ?? nowSec(),
      amount: outflow.amount,
      kind: outflow.kind,
    });
  }
  // Without the block time of the range end, do not age entries (resolving needs evidence that time passed).
  const end =
    reference ??
    Math.max(...Object.values(state.outflows).flatMap((entries) => entries.map((entry) => entry.timestamp)));

  const threshold = toUnits(outflowWindowAmount, ctx.global.token.decimals);
  const conditions: Alert[] = [];
  for (const [pool, entries] of Object.entries(state.outflows)) {
    const live = entries.filter((entry) => entry.timestamp > end - outflowWindowSec);
    if (!live.length) {
      delete state.outflows[pool];
      continue;
    }
    state.outflows[pool] = live;
    const total = live.reduce((sum, entry) => sum + entry.amount, 0n);
    if (total >= threshold) {
      conditions.push(windowCondition(ctx, getAddress(pool), live, total, threshold, outflowWindowSec, end));
    }
  }
  ctx.store.set<FlowsState>(namespace, state);
  ctx.alerter.sync(scope, conditions);
}

// ----------------------------------------------------------------------------------------------------------------
// Rule
// ----------------------------------------------------------------------------------------------------------------

export const flowsRule: EventRule = {
  id: RULE,
  filters(ctx: ChainContext): LogFilter[] {
    const filters: LogFilter[] = [];
    const endpoints = flowEndpoints(ctx);
    if (endpoints.length) {
      const topics = endpoints.map(addressTopic);
      // Transfer from an endpoint and Approval by an endpoint share topic1, so one request covers both.
      filters.push({address: ctx.addresses.token, topics: [[TRANSFER_TOPIC, APPROVAL_TOPIC], topics]});
      filters.push({address: ctx.addresses.token, topics: [TRANSFER_TOPIC, null, topics]});
    }
    // The accounting events. Other rules request most of them too (the scanner dedupes); flows requests them itself
    // so a missing explanation can never come from another rule's filter list.
    const contracts = [...(ctx.addresses.manager ? [ctx.addresses.manager] : []), ...ctx.addresses.pools];
    if (contracts.length) filters.push({address: contracts, topics: [[...MANAGER_TOPICS, ...POOL_TOPICS]]});
    return filters;
  },
  async onLogs(ctx: ChainContext, logs: Log[], range: BlockRange): Promise<void> {
    const outflows: PoolOutflow[] = [];
    const {token, manager, pools} = ctx.addresses;
    const relevant = logs.filter(
      (log) =>
        !log.removed &&
        (sameAddress(log.address, token) || sameAddress(log.address, manager) || includesAddress(pools, log.address)),
    );
    for (const [hash, txLogs] of groupByTx(relevant)) {
      try {
        processTx(ctx, hash, txLogs, outflows);
      } catch (error) {
        ctx.log.warn("flows: failed to process transaction", {error, tx: hash});
      }
    }
    // After the transfer alerts, so a block-time failure can never suppress them.
    try {
      await updateOutflowWindow(ctx, outflows, logs, range);
    } catch (error) {
      ctx.log.warn("flows: outflow window update failed", {error});
    }
  },
};
