// Command line: `node src/cli.ts <command> [--config <path>]`. Logs are JSON lines on stderr; human output (reports,
// console alerts) goes to stdout. Exit codes: 0 ok, 1 alert-worthy result (check, test-alert), 2 usage, config or RPC
// error. Read-only like the daemon: no command signs or sends a transaction.
import {realpathSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {parseArgs} from "node:util";

import type {Address, PublicClient} from "viem";

import {ConsoleSink, renderConsoleText} from "./alerts/console.ts";
import {AlertManager} from "./alerts/manager.ts";
import {TelegramSink, type FetchLike} from "./alerts/telegram.ts";
import {resolveAddresses} from "./chain/addresses.ts";
import {confirmedHead, createChainClient, createChainContext} from "./chain/client.ts";
import {loadConfig, type ChainConfig, type Config} from "./config.ts";
import {Daemon, errorText, scanRange, unresolvedAddresses} from "./daemon.ts";
import {createLogger, type Logger} from "./log.ts";
import {eventRules, stateRules} from "./rules/index.ts";
import {formatReconcileReport, reconcile} from "./rules/reconcile.ts";
import {createStore} from "./store.ts";
import {SEVERITY_RANK, type Alert, type Alerter, type ChainContext, type ResolvedAddresses} from "./types.ts";

export const EXIT_OK = 0;
export const EXIT_ALERT = 1;
export const EXIT_ERROR = 2;

/** `scan` gives the console this long to print the alerts it found once the scan is done. */
export const SCAN_DELIVERY_MS = 10_000;

export const USAGE = `Usage: node src/cli.ts <command> [--config <path>]

Commands:
  run [--dry-run]       Start the monitor. --dry-run: alerts to stdout only, no heartbeat, state kept in memory.
  check                 One-shot read-only report: addresses, state snapshots, violated conditions, reconciliation.
                        Exit 0 = no critical/high condition, 1 = at least one, 2 = config error or a failed
                        head/address/reconciliation read (failed state reads show as <rule>.read-failed warnings).
  test-alert            Send an info test message to every Telegram route. Exit 1 if any route failed.
  scan --chain <name> --from <block> --to <block>
                        Replay every event rule over a block range; alerts are printed, nothing is sent or saved.

Options:
  --config <path>       Configuration file (default ./config.yaml).
  -h, --help            Show this help.
`;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type Command =
  | {command: "help"}
  | {command: "run"; config: string; dryRun: boolean}
  | {command: "check"; config: string}
  | {command: "test-alert"; config: string}
  | {command: "scan"; config: string; chain: string; from: bigint; to: bigint};

const COMMANDS = ["run", "check", "test-alert", "scan"] as const;

/** Parses argv (without node and the script). Throws UsageError on anything unexpected. */
export function parseCli(argv: readonly string[]): Command {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const {values, positionals} = parsed;
  if (values.help) return {command: "help"};
  const [name, ...rest] = positionals;
  if (name === undefined) throw new UsageError("missing command");
  if (!(COMMANDS as readonly string[]).includes(name)) throw new UsageError(`unknown command "${name}"`);
  if (rest.length) throw new UsageError(`unexpected argument "${rest[0]}"`);
  const config = values.config ?? "./config.yaml";

  const only = (allowed: string[]) => {
    for (const option of ["dry-run", "chain", "from", "to"] as const) {
      if (values[option] !== undefined && !allowed.includes(option)) {
        throw new UsageError(`--${option} is not an option of "${name}"`);
      }
    }
  };
  switch (name) {
    case "run":
      only(["dry-run"]);
      return {command: "run", config, dryRun: values["dry-run"] ?? false};
    case "check":
      only([]);
      return {command: "check", config};
    case "test-alert":
      only([]);
      return {command: "test-alert", config};
    default: {
      only(["chain", "from", "to"]);
      if (!values.chain) throw new UsageError("scan needs --chain <name>");
      const from = blockArg("from", values.from);
      const to = blockArg("to", values.to);
      if (from > to) throw new UsageError(`--from ${from} is after --to ${to}`);
      return {command: "scan", config, chain: values.chain, from, to};
    }
  }
}

function parseCliArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      config: {type: "string"},
      "dry-run": {type: "boolean"},
      chain: {type: "string"},
      from: {type: "string"},
      to: {type: "string"},
      help: {type: "boolean", short: "h"},
    },
  });
}

