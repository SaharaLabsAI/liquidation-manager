// Timelock monitoring: the primary mitigation for a compromised Governance Safe. Every proposal is decoded and
// announced with the exact GuardianController cancel transaction, tracked while pending (store namespace
// `timelock:${chain}`), and raised again as it approaches and reaches its ETA, so the Guardian has the whole delay to
// cancel it. Cancellations, executions, delay changes and role changes are reported as they happen.
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  keccak256,
  zeroHash,
  type Address,
  type Hex,
  type Log,
} from "viem";

import {guardianControllerAbi, saharaTimelockAbi} from "../abi/generated.ts";
import {formatDuration, formatTimestamp} from "../format.ts";
import type {Store} from "../store.ts";
import type {
  Alert,
  AlertField,
  AlertLink,
  ChainContext,
  EventRule,
  LogFilter,
  Severity,
  StateCheckReads,
  StateRule,
} from "../types.ts";
import {
  callsSeverity,
  decodeCall,
  hasSelector,
  isProtectedSetGuardian,
  maxSeverity,
  roleName,
  SET_GUARDIAN_SELECTOR,
  unprotectedSetGuardianReason,
  UPDATE_DELAY_SELECTOR,
  type DecodedCall,
  type DecodeOptions,
} from "./calls.ts";
import {
  addressField,
  addressLink,
  blockTimestamps,
  chainNameForSelector,
  groupByTx,
  logKey,
  sameAddress,
  txLink,
} from "./common.ts";
import {summarizeFailures} from "./state-common.ts";

export interface PendingOp {
  id: Hex;
  calls: Array<{target: Address; value: bigint; data: Hex}>;
  predecessor: Hex;
  /** From CallSalt (absent when the salt was 0). */
  salt: Hex | null;
  delay: bigint;
  /** Unix seconds (block timestamp of the scheduling transaction). */
  scheduledAt: number;
  /** scheduledAt + delay; refreshed from `getTimestamp(id)` by the queue rule. */
  readyAt: number;
  txHash: Hex;
  /** One line, e.g. "LiquidityManager.setGuardian(newGuardian=Guardian 0x…)". */
  summary: string;
  severity: Severity;
  /** A standalone protected setGuardian: the Guardian cannot cancel it. */
  protected: boolean;
  status: "pending" | "executed" | "cancelled";
  /**
   * Scheduled with `scheduleBatch` (cancel with `cancelBatch`). A one-call batch logs exactly like `schedule`, so this
   * is decided by recomputing the id; null when the id matches neither encoding (no cancel instruction possible).
   */
  batch: boolean | null;
  /** Block of the scheduling transaction. */
  scheduledBlock: bigint;
  /** Unix seconds at which the op was seen executed or cancelled (for pruning). */
  closedAt?: number;
  /**
   * Key of the scheduled alert of the first scheduling of `id` in `txHash`, reused when the transaction is processed
   * again (a replayed chunk). A transaction can schedule, cancel and schedule an id again: its n-th later scheduling is
   * alerted under `…:<txHash>:<n>`.
   */
  alertKey?: string;
}

interface TimelockState {
  ops: Record<Hex, PendingOp>;
}

const RULE = "timelock";
const QUEUE_RULE = "timelock-queue";
const SOON_SEC = 24 * 3600;
const PRUNE_AFTER_SEC = 30 * 24 * 3600;
/** Hex characters per calldata field, so a Telegram message (4096 chars) can be split on line boundaries. */
const CALLDATA_CHUNK = 3000;

/** OpenZeppelin `TimelockController.OperationState`. */
export const OPERATION_STATE = {Unset: 0, Waiting: 1, Ready: 2, Done: 3} as const;

export function timelockNamespace(chain: string): string {
  return `timelock:${chain}`;
}

/**
 * Store namespace of what each cancelled scheduling was, keyed by `<txHash>:<logIndex>` of its `Cancelled` log. The
 * controller rule describes `ProposalCancelled` from it: the op record may already hold a later scheduling of the same
 * id from the same block range.
 */
export function timelockCancelsNamespace(chain: string): string {
  return `timelock-cancels:${chain}`;
}

/** One cancelled scheduling, as the controller rule reads it. */
export interface CancelledScheduling {
  id: Hex;
  summary: string;
  readyAt: number;
  /** The operation contains a setGuardian call. */
  setGuardian: boolean;
  /** Unix seconds of the cancelling transaction (for pruning). */
  at: number;
}

/**
 * Every operation the monitor tracks on `chain`, keyed by op id: pending ones and those executed or cancelled in the
 * last 30 days (check `status`). The controller rule uses it to describe `ProposalCancelled`.
 */
export function readPendingOps(store: Store, chain: string): Record<Hex, PendingOp> {
  return store.get<TimelockState>(timelockNamespace(chain), {ops: {}}).ops ?? {};
}

function writeOps(store: Store, chain: string, ops: Record<Hex, PendingOp>): void {
  store.set<TimelockState>(timelockNamespace(chain), {ops});
}

type OpCalls = Pick<PendingOp, "id" | "calls" | "predecessor" | "salt">;

/** `TimelockController.hashOperation`. */
export function hashOperation(call: {target: Address; value: bigint; data: Hex}, predecessor: Hex, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{type: "address"}, {type: "uint256"}, {type: "bytes"}, {type: "bytes32"}, {type: "bytes32"}],
      [call.target, call.value, call.data, predecessor, salt],
    ),
  );
}

/** `TimelockController.hashOperationBatch`. */
export function hashOperationBatch(calls: OpCalls["calls"], predecessor: Hex, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{type: "address[]"}, {type: "uint256[]"}, {type: "bytes[]"}, {type: "bytes32"}, {type: "bytes32"}],
      [calls.map((c) => c.target), calls.map((c) => c.value), calls.map((c) => c.data), predecessor, salt],
    ),
  );
}

/** Whether the op id is the `schedule` (false) or `scheduleBatch` (true) hash of its calls; null if neither. */
export function scheduledAsBatch(op: OpCalls): boolean | null {
  const salt = op.salt ?? zeroHash;
  const id = op.id.toLowerCase();
  const [first] = op.calls;
  if (op.calls.length === 1 && first && hashOperation(first, op.predecessor, salt).toLowerCase() === id) return false;
  if (op.calls.length > 0 && hashOperationBatch(op.calls, op.predecessor, salt).toLowerCase() === id) return true;
  return null;
}

