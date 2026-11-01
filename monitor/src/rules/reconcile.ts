// Off-chain reconciliation of design §5: "R is the combined verified SAHARA balance across both chains … I is principal
// locked on the source chain but not yet released on the destination, including failed messages awaiting execution …
// require R − I ≥ 10 billion. … Reconcile finalized balances and messages off-chain." Run by the daemon every
// `reconciliation.intervalSec`, and by the CLI `check` command.
//
// - Snapshot block per chain: the "finalized" block (the confirmed head, latest − confirmations, where the RPC lacks
//   the tag), capped at the last block the ccip rule has processed, so every lock and release in the snapshot balances
//   is also in the message stores. A capped chain can still miss locks its counterpart has already released (the
//   counterpart's snapshot is later): such a run is incomplete (blocking) rather than a breach.
// - R: SAHARA balance of every reserve endpoint (Manager, every adapter ever registered, watched pools, legacy reserve
//   wallets, extra endpoints), each (chain, address) once, at the snapshot block.
// - I: src/ccip/inflight.ts over the ccip stores (src/ccip/store.ts) at the snapshot blocks.
// - Conditions (synced under "global:reconcile:"): backing breach (critical), failed messages outstanding (critical),
//   stuck messages (warning, per message), totalSupply != requiredBacking per chain (critical: the fixed supply
//   changed), reconciliation incomplete (warning). A breach or supply condition that cannot be re-evaluated (chain
//   unreachable, tracking disabled) is kept as it was rather than resolved. How long the daemon's runs stay blocked by
//   a failure (each reason's `cause`) is its own health condition (health.reconcile-stale, src/health.ts).
//
// Limitations (also in the report's notes where they apply):
// - Messages sent before the first block the ccip rule scanned are invisible. Set each chain's `startBlock` before any
//   message that can still be in flight or failed when the monitor is first deployed (failed messages can wait for
//   manual execution indefinitely: check the CCIP explorer for the pools' open failures), and keep the state file.
// - At-least-once: records come from confirmed (not finalized) blocks and are not reorg-corrected; a reorg deeper than
//   `confirmations` could leave a phantom message. Balances are always read at finalized (or capped) blocks.
// - Executions are watched on the OffRamps the Router lists for the counterpart selectors. A SUCCESS on any other
//   OffRamp is still seen through the pool's ReleasedOrMinted (its `sender` names the OffRamp); a FAILURE is not.
// - Only watched pools are tracked (registered, registry, configured and `reserves.extraPools`); SAHARA bridged through
//   any other pool is outside R and I.
// - Locks that cannot be tied to a message, and messages to a chain selector that is not configured, are counted in I
//   without being able to see their settlement ("uncertain" in the report), however old, until the operator lists them
//   in `reconciliation.acknowledged` after checking the CCIP explorer (then shown as acknowledged, not counted).
// - Blocks a chain's ccip rule skipped (e.g. tracking disabled for a while) are a gap: I cannot be bounded, so the run
//   is incomplete until the gap is scanned (the daemon replays it), however old.
// - Messages are joined across chains through the one shared store; the daemon must give every chain the same store.
import {getAddress, type Address, type Hex} from "viem";

import {saharaTokenAbi} from "../abi/external.ts";
import {confirmedHead} from "../chain/client.ts";
import {computeInFlight, findAcknowledgement, type InFlight, type InFlightEntry} from "../ccip/inflight.ts";
import {
  executionStatus,
  idKey,
  lastFailure,
  readExec,
  readScan,
  readSent,
  successAttempt,
  type ExecAttempt,
  type ExecRecord,
  type ScanState,
  type SentRecord,
} from "../ccip/store.ts";
import {ccipMessageUrl} from "../ccip/tracker.ts";
import {toUnits, type Acknowledgement, type Config} from "../config.ts";
import {formatAmount, formatDuration, formatTimestamp, shortHex} from "../format.ts";
import {redact} from "../log.ts";
import type {Alert, AlertField, AlertLink, Alerter, ChainContext} from "../types.ts";

export const RECONCILE_SCOPE = "global:reconcile:";
const RECONCILE_NAMESPACE = "reconcile";
const BACKING_KEY = `${RECONCILE_SCOPE}backing`;
const FAILED_KEY = `${RECONCILE_SCOPE}failed`;
const INCOMPLETE_KEY = `${RECONCILE_SCOPE}incomplete`;
const supplyKey = (chain: string) => `${RECONCILE_SCOPE}supply:${chain}`;
const stuckKey = (messageId: Hex) => `${RECONCILE_SCOPE}stuck:${idKey(messageId)}`;