function blockArg(name: string, value: string | undefined): bigint {
  if (value === undefined) throw new UsageError(`scan needs --${name} <block>`);
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be a block number, got "${value}"`);
  return BigInt(value);
}

export interface CliDeps {
  /** Human output. Default: process.stdout. */
  out?: (text: string) => void;
  /** Usage errors. Default: process.stderr. */
  err?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Default: JSON lines on stderr at the configured level. */
  log?: Logger;
  createClient?: (name: string, chain: ChainConfig) => PublicClient;
  fetch?: FetchLike;
  now?: () => number;
  /** `run`: resolves with the signal name when the daemon should stop. Default: the first SIGINT or SIGTERM. */
  waitForStop?: () => Promise<string>;
}

function defaultClient(name: string, chain: ChainConfig): PublicClient {
  return createChainClient(chain, {
    name,
    timeoutMs: chain.rpcTimeoutMs,
    receiptsTimeoutMs: chain.rpcReceiptsTimeoutMs,
    retryCount: chain.rpcRetryCount,
  });
}

/** Runs a command and returns its exit code. */
export async function main(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => void process.stdout.write(text));
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  let command: Command;
  try {
    command = parseCli(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`error: ${error.message}\n\n${USAGE}`);
    return EXIT_ERROR;
  }
  if (command.command === "help") {
    out(USAGE);
    return EXIT_OK;
  }

  let config: Config;
  try {
    config = loadConfig(command.config, deps.env ?? process.env);
  } catch (error) {
    (deps.log ?? createLogger("info")).error("cannot load the configuration", {
      path: command.config,
      error: errorText(error),
    });
    return EXIT_ERROR;
  }
  const io: CommandIo = {
    out,
    log: deps.log ?? createLogger(config.logLevel),
    createClient: deps.createClient ?? defaultClient,
    fetch: deps.fetch,
    now: deps.now ?? Date.now,
  };
  switch (command.command) {
    case "run":
      return runCommand(config, {dryRun: command.dryRun}, io, deps.waitForStop ?? waitForSignal);
    case "check":
      return checkCommand(config, io);
    case "test-alert":
      return testAlertCommand(config, io);
    case "scan":
      return scanCommand(config, command, io);
  }
}

export interface CommandIo {
  out: (text: string) => void;
  log: Logger;
  createClient: (name: string, chain: ChainConfig) => PublicClient;
  fetch?: FetchLike;
  now: () => number;
}

// ---------------------------------------------------------------------------------------------------------------
// run

/** Starts the daemon and stops it cleanly (finish the cycle, flush, save, close the server) on SIGINT/SIGTERM. */
export async function runCommand(
  config: Config,
  options: {dryRun: boolean},
  io: CommandIo,
  waitForStop: () => Promise<string>,
): Promise<number> {
  const daemon = new Daemon({
    config,
    log: io.log,
    dryRun: options.dryRun,
    createClient: io.createClient,
    fetch: io.fetch,
    now: io.now,
    out: io.out,
  });
  const stopRequested = waitForStop();
  try {
    await daemon.start();
  } catch (error) {
    io.log.error("cannot start the monitor", {error: errorText(error)});
    await daemon.stop();
    return EXIT_ERROR;
  }
  const signal = await stopRequested;
  io.log.info("stopping", {signal});
  await daemon.stop();
  return EXIT_OK;
}

function waitForSignal(): Promise<string> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals) => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      // A second signal while the cycle finishes forces the exit.
      process.once("SIGINT", () => process.exit(130));
      process.once("SIGTERM", () => process.exit(143));
      resolve(signal);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// check

/** Collects nothing and delivers nothing: `check` reads conditions from the rule results and the report. */
const silentAlerter: Alerter = {emit: () => {}, sync: () => {}, resolve: () => {}};

function addressLines(addresses: ResolvedAddresses, label: (address: Address) => string): string[] {
  const named = (address: Address) => {
    const text = label(address);
    return text.toLowerCase() === address.toLowerCase() ? address : `${address} (${text})`;
  };
  const optional = (address: Address | undefined) => (address ? named(address) : "not configured");
  const list = (items: readonly Address[]) => (items.length ? items.map(named).join(", ") : "none");
  const enabled = (value: boolean) => (value ? "enabled" : "disabled");
  return [
    `  Token: ${named(addresses.token)}`,
    `  Registry: ${named(addresses.registry)}`,
    `  Registry pool: ${named(addresses.registryPool)}`,
    `  Router: ${optional(addresses.router)}`,
    `  Manager: ${optional(addresses.manager)}`,
    `  Timelock: ${optional(addresses.timelock)}`,
    `  GuardianController: ${optional(addresses.controller)}`,
    `  Guardian: ${optional(addresses.guardian)}`,
    ...addresses.adapters.map(
      (entry) =>
        `  Adapter #${entry.id}: ${named(entry.adapter)} -> pool ${named(entry.pool)}, ` +
        `funding ${enabled(entry.fundingEnabled)}, recall ${enabled(entry.recallEnabled)}`,
    ),
    `  Adapter history: ${list(addresses.adapterHistory)}`,
    `  Watched pools: ${list(addresses.pools)}`,
    `  Legacy wallets: ${list(addresses.legacyWallets)}`,
  ];
}

