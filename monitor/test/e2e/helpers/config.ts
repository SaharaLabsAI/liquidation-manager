// Monitor configuration for an e2e deployment: one chain named "local" (the anvil node), Telegram pointed at the mock,
// /healthz and /metrics on a free port, the state file in a temp directory. `expected` mirrors the deployment, so a
// healthy deployment raises only the conditions the mocks cannot avoid (KNOWN_MOCK_CONDITIONS).
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {formatUnits} from "viem";
import {stringify} from "yaml";
import type {z} from "zod";

import type {configSchema} from "../../../src/config.ts";
import type {Severity} from "../../../src/types.ts";
import {freePort} from "./anvil.ts";
import type {E2EDeployment, RateLimit} from "./deploy.ts";

/** The config's chain name. */
export const CHAIN = "local";
/** CCIP selector of the local chain (made up; the pool's counterpart is `REMOTE_CHAIN_SELECTOR`). */
export const LOCAL_CHAIN_SELECTOR = 1_000_000_000_000_000_001n;
/** Telegram chat of the single route. */
export const CHAT_ID = "-1001234567890";

/** The YAML document before validation (what `edit` receives). */
export type ConfigDocument = z.input<typeof configSchema>;
type ChainDocument = ConfigDocument["chains"][string];

/**
 * Conditions every state-rule cycle raises on the healthy anvil deployment, because of the mocks (measured by running
 * every state rule against `deploySystem`; the smoke test keeps this list exact). Scenarios should ignore exactly these
 * (match on `key`). They are warnings while the reads have failed for at most `staleAfterSec` (900 s here, far longer
 * than a suite run, which keeps its first failure across the restart); after that the daemon escalates them and
 * counts the chain stale. The daemon suite checks that the failures are tracked (/healthz `failingReads`, the state
 * file) without reaching that limit.
 * - `state-pool.read-failed`: MockLockReleaseTokenPool has no `getCurrentOutboundRateLimiterState` /
 *   `getCurrentInboundRateLimiterState`, so the pool's rate limits (and a lockdown) cannot be read.
 * - `state-router.read-failed`: the Router is an address without code, so `getOffRamps()` / `getOnRamp(remote)` fail.
 *
 * Side effect: because a pool read fails every cycle, state-common.ts carries forward every open state-pool condition
 * keyed by the pool address (e.g. `local:state-pool:<pool>:rebalancer`). On anvil such a condition opens but never
 * resolves while the state file persists, even after the pool is restored.
 */
export const KNOWN_MOCK_CONDITIONS: ReadonlyArray<{key: string; rule: string; severity: Severity; reason: string}> = [
  {
    key: `${CHAIN}:state-pool:read-failed`,
    rule: "state-pool.read-failed",
    severity: "warning",
    reason: "the mock pool lacks getCurrent{Outbound,Inbound}RateLimiterState",
  },
  {
    key: `${CHAIN}:state-router:read-failed`,
    rule: "state-router.read-failed",
    severity: "warning",
    reason: "the Router stand-in has no code (getOffRamps/getOnRamp)",
  },
];

export function isKnownMockCondition(key: string): boolean {
  return KNOWN_MOCK_CONDITIONS.some((condition) => condition.key === key);
}

export interface E2EConfigOptions {
  deployment: E2EDeployment;
  /** Telegram Bot API stand-in (`startTelegramMock`); omit for a config without a telegram section. */
  telegram?: {url: string; botToken: string};
  /** Port for /healthz and /metrics; default: a free port; false: no http section. */
  httpPort?: number | false;
  /** Directory for config.yaml and the state file; default: a new temp directory. */
  dir?: string;
  /** `chains.local.startBlock` (first-start backfill); default: unset. */
  startBlock?: bigint;
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Last-minute changes to the document before it is written (e.g. `alerts.dailySummaryUtc`). */
  edit?: (document: ConfigDocument) => void;
}

export interface E2EConfig {
  /** config.yaml path (`--config`). */
  path: string;
  dir: string;
  stateFile: string;
  /** undefined when `httpPort: false`. */
  httpPort: number | undefined;
  /**
   * Only the variables the document references (`${E2E_RPC_URL}`, `${E2E_TELEGRAM_BOT_TOKEN}`): pass as is to
   * parseConfig; merge into the environment (`{...process.env, ...env}`) when spawning the CLI.
   */
  env: Record<string, string>;
  /** The written document (after `edit`). */
  document: ConfigDocument;
}

