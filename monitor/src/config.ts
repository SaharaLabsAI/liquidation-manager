// Configuration: YAML (or JSON) file with ${ENV} interpolation, validated with zod. Addresses are checksummed, chain
// selectors are bigints, token amounts stay decimal strings of whole tokens until `toUnits`.
// Secrets (bot token, RPC URLs that embed API keys) should come from the environment and are registered for redaction.
import {readFileSync} from "node:fs";

import {getAddress, isAddress, parseUnits, zeroAddress, type Address, type Hex} from "viem";
import {parse as parseYaml} from "yaml";
import {z} from "zod";

import {registerSecret} from "./log.ts";
import type {ResolvedAddresses} from "./types.ts";

const address = z
  .string()
  .refine((value) => isAddress(value, {strict: false}), {message: "invalid address"})
  .transform((value) => getAddress(value));

/** Aliases resolved against the live deployment each cycle (see `resolveRef`). */
export const ADDRESS_ALIASES = ["timelock", "manager", "controller", "adapter", "governanceSafe", "zero"] as const;
export type AddressAlias = (typeof ADDRESS_ALIASES)[number];

/** An address, or an alias such as "timelock". */
const addressRef = z.union([z.enum(ADDRESS_ALIASES), address]);
export type AddressRef = z.infer<typeof addressRef>;

/** Whole tokens as a decimal string or number, e.g. "10000000000" or 2.5. Converted with `toUnits`. */
const amount = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).replaceAll("_", ""))
  .refine((value) => /^\d+(\.\d+)?$/.test(value), {message: "expected a non-negative decimal amount"});

const severity = z.enum(["critical", "high", "warning", "info"]);

/** A transaction hash or CCIP messageId (32 bytes), lowercased. */
const hash32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, {message: "expected 32 bytes of hex (0x + 64 hex digits)"})
  .transform((value) => value.toLowerCase() as Hex);

/**
 * An in-flight obligation the monitor can never see settle, checked and settled by the operator (e.g. in the CCIP
 * explorer): no longer counted in I. Only what has no automatic settlement path can be acknowledged; anything else
 * (pending or failed messages, gaps) clears by itself once settlement is observed.
 */
const acknowledgement = z
  .object({
    /** Chain of the transaction, or the chain the message was sent from (a key of `chains`). */
    chain: z.string(),
    /** A lock that cannot be tied to a CCIP message, or whose transaction receipt cannot be fetched. */
    txHash: hash32.optional(),
    /** A message to a chain selector that is not configured (its execution cannot be seen). */
    messageId: hash32.optional(),
    /** What was checked, e.g. the CCIP explorer link and the date. */
    note: z.string().min(1),
  })
  .refine((entry) => (entry.txHash === undefined) !== (entry.messageId === undefined), {
    message: "set exactly one of txHash and messageId",
  });

const rateLimit = z.object({
  enabled: z.boolean(),
  /** Whole tokens. */
  capacity: amount,
  /** Whole tokens per second. */
  rate: amount,
});

