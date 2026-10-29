// The monitor as an operator runs it: `node src/cli.ts <command> --config <path>` as a child process of the test, with
// the e2e environment (RPC URL, bot token) merged into its own. The scenarios drive this real entry point, so config
// loading, signal handling, exit codes and the stdout/stderr split are under test, not only the modules. Also reads the
// daemon's state file, whose saved cursor and outbox are the only reliable "everything up to block N was delivered"
// barrier.
import {spawn, type ChildProcess} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {deserializeState} from "../../../src/store.ts";
import type {E2EConfig} from "./config.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The monitor package: the CLI's working directory (`src/cli.ts` relative to it). */
export const MONITOR_ROOT = join(here, "..", "..", "..");
/**
 * Long enough for a clean stop: the daemon finishes its cycle and flush first, and the entry point's last-resort
 * `process.exit` fires 10 s after `main` returned.
 */
const EXIT_TIMEOUT_MS = 20_000;
const POLL_MS = 50;

/** One stderr JSON log line. */
export type LogLine = {time: string; level: string; msg: string} & Record<string, unknown>;

export interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface MonitorProcess {
  child: ChildProcess;
  /** Everything written so far. */
  stdout(): string;
  stderr(): string;
  /** The stderr lines that are JSON log entries (Node's own warnings are skipped). */
  logs(): LogLine[];
  /** Resolves with the first log line (already written or later) matching `predicate`; rejects early on exit. */
  waitForLog(predicate: (line: LogLine) => boolean, timeoutMs?: number): Promise<LogLine>;
  /** Resolves when the process has exited. */
  exited: Promise<ExitStatus>;
  /** Sends `signal` and waits for the exit; also reports how long the exit took. SIGKILL after `timeoutMs`. */
  stop(signal?: NodeJS.Signals, timeoutMs?: number): Promise<ExitStatus & {elapsedMs: number}>;
}

/** Spawns `node src/cli.ts <args> --config <config.path>` (e.g. `["run"]`). */
export function startMonitor(config: E2EConfig, args: readonly string[] = ["run"]): MonitorProcess {
  const child = spawn(process.execPath, ["src/cli.ts", ...args, "--config", config.path], {
    cwd: MONITOR_ROOT,
    env: {...process.env, ...config.env},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  let status: ExitStatus | undefined;
  const exited = new Promise<ExitStatus>((resolve) => {
    // "close" (not "exit"): the pipes are drained, so stdout()/stderr() are complete once this resolves.
    child.once("close", (code, signal) => {
      status = {code, signal};
      resolve(status);
    });
    child.once("error", (error) => {
      stderr += `spawn failed: ${error.message}\n`;
      status = {code: null, signal: null};
      resolve(status);
    });
  });
  // A crashed test run must not leave the daemon behind.
  const killOnExit = () => child.kill("SIGKILL");
  process.once("exit", killOnExit);
  void exited.then(() => process.removeListener("exit", killOnExit));

  const logs = () => parseLogs(stderr);
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    logs,
    exited,
    waitForLog: async (predicate, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = logs().find(predicate);
        if (found) return found;
        if (status) {
          throw new Error(`monitor exited (${describeExit(status)}) before the log line; stderr:\n${tail(stderr)}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`no matching log line within ${timeoutMs} ms; stderr:\n${tail(stderr)}`);
        }
        await sleep(POLL_MS);
      }
    },
    stop: async (signal = "SIGTERM", timeoutMs = EXIT_TIMEOUT_MS) => {
      const startedAt = Date.now();
      if (!status) child.kill(signal);
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      const result = await exited;
      clearTimeout(timer);
      return {...result, elapsedMs: Date.now() - startedAt};
    },
  };
}

export interface CliResult extends ExitStatus {
  stdout: string;
  stderr: string;
}

/** Runs a one-shot command (`check`, `test-alert`, `scan ...`) to completion. */
export async function runCli(
  config: E2EConfig,
  args: readonly string[],
  timeoutMs = EXIT_TIMEOUT_MS * 3,
): Promise<CliResult> {
  const monitor = startMonitor(config, args);
  const timer = setTimeout(() => monitor.child.kill("SIGKILL"), timeoutMs);
  const result = await monitor.exited;
  clearTimeout(timer);
  return {...result, stdout: monitor.stdout(), stderr: monitor.stderr()};
}

/** The daemon cursor (`daemon:${chain}`.cursor) in the saved state file; undefined before the first save. */
export function savedCursor(stateFile: string, chain: string): bigint | undefined {
  if (!existsSync(stateFile)) return undefined;
  const state = deserializeState(readFileSync(stateFile, "utf8")) as Record<string, {cursor?: bigint} | undefined>;
  return state[`daemon:${chain}`]?.cursor;
}

/** Alert messages in the saved state file not delivered yet (the alert manager's queue and outbox). */
export function savedUndelivered(stateFile: string): number {
  if (!existsSync(stateFile)) return 0;
  const state = deserializeState(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  const alerts = state.alerts as {queue?: unknown[]; outbox?: unknown[]} | undefined;
  return (alerts?.queue?.length ?? 0) + (alerts?.outbox?.length ?? 0);
}

/** The saved per-rule state reads (`daemon:${chain}`.reads): unix ms of the last success and of the first failure. */
export function savedReads(
  stateFile: string,
  chain: string,
): Record<string, {okAt?: number; failingSince?: number}> | undefined {
  if (!existsSync(stateFile)) return undefined;
  const state = deserializeState(readFileSync(stateFile, "utf8")) as Record<
    string,
    {reads?: Record<string, {okAt?: number; failingSince?: number}>} | undefined
  >;
  return state[`daemon:${chain}`]?.reads;
}

/**
 * Waits until the saved cursor reaches `block` and the saved outbox is empty. The daemon moves the alerts of a chunk to
 * the outbox in the commit that saves its cursor, and saves again after each delivery, so from then on every alert for
 * blocks up to `block` has been delivered: a barrier for "no such alert" assertions. With `delivered: false` only
 * the cursor counts (alerts may still wait in the outbox, e.g. during a Telegram outage).
 */
export async function waitForSavedCursor(
  stateFile: string,
  chain: string,
  block: bigint,
  timeoutMs = 90_000,
  options: {delivered?: boolean} = {},
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let cursor: bigint | undefined;
    let undelivered = 0;
    try {
      cursor = savedCursor(stateFile, chain);
      if (options.delivered !== false) undelivered = savedUndelivered(stateFile);
    } catch {
      // Never a torn read (the store renames a temp file into place), but stay robust to a concurrent first write.
    }
    if (cursor !== undefined && cursor >= block && undelivered === 0) return cursor;
    if (Date.now() > deadline) {
      throw new Error(
        `saved cursor of ${chain} is ${cursor ?? "unset"} (${undelivered} alerts undelivered) after ${timeoutMs} ms, ` +
          `waiting for ${block}`,
      );
    }
    await sleep(POLL_MS * 2);
  }
}

function parseLogs(stderr: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const text of stderr.split("\n")) {
    if (!text.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (value !== null && typeof value === "object" && typeof (value as LogLine).msg === "string") {
        lines.push(value as LogLine);
      }
    } catch {
      // A partial last line; complete on the next read.
    }
  }
  return lines;
}

function describeExit(status: ExitStatus): string {
  return status.signal ? `signal ${status.signal}` : `code ${status.code}`;
}

function tail(text: string): string {
  return text.slice(-4000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
