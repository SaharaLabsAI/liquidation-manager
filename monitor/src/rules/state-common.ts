// Plumbing shared by the state rules (src/rules/state.ts): reads at one block that record failures instead of throwing,
// revert decoding for the Manager's verify views, condition builders and display helpers.
//
// A failed read never passes silently: it raises `${chain}:${rule}:read-failed` (warning) and, because the alert
// manager resolves every open condition missing from a sync, last cycle's conditions that the failed reads could have
// confirmed are carried forward (store namespace `state:${chain}`), so an RPC hiccup does not send "resolved" for a
// problem nobody fixed. Carrying is scoped by address, so one pool that always fails a read (e.g. an older pool version
// lacking a view) cannot pin the conditions of other pools open forever. The daemon tracks how long each read has
// failed (from the reads a check reports, named the same in every check) and escalates the condition by the oldest:
// high after staleAfterSec, critical after three times that, and the chain counts as stale (src/health.ts
// `escalateReadFailed`, `readsStale`).
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  getAddress,
  isAddress,
  isHex,
  size,
  slice,
  zeroAddress,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type Hex,
} from "viem";

import {tokenAdminRegistryAbi, tokenPoolAbi} from "../abi/external.ts";
import {liquidityManagerAbi} from "../abi/generated.ts";
import {formatAmount} from "../format.ts";
import type {Alert, AlertField, AlertLink, ChainContext, Severity, StateCheckReads, StateRule} from "../types.ts";
import {otherChainSelectors} from "./common.ts";

/** Snapshot value of a read that failed. */
export const READ_FAILED = "unavailable (read failed)";

/** Key of the condition a state rule raises while any of its reads failed (the Timelock queue rule uses it too). */
export function readFailedKey(chain: string, ruleId: string): string {
  return `${chain}:${ruleId}:read-failed`;
}

type ReadMutability = "pure" | "view";

/** One `readContract` call without the block (added by `StateCheck`). */
export interface ReadParams<
  abi extends Abi,
  fn extends ContractFunctionName<abi, ReadMutability>,
  args extends ContractFunctionArgs<abi, ReadMutability, fn>,
> {
  address: Address;
  abi: abi;
  functionName: fn;
  args?: args;
}

/** A decoded revert of a verify view. */
export interface Revert {
  /** Custom error name; "Error"/"Panic" for require strings and panics; "unknown" when the selector is not known. */
  name: string;
  /** Display text, e.g. "PoolRebalancerMismatch(pool = Pool 0x…, rebalancer = 0x…)". */
  text: string;
}

export type VerifyResult = {ok: true} | {ok: false; revert: Revert};

export interface ConditionInput {
  /** Short check name; the alert's `rule` is `${ruleId}.${check}`. */
  check: string;
  /** Key suffix after `${chain}:${ruleId}:`; defaults to `check`. Lowercase addresses, selectors, ids only. */
  subject?: string;
  severity: Severity;
  title: string;
  fields?: AlertField[];
  links?: AlertLink[];
  note?: string;
}

/** Errors a verify view can bubble up: the Manager's own and the pool's or registry's from `_verifyPool`. */
const VERIFY_ERRORS_ABI: Abi = [
  ...(liquidityManagerAbi as Abi).filter((item) => item.type === "error"),
  ...(tokenPoolAbi as Abi).filter((item) => item.type === "error"),
  ...(tokenAdminRegistryAbi as Abi).filter((item) => item.type === "error"),
];

/**
 * State collected by one rule for one cycle: conditions (deduplicated by key, first raise wins), snapshot entries and
 * failed reads. Every read is made at `blockNumber`.
 */
export class StateCheck {
  readonly conditions = new Map<string, Alert>();
  readonly snapshot: Record<string, string> = {};
  readonly failures: string[] = [];
  /** Reads that returned (a revert of a verify view is a result too), described as in `failures`. */
  readonly verified: string[] = [];
  /** Lowercase addresses involved in failed reads (the contract read and address arguments). */
  readonly tainted = new Set<string>();
  /** The rule body threw: nothing it would have checked is known. */
  aborted = false;
  readonly ctx: ChainContext;
  readonly ruleId: string;
  readonly blockNumber: bigint;

  constructor(ctx: ChainContext, ruleId: string, blockNumber: bigint) {
    this.ctx = ctx;
    this.ruleId = ruleId;
    this.blockNumber = blockNumber;
  }