const chainSchema = z.object({
  chainId: z.number().int().positive(),
  /** CCIP chain selector of this chain (decimal string). */
  chainSelector: z
    .union([z.string(), z.number()])
    .transform((value) => String(value))
    .refine((value) => /^\d+$/.test(value), {message: "expected a decimal chain selector"})
    .transform((value) => BigInt(value)),
  /** Tried in order; later URLs are fallbacks. Must support eth_getLogs over `maxLogRange` blocks. */
  rpcUrls: z.array(z.string().url()).min(1),
  /** Per-request RPC timeout. */
  rpcTimeoutMs: z.number().int().positive().default(20_000),
  /** Retries per RPC URL before falling back to the next one. */
  rpcRetryCount: z.number().int().min(0).default(2),
  explorerUrl: z.string().url(),
  /** Logs and state are processed at `head - confirmations`. */
  confirmations: z.number().int().min(0).default(3),
  pollIntervalSec: z.number().positive().default(15),
  /**
   * Largest eth_getLogs block range; ranges that fail are split further (at the cost of extra requests). Free public
   * endpoints often cap this at 50-1000 blocks; paid providers usually allow 2000 or more.
   */
  maxLogRange: z.number().int().positive().default(500),
  /** First block scanned when no cursor is stored. Default: the confirmed head at first start. */
  startBlock: z.number().int().min(0).optional(),
  /**
   * The chain is stale (`health.stale-telemetry`, high; critical after 3×; /healthz 503; no heartbeat; no
   * reconciliation) once for longer than this either no successful cycle left the cursor at the confirmed head (an RPC
   * behind the cursor does not count), or the confirmed head did not rise (a stuck RPC node: raise this for chains
   * without regular blocks). Counted from the start until the first catch-up; a condition still open at a restart
   * keeps its age.
   */
  staleAfterSec: z.number().positive().default(300),
  contracts: z.object({
    token: address,
    /** CCIP TokenAdminRegistry. */
    registry: address,
    /** CCIP Router. Default: the pool's `getRouter()`. */
    router: address.optional(),
    /** The pool to watch before a Manager exists; with a Manager, registered pools are discovered. */
    pool: address.optional(),
    manager: address.optional(),
    /** Default: `manager.owner()`. */
    timelock: address.optional(),
    /** GuardianController. Default: the registered pool's spec `rateLimitAdmin`. */
    controller: address.optional(),
  }),
  reserves: z
    .object({
      /** Legacy reserve wallets: flow-monitored and counted in reconciliation until migrated. */
      legacyWallets: z.array(address).default([]),
      /** Retired or replacement pools still holding inventory or obligations. */
      extraPools: z.array(address).default([]),
      /** Any other reserve endpoint counted in reconciliation. */
      extraEndpoints: z.array(address).default([]),
    })
    .default({legacyWallets: [], extraPools: [], extraEndpoints: []}),
  /**
   * Expected live state. Unset entries are not asserted, except these defaults once `contracts.manager` is set:
   * tokenOwner, poolOwner and registryAdmin = "timelock"; rebalancer = "adapter"; rateLimitAdmin = "controller".
   */
  expected: z
    .object({
      governanceSafe: address.optional(),
      guardian: addressRef.optional(),
      fundingOperators: z.array(address).optional(),
      recallOperators: z.array(address).optional(),
      timelockDelaySec: z.number().int().positive().optional(),
      /** Exact Timelock role holders. "timelock" is the self-administration admin. */
      timelockRoles: z
        .object({
          admins: z.array(addressRef),
          proposers: z.array(addressRef),
          executors: z.array(addressRef),
          cancellers: z.array(addressRef),
        })
        .partial()
        .optional(),
      tokenOwner: addressRef.optional(),
      tokenPaused: z.boolean().default(false),
      poolOwner: addressRef.optional(),
      registryAdmin: addressRef.optional(),
      /** "adapter" = the adapter registered for the pool in the Manager. */
      rebalancer: addressRef.optional(),
      rateLimitAdmin: addressRef.optional(),
      /** Router `getOnRamp(remoteSelector)`. */
      onRamp: address.optional(),
      /** Router OffRamps authorised for the remote chain selector (exact set). */
      offRamps: z.array(address).optional(),
      /** Expected pool rate limits for the remote chain. A lockdown (enabled, 0, 0) always alerts. */
      rateLimits: z.object({outbound: rateLimit, inbound: rateLimit}).optional(),
    })
    .default({tokenPaused: false}),
  limits: z
    .object({
      /** Budget available below this percentage of capacity raises a warning; 0 available raises high. */
      budgetLowPct: z.number().min(0).max(100).default(20),
      /** A single bridge release or lock at or above this amount (whole tokens) raises a warning. */
      largeTransfer: amount.optional(),
      /** Pool outflow (bridge releases + withdrawals + migrations) summed over `outflowWindowSec`. */
      outflowWindowSec: z.number().positive().default(3600),
      /** Outflow over the window at or above this amount (whole tokens) raises high. */
      outflowWindowAmount: amount.optional(),
    })
    .default({budgetLowPct: 20, outflowWindowSec: 3600}),
  ccip: z
    .object({
      /** Track SAHARA CCIP messages (in-flight amount I, failed and stuck messages). */
      enabled: z.boolean().default(true),
      /** A message not executed on the destination after this long raises a warning. */
      stuckAfterSec: z.number().positive().default(2 * 3600),
    })
    .default({enabled: true, stuckAfterSec: 2 * 3600}),
});

