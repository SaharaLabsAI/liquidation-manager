// Telegram delivery via the Bot API (sendMessage, HTML parse mode). Every alert string is plain text and is escaped
// here. Messages are rendered as self-contained lines (no tag spans two lines), so splitting at the 4096-character
// limit on line boundaries never breaks markup, and the plain-text fallback can resend exactly the failed part.
//
// Each route is a delivery target of its own (see `AlertSink`). A send retries only briefly in the call (a few seconds
// of backoff, a short 429 wait); after that it throws a TelegramError whose `kind` tells the alert manager to keep the
// message and retry later ("transient", "route") or to drop it for that route ("message"). The parts of a long message
// a chat accepted are reported to the alert manager, which keeps the count, so a retry sends only the rest.
import type {TelegramRoute} from "../config.ts";
import {formatDuration, formatTimestamp} from "../format.ts";
import type {Logger} from "../log.ts";
import {redact, registerSecret} from "../log.ts";
import {DeliveryError, routeSeverity, SEVERITY_RANK} from "../types.ts";
import type {AlertSink, DeliveryErrorKind, OutgoingMessage, SendProgress, Severity} from "../types.ts";

/** Telegram's sendMessage text limit. */
export const TELEGRAM_MAX_TEXT = 4096;
/** Longest rendered line; values longer than this are split over several lines. Leaves room under the limit. */
const MAX_LINE = 3800;
/** Telegram allows about 20 messages per minute into one group or channel. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
/** Waits between attempts on 5xx, network errors and unconfirmed replies; then the alert manager retries later. */
const BACKOFF_MS = [1000, 2000];
/** A 429 is waited out in the call only this often and only when this short; else the alert manager waits it out. */
const MAX_RATE_LIMITED_RETRIES = 2;
const MAX_INLINE_RETRY_AFTER_SEC = 5;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Lowercase parts of Bot API 400 descriptions ("Bad Request: ...") that are about the chat or the bot's rights in it,
 * not the message: the route needs a fix, and its messages are kept for when it works. E.g. "chat not found", "message
 * thread not found", "not enough rights to send text messages to the chat", "need administrator rights in the channel
 * chat", "group chat was upgraded to a supergroup chat", TDLib's access checks ("have no write access to the chat",
 * "can't access the chat") and Telegram's own error names, passed through in capitals ("TOPIC_CLOSED",
 * "CHAT_WRITE_FORBIDDEN", "CHAT_SEND_PLAIN_FORBIDDEN"). Names about the message itself ("ENTITY_BOUNDS_INVALID",
 * "ENTITIES_TOO_LONG") are not listed: that message is dropped for the route.
 */
const ROUTE_ERRORS = [
  "chat not found",
  "thread not found",
  "not enough rights",
  "need administrator rights",
  "have no rights",
  "have no write access",
  "can't access the chat",
  "can't access the topic",
  "chat is not accessible",
  "upgraded to a supergroup",
  "bot was kicked",
  "bot is not a member",
  "bot was blocked",
  "chat was deleted",
  "chat was deactivated",
  "chat_id is empty",
  "topic_closed",
  "topic_deleted",
  "chat_write_forbidden",
  // CHAT_SEND_PLAIN_FORBIDDEN and the other CHAT_SEND_*_FORBIDDEN: the chat's permissions forbid the bot to post.
  "chat_send_",
  "chat_restricted",
  "chat_admin_required",
  "channel_private",
  "channel_invalid",
  "chat_id_invalid",
  "peer_id_invalid",
  // The bot's account is limited (e.g. for spam): it cannot post to any group.
  "user_banned_in_channel",
];

const SEVERITY_EMOJI: Record<Severity, string> = {critical: "🚨", high: "🔴", warning: "🟠", info: "🔵"};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TelegramSinkOptions {
  botToken: string;
  /** Bot API base URL, e.g. "https://api.telegram.org". */
  apiUrl: string;
  routes: TelegramRoute[];
  log: Logger;
  /** Default: global fetch. */
  fetch?: FetchLike;
  /** Default: setTimeout. Tests inject a fake that advances `now`. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in unix ms for the per-chat rate limiter. Default: Date.now. */
  now?: () => number;
}

export interface TelegramTestResult {
  chatId: string;
  threadId?: number;
  ok: boolean;
  error?: string;
}

/** Delivery failure. Messages are built from the chat id and Telegram's description only, never the request URL. */
export class TelegramError extends DeliveryError {
  readonly status: number | undefined;
  /** Telegram rejected the HTML ("can't parse entities"). */
  readonly parseError: boolean;