  /** `readContract` at the block; on any error records a failure and returns undefined. */
  async read<
    const abi extends Abi,
    fn extends ContractFunctionName<abi, ReadMutability>,
    const args extends ContractFunctionArgs<abi, ReadMutability, fn>,
  >(params: ReadParams<abi, fn, args>): Promise<ContractFunctionReturnType<abi, ReadMutability, fn, args> | undefined> {
    try {
      const result = (await this.ctx.client.readContract({
        ...params,
        blockNumber: this.blockNumber,
      } as never)) as ContractFunctionReturnType<abi, ReadMutability, fn, args>;
      this.verified.push(this.describeCall(params));
      return result;
    } catch (error) {
      this.fail(this.describeCall(params), error, involvedAddresses(params));
      return undefined;
    }
  }

  /**
   * Calls a view whose only output is whether it reverts (`verifyHandover`, `verifyAdapter`). A revert is a result;
   * an error without revert data (RPC failure) is recorded as a failed read and returns undefined.
   */
  async verify<
    const abi extends Abi,
    fn extends ContractFunctionName<abi, ReadMutability>,
    const args extends ContractFunctionArgs<abi, ReadMutability, fn>,
  >(params: ReadParams<abi, fn, args>): Promise<VerifyResult | undefined> {
    try {
      await this.ctx.client.readContract({...params, blockNumber: this.blockNumber} as never);
      this.verified.push(this.describeCall(params));
      return {ok: true};
    } catch (error) {
      const revert = decodeRevert(error, (address) => this.ctx.label(address));
      if (revert) {
        this.verified.push(this.describeCall(params));
        return {ok: false, revert};
      }
      this.fail(this.describeCall(params), error, involvedAddresses(params));
      return undefined;
    }
  }

  fail(what: string, error: unknown, involved: readonly string[] = []): void {
    this.ctx.log.warn(`${this.ruleId}: read failed`, {read: what, block: this.blockNumber, error: errorText(error)});
    this.failures.push(what);
    for (const address of involved) this.tainted.add(address.toLowerCase());
  }

  raise(input: ConditionInput): void {
    const key = `${this.ctx.name}:${this.ruleId}:${input.subject ?? input.check}`;
    if (this.conditions.has(key)) return;
    const alert: Alert = {
      key,
      kind: "condition",
      severity: input.severity,
      rule: `${this.ruleId}.${input.check}`,
      chain: this.ctx.name,
      title: input.title,
    };
    if (input.fields?.length) alert.fields = input.fields;
    if (input.links?.length) alert.links = input.links;
    if (input.note) alert.note = input.note;
    this.conditions.set(key, alert);
  }

  /** "Pool.getRebalancer()", "Manager.getPoolFundingBudget(Pool)": the failure text listed in read-failed alerts. */
  private describeCall(params: {address: Address; functionName: string; args?: unknown}): string {
    const list: readonly unknown[] = Array.isArray(params.args) ? params.args : [];
    const args = list.map((arg) => formatValue(arg, (address) => this.ctx.label(address)));
    return `${this.ctx.label(params.address)}.${params.functionName}(${args.join(", ")})`;
  }
}

/**
 * Defines a state rule. `body` fills a `StateCheck`; an exception escaping it counts as a failed read. When anything
 * failed, a read-failed warning is added and last cycle's conditions that were not re-raised are kept open.
 */
export function defineStateRule(id: string, body: (check: StateCheck) => Promise<void>): StateRule {
  return {
    id,
    async check(ctx, blockNumber) {
      const check = new StateCheck(ctx, id, blockNumber);
      try {
        await body(check);
      } catch (error) {
        check.aborted = true;
        check.fail(`${id} check aborted: ${errorText(error)}`, error);
      }
      return finish(check);
    },
  };
}

interface HeldConditions {
  /** Conditions each rule returned last cycle (read-failed excluded). */
  rules: Record<string, Alert[]>;
}