export interface GuardianCancel {
  /** The GuardianController; the Guardian Safe sends the transaction with value 0. */
  to: Address;
  fn: "cancel" | "cancelBatch";
  signature: string;
  data: Hex;
}

/**
 * The transaction the Guardian Safe sends to cancel `op`: `GuardianController.cancel(target, value, data,
 * predecessor, salt)` or `cancelBatch(...)`. The controller recomputes the id from these arguments, so this throws
 * unless they reproduce `op.id` exactly. It does not check protection: a protected op reverts with
 * `ProtectedOperation`.
 */
export function guardianCancelCalldata(op: OpCalls, controller: Address): GuardianCancel {
  const batch = scheduledAsBatch(op);
  if (batch === null) throw new Error(`operation ${op.id} does not match its calls, predecessor and salt`);
  const salt = op.salt ?? zeroHash;
  const [first] = op.calls;
  if (!batch && first) {
    return {
      to: getAddress(controller),
      fn: "cancel",
      signature: "cancel(address,uint256,bytes,bytes32,bytes32)",
      data: encodeFunctionData({
        abi: guardianControllerAbi,
        functionName: "cancel",
        args: [first.target, first.value, first.data, op.predecessor, salt],
      }),
    };
  }
  return {
    to: getAddress(controller),
    fn: "cancelBatch",
    signature: "cancelBatch(address[],uint256[],bytes[],bytes32,bytes32)",
    data: encodeFunctionData({
      abi: guardianControllerAbi,
      functionName: "cancelBatch",
      args: [
        op.calls.map((c) => c.target),
        op.calls.map((c) => c.value),
        op.calls.map((c) => c.data),
        op.predecessor,
        salt,
      ],
    }),
  };
}

/** `Timelock.cancel(id)` calldata, for a CANCELLER_ROLE holder such as the Governance Safe. */
export function timelockCancelCalldata(id: Hex): Hex {
  return encodeFunctionData({abi: saharaTimelockAbi, functionName: "cancel", args: [id]});
}

function decodeOptions(ctx: ChainContext, currentDelay?: bigint): DecodeOptions {
  return {
    token: ctx.global.token,
    label: ctx.label,
    chainName: (selector) => chainNameForSelector(ctx, selector),
    currentDelay,
  };
}

function isSetGuardianData(data: Hex): boolean {
  return hasSelector(data, SET_GUARDIAN_SELECTOR);
}