  constructor(
    message: string,
    kind: DeliveryErrorKind,
    options: {status?: number; parseError?: boolean; retryAfterMs?: number} = {},
  ) {
    super(message, kind, options.retryAfterMs);
    this.name = "TelegramError";
    this.status = options.status;
    this.parseError = options.parseError ?? false;
  }
}

/**
 * What a Bot API error reply means (see `DeliveryErrorKind`): 429, 408 and 5xx are transient; 401 (bad token), 403
 * (bot removed or blocked), 404 (bad token or API URL) and a 400 about the chat (`ROUTE_ERRORS`, or a group upgraded
 * to a supergroup: `migrated`) mean the route needs a fix; any other 400 or 4xx rejects the message itself.
 */
export function telegramErrorKind(status: number, description: string, migrated = false): DeliveryErrorKind {
  if (status === 429 || status === 408 || status >= 500) return "transient";
  if (status === 401 || status === 403 || status === 404) return "route";
  const text = description.toLowerCase();
  if (status === 400 && (migrated || ROUTE_ERRORS.some((part) => text.includes(part)))) return "route";
  return "message";
}

export class TelegramSink implements AlertSink {
  readonly name = "telegram";
  /** One per route: the chat id, with "/<thread id>" for a forum topic (see `telegramTargetId`). */
  readonly targets: readonly string[];
  readonly #token: string;
  readonly #endpoint: string;
  readonly #routes: TelegramRoute[];
  readonly #byTarget = new Map<string, TelegramRoute>();
  readonly #log: Logger;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  /** chatId -> send times (unix ms) within the last minute. */
  readonly #windows = new Map<string, number[]>();