/** Messages listed per alert; the rest are counted. */
const MAX_LISTED = 10;

export interface EndpointBalance {
  address: Address;
  label: string;
  balance: bigint;
}

export interface ChainSnapshot {
  chain: string;
  /** Balances and totalSupply were read. */
  ok: boolean;
  error?: string;
  /** How the snapshot block was chosen. */
  blockSource?: "finalized" | "confirmed" | "scanned";
  block?: bigint;
  /** Unix seconds, when known. */
  timestamp?: number;
  /** The finalized block (or confirmed head) before capping. */
  headBlock?: bigint;
  tracking: "enabled" | "disabled" | "not-started";
  /** Blocks processed by the ccip rule. */
  scanned?: {from: bigint; to: bigint};
  balances: EndpointBalance[];
  /** Σ balances. */
  total?: bigint;
  totalSupply?: bigint;
  notes: string[];
}

/** A SAHARA message for display (failed or stuck lists). */
export interface MessageView {
  messageId: Hex;
  sourceChain: string | null;
  destChain: string;
  /** Unknown when the send was not seen. */
  amount?: bigint;
  receiver?: Address | null;
  sentAt?: number;
  sourceTx?: Hex;
  /** Latest FAILURE (failed list). */
  failure?: ExecAttempt;
  /** Seconds since the send (stuck list). */
  ageSec?: number;
}

/** What an incomplete reason is about, for code (the daemon tells failures from expected gaps by it). */
export type IncompleteCause =
  /** The finalized head or a balance read failed. */
  | "unreachable"
  /** `ccip.enabled: false`. */
  | "ccip-disabled"
  /** The ccip rule has not scanned a block yet. */
  | "ccip-not-started"
  /** A capped snapshot misses locks whose release the counterpart already saw. */
  | "ccip-scan-behind"
  /** Blocks the ccip rule skipped, not replayed yet. */
  | "ccip-gap"
  | "ramps-unreadable"
  | "unlinked-txs"
  | "ramp-backfill"
  | "unlinked-locks"
  | "unknown-destination"
  | "released-ahead";

export interface IncompleteReason {
  chain?: string;
  reason: string;
  /** R or I cannot be computed: the backing condition is not evaluated. */
  blocking: boolean;
  cause: IncompleteCause;
}

export interface ReconcileReport {
  /** Unix seconds. */
  at: number;
  /** "ok", "breach" (R − I below required) or "incomplete" (R or I unknown). */
  status: "ok" | "breach" | "incomplete";
  required: bigint;
  chains: ChainSnapshot[];
  /** Σ endpoint balances across chains; undefined when a chain could not be read. */
  R?: bigint;
  /** Net in flight; undefined when a chain's messages are not tracked, a snapshot is missing or a reason blocks. */
  I?: bigint;
  /** Part of I counted without verified settlement. */
  uncertain: bigint;
  /** R − I − required. */
  margin?: bigint;
  /** Composition of I at the snapshots (pending, failed, released-ahead, unlinked, …; acknowledged: not counted). */
  inFlight: InFlightEntry[];
  /** I per lane ("ethereum→bsc"). */
  byLane: Record<string, bigint>;
  /** SAHARA messages whose latest execution is a FAILURE (owed until manually executed). */
  failed: MessageView[];
  /** SAHARA messages without any execution after the source chain's `ccip.stuckAfterSec`. */
  stuck: MessageView[];
  incomplete: IncompleteReason[];
  /** Conditions active after this run (as synced). */
  conditions: Alert[];
}

export interface ReconcileOptions {
  /** Clock in unix ms (tests). */
  now?: () => number;
  /** True holds back this run's reconcile.incomplete warning (the daemon's grace for a passing failure). */
  holdIncomplete?: (report: ReconcileReport) => boolean;
}

interface ChainData {
  ctx: ChainContext;
  sent: Record<Hex, SentRecord>;
  exec: Record<Hex, ExecRecord>;
  scan: ScanState;
}

function errorText(error: unknown): string {
  const shortMessage = (error as {shortMessage?: unknown})?.shortMessage;
  if (typeof shortMessage === "string") return redact(shortMessage);
  return redact(error instanceof Error ? error.message : String(error));
}

type Head = {ok: true; block: bigint; timestamp?: number; source: "finalized" | "confirmed"; note?: string} | {
  ok: false;
  error: string;
};

