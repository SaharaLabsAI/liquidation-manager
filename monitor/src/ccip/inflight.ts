// The in-flight amount I of design §5 ("principal locked on the source chain but not yet released on the destination,
// including failed messages awaiting execution"), computed from the ccip stores at one snapshot block per chain.
// Pure: reconciliation reads the stores and picks the blocks; tests drive it directly.
import type {Address, Hex} from "viem";

import type {Acknowledgement} from "../config.ts";
import {
  idKey,
  lastFailure,
  successAttempt,
  type ExecAttempt,
  type ExecRecord,
  type ScanState,
  type SentRecord,
} from "./store.ts";

export type InFlightStatus =
  /** Locked by the source snapshot, not executed by the destination snapshot. */
  | "pending"
  /** Locked, and only FAILUREs by the destination snapshot: owed until manually executed. */
  | "failed"
  /** Released by the destination snapshot but locked after the source snapshot: subtracted (the source lags). */
  | "released-ahead"
  /** Destination selector not configured: settlement cannot be seen; counted. */
  | "unknown-destination"
  /** Destination chain has no snapshot (unreachable): counted. */
  | "unverified"
  /** A lock whose CCIP message could not be identified (anomaly or receipt lookup still failing): counted. */
  | "unlinked"
  /** An unlinked lock or a message to an unconfigured chain that the operator acknowledged as settled: not counted. */
  | "acknowledged";

export interface InFlightEntry {
  status: InFlightStatus;
  /** Null for unlinked locks. */
  messageId: Hex | null;
  sourceChain: string;
  destChain: string | null;
  /** Always positive; `released-ahead` entries are subtracted from the total. */
  amount: bigint;
  receiver: Address | null;
  sentBlock: bigint;
  sentAt: number;
  txHash: Hex;
  /** Latest FAILURE at or before the destination snapshot (`failed`). */
  failure?: ExecAttempt;
  /** The operator's note (`acknowledged`). */
  note?: string;
}

export interface InFlightInput {
  /** Snapshot block per chain; chains without one are unreachable. */
  snapshots: Record<string, bigint | undefined>;
  /** Sent records of every tracked source chain. Chains absent here are not tracked (their sends are unknown). */
  sent: Record<string, Record<Hex, SentRecord>>;
  exec: Record<string, Record<Hex, ExecRecord>>;
  scan: Record<string, ScanState>;
  /** `reconciliation.acknowledged`: matching obligations (no automatic settlement path) are listed, not counted. */
  acknowledged?: readonly Acknowledgement[];
}

export interface InFlight {
  /** Net SAHARA in flight across both snapshots (base units). */
  total: bigint;
  /** Part of `total` counted without being able to verify settlement (unlinked, unknown destination, unverified). */
  uncertain: bigint;
  /** Sum per lane, "source→dest" (dest "?" when unknown); released-ahead entries count negative. */
  byLane: Record<string, bigint>;
  entries: InFlightEntry[];
}

/** The operator's acknowledgement of a lock (by transaction) or a message sent from `chain`, if any. */
export function findAcknowledgement(
  acknowledged: readonly Acknowledgement[] | undefined,
  chain: string,
  key: {txHash: Hex} | {messageId: Hex},
): Acknowledgement | undefined {
  const [field, value] = "txHash" in key ? (["txHash", key.txHash] as const) : (["messageId", key.messageId] as const);
  return acknowledged?.find((ack) => ack.chain === chain && ack[field]?.toLowerCase() === value.toLowerCase());
}

/**
 * I = Σ amounts of messages locked at or before their source chain's snapshot and not successfully executed at or
 * before their destination chain's snapshot (FAILUREs included), minus messages executed by the destination snapshot
 * but locked after the source snapshot (both snapshots must describe the same set of transfers for R − I to hold).
 * Locks that cannot be tied to a message, and messages whose settlement cannot be seen, are counted conservatively
 * until the operator acknowledges them.
 */