  constructor(options: TelegramSinkOptions) {
    registerSecret(options.botToken);
    this.#token = options.botToken;
    this.#endpoint = `${options.apiUrl.replace(/\/+$/, "")}/bot${options.botToken}/sendMessage`;
    this.#routes = options.routes;
    for (const route of this.#routes) {
      const base = telegramTargetId(route);
      let id = base;
      // Two routes to the same chat and thread (a misconfiguration) still get a target each.
      for (let n = 2; this.#byTarget.has(id); n++) id = `${base}#${n}`;
      this.#byTarget.set(id, route);
    }
    this.targets = [...this.#byTarget.keys()];
    this.#log = options.log;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
  }

  /** Whether the route's `minSeverity` admits the message (by its routing severity). */
  admits(message: OutgoingMessage, target: string): boolean {
    const route = this.#byTarget.get(target);
    return route !== undefined && SEVERITY_RANK[routeSeverity(message)] >= SEVERITY_RANK[route.minSeverity];
  }

  /**
   * Sends the message to one route. Throws a TelegramError once the short in-call retries are exhausted. A multi-part
   * message starts after the `progress.sent` parts the chat already accepted, and each part it accepts but the last is
   * reported to `progress.onPart`.
   */
  async send(message: OutgoingMessage, target: string, progress?: SendProgress): Promise<void> {
    const route = this.#byTarget.get(target);
    if (!route) throw new TelegramError(`no Telegram route ${target}`, "message");
    await this.#deliver(route, message, progress?.sent ?? 0, (sent) => progress?.onPart(sent));
  }

  /** Sends a fixed INFO test alert to every route, ignoring `minSeverity` (CLI `test-alert`). Never throws. */
  async sendTest(): Promise<TelegramTestResult[]> {
    const message = testAlertMessage(this.#now());
    return Promise.all(
      this.#routes.map(async (route): Promise<TelegramTestResult> => {
        const id: Pick<TelegramTestResult, "chatId" | "threadId"> = {chatId: route.chatId};
        if (route.threadId !== undefined) id.threadId = route.threadId;
        try {
          await this.#deliver(route, message);
          return {...id, ok: true};
        } catch (error) {
          return {...id, ok: false, error: this.#errorText(error)};
        }
      }),
    );
  }

  /** Sends every part from `from` on; `onPart` is told how many were sent after each part of a multi-part message. */
  async #deliver(
    route: TelegramRoute,
    message: OutgoingMessage,
    from = 0,
    onPart?: (sent: number) => void,
  ): Promise<void> {
    let lines: Line[];
    let html: string[];
    let ranges: Array<[number, number]>;
    try {
      lines = buildLines(message, route);
      html = lines.map((line) => renderLine(line, HTML));
      ranges = chunkRanges(lines, html);
    } catch (error) {
      // Rendering is deterministic: a message that cannot be rendered never can.
      const reason = this.#errorText(error);
      throw new TelegramError(`cannot render the message for ${routeName(route)}: ${reason}`, "message");
    }
    for (let part = from; part < ranges.length; part++) {
      const [start, end] = ranges[part]!;
      try {
        await this.#post(route, message, html.slice(start, end).join("\n"), true);
      } catch (error) {
        if (!(error instanceof TelegramError) || !error.parseError) throw error;
        this.#log.warn("telegram rejected HTML, resending as plain text", {chatId: route.chatId, error: error.message});
        const plain = lines.slice(start, end).map((line) => renderLine(line, PLAIN));
        await this.#post(route, message, plain.join("\n"), false);
      }
      if (ranges.length > 1 && part + 1 < ranges.length) onPart?.(part + 1);
    }
  }

  async #post(route: TelegramRoute, message: OutgoingMessage, text: string, html: boolean): Promise<void> {
    const body: Record<string, unknown> = {chat_id: route.chatId};
    if (route.threadId !== undefined) body.message_thread_id = route.threadId;
    body.text = text;
    if (html) body.parse_mode = "HTML";
    body.link_preview_options = {is_disabled: true};
    body.disable_notification = message.alert.severity === "info";
    const payload = JSON.stringify(body);
    const chat = routeName(route);

    let backoff = 0;
    let rateLimited = 0;
    for (;;) {
      await this.#acquire(route.chatId);
      let response: Response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: payload,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        const reason = this.#errorText(error);
        const delay = BACKOFF_MS[backoff++];
        if (delay === undefined) {
          throw new TelegramError(`sendMessage to ${chat} failed after ${backoff} attempts: ${reason}`, "transient");
        }
        this.#log.debug("telegram request failed, retrying", {chatId: route.chatId, error: reason, retryInMs: delay});
        await this.#sleep(delay);
        continue;
      }

      const result = await readResult(response);
      if (response.ok && result.ok === true) return;
      // A 2xx without `"ok": true` (e.g. a truncated body) confirms nothing: retried like a 5xx. Telegram may have
      // posted it, so the retry can duplicate the message, which beats losing it.
      const unconfirmed = response.ok && result.ok !== false;
      const status = unconfirmed ? response.status : (result.error_code ?? response.status);
      const description = unconfirmed
        ? 'unconfirmed (no "ok": true in the response)'
        : this.#scrub(result.description ?? response.statusText ?? "");

      if (status === 429) {
        const retryAfter = Math.max(1, Number(result.parameters?.retry_after) || 1);
        if (retryAfter > MAX_INLINE_RETRY_AFTER_SEC || ++rateLimited > MAX_RATE_LIMITED_RETRIES) {
          const reason = `rate limited (retry after ${retryAfter}s): ${description}`;
          throw new TelegramError(`sendMessage to ${chat} ${reason}`, "transient", {
            status,
            retryAfterMs: retryAfter * 1000,
          });
        }
        this.#log.debug("telegram rate limited, waiting", {chatId: route.chatId, retryAfterSec: retryAfter});
        await this.#sleep(retryAfter * 1000);
        continue;
      }
      if (unconfirmed || status >= 500 || status === 408) {
        const delay = BACKOFF_MS[backoff++];
        if (delay === undefined) {
          const reason = `failed after ${backoff} attempts: ${status} ${description}`;
          throw new TelegramError(`sendMessage to ${chat} ${reason}`, "transient", {status});
        }
        const fields = {chatId: route.chatId, status, error: description, retryInMs: delay};
        this.#log.debug(`telegram ${unconfirmed ? "response unconfirmed" : "server error"}, retrying`, fields);
        await this.#sleep(delay);
        continue;
      }
      const parseError = html && status === 400 && /can't parse entities/i.test(description);
      // A group upgraded to a supergroup (e.g. by enabling topics) has a new id; every message fails until updated.
      const migrated = result.parameters?.migrate_to_chat_id;
      const hint = migrated !== undefined ? ` (the chat is now ${migrated}: update the route's chatId)` : "";
      const kind = parseError ? "message" : telegramErrorKind(status, description, migrated !== undefined);
      throw new TelegramError(`sendMessage to ${chat} failed: ${status} ${description}${hint}`, kind, {
        status,
        parseError,
      });
    }
  }

  /** Sliding-window limiter per chat. The slot is taken synchronously, so concurrent senders cannot overbook it. */
  async #acquire(chatId: string): Promise<void> {
    for (;;) {
      const now = this.#now();
      const window = (this.#windows.get(chatId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
      this.#windows.set(chatId, window);
      if (window.length < RATE_LIMIT) {
        window.push(now);
        return;
      }
      await this.#sleep(Math.max(1, (window[0] ?? now) + RATE_WINDOW_MS - now));
    }
  }

  /** Error text with the bot token removed (fetch implementations may echo the request URL). */
  #errorText(error: unknown): string {
    return this.#scrub(error instanceof Error ? error.message : String(error));
  }

  #scrub(text: string): string {
    let out = text;
    for (const secret of [this.#token, encodeURIComponent(this.#token)]) {
      if (secret) out = out.split(secret).join("<redacted>");
    }
    return redact(out);
  }
}