/** One line for an op: the call summary, or "batch of N: A.f, B.g" (bounded so titles stay short). */
function opSummary(decoded: readonly DecodedCall[]): string {
  const [first] = decoded;
  if (decoded.length === 1 && first) return first.summary;
  const names = decoded.map((call) => (call.fn === "unrecognised" ? call.summary : `${call.contract}.${call.fn}`));
  const text = `batch of ${decoded.length}: ${names.join(", ")}`;
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

function shortTitle(decoded: readonly DecodedCall[]): string {
  const name = (call: DecodedCall) =>
    call.fn === "unrecognised" ? "unrecognised call" : `${call.contract}.${call.fn}`;
  const text = [...new Set(decoded.map(name))].join(", ");
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function calldataFields(label: string, data: Hex): AlertField[] {
  if (data.length <= CALLDATA_CHUNK) return [{label, value: data, code: true}];
  const parts: string[] = [];
  for (let i = 0; i < data.length; i += CALLDATA_CHUNK) parts.push(data.slice(i, i + CALLDATA_CHUNK));
  return parts.map((part, i) => ({
    label: `${label} (part ${i + 1}/${parts.length}${i ? ", append without separator" : ""})`,
    value: part,
    code: true,
  }));
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function etaText(readyAt: number, reference: number): string {
  const remaining = readyAt - reference;
  return remaining > 0
    ? `${formatTimestamp(readyAt)} (in ${formatDuration(remaining)})`
    : `${formatTimestamp(readyAt)} (executable now)`;
}

/**
 * The Guardian's options for `op`: the exact cancel transaction, or why there is none. Shared by the scheduled alert
 * and the queue conditions, so every reminder carries the instruction. Before the ETA the deadline is the ETA, after
 * which Governance can execute; once the ETA has passed (`reference`) the operation can still be cancelled until it is
 * executed, so the instruction is to cancel now.
 */
function guardianFields(ctx: ChainContext, op: PendingOp, reference: number): {fields: AlertField[]; note: string} {
  const passed = op.readyAt <= reference;
  const deadline = passed
    ? `now: its ETA (${formatTimestamp(op.readyAt)}) has passed`
    : `before ${formatTimestamp(op.readyAt)}`;
  const fields: AlertField[] = [];
  const timelock = ctx.addresses.timelock;
  const governanceCancel = (): AlertField[] =>
    timelock
      ? [
          addressField(ctx, "Governance cancel: to", timelock),
          ...calldataFields("Governance cancel: calldata", timelockCancelCalldata(op.id)),
        ]
      : [];
  if (op.protected) {
    fields.push({
      label: "Guardian action",
      value:
        "Guardian cannot cancel (protected setGuardian); only the Governance Safe can cancel via Timelock.cancel(id)",
    });
    fields.push(...governanceCancel());
    return {
      fields,
      note:
        "Protected Guardian recovery. Confirm with the Governance Safe signers that this replacement is intended; if " +
        "not, the Governance Safe must cancel it with Timelock.cancel(id) " +
        `${passed ? "now, before it is executed" : "before the ETA"}.`,
    };
  }
  const controller = ctx.addresses.controller;
  if (!controller) {
    fields.push({
      label: "Guardian action",
      value:
        "No GuardianController resolved: no Guardian cancel transaction available. Configure contracts.controller.",
    });
    fields.push(...governanceCancel());
    return {fields, note: "Review every call. Without a GuardianController only a CANCELLER_ROLE holder can cancel."};
  }
  try {
    const cancel = guardianCancelCalldata(op, controller);
    fields.push({
      label: "Guardian action",
      value: `Guardian Safe: call GuardianController.${cancel.signature} (value 0) ${deadline}`,
    });
    fields.push(addressField(ctx, "Cancel tx: to", cancel.to));
    fields.push(...calldataFields("Cancel tx: calldata", cancel.data));
    return {
      fields,
      note:
        "Review every call. If this proposal is not expected, the Guardian Safe must send the cancel transaction " +
        `above ${passed ? "now: it can be cancelled until it is executed" : "before the ETA"}.`,
    };
  } catch {
    fields.push({
      label: "Guardian action",
      value:
        "Cannot build the Guardian cancel calldata: the operation id does not match the logged calls, predecessor " +
        "and salt. Rebuild cancel/cancelBatch from the scheduling transaction input.",
    });
    fields.push(...governanceCancel());
    return {fields, note: "The monitor could not reproduce the operation id; inspect the scheduling transaction."};
  }
}

// ----------------------------------------------------------------------------------------------------------------
// Event rule
// ----------------------------------------------------------------------------------------------------------------

const TIMELOCK_EVENTS = [
  "CallScheduled",
  "CallSalt",
  "Cancelled",
  "CallExecuted",
  "MinDelayChange",
  "RoleGranted",
  "RoleRevoked",
  "RoleAdminChanged",
] as const;

function topic0(abi: typeof saharaTimelockAbi | typeof guardianControllerAbi, eventName: string): Hex {
  const [topic] = encodeEventTopics({abi, eventName} as never) as Hex[];
  if (!topic) throw new Error(`no topic for ${eventName}`);
  return topic;
}

const TIMELOCK_TOPICS = TIMELOCK_EVENTS.map((name) => topic0(saharaTimelockAbi, name));
const PROPOSAL_CANCELLED_TOPIC = topic0(guardianControllerAbi, "ProposalCancelled");

interface ScheduledEntry {
  log: Log;
  index: bigint;
  target: Address;
  value: bigint;
  data: Hex;
  predecessor: Hex;
  delay: bigint;
}

/** One `schedule` / `scheduleBatch` call: the CallScheduled logs it emits back to back, indices increasing. */
interface ScheduleRun {
  id: Hex;
  entries: ScheduledEntry[];
  /** Schedulings of `id` earlier in the transaction (each cancelled before the next one): 0 for the first. */
  ordinal: number;
  /** A later Cancelled of the transaction closes this scheduling, so it is not pending after it. */
  cancelledInTx: boolean;
}

interface ExecutedEntry {
  log: Log;
  index: bigint;
  target: Address;
  value: bigint;
  data: Hex;
}

type DecodedTimelockLog = ReturnType<typeof decodeEventLog<typeof saharaTimelockAbi>>;

interface TxContext {
  txHash: Hex;
  blockNumber: bigint;
  timestamp: number;
  /** The block timestamp was unavailable and `timestamp` is the wall clock. */
  estimated: boolean;
  /** `ProposalCancelled(id, guardian)` emitted by the controller in this transaction. */
  guardianCancels: Map<string, Address>;
}

async function currentDelayAt(ctx: ChainContext, blockNumber: bigint): Promise<bigint | undefined> {
  const timelock = ctx.addresses.timelock;
  if (!timelock) return undefined;
  try {
    return await ctx.client.readContract({
      address: timelock,
      abi: saharaTimelockAbi,
      functionName: "getMinDelay",
      blockNumber,
    });
  } catch (error) {
    ctx.log.warn("timelock: getMinDelay failed", {error, blockNumber});
    return undefined;
  }
}

/**
 * Records and alerts one scheduling. `prior` is the op as stored before this transaction; `firstKey` the key of the
 * transaction's first scheduling of the id, when this is a later one. Returns the key of the alert.
 */
async function handleScheduled(
  ctx: ChainContext,
  ops: Record<Hex, PendingOp>,
  run: ScheduleRun,
  salt: Hex | null,
  prior: PendingOp | undefined,
  firstKey: string | undefined,
  tx: TxContext,
): Promise<string> {
  const {id, entries, ordinal} = run;
  const [first] = entries;
  if (!first) throw new Error(`no CallScheduled for ${id}`);
  const calls = entries.map((entry) => ({target: getAddress(entry.target), value: entry.value, data: entry.data}));
  const predecessor = first.predecessor;
  const delay = first.delay;
  const needsDelay = calls.some(
    (call) => sameAddress(call.target, ctx.addresses.timelock) && hasSelector(call.data, UPDATE_DELAY_SELECTOR),
  );
  const currentDelay = needsDelay ? await currentDelayAt(ctx, tx.blockNumber) : undefined;
  const options = decodeOptions(ctx, currentDelay);
  const decoded = calls.map((call) => decodeCall(call.target, call.value, call.data, ctx.addresses, options));

  const batch = scheduledAsBatch({id, calls, predecessor, salt});
  const [onlyCall] = calls;
  const isProtected =
    calls.length === 1 &&
    !!onlyCall &&
    isProtectedSetGuardian(onlyCall.target, onlyCall.value, onlyCall.data, ctx.addresses.manager);

  let severity = callsSeverity(decoded);
  const warnings: string[] = [];
  if (batch === null) {
    severity = "critical";
    warnings.push(
      `Operation id does not match the logged calls with salt ${salt ?? "0"}: the monitor cannot build a cancel ` +
        "instruction (missing CallSalt?).",
    );
  }
  const indexGap = entries.some((entry, i) => entry.index !== BigInt(i));
  if (indexGap) warnings.push(`Call indices are not contiguous (${entries.map((e) => e.index).join(", ")}).`);
  if (isProtected && BigInt(predecessor) !== 0n) {
    severity = maxSeverity(severity, "high");
    warnings.push(
      "Protected setGuardian has a non-zero predecessor: the recovery cannot execute before the predecessor, and " +
        "cancelling the predecessor stalls it (runbook: predecessor must be 0).",
    );
  }
  if (!isProtected) {
    const guardianCalls = calls.filter((call) => isSetGuardianData(call.data));
    if (guardianCalls.length) {
      severity = maxSeverity(severity, "high");
      const reasons = new Set<string>();
      if (calls.length > 1) reasons.add(`it is one of ${calls.length} calls in a batch`);
      for (const call of guardianCalls) {
        const reason = unprotectedSetGuardianReason(call.target, call.value, call.data, ctx.addresses.manager);
        if (reason) reasons.add(reason);
      }
      warnings.push(
        `setGuardian calldata is NOT protected (${[...reasons].join("; ")}): the current Guardian can cancel this ` +
          "recovery.",
      );
    }
  }

  const rescan = !!prior && prior.txHash.toLowerCase() === tx.txHash.toLowerCase();
  // One alert per scheduling of an id. A re-schedule of a cancelled id is a new proposal, so it gets its own key, and
  // so does each scheduling after the first in one transaction (schedule, cancel, schedule again). A rescan of the
  // transaction keeps the key its first scheduling was alerted under.
  const key = ordinal
    ? `${ctx.name}:${RULE}:scheduled:${id}:${tx.txHash}:${ordinal}`
    : ((rescan ? prior?.alertKey : undefined) ??
      `${ctx.name}:${RULE}:scheduled:${id}${prior && !rescan ? `:${tx.txHash}` : ""}`);
  const op: PendingOp = {
    id,
    calls,
    predecessor,
    salt,
    delay,
    scheduledAt: tx.timestamp,
    readyAt: tx.timestamp + Number(delay),
    txHash: tx.txHash,
    summary: opSummary(decoded),
    severity,
    protected: isProtected,
    status: rescan && prior ? prior.status : "pending",
    batch,
    scheduledBlock: tx.blockNumber,
    alertKey: (ordinal ? firstKey : undefined) ?? key,
    ...(rescan && prior?.closedAt !== undefined ? {closedAt: prior.closedAt} : {}),
  };
  ops[id] = op;

  const fields: AlertField[] = [
    {label: "Operation id", value: id, code: true},
    {
      label: "Executable at",
      value:
        `${etaText(op.readyAt, nowSec())}; delay ${formatDuration(delay)}` +
        (tx.estimated ? " (estimated: block timestamp unavailable)" : ""),
    },
    {label: "Scheduled with", value: batch === null ? "unknown (id mismatch)" : batch ? "scheduleBatch" : "schedule"},
  ];
  decoded.forEach((call, i) => {
    fields.push({label: `Call ${i + 1}/${decoded.length}`, value: call.summary});
    if (call.notes.length) fields.push({label: `Call ${i + 1} warning`, value: call.notes.join(" ")});
  });
  if (BigInt(predecessor) === 0n) {
    fields.push({label: "Predecessor", value: "none"});
  } else {
    const parent = ops[predecessor];
    const parentText = parent ? ` (${parent.status}: ${parent.summary})` : " (not tracked by the monitor)";
    fields.push({label: "Predecessor", value: `${predecessor}${parentText}`, code: true});
  }
  fields.push({label: "Salt", value: salt ?? "0 (none)", code: true});
  for (const warning of warnings) fields.push({label: "Warning", value: warning});
  // Cancelled again before the transaction ended: nothing for the Guardian to cancel.
  const guardian = run.cancelledInTx ? undefined : guardianFields(ctx, op, nowSec());
  if (guardian) fields.push(...guardian.fields);
  else fields.push({label: "Status", value: "Cancelled later in this transaction: not pending, nothing to cancel"});

  const what = decoded.length === 1 ? "operation" : `batch (${decoded.length} calls)`;
  const title = isProtected
    ? "Guardian recovery scheduled on Timelock (protected setGuardian)"
    : `Timelock ${what} scheduled: ${shortTitle(decoded)}`;
  const links: AlertLink[] = [txLink(ctx, tx.txHash)];
  if (ctx.addresses.timelock) links.push(addressLink(ctx, ctx.addresses.timelock));
  if (ctx.addresses.controller && !isProtected) links.push(addressLink(ctx, ctx.addresses.controller));

  ctx.alerter.emit({
    key,
    kind: "event",
    severity,
    rule: "timelock.scheduled",
    chain: ctx.name,
    title: guardian ? title : `${title} (cancelled in the same transaction)`,
    fields,
    links,
    note: guardian?.note,
  });
  return key;
}

function opIncludesSetGuardian(op: PendingOp | undefined): boolean {
  return !!op && op.calls.some((call) => isSetGuardianData(call.data));
}

/**
 * The ETA the scheduling itself set (OpenZeppelin stores block.timestamp + delay). `readyAt` can already hold
 * `getTimestamp(id)` of a later scheduling of the same id, read by the queue rule at the head while the scan lags.
 */
function schedulingEta(op: PendingOp): number {
  return op.scheduledAt + Number(op.delay);
}

function handleCancelled(ctx: ChainContext, ops: Record<Hex, PendingOp>, id: Hex, log: Log, tx: TxContext): void {
  const op = ops[id];
  if (op) {
    op.status = "cancelled";
    op.closedAt = tx.timestamp;
    recordCancel(ctx, `${tx.txHash.toLowerCase()}:${log.logIndex ?? 0}`, {
      id,
      summary: op.summary,
      readyAt: schedulingEta(op),
      setGuardian: opIncludesSetGuardian(op),
      at: tx.timestamp,
    });
  }
  const guardian = tx.guardianCancels.get(id.toLowerCase());
  // Pending ops naming this one as predecessor cannot execute until it is scheduled again and executed.
  const dependents = Object.values(ops).filter(
    (other) => other.status === "pending" && other.predecessor.toLowerCase() === id.toLowerCase(),
  );
  const stallsRecovery = dependents.some((other) => other.protected || opIncludesSetGuardian(other));
  // A cancelled Guardian replacement is what a compromised Guardian (or Governance Safe) would do: page someone. So
  // is a cancel that stalls one.
  const severity: Severity = opIncludesSetGuardian(op) || op?.protected || stallsRecovery ? "critical" : "high";
  const fields: AlertField[] = [
    {label: "Operation id", value: id, code: true},
    {label: "Operation", value: op ? op.summary : "not tracked by the monitor (scheduled before monitoring started?)"},
    guardian
      ? addressField(ctx, "Cancelled by Guardian (via GuardianController)", guardian)
      : {label: "Cancelled by", value: "a CANCELLER_ROLE holder directly (normally the Governance Safe)"},
  ];
  if (op) fields.push({label: "Was executable at", value: formatTimestamp(schedulingEta(op))});
  for (const other of dependents) {
    fields.push({label: "Stalls pending operation", value: `${other.id} (${other.summary})`});
  }
  let title = opIncludesSetGuardian(op)
    ? "Timelock Guardian change cancelled"
    : `Timelock operation cancelled${op ? `: ${shortTitleFromSummary(op.summary)}` : ""}`;
  if (stallsRecovery && !opIncludesSetGuardian(op)) title += " (stalls a pending Guardian recovery)";
  const notes = [
    dependents.length ? predecessorNote(stallsRecovery) : undefined,
    opIncludesSetGuardian(op) ? GUARDIAN_CHANGE_CANCELLED_NOTE : undefined,
  ].filter((note): note is string => note !== undefined);
  ctx.alerter.emit({
    key: logKey(ctx, RULE, log),
    kind: "event",
    severity,
    rule: "timelock.cancelled",
    chain: ctx.name,
    title,
    fields,
    links: [txLink(ctx, tx.txHash)],
    note: notes.length ? notes.join(" ") : undefined,
  });
}

/** What to do after a Guardian change was cancelled: re-propose it in the one form the Guardian cannot cancel. */
export const GUARDIAN_CHANGE_CANCELLED_NOTE =
  "If this Guardian change was not an agreed cancellation, re-propose it as a single protected call: " +
  "LiquidityManager.setGuardian(newGuardian) alone, value 0, predecessor 0 (GuardianController.isProtectedCall " +
  "returns true). The Guardian can cancel it in any other form.";

function recordCancel(ctx: ChainContext, key: string, entry: CancelledScheduling): void {
  const namespace = timelockCancelsNamespace(ctx.name);
  const cancels = ctx.store.get<Record<string, CancelledScheduling>>(namespace, {});
  for (const [other, stored] of Object.entries(cancels)) {
    if (stored.at < entry.at - PRUNE_AFTER_SEC) delete cancels[other];
  }
  // A chunk processed again sees the op as its first pass left it, possibly a later scheduling: keep the first record.
  cancels[key] ??= entry;
  ctx.store.set(namespace, cancels);
}

/** Why an op whose predecessor is not executed cannot run, and what unblocks it. */
function predecessorNote(recovery: boolean): string {
  const note =
    "OpenZeppelin reverts execute with TimelockUnexecutedPredecessor until the predecessor is executed; a cancelled " +
    "predecessor must be scheduled again (same calls and salt) and executed first.";
  return recovery
    ? `${note} The Guardian can cancel a re-proposed predecessor again, so the Guardian recovery must be ` +
        "re-proposed with predecessor 0 (runbook)."
    : note;
}

/**
 * One alert per operation still pending after the first-start backfill, in scheduling order. The backfill is muted, so
 * none of them was alerted when it was scheduled. Same rule and severity as its `timelock.scheduled` alert, with when
 * it was scheduled; the queue rule raises its "executable within 24h" and "executable now" conditions as for any op.
 */
export function pendingAtStartAlerts(ctx: ChainContext, reference = nowSec()): Alert[] {
  const pending = Object.values(readPendingOps(ctx.store, ctx.name)).filter((op) => op.status === "pending");
  pending.sort(
    (a, b) =>
      (a.scheduledBlock === b.scheduledBlock ? 0 : a.scheduledBlock < b.scheduledBlock ? -1 : 1) ||
      a.scheduledAt - b.scheduledAt ||
      a.txHash.localeCompare(b.txHash) ||
      a.id.localeCompare(b.id),
  );
  return pending.map((op) => {
    const guardian = guardianFields(ctx, op, reference);
    const fields: AlertField[] = [
      {label: "Operation id", value: op.id, code: true},
      {label: "Scheduled at", value: `${formatTimestamp(op.scheduledAt)} (block ${op.scheduledBlock})`},
      {label: "Executable at", value: `${etaText(op.readyAt, reference)}; delay ${formatDuration(op.delay)}`},
      {label: "Operation", value: op.summary},
      {
        label: "Predecessor",
        value: BigInt(op.predecessor) === 0n ? "none" : op.predecessor,
        code: BigInt(op.predecessor) !== 0n,
      },
      ...guardian.fields,
    ];
    const links: AlertLink[] = [txLink(ctx, op.txHash)];
    if (ctx.addresses.timelock) links.push(addressLink(ctx, ctx.addresses.timelock));
    const name = shortTitleFromSummary(op.summary);
    return {
      key: `${ctx.name}:${RULE}:pending-at-start:${op.id}:${op.txHash}`,
      kind: "event",
      severity: op.severity,
      rule: "timelock.scheduled",
      chain: ctx.name,
      title: op.protected
        ? "Guardian recovery pending on Timelock since before the monitor started (protected setGuardian)"
        : `Timelock operation pending since before the monitor started: ${name}`,
      fields,
      links,
      note:
        `Scheduled ${formatTimestamp(op.scheduledAt)}, before this monitor's first start, so it was not alerted ` +
        `when scheduled (the first-start backfill is muted). ${guardian.note}`,
    };
  });
}

function shortTitleFromSummary(summary: string): string {
  const head = summary.split("(")[0] ?? summary;
  return head.length > 100 ? `${head.slice(0, 97)}...` : head;
}

function handleExecuted(
  ctx: ChainContext,
  ops: Record<Hex, PendingOp>,
  id: Hex,
  entries: ExecutedEntry[],
  tx: TxContext,
): void {
  const op = ops[id];
  if (op) {
    op.status = "executed";
    op.closedAt = tx.timestamp;
  }
  entries.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  // Decode what actually ran (always available from the log), so ops scheduled before monitoring are still described.
  const decoded = entries.map((entry) =>
    decodeCall(getAddress(entry.target), entry.value, entry.data, ctx.addresses, decodeOptions(ctx)),
  );
  const opSeverity = op ? op.severity : callsSeverity(decoded);
  const severity: Severity = opSeverity === "critical" ? "critical" : "high";
  const fields: AlertField[] = [{label: "Operation id", value: id, code: true}];
  decoded.forEach((call, i) => fields.push({label: `Call ${i + 1}/${decoded.length}`, value: call.summary}));
  if (!op) fields.push({label: "Note", value: "Scheduling not seen by the monitor (before its start block?)."});
  ctx.alerter.emit({
    key: `${ctx.name}:${RULE}:executed:${id}`,
    kind: "event",
    severity,
    rule: "timelock.executed",
    chain: ctx.name,
    title: `Timelock operation executed: ${shortTitle(decoded)}`,
    fields,
    links: [txLink(ctx, tx.txHash)],
  });
}

function handleAdminEvent(ctx: ChainContext, decoded: DecodedTimelockLog, log: Log, tx: TxContext): void {
  const base = {key: logKey(ctx, RULE, log), kind: "event" as const, severity: "critical" as const, chain: ctx.name};
  const links = [txLink(ctx, tx.txHash)];
  switch (decoded.eventName) {
    case "MinDelayChange": {
      const {oldDuration, newDuration} = decoded.args;
      ctx.alerter.emit({
        ...base,
        rule: "timelock.delay",
        title: `Timelock delay changed: ${formatDuration(oldDuration, true)} -> ${formatDuration(newDuration, true)}`,
        fields: [
          {label: "Old delay", value: `${formatDuration(oldDuration)} (${oldDuration}s)`},
          {label: "New delay", value: `${formatDuration(newDuration)} (${newDuration}s)`},
        ],
        links,
      });
      return;
    }
    case "RoleGranted":
    case "RoleRevoked": {
      const {role, account, sender} = decoded.args;
      const verb = decoded.eventName === "RoleGranted" ? "granted" : "revoked";
      ctx.alerter.emit({
        ...base,
        rule: "timelock.role",
        title: `Timelock ${roleName(role)} ${verb}: ${ctx.label(account)}`,
        fields: [
          {label: "Role", value: roleName(role), code: true},
          addressField(ctx, "Account", account),
          addressField(ctx, "Sender", sender),
        ],
        links,
      });
      return;
    }
    case "RoleAdminChanged": {
      const {role, previousAdminRole, newAdminRole} = decoded.args;
      ctx.alerter.emit({
        ...base,
        rule: "timelock.role",
        title: `Timelock admin role of ${roleName(role)} changed`,
        fields: [
          {label: "Role", value: roleName(role), code: true},
          {label: "Previous admin role", value: roleName(previousAdminRole), code: true},
          {label: "New admin role", value: roleName(newAdminRole), code: true},
        ],
        links,
      });
      return;
    }
    default:
      return;
  }
}

/** `chunkStart`: the ops as stored before the chunk (`ops` as of this transaction is updated in place). */
async function processTx(
  ctx: ChainContext,
  ops: Record<Hex, PendingOp>,
  chunkStart: Record<Hex, PendingOp>,
  txLogs: Log[],
  timestamps: Map<bigint, number>,
): Promise<void> {
  const timelock = ctx.addresses.timelock;
  const controller = ctx.addresses.controller;
  const [firstLog] = txLogs;
  if (!firstLog?.transactionHash || firstLog.blockNumber === null) return;
  const tx: TxContext = {
    txHash: firstLog.transactionHash,
    blockNumber: firstLog.blockNumber,
    timestamp: timestamps.get(firstLog.blockNumber) ?? nowSec(),
    estimated: !timestamps.has(firstLog.blockNumber),
    guardianCancels: new Map(),
  };

  // The Timelock logs in order; a scheduling appears once, at its first CallScheduled log, carrying all of them.
  const decodedLogs: Array<{log: Log; event: DecodedTimelockLog; run?: ScheduleRun}> = [];
  const runs = new Map<Hex, ScheduleRun>();
  const executed = new Map<Hex, ExecutedEntry[]>();
  // The salt is part of the id, so every scheduling of an id has the same one.
  const salts = new Map<Hex, Hex>();
  let open: ScheduleRun | undefined;
  for (const log of txLogs) {
    try {
      if (sameAddress(log.address, controller)) {
        const event = decodeEventLog({abi: guardianControllerAbi, data: log.data, topics: log.topics, strict: true});
        if (event.eventName === "ProposalCancelled") {
          tx.guardianCancels.set(event.args.id.toLowerCase(), event.args.guardian);
        }
        continue;
      }
      if (!sameAddress(log.address, timelock)) continue;
      const event = decodeEventLog({abi: saharaTimelockAbi, data: log.data, topics: log.topics, strict: true});
      if (event.eventName === "CallScheduled") {
        const {id, index, target, value, data, predecessor, delay} = event.args;
        const entry = {log, index, target, value, data, predecessor, delay};
        // One schedule/scheduleBatch call logs its calls back to back with increasing indices. Any other Timelock log,
        // another id or an index not above the last one starts the next scheduling: the Governance Safe can schedule,
        // cancel and schedule the same id again in one transaction, and those must not merge into one batch.
        const last = open?.entries.at(-1);
        if (open && last && open.id === id && index > last.index) {
          open.entries.push(entry);
          continue;
        }
        const previous = runs.get(id);
        open = {id, entries: [entry], ordinal: previous ? previous.ordinal + 1 : 0, cancelledInTx: false};
        runs.set(id, open);
        decodedLogs.push({log, event, run: open});
        continue;
      }
      open = undefined;
      decodedLogs.push({log, event});
      if (event.eventName === "CallSalt") {
        salts.set(event.args.id, event.args.salt);
      } else if (event.eventName === "Cancelled") {
        const run = runs.get(event.args.id);
        if (run) run.cancelledInTx = true;
      } else if (event.eventName === "CallExecuted") {
        const {id, index, target, value, data} = event.args;
        const list = executed.get(id) ?? [];
        list.push({log, index, target, value, data});
        executed.set(id, list);
      }
    } catch (error) {
      ctx.log.warn("timelock: cannot decode log", {error, tx: log.transactionHash, logIndex: log.logIndex});
    }
  }

  // The scheduled ops as stored before this transaction. Copies, since a Cancelled updates the stored op in place:
  // on a rescan the stored op is the transaction's last scheduling, which a Cancelled ahead of it must not change. A
  // chunk processed again (a later rule failed on it, or a crash) starts from the state its first pass left, so an op
  // this transaction scheduled is taken as stored before the chunk: a Cancelled in an earlier transaction of the chunk
  // closed an earlier scheduling, not this one.
  const before = new Map<Hex, PendingOp | undefined>();
  for (const id of runs.keys()) {
    const stored = chunkStart[id];
    const rescan = stored && stored.txHash.toLowerCase() === tx.txHash.toLowerCase();
    before.set(id, rescan ? {...stored} : ops[id] ? {...ops[id]} : undefined);
  }
  const firstKeys = new Map<Hex, string>();

  // Walk the transaction in log order, one scheduling at a time, so the stored op ends in its on-chain state (e.g.
  // pending after schedule, cancel, schedule). A scheduling is handled once its CallSalt (emitted after its
  // CallScheduled logs) has been collected above.
  const done = new Set<string>();
  for (const {log, event, run} of decodedLogs) {
    try {
      switch (event.eventName) {
        case "CallScheduled": {
          if (!run) break;
          const id = run.id;
          let key: string;
          try {
            key = await handleScheduled(ctx, ops, run, salts.get(id) ?? null, before.get(id), firstKeys.get(id), tx);
          } catch (error) {
            // Never let a decoding bug hide a proposal: fall back to a bare critical alert.
            ctx.log.error("timelock: failed to describe scheduled operation", {error, id, tx: tx.txHash});
            // Unique per scheduling, so a failure on a re-scheduled id is not deduped against the first alert.
            key = `${ctx.name}:${RULE}:scheduled:${id}:${tx.txHash}${run.ordinal ? `:${run.ordinal}` : ""}`;
            ctx.alerter.emit({
              key,
              kind: "event",
              severity: "critical",
              rule: "timelock.scheduled",
              chain: ctx.name,
              title: "Timelock operation scheduled (monitor could not decode it)",
              fields: [{label: "Operation id", value: id, code: true}],
              links: [txLink(ctx, tx.txHash)],
              note:
                "Inspect the scheduling transaction now. It can be executed from its ETA, so a cancel must land " +
                "before then.",
            });
          }
          if (!run.ordinal) firstKeys.set(id, key);
          break;
        }
        case "Cancelled":
          handleCancelled(ctx, ops, event.args.id, log, tx);
          break;
        case "CallExecuted": {
          // Grouped by id: an executed id cannot be scheduled again, and an executeBatch's CallExecuted logs can be
          // interleaved with Timelock events of its own calls (e.g. MinDelayChange of an updateDelay).
          const id = event.args.id;
          if (done.has(`e:${id}`)) break;
          done.add(`e:${id}`);
          handleExecuted(ctx, ops, id, executed.get(id) ?? [], tx);
          break;
        }
        case "CallSalt":
          break;
        default:
          handleAdminEvent(ctx, event, log, tx);
      }
    } catch (error) {
      ctx.log.warn("timelock: failed to process log", {error, tx: tx.txHash, logIndex: log.logIndex});
    }
  }
}

export const timelockEventsRule: EventRule = {
  id: RULE,
  filters(ctx: ChainContext): LogFilter[] {
    const filters: LogFilter[] = [];
    if (!ctx.addresses.timelock) return filters;
    filters.push({address: ctx.addresses.timelock, topics: [TIMELOCK_TOPICS]});
    // Attributes a Cancelled to the Guardian; the controller rule alerts on ProposalCancelled itself.
    if (ctx.addresses.controller) {
      filters.push({address: ctx.addresses.controller, topics: [[PROPOSAL_CANCELLED_TOPIC]]});
    }
    return filters;
  },
  async onLogs(ctx: ChainContext, logs: Log[]): Promise<void> {
    const timelock = ctx.addresses.timelock;
    if (!timelock) return;
    const relevant = logs.filter(
      (log) => sameAddress(log.address, timelock) || sameAddress(log.address, ctx.addresses.controller),
    );
    if (!relevant.some((log) => sameAddress(log.address, timelock))) return;

    let timestamps = new Map<bigint, number>();
    try {
      timestamps = await blockTimestamps(ctx, relevant.filter((log) => sameAddress(log.address, timelock)));
    } catch (error) {
      // ETAs fall back to the wall clock; the queue rule corrects readyAt from getTimestamp(id).
      ctx.log.warn("timelock: block timestamps unavailable", {error});
    }

    const ops = readPendingOps(ctx.store, ctx.name);
    const chunkStart = structuredClone(ops);
    for (const txLogs of groupByTx(relevant).values()) {
      try {
        await processTx(ctx, ops, chunkStart, txLogs, timestamps);
      } catch (error) {
        ctx.log.warn("timelock: failed to process transaction", {error, tx: txLogs[0]?.transactionHash});
      }
    }
    writeOps(ctx.store, ctx.name, ops);
  },
};

// ----------------------------------------------------------------------------------------------------------------
// Queue rule
// ----------------------------------------------------------------------------------------------------------------

/** "Executable within 24h" is one level below the op itself, but never below warning. */
function downgrade(severity: Severity): Severity {
  if (severity === "critical") return "high";
  return "warning";
}

const PREDECESSOR_STATE_TEXT: Record<number, string> = {
  [OPERATION_STATE.Unset]: "not scheduled: cancelled or never proposed",
  [OPERATION_STATE.Waiting]: "scheduled, not executable yet",
  [OPERATION_STATE.Ready]: "executable, not executed yet",
};

/** `predecessorState`: OperationState of the unexecuted predecessor of a `blocked` op. */
function queueCondition(
  ctx: ChainContext,
  op: PendingOp,
  subject: "soon" | "ready" | "blocked",
  reference: number,
  predecessorState?: number,
): Alert {
  const guardian = guardianFields(ctx, op, reference);
  const name = shortTitleFromSummary(op.summary);
  const blocked = subject === "blocked";
  const fields: AlertField[] = [
    {label: "Operation id", value: op.id, code: true},
    {label: "Operation", value: op.summary},
    {
      label: "Executable at",
      value: blocked ? `${formatTimestamp(op.readyAt)} (ETA passed)` : etaText(op.readyAt, reference),
    },
    {label: "Scheduled", value: formatTimestamp(op.scheduledAt)},
  ];
  if (blocked) {
    const state = PREDECESSOR_STATE_TEXT[predecessorState ?? -1] ?? `state ${predecessorState}`;
    fields.push({label: "Predecessor", value: `${op.predecessor} (${state})`, code: true});
  }
  fields.push(...guardian.fields);
  const titles = {
    soon: `Timelock operation executable within 24h: ${name}`,
    ready: `Timelock operation executable now: ${name}`,
    blocked: `Timelock operation blocked by its predecessor: ${name}`,
  };
  return {
    key: `${ctx.name}:${QUEUE_RULE}:${op.id}:${subject}`,
    kind: "condition",
    severity: subject === "soon" ? downgrade(op.severity) : op.severity,
    rule: `timelock-queue.${subject}`,
    chain: ctx.name,
    title: titles[subject],
    fields,
    links: [txLink(ctx, op.txHash)],
    note: blocked
      ? `${predecessorNote(op.protected || opIncludesSetGuardian(op))} ${guardian.note}`
      : guardian.note,
  };
}

/**
 * OperationState of `op`'s predecessor when it is not executed yet (undefined when there is none or it is Done).
 * OpenZeppelin's getOperationState ignores the predecessor, so a Ready op can still revert on execute.
 */
async function unexecutedPredecessor(
  ctx: ChainContext,
  timelock: Address,
  op: PendingOp,
  blockNumber: bigint,
): Promise<number | undefined> {
  if (BigInt(op.predecessor) === 0n) return undefined;
  const state = Number(
    await ctx.client.readContract({
      address: timelock,
      abi: saharaTimelockAbi,
      functionName: "getOperationState",
      args: [op.predecessor],
      blockNumber,
    }),
  );
  return state === OPERATION_STATE.Done ? undefined : state;
}

export const timelockQueueRule: StateRule = {
  id: QUEUE_RULE,
  async check(ctx: ChainContext, blockNumber: bigint) {
    const timelock = ctx.addresses.timelock;
    if (!timelock) return {conditions: [], snapshot: {}};
    const conditions: Alert[] = [];
    const ops = readPendingOps(ctx.store, ctx.name);
    // `failures` is what the alert lists, `reads` names every read the same in every check (see StateRule).
    const failures: string[] = [];
    const reads: StateCheckReads = {ok: [], failed: [], complete: true};
    const failed = (read: string, display = read) => {
      failures.push(display);
      reads.failed.push(read);
    };

    let reference: number;
    try {
      reference = Number((await ctx.client.getBlock({blockNumber})).timestamp);
      reads.ok.push("block timestamp");
    } catch (error) {
      ctx.log.warn("timelock-queue: getBlock failed", {error, blockNumber});
      failed("block timestamp", `block ${blockNumber} timestamp`);
      reference = nowSec();
    }

    for (const op of Object.values(ops)) {
      if (op.status !== "pending") continue;
      let ready = op.readyAt <= reference;
      // Scheduled after the block being checked (should not happen): nothing to read yet.
      if (op.scheduledBlock === undefined || op.scheduledBlock <= blockNumber) {
        try {
          const [state, timestamp] = await Promise.all([
            ctx.client.readContract({
              address: timelock,
              abi: saharaTimelockAbi,
              functionName: "getOperationState",
              args: [op.id],
              blockNumber,
            }),
            ctx.client.readContract({
              address: timelock,
              abi: saharaTimelockAbi,
              functionName: "getTimestamp",
              args: [op.id],
              blockNumber,
            }),
          ]);
          reads.ok.push(op.id);
          if (Number(state) === OPERATION_STATE.Done) {
            ctx.log.info("timelock-queue: operation executed (event not seen)", {id: op.id});
            op.status = "executed";
            op.closedAt = reference;
            continue;
          }
          if (Number(state) === OPERATION_STATE.Unset) {
            ctx.log.warn("timelock-queue: operation no longer scheduled (cancelled, event not seen)", {id: op.id});
            op.status = "cancelled";
            op.closedAt = reference;
            continue;
          }
          if (timestamp > 1n) op.readyAt = Number(timestamp);
          ready = Number(state) === OPERATION_STATE.Ready;
        } catch (error) {
          ctx.log.warn("timelock-queue: cannot read operation state", {error, id: op.id});
          failed(op.id);
        }
      }
      if (ready) {
        let predecessorState: number | undefined;
        const predecessor = `${op.predecessor} (predecessor of ${op.id})`;
        try {
          predecessorState = await unexecutedPredecessor(ctx, timelock, op, blockNumber);
          reads.ok.push(predecessor);
        } catch (error) {
          ctx.log.warn("timelock-queue: cannot read predecessor state", {error, id: op.id});
          failed(predecessor);
        }
        if (predecessorState === undefined) conditions.push(queueCondition(ctx, op, "ready", reference));
        else conditions.push(queueCondition(ctx, op, "blocked", reference, predecessorState));
      } else if (op.readyAt - reference < SOON_SEC) {
        conditions.push(queueCondition(ctx, op, "soon", reference));
      }
    }

    for (const [id, op] of Object.entries(ops) as Array<[Hex, PendingOp]>) {
      if (op.status !== "pending" && (op.closedAt ?? op.readyAt) < reference - PRUNE_AFTER_SEC) delete ops[id];
    }
    writeOps(ctx.store, ctx.name, ops);

    if (failures.length) {
      conditions.push({
        key: `${ctx.name}:${QUEUE_RULE}:read-failed`,
        kind: "condition",
        severity: "warning",
        rule: "timelock-queue.read-failed",
        chain: ctx.name,
        title: "Cannot verify the Timelock queue",
        fields: [{label: "Failed reads", value: summarizeFailures(failures), code: true}],
        note: "Pending operations are still evaluated against their stored ETA.",
      });
    }

    const pending = Object.values(ops)
      .filter((op) => op.status === "pending")
      .sort((a, b) => a.readyAt - b.readyAt);
    const [next] = pending;
    const snapshot: Record<string, string> = {
      "Pending Timelock operations": String(pending.length),
      "Next Timelock ETA": next ? `${etaText(next.readyAt, reference)}: ${next.summary}` : "none",
    };
    return {conditions, snapshot, reads};
  },
};
