// Decodes and classifies calls scheduled on the Timelock, so the Guardian sees exactly what a proposal would do before
// its delay elapses. Every call is decoded against the ABI of the contract it targets; anything the monitor cannot
// decode is treated as critical, since an unreadable proposal cannot be reviewed.
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  formatUnits,
  getAddress,
  hexToBigInt,
  isAddress,
  isHex,
  keccak256,
  maxUint256,
  size,
  slice,
  stringToHex,
  toFunctionSelector,
  zeroHash,
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";

import {routerAbi, saharaTokenAbi, tokenAdminRegistryAbi, tokenPoolAbi} from "../abi/external.ts";
import {
  ccipPoolAdapterAbi,
  guardianControllerAbi,
  liquidityManagerAbi,
  saharaTimelockAbi,
} from "../abi/generated.ts";
import {formatAmount, formatDuration} from "../format.ts";
import {SEVERITY_RANK, type ResolvedAddresses, type Severity} from "../types.ts";
import {includesAddress, sameAddress} from "./common.ts";

export type TargetKind =
  | "manager"
  | "pool"
  | "registry"
  | "token"
  | "timelock"
  | "controller"
  | "adapter"
  | "router"
  | "unknown";

export interface DecodedArg {
  name: string;
  type: string;
  /** Decoded value as returned by viem (bigint, address, struct object, ...). */
  value: unknown;
  /** Plain-text rendering: amounts formatted, addresses labelled, roles named. */
  display: string;
}

export interface DecodedCall {
  target: Address;
  kind: TargetKind;
  /** Contract name used in summaries, e.g. "LiquidityManager", "Pool", "TokenAdminRegistry". */
  contract: string;
  /** Function name, or "unrecognised" when the selector is not in the target's ABI. */
  fn: string;
  /** 4-byte selector, or null when the calldata is shorter than 4 bytes. */
  selector: Hex | null;
  args: DecodedArg[];
  /** One line, e.g. "LiquidityManager.setGuardian(newGuardian=Guardian 0x…)". */
  summary: string;
  severity: Severity;
  /** A standalone protected `setGuardian` (mirrors `GuardianController.isProtectedCall`). */
  protected?: boolean;
  /** Anomalies worth a human look: value attached, non-canonical calldata, malformed arguments. */
  notes: string[];
}

export interface DecodeOptions {
  /** Token used to format amounts. Default SAHARA, 18 decimals. */
  token?: {symbol: string; decimals: number};
  /** Address labeller (normally `ctx.label`). Default: `addresses.labels`, else the checksummed address. */
  label?: (address: Address) => string;
  /** CCIP chain selector -> name. Default: the selector as a decimal string. */
  chainName?: (selector: bigint) => string;
  /** The Timelock's current delay, to show `updateDelay` as old -> new. */
  currentDelay?: bigint;
}

/** OpenZeppelin AccessControl / TimelockController role ids. */
export const TIMELOCK_ROLES: {DEFAULT_ADMIN_ROLE: Hex; PROPOSER_ROLE: Hex; EXECUTOR_ROLE: Hex; CANCELLER_ROLE: Hex} = {
  DEFAULT_ADMIN_ROLE: zeroHash,
  PROPOSER_ROLE: keccak256(stringToHex("PROPOSER_ROLE")),
  EXECUTOR_ROLE: keccak256(stringToHex("EXECUTOR_ROLE")),
  CANCELLER_ROLE: keccak256(stringToHex("CANCELLER_ROLE")),
};

/** "PROPOSER_ROLE" for a known role id, else the id itself. */
export function roleName(role: Hex): string {
  const match = Object.entries(TIMELOCK_ROLES).find(([, id]) => id.toLowerCase() === role.toLowerCase());
  return match ? match[0] : role;
}

export const SET_GUARDIAN_SELECTOR = toFunctionSelector("setGuardian(address)");
export const UPDATE_DELAY_SELECTOR = toFunctionSelector("updateDelay(uint256)");

/** Whether `data` starts with `selector` (case-insensitive). */
export function hasSelector(data: Hex, selector: Hex): boolean {
  return data.slice(0, 10).toLowerCase() === selector.toLowerCase();
}

/** Manager functions that move authority or reserves (Section "Timelock" of the monitor spec). Others are high. */
const CRITICAL_MANAGER_FUNCTIONS = new Set([
  "setGuardian",
  "migrateReserves",
  "transferOwnership",
  "acceptOwnership",
  "registerAdapter",
  "replaceAdapter",
  "setPoolSpec",
  "setPoolMigrationApproval",
  "setFundingOperator",
  "setRecallOperator",
]);

