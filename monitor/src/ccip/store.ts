// CCIP message tracking state: written by the ccip event rule (src/ccip/tracker.ts), read by reconciliation
// (src/rules/reconcile.ts). All namespaces live in the one shared store, so each chain's rule can join its executions
// with the counterpart chain's sends (and vice versa) by messageId, the cross-chain key of both ramp families.
//
//   ccip:sent:${chain}  SAHARA messages sent from this chain's watched pools (source side).
//   ccip:exec:${chain}  Executions on this chain's OffRamps of SAHARA messages, and every FAILURE from a counterpart
//                       lane (a failure has no pool logs, so it may only be attributable later by the join).
//   ccip:scan:${chain}  The block range the rule has processed (and the gaps in it), the Router's ramps and lookups
//                       still to retry.
//
// Nothing that can change I is dropped because of its age: unlinked locks, transactions awaiting their receipt, sends
// without a SUCCESS and SAHARA failures stay until settled (or acknowledged by the operator, see src/ccip/inflight.ts).
// Settled records and executions without a send are dropped by scan coverage only (pruneSent, pruneExec), so the
// result does not depend on which chain is scanned first or how old the scanned blocks are.
import type {Address, Hex} from "viem";

import {MESSAGE_EXECUTION_STATE, type OffRampKind, type OnRampKind} from "../abi/ccip.ts";
import {includesAddress} from "../rules/common.ts";
import type {Store} from "../store.ts";
import type {BlockRange} from "../types.ts";

/**
 * Coverage margin in block time: a record is only dropped once the scans have processed this far past it. Far beyond
 * finality, so every later snapshot holds both sides of a settled message, and beyond any clock skew between chains.
 */
export const RETENTION_SEC = 14 * 24 * 3600;

export const SUCCESS = MESSAGE_EXECUTION_STATE.SUCCESS;
export const FAILURE = MESSAGE_EXECUTION_STATE.FAILURE;

export interface SentRecord {
  messageId: Hex;
  /** Config name of the chain the message was sent from (the chain whose store holds the record). */
  sourceChain: string;
  destSelector: bigint;
  /** Config name of the destination chain; null when its selector is not configured (settlement cannot be seen). */
  destChain: string | null;
  /** SAHARA locked in the source pool for this message (base units); released 1:1 on the destination. */
  amount: bigint;
  /** Receives the release on the destination. */
  receiver: Address | null;
  /** Router caller: the `from` of the token Transfer into the pool (often an aggregator, not the EOA). */
  sender: Address;
  pool: Address;
  onRamp: Address;
  kind: OnRampKind;
  /** Per-lane message number (2.0.0) or sequence number (EVM2EVM), as the CCIP explorer shows it. */
  sequenceNumber: bigint;
  sentBlock: bigint;
  /** Unix seconds (block timestamp). */
  sentAt: number;
  txHash: Hex;
  /** logIndex of the OnRamp send event. */
  logIndex: number;
}

export interface ExecAttempt {
  state: typeof SUCCESS | typeof FAILURE;
  block: bigint;
  txHash: Hex;
  logIndex: number;
  /** Unix seconds (block timestamp). */
  at: number;
  /** describeExecutionError(returnData), FAILURE only. */
  reason?: string;
}

/** Why an execution is known to carry SAHARA. */
export type SaharaEvidence = "release" | "sent" | "error-target";

export interface ExecRecord {
  messageId: Hex;
  /** Config name of the source chain; null when the lane's selector is not configured. */
  sourceChain: string | null;
  sourceSelector: bigint | null;
  sequenceNumber: bigint;
  kind: OffRampKind;
  offRamp: Address;
  /** Null: a FAILURE not (yet) attributable to SAHARA, kept so a later join with the source's sends can. */
  sahara: SaharaEvidence | null;
  /** The watched pool's ReleasedOrMinted attributed to the SUCCESS. */
  release?: {pool: Address; recipient: Address; amount: bigint; txHash: Hex; logIndex: number};
  /**
   * Every final state change seen, in chain order. A FAILURE can be followed by a manual re-execution SUCCESS (same
   * messageId); a second failed manual attempt on OffRamp 2.0.0 reverts and leaves no log.
   */
  attempts: ExecAttempt[];
}

/** A transaction whose pool log could not be linked from the scanned logs and whose receipt fetch failed. */
export interface PendingTx {
  txHash: Hex;
  block: bigint;
  /** Unlinked SAHARA amount locked (lock) or released (release) by watched pools in the transaction. */
  locked: bigint;
  released: bigint;
  firstSeenAt: number;
  attempts: number;
  error: string;
}