function finish(check: StateCheck): {conditions: Alert[]; snapshot: Record<string, string>; reads: StateCheckReads} {
  const {ctx, ruleId} = check;
  const namespace = `state:${ctx.name}`;
  const held = ctx.store.get<HeldConditions>(namespace, {rules: {}});
  const previous = held.rules[ruleId] ?? [];
  if (check.failures.length) {
    // Cannot tell whether these problems were fixed: keep them open until the reads succeed again. A condition whose
    // subject names addresses depends on reads involving them; one without (Manager-wide, lane-wide) on any read.
    const prefix = `${ctx.name}:${ruleId}:`;
    const unverified = (alert: Alert) => {
      if (check.aborted) return true;
      const subjects = alert.key.slice(prefix.length).toLowerCase().match(/0x[0-9a-f]{40}/g);
      return !subjects || subjects.some((address) => check.tainted.has(address));
    };
    for (const alert of previous) {
      if (!check.conditions.has(alert.key) && unverified(alert)) check.conditions.set(alert.key, alert);
    }
  }
  const conditions = [...check.conditions.values()];
  if (JSON.stringify(previous) !== JSON.stringify(conditions)) {
    if (conditions.length) held.rules[ruleId] = conditions;
    else delete held.rules[ruleId];
    ctx.store.set(namespace, held);
  }
  if (check.failures.length) {
    conditions.push({
      key: readFailedKey(ctx.name, ruleId),
      kind: "condition",
      severity: "warning",
      rule: `${ruleId}.read-failed`,
      chain: ctx.name,
      title: `Cannot verify ${ruleId}: ${check.failures.length} read(s) failed`,
      fields: [{label: "Failed reads", value: check.failures.join("\n"), code: true}],
      note: "Conditions open from the last cycle stay open until the reads succeed again.",
    });
  }
  const reads: StateCheckReads = {
    ok: [...check.verified],
    // An abort (the last failure) is not a read: the reads it prevented are unknown, which `complete` says.
    failed: check.aborted ? check.failures.slice(0, -1) : [...check.failures],
    complete: !check.aborted,
  };
  return {conditions, snapshot: check.snapshot, reads};
}

/** The contract read and every address argument of a call. */
function involvedAddresses(params: {address: Address; args?: unknown}): string[] {
  const args: readonly unknown[] = Array.isArray(params.args) ? params.args : [];
  const addresses = args.filter((arg): arg is string => typeof arg === "string" && isAddress(arg, {strict: false}));
  return [params.address, ...addresses];
}

// ---------------------------------------------------------------------------------------------------------------------
// Revert decoding

/**
 * Decodes the revert carried by a failed `eth_call`, or returns undefined when the error carries no revert (an RPC or
 * transport failure). Handles viem's `ContractFunctionRevertedError` (decoded `data`, or `raw` bytes when the selector
 * was not in the call ABI) and raw JSON-RPC errors whose `data` (or `data.data`) holds the revert bytes. A revert
 * without data ("execution reverted") is still a revert: e.g. a call into a contract lacking the function.
 */
export function decodeRevert(error: unknown, label: (address: Address) => string): Revert | undefined {
  const reverted =
    error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null;
  if (reverted instanceof ContractFunctionRevertedError) {
    if (reverted.data) return fromDecoded(reverted.data.errorName, reverted.data.args, reverted.data.abiItem, label);
    if (reverted.raw && reverted.raw !== "0x") return fromRaw(reverted.raw, label);
    if (reverted.reason !== undefined && !/revert/i.test(reverted.reason)) return undefined;
    return {name: "empty revert", text: "reverted without data"};
  }
  const raw = findRevertData(error);
  if (raw) return fromRaw(raw, label);
  if (/execution reverted/i.test(errorText(error))) return {name: "empty revert", text: "reverted without data"};
  return undefined;
}

function fromRaw(raw: Hex, label: (address: Address) => string): Revert {
  if (size(raw) < 4) return {name: "empty revert", text: `reverted with ${raw}`};
  try {
    const decoded = decodeErrorResult({abi: VERIFY_ERRORS_ABI, data: raw});
    return fromDecoded(decoded.errorName, decoded.args, decoded.abiItem, label);
  } catch {
    const selector = slice(raw, 0, 4);
    return {name: "unknown", text: `unknown error ${selector} (${size(raw)} bytes: ${raw})`};
  }
}

function fromDecoded(
  errorName: string,
  args: readonly unknown[] | undefined,
  abiItem: object | undefined,
  label: (address: Address) => string,
): Revert {
  const values = args ?? [];
  const inputs = abiItem && "inputs" in abiItem ? (abiItem.inputs as ReadonlyArray<{name?: string}>) : [];
  const parts = values.map((value, i) => {
    const name = inputs[i]?.name;
    const text = formatValue(value, label);
    return name ? `${name} = ${text}` : text;
  });
  return {name: errorName, text: `${errorName}(${parts.join(", ")})`};
}

/** First hex `data` (or nested `data.data`) of at least a selector found along the error's `cause` chain. */
function findRevertData(error: unknown): Hex | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    const record = current as {data?: unknown; cause?: unknown};
    const data = record.data;
    if (typeof data === "string" && isHex(data) && data.length >= 10) return data;
    if (data !== null && typeof data === "object") {
      const nested = (data as {data?: unknown}).data;
      if (typeof nested === "string" && isHex(nested) && nested.length >= 10) return nested;
    }
    current = record.cause;
  }
  return undefined;
}