const telegramRoute = z.object({
  /** Channel "@name" or numeric id ("-100…"); group id for groups. The bot must be able to post there. */
  chatId: z.union([z.string(), z.number()]).transform((value) => String(value)),
  /** Forum topic id (groups with topics). */
  threadId: z.number().int().optional(),
  minSeverity: severity.default("info"),
  /** Appended to critical messages, e.g. "@alice @bob". */
  mention: z.string().optional(),
});

export const configSchema = z.object({
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  stateFile: z.string().default("./state/state.json"),
  /** Serves /healthz and /metrics. Omit to disable. Port 0 picks a free port (tests). */
  http: z
    .object({host: z.string().default("0.0.0.0"), port: z.number().int().min(0).max(65_535).default(9464)})
    .optional(),
  token: z
    .object({symbol: z.string().default("SAHARA"), decimals: z.number().int().min(0).max(36).default(18)})
    .default({symbol: "SAHARA", decimals: 18}),
  alerts: z
    .object({
      /** Re-send an open condition after this many seconds; 0 disables reminders for that severity. */
      reminderSec: z
        .object({
          critical: z.number().min(0).default(3600),
          high: z.number().min(0).default(4 * 3600),
          warning: z.number().min(0).default(12 * 3600),
          info: z.number().min(0).default(0),
        })
        .default({critical: 3600, high: 4 * 3600, warning: 12 * 3600, info: 0}),
      /** Daily status summary at this UTC time ("HH:MM"). Omit to disable. */
      dailySummaryUtc: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .optional(),
      /**
       * Dead-man's switch: GET every 60 s (the first 60 s after the start) while every chain has caught up since the
       * start and is not stale (`staleAfterSec`), reconciliation is not stale (`reconciliation.staleAfterSec`), and no
       * alert sink is dropping alerts (a failed delivery not followed by a delivery at that severity or above). Never
       * in a dry run.
       */
      heartbeatUrl: z.string().url().optional(),
    })
    .default({reminderSec: {critical: 3600, high: 4 * 3600, warning: 12 * 3600, info: 0}}),
  telegram: z
    .object({
      botToken: z.string().min(1),
      apiUrl: z.string().url().default("https://api.telegram.org"),
      routes: z.array(telegramRoute).min(1),
    })
    .optional(),
  reconciliation: z
    .object({
      enabled: z.boolean().default(true),
      /** R − I must stay at or above this many whole tokens (10 billion: one chain's supply). */
      requiredBacking: amount.default("10000000000"),
      /** Runs this often while every chain has caught up since the start and none is stale (`staleAfterSec`). */
      intervalSec: z.number().positive().default(300),
      /**
       * Reconciliation is stale (`health.reconcile-stale`, high; critical after 3×; /healthz 503; no heartbeat) once
       * its runs have been blocked for longer than this: they threw, or could not read a chain's balances or CCIP
       * messages (not: CCIP tracking disabled, or skipped blocks still being replayed). A restart keeps the age.
       * Default 3 × intervalSec; at least 2 × intervalSec. One blocked run followed by a good one is blocked from the
       * start of the first to the end of the second: intervalSec plus both runs' durations, which RPC timeouts can
       * stretch to minutes ((rpcRetryCount + 1) × rpcTimeoutMs per hanging request and RPC URL). It pages only when
       * that exceeds this limit: the default leaves both runs 2 × intervalSec, the minimum only intervalSec.
       */
      staleAfterSec: z.number().positive().optional(),
      acknowledged: z.array(acknowledgement).default([]),
    })
    .refine((entry) => entry.staleAfterSec === undefined || entry.staleAfterSec >= 2 * entry.intervalSec, {
      message:
        "must be at least 2 × intervalSec (one blocked run followed by a good one is blocked for intervalSec plus " +
        "both runs' durations, and pages when that exceeds staleAfterSec)",
      path: ["staleAfterSec"],
    })
    .default({enabled: true, requiredBacking: "10000000000", intervalSec: 300, acknowledged: []}),
  chains: z
    .record(z.string().regex(/^[a-z0-9_-]+$/, "chain names: lowercase letters, digits, - and _"), chainSchema)
    .refine((chains) => Object.keys(chains).length > 0, {message: "at least one chain is required"}),
});

