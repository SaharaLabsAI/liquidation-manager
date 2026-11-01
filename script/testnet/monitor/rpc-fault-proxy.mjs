// JSON-RPC fault proxy for the live monitor test: forwards to an upstream RPC and injects failures read from a rules
// file on every request, so faults can be switched without restarting the daemon.
//   node rpc-fault-proxy.mjs <port> <upstream url> <rules.json>
// rules.json: {"down": true}                                  every request gets HTTP 503
//             {"failCalls": [{"to": "0x…", "sel": "0x…"}]}     matching eth_call items get a JSON-RPC error
//             {}                                              pass everything through
// Batches are answered item by item, so only the matching calls of a batch fail.
import {readFileSync} from "node:fs";
import {createServer} from "node:http";

const [port, upstream, rulesPath] = process.argv.slice(2);
if (!port || !upstream || !rulesPath) {
  console.error("usage: node rpc-fault-proxy.mjs <port> <upstream url> <rules.json>");
  process.exit(2);
}

function rules() {
  try {
    return JSON.parse(readFileSync(rulesPath, "utf8"));
  } catch {
    return {};
  }
}

function injected(item, {failCalls = []}) {
  if (item?.method !== "eth_call") return false;
  const {to = "", data = "", input = ""} = item.params?.[0] ?? {};
  const payload = (data || input).toLowerCase();
  return failCalls.some((rule) => to.toLowerCase() === rule.to.toLowerCase() && payload.startsWith(rule.sel.toLowerCase()));
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const current = rules();
  if (current.down) {
    res.writeHead(503).end("injected outage");
    return;
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400).end("bad json");
    return;
  }
  const batch = Array.isArray(body);
  const items = batch ? body : [body];
  const failed = items.map((item) => injected(item, current));
  const forward = items.filter((_, i) => !failed[i]);
  let answers = [];
  if (forward.length) {
    try {
      const response = await fetch(upstream, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(batch ? forward : forward[0]),
      });
      const text = await response.text();
      if (!response.ok) {
        res.writeHead(response.status).end(text);
        return;
      }
      const parsed = JSON.parse(text);
      answers = Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      res.writeHead(502).end(String(error));
      return;
    }
  }
  const byId = new Map(answers.map((answer) => [JSON.stringify(answer.id), answer]));
  const out = items.map((item, i) =>
    failed[i]
      ? {jsonrpc: "2.0", id: item.id, error: {code: -32603, message: "injected read failure"}}
      : (byId.get(JSON.stringify(item.id)) ?? {jsonrpc: "2.0", id: item.id, error: {code: -32603, message: "no upstream answer"}}),
  );
  res.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify(batch ? out : out[0]));
}).listen(Number(port), "127.0.0.1", () => console.log(`rpc-fault-proxy on 127.0.0.1:${port} -> ${upstream}`));
