import {describe, expect, it, vi} from "vitest";

import {AlertManager} from "../src/alerts/manager.ts";
import {
  renderTelegramChunks,
  renderTelegramHtml,
  renderTelegramPlain,
  TELEGRAM_MAX_TEXT,
  TelegramError,
  telegramErrorKind,
  TelegramSink,
  type FetchLike,
} from "../src/alerts/telegram.ts";
import type {TelegramRoute} from "../src/config.ts";
import type {Logger} from "../src/log.ts";
import {silentLogger} from "../src/log.ts";
import {createStore} from "../src/store.ts";
import type {Alert, AlertLink, DeliveryErrorKind, OutgoingMessage, Severity} from "../src/types.ts";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const API = "https://api.telegram.org";
/** The target id of `route()`. */
const CHAT = "-1001234567890";

interface SentRequest {
  url: string;
  body: Record<string, unknown>;
  /** Fake clock (unix ms) when the request was made. */
  at: number;
}

function message(extra: Partial<Alert> = {}, status: OutgoingMessage["status"] = "firing"): OutgoingMessage {
  return {
    alert: {
      key: "ethereum:flows:0xabc:1",
      kind: "event",
      severity: "critical",
      rule: "flows",
      chain: "ethereum",
      title: "Unexplained outflow from Manager: 1,000 SAHARA",
      ...extra,
    },
    status,
  };
}

function route(extra: Partial<TelegramRoute> = {}): TelegramRoute {
  return {chatId: "-1001234567890", minSeverity: "info", ...extra};
}

function ok(): Response {
  return new Response(JSON.stringify({ok: true, result: {message_id: 1}}), {status: 200});
}

function apiError(status: number, description: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ok: false, error_code: status, description, ...extra}), {status});
}

/** Fake transport: answers with the queued responses (then 200 OK) and records every request. */
function fakeTelegram(responses: Array<Response | Error> = [], routes = [route()], log = silentLogger) {
  const requests: SentRequest[] = [];
  const clock = {now: Date.UTC(2026, 9, 28, 9, 0, 0)};
  const sleeps: number[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({url, body: JSON.parse(String(init.body)) as Record<string, unknown>, at: clock.now});
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? ok();
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock.now += ms;
  };
  const sink = new TelegramSink({botToken: TOKEN, apiUrl: `${API}/`, routes, log, fetch, sleep, now: () => clock.now});
  return {sink, requests, sleeps, clock};
}