export type Config = z.infer<typeof configSchema>;
export type ChainConfig = z.infer<typeof chainSchema>;
export type TelegramRoute = z.infer<typeof telegramRoute>;
export type Acknowledgement = z.infer<typeof acknowledgement>;

/** Replaces ${NAME} and ${NAME:-default} in every string of a parsed document. Unset without default throws. */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv, path = "$"): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved !== "") return resolved;
      if (fallback !== undefined) return fallback;
      throw new Error(`${path}: environment variable ${name} is not set`);
    });
  }
  if (Array.isArray(value)) return value.map((item, i) => interpolateEnv(item, env, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateEnv(item, env, `${path}.${key}`)]),
    );
  }
  return value;
}

/**
 * Drops empty strings (object entries and array items), so `${VAR:-}` leaves an optional setting unset, e.g. the
 * Manager address before deployment.
 */
export function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => item !== "").map(pruneEmpty);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== "")
        .map(([key, item]) => [key, pruneEmpty(item)]),
    );
  }
  return value;
}

export function parseConfig(text: string, env: NodeJS.ProcessEnv = process.env): Config {
  const raw = pruneEmpty(interpolateEnv(parseYaml(text), env));
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  ${issue.path.join(".") || "$"}: ${issue.message}`);
    throw new Error(`invalid configuration:\n${issues.join("\n")}`);
  }
  const config = result.data;
  registerSecret(config.telegram?.botToken);
  for (const chain of Object.values(config.chains)) for (const url of chain.rpcUrls) registerSecret(secretPart(url));
  return config;
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  return parseConfig(readFileSync(path, "utf8"), env);
}

/** The part of an RPC URL that may carry an API key (path, query and credentials), for redaction. */
function secretPart(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const tail = `${parsed.pathname}${parsed.search}`;
    if (parsed.password) registerSecret(parsed.password);
    return tail.length > 1 ? tail : undefined;
  } catch {
    return undefined;
  }
}

/** `reconciliation.staleAfterSec`, by default three runs. */
export function reconcileStaleAfterSec(reconciliation: Config["reconciliation"]): number {
  return reconciliation.staleAfterSec ?? 3 * reconciliation.intervalSec;
}

/** Converts whole tokens ("1.5") to base units. */
export function toUnits(value: string, decimals: number): bigint {
  return parseUnits(value, decimals);
}

/**
 * Expected-state entries after applying the defaults that hold once a Manager is configured.
 * See the `expected` schema comment.
 */
export function effectiveExpected(chain: ChainConfig): ChainConfig["expected"] {
  if (!chain.contracts.manager) return chain.expected;
  return {
    tokenOwner: "timelock",
    poolOwner: "timelock",
    registryAdmin: "timelock",
    rebalancer: "adapter",
    rateLimitAdmin: "controller",
    ...stripUndefined(chain.expected),
  };
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Resolves an address reference. "adapter" resolves to the adapter registered for `context.pool` (undefined when the
 * pool has none). Returns undefined when the referenced contract is unknown (e.g. no Manager deployed yet).
 */
export function resolveRef(
  ref: AddressRef | undefined,
  addresses: ResolvedAddresses,
  chain: ChainConfig,
  context: {pool?: Address} = {},
): Address | undefined {
  switch (ref) {
    case undefined:
      return undefined;
    case "timelock":
      return addresses.timelock;
    case "manager":
      return addresses.manager;
    case "controller":
      return addresses.controller;
    case "governanceSafe":
      return chain.expected.governanceSafe;
    case "zero":
      return zeroAddress;
    case "adapter": {
      const pool = context.pool?.toLowerCase();
      return addresses.adapters.find((entry) => entry.pool.toLowerCase() === pool)?.adapter;
    }
    default:
      return ref;
  }
}