/** The finalized block, else the confirmed head (RPCs and dev chains without the "finalized" tag). */
async function finalizedHead(ctx: ChainContext): Promise<Head> {
  try {
    const block = await ctx.client.getBlock({blockTag: "finalized"});
    if (block.number === null) throw new Error("finalized block has no number");
    return {ok: true, block: block.number, timestamp: Number(block.timestamp), source: "finalized"};
  } catch (finalizedError) {
    try {
      const head = await confirmedHead(ctx.client, ctx.config.confirmations);
      return {
        ok: true,
        block: head,
        source: "confirmed",
        note:
          `"finalized" block unavailable (${errorText(finalizedError)}); used the confirmed head ` +
          `(latest − ${ctx.config.confirmations})`,
      };
    } catch (error) {
      return {ok: false, error: errorText(error)};
    }
  }
}

function trackingOf(ctx: ChainContext, scan: ScanState): ChainSnapshot["tracking"] {
  if (!ctx.config.ccip.enabled) return "disabled";
  return scan.cursor ? "enabled" : "not-started";
}

/** Snapshot block: the head, capped at the last block the ccip rule processed (its stores are complete up to it). */
function chooseSnapshot(data: ChainData, head: Head): ChainSnapshot {
  const {ctx, scan} = data;
  const tracking = trackingOf(ctx, scan);
  const snapshot: ChainSnapshot = {chain: ctx.name, ok: false, tracking, balances: [], notes: []};
  if (scan.cursor) snapshot.scanned = {...scan.cursor};
  if (!head.ok) {
    snapshot.error = head.error;
    return snapshot;
  }
  snapshot.headBlock = head.block;
  snapshot.block = head.block;
  snapshot.blockSource = head.source;
  snapshot.timestamp = head.timestamp;
  if (head.note) snapshot.notes.push(head.note);
  if (tracking === "enabled" && scan.cursor && scan.cursor.to < head.block) {
    snapshot.block = scan.cursor.to;
    snapshot.blockSource = "scanned";
    snapshot.timestamp = undefined;
    snapshot.notes.push(`capped at the last block scanned for CCIP messages (${head.source} is ${head.block})`);
  }
  if (tracking === "enabled" && scan.cursor) {
    snapshot.notes.push(`CCIP messages tracked from block ${scan.cursor.from}`);
  }
  return snapshot;
}

async function readBalances(ctx: ChainContext, snapshot: ChainSnapshot): Promise<void> {
  const blockNumber = snapshot.block;
  if (blockNumber === undefined) return;
  const token = ctx.addresses.token;
  const endpoints: Address[] = [];
  for (const address of ctx.addresses.endpoints) {
    if (!endpoints.some((known) => known.toLowerCase() === address.toLowerCase())) endpoints.push(getAddress(address));
  }
  try {
    const [totalSupply, balances, header] = await Promise.all([
      ctx.client.readContract({address: token, abi: saharaTokenAbi, functionName: "totalSupply", blockNumber}),
      Promise.all(
        endpoints.map((address) =>
          ctx.client.readContract({
            address: token,
            abi: saharaTokenAbi,
            functionName: "balanceOf",
            args: [address],
            blockNumber,
          }),
        ),
      ),
      // Display, and the lag check of a capped snapshot (collectIncomplete).
      snapshot.timestamp === undefined ? ctx.client.getBlock({blockNumber}).catch(() => undefined) : undefined,
    ]);
    snapshot.totalSupply = totalSupply;
    snapshot.balances = endpoints.map((address, i) => ({address, label: ctx.label(address), balance: balances[i]!}));
    snapshot.total = balances.reduce((sum, balance) => sum + balance, 0n);
    if (header) snapshot.timestamp = Number(header.timestamp);
    snapshot.ok = true;
  } catch (error) {
    snapshot.error = `balance reads at block ${blockNumber} failed: ${errorText(error)}`;
  }
}

/** Is this execution record a SAHARA message (evidence on the destination, or a send seen on the source)? */
function isSahara(
  record: ExecRecord,
  sentOf: (chain: string) => Record<Hex, SentRecord> | undefined,
): SentRecord | true | null {
  const sent = record.sourceChain ? sentOf(record.sourceChain)?.[idKey(record.messageId)] : undefined;
  if (sent) return sent;
  return record.sahara !== null ? true : null;
}

