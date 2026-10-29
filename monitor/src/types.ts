// Core types shared by every module. Rules produce `Alert`s; the alert manager (src/alerts/manager.ts) dedupes them,
// tracks open conditions and hands messages to the sinks' targets (src/alerts/telegram.ts, src/alerts/console.ts).
import type {Address, Hex, Log, PublicClient} from "viem";

import type {ChainConfig, Config} from "./config.ts";
import type {Logger} from "./log.ts";
import type {Store} from "./store.ts";

export type Severity = "critical" | "high" | "warning" | "info";

export const SEVERITY_RANK: Record<Severity, number> = {info: 0, warning: 1, high: 2, critical: 3};

export interface AlertField {
  label: string;
  /** Plain text; sinks escape it. */
  value: string;
  /** Render as monospace (addresses, hashes, calldata, amounts). */
  code?: boolean;
}

export interface AlertLink {
  label: string;
  url: string;
}

/**
 * One alert. All text is plain (never pre-escaped markup); each sink renders and escapes it.
 *
 * - `kind: "event"`: something happened (a log, a transaction). Sent once per `key`.
 * - `kind: "condition"`: something is currently wrong (a state check). Stays open while the condition holds, is
 *   re-sent as a reminder per `alerts.reminderSec[severity]`, and a "resolved" message is sent once it clears.
 */
export interface Alert {
  /**
   * Stable identity. Event alerts: `${chain}:${rule}:${txHash}:${logIndex}` (or another unique suffix).
   * Condition alerts: `${chain}:${rule}:${subject}`; the same key must be produced on every cycle the condition holds.
   */
  key: string;
  kind: "event" | "condition";
  severity: Severity;
  /** Rule id, e.g. "manager.guardian-action". Listed in the README rule catalog. */
  rule: string;
  /** Chain name (the key under `chains` in the config). Omitted for cross-chain alerts. */
  chain?: string;
  /** One line, plain text. */
  title: string;
  fields?: AlertField[];
  links?: AlertLink[];
  /** Optional plain-text paragraph, e.g. the runbook action. */
  note?: string;
}

export type MessageStatus = "firing" | "reminder" | "resolved";

export interface OutgoingMessage {
  alert: Alert;
  status: MessageStatus;
  /** Seconds the condition has been open (reminder/resolved only). */
  openForSec?: number;
  /**
   * Severity that selects the routes, when above `alert.severity`: a condition's downgrade and its resolution also
   * reach the routes its most severe message reached, so a paged route sees it end.
   */
  routeSeverity?: Severity;
}

/** The severity sinks route a message by (see `OutgoingMessage.routeSeverity`). */
export function routeSeverity(message: OutgoingMessage): Severity {
  const {routeSeverity: route} = message;
  const {severity} = message.alert;
  return route && SEVERITY_RANK[route] > SEVERITY_RANK[severity] ? route : severity;
}

/**
 * What a failed delivery means for the message (the alert manager acts on it, see src/alerts/manager.ts):
 * - "transient": the target is unavailable for now (network, timeout, 5xx, rate limit). Kept and retried later.
 * - "route": the target itself is broken and needs an operator fix (bot token, chat id, the bot's membership or
 *   rights). Kept and retried, so it is delivered once that is fixed.
 * - "message": this message can never be delivered to that target (e.g. rejected as malformed). Dropped for that
 *   target only.
 */
export type DeliveryErrorKind = "transient" | "route" | "message";

/** A failed `AlertSink.send` that says what it means for the message. Any other error is unclassified. */
export class DeliveryError extends Error {
  readonly kind: DeliveryErrorKind;
  /** The earliest the target accepts a retry, in ms from now (e.g. Telegram's `retry_after`). */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, kind: DeliveryErrorKind, retryAfterMs?: number) {
    super(message);
    this.name = "DeliveryError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface AlertSink {
  /** Kind of sink, e.g. "telegram": the `sink` of /healthz and /metrics. */
  readonly name: string;
  /**
   * Where it delivers, e.g. one id per Telegram route. Each target receives the messages it admits in emission order
   * and is tracked on its own: a retry never re-sends to a target that took the message. Ids are configuration (never
   * secrets), stable across restarts and unique within the sink. Default: one target named after the sink.
   */
  readonly targets?: readonly string[];
  /** Whether `target` receives `message` (e.g. a route's minSeverity). Default: every message. */
  admits?(message: OutgoingMessage, target: string): boolean;
  /**
   * Delivers one message to one target, retrying in the call itself only briefly (seconds, never minutes). On failure
   * throws, preferably a `DeliveryError` saying whether the message is kept for a later retry or dropped. A sink that
   * sends a message in several parts resumes after the `progress.sent` parts the target already accepted and reports
   * each accepted part to `progress.onPart`, so a retry, also after a restart, never repeats a part.
   */
  send(message: OutgoingMessage, target: string, progress?: SendProgress): Promise<void>;
}

