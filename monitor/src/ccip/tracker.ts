// CCIP message tracking, rule id "ccip" (runs per chain). Feeds the in-flight amount I of the reconciliation and alerts
// the moment a SAHARA message fails on the destination.
//
// Source side: every LockedOrBurned of a watched pool is one bridge send. Its `sender` is the OnRamp (the pool only
// accepts lockOrBurn from the Router's OnRamp), and the OnRamp's send event follows it in the same transaction:
// CCIPMessageSent (OnRamp 2.0.0) or CCIPSendRequested (EVM2EVMOnRamp 1.5.0, which lacks the destination selector; the
// lock's remoteChainSelector supplies it). Recorded in `ccip:sent:${chain}` keyed by messageId.
//
// Destination side: ExecutionStateChanged of every OffRamp the Router authorises for a counterpart lane (OffRamp 2.0.0
// and the EVM2EVM 1.5.0/1.2.0 OffRamps still on it; 1.5-era messages can only be (re-)executed on 1.5.0).
// - SUCCESS carries SAHARA iff a watched pool's ReleasedOrMinted precedes it: pool logs belong to the next
//   ExecutionStateChanged of the releasing OffRamp (the release's `sender`); EVM2EVM 1.5.0 batches messages per tx.
// - FAILURE has no pool logs (the release reverted). It is attributed by joining with the counterpart's sent store,
//   or by an OffRamp 2.0.0 TokenHandlingError whose target is the token or a pool. Other failures are kept, because
//   the counterpart may be scanned later (the join is then made, and alerted, from the source side).
// A manual re-execution of a failed message emits another ExecutionStateChanged with the same messageId.
//
// The Router's ramps are read at the end of each range and kept in `ccip:scan:${chain}`, because `filters()` cannot
// read the chain; ramps that appear mid-range are fetched here for the whole range. A fetch that fails is retried every
// cycle (a backfill, kept until its logs are recorded) with those ramps and their lanes, whose executions there count
// even once the Router dropped them. A pool log whose ramp log is not among the scanned logs is resolved from the
// transaction receipt (retried every cycle while the receipt fails).
//
// Coverage: forward ranges extend the cursor (a skipped range becomes a gap, with the OffRamps known then); a range at
// or below the cursor fills the gaps it overlaps (the daemon replays `ccipGaps`) and leaves the cursor and the stored
// ramps as they are.
import {
  BaseError,
  decodeAbiParameters,
  decodeEventLog,
  encodeEventTopics,
  getAddress,
  numberToHex,
  size,
  slice,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from "viem";

import {
  CCIP_EXECUTION_TOPICS,
  CCIP_SEND_TOPICS,
  CCIP_TOPICS,
  decodeExecutionState,
  decodeSentMessage,
  describeExecutionError,
  type ExecutionStateChange,
  type SentMessage,
} from "../abi/ccip.ts";
import {routerAbi, tokenPoolAbi} from "../abi/external.ts";
import {createExplorer} from "../chain/client.ts";
import {fetchLogs} from "../chain/scanner.ts";
import type {Config} from "../config.ts";
import {formatAmount, formatTimestamp, shortHex} from "../format.ts";
import {redact} from "../log.ts";
import {groupByTx, includesAddress, otherChainSelectors, sameAddress} from "../rules/common.ts";
import type {Store} from "../store.ts";
import type {Alert, AlertField, AlertLink, BlockRange, ChainContext, EventRule, LogFilter} from "../types.ts";
import {
  addAttempt,
  FAILURE,
  idKey,
  lastFailure,
  pruneExec,
  pruneSent,
  readExec,
  readScan,
  readSent,
  SUCCESS,
  successAttempt,
  writeExec,
  writeScan,
  writeSent,
  type Backfill,
  type ExecAttempt,
  type ExecRecord,
  type OffRampLane,
  type SaharaEvidence,
  type ScanState,
  type SentRecord,
} from "./store.ts";

const RULE = "ccip";

/** Receipt lookups retried per cycle (each is one RPC call), fewest attempts first. */
const MAX_PENDING_RETRIES = 10;

export const CCIP_EXPLORER_URL = "https://ccip.chain.link/msg";

const LOCKED_OR_BURNED = (encodeEventTopics({abi: tokenPoolAbi, eventName: "LockedOrBurned"})[0] as Hex).toLowerCase();
const RELEASED_OR_MINTED = (
  encodeEventTopics({abi: tokenPoolAbi, eventName: "ReleasedOrMinted"})[0] as Hex
).toLowerCase();

/** OffRamp 2.0.0 TokenHandlingError(address target, bytes err); `target` survives the 132-byte truncation. */
const TOKEN_HANDLING_ERROR = toFunctionSelector("TokenHandlingError(address,bytes)").toLowerCase();

interface PoolLock {
  log: Log;
  remoteChainSelector: bigint;
  /** The OnRamp that called lockOrBurn. */
  onRamp: Address;
  amount: bigint;
}

interface PoolRelease {
  log: Log;
  remoteChainSelector: bigint;
  /** The OffRamp that called releaseOrMint. */
  offRamp: Address;
  recipient: Address;
  amount: bigint;
}

/** Per-call working state: this chain's stores (mutated, written at the end) and read-only counterpart stores. */
interface Env {
  ctx: ChainContext;
  /** Unix seconds. */
  now: number;
  counterparts: bigint[];
  /**
   * OffRamps whose executions are accepted: the ramps requested for this range plus the Router's current ones (for a
   * retried backfill's logs, its own; see recordBackfill). A log from any other address (e.g. a contract in a
   * receipt) is ignored unless a pool release names it.
   */
  offRamps: Address[];
  /**
   * Source lane of each Router OffRamp (EVM2EVM execution events lack it): the Router's at the range end, those a gap
   * in the range was recorded with, then the stored ramps (for a retried backfill's logs, its own lanes first).
   */
  offRampLanes: OffRampLane[];
  scan: ScanState;
  sent: Record<Hex, SentRecord>;
  exec: Record<Hex, ExecRecord>;
  /** Counterpart stores as first read during this call (for joins; pruning reads them again, see onLogs). */
  sentOf(chain: string): Record<Hex, SentRecord>;
  execOf(chain: string): Record<Hex, ExecRecord>;
  timeOf(log: Log): Promise<number>;
}

/** Configured chain name for a CCIP selector, or null. */
export function chainForSelector(global: Config, selector: bigint): string | null {
  return Object.entries(global.chains).find(([, chain]) => chain.chainSelector === selector)?.[0] ?? null;
}

export function ccipMessageUrl(messageId: Hex): string {
  return `${CCIP_EXPLORER_URL}/${messageId}`;
}

function topic0(log: Pick<Log, "topics">): string | undefined {
  return log.topics[0]?.toLowerCase();
}

function errorText(error: unknown): string {
  if (error instanceof BaseError) return redact(error.shortMessage);
  return redact(error instanceof Error ? error.message : String(error));
}

function uniqueAddresses(list: ReadonlyArray<Address | undefined>): Address[] {
  const out: Address[] = [];
  for (const address of list) if (address && !includesAddress(out, address)) out.push(getAddress(address));
  return out;
}

function uniqueLanes(lanes: readonly OffRampLane[]): OffRampLane[] {
  const out: OffRampLane[] = [];
  for (const lane of lanes) {
    const same = (entry: OffRampLane) =>
      sameAddress(entry.offRamp, lane.offRamp) && entry.sourceChainSelector === lane.sourceChainSelector;
    if (!out.some(same)) out.push(lane);
  }
  return out;
}

/** Ramps whose logs the filters request: the Router's (as last read) plus the configured expectations. */
function knownRamps(ctx: ChainContext, scan: ScanState): {onRamps: Address[]; offRamps: Address[]} {
  return {
    onRamps: uniqueAddresses([...scan.onRamps, ctx.config.expected.onRamp]),
    offRamps: uniqueAddresses([
      ...scan.offRamps.map((entry) => entry.offRamp),
      ...(ctx.config.expected.offRamps ?? []),
    ]),
  };
}

/**
 * Send and execution events of the given ramps for the counterpart lanes. OnRamp/OffRamp 2.0.0 serve every lane, so
 * their events are narrowed by the indexed selector; EVM2EVM ramps serve one lane and index no selector.
 */
function rampFilters(ctx: ChainContext, onRamps: Address[], offRamps: Address[]): LogFilter[] {
  const selectorTopics = otherChainSelectors(ctx).map((selector) => numberToHex(selector, {size: 32}));
  const filters: LogFilter[] = [];
  if (onRamps.length) {
    filters.push(
      {address: onRamps, topics: [[CCIP_TOPICS.messageSent], selectorTopics]},
      {address: onRamps, topics: [[CCIP_TOPICS.sendRequested]]},
    );
  }
  if (offRamps.length) {
    filters.push(
      {address: offRamps, topics: [[CCIP_TOPICS.executionStateChangedV2], selectorTopics]},
      {address: offRamps, topics: [[CCIP_TOPICS.executionStateChanged]]},
    );
  }
  return filters;
}

/** A chain's store: this chain's working state `own`, a counterpart's as read from the store on first use. */
function storeReader<T>(ctx: ChainContext, own: T, read: (store: Store, chain: string) => T): (chain: string) => T {
  const cache = new Map<string, T>();
  return (chain) => {
    if (chain === ctx.name) return own;
    if (!cache.has(chain)) cache.set(chain, read(ctx.store, chain));
    return cache.get(chain)!;
  };
}

function createEnv(ctx: ChainContext, scan: ScanState, now: number): Env {
  const sent = readSent(ctx.store, ctx.name);
  const exec = readExec(ctx.store, ctx.name);
  const times = new Map<bigint, number>();
  let warnedTime = false;
  return {
    ctx,
    now,
    counterparts: otherChainSelectors(ctx),
    offRamps: knownRamps(ctx, scan).offRamps,
    offRampLanes: scan.offRamps,
    scan,
    sent,
    exec,
    sentOf: storeReader(ctx, sent, readSent),
    execOf: storeReader(ctx, exec, readExec),
    async timeOf(log) {
      const block = log.blockNumber;
      if (block === null) return now;
      const raw = (log as Log & {blockTimestamp?: Hex | bigint | number | null}).blockTimestamp;
      if (raw !== undefined && raw !== null) return Number(BigInt(raw));
      const known = times.get(block);
      if (known !== undefined) return known;
      try {
        const header = await ctx.client.getBlock({blockNumber: block});
        times.set(block, Number(header.timestamp));
      } catch (error) {
        // Only ages depend on it (stuck detection; pruning, which the later wall clock only delays).
        if (!warnedTime) ctx.log.warn("ccip: block timestamp unavailable, using the wall clock", {block, error});
        warnedTime = true;
        times.set(block, now);
      }
      return times.get(block)!;
    },
  };
}

function poolEvents(env: Env, txLogs: readonly Log[]): {locks: PoolLock[]; releases: PoolRelease[]} {
  const locks: PoolLock[] = [];
  const releases: PoolRelease[] = [];
  for (const log of txLogs) {
    if (!includesAddress(env.ctx.addresses.pools, log.address)) continue;
    const topic = topic0(log);
    if (topic !== LOCKED_OR_BURNED && topic !== RELEASED_OR_MINTED) continue;
    try {
      const event = decodeEventLog({abi: tokenPoolAbi, data: log.data, topics: log.topics, strict: true});
      if (event.eventName === "LockedOrBurned") {
        if (!sameAddress(event.args.token, env.ctx.addresses.token)) continue;
        const {remoteChainSelector, sender, amount} = event.args;
        locks.push({log, remoteChainSelector, onRamp: getAddress(sender), amount});
      } else if (event.eventName === "ReleasedOrMinted") {
        if (!sameAddress(event.args.token, env.ctx.addresses.token)) continue;
        const {remoteChainSelector, sender, recipient, amount} = event.args;
        const offRamp = getAddress(sender);
        releases.push({log, remoteChainSelector, offRamp, recipient: getAddress(recipient), amount});
      }
    } catch (error) {
      env.ctx.log.warn("ccip: undecodable pool log", {error, tx: log.transactionHash, logIndex: log.logIndex});
    }
  }
  return {locks, releases};
}

/** First log after `after` in the transaction emitted by `emitter` with one of `topics`. */
function nextLog(txLogs: readonly Log[], after: Log, emitter: Address, topics: readonly Hex[]): Log | undefined {
  const index = after.logIndex ?? -1;
  return txLogs.find((log) => {
    const topic = topic0(log);
    if ((log.logIndex ?? -1) <= index || !sameAddress(log.address, emitter)) return false;
    return topic !== undefined && topics.includes(topic as Hex);
  });
}

/** Pool logs whose ramp log is not among `txLogs`, and their amounts. */
function unlinkedParts(txLogs: readonly Log[], locks: PoolLock[], releases: PoolRelease[]) {
  const unlinkedLocks = locks.filter((lock) => !nextLog(txLogs, lock.log, lock.onRamp, CCIP_SEND_TOPICS));
  const unattributed = releases.filter(
    (release) => !nextLog(txLogs, release.log, release.offRamp, CCIP_EXECUTION_TOPICS),
  );
  return {
    missing: unlinkedLocks.length + unattributed.length > 0,
    locked: unlinkedLocks.reduce((sum, lock) => sum + lock.amount, 0n),
    released: unattributed.reduce((sum, release) => sum + release.amount, 0n),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Source side

function recordUnlinked(env: Env, lock: PoolLock, at: number, reason: string): void {
  const txHash = lock.log.transactionHash!;
  const logIndex = lock.log.logIndex!;
  env.ctx.log.warn("ccip: SAHARA lock without a matching CCIP message (counted as in flight)", {
    tx: txHash,
    logIndex,
    reason,
  });
  const known = env.scan.unlinked.some((entry) => sameTx(entry.txHash, txHash) && entry.logIndex === logIndex);
  if (known) return;
  env.scan.unlinked.push({
    txHash,
    logIndex,
    block: lock.log.blockNumber!,
    pool: getAddress(lock.log.address),
    amount: lock.amount,
    remoteSelector: lock.remoteChainSelector,
    at,
  });
}

function sameTx(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Records the message a lock belongs to. Returns an error text when the send event does not match the lock. */
async function recordSend(env: Env, lock: PoolLock, sendLog: Log): Promise<string | null> {
  const {ctx} = env;
  let message: SentMessage | null;
  try {
    message = decodeSentMessage(sendLog, {destChainSelector: lock.remoteChainSelector});
  } catch (error) {
    return `undecodable send event: ${errorText(error)}`;
  }
  if (!message) return "not a send event";
  // EVM2EVMOnRamp 1.2.0 carries opaque pool data instead of the source pool (sourcePoolAddress null).
  const ours = message.tokenAmounts.filter(
    (transfer) =>
      sameAddress(transfer.token, ctx.addresses.token) &&
      (transfer.sourcePoolAddress === null || sameAddress(transfer.sourcePoolAddress, lock.log.address)),
  );
  const first = ours[0];
  if (!first) return `message ${message.messageId} carries no ${ctx.global.token.symbol} from this pool`;
  const amount = ours.reduce((sum, transfer) => sum + transfer.amount, 0n);
  if (ours.length === 1 && amount !== lock.amount) {
    ctx.log.warn("ccip: lock and message amounts differ", {messageId: message.messageId, lock: lock.amount, amount});
  }
  const destSelector = message.destChainSelector ?? lock.remoteChainSelector;
  if (destSelector !== lock.remoteChainSelector) {
    ctx.log.warn("ccip: lock and message destinations differ", {messageId: message.messageId});
  }
  const id = idKey(message.messageId);
  const existing = env.sent[id];
  const record: SentRecord = {
    messageId: message.messageId,
    sourceChain: ctx.name,
    destSelector,
    destChain: chainForSelector(ctx.global, destSelector),
    amount,
    receiver: first.tokenReceiver ?? message.receiver,
    sender: message.sender,
    pool: getAddress(lock.log.address),
    onRamp: message.onRamp,
    kind: message.kind,
    sequenceNumber: message.sequenceNumber,
    sentBlock: sendLog.blockNumber!,
    sentAt: existing?.sentAt ?? (await env.timeOf(sendLog)),
    txHash: sendLog.transactionHash!,
    logIndex: sendLog.logIndex!,
  };
  env.sent[id] = record;
  env.scan.unlinked = env.scan.unlinked.filter(
    (entry) => !(sameTx(entry.txHash, record.txHash) && entry.logIndex === lock.log.logIndex),
  );
  if (!existing) alertKnownFailure(env, record);
  return null;
}

/** The destination was scanned before this send: alert a failure already recorded there. */
function alertKnownFailure(env: Env, sent: SentRecord): void {
  if (!sent.destChain) return;
  const record = env.execOf(sent.destChain)[idKey(sent.messageId)];
  if (!record || successAttempt(record)) return;
  const failure = lastFailure(record);
  if (failure) env.ctx.alerter.emit(failureAlert(env.ctx.global, sent.destChain, record, failure, sent));
}

// ---------------------------------------------------------------------------------------------------------------
// Destination side

/** Source selector of an execution: in the event (2.0.0), else the Router's OffRamp lane, else the pool release. */
function laneOf(env: Env, change: ExecutionStateChange, releases: PoolRelease[]): bigint | null {
  if (change.sourceChainSelector !== null) return change.sourceChainSelector;
  const entry = env.offRampLanes.find((ramp) => sameAddress(ramp.offRamp, change.offRamp));
  if (entry) return entry.sourceChainSelector;
  if (releases[0]) return releases[0].remoteChainSelector;
  // A configured (expected) EVM2EVM OffRamp the Router no longer lists: only one counterpart lane can be meant.
  return env.counterparts.length === 1 ? env.counterparts[0]! : null;
}

/** OffRamp 2.0.0 TokenHandlingError target, read from its static head (the error is truncated inside `err`). */
export function tokenHandlingTarget(returnData: Hex): Address | null {
  if (size(returnData) < 36 || slice(returnData, 0, 4).toLowerCase() !== TOKEN_HANDLING_ERROR) return null;
  const [target] = decodeAbiParameters([{type: "address"}], slice(returnData, 4, 36));
  return target;
}

async function recordExecution(env: Env, log: Log, releases: PoolRelease[]): Promise<void> {
  const {ctx} = env;
  let change: ExecutionStateChange | null;
  try {
    change = decodeExecutionState(log);
  } catch (error) {
    ctx.log.warn("ccip: undecodable ExecutionStateChanged", {error, tx: log.transactionHash, logIndex: log.logIndex});
    return;
  }
  if (!change || change.blockNumber === null || change.transactionHash === null || change.logIndex === null) return;
  const state = change.state;
  if (state !== SUCCESS && state !== FAILURE) return;
  // A release proves its OffRamp (the pool only pays the Router's OffRamps); anything else must be a watched OffRamp.
  if (!releases.length && !includesAddress(env.offRamps, change.offRamp)) return;
  const lane = laneOf(env, change, releases);
  if (lane === null || (!env.counterparts.includes(lane) && releases.length === 0)) return;

  const sourceChain = chainForSelector(ctx.global, lane);
  const id = idKey(change.messageId);
  const existing = env.exec[id];
  const sent = sourceChain ? env.sentOf(sourceChain)[id] : undefined;
  let evidence: SaharaEvidence | null = existing?.sahara ?? null;
  if (releases.length) evidence = "release";
  else if (evidence === null && sent) evidence = "sent";
  else if (evidence === null && state === FAILURE) {
    const target = tokenHandlingTarget(change.returnData);
    if (sameAddress(target, ctx.addresses.token) || includesAddress(ctx.addresses.pools, target)) {
      evidence = "error-target";
    }
  }
  // Another token's message (failures are kept: the source may be scanned later).
  if (!existing && evidence === null && state === SUCCESS) return;

  const record: ExecRecord = existing ?? {
    messageId: change.messageId,
    sourceChain,
    sourceSelector: lane,
    sequenceNumber: change.sequenceNumber,
    kind: change.kind,
    offRamp: change.offRamp,
    sahara: null,
    attempts: [],
  };
  record.sahara = evidence;
  if (releases.length) {
    const first = releases[0]!;
    record.release = {
      pool: getAddress(first.log.address),
      recipient: first.recipient,
      amount: releases.reduce((sum, release) => sum + release.amount, 0n),
      txHash: first.log.transactionHash!,
      logIndex: first.log.logIndex!,
    };
  }
  const attempt: ExecAttempt = {
    state,
    block: change.blockNumber,
    txHash: change.transactionHash,
    logIndex: change.logIndex,
    at: await env.timeOf(log),
  };
  if (state === FAILURE) attempt.reason = describeExecutionError(change.returnData);
  const isNew = addAttempt(record, attempt);
  env.exec[id] = record;
  if (!isNew || evidence === null) return;

  if (state === FAILURE) {
    if (!successAttempt(record)) ctx.alerter.emit(failureAlert(ctx.global, ctx.name, record, attempt, sent));
  } else if (record.attempts.some((entry) => entry.state === FAILURE)) {
    ctx.alerter.emit(recoveredAlert(ctx.global, ctx.name, record, attempt, sent));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Alerts

function explorerFor(global: Config, chain: string | null) {
  const config = chain ? global.chains[chain] : undefined;
  return config ? createExplorer(config.explorerUrl) : undefined;
}

function laneText(record: ExecRecord, destChain: string): string {
  const source = record.sourceChain ?? record.sourceSelector?.toString() ?? "unknown";
  return `${source} → ${destChain} (${record.kind} #${record.sequenceNumber})`;
}

function messageFields(global: Config, record: ExecRecord, destChain: string, sent: SentRecord | undefined) {
  const {decimals, symbol} = global.token;
  const fields: AlertField[] = [{label: "Message ID", value: record.messageId, code: true}];
  if (sent) fields.push({label: "Amount", value: formatAmount(sent.amount, decimals, symbol), code: true});
  else if (record.release) {
    fields.push({label: "Amount", value: formatAmount(record.release.amount, decimals, symbol), code: true});
  } else {
    const source = record.sourceChain ?? "the source";
    fields.push({
      label: "Amount",
      value: `unknown: the send was not seen (before the first scanned block, or ${source} not scanned yet)`,
    });
  }
  const receiver = sent?.receiver ?? record.release?.recipient;
  if (receiver) fields.push({label: "Receiver", value: getAddress(receiver), code: true});
  fields.push({label: "Lane", value: laneText(record, destChain)});
  if (sent) {
    fields.push({label: "Sender", value: sent.sender, code: true});
    fields.push({label: "Sent", value: `block ${sent.sentBlock}, ${formatTimestamp(sent.sentAt)}`});
  }
  return fields;
}

function messageLinks(global: Config, record: ExecRecord, destChain: string, attempt: ExecAttempt, sent?: SentRecord) {
  const links: AlertLink[] = [];
  const dest = explorerFor(global, destChain);
  const label = attempt.state === FAILURE ? "Failed execution" : "Execution";
  if (dest) links.push({label, url: dest.tx(attempt.txHash)});
  const source = sent ? explorerFor(global, sent.sourceChain) : undefined;
  if (sent && source) links.push({label: "Source transaction", url: source.tx(sent.txHash)});
  links.push({label: "CCIP explorer", url: ccipMessageUrl(record.messageId)});
  return links;
}

/** Critical event alert for a FAILURE of a SAHARA message (same key from the destination and the late join). */
export function failureAlert(
  global: Config,
  destChain: string,
  record: ExecRecord,
  attempt: ExecAttempt,
  sent: SentRecord | undefined,
): Alert {
  const {decimals, symbol} = global.token;
  const receiver = sent?.receiver ? shortHex(getAddress(sent.receiver)) : "an unknown receiver";
  const amount = sent ? formatAmount(sent.amount, decimals, symbol) : "";
  const title = sent
    ? `CCIP message failed: ${amount} to ${receiver} stuck on ${destChain}; needs manual execution`
    : `CCIP message failed on ${destChain} with a ${symbol} token error; needs manual execution`;
  const source = sent?.sourceChain ?? record.sourceChain ?? "the source chain";
  return {
    key: `${destChain}:${RULE}:${attempt.txHash}:${attempt.logIndex}`,
    kind: "event",
    severity: "critical",
    rule: "ccip.message-failed",
    chain: destChain,
    title,
    fields: [
      ...messageFields(global, record, destChain, sent),
      {label: "Failure", value: attempt.reason ?? "unknown"},
      {label: "Failed at", value: `block ${attempt.block}, ${formatTimestamp(attempt.at)}`},
      {label: "OffRamp", value: record.offRamp, code: true},
    ],
    links: messageLinks(global, record, destChain, attempt, sent),
    note:
      `The ${symbol} is locked on ${source} but was not released on ${destChain}: it is still owed and counts in ` +
      `the in-flight amount I until the message executes. Fix the cause first (ERC20InsufficientBalance: the ` +
      `${destChain} pool lacks inventory; TokenRateLimitReached: wait for the bucket; TokenMaxCapacityExceeded: ` +
      `the amount is above the bucket's capacity, which is 0 while the pool is locked down, so it waits for the ` +
      `Timelock restore, see EMERGENCY.md R5), then manually execute the message from the CCIP explorer. A manual ` +
      `attempt that fails again reverts and leaves no log.`,
  };
}

function recoveredAlert(
  global: Config,
  destChain: string,
  record: ExecRecord,
  attempt: ExecAttempt,
  sent: SentRecord | undefined,
): Alert {
  const {decimals, symbol} = global.token;
  const amount = sent?.amount ?? record.release?.amount;
  const receiver = sent?.receiver ?? record.release?.recipient;
  const what = amount !== undefined ? formatAmount(amount, decimals, symbol) : symbol;
  const to = receiver ? ` to ${shortHex(getAddress(receiver))}` : "";
  return {
    key: `${destChain}:${RULE}:${attempt.txHash}:${attempt.logIndex}`,
    kind: "event",
    severity: "info",
    rule: "ccip.message-executed",
    chain: destChain,
    title: `Failed CCIP message executed: ${what} released${to} on ${destChain}`,
    fields: [
      ...messageFields(global, record, destChain, sent),
      {label: "Executed at", value: `block ${attempt.block}`},
    ],
    links: messageLinks(global, record, destChain, attempt, sent),
  };
}

function rampsCondition(ctx: ChainContext, error: string): Alert {
  return {
    key: `${ctx.name}:${RULE}:ramps`,
    kind: "condition",
    severity: "warning",
    rule: "ccip.ramps-unknown",
    chain: ctx.name,
    title: `CCIP ramps unreadable on ${ctx.name}: failed ${ctx.global.token.symbol} messages may go unnoticed`,
    fields: [{label: "Error", value: error}],
    note:
      "The Router's OffRamps are read every cycle to watch their executions; until it succeeds only the last known " +
      "OffRamps are watched.",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Processing

async function processTx(env: Env, txLogs: readonly Log[], final: boolean): Promise<void> {
  const {locks, releases} = poolEvents(env, txLogs);
  for (const lock of locks) {
    const sendLog = nextLog(txLogs, lock.log, lock.onRamp, CCIP_SEND_TOPICS);
    if (!sendLog) {
      if (final) recordUnlinked(env, lock, await env.timeOf(lock.log), "no send event from the OnRamp after the lock");
      continue;
    }
    const error = await recordSend(env, lock, sendLog);
    if (error) recordUnlinked(env, lock, await env.timeOf(lock.log), error);
  }

  const attributed = new Map<number, PoolRelease[]>();
  for (const release of releases) {
    const execLog = nextLog(txLogs, release.log, release.offRamp, CCIP_EXECUTION_TOPICS);
    if (!execLog) {
      if (final) {
        env.ctx.log.warn("ccip: pool release without an ExecutionStateChanged of its OffRamp", {
          tx: release.log.transactionHash,
          logIndex: release.log.logIndex,
        });
      }
      continue;
    }
    const list = attributed.get(execLog.logIndex!) ?? [];
    list.push(release);
    attributed.set(execLog.logIndex!, list);
  }

  for (const log of txLogs) {
    const topic = topic0(log);
    if (topic === undefined || !CCIP_EXECUTION_TOPICS.includes(topic as Hex)) continue;
    await recordExecution(env, log, attributed.get(log.logIndex ?? -1) ?? []);
  }
}

async function receiptLogs(ctx: ChainContext, hash: Hex): Promise<Log[]> {
  const receipt = await ctx.client.getTransactionReceipt({hash});
  return [...receipt.logs].sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0));
}

function addPending(env: Env, txLogs: readonly Log[], parts: {locked: bigint; released: bigint}, error: unknown) {
  const first = txLogs[0];
  if (!first?.transactionHash || first.blockNumber === null) return;
  const key = first.transactionHash.toLowerCase() as Hex;
  const existing = env.scan.pendingTxs[key];
  env.scan.pendingTxs[key] = {
    txHash: first.transactionHash,
    block: first.blockNumber,
    locked: parts.locked,
    released: parts.released,
    firstSeenAt: existing?.firstSeenAt ?? env.now,
    attempts: (existing?.attempts ?? 0) + 1,
    error: errorText(error),
  };
  env.ctx.log.warn("ccip: transaction receipt unavailable, will retry", {tx: first.transactionHash, error});
}

/** Processes one transaction's scanned logs, from its receipt when a pool log's ramp log is not among them. */
async function processScannedTx(env: Env, txLogs: Log[]): Promise<void> {
  const {locks, releases} = poolEvents(env, txLogs);
  const parts = unlinkedParts(txLogs, locks, releases);
  if (!parts.missing) {
    await processTx(env, txLogs, true);
    return;
  }
  let full: Log[];
  try {
    full = await receiptLogs(env.ctx, txLogs[0]!.transactionHash!);
  } catch (error) {
    await processTx(env, txLogs, false);
    addPending(env, txLogs, parts, error);
    return;
  }
  delete env.scan.pendingTxs[txLogs[0]!.transactionHash!.toLowerCase() as Hex];
  await processTx(env, full, true);
}

/** Never gives up: the transaction's lock stays counted in I until its receipt links it (or it is acknowledged). */
async function retryPending(env: Env, done: Set<string>): Promise<void> {
  const entries = (Object.entries(env.scan.pendingTxs) as Array<[Hex, ScanState["pendingTxs"][Hex]]>)
    .filter(([key]) => !done.has(key))
    .sort(([, a], [, b]) => a.attempts - b.attempts)
    .slice(0, MAX_PENDING_RETRIES);
  for (const [key, pending] of entries) {
    let logs: Log[];
    try {
      logs = await receiptLogs(env.ctx, pending.txHash);
    } catch (error) {
      pending.attempts++;
      pending.error = errorText(error);
      continue;
    }
    delete env.scan.pendingTxs[key];
    await processTx(env, logs, true);
  }
}

/** The Router's ramps for the counterpart lanes at `blockNumber`. Throws when they cannot be read. */
async function readRamps(env: Env, blockNumber: bigint): Promise<Pick<ScanState, "onRamps" | "offRamps">> {
  const {ctx} = env;
  const router = ctx.addresses.router;
  if (!router) {
    throw new Error("Router address unknown (contracts.router unset and no watched pool's getRouter() succeeded)");
  }
  const offRamps = await ctx.client.readContract({
    address: router,
    abi: routerAbi,
    functionName: "getOffRamps",
    blockNumber,
  });
  const onRamps = await Promise.all(
    env.counterparts.map((selector) =>
      ctx.client.readContract({
        address: router,
        abi: routerAbi,
        functionName: "getOnRamp",
        args: [selector],
        blockNumber,
      }),
    ),
  );
  return {
    offRamps: offRamps
      .filter((entry) => env.counterparts.includes(entry.sourceChainSelector))
      .map((entry) => ({offRamp: getAddress(entry.offRamp), sourceChainSelector: entry.sourceChainSelector})),
    onRamps: uniqueAddresses(onRamps.filter((onRamp) => !sameAddress(onRamp, zeroAddress))),
  };
}

/** Keeps the Router's ramps at the end of a forward range (the next ranges' filters request them). */
async function refreshRamps(env: Env, blockNumber: bigint): Promise<void> {
  const {ctx, scan} = env;
  try {
    const ramps = await readRamps(env, blockNumber);
    scan.offRamps = ramps.offRamps;
    scan.onRamps = ramps.onRamps;
    scan.rampsBlock = blockNumber;
    delete scan.rampsError;
  } catch (error) {
    scan.rampsError = errorText(error);
    ctx.log.warn("ccip: Router ramps unreadable, keeping the last known ramps", {error: scan.rampsError});
  }
}

function fetchRampLogs(env: Env, onRamps: Address[], offRamps: Address[], range: BlockRange): Promise<Log[]> {
  return fetchLogs(env.ctx.client, rampFilters(env.ctx, onRamps, offRamps), range, {
    maxRange: env.ctx.config.maxLogRange,
    log: env.ctx.log,
  });
}

/** A backfill whose ramp logs this call fetched; it stays in the scan state until recordBackfill recorded them. */
interface FetchedBackfill {
  entry: Backfill;
  logs: Log[];
}

/**
 * Ramp logs of ranges fetched before the ramp was known: earlier failed backfills (retried until fetched, `retried`),
 * then the ramps of `after` (the Router's at the range end) that `before` (the filters) did not request, for `range`
 * (`logs`; when that fetch fails, a backfill with the lanes `env.offRampLanes` holds for them).
 */
async function backfill(
  env: Env,
  range: BlockRange,
  before: {onRamps: Address[]; offRamps: Address[]},
  after: {onRamps: Address[]; offRamps: Address[]},
): Promise<{retried: FetchedBackfill[]; logs: Log[]}> {
  const retried: FetchedBackfill[] = [];
  for (const entry of env.scan.backfills) {
    try {
      retried.push({entry, logs: await fetchRampLogs(env, entry.onRamps, entry.offRamps, entry)});
    } catch (error) {
      entry.attempts++;
      env.ctx.log.debug("ccip: ramp log backfill still failing", {from: entry.from, to: entry.to, error});
    }
  }

  const onRamps = after.onRamps.filter((address) => !includesAddress(before.onRamps, address));
  const offRamps = after.offRamps.filter((address) => !includesAddress(before.offRamps, address));
  if (!onRamps.length && !offRamps.length) return {retried, logs: []};
  try {
    return {retried, logs: await fetchRampLogs(env, onRamps, offRamps, range)};
  } catch (error) {
    env.ctx.log.warn("ccip: ramp logs unavailable, will retry", {from: range.from, to: range.to, error});
    const offRampLanes = uniqueLanes(env.offRampLanes.filter((lane) => includesAddress(offRamps, lane.offRamp)));
    env.scan.backfills.push({...range, onRamps, offRamps, offRampLanes, firstSeenAt: env.now, attempts: 1});
    return {retried, logs: []};
  }
}

/**
 * Records a retried backfill's logs, accepting its OffRamps and their lanes for them even when the Router no longer
 * lists them (only for these logs: the forward scan accepts the Router's). False when a transaction failed: the entry
 * is then kept and refetched next cycle (recording is idempotent).
 */
async function recordBackfill(env: Env, {entry, logs}: FetchedBackfill): Promise<boolean> {
  const scoped: Env = {...env, offRamps: entry.offRamps, offRampLanes: [...entry.offRampLanes, ...env.offRampLanes]};
  let recorded = true;
  for (const [txHash, txLogs] of groupByTx(mergeLogs(logs).filter((log) => isRelevant(env, log)))) {
    try {
      // Ramp logs only: nothing to link from a receipt.
      await processTx(scoped, txLogs, true);
    } catch (error) {
      recorded = false;
      env.ctx.log.warn("ccip: backfilled transaction not recorded, will refetch", {tx: txHash, error});
    }
  }
  if (!recorded) entry.attempts++;
  return recorded;
}

function mergeLogs(...lists: Log[][]): Log[] {
  const unique = new Map<string, Log>();
  for (const log of lists.flat()) unique.set(`${log.transactionHash?.toLowerCase()}:${log.logIndex}`, log);
  return [...unique.values()].sort((a, b) => {
    const blockA = a.blockNumber ?? 0n;
    const blockB = b.blockNumber ?? 0n;
    if (blockA !== blockB) return blockA < blockB ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
}

function isRelevant(env: Env, log: Log): boolean {
  const topic = topic0(log) as Hex | undefined;
  if (topic === undefined) return false;
  if (topic === LOCKED_OR_BURNED || topic === RELEASED_OR_MINTED) {
    return includesAddress(env.ctx.addresses.pools, log.address);
  }
  return CCIP_SEND_TOPICS.includes(topic) || CCIP_EXECUTION_TOPICS.includes(topic);
}

/** `gaps` without the blocks of `range`. */
function withoutRange(gaps: ScanState["gaps"], range: BlockRange): ScanState["gaps"] {
  const out: ScanState["gaps"] = [];
  for (const gap of gaps) {
    if (gap.to < range.from || gap.from > range.to) {
      out.push(gap);
      continue;
    }
    if (gap.from < range.from) out.push({...gap, to: range.from - 1n});
    if (gap.to > range.to) out.push({...gap, from: range.to + 1n});
  }
  return out;
}

/**
 * Records `range` as processed: fills the gaps it overlaps and extends the cursor over it, recording the blocks
 * between the cursor and a disjoint range as a gap. A forward extension reads the new `cursor.to`'s timestamp
 * (`coveredAt`); when that fails the previous value stays (a lower bound), which only delays pruning.
 */
async function cover(env: Env, range: BlockRange): Promise<void> {
  const {scan} = env;
  const cursor = scan.cursor;
  const gaps = withoutRange(scan.gaps, range);
  const skipped = (from: bigint, to: bigint) => {
    env.ctx.log.warn("ccip: blocks skipped between scans; reconciliation is incomplete until they are scanned", {
      from,
      to,
    });
    gaps.push({from, to, detectedAt: env.now, offRampLanes: uniqueLanes(env.offRampLanes)});
  };
  if (cursor && range.from > cursor.to + 1n) skipped(cursor.to + 1n, range.from - 1n);
  if (cursor && range.to + 1n < cursor.from) skipped(range.to + 1n, cursor.from - 1n);
  scan.gaps = gaps.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  scan.cursor = {
    from: cursor && cursor.from < range.from ? cursor.from : range.from,
    to: cursor && cursor.to > range.to ? cursor.to : range.to,
  };
  if (cursor && range.to <= cursor.to) return;
  try {
    const header = await env.ctx.client.getBlock({blockNumber: range.to});
    scan.coveredAt = Number(header.timestamp);
  } catch (error) {
    env.ctx.log.warn("ccip: block timestamp unavailable, pruning waits", {block: range.to, error});
  }
}

export const ccipEventsRule: EventRule = {
  id: RULE,
  filters(ctx: ChainContext): LogFilter[] {
    if (!ctx.config.ccip.enabled) return [];
    const ramps = knownRamps(ctx, readScan(ctx.store, ctx.name));
    return [
      {address: ctx.addresses.pools, topics: [[LOCKED_OR_BURNED as Hex, RELEASED_OR_MINTED as Hex]]},
      ...rampFilters(ctx, ramps.onRamps, ramps.offRamps),
    ];
  },
  async onLogs(ctx: ChainContext, logs: Log[], range: BlockRange): Promise<void> {
    if (!ctx.config.ccip.enabled) return;
    const scan = readScan(ctx.store, ctx.name);
    const env = createEnv(ctx, scan, Math.floor(Date.now() / 1000));
    // The ramps filters() requested for this range (nothing else writes the scan state in between).
    const requested = knownRamps(ctx, scan);
    // A range at or below the cursor fills gaps (or replays blocks): the stored ramps stay those of the cursor.
    const forward = !scan.cursor || range.to > scan.cursor.to;
    try {
      let after = requested;
      if (forward) {
        await refreshRamps(env, range.to);
        after = knownRamps(ctx, scan);
        // Also those of the start: an EVM2EVM OffRamp retired in the range executed its last messages here.
        env.offRampLanes = [...scan.offRamps, ...env.offRampLanes];
      } else {
        // The Router's ramps at the range end and the OffRamps known when its gaps were recorded. Old state may be
        // pruned (no archive RPC): then only the known ramps are watched here. That cannot lower I (locks and releases
        // are linked through the pool logs); a FAILURE on an OffRamp the Router listed only inside the gap is missed,
        // and its message counts as pending instead of failed.
        const gapLanes = scan.gaps
          .filter((gap) => gap.from <= range.to && gap.to >= range.from)
          .flatMap((gap) => gap.offRampLanes ?? []);
        let ramps: Pick<ScanState, "onRamps" | "offRamps"> = {onRamps: [], offRamps: []};
        try {
          ramps = await readRamps(env, range.to);
        } catch (error) {
          ctx.log.warn("ccip: Router ramps unreadable at a gap's block, using the known ramps", {
            block: range.to,
            error: errorText(error),
          });
        }
        after = knownRamps(ctx, {...scan, onRamps: ramps.onRamps, offRamps: [...ramps.offRamps, ...gapLanes]});
        env.offRampLanes = [...ramps.offRamps, ...gapLanes, ...scan.offRamps];
      }
      // Executions in this range may come from OffRamps the Router listed at its start or lists at its end.
      env.offRamps = uniqueAddresses([...requested.offRamps, ...after.offRamps]);
      const {retried, logs: extra} = await backfill(env, range, requested, after);

      // Earlier ranges first. A backfill leaves the state once its logs are recorded, and the state is only written
      // below, all at once: a save during this call (an alert delivery) holds the entry and none of its records.
      const recorded = new Set<Backfill>();
      for (const fetched of retried) if (await recordBackfill(env, fetched)) recorded.add(fetched.entry);
      scan.backfills = scan.backfills.filter((entry) => !recorded.has(entry));

      const done = new Set<string>();
      const relevant = mergeLogs(logs, extra).filter((log) => isRelevant(env, log));
      for (const [txHash, txLogs] of groupByTx(relevant)) {
        done.add(txHash.toLowerCase());
        try {
          await processScannedTx(env, txLogs);
        } catch (error) {
          // Unexpected (decoders catch their own errors): keep the transaction for a receipt-based retry.
          const {locks, releases} = poolEvents(env, txLogs);
          addPending(env, txLogs, unlinkedParts([], locks, releases), error);
        }
      }
      await retryPending(env, done);
      await cover(env, range);

      // By coverage only: unlinked locks, pending receipts, backfills and gaps stay until settled or filled. On the
      // counterparts' stores as they are now, read with no await until this call's own writes: their loops run
      // concurrently (e.g. a gap replay records a send while this call awaits an RPC), and each chain writes its
      // sent, exec and scan state together, so these reads are one consistent state.
      const scanOf = storeReader(ctx, scan, readScan);
      pruneSent(env.sent, storeReader(ctx, env.exec, readExec), scanOf);
      pruneExec(env.exec, storeReader(ctx, env.sent, readSent), scanOf);
    } finally {
      writeSent(ctx.store, ctx.name, env.sent);
      writeExec(ctx.store, ctx.name, env.exec);
      writeScan(ctx.store, ctx.name, scan);
    }
    if (!forward) return;
    if (scan.rampsError) ctx.alerter.emit(rampsCondition(ctx, scan.rampsError));
    else ctx.alerter.resolve(`${ctx.name}:${RULE}:ramps`);
  },
};