function collectIncomplete(
  data: ChainData[],
  snapshots: ChainSnapshot[],
  inFlight: InFlight | undefined,
  acknowledged: readonly Acknowledgement[],
) {
  const reasons: IncompleteReason[] = [];
  const configured = new Set(data.map((entry) => entry.ctx.name));
  for (const [i, {ctx, sent, scan}] of data.entries()) {
    const snapshot = snapshots[i]!;
    const chain = ctx.name;
    if (!snapshot.ok) {
      reasons.push({chain, reason: `${chain} unreachable: ${snapshot.error}`, blocking: true, cause: "unreachable"});
    }
    if (snapshot.tracking === "disabled") {
      reasons.push({
        chain,
        reason: `${chain}: CCIP tracking disabled (ccip.enabled: false); messages from and to ${chain} are unknown`,
        blocking: true,
        cause: "ccip-disabled",
      });
    } else if (snapshot.tracking === "not-started") {
      reasons.push({
        chain,
        reason: `${chain}: no blocks scanned for CCIP messages yet`,
        blocking: true,
        cause: "ccip-not-started",
      });
    }
    if (scan.rampsError) {
      reasons.push({
        chain,
        reason: `${chain}: Router ramps unreadable (${scan.rampsError})`,
        blocking: false,
        cause: "ramps-unreadable",
      });
    }
    // Acknowledged obligations are listed in the report only: they would keep the condition open for good.
    const pending = Object.values(scan.pendingTxs).filter(
      (entry) => !findAcknowledgement(acknowledged, chain, {txHash: entry.txHash}),
    );
    if (pending.length) {
      reasons.push({
        chain,
        reason:
          `${chain}: ${pending.length} bridge transaction(s) not yet linked to their CCIP message ` +
          "(receipt lookups failing)",
        blocking: false,
        cause: "unlinked-txs",
      });
    }
    for (const entry of scan.backfills) {
      reasons.push({
        chain,
        reason: `${chain}: ramp logs of blocks ${entry.from}–${entry.to} not fetched yet`,
        blocking: false,
        cause: "ramp-backfill",
      });
    }
    const unlinked = scan.unlinked.filter((lock) => !findAcknowledgement(acknowledged, chain, {txHash: lock.txHash}));
    if (unlinked.length) {
      reasons.push({
        chain,
        reason: `${chain}: ${unlinked.length} lock(s) without a matching CCIP message, counted as in flight`,
        blocking: false,
        cause: "unlinked-locks",
      });
    }
    // Locks and releases there are in the balances but not in the message stores: I cannot be bounded until filled.
    for (const gap of scan.gaps) {
      reasons.push({
        chain,
        reason:
          `${chain}: blocks ${gap.from}–${gap.to} were not scanned for CCIP messages; what was sent or executed ` +
          "there is unknown until they are scanned",
        blocking: true,
        cause: "ccip-gap",
      });
    }
    const unknownDest = Object.values(sent).filter(
      (message) =>
        (!message.destChain || !configured.has(message.destChain)) &&
        !findAcknowledgement(acknowledged, chain, {messageId: message.messageId}),
    );
    if (unknownDest.length) {
      const selectors = [...new Set(unknownDest.map((message) => message.destSelector.toString()))].join(", ");
      reasons.push({
        chain,
        reason:
          `${chain}: ${unknownDest.length} message(s) to unconfigured chain selector(s) ${selectors}, ` +
          "counted as in flight",
        blocking: false,
        cause: "unknown-destination",
      });
    }
  }
  for (const [i, {ctx, sent}] of data.entries()) {
    const snapshot = snapshots[i]!;
    if (!snapshot.ok || snapshot.blockSource !== "scanned") continue;
    for (const [j, other] of data.entries()) {
      const released = j === i ? [] : unscannedReleases(ctx.name, snapshot, sent, other.exec, snapshots[j]!);
      if (!released.length) continue;
      const total = released.reduce((sum, record) => sum + (record.release?.amount ?? 0n), 0n);
      const unknown = released.some((record) => !record.release);
      reasons.push({
        chain: ctx.name,
        reason:
          `${ctx.name}: CCIP scan behind its finalized block (snapshot capped at block ${snapshot.block}, finalized ` +
          `${snapshot.headBlock}): ${released.length} release(s) on ${other.ctx.name} ` +
          `(${amountText(ctx.global, total)}${unknown ? " + unknown" : ""}) ` +
          `of messages ${ctx.name} has not scanned yet`,
        blocking: true,
        cause: "ccip-scan-behind",
      });
    }
  }
  if (inFlight && inFlight.entries.some((entry) => entry.status === "released-ahead")) {
    // Informational: correct by construction, but worth knowing that a source snapshot lags what CCIP executed.
    reasons.push({
      reason:
        "a message was released although its lock is after its source chain's snapshot block (source finalized " +
        "block behind the destination's execution), subtracted from I",
      blocking: false,
      cause: "released-ahead",
    });
  }
  return reasons;
}