/** The fixed message `sendTest` delivers. */
export function testAlertMessage(nowMs: number): OutgoingMessage {
  return {
    alert: {
      key: `test-alert:${nowMs}`,
      kind: "event",
      severity: "info",
      rule: "test-alert",
      title: "Test alert from the SAHARA liquidity monitor",
      fields: [{label: "Sent at", value: formatTimestamp(Math.floor(nowMs / 1000))}],
      note: "If you can read this, the monitor can post to this chat. No action needed.",
    },
    status: "firing",
  };
}

/** Full HTML text of a message for one route, before splitting at the length limit. */
export function renderTelegramHtml(message: OutgoingMessage, route: Pick<TelegramRoute, "mention"> = {}): string {
  return buildLines(message, route)
    .map((line) => renderLine(line, HTML))
    .join("\n");
}

/** Plain-text variant (the fallback when Telegram rejects the HTML). Line-for-line parallel to the HTML. */
export function renderTelegramPlain(message: OutgoingMessage, route: Pick<TelegramRoute, "mention"> = {}): string {
  return buildLines(message, route)
    .map((line) => renderLine(line, PLAIN))
    .join("\n");
}

/** The HTML texts actually sent for a message (each at most TELEGRAM_MAX_TEXT characters). */
export function renderTelegramChunks(message: OutgoingMessage, route: Pick<TelegramRoute, "mention"> = {}): string[] {
  const lines = buildLines(message, route);
  const html = lines.map((line) => renderLine(line, HTML));
  return chunkRanges(lines, html).map(([start, end]) => html.slice(start, end).join("\n"));
}

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// --- rendering ---------------------------------------------------------------------------------------------------

type Segment =
  | {kind: "text" | "bold" | "italic" | "code"; text: string}
  | {kind: "link"; label: string; url: string};

/** One output line; `[]` is a blank line. */
type Line = Segment[];

interface Markup {
  text(raw: string): string;
  bold(raw: string): string;
  italic(raw: string): string;
  code(raw: string): string;
  link(label: string, url: string): string;
}

const HTML: Markup = {
  text: escapeHtml,
  bold: (raw) => `<b>${escapeHtml(raw)}</b>`,
  italic: (raw) => `<i>${escapeHtml(raw)}</i>`,
  code: (raw) => `<code>${escapeHtml(raw)}</code>`,
  link: (label, url) =>
    /^https?:\/\//i.test(url)
      ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
      : `${escapeHtml(label)}: ${escapeHtml(url)}`,
};

// Never longer than the HTML rendering of the same line, so the HTML chunk ranges also fit the plain fallback.
const PLAIN: Markup = {
  text: (raw) => raw,
  bold: (raw) => raw,
  italic: (raw) => raw,
  code: (raw) => raw,
  link: (label, url) => `${label}: ${url}`,
};

function renderLine(line: Line, markup: Markup): string {
  return line
    .map((segment) =>
      segment.kind === "link" ? markup.link(segment.label, segment.url) : markup[segment.kind](segment.text),
    )
    .join("");
}

/** HTML length of a line (the longer of the two renderings). */
function htmlLength(line: Line): number {
  return renderLine(line, HTML).length;
}

