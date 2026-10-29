// Stand-in for the Telegram Bot API: a node:http server on a free port that accepts what src/alerts/telegram.ts sends
// (POST /bot<token>/sendMessage with a JSON body), records every request and answers the way Telegram does. Failures
// can be injected for the next requests (rate limit, HTML parse error, server error), for every request during an
// outage, or as connection refused while the mock is offline (it listens on the same port again once online).
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";

/** The sendMessage fields the sink sets. */
export interface SendMessageBody {
  chat_id: string | number;
  text: string;
  parse_mode?: string;
  disable_notification?: boolean;
  message_thread_id?: number;
  link_preview_options?: {is_disabled?: boolean};
}

/** One request as received, accepted or not. */
export interface TelegramRequest {
  method: string;
  path: string;
  /** Bot token from the path (`/bot<token>/...`), or undefined for other paths. */
  token: string | undefined;
  /** Parsed JSON body (undefined when absent or not JSON). */
  body: SendMessageBody | undefined;
  /** HTTP status answered. */
  status: number;
  receivedAt: number;
}

/** A message Telegram would have delivered. */
export interface TelegramMessage extends SendMessageBody {
  message_id: number;
  receivedAt: number;
}

export type TelegramFailure =
  /** 429 with `parameters.retry_after` (seconds, default 1); the sink sleeps that long in real time. */
  | {kind: "rate-limit"; retryAfterSec?: number}
  /**
   * 400 "can't parse entities". Applies only to requests with `parse_mode` (as on Telegram): the sink's plain-text
   * retry of the same message is accepted and does not use up the count.
   */
  | {kind: "parse-error"}
  /** 500; the sink retries with backoff (1 s, 2 s), then the alert manager later. */
  | {kind: "server-error"}
  /** 502, as from a proxy in front of an unreachable API. */
  | {kind: "bad-gateway"};

export interface TelegramMock {
  /** Base URL for `telegram.apiUrl`. */
  url: string;
  /** The token the mock accepts; other tokens get 401 Unauthorized (as an invalid token does on Telegram). */
  botToken: string;
  /** Every request, in arrival order. */
  readonly requests: readonly TelegramRequest[];
  /** Accepted messages, in arrival order. */
  readonly messages: readonly TelegramMessage[];
  /** Answers the next `count` matching requests with `failure`. Calls queue up in order. */
  failNext(count: number, failure: TelegramFailure): void;
  /** While set, answers every sendMessage with `failure` (before any `failNext`); undefined ends the outage. */
  outage(failure: TelegramFailure | undefined): void;
  /** Stops listening (new connections are refused) until `online()`; recorded requests and messages are kept. */
  offline(): Promise<void>;
  /** Listens again on the same port. */
  online(): Promise<void>;
  /** Resolves with the first accepted message (already received or arriving later) matching `predicate`. */
  waitFor(predicate: (message: TelegramMessage) => boolean, timeoutMs?: number): Promise<TelegramMessage>;
  /** Forgets recorded requests and messages and pending failures. */
  clear(): void;
  close(): Promise<void>;
}

export interface TelegramMockOptions {
  /** Default: a fixed fake token (long enough for `registerSecret`). */
  botToken?: string;
}

/** Fake bot token used by the e2e configs: never a real one. */
export const FAKE_BOT_TOKEN = "123456789:e2e-fake-bot-token-not-a-secret";

const DEFAULT_WAIT_MS = 30_000;

export async function startTelegramMock(options: TelegramMockOptions = {}): Promise<TelegramMock> {
  const botToken = options.botToken ?? FAKE_BOT_TOKEN;
  const requests: TelegramRequest[] = [];
  const messages: TelegramMessage[] = [];
  const failures: TelegramFailure[] = [];
  const waiters = new Set<(message: TelegramMessage) => void>();
  let nextMessageId = 1;
  let down: TelegramFailure | undefined;
  let listening = false;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const raw = await readBody(req);
    const body = parseJson(raw);
    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(path);
    const record: TelegramRequest = {
      method: req.method ?? "GET",
      path,
      token: match?.[1],
      body,
      status: 200,
      receivedAt: Date.now(),
    };
    requests.push(record);
    const reply = (status: number, payload: unknown) => {
      record.status = status;
      res.writeHead(status, {"content-type": "application/json"});
      res.end(JSON.stringify(payload));
    };

    if (!match) return reply(404, {ok: false, error_code: 404, description: "Not Found"});
    if (match[1] !== botToken) return reply(401, {ok: false, error_code: 401, description: "Unauthorized"});
    if (match[2] !== "sendMessage" || req.method !== "POST") {
      return reply(404, {ok: false, error_code: 404, description: "Not Found: method not found"});
    }
    if (!body || body.chat_id === undefined || typeof body.text !== "string" || body.text === "") {
      return reply(400, {ok: false, error_code: 400, description: "Bad Request: message text is empty"});
    }

    const failure = down ?? takeFailure(failures, body);
    if (failure?.kind === "rate-limit") {
      const retryAfter = failure.retryAfterSec ?? 1;
      return reply(429, {
        ok: false,
        error_code: 429,
        description: `Too Many Requests: retry after ${retryAfter}`,
        parameters: {retry_after: retryAfter},
      });
    }
    if (failure?.kind === "parse-error") {
      const description = "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 0";
      return reply(400, {ok: false, error_code: 400, description});
    }
    if (failure?.kind === "server-error") {
      return reply(500, {ok: false, error_code: 500, description: "Internal Server Error"});
    }
    if (failure?.kind === "bad-gateway") return reply(502, {ok: false, error_code: 502, description: "Bad Gateway"});

    const message: TelegramMessage = {...body, message_id: nextMessageId++, receivedAt: Date.now()};
    messages.push(message);
    reply(200, {ok: true, result: {message_id: message.message_id, date: Math.floor(Date.now() / 1000)}});
    for (const waiter of waiters) waiter(message);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        listening = true;
        resolve();
      });
    });
  const stopListening = () =>
    new Promise<void>((resolve) => {
      if (!listening) return resolve();
      listening = false;
      server.closeAllConnections();
      server.close(() => resolve());
    });
  await listen(0);
  const {port} = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    botToken,
    requests,
    messages,
    failNext: (count, failure) => {
      for (let i = 0; i < count; i++) failures.push(failure);
    },
    outage: (failure) => {
      down = failure;
    },
    offline: stopListening,
    online: () => (listening ? Promise.resolve() : listen(port)),
    waitFor: (predicate, timeoutMs = DEFAULT_WAIT_MS) => {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise<TelegramMessage>((resolve, reject) => {
        const waiter = (message: TelegramMessage) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(message);
        };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          const received = messages.map((message) => `  ${firstLine(message.text)}`).join("\n") || "  (none)";
          reject(new Error(`no matching Telegram message within ${timeoutMs} ms; received:\n${received}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    clear: () => {
      requests.length = 0;
      messages.length = 0;
      failures.length = 0;
      down = undefined;
    },
    close: stopListening,
  };
}

/** First line of a message (the severity/chain/title header). */
export function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

/** Next queued failure that applies to this request; parse errors only apply to HTML requests. */
function takeFailure(failures: TelegramFailure[], body: SendMessageBody): TelegramFailure | undefined {
  const index = failures.findIndex((failure) => failure.kind !== "parse-error" || body.parse_mode !== undefined);
  if (index < 0) return undefined;
  return failures.splice(index, 1)[0];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJson(text: string): SendMessageBody | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? (value as SendMessageBody) : undefined;
  } catch {
    return undefined;
  }
}