/**
 * SUCCESSes at or before `other`'s snapshot of messages from the capped `chain` that it has no send record of. Its
 * snapshot stops at its last scanned block, so a lock after it is in neither its balance nor I while the release has
 * already left `other`'s balance: R − I would read low by the amount. CCIP executes a message only after its lock is
 * final, so only a release at or after the capped block's timestamp (any, when it is unknown) can be one; a message
 * sent before tracking started and executed then is indistinguishable and flagged the same way.
 */
function unscannedReleases(
  chain: string,
  capped: ChainSnapshot,
  sent: Record<Hex, SentRecord>,
  exec: Record<Hex, ExecRecord>,
  other: ChainSnapshot,
): ExecRecord[] {
  if (!other.ok || other.block === undefined) return [];
  return Object.values(exec).filter((record) => {
    if (record.sourceChain !== chain || idKey(record.messageId) in sent) return false;
    const success = successAttempt(record, other.block);
    return success !== undefined && (capped.timestamp === undefined || success.at >= capped.timestamp);
  });
}

function failedViews(data: ChainData[]): MessageView[] {
  const sentByChain = new Map(data.map((entry) => [entry.ctx.name, entry.sent] as const));
  const views: MessageView[] = [];
  for (const {ctx, exec} of data) {
    for (const record of Object.values(exec)) {
      if (executionStatus(record) !== "failed") continue;
      const sahara = isSahara(record, (chain) => sentByChain.get(chain));
      if (sahara === null) continue;
      const sent = sahara === true ? undefined : sahara;
      views.push({
        messageId: record.messageId,
        sourceChain: record.sourceChain,
        destChain: ctx.name,
        amount: sent?.amount ?? record.release?.amount,
        receiver: sent?.receiver ?? null,
        sentAt: sent?.sentAt,
        sourceTx: sent?.txHash,
        failure: lastFailure(record),
      });
    }
  }
  return views.sort((a, b) => (a.failure?.at ?? 0) - (b.failure?.at ?? 0));
}

function stuckViews(data: ChainData[], now: number): MessageView[] {
  const byName = new Map(data.map((entry) => [entry.ctx.name, entry] as const));
  const views: MessageView[] = [];
  for (const {ctx, sent, scan} of data) {
    if (trackingOf(ctx, scan) !== "enabled") continue;
    for (const message of Object.values(sent)) {
      const dest = message.destChain ? byName.get(message.destChain) : undefined;
      if (!dest || trackingOf(dest.ctx, dest.scan) !== "enabled") continue;
      const ageSec = now - message.sentAt;
      if (ageSec <= ctx.config.ccip.stuckAfterSec) continue;
      if (executionStatus(dest.exec[idKey(message.messageId)]) !== "pending") continue;
      views.push({
        messageId: message.messageId,
        sourceChain: ctx.name,
        destChain: dest.ctx.name,
        amount: message.amount,
        receiver: message.receiver,
        sentAt: message.sentAt,
        sourceTx: message.txHash,
        ageSec,
      });
    }
  }
  return views.sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0));
}

// ---------------------------------------------------------------------------------------------------------------
// Conditions

function amountText(config: Config, raw: bigint | undefined): string {
  return raw === undefined ? "unknown" : formatAmount(raw, config.token.decimals, config.token.symbol);
}

function messageLine(config: Config, view: MessageView): string {
  const lane = `${view.sourceChain ?? "?"}→${view.destChain}`;
  const receiver = view.receiver ? ` to ${shortHex(getAddress(view.receiver))}` : "";
  return `${shortHex(view.messageId)} ${lane}: ${amountText(config, view.amount)}${receiver}`;
}

function backingAlert(config: Config, report: ReconcileReport, R: bigint, I: bigint, margin: bigint): Alert {
  const fields: AlertField[] = [
    {label: "R (reserves)", value: amountText(config, R), code: true},
    {label: "I (in flight)", value: amountText(config, I), code: true},
    {label: "Required", value: amountText(config, report.required), code: true},
    {label: "Margin (R − I − required)", value: amountText(config, margin), code: true},
  ];
  for (const chain of report.chains) {
    fields.push({
      label: `${chain.chain} reserves`,
      value: `${amountText(config, chain.total)} at block ${chain.block} (${chain.blockSource})`,
    });
  }
  for (const [lane, amount] of Object.entries(report.byLane)) {
    fields.push({label: `In flight ${lane}`, value: amountText(config, amount)});
  }
  if (report.uncertain > 0n) {
    fields.push({label: "Uncertain part of I", value: amountText(config, report.uncertain)});
  }
  const failedInI = report.inFlight.filter((entry) => entry.status === "failed").length;
  if (failedInI) fields.push({label: "Failed messages in I", value: String(failedInI)});
  return {
    key: BACKING_KEY,
    kind: "condition",
    severity: "critical",
    rule: "reconcile.backing",
    title:
      `Backing breach: R − I is ${amountText(config, -margin)} below the required ` +
      amountText(config, report.required),
    fields,
    note:
      "Design §5 requires R − I ≥ the required backing at finalized blocks. Check the flows alerts for unexplained " +
      "outflows, have the Guardian pause recalls (pauseRecall) until reconciled, and re-run `npm run check`.",
  };
}