export function errorText(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------------------------------------------------
// Display helpers (plain text; sinks escape)

/** Decoded ABI value as text: addresses labeled, bigints in decimal, strings quoted. */
export function formatValue(value: unknown, label: (address: Address) => string): string {
  if (typeof value === "string" && isAddress(value, {strict: false})) {
    const checksummed = getAddress(value);
    const name = label(checksummed);
    return name === checksummed ? checksummed : `${name} ${checksummed}`;
  }
  if (typeof value === "string") return isHex(value) ? value : JSON.stringify(value);
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => formatValue(item, label)).join(", ")}]`;
  return String(value);
}

/** "Timelock 0xAbC…" for a known address, the checksummed address otherwise, "none (address(0))" for zero. */
export function labelled(ctx: ChainContext, address: string): string {
  if (address.toLowerCase() === zeroAddress) return "none (address(0))";
  const checksummed = getAddress(address);
  const name = ctx.label(checksummed);
  return name === checksummed ? checksummed : `${name} ${checksummed}`;
}

export function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function amount(ctx: ChainContext, raw: bigint): string {
  return formatAmount(raw, ctx.global.token.decimals, ctx.global.token.symbol);
}

/** Lowercase address for condition keys (stable however the address was spelled). */
export function keyOf(address: string): string {
  return address.toLowerCase();
}

/** `bytes` holding an ABI-encoded address (remote token or pool) shown as that address; other bytes as hex. */
export function remoteAddressText(bytes: Hex): string {
  if (size(bytes) === 32 && /^0x0{24}/i.test(bytes)) return getAddress(slice(bytes, 12));
  if (size(bytes) === 20) return getAddress(bytes);
  return bytes;
}

/** Case-insensitive set difference of hex strings: entries of `a` missing from `b`. */
export function hexMinus<T extends string>(a: readonly T[], b: readonly string[]): T[] {
  const other = new Set(b.map((item) => item.toLowerCase()));
  return a.filter((item) => !other.has(item.toLowerCase()));
}

/**
 * CCIP selectors of the counterpart chain(s): the other configured chains. A single-chain config falls back to the
 * Manager pool specs' `remoteChainSelector` passed in `specSelectors`, except this chain's own selector. A spec that
 * names another lane is reported by state-pool; checking the Router's ramps for it against `expected.onRamp` and
 * `expected.offRamps`, which describe the configured lane, would only add false "changed" alerts.
 */
export function remoteSelectorsOf(ctx: ChainContext, specSelectors: readonly bigint[] = []): bigint[] {
  const others = otherChainSelectors(ctx);
  if (others.length) return others;
  return [...new Set(specSelectors.filter((selector) => selector !== ctx.config.chainSelector))];
}

/** Adapters whose pool the TokenAdminRegistry currently maps the token to (the live bridge pool). */
export function liveAdapters(ctx: ChainContext): ChainContext["addresses"]["adapters"] {
  const registryPool = ctx.addresses.registryPool.toLowerCase();
  return ctx.addresses.adapters.filter((entry) => entry.pool.toLowerCase() === registryPool);
}

/**
 * Whether `pool` can carry bridge traffic or receive funding: the registry pool (the configured pool while the registry
 * maps none) or the pool of a fundable adapter (a migration target). A retired pool is neither: CCIP ramps resolve the
 * pool through the registry, so its remote configuration and rate limits no longer matter, only who controls it.
 */
export function isLivePool(ctx: ChainContext, pool: string): boolean {
  const {registryPool, adapters} = ctx.addresses;
  const current = registryPool.toLowerCase() === zeroAddress ? ctx.config.contracts.pool : registryPool;
  if (current && current.toLowerCase() === pool.toLowerCase()) return true;
  return adapters.some((entry) => entry.fundingEnabled && entry.pool.toLowerCase() === pool.toLowerCase());
}

/** Pools of adapters that are live or still fundable (a migration target), deduplicated, checksummed. */
export function activePools(ctx: ChainContext): Address[] {
  const registryPool = ctx.addresses.registryPool.toLowerCase();
  const seen = new Set<string>();
  const pools: Address[] = [];
  for (const entry of ctx.addresses.adapters) {
    const key = entry.pool.toLowerCase();
    if (seen.has(key) || !(entry.fundingEnabled || key === registryPool)) continue;
    seen.add(key);
    pools.push(getAddress(entry.pool));
  }
  return pools;
}