function buildLines(message: OutgoingMessage, route: Pick<TelegramRoute, "mention">): Line[] {
  const {alert, status} = message;
  const severity = alert.severity.toUpperCase();
  const chain: Line = alert.chain ? [{kind: "text", text: ` · ${alert.chain} · `}] : [{kind: "text", text: " · "}];
  let head: Line;
  if (status === "resolved") head = [{kind: "text", text: "✅ "}, {kind: "bold", text: "RESOLVED"}, ...chain];
  else if (status === "reminder") {
    head = [{kind: "text", text: "🔁 "}, {kind: "bold", text: `REMINDER ${severity}`}, ...chain];
  } else head = [{kind: "text", text: `${SEVERITY_EMOJI[alert.severity]} `}, {kind: "bold", text: severity}, ...chain];

  const lines: Line[] = [];
  const titlePieces = splitText(alert.title, MAX_LINE - htmlLength(head) - 10);
  lines.push([...head, {kind: "bold", text: titlePieces[0] ?? ""}]);
  for (const piece of titlePieces.slice(1)) lines.push([{kind: "bold", text: piece}]);

  const openFor = message.openForSec !== undefined ? formatDuration(message.openForSec) : undefined;
  if (status === "reminder") lines.push([{kind: "italic", text: `Still open${openFor ? ` after ${openFor}` : ""}`}]);
  if (status === "resolved") {
    lines.push([{kind: "italic", text: `Was ${severity}${openFor ? `, open for ${openFor}` : ""}`}]);
  }

  if (alert.fields?.length) {
    lines.push([]);
    for (const field of alert.fields) lines.push(...fieldLines(field.label, field.value, field.code === true));
  }
  // The runbook note says what to do; a resolved condition needs nothing done.
  if (alert.note && status !== "resolved") {
    lines.push([]);
    for (const text of alert.note.split("\n")) {
      for (const piece of splitText(text, MAX_LINE)) lines.push(piece ? [{kind: "text", text: piece}] : []);
    }
  }
  if (alert.links?.length) {
    lines.push([]);
    let current: Line = [];
    for (const link of alert.links) {
      const segment: Segment = {kind: "link", label: truncate(link.label, 200), url: truncate(link.url, 2000)};
      const candidate: Line = current.length ? [...current, {kind: "text", text: " · "}, segment] : [segment];
      if (current.length && htmlLength(candidate) > MAX_LINE) {
        lines.push(current);
        current = [segment];
      } else current = candidate;
    }
    lines.push(current);
  }
  lines.push([]);
  lines.push([{kind: "italic", text: `rule ${alert.rule}`}]);
  if (route.mention && alert.severity === "critical" && status !== "resolved") {
    for (const piece of splitText(route.mention, MAX_LINE)) lines.push([{kind: "text", text: piece}]);
  }
  return lines;
}

/** `label: value` lines; multi-line or overlong values continue on following lines, each piece self-contained. */
function fieldLines(label: string, value: string, code: boolean): Line[] {
  const prefix: Segment = {kind: "text", text: `${truncate(label, 200)}: `};
  const kind = code ? "code" : "text";
  const budget = MAX_LINE - htmlLength([prefix]) - 20;
  const pieces = value === "" ? ["—"] : value.split("\n").flatMap((text) => splitText(text, budget));
  return pieces.map((piece, i) => (i === 0 ? [prefix, {kind, text: piece}] : [{kind, text: piece}]));
}

/** Splits plain text into pieces whose escaped length is at most `budget` (by code point, never inside an entity). */
function splitText(text: string, budget: number): string[] {
  const limit = Math.max(100, budget);
  if (escapeHtml(text).length <= limit) return [text];
  const pieces: string[] = [];
  let current = "";
  let length = 0;
  for (const char of text) {
    const size = escapeHtml(char).length;
    if (length + size > limit) {
      pieces.push(current);
      current = "";
      length = 0;
    }
    current += char;
    length += size;
  }
  if (current) pieces.push(current);
  return pieces;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Greedy grouping of lines into messages of at most TELEGRAM_MAX_TEXT characters (measured on the HTML), as
 * [start, end) ranges with blank lines trimmed at the edges.
 */
function chunkRanges(lines: Line[], html: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  let length = 0;
  for (let i = 0; i < html.length; i++) {
    const size = html[i]?.length ?? 0;
    if (i > start && length + 1 + size > TELEGRAM_MAX_TEXT) {
      ranges.push([start, i]);
      start = i;
      length = size;
    } else length = i === start ? size : length + 1 + size;
  }
  if (start < html.length) ranges.push([start, html.length]);
  const trimmed: Array<[number, number]> = [];
  for (let [from, to] of ranges) {
    while (from < to && lines[from]?.length === 0) from++;
    while (to > from && lines[to - 1]?.length === 0) to--;
    if (from < to) trimmed.push([from, to]);
  }
  return trimmed;
}

// --- HTTP ---------------------------------------------------------------------------------------------------------

interface BotApiResult {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: {retry_after?: number; migrate_to_chat_id?: number};
}

async function readResult(response: Response): Promise<BotApiResult> {
  try {
    const body: unknown = await response.json();
    return body !== null && typeof body === "object" ? (body as BotApiResult) : {};
  } catch {
    return {};
  }
}

function routeName(route: TelegramRoute): string {
  return route.threadId !== undefined ? `chat ${route.chatId} (thread ${route.threadId})` : `chat ${route.chatId}`;
}

/** A route's target id: its chat id, plus "/<thread id>" for a forum topic. Configuration, never the token. */
export function telegramTargetId(route: Pick<TelegramRoute, "chatId" | "threadId">): string {
  return route.threadId !== undefined ? `${route.chatId}/${route.threadId}` : route.chatId;
}