/**
 * Resolves every chain and runs every state rule at its confirmed head, then reconciliation over the real state file
 * (opened read-only: never saved). Prints everything and returns 0 (no critical/high condition), 1, or 2 when a head,
 * address or reconciliation read failed (a failed state read is a `<rule>.read-failed` warning condition instead).
 */
export async function checkCommand(config: Config, io: CommandIo): Promise<number> {
  const {out, log} = io;
  // The rules read (and update in memory) their stored state, e.g. the pending Timelock operations; never saved.
  const store = createStore(config.stateFile);
  const conditions: Alert[] = [];
  const contexts: ChainContext[] = [];
  const failed: string[] = [];

  for (const [name, chain] of Object.entries(config.chains)) {
    const ctx = createChainContext({
      name,
      chain,
      global: config,
      client: io.createClient(name, chain),
      alerter: silentAlerter,
      store,
      log: log.child({chain: name}),
      addresses: unresolvedAddresses(chain),
    });
    let head: bigint;
    try {
      head = await confirmedHead(ctx.client, chain.confirmations);
      ctx.addresses = await resolveAddresses(ctx.client, chain, head, {log: ctx.log});
    } catch (error) {
      failed.push(name);
      out(`== ${name}: RPC error ==\n  ${errorText(error)}\n\n`);
      continue;
    }
    contexts.push(ctx);
    out(`== ${name} at confirmed block ${head} ==\nAddresses:\n${addressLines(ctx.addresses, ctx.label).join("\n")}\n`);
    for (const rule of stateRules) {
      try {
        const result = await rule.check(ctx, head);
        conditions.push(...result.conditions);
        const entries = Object.entries(result.snapshot);
        if (!entries.length) continue;
        out(`[${rule.id}]\n${entries.map(([key, value]) => `  ${key}: ${value}`).join("\n")}\n`);
      } catch (error) {
        failed.push(`${name}/${rule.id}`);
        out(`[${rule.id}] failed: ${errorText(error)}\n`);
      }
    }
    out("\n");
  }

  if (!config.reconciliation.enabled) {
    out("== Reconciliation: disabled ==\n\n");
  } else if (contexts.length < Object.keys(config.chains).length) {
    out(`== Reconciliation: skipped (${failed.join(", ")} unavailable) ==\n\n`);
  } else {
    try {
      const report = await reconcile(contexts, silentAlerter, config, {now: io.now});
      conditions.push(...report.conditions);
      out(`== Reconciliation ==\n${formatReconcileReport(report, config)}\n\n`);
    } catch (error) {
      failed.push("reconciliation");
      out(`== Reconciliation failed ==\n  ${errorText(error)}\n\n`);
    }
  }

  conditions.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  out(`== Violated conditions: ${conditions.length} ==\n`);
  for (const alert of conditions) out(`${renderConsoleText({alert, status: "firing"})}\n\n`);
  const urgent = conditions.filter((alert) => SEVERITY_RANK[alert.severity] >= SEVERITY_RANK.high).length;
  if (failed.length) {
    out(`Result: incomplete (${failed.join(", ")} failed) – exit ${EXIT_ERROR}\n`);
    return EXIT_ERROR;
  }
  if (urgent) {
    out(`Result: ${urgent} critical/high condition${urgent === 1 ? "" : "s"} – exit ${EXIT_ALERT}\n`);
    return EXIT_ALERT;
  }
  out(`Result: no critical/high condition – exit ${EXIT_OK}\n`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------------------------------------------
// test-alert

export async function testAlertCommand(config: Config, io: CommandIo): Promise<number> {
  const {out} = io;
  if (!config.telegram) {
    out("No telegram section is configured: there is nothing to test.\n");
    return EXIT_ALERT;
  }
  const sink = new TelegramSink({
    botToken: config.telegram.botToken,
    apiUrl: config.telegram.apiUrl,
    routes: config.telegram.routes,
    log: io.log.child({sink: "telegram"}),
    fetch: io.fetch,
    now: io.now,
  });
  out(
    `Sending a test message to ${config.telegram.routes.length} route(s). It is info severity, so it arrives ` +
      "silently (disable_notification: no sound or notification); that is expected.\n",
  );
  const results = await sink.sendTest();
  for (const result of results) {
    const thread = result.threadId !== undefined ? ` thread ${result.threadId}` : "";
    out(`chat ${result.chatId}${thread}: ${result.ok ? "ok" : `error: ${result.error ?? "unknown"}`}\n`);
  }
  return results.every((result) => result.ok) ? EXIT_OK : EXIT_ALERT;
}

// ---------------------------------------------------------------------------------------------------------------
// scan

/**
 * Replays every event rule over [from, to] with the addresses resolved at `to`. Alerts go to stdout (ConsoleSink, in
 * the background while the scan goes on, then a bounded wait for the rest); the store is in memory, so nothing is sent
 * to Telegram and the state file is untouched.
 */
export async function scanCommand(
  config: Config,
  args: {chain: string; from: bigint; to: bigint},
  io: CommandIo,
): Promise<number> {
  const {out, log} = io;
  const chain = config.chains[args.chain];
  if (!chain) {
    out(`Unknown chain "${args.chain}"; configured: ${Object.keys(config.chains).join(", ")}\n`);
    return EXIT_ERROR;
  }
  const store = createStore();
  const alerter = new AlertManager({
    sinks: [new ConsoleSink({write: out})],
    store,
    reminderSec: config.alerts.reminderSec,
    log: log.child({component: "alerts"}),
    now: io.now,
  });
  const ctx = createChainContext({
    name: args.chain,
    // Every transfer on its own: a merged one would wait for a summary that a scan never reaches.
    chain: {...chain, limits: {...chain.limits, inflowMergeSec: 0}},
    global: config,
    client: io.createClient(args.chain, chain),
    alerter,
    store,
    log: log.child({chain: args.chain}),
    addresses: unresolvedAddresses(chain),
  });
  // Prints what is left of the alerts found (bounded), and says how many it could not.
  const finish = async () => {
    alerter.flush();
    const left = await alerter.stop(SCAN_DELIVERY_MS);
    if (left) out(`${left} alert message(s) could not be printed.\n`);
  };
  let chunks = 0;
  try {
    ctx.addresses = await resolveAddresses(ctx.client, chain, args.to, {log: ctx.log});
    out(`Scanning ${args.chain} blocks ${args.from}-${args.to} (addresses resolved at block ${args.to})\n\n`);
    await scanRange(ctx, eventRules, {from: args.from, to: args.to}, {
      onChunk: () => {
        chunks++;
        alerter.flush();
      },
    });
  } catch (error) {
    await finish();
    out(`Scan failed: ${errorText(error)}\n`);
    return EXIT_ERROR;
  }
  await finish();
  out(`Done: ${chunks} chunk(s) of up to ${chain.maxLogRange} blocks.\n`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------------------------------------------

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // Everything is closed by now; an idle keep-alive socket must not hold the process open.
      setTimeout(() => process.exit(code), 10_000).unref();
    },
    (error: unknown) => {
      process.stderr.write(`fatal: ${errorText(error)}\n`);
      process.exitCode = EXIT_ERROR;
    },
  );
}