function failedAlert(config: Config, failed: MessageView[]): Alert {
  const total = failed.reduce((sum, view) => sum + (view.amount ?? 0n), 0n);
  const unknown = failed.some((view) => view.amount === undefined);
  const fields: AlertField[] = failed.slice(0, MAX_LISTED).map((view) => ({
    label: messageLine(config, view),
    value: view.failure
      ? `failed ${formatTimestamp(view.failure.at)}: ${view.failure.reason ?? "unknown reason"}`
      : "failed",
  }));
  if (failed.length > MAX_LISTED) fields.push({label: "More", value: `${failed.length - MAX_LISTED} more`});
  const links: AlertLink[] = failed
    .slice(0, 5)
    .map((view) => ({label: `CCIP ${shortHex(view.messageId)}`, url: ccipMessageUrl(view.messageId)}));
  return {
    key: FAILED_KEY,
    kind: "condition",
    severity: "critical",
    rule: "reconcile.failed-messages",
    title:
      `${failed.length} failed CCIP message(s) awaiting manual execution: ` +
      `${amountText(config, total)}${unknown ? " + unknown" : ""}`,
    fields,
    links,
    note:
      "Each failed message is still owed on its destination and counts in I. Fix the cause (pool inventory, rate " +
      "limits), then manually execute it from the CCIP explorer.",
  };
}

function stuckAlert(config: Config, view: MessageView): Alert {
  return {
    key: stuckKey(view.messageId),
    kind: "condition",
    severity: "warning",
    rule: "reconcile.stuck-message",
    chain: view.destChain,
    title:
      `CCIP message not executed after ${formatDuration(view.ageSec ?? 0)}: ` +
      `${amountText(config, view.amount)} ${view.sourceChain}→${view.destChain}`,
    fields: [
      {label: "Message ID", value: view.messageId, code: true},
      {label: "Amount", value: amountText(config, view.amount), code: true},
      ...(view.receiver ? [{label: "Receiver", value: getAddress(view.receiver), code: true}] : []),
      ...(view.sentAt !== undefined ? [{label: "Sent", value: formatTimestamp(view.sentAt)}] : []),
      ...(view.sourceTx ? [{label: "Source transaction", value: view.sourceTx, code: true}] : []),
    ],
    links: [{label: "CCIP explorer", url: ccipMessageUrl(view.messageId)}],
    note:
      "No execution of this message has been seen on the destination's OffRamps. Check its status in the CCIP " +
      "explorer (source finality, DON execution, a cursed lane or an OffRamp the monitor does not watch).",
  };
}

function supplyAlert(config: Config, chain: ChainSnapshot, required: bigint): Alert {
  // Full precision: a change of a few wei must not print as the expected supply.
  const {decimals, symbol} = config.token;
  const exact = (raw: bigint | undefined) =>
    raw === undefined ? "unknown" : formatAmount(raw, decimals, symbol, decimals);
  return {
    key: supplyKey(chain.chain),
    kind: "condition",
    severity: "critical",
    rule: "reconcile.total-supply",
    chain: chain.chain,
    title: `${config.token.symbol} totalSupply changed on ${chain.chain}: ${exact(chain.totalSupply)}`,
    fields: [
      {label: "totalSupply", value: exact(chain.totalSupply), code: true},
      {label: "Expected", value: exact(required), code: true},
      {label: "Block", value: String(chain.block)},
    ],
    note: "The token has a fixed supply per chain; a change means mint/burn capability or a different token.",
  };
}

function incompleteAlert(reasons: IncompleteReason[]): Alert {
  const blocking = reasons.some((reason) => reason.blocking);
  const first = (reasons.find((reason) => reason.blocking) ?? reasons[0])!;
  return {
    key: INCOMPLETE_KEY,
    kind: "condition",
    severity: "warning",
    rule: "reconcile.incomplete",
    title: `Reconciliation ${blocking ? "incomplete" : "uncertain"}: ${first.reason}`,
    fields: reasons.map((reason, i) => ({label: `${i + 1}`, value: reason.reason})),
    note: blocking
      ? "R − I cannot be verified. Design §5: disable recall while in-flight obligations cannot be bounded."
      : "R − I was evaluated, counting what could not be verified as in flight.",
  };
}