/** Writes config.yaml for the deployment. Secrets go through ${ENV} interpolation, as in production. */
export async function writeE2EConfig(options: E2EConfigOptions): Promise<E2EConfig> {
  const {deployment} = options;
  const {addresses, accounts, params} = deployment;
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "sahara-monitor-e2e-"));
  const stateFile = join(dir, "state", "state.json");
  const httpPort = options.httpPort === false ? undefined : (options.httpPort ?? (await freePort()));
  const env: Record<string, string> = {E2E_RPC_URL: deployment.anvil.rpcUrl};

  const chain: ChainDocument = {
    chainId: deployment.anvil.chainId,
    chainSelector: LOCAL_CHAIN_SELECTOR.toString(),
    rpcUrls: ["${E2E_RPC_URL}"],
    // A stopped node (stale-telemetry scenarios) should fail a cycle quickly.
    rpcTimeoutMs: 5_000,
    rpcRetryCount: 0,
    explorerUrl: "http://explorer.invalid",
    confirmations: 0,
    pollIntervalSec: 1,
    maxLogRange: 100,
    // anvil mines only on transactions, so its head stands still between scenarios, and a head that does not advance
    // for staleAfterSec is stale telemetry: longer than any idle stretch of a suite. State reads failing for longer are
    // stale too, and the mocks fail two rules' reads from the start (KNOWN_MOCK_CONDITIONS): longer than a whole suite.
    staleAfterSec: 900,
    contracts: {
      token: addresses.token,
      registry: addresses.registry,
      router: addresses.router,
      pool: addresses.pool,
      manager: addresses.manager,
      timelock: addresses.timelock,
      controller: addresses.controller,
    },
    reserves: {legacyWallets: [], extraPools: [], extraEndpoints: []},
    expected: {
      governanceSafe: accounts.governance.address,
      guardian: accounts.guardian.address,
      fundingOperators: [accounts.fundingOperator.address],
      recallOperators: [accounts.recallOperator.address],
      timelockDelaySec: Number(params.delaySec),
      timelockRoles: {
        admins: ["timelock"],
        proposers: ["governanceSafe"],
        executors: ["governanceSafe"],
        cancellers: ["governanceSafe", "controller"],
      },
      tokenPaused: false,
      rateLimits: {outbound: wholeTokens(params.rateLimits.outbound), inbound: wholeTokens(params.rateLimits.inbound)},
    },
    limits: {budgetLowPct: 20, largeTransfer: "1000000", outflowWindowSec: 3600, outflowWindowAmount: "10000000"},
    ccip: {enabled: false},
  };
  if (options.startBlock !== undefined) chain.startBlock = Number(options.startBlock);

  const document: ConfigDocument = {
    logLevel: options.logLevel ?? "info",
    stateFile,
    token: {symbol: "SAHARA", decimals: 18},
    alerts: {reminderSec: {critical: 3600, high: 14400, warning: 43200, info: 0}},
    reconciliation: {enabled: false},
    chains: {[CHAIN]: chain},
  };
  if (httpPort !== undefined) document.http = {host: "127.0.0.1", port: httpPort};
  if (options.telegram) {
    env.E2E_TELEGRAM_BOT_TOKEN = options.telegram.botToken;
    document.telegram = {
      botToken: "${E2E_TELEGRAM_BOT_TOKEN}",
      apiUrl: options.telegram.url,
      routes: [{chatId: CHAT_ID, minSeverity: "info"}],
    };
  }
  options.edit?.(document);

  const path = join(dir, "config.yaml");
  writeFileSync(path, stringify(document));
  return {path, dir, stateFile, httpPort, env, document};
}

/** Pool rate limit in the config's whole-token form. */
function wholeTokens(limit: RateLimit): {enabled: boolean; capacity: string; rate: string} {
  return {enabled: limit.isEnabled, capacity: formatUnits(limit.capacity, 18), rate: formatUnits(limit.rate, 18)};
}