/** Arguments holding token amounts (base units of the token). */
const AMOUNT_ARGS = new Set([
  "amount",
  "capacity",
  "minimum",
  "refillTrigger",
  "refillTarget",
  "newMaxFundingPerCall",
  "newMaxRecallPerCall",
  "value",
]);
/** Arguments holding a refill rate (token base units per second). */
const RATE_ARGS = new Set(["rate"]);
/** Arguments holding durations in seconds. */
const DURATION_ARGS = new Set(["newDelay", "delay"]);

/**
 * Mirrors `GuardianController.isProtectedCall` byte for byte: the Manager as target, zero value, exactly 36 bytes of
 * calldata, the `setGuardian(address)` selector and an argument whose upper 96 bits are zero. Raw bytes on purpose:
 * viem's decoder ignores trailing bytes and dirty upper bits, which the contract does not.
 */
export function isProtectedSetGuardian(
  target: Address,
  value: bigint,
  data: Hex,
  manager: Address | undefined,
): boolean {
  if (!manager || !sameAddress(target, manager) || value !== 0n) return false;
  if (!isHex(data, {strict: true}) || size(data) !== 36) return false;
  if (slice(data, 0, 4).toLowerCase() !== SET_GUARDIAN_SELECTOR) return false;
  return hexToBigInt(slice(data, 4, 36)) >> 160n === 0n;
}

/** Why a `setGuardian` call is not protected, or null when it is (or is not a `setGuardian` call at all). */
export function unprotectedSetGuardianReason(
  target: Address,
  value: bigint,
  data: Hex,
  manager: Address | undefined,
): string | null {
  if (!isHex(data, {strict: true}) || size(data) < 4 || slice(data, 0, 4).toLowerCase() !== SET_GUARDIAN_SELECTOR) {
    return null;
  }
  if (!manager) return "the Manager is not resolved, so protection cannot be checked";
  if (!sameAddress(target, manager)) return "the target is not the Manager";
  if (value !== 0n) return `it carries value (${value} wei)`;
  if (size(data) !== 36) return `its calldata is ${size(data)} bytes, not 36`;
  if (hexToBigInt(slice(data, 4, 36)) >> 160n !== 0n) {
    return "the address argument has non-zero upper bits (it would also revert at execution)";
  }
  return null;
}

interface Target {
  kind: TargetKind;
  contract: string;
  abi: Abi | undefined;
}

function identifyTarget(target: Address, addresses: ResolvedAddresses, opts: DecodeOptions): Target {
  const labelOf = (fallback: string) => addresses.labels[target.toLowerCase()] ?? fallback;
  if (sameAddress(target, addresses.manager)) {
    return {kind: "manager", contract: "LiquidityManager", abi: liquidityManagerAbi};
  }
  if (sameAddress(target, addresses.timelock)) return {kind: "timelock", contract: "Timelock", abi: saharaTimelockAbi};
  if (sameAddress(target, addresses.controller)) {
    return {kind: "controller", contract: "GuardianController", abi: guardianControllerAbi};
  }
  if (sameAddress(target, addresses.registry)) {
    return {kind: "registry", contract: "TokenAdminRegistry", abi: tokenAdminRegistryAbi};
  }
  if (sameAddress(target, addresses.token)) {
    return {kind: "token", contract: opts.token?.symbol ?? "SAHARA", abi: saharaTokenAbi};
  }
  if (includesAddress(addresses.pools, target) || sameAddress(target, addresses.registryPool)) {
    return {kind: "pool", contract: labelOf("Pool"), abi: tokenPoolAbi};
  }
  const adapters = [...addresses.adapters.map((entry) => entry.adapter), ...addresses.adapterHistory];
  if (includesAddress(adapters, target)) {
    return {kind: "adapter", contract: labelOf("Adapter"), abi: ccipPoolAdapterAbi};
  }
  if (sameAddress(target, addresses.router)) return {kind: "router", contract: "Router", abi: routerAbi};
  return {kind: "unknown", contract: labelOf(getAddress(target)), abi: undefined};
}

/** ABIs tried, in order, to name the function of a call to an unknown target. */
const FALLBACK_ABIS: Array<{name: string; abi: Abi}> = [
  {name: "LiquidityManager", abi: liquidityManagerAbi},
  {name: "TokenPool", abi: tokenPoolAbi},
  {name: "TokenAdminRegistry", abi: tokenAdminRegistryAbi},
  {name: "ERC20", abi: saharaTokenAbi},
  {name: "Timelock", abi: saharaTimelockAbi},
];

