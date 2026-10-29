// Plain-text alert output: used by `check` and by the daemon when Telegram is not configured.
import {formatDuration} from "../format.ts";
import {routeSeverity, SEVERITY_RANK} from "../types.ts";
import type {AlertSink, OutgoingMessage, Severity} from "../types.ts";

export interface ConsoleSinkOptions {
  /** Default: process.stdout. */
  write?: (text: string) => void;
  /** Messages below this severity are not printed. Default: info (everything). */
  minSeverity?: Severity;
}

export class ConsoleSink implements AlertSink {
  readonly name = "console";
  readonly targets = ["stdout"];
  readonly #write: (text: string) => void;
  readonly #minSeverity: Severity;

  constructor(options: ConsoleSinkOptions = {}) {
    this.#write = options.write ?? ((text) => void process.stdout.write(text));
    this.#minSeverity = options.minSeverity ?? "info";
  }

  admits(message: OutgoingMessage): boolean {
    return SEVERITY_RANK[routeSeverity(message)] >= SEVERITY_RANK[this.#minSeverity];
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (this.admits(message)) this.#write(`${renderConsoleText(message)}\n\n`);
  }
}

/** One block of plain text per message: header line, then indented fields, note, links and the rule/key. */
export function renderConsoleText(message: OutgoingMessage): string {
  const {alert, status} = message;
  const severity = alert.severity.toUpperCase();
  const openFor = message.openForSec !== undefined ? formatDuration(message.openForSec) : undefined;
  let tag: string;
  let suffix = "";
  if (status === "resolved") {
    tag = "RESOLVED";
    suffix = ` (was ${severity}${openFor ? `, open for ${openFor}` : ""})`;
  } else if (status === "reminder") {
    tag = `REMINDER ${severity}`;
    suffix = openFor ? ` (open for ${openFor})` : "";
  } else tag = severity;

  const lines = [`[${tag}]${alert.chain ? ` ${alert.chain} ·` : ""} ${alert.title}${suffix}`];
  for (const field of alert.fields ?? []) {
    const [first = "", ...rest] = field.value.split("\n");
    lines.push(`  ${field.label}: ${first}`);
    for (const line of rest) lines.push(`    ${line}`);
  }
  if (alert.note && status !== "resolved") for (const line of alert.note.split("\n")) lines.push(`  ${line}`);
  for (const link of alert.links ?? []) lines.push(`  ${link.label}: ${link.url}`);
  lines.push(`  (rule ${alert.rule}, key ${alert.key})`);
  return lines.join("\n");
}