function capturingLogger() {
  const lines: string[] = [];
  const record = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`);
  };
  const log: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => log,
  };
  return {log, lines};
}

describe("renderTelegramHtml", () => {
  it("escapes every plain-text value and renders fields, links, note and footer", () => {
    const html = renderTelegramHtml(
      message({
        title: "Pool <b>drained</b> & \"gone\"",
        fields: [
          {label: "Amount <x>", value: "1 < 2 & 3 > 2", code: true},
          {label: "Who", value: "Tom & Jerry"},
        ],
        links: [
          {label: "Transaction", url: "https://etherscan.io/tx/0xabc"},
          {label: "Search & <find>", url: "https://example.com/q?a=1&b=\"2\""},
        ],
        note: "Pause funding <now> & page the Guardian.",
      }),
      route(),
    );
    expect(html.split("\n")).toEqual([
      "🚨 <b>CRITICAL</b> · ethereum · <b>Pool &lt;b&gt;drained&lt;/b&gt; &amp; &quot;gone&quot;</b>",
      "",
      "Amount &lt;x&gt;: <code>1 &lt; 2 &amp; 3 &gt; 2</code>",
      "Who: Tom &amp; Jerry",
      "",
      "Pause funding &lt;now&gt; &amp; page the Guardian.",
      "",
      '<a href="https://etherscan.io/tx/0xabc">Transaction</a> · ' +
        '<a href="https://example.com/q?a=1&amp;b=&quot;2&quot;">Search &amp; &lt;find&gt;</a>',
      "",
      "<i>rule flows</i>",
    ]);
  });

  it("uses the status and severity headers", () => {
    const header = (severity: Severity, status: OutgoingMessage["status"], openForSec?: number) =>
      renderTelegramHtml({...message({severity, chain: undefined, title: "T"}, status), openForSec}).split("\n")[0];
    expect(header("critical", "firing")).toBe("🚨 <b>CRITICAL</b> · <b>T</b>");
    expect(header("high", "firing")).toBe("🔴 <b>HIGH</b> · <b>T</b>");
    expect(header("warning", "firing")).toBe("🟠 <b>WARNING</b> · <b>T</b>");
    expect(header("info", "firing")).toBe("🔵 <b>INFO</b> · <b>T</b>");
    expect(header("high", "resolved")).toBe("✅ <b>RESOLVED</b> · <b>T</b>");
    expect(header("high", "reminder")).toBe("🔁 <b>REMINDER HIGH</b> · <b>T</b>");

    const resolved = renderTelegramHtml({...message({note: "do something"}, "resolved"), openForSec: 3720});
    expect(resolved).toContain("<i>Was CRITICAL, open for 1h 2m</i>");
    expect(resolved).not.toContain("do something");
    expect(renderTelegramHtml({...message({}, "reminder"), openForSec: 7200})).toContain("<i>Still open after 2h</i>");
  });

  it("appends the route mention only to critical firing and reminder messages", () => {
    const mention = route({mention: "@alice @bob"});
    const lastLine = (msg: OutgoingMessage) => renderTelegramHtml(msg, mention).split("\n").at(-1);
    expect(lastLine(message())).toBe("@alice @bob");
    expect(lastLine(message({}, "reminder"))).toBe("@alice @bob");
    expect(lastLine(message({}, "resolved"))).toBe("<i>rule flows</i>");
    expect(lastLine(message({severity: "high"}))).toBe("<i>rule flows</i>");
    expect(lastLine(message({severity: "high"}, "reminder"))).toBe("<i>rule flows</i>");
  });

  it("renders a parallel plain-text variant without markup", () => {
    const msg = message({
      fields: [{label: "Amount", value: "1 < 2", code: true}],
      links: [{label: "Transaction", url: "https://etherscan.io/tx/0xabc?a=1&b=2"}],
    });
    const plain = renderTelegramPlain(msg).split("\n");
    expect(plain).toHaveLength(renderTelegramHtml(msg).split("\n").length);
    expect(plain[0]).toBe("🚨 CRITICAL · ethereum · Unexplained outflow from Manager: 1,000 SAHARA");
    expect(plain).toContain("Amount: 1 < 2");
    expect(plain).toContain("Transaction: https://etherscan.io/tx/0xabc?a=1&b=2");
  });
});

describe("chunking", () => {
  it("splits long messages on line boundaries into self-contained chunks of at most 4096 characters", () => {
    const field = (i: number) => ({label: `Field ${i}`, value: `value <${i}> & more`, code: true});
    const fields = Array.from({length: 150}, (_, i) => field(i));
    const calldata = `0x${"ab".repeat(6000)}`;
    const msg = message({fields: [...fields, {label: "Cancel calldata", value: calldata, code: true}]});
    const chunks = renderTelegramChunks(msg, route());
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
      expect(chunk.match(/<code>/g)?.length).toBe(chunk.match(/<\/code>/g)?.length);
      expect(chunk).not.toMatch(/&[a-z]*$/m); // no entity cut in half
      expect(chunk).not.toMatch(/^\n|\n$/);
    }
    const joined = chunks.join("\n");
    for (let i = 0; i < 150; i++) expect(joined).toContain(`Field ${i}: <code>value &lt;${i}&gt; &amp; more</code>`);
    const hex = [...joined.matchAll(/<code>(0x[0-9a-f]+|[0-9a-f]+)<\/code>/g)].map((m) => m[1]).join("");
    expect(hex).toBe(calldata);
  });

  it("sends each chunk as its own sendMessage", async () => {
    const {sink, requests} = fakeTelegram();
    const fields = Array.from({length: 200}, (_, i) => ({label: `Field ${i}`, value: "x".repeat(30), code: true}));
    await sink.send(message({fields}), CHAT);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.map((r) => r.body.text)).toEqual(renderTelegramChunks(message({fields}), route()));
  });

  it("reports each part the chat accepted, and resumes after the parts its caller says were accepted", async () => {
    const fields = Array.from({length: 200}, (_, i) => ({label: `Field ${i}`, value: "x".repeat(30), code: true}));
    const chunks = renderTelegramChunks(message({fields}), route());
    expect(chunks.length).toBeGreaterThan(2);
    // Part 2 fails three times (the in-call retries): the alert manager retries the message later.
    const down = Array.from({length: 3}, () => apiError(502, "Bad Gateway"));
    const {sink, requests} = fakeTelegram([ok(), ...down]);
    const reported: number[] = [];
    const progress = {sent: 0, onPart: (sent: number) => reported.push(sent)};
    await expect(sink.send(message({fields}), CHAT, progress)).rejects.toMatchObject({kind: "transient"});
    expect(reported).toEqual([1]);
    // The alert manager keeps the count (also across a restart) and passes it to the retry.
    await sink.send(message({fields}), CHAT, {...progress, sent: 1});
    const accepted = requests.filter((_, i) => i === 0 || i > 3).map((r) => r.body.text);
    expect(accepted).toEqual(chunks);
    expect(reported).toEqual([1, ...chunks.slice(1, -1).map((_, i) => i + 2)]);
    // Without progress (or with none sent), it starts over.
    await sink.send(message({fields}), CHAT);
    expect(requests.slice(4 + chunks.length - 1).map((r) => r.body.text)).toEqual(chunks);
  });
});

describe("TelegramSink", () => {
  it("posts the Bot API request shape", async () => {
    const {sink, requests} = fakeTelegram([], [route({threadId: 7})]);
    expect(sink.targets).toEqual([`${CHAT}/7`]);
    await sink.send(message({severity: "info"}), `${CHAT}/7`);
    await sink.send(message({severity: "warning"}), `${CHAT}/7`);
    expect(requests[0]?.url).toBe(`${API}/bot${TOKEN}/sendMessage`);
    expect(requests[0]?.body).toEqual({
      chat_id: "-1001234567890",
      message_thread_id: 7,
      text: renderTelegramHtml(message({severity: "info"})),
      parse_mode: "HTML",
      link_preview_options: {is_disabled: true},
      disable_notification: true,
    });
    expect(requests[1]?.body.disable_notification).toBe(false);

    const noThread = fakeTelegram();
    await noThread.sink.send(message(), CHAT);
    expect(noThread.requests[0]?.body).not.toHaveProperty("message_thread_id");
  });

  it("has one target per route, named by chat id and thread, unique even for a repeated route", () => {
    const routes = [route({chatId: "@ops"}), route({chatId: "@ops", threadId: 3}), route({chatId: "@ops"})];
    expect(fakeTelegram([], routes).sink.targets).toEqual(["@ops", "@ops/3", "@ops#2"]);
  });

  /** Sends to every route that admits the message, as the alert manager does. */
  const sendAll = async (sink: TelegramSink, msg: OutgoingMessage) => {
    for (const target of sink.targets) if (sink.admits(msg, target)) await sink.send(msg, target);
  };

  it("routes by minSeverity, also for resolved and reminder messages", async () => {
    const routes = [route({chatId: "@ops"}), route({chatId: "@pager", minSeverity: "high"})];
    const {sink, requests} = fakeTelegram([], routes);
    await sendAll(sink, message({severity: "warning"}));
    await sendAll(sink, message({severity: "warning"}, "resolved"));
    await sendAll(sink, message({severity: "warning"}, "reminder"));
    await sendAll(sink, message({severity: "high"}, "resolved"));
    await sendAll(sink, message({severity: "critical"}));
    expect(requests.map((r) => r.body.chat_id)).toEqual(["@ops", "@ops", "@ops", "@ops", "@pager", "@ops", "@pager"]);
    expect(sink.admits(message({severity: "critical"}), "@nowhere")).toBe(false);
  });

  it("routes by routeSeverity when above the alert's: a paged route sees a downgrade and the resolution", async () => {
    const routes = [route({chatId: "@ops"}), route({chatId: "@pager", minSeverity: "high", mention: "@alice"})];
    const {sink, requests} = fakeTelegram([], routes);
    await sendAll(sink, {...message({severity: "warning"}), routeSeverity: "critical"});
    await sendAll(sink, {...message({severity: "warning"}, "resolved"), routeSeverity: "critical"});
    await sendAll(sink, {...message({severity: "high"}), routeSeverity: "info"});
    expect(requests.map((r) => r.body.chat_id)).toEqual(["@ops", "@pager", "@ops", "@pager", "@ops", "@pager"]);
    // Rendered at the alert's own severity: a warning, without the critical mention.
    const pager = requests[1]!.body;
    expect(String(pager.text).startsWith("🟠 <b>WARNING</b>")).toBe(true);
    expect(pager.text).not.toContain("@alice");
  });

  it("waits a short retry_after on 429 in the call and retries", async () => {
    const {sink, requests, sleeps} = fakeTelegram([
      apiError(429, "Too Many Requests: retry after 3", {parameters: {retry_after: 3}}),
    ]);
    await sink.send(message(), CHAT);
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
  });

  it("leaves a long retry_after, or a 429 repeated, to the alert manager: transient, with the wait", async () => {
    const long = apiError(429, "Too Many Requests: retry after 3600", {parameters: {retry_after: 3600}});
    const flood = fakeTelegram([long]);
    const error = await flood.sink.send(message(), CHAT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect(error).toMatchObject({kind: "transient", status: 429, retryAfterMs: 3_600_000});
    expect((error as Error).message).toContain("rate limited (retry after 3600s)");
    expect(flood.requests).toHaveLength(1);
    expect(flood.sleeps).toEqual([]);

    const limited = () => apiError(429, "Too Many Requests: retry after 2", {parameters: {retry_after: 2}});
    const repeated = fakeTelegram([limited(), limited(), limited()]);
    await expect(repeated.sink.send(message(), CHAT)).rejects.toMatchObject({kind: "transient", retryAfterMs: 2000});
    expect(repeated.requests).toHaveLength(3);
    expect(repeated.sleeps).toEqual([2000, 2000]);
  });

  it("backs off briefly on 5xx and network errors, then throws a transient error", async () => {
    const recovered = fakeTelegram([apiError(502, "Bad Gateway"), new Error("socket hang up")]);
    await recovered.sink.send(message(), CHAT);
    expect(recovered.requests).toHaveLength(3);
    expect(recovered.sleeps).toEqual([1000, 2000]);

    const failing = fakeTelegram(Array.from({length: 10}, () => apiError(500, "Internal Server Error")));
    const error = failing.sink.send(message(), CHAT);
    await expect(error).rejects.toThrow(/failed after 3 attempts: 500 Internal Server Error/);
    await expect(error).rejects.toMatchObject({kind: "transient", status: 500});
    expect(failing.requests).toHaveLength(3);
    expect(failing.sleeps).toEqual([1000, 2000]);

    const refused = fakeTelegram(Array.from({length: 10}, () => new Error("connect ECONNREFUSED")));
    await expect(refused.sink.send(message(), CHAT)).rejects.toMatchObject({kind: "transient"});
    expect(refused.requests).toHaveLength(3);
  });

  it("retries a 2xx that does not confirm the message with ok: true, then throws a transient error", async () => {
    const truncated = () => new Response('{"ok":tr', {status: 200});
    // Telegram may have posted it: the retry can duplicate the message, which beats losing it.
    const recovered = fakeTelegram([truncated()]);
    await recovered.sink.send(message(), CHAT);
    expect(recovered.requests).toHaveLength(2);
    expect(recovered.sleeps).toEqual([1000]);

    const failing = fakeTelegram(Array.from({length: 10}, truncated));
    const error = failing.sink.send(message(), CHAT);
    await expect(error).rejects.toThrow(/failed after 3 attempts: 200 unconfirmed/);
    await expect(error).rejects.toMatchObject({kind: "transient"});
    expect(failing.requests).toHaveLength(3);
    expect(failing.sleeps).toEqual([1000, 2000]);

    for (const body of ["", "{}", "null", '{"result": {"message_id": 1}}']) {
      const ambiguous = fakeTelegram([new Response(body, {status: 200})]);
      await ambiguous.sink.send(message(), CHAT);
      expect(ambiguous.requests).toHaveLength(2);
    }
  });

  it("keeps an unconfirmed message for a retry, the route failing, once the in-call retries ran out", async () => {
    const {sink} = fakeTelegram(Array.from({length: 3}, () => new Response("<html>", {status: 200})));
    const alerts = new AlertManager({
      sinks: [sink],
      store: createStore(),
      reminderSec: {critical: 3600, high: 0, warning: 0, info: 0},
      log: silentLogger,
    });
    alerts.emit(message().alert);
    alerts.flush();
    await alerts.drain(1000);
    expect(alerts.stats.telegram?.targets[CHAT]).toMatchObject({
      ok: 0,
      failed: 0,
      retries: 1,
      undelivered: 1,
      failing: {severity: "critical", kind: "transient"},
    });
    expect(await alerts.stop(1000)).toBe(1);
  });

  it("resends once as plain text when Telegram cannot parse the HTML", async () => {
    const {sink, requests} = fakeTelegram([
      apiError(400, "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 10"),
    ]);
    const msg = message({links: [{label: "Transaction", url: "https://etherscan.io/tx/0xabc"}]});
    await sink.send(msg, CHAT);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).not.toHaveProperty("parse_mode");
    expect(requests[1]?.body.text).toBe(renderTelegramPlain(msg));
    expect(requests[1]?.body.text).toContain("Transaction: https://etherscan.io/tx/0xabc");
    expect(requests[1]?.body.text).not.toContain("<b>");

    const twice = fakeTelegram([
      apiError(400, "Bad Request: can't parse entities: x"),
      apiError(400, "Bad Request: can't parse entities: x"),
    ]);
    // Rejected as plain text too: this message cannot be delivered there.
    await expect(twice.sink.send(msg, CHAT)).rejects.toThrow(/400 Bad Request/);
    await expect(
      fakeTelegram([
        apiError(400, "Bad Request: can't parse entities: x"),
        apiError(400, "Bad Request: can't parse entities: x"),
      ]).sink.send(msg, CHAT),
    ).rejects.toMatchObject({kind: "message"});
    expect(twice.requests).toHaveLength(2);
  });

  it("fails fast on client errors, without in-call retries, classified for the alert manager", async () => {
    const routes = [route({chatId: "@missing"}), route({chatId: "@ops"})];
    const {sink, requests} = fakeTelegram([apiError(400, "Bad Request: chat not found")], routes);
    const error = sink.send(message(), "@missing");
    await expect(error).rejects.toThrow("sendMessage to chat @missing failed: 400 Bad Request: chat not found");
    await expect(error).rejects.toMatchObject({kind: "route", status: 400});
    await sink.send(message(), "@ops");
    expect(requests.map((r) => r.body.chat_id)).toEqual(["@missing", "@ops"]);

    const tooLong = fakeTelegram([apiError(400, "Bad Request: message is too long")]);
    await expect(tooLong.sink.send(message(), CHAT)).rejects.toMatchObject({kind: "message"});
    expect(tooLong.requests).toHaveLength(1);
  });

  it("names the new chat id when a group was upgraded to a supergroup (a route error)", async () => {
    const upgraded = apiError(400, "Bad Request: group chat was upgraded to a supergroup chat", {
      parameters: {migrate_to_chat_id: -1009876543210},
    });
    const {sink} = fakeTelegram([upgraded], [route({chatId: "-123456"})]);
    const error = sink.send(message(), "-123456");
    await expect(error).rejects.toThrow(
      "upgraded to a supergroup chat (the chat is now -1009876543210: update the route's chatId)",
    );
    await expect(error).rejects.toMatchObject({kind: "route"});
  });

  it("throws a message error for a message it cannot render", async () => {
    const {sink, requests} = fakeTelegram();
    const broken = message({links: "not a list" as unknown as AlertLink[]});
    await expect(sink.send(broken, CHAT)).rejects.toMatchObject({kind: "message"});
    expect(requests).toEqual([]);
    await expect(sink.send(message(), "@unknown")).rejects.toMatchObject({kind: "message"});
  });

  it("never puts the bot token in thrown errors or logs", async () => {
    const {log, lines} = capturingLogger();
    const echo: FetchLike = async (url) => {
      throw new Error(`connect ECONNREFUSED ${url} (${encodeURIComponent(url)})`);
    };
    const sleep = async () => {};
    const sink = new TelegramSink({botToken: TOKEN, apiUrl: API, routes: [route()], log, fetch: echo, sleep});
    const error = await sink.send(message(), CHAT).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("ECONNREFUSED");
    expect(error?.message).toContain("<redacted>");
    const secretParts = [TOKEN, encodeURIComponent(TOKEN), TOKEN.split(":")[1] ?? TOKEN];
    for (const secret of secretParts) {
      expect(error?.message).not.toContain(secret);
      expect(String(error?.stack)).not.toContain(secret);
      expect(JSON.stringify(error?.cause ?? null)).not.toContain(secret);
      for (const line of lines) expect(line).not.toContain(secret);
    }
    // The two in-call retries, at debug level (the alert manager logs the failure).
    expect(lines.map((line) => line.split(" ", 2).join(" "))).toEqual(["debug telegram", "debug telegram"]);

    const results = await sink.sendTest();
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    for (const secret of secretParts) expect(results[0]?.error).not.toContain(secret);

    const echoingApi = fakeTelegram([apiError(401, `Unauthorized: bot${TOKEN}`)], [route()], log);
    const apiFailure = await echoingApi.sink.send(message(), CHAT).catch((e: unknown) => e as Error);
    expect(apiFailure?.message).toContain("401");
    expect(apiFailure?.message).not.toContain(TOKEN);
  });

  it("limits each chat to 20 messages per minute", async () => {
    const {sink, requests, sleeps, clock} = fakeTelegram();
    const start = clock.now;
    for (let i = 0; i < 45; i++) await sink.send(message({title: `m${i}`}), CHAT);
    expect(requests).toHaveLength(45);
    expect(sleeps).toEqual([60_000, 60_000]);
    const offsets = requests.map((r) => r.at - start);
    expect(offsets.slice(0, 20).every((at) => at === 0)).toBe(true);
    expect(offsets.slice(20, 40).every((at) => at === 60_000)).toBe(true);
    expect(offsets.slice(40).every((at) => at === 120_000)).toBe(true);

    // Another chat has its own window.
    const other = fakeTelegram([], [route({chatId: "@a"}), route({chatId: "@b"})]);
    for (let i = 0; i < 20; i++) {
      for (const target of other.sink.targets) await other.sink.send(message({title: `m${i}`}), target);
    }
    expect(other.requests).toHaveLength(40);
    expect(other.sleeps).toEqual([]);
  });

  it("sendTest delivers an INFO test alert to every route regardless of minSeverity", async () => {
    const routes = [route({chatId: "@ops"}), route({chatId: "@pager", minSeverity: "critical", threadId: 3})];
    const forbidden = apiError(403, "Forbidden: bot is not a member of the channel chat");
    const {sink, requests} = fakeTelegram([forbidden], routes);
    const results = await sink.sendTest();
    expect(results).toEqual([
      {
        chatId: "@ops",
        ok: false,
        error: "sendMessage to chat @ops failed: 403 Forbidden: bot is not a member of the channel chat",
      },
      {chatId: "@pager", threadId: 3, ok: true},
    ]);
    expect(requests.map((r) => r.body.chat_id)).toEqual(["@ops", "@pager"]);
    expect(requests[1]?.body.text).toContain("🔵 <b>INFO</b>");
    expect(requests[1]?.body.text).toContain("Test alert");
    expect(requests[1]?.body.disable_notification).toBe(true);
  });
});

describe("telegramErrorKind", () => {
  // Real Bot API replies: "Bad Request: ..." (400), "Forbidden: ..." (403), "Unauthorized" (401), "Not Found" (404).
  const cases: Array<[number, string, DeliveryErrorKind]> = [
    [429, "Too Many Requests: retry after 30", "transient"],
    [500, "Internal Server Error", "transient"],
    [502, "Bad Gateway", "transient"],
    [504, "Gateway Timeout", "transient"],
    [408, "Request Timeout", "transient"],
    [401, "Unauthorized", "route"],
    [404, "Not Found", "route"],
    [403, "Forbidden: bot was kicked from the supergroup chat", "route"],
    [403, "Forbidden: bot is not a member of the channel chat", "route"],
    [403, "Forbidden: bot was blocked by the user", "route"],
    [403, "Forbidden: the group chat was deleted", "route"],
    [400, "Bad Request: chat not found", "route"],
    [400, "Bad Request: message thread not found", "route"],
    [400, "Bad Request: not enough rights to send text messages to the chat", "route"],
    [400, "Bad Request: need administrator rights in the channel chat", "route"],
    [400, "Bad Request: have no rights to send a message", "route"],
    [400, "Bad Request: group chat was upgraded to a supergroup chat", "route"],
    [400, "Bad Request: TOPIC_CLOSED", "route"],
    [400, "Bad Request: CHAT_WRITE_FORBIDDEN", "route"],
    [400, "Bad Request: CHAT_RESTRICTED", "route"],
    [400, "Bad Request: PEER_ID_INVALID", "route"],
    [400, "BAD REQUEST: Chat Not Found", "route"],
    // TDLib's checks of the bot's access and rights, and MTProto errors passed through as they are.
    [400, "Bad Request: have no write access to the chat", "route"],
    [400, "Bad Request: can't access the chat", "route"],
    [400, "Bad Request: can't access the topic", "route"],
    [400, "Bad Request: chat is not accessible", "route"],
    [400, "Bad Request: CHAT_SEND_PLAIN_FORBIDDEN", "route"],
    [400, "Bad Request: USER_BANNED_IN_CHANNEL", "route"],
    [400, "Bad Request: CHANNEL_INVALID", "route"],
    [400, "Bad Request: CHAT_ID_INVALID", "route"],
    [400, "Bad Request: message is too long", "message"],
    [400, "Bad Request: message text is empty", "message"],
    [400, "Bad Request: can't parse entities: Unsupported start tag", "message"],
    [400, "Bad Request: ENTITY_BOUNDS_INVALID", "message"],
    [400, "Bad Request: ENTITIES_TOO_LONG", "message"],
    [400, "", "message"],
    [413, "Request Entity Too Large", "message"],
    [409, "Conflict", "message"],
  ];

  it.each(cases)("%i %j is %s", (status, description, kind) => {
    expect(telegramErrorKind(status, description)).toBe(kind);
  });

  it("treats any 400 with migrate_to_chat_id as a route error", () => {
    expect(telegramErrorKind(400, "Bad Request: something new", true)).toBe("route");
  });

  it("classifies each failure the sink throws", async () => {
    const kinds: Array<[Response | Error, DeliveryErrorKind]> = [
      [apiError(401, "Unauthorized"), "route"],
      [apiError(403, "Forbidden: bot was kicked from the supergroup chat"), "route"],
      [apiError(400, "Bad Request: message thread not found"), "route"],
      [apiError(413, "Request Entity Too Large"), "message"],
    ];
    for (const [response, kind] of kinds) {
      const {sink, requests} = fakeTelegram([response]);
      await expect(sink.send(message(), CHAT)).rejects.toMatchObject({kind});
      expect(requests).toHaveLength(1);
    }
  });
});

describe("TelegramSink defaults", () => {
  it("uses the global fetch when none is injected", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    try {
      const sink = new TelegramSink({botToken: TOKEN, apiUrl: API, routes: [route()], log: silentLogger});
      await sink.send(message(), CHAT);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toBe(`${API}/bot${TOKEN}/sendMessage`);
    } finally {
      spy.mockRestore();
    }
  });
});