/** An OffRamp the Router authorises for a source chain (EVM2EVM execution events lack the source selector). */
export interface OffRampLane {
  offRamp: Address;
  sourceChainSelector: bigint;
}

/**
 * Ramp logs of a block range that still have to be fetched (ramps that appeared on the Router mid-range). Kept until
 * its logs are recorded, with its OffRamps' lanes: their executions there count even once the Router dropped them.
 */
export interface Backfill {
  from: bigint;
  to: bigint;
  onRamps: Address[];
  offRamps: Address[];
  /** Lanes of `offRamps` as the Router listed them (state saved without them: those of the stored ramps). */
  offRampLanes: OffRampLane[];
  firstSeenAt: number;
  attempts: number;
}

/** A lock whose send event does not carry this pool's transfer: counted in I, never settles on its own. */
export interface UnlinkedLock {
  txHash: Hex;
  logIndex: number;
  block: bigint;
  pool: Address;
  amount: bigint;
  remoteSelector: bigint;
  at: number;
}

export interface ScanState {
  /**
   * First and last block this chain's ccip rule has processed (inclusive), except `gaps`. Reconciliation never
   * snapshots past `to`.
   */
  cursor?: {from: bigint; to: bigint};
  /**
   * Block time (unix seconds) the forward scan has reached: the timestamp of `cursor.to` when it was last read, so a
   * lower bound of it (unset until a read succeeds). Never the wall clock: pruning relies on it.
   */
  coveredAt?: number;
  /** Router OnRamps for the counterpart selectors and OffRamps for them, as of `rampsBlock`. */
  onRamps: Address[];
  offRamps: OffRampLane[];
  rampsBlock?: bigint;
  /** Set while the Router's ramps cannot be read (failures from new OffRamps would be missed). */
  rampsError?: string;
  pendingTxs: Record<Hex, PendingTx>;
  backfills: Backfill[];
  unlinked: UnlinkedLock[];
  /**
   * Block ranges inside `cursor` that were skipped (e.g. tracking disabled for a while), until a scan of the range
   * fills them (ccipEventsRule.onLogs with a range at or below `cursor.to`). Never expire. `offRampLanes`: the
   * OffRamps known when the gap was recorded (the Router's at both its ends), which its fill watches also when the
   * node no longer serves the Router's state there (absent in state saved before it was kept).
   */
  gaps: Array<{from: bigint; to: bigint; detectedAt: number; offRampLanes?: OffRampLane[]}>;
}

export const sentNamespace = (chain: string): string => `ccip:sent:${chain}`;
export const execNamespace = (chain: string): string => `ccip:exec:${chain}`;
export const scanNamespace = (chain: string): string => `ccip:scan:${chain}`;

export function readSent(store: Store, chain: string): Record<Hex, SentRecord> {
  return store.get<{messages: Record<Hex, SentRecord>}>(sentNamespace(chain), {messages: {}}).messages ?? {};
}

export function writeSent(store: Store, chain: string, messages: Record<Hex, SentRecord>): void {
  store.set(sentNamespace(chain), {messages});
}

export function readExec(store: Store, chain: string): Record<Hex, ExecRecord> {
  return store.get<{messages: Record<Hex, ExecRecord>}>(execNamespace(chain), {messages: {}}).messages ?? {};
}

export function writeExec(store: Store, chain: string, messages: Record<Hex, ExecRecord>): void {
  store.set(execNamespace(chain), {messages});
}

export function emptyScanState(): ScanState {
  return {onRamps: [], offRamps: [], pendingTxs: {}, backfills: [], unlinked: [], gaps: []};
}

export function readScan(store: Store, chain: string): ScanState {
  const scan = {...emptyScanState(), ...store.get<Partial<ScanState>>(scanNamespace(chain), {})};
  // Backfills saved without lanes (bare OffRamp addresses): those the stored ramps give; laneOf() falls back for the
  // rest (the event's selector, the current ramps, a pool release, a single counterpart).
  scan.backfills = scan.backfills.map((entry) =>
    entry.offRampLanes
      ? entry
      : {...entry, offRampLanes: scan.offRamps.filter((lane) => includesAddress(entry.offRamps, lane.offRamp))},
  );
  return scan;
}

export function writeScan(store: Store, chain: string, state: ScanState): void {
  store.set(scanNamespace(chain), state);
}