/** How far the delivery of a multi-part message to one target got; the alert manager keeps it with the message. */
export interface SendProgress {
  /** Parts the target accepted in earlier attempts. */
  readonly sent: number;
  /** Called once the target accepted a part that is not the last, with the parts accepted so far. */
  onPart(sent: number): void;
}

/** setTimeout/clearTimeout, injectable so tests decide when timers fire. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What rules use to raise alerts. Implemented by src/alerts/manager.ts. */
export interface Alerter {
  /** Raises an event alert (sent once per key) or a condition alert (opened, or kept open). */
  emit(alert: Alert): void;
  /**
   * Declares the complete set of conditions currently holding within `scope` (a key prefix, e.g. "ethereum:state:").
   * New conditions are opened, held ones are kept (and reminded when due), and open conditions under `scope` that
   * are absent from `active` are resolved.
   */
  sync(scope: string, active: Alert[]): void;
  /** Resolves one open condition, if open. */
  resolve(key: string): void;
}

/** Every address the monitor knows about on one chain, re-resolved every cycle (adapters and pools can change). */
export interface ResolvedAddresses {
  token: Address;
  registry: Address;
  router?: Address;
  manager?: Address;
  timelock?: Address;
  controller?: Address;
  /** Live `Manager.guardian()`; undefined when address(0) or no Manager. */
  guardian?: Address;
  /** Pool the TokenAdminRegistry currently maps the token to (address(0) if none). */
  registryPool: Address;
  /** Registered adapters, by id (1-based). */
  adapters: Array<{id: bigint; adapter: Address; pool: Address; fundingEnabled: boolean; recallEnabled: boolean}>;
  /** Every adapter ever registered (Manager.getAdapterHistory), including replaced ones. */
  adapterHistory: Address[];
  /** Pools to watch: registered pools ∪ registry pool ∪ configured pool ∪ `reserves.extraPools`, deduplicated. */
  pools: Address[];
  /** Configured legacy reserve wallets (counted in reconciliation until migrated). */
  legacyWallets: Address[];
  /**
   * Reserve endpoints of this chain for flow monitoring and reconciliation, each listed once: Manager, adapter history,
   * pools, legacy wallets and `reserves.extraEndpoints`.
   */
  endpoints: Address[];
  /** Human-readable label per lowercase address ("Manager", "Pool", "Adapter #1", "Timelock", ...). */
  labels: Record<string, string>;
}

export interface Explorer {
  tx(hash: Hex): string;
  address(address: Address): string;
}

/** Per-chain runtime context handed to every rule. */
export interface ChainContext {
  /** Config key, e.g. "ethereum". */
  name: string;
  config: ChainConfig;
  global: Config;
  client: PublicClient;
  explorer: Explorer;
  alerter: Alerter;
  store: Store;
  log: Logger;
  addresses: ResolvedAddresses;
  /** Label for an address: the known label, else the checksummed address. */
  label(address: Address): string;
}

export interface LogFilter {
  address: Address | Address[];
  /**
   * eth_getLogs topic filter; `null` matches anything, an array matches any of its entries. An empty array (or an empty
   * `address` array) matches nothing: `fetchLogs` skips that filter instead of sending a wildcard query.
   */
  topics?: Array<Hex | Hex[] | null>;
}

export interface BlockRange {
  from: bigint;
  to: bigint;
}

/** A rule driven by logs. The scanner fetches the union of every rule's filters for a range and passes all of them. */
export interface EventRule {
  readonly id: string;
  /** Filters this rule needs for the current addresses. Called once per scanned range. */
  filters(ctx: ChainContext): LogFilter[];
  /**
   * Called once per scanned range with every log fetched for that range (the union over all rules, deduplicated,
   * sorted by blockNumber then logIndex). Rules pick out what they need; logs of other rules are visible on purpose
   * (e.g. flow rules match SAHARA Transfers against Funded/LiquidityAdded logs in the same transaction).
   */
  onLogs(ctx: ChainContext, logs: Log[], range: BlockRange): Promise<void>;
}

/** The reads of one state rule check, each named the same in every check (e.g. "Token.owner()"). */
export interface StateCheckReads {
  ok: string[];
  failed: string[];
  /** False when the check ended early: the reads it did not make are unknown. */
  complete: boolean;
}

/** A rule driven by state reads at a block. */
export interface StateRule {
  readonly id: string;
  /**
   * Reads state at `blockNumber` and returns every condition currently violated. The daemon passes them to
   * `alerter.sync(`${chain}:${id}:`, conditions)`, so condition keys must start with `${ctx.name}:${id}:`.
   * `snapshot` holds display values (for `check` output and the daily summary), as plain strings. `reads` lets the
   * daemon track how long each read has failed; without it, a check with its read-failed condition counts as every
   * read failing.
   */
  check(
    ctx: ChainContext,
    blockNumber: bigint,
  ): Promise<{conditions: Alert[]; snapshot: Record<string, string>; reads?: StateCheckReads}>;
}