export function computeInFlight(input: InFlightInput): InFlight {
  const result: InFlight = {total: 0n, uncertain: 0n, byLane: {}, entries: []};
  const add = (entry: InFlightEntry, uncertain = false) => {
    if (entry.status === "acknowledged") {
      result.entries.push(entry);
      return;
    }
    const signed = entry.status === "released-ahead" ? -entry.amount : entry.amount;
    result.total += signed;
    if (uncertain) result.uncertain += entry.amount;
    const lane = `${entry.sourceChain}→${entry.destChain ?? "?"}`;
    result.byLane[lane] = (result.byLane[lane] ?? 0n) + signed;
    result.entries.push(entry);
  };

  for (const [sourceChain, messages] of Object.entries(input.sent)) {
    const sourceBlock = input.snapshots[sourceChain];
    if (sourceBlock === undefined) continue;
    for (const message of Object.values(messages)) {
      const locked = message.sentBlock <= sourceBlock;
      const base = {
        messageId: message.messageId,
        sourceChain,
        destChain: message.destChain,
        amount: message.amount,
        receiver: message.receiver,
        sentBlock: message.sentBlock,
        sentAt: message.sentAt,
        txHash: message.txHash,
      };
      // Settlement on a chain that is not configured can never be seen.
      const unconfigured = message.destChain === null || !(message.destChain in input.snapshots);
      const ack = unconfigured
        ? findAcknowledgement(input.acknowledged, sourceChain, {messageId: message.messageId})
        : undefined;
      if (ack) {
        if (locked) add({...base, status: "acknowledged", note: ack.note});
        continue;
      }
      if (message.destChain === null) {
        if (locked) add({...base, status: "unknown-destination"}, true);
        continue;
      }
      const destBlock = input.snapshots[message.destChain];
      if (destBlock === undefined) {
        if (locked) add({...base, status: "unverified"}, true);
        continue;
      }
      const record = input.exec[message.destChain]?.[idKey(message.messageId)];
      const released = successAttempt(record, destBlock) !== undefined;
      if (locked && !released) {
        const failure = lastFailure(record, destBlock);
        add(failure ? {...base, status: "failed", failure} : {...base, status: "pending"});
      } else if (!locked && released) {
        add({...base, status: "released-ahead"});
      }
    }

    const scan = input.scan[sourceChain];
    for (const lock of scan?.unlinked ?? []) {
      if (lock.block > sourceBlock) continue;
      const ack = findAcknowledgement(input.acknowledged, sourceChain, {txHash: lock.txHash});
      add(
        {
          status: ack ? "acknowledged" : "unlinked",
          messageId: null,
          sourceChain,
          destChain: null,
          amount: lock.amount,
          receiver: null,
          sentBlock: lock.block,
          sentAt: lock.at,
          txHash: lock.txHash,
          ...(ack ? {note: ack.note} : {}),
        },
        true,
      );
    }
    for (const pending of Object.values(scan?.pendingTxs ?? {})) {
      if (pending.locked === 0n || pending.block > sourceBlock) continue;
      const ack = findAcknowledgement(input.acknowledged, sourceChain, {txHash: pending.txHash});
      add(
        {
          status: ack ? "acknowledged" : "unlinked",
          messageId: null,
          sourceChain,
          destChain: null,
          amount: pending.locked,
          receiver: null,
          sentBlock: pending.block,
          sentAt: pending.firstSeenAt,
          txHash: pending.txHash,
          ...(ack ? {note: ack.note} : {}),
        },
        true,
      );
    }
  }

  // A release whose execution could not be identified leaves its message counted above although it was paid out.
  for (const [chain, scan] of Object.entries(input.scan)) {
    const block = input.snapshots[chain];
    if (block === undefined) continue;
    for (const pending of Object.values(scan.pendingTxs)) {
      if (pending.released === 0n || pending.block > block) continue;
      if (findAcknowledgement(input.acknowledged, chain, {txHash: pending.txHash})) continue;
      result.uncertain += pending.released;
    }
  }
  return result;
}