/** Marks a kept (not re-evaluated) condition. */
function kept(alert: Alert, reason: string): Alert {
  const marker = "Not re-evaluated in the latest reconciliation";
  const base = (alert.note ?? "").split(`\n${marker}`)[0]!;
  return {...alert, note: `${base}\n${marker}: ${reason}.`.trimStart()};
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Reconciles R − I across `contexts` (one per configured chain), syncs the "global:reconcile:" conditions and returns
 * the report (daily summary, /metrics, `check`).
 */
export async function reconcile(
  contexts: ChainContext[],
  alerter: Alerter,
  config: Config,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const required = toUnits(config.reconciliation.requiredBacking, config.token.decimals);

  const heads = await Promise.all(contexts.map((ctx) => finalizedHead(ctx)));
  // Read the stores in one synchronous step after the heads: everything the ccip rule recorded up to its cursor is in.
  const data: ChainData[] = contexts.map((ctx) => ({
    ctx,
    sent: readSent(ctx.store, ctx.name),
    exec: readExec(ctx.store, ctx.name),
    scan: readScan(ctx.store, ctx.name),
  }));
  const chains = data.map((entry, i) => chooseSnapshot(entry, heads[i]!));
  await Promise.all(data.map((entry, i) => readBalances(entry.ctx, chains[i]!)));

  const allRead = chains.every((chain) => chain.ok);
  const allTracked = chains.every((chain) => chain.tracking === "enabled");
  const snapshots = Object.fromEntries(chains.map((chain) => [chain.chain, chain.ok ? chain.block : undefined]));
  const inFlight = computeInFlight({
    snapshots,
    sent: Object.fromEntries(
      data
        .filter((entry) => trackingOf(entry.ctx, entry.scan) === "enabled")
        .map((entry) => [entry.ctx.name, entry.sent]),
    ),
    exec: Object.fromEntries(data.map((entry) => [entry.ctx.name, entry.exec])),
    scan: Object.fromEntries(data.map((entry) => [entry.ctx.name, entry.scan])),
    acknowledged: config.reconciliation.acknowledged,
  });

  const report: ReconcileReport = {
    at: now,
    status: "ok",
    required,
    chains,
    uncertain: inFlight.uncertain,
    inFlight: inFlight.entries,
    byLane: inFlight.byLane,
    failed: failedViews(data),
    stuck: stuckViews(data, now),
    incomplete: collectIncomplete(data, chains, inFlight, config.reconciliation.acknowledged),
    conditions: [],
  };
  const blocking = report.incomplete.some((reason) => reason.blocking);
  if (allRead) report.R = chains.reduce((sum, chain) => sum + (chain.total ?? 0n), 0n);
  // A lagging CCIP scan leaves R and I readable but not comparable: no I or margin then either.
  if (allRead && allTracked && !blocking) {
    report.I = inFlight.total;
    report.margin = report.R! - inFlight.total - required;
  }
  report.status = blocking ? "incomplete" : report.margin !== undefined && report.margin < 0n ? "breach" : "ok";

  // Conditions. Breach and supply are kept as they were when they cannot be re-evaluated.
  const store = contexts[0]?.store;
  const previous =
    store?.get<{conditions: Record<string, Alert>}>(RECONCILE_NAMESPACE, {conditions: {}}).conditions ?? {};
  const active: Alert[] = [];
  if (!blocking && report.margin !== undefined) {
    if (report.margin < 0n) active.push(backingAlert(config, report, report.R!, report.I!, report.margin));
  } else if (previous[BACKING_KEY]) {
    active.push(kept(previous[BACKING_KEY], "R or I unknown"));
  }
  if (report.failed.length) active.push(failedAlert(config, report.failed));
  for (const view of report.stuck) active.push(stuckAlert(config, view));
  for (const chain of chains) {
    if (chain.totalSupply !== undefined) {
      if (chain.totalSupply !== required) active.push(supplyAlert(config, chain, required));
    } else if (previous[supplyKey(chain.chain)]) {
      active.push(kept(previous[supplyKey(chain.chain)]!, `${chain.chain} unreachable`));
    }
  }
  if (report.incomplete.length && !opts.holdIncomplete?.(report)) active.push(incompleteAlert(report.incomplete));

  alerter.sync(RECONCILE_SCOPE, active);
  store?.set(RECONCILE_NAMESPACE, {conditions: Object.fromEntries(active.map((alert) => [alert.key, alert]))});
  report.conditions = active;
  return report;
}

// ---------------------------------------------------------------------------------------------------------------
// Plain-text report (CLI `check`, daily summary)

function entryLine(config: Config, entry: InFlightEntry): string {
  const id = entry.messageId ? shortHex(entry.messageId) : `tx ${shortHex(entry.txHash)}`;
  const receiver = entry.receiver ? ` to ${shortHex(getAddress(entry.receiver))}` : "";
  const sign = entry.status === "released-ahead" ? "−" : "";
  const failure = entry.failure ? `: ${entry.failure.reason ?? "failed"}` : entry.note ? `: ${entry.note}` : "";
  return (
    `${id} ${entry.sourceChain}→${entry.destChain ?? "?"}: ${sign}${amountText(config, entry.amount)}${receiver}, ` +
    `sent ${formatTimestamp(entry.sentAt)} [${entry.status}${failure}]`
  );
}

export function formatReconcileReport(report: ReconcileReport, config: Config): string {
  const lines: string[] = [];
  const statusText = {ok: "OK", breach: "BACKING BREACH", incomplete: "INCOMPLETE"}[report.status];
  lines.push(`${config.token.symbol} reconciliation at ${formatTimestamp(report.at)}: ${statusText}`);
  for (const chain of report.chains) {
    if (chain.block === undefined) {
      lines.push(`${chain.chain}: unreachable (${chain.error ?? "unknown error"})`);
      continue;
    }
    const when = chain.timestamp !== undefined ? `, ${formatTimestamp(chain.timestamp)}` : "";
    lines.push(`${chain.chain}: block ${chain.block} (${chain.blockSource}${when}), CCIP tracking ${chain.tracking}`);
    if (!chain.ok) lines.push(`  unreachable: ${chain.error ?? "unknown error"}`);
    for (const balance of chain.balances) {
      const name = balance.label === balance.address ? balance.address : `${balance.label} ${balance.address}`;
      lines.push(`  ${name}: ${amountText(config, balance.balance)}`);
    }
    if (chain.total !== undefined) lines.push(`  Reserves: ${amountText(config, chain.total)}`);
    if (chain.totalSupply !== undefined) lines.push(`  totalSupply: ${amountText(config, chain.totalSupply)}`);
    for (const note of chain.notes) lines.push(`  note: ${note}`);
  }
  lines.push(`R (reserves): ${amountText(config, report.R)}`);
  const counted = report.inFlight.filter((entry) => entry.status !== "acknowledged").length;
  const failedInI = report.inFlight.filter((entry) => entry.status === "failed").length;
  const entries = `${counted} entr${counted === 1 ? "y" : "ies"}`;
  lines.push(`I (in flight): ${amountText(config, report.I)} (${entries}, ${failedInI} failed)`);
  for (const [lane, amount] of Object.entries(report.byLane)) lines.push(`  ${lane}: ${amountText(config, amount)}`);
  if (report.uncertain > 0n) lines.push(`  uncertain: ${amountText(config, report.uncertain)}`);
  lines.push(`Required: ${amountText(config, report.required)}`);
  lines.push(`Margin (R − I − required): ${amountText(config, report.margin)}`);
  if (report.inFlight.length) {
    lines.push("In flight at the snapshots:");
    for (const entry of report.inFlight.slice(0, 50)) lines.push(`  ${entryLine(config, entry)}`);
    if (report.inFlight.length > 50) lines.push(`  … ${report.inFlight.length - 50} more`);
  }
  if (report.failed.length) {
    lines.push("Failed messages awaiting manual execution:");
    for (const view of report.failed) {
      const reason = view.failure ? ` (failed ${formatTimestamp(view.failure.at)}: ${view.failure.reason ?? "?"})` : "";
      lines.push(`  ${messageLine(config, view)}${reason} ${ccipMessageUrl(view.messageId)}`);
    }
  }
  if (report.stuck.length) {
    lines.push("Stuck messages (no execution seen):");
    for (const view of report.stuck) {
      const waiting = formatDuration(view.ageSec ?? 0);
      lines.push(`  ${messageLine(config, view)}, waiting ${waiting} ${ccipMessageUrl(view.messageId)}`);
    }
  }
  if (report.incomplete.length) {
    lines.push("Incomplete:");
    for (const reason of report.incomplete) {
      lines.push(`  - ${reason.reason}${reason.blocking ? "" : " (evaluated anyway)"}`);
    }
  }
  return lines.join("\n");
}
