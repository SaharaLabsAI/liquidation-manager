// Minimal structured logger: one JSON object per line on stderr, so stdout stays free for CLI output.
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {debug: 0, info: 1, warn: 2, error: 3};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Strings that must never reach a log line (e.g. the Telegram bot token, RPC URLs with API keys). */
const secrets = new Set<string>();

export function registerSecret(secret: string | undefined): void {
  if (secret && secret.length >= 8) secrets.add(secret);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("<redacted>");
  return out;
}

function serialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return {name: value.name, message: value.message};
  return value;
}

export function createLogger(level: LogLevel = "info", base: Record<string, unknown> = {}): Logger {
  const write = (lvl: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) return;
    const entry: Record<string, unknown> = {time: new Date().toISOString(), level: lvl, msg: message, ...base};
    for (const [k, v] of Object.entries(fields ?? {})) entry[k] = serialize(v);
    process.stderr.write(redact(JSON.stringify(entry, (_k, v) => serialize(v))) + "\n");
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (fields) => createLogger(level, {...base, ...fields}),
  };
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