/** Block ranges inside the chain's scanned range that its ccip rule has not processed (fill them by scanning them). */
export function ccipGaps(store: Store, chain: string): BlockRange[] {
  return readScan(store, chain).gaps.map((gap) => ({from: gap.from, to: gap.to}));
}

/** messageIds are compared lowercase (events and stores may differ in case). */
export function idKey(messageId: Hex): Hex {
  return messageId.toLowerCase() as Hex;
}

/** First SUCCESS at or before `block` (any block when omitted). */
export function successAttempt(record: ExecRecord | undefined, block?: bigint): ExecAttempt | undefined {
  return record?.attempts.find(
    (attempt) => attempt.state === SUCCESS && (block === undefined || attempt.block <= block),
  );
}

/** Last FAILURE at or before `block` (any block when omitted). */
export function lastFailure(record: ExecRecord | undefined, block?: bigint): ExecAttempt | undefined {
  const failures = (record?.attempts ?? []).filter(
    (attempt) => attempt.state === FAILURE && (block === undefined || attempt.block <= block),
  );
  return failures.at(-1);
}

/**
 * Execution status of a message on the destination as of `block` (latest known when omitted): executed once any
 * SUCCESS is at or before it, failed when only FAILUREs are, pending when nothing is.
 */
export function executionStatus(record: ExecRecord | undefined, block?: bigint): "executed" | "failed" | "pending" {
  if (successAttempt(record, block)) return "executed";
  if (lastFailure(record, block)) return "failed";
  return "pending";
}

/** Adds an attempt unless the same log is already recorded; keeps chain order. Returns true when it was new. */
export function addAttempt(record: ExecRecord, attempt: ExecAttempt): boolean {
  const known = record.attempts.some(
    (existing) =>
      existing.txHash.toLowerCase() === attempt.txHash.toLowerCase() && existing.logIndex === attempt.logIndex,
  );
  if (known) return false;
  record.attempts.push(attempt);
  record.attempts.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  return true;
}

/** The chain's forward scan has reached block time `at` + RETENTION_SEC. */
function scannedPast(scan: ScanState, at: number): boolean {
  return scan.coveredAt !== undefined && scan.coveredAt > at + RETENTION_SEC;
}

/**
 * Drops sent records of executed messages once both chains' scans are RETENTION_SEC past them: the source past the
 * send, the destination past the SUCCESS. Exec records are only dropped once their sent record is gone (pruneExec), so
 * a sent record never outlives its execution and reappears as in flight.
 */
export function pruneSent(
  sent: Record<Hex, SentRecord>,
  execOf: (chain: string) => Record<Hex, ExecRecord>,
  scanOf: (chain: string) => ScanState,
): number {
  let removed = 0;
  for (const [id, record] of Object.entries(sent) as Array<[Hex, SentRecord]>) {
    if (!record.destChain || !scannedPast(scanOf(record.sourceChain), record.sentAt)) continue;
    const success = successAttempt(execOf(record.destChain)[idKey(record.messageId)]);
    if (success && scannedPast(scanOf(record.destChain), success.at)) {
      delete sent[id];
      removed++;
    }
  }
  return removed;
}

/**
 * Drops exec records without a sent record that the source chain's scan can no longer produce: settled ones (a SUCCESS)
 * and failures never attributed to SAHARA (another token's). The send precedes the first execution attempt, so once
 * the source's scan has processed every block from its first one (no gaps) to RETENTION_SEC past that attempt, and
 * linked every lock it saw (none awaiting its receipt), a send not recorded by then was before the scanned history. A
 * SAHARA failure without a SUCCESS is owed and always kept.
 */
export function pruneExec(
  exec: Record<Hex, ExecRecord>,
  sentOf: (chain: string) => Record<Hex, SentRecord>,
  scanOf: (chain: string) => ScanState,
): number {
  let removed = 0;
  for (const [id, record] of Object.entries(exec) as Array<[Hex, ExecRecord]>) {
    if (!successAttempt(record) && record.sahara !== null) continue;
    // A lane whose source is not configured can never be joined.
    if (record.sourceChain !== null) {
      if (idKey(record.messageId) in sentOf(record.sourceChain)) continue;
      const source = scanOf(record.sourceChain);
      const first = record.attempts[0];
      if (!first || !source.cursor || source.gaps.length > 0 || !scannedPast(source, first.at)) continue;
      // A lock whose receipt is still to be fetched may be this message's send (its block time is not known).
      if (Object.values(source.pendingTxs).some((pending) => pending.locked > 0n)) continue;
    }
    delete exec[id];
    removed++;
  }
  return removed;
}