function functionsBySelector(abi: Abi): Map<string, AbiFunction> {
  const map = new Map<string, AbiFunction>();
  for (const item of abi) if (item.type === "function") map.set(toFunctionSelector(item).toLowerCase(), item);
  return map;
}

const selectorCache = new WeakMap<Abi, Map<string, AbiFunction>>();

function findFunction(abi: Abi, selector: Hex): AbiFunction | undefined {
  let map = selectorCache.get(abi);
  if (!map) {
    map = functionsBySelector(abi);
    selectorCache.set(abi, map);
  }
  return map.get(selector.toLowerCase());
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

interface Formatter {
  fn: string;
  label(address: Address): string;
  amount(raw: bigint): string;
  chainName(selector: bigint): string;
  currentDelay?: bigint;
}

function labelled(fmt: Formatter, address: string): string {
  if (!isAddress(address, {strict: false})) return address;
  const checksummed = getAddress(address);
  const name = fmt.label(checksummed);
  return name === checksummed ? checksummed : `${name} ${checksummed}`;
}

function formatUint(param: AbiParameter, raw: bigint, fmt: Formatter): string {
  const name = param.name ?? "";
  if (DURATION_ARGS.has(name)) {
    const next = `${formatDuration(raw)} (${raw}s)`;
    return fmt.fn === "updateDelay" && fmt.currentDelay !== undefined
      ? `${formatDuration(fmt.currentDelay)} -> ${next}`
      : next;
  }
  if (/chainselector$/i.test(name)) return `${fmt.chainName(raw)} (${raw})`;
  // recoverToken moves a foreign token whose decimals are unknown: show base units.
  if (fmt.fn !== "recoverToken" && AMOUNT_ARGS.has(name)) {
    if (raw === maxUint256) return fmt.fn === "migrateReserves" ? "entire balance (type(uint256).max)" : "max uint256";
    return fmt.amount(raw);
  }
  if (RATE_ARGS.has(name)) return `${fmt.amount(raw)}/s`;
  return raw.toString();
}

function formatBytes(raw: Hex, fmt: Formatter): string {
  // CCIP encodes EVM remote token/pool addresses as abi.encode(address).
  if (size(raw) === 32 && hexToBigInt(raw) >> 160n === 0n && hexToBigInt(raw) !== 0n) {
    const [address] = decodeAbiParameters([{type: "address"}], raw);
    return `${labelled(fmt, address)} (abi-encoded)`;
  }
  return raw === "0x" ? "0x (empty)" : raw;
}

function formatValue(param: AbiParameter, value: unknown, fmt: Formatter): string {
  const type = param.type;
  const array = /^(.*)\[(\d*)\]$/.exec(type);
  if (array) {
    const inner = {...param, type: array[1] ?? ""} as AbiParameter;
    const items = Array.isArray(value) ? value : [];
    return `[${items.map((item) => formatValue(inner, item, fmt)).join(", ")}]`;
  }
  if (type === "tuple") {
    const components = "components" in param ? param.components : [];
    const record = (value ?? {}) as Record<string, unknown> & unknown[];
    const parts = components.map((component, i) => {
      const item = component.name !== undefined && component.name in record ? record[component.name] : record[i];
      return `${component.name ?? i}: ${formatValue(component, item, fmt)}`;
    });
    return `{${parts.join(", ")}}`;
  }
  if (type === "address") return labelled(fmt, String(value));
  if (type === "bool") return String(value);
  if (type === "string") return JSON.stringify(value);
  if (type === "bytes32") return /role/i.test(param.name ?? "") ? roleName(value as Hex) : String(value);
  if (type === "bytes") return formatBytes(value as Hex, fmt);
  if (/^u?int\d*$/.test(type) && typeof value === "bigint") return formatUint(param, value, fmt);
  return String(value);
}

/** Severity of a decoded call by target and function, before value and calldata anomalies. */
export function classifyCall(kind: TargetKind, fn: string): Severity {
  if (kind === "manager") return CRITICAL_MANAGER_FUNCTIONS.has(fn) ? "critical" : "high";
  // Pool, registry and token admin calls move bridge, registry or token authority; calls to the Timelock itself change
  // the delay or roles; the controller and adapters expose nothing the Timelock should call; unknown targets cannot
  // be reviewed.
  return "critical";
}

/**
 * Decodes one call `(target, value, data)` of a Timelock operation. The target is matched against the known
 * addresses and decoded with that contract's ABI; an unknown target or selector is reported as an "unrecognised call"
 * (critical). Any value > 0 is critical.
 */
export function decodeCall(
  target: Address,
  value: bigint,
  data: Hex,
  addresses: ResolvedAddresses,
  opts: DecodeOptions = {},
): DecodedCall {
  const token = opts.token ?? {symbol: "SAHARA", decimals: 18};
  const label = opts.label ?? ((address: Address) => addresses.labels[address.toLowerCase()] ?? getAddress(address));
  const id = identifyTarget(target, addresses, opts);
  const notes: string[] = [];
  const valueText = value > 0n ? `{value: ${formatUnits(value, 18)} native}` : "";
  if (value > 0n) notes.push(`Sends ${formatUnits(value, 18)} native coin (${value} wei) from the Timelock.`);

  const base = {target: getAddress(target), kind: id.kind, contract: id.contract};
  const validHex = isHex(data, {strict: true}) && data.length % 2 === 0;
  if (!validHex || size(data) < 4) {
    const what = !validHex
      ? "malformed calldata"
      : size(data) === 0
        ? "plain transfer, no calldata"
        : "calldata shorter than a selector";
    return {
      ...base,
      fn: "unrecognised",
      selector: null,
      args: [],
      summary: `${id.contract}${valueText}: unrecognised call (${what}${validHex ? `, ${size(data)} bytes` : ""})`,
      severity: "critical",
      notes,
    };
  }

  const selector = slice(data, 0, 4);
  const contract = id.contract;
  let fnItem = id.abi ? findFunction(id.abi, selector) : undefined;
  if (id.kind === "unknown") {
    notes.push("Unrecognised target: not a contract the monitor knows.");
    for (const candidate of FALLBACK_ABIS) {
      fnItem = findFunction(candidate.abi, selector);
      if (fnItem) {
        notes.push(`Function named by selector only, using the ${candidate.name} ABI.`);
        break;
      }
    }
  }
  if (!fnItem) {
    return {
      ...base,
      fn: "unrecognised",
      selector,
      args: [],
      summary: `${contract}${valueText}: unrecognised call (selector ${selector}, ${size(data)} bytes)`,
      severity: "critical",
      notes,
    };
  }

  const fmt: Formatter = {
    fn: fnItem.name,
    label,
    amount: (raw) => formatAmount(raw, token.decimals, token.symbol),
    chainName: opts.chainName ?? ((selectorValue) => selectorValue.toString()),
    currentDelay: opts.currentDelay,
  };
  let severity = classifyCall(id.kind, fnItem.name);
  if (value > 0n) severity = "critical";

  let args: DecodedArg[] = [];
  let argsText: string;
  try {
    const decoded = decodeFunctionData({abi: [fnItem], data});
    const values = (decoded.args ?? []) as readonly unknown[];
    args = fnItem.inputs.map((param, i) => ({
      name: param.name ?? `arg${i}`,
      type: param.type,
      value: values[i],
      display: formatValue(param, values[i], fmt),
    }));
    argsText = args.map((arg) => (arg.name ? `${arg.name}=${arg.display}` : arg.display)).join(", ");
    // viem ignores trailing bytes and dirty upper bits; the canonical encoding shows whether the calldata has either.
    const canonical = encodeFunctionData({abi: [fnItem], functionName: fnItem.name, args: values} as never) as Hex;
    if (canonical.toLowerCase() !== data.toLowerCase()) {
      notes.push(
        `Non-canonical calldata: ${size(data)} bytes, canonical encoding is ${size(canonical)} bytes` +
          " (padding or dirty upper bits).",
      );
    }
  } catch {
    argsText = `<malformed arguments: ${size(data) - 4} bytes>`;
    notes.push(`Arguments do not decode as ${fnItem.name}: the call would revert at execution.`);
    severity = "critical";
  }

  // Call-level protection only; whether the operation is protected also depends on it being a single call, which the
  // Timelock rule decides (and explains with `unprotectedSetGuardianReason`).
  const isProtected = hasSelector(data, SET_GUARDIAN_SELECTOR)
    ? isProtectedSetGuardian(target, value, data, addresses.manager)
    : undefined;

  return {
    ...base,
    contract,
    fn: fnItem.name,
    selector,
    args,
    summary:
      id.kind === "unknown"
        ? `unrecognised call to ${contract}: ${fnItem.name}${valueText}(${argsText})`
        : `${contract}.${fnItem.name}${valueText}(${argsText})`,
    severity,
    ...(isProtected !== undefined ? {protected: isProtected} : {}),
    notes,
  };
}

/** Highest severity of a list of calls (critical for an empty list: nothing to review is itself suspicious). */
export function callsSeverity(calls: readonly DecodedCall[]): Severity {
  if (!calls.length) return "critical";
  return calls.reduce<Severity>((acc, call) => maxSeverity(acc, call.severity), "info");
}
