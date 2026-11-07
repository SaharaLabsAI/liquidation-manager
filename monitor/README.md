# SAHARA Liquidity Monitor

Read-only monitoring and Telegram alerting for the SAHARA `LiquidityManager` deployments on Ethereum and BSC. It
implements the off-chain duties of design §5 and review response §7: flow monitoring, alerts on configuration,
Guardian and Timelock actions, CCIP message tracking, and the cross-chain reconciliation `R − I ≥ 10B`.

TypeScript, run from source with Node's built-in type stripping (Node >= 22.18, no build step). The contracts it
watches are described in the [root README](../README.md).

## What it watches

| Area | Checks | Source |
| --- | --- | --- |
| SAHARA flows | Every `Transfer` and `Approval` that touches a reserve endpoint must be explained in the same transaction by the contract that moved the tokens. Reserve endpoints are the Manager, every adapter ever registered, the watched pools, legacy reserve wallets and extra endpoints. Explaining events are `Funded`, `Recalled`, `ReservesMigrated`, `LiquidityAdded`, `LiquidityRemoved`, `LiquidityTransferred`, `LockedOrBurned` and `ReleasedOrMinted`. Direct transfers to a pool and unexplained outflows raise alerts. Pool outflows also feed a sliding window. | §5 "monitor all SAHARA inflows", "abnormal outflows" |
| Manager activity | `Funded`/`Recalled`, every `GuardianAction` (naming the Guardian function and its effect), and every owner configuration event, attributed to the Timelock operation that executed it | §7 fund/recall activity, Guardian or Timelock actions |
| Timelock | Every proposal decoded call by call, with the exact Guardian cancel transaction. Raised again when it comes within 24 h of its ETA and when it becomes executable. Cancellations, executions, delay and role changes. | §5 governance queues, §7 Timelock actions |
| Live state, every cycle | Token owner and `paused()`. Registry mapping and administrator. Pool owner, rebalancer, `rateLimitAdmin`, Router, remote configuration and rate limits. Router ramps. Manager owner, Guardian, pauses, operators and budgets. `verifyHandover()` and `verifyAdapter(id)`. Adapter allowances and balances. Pool inventory against the thresholds. Timelock delay and roles. GuardianController bindings. | §5 list, §7 allowances, limits, budgets, operator permissions, adapter configuration |
| CCIP and reconciliation | SAHARA CCIP messages in both directions: failed messages (critical), stuck messages, the in-flight amount `I`. `R − I ≥ requiredBacking` at finalized blocks. `totalSupply` per chain. | §5 reconciliation, failed messages |
| Health | Stale telemetry (a chain not caught up, its head not advancing, a state rule's reads failing, skipped CCIP blocks that cannot be replayed, or reconciliation blocked by failures so that `R − I` goes unverified), failing alert delivery, a daily summary, `/healthz`, `/metrics` and a dead-man's-switch heartbeat | §5 "stale telemetry … trigger incident response" |

**What it does not do.** The monitor only reads. It builds a public RPC client and makes `eth_call`, `eth_getLogs` and
block reads. It holds no private key and never sends a transaction. It does not pause, cancel, lock down, fund or
recall anything. It alerts, and people act:

- the Guardian Safe acts through the Manager restrictions and through `GuardianController.cancel`/`cancelBatch`/`lockdown`;
- the Governance Safe acts through the Timelock;
- the operators run `fund` and `recall`.

## Quick start

```sh
cd monitor
npm ci
cp config.example.yaml config.yaml          # then review it (see Configuration and the two steps below)
cat > .env <<'EOF'
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHANNEL_ID=-1001234567890
ETH_RPC_URL=https://...
BSC_RPC_URL=https://...
EOF
node --env-file=.env src/cli.ts test-alert   # one INFO message per Telegram route
node --env-file=.env src/cli.ts check        # one-shot report (exit codes: see CLI)
node --env-file=.env src/cli.ts run          # the daemon
```

`npm start`, `npm run check` and `npm run test-alert` run the same commands without `--env-file`. With those, export
the variables yourself.

Two steps before the first `run`:

1. **List the reserve wallets.** Put every wallet that holds SAHARA reserves on a chain in
   `chains.<chain>.reserves.legacyWallets` (or `extraEndpoints`). `R` counts only the endpoints the monitor knows:
   the Manager, the adapters, the watched pools and these lists. Before the Manager exists that is just the pool,
   which holds a small fraction of `requiredBacking`. With the example's empty lists, `R − I` is billions below
   `requiredBacking`. A critical `reconcile.backing` then fires as soon as both chains have scanned CCIP messages, and
   it is reminded every hour. Its note asks the Guardian to `pauseRecall()`. Unlisted wallets are also not
   flow-monitored, so an outflow from them raises nothing. `check` does not show this breach before the daemon's
   first scan: reconciliation is INCOMPLETE ("no blocks scanned for CCIP messages yet"). It does print
   `R (reserves)` with every balance, and `R` must be at least `requiredBacking` plus what is in flight. If the
   wallets are not known yet, set `reconciliation.enabled: false` until they are. That also disables
   `reconcile.failed-messages`, `.stuck-message` and `.total-supply`; `ccip.message-failed` events still fire.
2. **Choose `startBlock` and plan the first start.** See
   [startBlock and the state file](#startblock-and-the-state-file). A long first-start backfill raises
   `health.stale-telemetry`, fails `/healthz` and withholds the heartbeat until it completes.

`check` exits 0 when no critical or high condition was found, 1 when at least one was, and 2 on a configuration
error or when reading the head, resolving the addresses or running reconciliation failed. Failed state or balance
reads are warning conditions (`<rule>.read-failed`, reconciliation INCOMPLETE "… unreachable"). They still exit 0
when nothing is critical or high, so read the output, not only the exit code. Only the daemon escalates them with
their age (`<rule>.read-failed` to high and critical, a blocked reconciliation to `health.reconcile-stale`).

Environment variables read by `config.example.yaml`:

| Variable | Required | Sets |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes, while `telegram` is configured | `telegram.botToken` |
| `TELEGRAM_CHANNEL_ID` | yes, while `telegram` is configured | first route `chatId` |
| `ETH_RPC_URL`, `BSC_RPC_URL` | yes | `chains.<chain>.rpcUrls` |
| `HEARTBEAT_URL` | no | `alerts.heartbeatUrl` |
| `ETH_MANAGER`, `BSC_MANAGER` | no (set once deployed) | `contracts.manager` |
| `ETH_TIMELOCK`, `BSC_TIMELOCK` | no (recommended once deployed) | `contracts.timelock` (default: `Manager.owner()`) |
| `ETH_CONTROLLER`, `BSC_CONTROLLER` | no (recommended once deployed) | `contracts.controller` (default: the pool spec's `rateLimitAdmin`) |
| `ETH_GOVERNANCE_SAFE`, `BSC_GOVERNANCE_SAFE` | no | `expected.governanceSafe` (also the `governanceSafe` alias) |
| `ETH_GUARDIAN_SAFE`, `BSC_GUARDIAN_SAFE` | no | `expected.guardian` |
| `ETH_FUNDING_OPERATOR`, `BSC_FUNDING_OPERATOR` | no | `expected.fundingOperators` |
| `ETH_RECALL_OPERATOR`, `BSC_RECALL_OPERATOR` | no | `expected.recallOperators` |

`${VAR}` fails the configuration when `VAR` is unset or empty. `${VAR:-default}` falls back to `default`. Empty
strings and empty list items are dropped, so `${VAR:-}` leaves an optional setting unset. Interpolation always
produces strings, so numeric fields (`chainId`, `startBlock`, ports, intervals) must be literal numbers in the YAML.

### Docker

The image runs the source the same way (`node:24-alpine`, user `node`). Build and run it from `monitor/`:

```sh
docker build -t sahara-liquidity-monitor .
docker run -d --name sahara-monitor --restart unless-stopped \
  --env-file .env \
  -v "$PWD/config.yaml:/app/config.yaml:ro" \
  -v sahara-monitor-state:/app/state \
  -p 127.0.0.1:9464:9464 \
  sahara-liquidity-monitor
```

- Mount the config at `/app/config.yaml`. The default command is `run --config /app/config.yaml`.
- `/app/state` is a volume. The default `stateFile` (`./state/state.json`, relative to `/app`) lives on it. It must
  survive restarts and upgrades (see [startBlock and the state file](#startblock-and-the-state-file)). A bind mount
  must be writable by the container's `node` user.
- `.env` and `config.yaml` are excluded from the build context. Pass the environment with `--env-file`/`-e`. Docker
  reads `--env-file` values literally, so do not quote them.
- The image `HEALTHCHECK` polls `http://127.0.0.1:9464/healthz`, so keep `http.port: 9464`. The container turns
  unhealthy whenever `/healthz` returns 503. That happens while a chain is stale, and while an alert target is failing
  (a Telegram route cannot take its alerts, which are kept and retried, or it dropped one). A chain is stale while its
  scan is, including a first start whose backfill outlasts `staleAfterSec` (see
  [startBlock and the state file](#startblock-and-the-state-file)), while a state rule's reads have failed for longer
  than `staleAfterSec`, and while the replay of skipped CCIP blocks has failed for that long. It also returns 503
  while reconciliation has been blocked for longer than `reconciliation.staleAfterSec`, with every chain fresh. Do not
  restart the container on it (an autoheal tool, or a Kubernetes liveness probe on `/healthz`): a restart fixes none
  of these causes. It does not hide them either: failed reads, failed replays, a blocked reconciliation and a failing
  alert target are kept across a restart. Alert on the unhealthy state, or use `/healthz` as a readiness probe.
- One-shot commands replace the default command, e.g.
  `docker run --rm --env-file .env -v "$PWD/config.yaml:/app/config.yaml:ro" -v sahara-monitor-state:/app/state sahara-liquidity-monitor check --config /app/config.yaml`.
- On `SIGTERM` the daemon finishes the in-flight cycle, gives alert delivery up to 10 s, saves and exits. The cycle
  can take as long as its RPC requests, so allow more than Docker's default 10 s, e.g.
  `docker stop -t 60 sahara-monitor`. No alert is lost: what was not delivered by then, or at a `SIGKILL` or a crash,
  is sent at the next start (see Durability under
  [Delivery behaviour](#delivery-behaviour-srcalertstelegramts-srcalertsmanagerts)).

## Telegram setup

1. **Bot.** Message [@BotFather](https://t.me/BotFather), send `/newbot` and keep the token as `TELEGRAM_BOT_TOKEN`.
   The token never appears in logs or error messages (it is redacted).
2. **Channel.** Create a channel (a private one unless the alerts may be public). Add the bot as an
   **administrator** with the **Post messages** permission. It needs no other right.
3. **Chat id.** A public channel can use `@channelname`. A private channel needs its numeric id, which starts with
   `-100`. To find the id:
   1. Post any message in the channel.
   2. Run `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"`.
   3. Read `channel_post.chat.id` from the output (this works while the bot has no webhook).

   Set the id as `TELEGRAM_CHANNEL_ID`.
4. **Test.** Run `node --env-file=.env src/cli.ts test-alert`. It sends one fixed INFO message to every route (ignoring
   `minSeverity`) and prints one line per route. Because the message is info severity it is delivered silently, with
   no notification sound.

**On-call route (optional).** A second route can page an on-call group with high and critical alerts only, and
mention people on critical ones:

```yaml
telegram:
  botToken: ${TELEGRAM_BOT_TOKEN}
  routes:
    - chatId: ${TELEGRAM_CHANNEL_ID}
      minSeverity: info
    - chatId: "-1001234567890"     # group or supergroup; the bot must be allowed to send messages there
      threadId: 42                 # optional forum topic id (the topic number in a message link)
      minSeverity: high
      mention: "@oncall_primary @oncall_secondary"
```

### Delivery behaviour (src/alerts/telegram.ts, src/alerts/manager.ts)

**Routing and format**

- **Routing.** Each route receives the messages whose routing severity is at or above its `minSeverity`. The routing
  severity is the alert's severity, with one exception. An open condition can be downgraded on the same key, for
  example a pool below its minimum (critical) that is now only below its refill trigger (warning), or a budget that
  went from exhausted (high) to low (warning). Its downgrade message and its final "resolved" message are routed by
  the highest severity sent while it was open. A `minSeverity: high` on-call route therefore sees how the incident
  ends. Reminders follow the current severity.
- **Format.** Messages use HTML parse mode, with link previews disabled. The header is the severity emoji, severity,
  chain and title: 🚨 CRITICAL, 🔴 HIGH, 🟠 WARNING, 🔵 INFO, 🔁 REMINDER, ✅ RESOLVED. Then come the fields (addresses,
  hashes, calldata and amounts in monospace), the note with the runbook action (omitted on "resolved"), the links and
  a `rule <id>` footer.
- **Silent delivery.** `disable_notification` is set exactly when the alert's severity is `info`.
- **Mentions.** A route's `mention` text is appended to critical messages, both when they fire and when they are
  reminded. It is not appended to "resolved" messages.

**Lifecycle**

- **Events and conditions.** An event alert (something happened) is sent once per key. Keys are remembered for 7
  days. A condition alert (something is wrong now) stays open while it holds. It is re-sent as a reminder every
  `alerts.reminderSec[severity]`, which defaults to 1 h for critical, 4 h for high, 12 h for warning and never for
  info. A "resolved" message, with how long the condition was open, is sent once it clears. If the severity of an open
  condition changes, it is sent again as firing (routed as described under Routing).
- **Conditions no rule evaluates any more.** These are dropped at start-up without a "resolved" message, which
  would be a false all-clear:
  - the conditions of a chain removed from or renamed in `chains`;
  - `global:reconcile:*` when `reconciliation.enabled` is false;
  - `global:health:reconcile-stale` when `reconciliation.enabled` is false, and also when the state file holds no
    blocked age for it (an older or edited state file): the next run would resolve it whatever it finds;
  - `<chain>:ccip:*` when that chain's `ccip.enabled` is false.

  They are logged at warn and listed in the start-up message (`health.started`) under "Open conditions dropped".
- **Backlog bounding.** What waits for one target (a Telegram route or the console, see Targets below), whether a
  burst or everything raised while a route is down, stays bounded:
  - More than 20 info/warning messages waiting for one target are folded into one digest message for that target
    alone, merged with an earlier digest it has not delivered yet, in the place of the first of them. A target counts
    only the messages it admits, so a `minSeverity: high` route never folds anything. The digest's title is "`<N>`
    info/warning alerts (digest)". Its fields count the messages per severity and status (e.g. "Info firing: 23").
    Its text has one line per alert key with that key's latest status, e.g. "• WARNING ethereum: `<title>`
    (resolved)", for up to 30 keys, then "… and N more". It has warning severity if it contains a warning, otherwise
    info.
  - Critical and high messages, including downgrades and resolutions routed as critical or high, are never folded and
    stay in order. An info/warning message about a key that has a critical or high message ahead of it, after the
    digest's place, also stays individual, behind that message: a digest never shows a condition in a later state
    than a message after it.
  - A reminder replaces an older reminder of the same condition that the target has not delivered yet, so after an
    outage each open condition gets one reminder per route.
  - The message a target is sending or retrying, or has sent part of, is never folded or replaced. Critical and high
    messages stay unbounded: state changes, events and one reminder per open condition.

**Sending**

- **Targets.** Each Telegram route is a delivery target of its own, named by its chat id, or `<chatId>/<threadId>` for
  a forum topic (a second route to the same chat and topic gets `#2`). The console is the target `stdout`. Each
  target sends the messages it admits one at a time, in emission order, and is tracked on its own: a retry never
  re-sends to a target that already accepted the message. Delivery runs in the background, so no loop waits for
  Telegram: chain cycles, cursor saves, reconciliation and the health timer go on during an outage. A saved cursor
  therefore does not mean that its alerts were delivered; `sahara_monitor_alert_outbox_messages` and `/healthz`
  `outboxMessages` show what is still waiting.
- **Rate limits.** At most 20 messages per minute are sent to each chat (sliding window). Routes to topics of one chat
  share it.
- **Short retries in the call.** Network errors, timeouts (15 s per request), 5xx and 408 are retried after 1 s and
  2 s, three attempts in all. A 429 is waited out in the call only when its `retry_after` is at most 5 s, and at most
  twice. Anything else ends the attempt with an error the alert manager acts on (see Failures below).
- **Unconfirmed responses.** A message counts as delivered only when the HTTP status is 2xx and the body parses with
  `"ok": true`. A 2xx whose body is empty, truncated, not JSON or lacks `"ok": true` is retried like a 5xx (debug log
  `telegram response unconfirmed, retrying`). After 3 attempts it fails with `sendMessage to chat <id> failed after 3
  attempts: 200 unconfirmed (no "ok": true in the response)`, a transient failure: the message is kept and retried
  later. Telegram may have posted it anyway, so a retry can duplicate a message; the same holds for a timeout or
  network error after the request reached Telegram.
- **Long messages.** Messages are split at Telegram's 4096-character limit on line boundaries. Over-long values,
  such as Timelock calldata, are broken into labelled parts. Each part a chat accepts is saved with the message, so a
  retry, also after a restart or a crash, sends only the parts that chat has not received yet.
- **HTML fallback.** If Telegram answers 400 "can't parse entities", that part is re-sent once as plain text without
  `parse_mode` (warn log `telegram rejected HTML, resending as plain text`).

**Failures**

Each failed attempt is classified. Every kind marks the target failing (see below).

| Kind (`failingKind`) | Failures | The message |
| --- | --- | --- |
| `transient` | A network error or timeout, a 5xx, a 408 or an unconfirmed 2xx after the short retries; any 429 not waited out in the call | Kept and retried with backoff. |
| `route` | 401 (bot token), 403 (bot removed or blocked), 404 (bot token or `telegram.apiUrl`), and a 400 about the chat or the bot's rights in it (listed below) | Kept and retried with backoff until the route is fixed (see [When Telegram fails](#when-telegram-fails)). |
| `message` | Any other 4xx, e.g. 400 "message is too long" after the plain-text fallback, 413 or `ENTITY_BOUNDS_INVALID`, and a message that cannot be rendered | Dropped for that target only. The other targets still deliver it. |
| `unclassified` | An error of the sink itself, not a classified delivery error (a sink bug, a failed console write) | Retried with backoff, and dropped for that target at the third failed attempt. |

These 400 descriptions are route failures (case-insensitive parts of Telegram's description): "chat not found",
"thread not found", "not enough rights", "need administrator rights", "have no rights", "have no write access",
"can't access the chat", "can't access the topic", "chat is not accessible", "upgraded to a supergroup" (also any 400
that names a `migrate_to_chat_id`), "bot was kicked", "bot is not a member", "bot was blocked", "chat was deleted",
"chat was deactivated", "chat_id is empty", and the error names `TOPIC_CLOSED`, `TOPIC_DELETED`,
`CHAT_WRITE_FORBIDDEN`, any `CHAT_SEND_*` (e.g. `CHAT_SEND_PLAIN_FORBIDDEN`), `CHAT_RESTRICTED`, `CHAT_ADMIN_REQUIRED`,
`CHANNEL_PRIVATE`, `CHANNEL_INVALID`, `CHAT_ID_INVALID`, `PEER_ID_INVALID` and `USER_BANNED_IN_CHANNEL` (the bot's
account is limited and cannot post to groups). Other error names, such as `ENTITY_BOUNDS_INVALID` and
`ENTITIES_TOO_LONG`, concern the message, which is dropped for that route. When a group was upgraded to a supergroup
(e.g. by enabling topics), the error ends with "(the chat is now `<id>`: update the route's chatId)", in the logs and
in `/healthz`.

- **Retry timing.** A target retries a kept message after 5 s, doubled per failed attempt up to 5 min, and never
  earlier than Telegram's `retry_after`. That wait is saved in the state file (`retryAt`), so a restart does not
  retry earlier either. A `retry_after` is waited at most 24 h: a longer or infinite value, or a saved `retryAt` more
  than 24 h ahead (e.g. after a clock change), is cut to 24 h, and a value that is not a positive number is ignored
  (the backoff applies). `lastError` keeps Telegram's value (e.g. "rate limited (retry after 2592000s)"), while the
  warn log's `retryInMs` shows the delay used. After a restart the backoff starts again at 5 s.
- **Per target, in order.** While a target retries a message, its later messages wait behind it, in order. Other
  targets are not held up: a broken on-call route does not delay the channel, and the reverse. Once the route works
  again (fixed in Telegram, or in the config and restarted, including a `chatId` changed after a migration), its kept
  messages are delivered in order.
- **Failing target.** A failed attempt, kept or dropped, marks the target failing. It stays failing until it delivers
  a message at the highest routing severity that failed, or above. A kept message clears it once it is delivered
  itself. A dropped one keeps it until a later delivery at its severity or above (routes admit by severity, so that
  delivery reached every route the dropped one should have). The failing state is saved in the state file, so it
  survives a restart: it holds from the start, with the warn log `alert delivery was failing before the last
  shutdown, and counts as failing until it delivers` (`sink`, `target`, `failingSince`, `kind`, `error`). While any
  target is failing:
  - the heartbeat is not sent, so the dead-man's switch fires;
  - `/healthz` returns 503 with status `delivery-failing` (unless a chain or reconciliation is stale, which takes
    precedence);
  - `sahara_monitor_alert_sink_failing{sink,target}` is 1;
  - the daily summary's "Deliveries" line shows "FAILING since `<time>`".
- **The cause shown.** `failingKind` and `lastError` (in `/healthz` and the state file) are those of the latest
  failure at the failing severity. While a dropped, more severe message keeps the target failing, a later failure of
  a less severe message does not replace them: they keep showing the drop (e.g. kind `message`, "400 … message is too
  long") until a delivery at that severity or above. A new outage that meanwhile affects only less severe messages
  shows in `outboxMessages`, `outboxOldestAgeSec`, `retries` and the warn log `alert delivery failing…`, with its own
  `kind`.
- **Logs.** Each with `sink` and `target`:
  - warn `alert delivery failing; its alerts are kept and retried with backoff`, or for a route failure warn `alert
    delivery failing: the route needs a fix (bot token, chat id, the bot's membership or rights); its alerts are kept
    and retried`. Once per outage and process, and again when the kind changes, with `key`, `status`, `kind`,
    `error`, `undelivered` and `retryInMs`. Each further failed retry is the debug log `alert delivery retry failed`.
  - info `alert delivery recovered` (`failingForSec`, `undelivered`) once the target is no longer failing.
  - error `alert dropped for a target that cannot take it` (`key`, `status`, `kind`, `error`).
  - error `alert delivery failed with an unclassified error, retrying` (the fields of the warn, plus `attempts`), and
    error `alert delivery loop failed` (a bug in the delivery loop).
  - The Telegram sink's short retries log at debug level: `telegram request failed, retrying`, `telegram server
    error, retrying`, `telegram response unconfirmed, retrying` and `telegram rate limited, waiting`.

**Durability**

- **Outbox.** A message is stored in the state file (`alerts` namespace) together with the change that caused it: an
  event key marked sent, or a condition opened, reminded or resolved. It stays in `queue` until the next flush and
  then in `outbox` until every target it is for has delivered or dropped it. The state file is saved after each
  delivery, drop, failed attempt and accepted part of a long message, per target, as well as after every cycle,
  reconciliation and health tick.
- **Crash or kill.** Messages not delivered when the process died are sent again at the next start, with the warn log
  `alerts not delivered before the last shutdown are sent again` (`messages`: their number). Each target gets only
  those it had not taken, in their original order, before the start-up message (`health.started`) and anything new,
  and of a long message only the parts it had not taken. A message delivered and saved is never sent again.
- **At least once.** A message in flight at a crash (delivered, but its delivery not saved yet) can arrive twice; of a
  long message, only the part in flight. So can a retried Telegram request (see Unconfirmed responses). A message
  leaves the outbox only once every target it is for has delivered it, dropped it as undeliverable (a `message`
  failure, or an unclassified one three times), folded it into a digest or replaced it by a newer reminder (see
  Backlog bounding), or when those targets are no longer configured (below).
- **Changed or removed routes.** At start, the undelivered messages of a target that is no longer configured go to
  the targets of the same sink added since the last start that admit them, e.g. the route whose `chatId` was updated
  after a group migration (warn `alerts not delivered to targets no longer configured go to the targets added
  since`, `targets`). Such a target starts a long message from its first part. Without one they are dropped (warn
  `alerts not delivered to targets no longer configured are dropped`, `messages`: those no configured target is left
  for), e.g. when the `telegram` section was removed. The failing state of a target no longer configured is dropped
  with it.
- **Stop.** On SIGINT/SIGTERM the pending retries are cancelled and sends in progress get up to 10 s; a target that is
  delivering goes on with its next messages meanwhile. Then nothing more is sent: what is left stays in the state
  file and is delivered at the next start (warn `alerts not delivered yet are kept for the next start`, `messages`).
  A dry run keeps nothing, since its store is in memory.
- **Earlier state files.** An outbox written before delivery was tracked per target (`{message, sinks}`) is moved at
  start to the targets of those sinks that admit each message.

#### When Telegram fails

Signs: `/healthz` 503 `delivery-failing`, the dead-man's switch firing, `sahara_monitor_alert_sink_failing` at 1 and
the warn log `alert delivery failing…`. `/healthz` `deliveries.telegram.targets` names the route (its chat id) with
`failingKind`, `lastError`, `outboxMessages` and `outboxOldestAgeSec`. The other routes keep delivering meanwhile:
pages still reach the on-call group while the channel is broken, and the reverse. Nothing raised meanwhile is lost
(see Durability). A restart alone changes nothing, since the failure and the kept alerts are in the state file, and
deleting the state file would lose the kept alerts with everything else in it.

| `failingKind`, `lastError` | Cause | Action |
| --- | --- | --- |
| `route`, `401 Unauthorized` (every route) | The bot token is wrong or revoked. | Set the right `TELEGRAM_BOT_TOKEN` and restart. The kept messages are delivered soon after the start. |
| `route`, `404 Not Found` | The bot token or `telegram.apiUrl` is wrong. | Fix it and restart. |
| `route`, `403 Forbidden: bot was kicked …`, `bot is not a member`, `bot was blocked` | The bot was removed from the chat. | Add the bot back (in a channel as an administrator with **Post messages**). No restart: the next retry, within 5 min, delivers the kept messages. |
| `route`, `400 Bad Request: not enough rights …`, `need administrator rights`, `CHAT_WRITE_FORBIDDEN`, `CHAT_SEND_*` | The bot may not post there. | Give it the right. No restart. |
| `route`, `400 Bad Request: group chat was upgraded to a supergroup chat (the chat is now <id>: update the route's chatId)` | The group became a supergroup (e.g. topics were enabled) and has a new id. | Set the route's `chatId` to the new id and restart. The old route's kept messages go to the new one. |
| `route`, `400 Bad Request: chat not found`, `message thread not found`, `TOPIC_CLOSED`, `TOPIC_DELETED` | The chat id or topic is wrong, or the topic was closed or deleted. | Fix `chatId` or `threadId` and restart (the kept messages go to the new target), or reopen the topic (no restart). |
| `route`, `USER_BANNED_IN_CHANNEL` | Telegram limited the bot's account: it cannot post to groups. | Use another bot: put its token in `TELEGRAM_BOT_TOKEN`, add it to every chat, then restart. |
| `transient`, `rate limited (retry after Ns)` | Telegram's flood control. | Nothing: the route waits `retry_after` (at most 24 h), then delivers. If a busy channel is limited often, raise its `minSeverity`. Anything else posting with the same bot counts towards Telegram's limits too. |
| `transient`, `failed after 3 attempts: …` (network error, timeout, 5xx) | Telegram or the network is unreachable. | Check that the host reaches `api.telegram.org` (DNS, firewall, proxy). The kept messages are delivered once it answers. |
| `message`, e.g. `400 Bad Request: message is too long` | Telegram rejected that one message. | It was dropped for that route only. The error log `alert dropped for a target that cannot take it` names its `key`, and the info logs with that key (`event alert`, `condition opened`) give its title. Nothing on the route needs fixing; report the message as a bug. The route stays failing, and the heartbeat withheld, until it delivers a message at that severity or above, e.g. the next reminder of an open critical condition (hourly by default). |

After a fix, `test-alert` shows at once whether the route works. It posts directly, outside the daemon's outbox, so it
neither delivers the kept messages nor clears the failing state: the daemon does both at its next retry.

## Configuration

The file is YAML (JSON also works), validated at start-up. It is read from `--config <path>`, default
`./config.yaml`. Addresses may be in any case. Token amounts are whole tokens, given as decimal strings or numbers
(`"10000000000"` = 10 billion SAHARA; `_` separators are allowed). Unknown keys are ignored.

### Top level

| Field | Default | Meaning |
| --- | --- | --- |
| `logLevel` | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr. |
| `stateFile` | `./state/state.json` | Persistent state, relative to the working directory. Written atomically (temporary file and rename) after every cycle, reconciliation and health tick, and after each delivery attempt to an alert target: a delivery, a drop, a failed attempt or an accepted part of a long message (for Telegram at most about 20 writes per minute per chat). A failed write (disk full, not writable) logs `cannot save the state file` each time. |
| `http.host` | `0.0.0.0` | Bind address of `/healthz` and `/metrics`. |
| `http.port` | `9464` | `0` lets the OS pick a free port (tests); the Docker `HEALTHCHECK` needs `9464`. Omit the whole `http` section to disable the server. |
| `token.symbol` | `SAHARA` | Display only. |
| `token.decimals` | `18` | Used for every amount conversion. |
| `alerts.reminderSec.critical` | `3600` | Reminder interval for open conditions; `0` = never. |
| `alerts.reminderSec.high` | `14400` | |
| `alerts.reminderSec.warning` | `43200` | |
| `alerts.reminderSec.info` | `0` | |
| `alerts.dailySummaryUtc` | unset (no summary) | `"HH:MM"` UTC. The daily summary is sent once per UTC day at or after this time. |
| `alerts.transientFailureGraceSec` | `60` | Seconds a failure must last before its warning is raised: a state rule's failed reads (`<state-rule>.read-failed`, `timelock-queue.read-failed`) and reconciliation runs blocked only by failures (`reconcile.incomplete` for an unreachable chain, CCIP tracking not started or a lagging CCIP scan, counted from the first blocked run). A passing RPC error then sends nothing, neither the warning nor its resolution. Escalation (high after `staleAfterSec`, `health.reconcile-stale`), `/healthz`, the heartbeat and `check` are unchanged. `0` raises the warning at the first failure. |
| `alerts.heartbeatUrl` | unset | Dead-man's switch URL (e.g. healthchecks.io). It is fetched with GET every 60 s while every chain has caught up since the start and is not stale (its scan, its state reads and the replay of its skipped CCIP blocks), reconciliation has not been blocked for longer than `reconciliation.staleAfterSec`, and no alert target is failing, also after a restart (see [Heartbeat](#http-endpoints)). Treated as a secret. |
| `telegram.botToken` | required if `telegram` is set | |
| `telegram.apiUrl` | `https://api.telegram.org` | Bot API base URL. |
| `telegram.routes[]` | at least one | See below. Without a `telegram` section no message is sent to Telegram. |
| `routes[].chatId` | required | `@channelname`, or a numeric id (`-100…`). With `threadId` it names the route's delivery target. When either changes (e.g. after Telegram moved a group to a supergroup), the old route's undelivered alerts go to the new one (those it admits) at the next start (see Durability under [Delivery behaviour](#delivery-behaviour-srcalertstelegramts-srcalertsmanagerts)). |
| `routes[].threadId` | unset | Forum topic id. |
| `routes[].minSeverity` | `info` | `info`, `warning`, `high` or `critical`. |
| `routes[].mention` | unset | Text appended to critical messages, e.g. `"@alice @bob"`. |
| `reconciliation.enabled` | `true` | Run `R − I` reconciliation. `false` also disables `reconcile.failed-messages`, `.stuck-message`, `.total-supply` and `health.reconcile-stale` (`ccip.message-failed` events still fire). At the next start, open `global:reconcile:*` conditions and an open `health.reconcile-stale` are dropped without a "resolved" message, and the stored blocked age is cleared. |
| `reconciliation.requiredBacking` | `"10000000000"` | `R − I` must stay at or above this. It is also the expected `totalSupply` on each chain (`reconcile.total-supply`). |
| `reconciliation.intervalSec` | `300` | Reconciliation interval of the daemon: the next run starts this long after the previous one ended. A run happens only while every chain has caught up since the start and no chain's scan is stale; otherwise it is skipped and the last report is kept (see [CCIP and reconciliation](#ccip-and-reconciliation)). Failing state reads or CCIP gap replays do not skip it. A run that does happen can still be blocked (see `staleAfterSec` below). |
| `reconciliation.staleAfterSec` | `3 × intervalSec` (900 with the defaults) | Reconciliation is stale once its runs have been blocked for longer than this: they threw, or were INCOMPLETE because a chain was unreachable, CCIP tracking had not started or a CCIP scan was behind its finalized block. It raises `health.reconcile-stale` (high; critical after 3×), fails `/healthz` and withholds the heartbeat. CCIP tracking disabled and skipped CCIP blocks still being replayed do not count (see [`health.reconcile-stale`](#health-and-other)). The chain's `staleAfterSec` does not apply to reconciliation. Must be at least `2 × intervalSec`: one blocked run followed by a good one is blocked from the start of the first run to the end of the second, that is `intervalSec` plus both runs' durations, and RPC timeouts can stretch a run to minutes (`(rpcRetryCount + 1) × rpcTimeoutMs` per hanging request and RPC URL). It pages only when that span exceeds this limit: the default leaves both runs `2 × intervalSec`, the minimum only `intervalSec`. A smaller value fails the configuration with `reconciliation.staleAfterSec: must be at least 2 × intervalSec (one blocked run followed by a good one is blocked for intervalSec plus both runs' durations, and pages when that exceeds staleAfterSec)`. |
| `reconciliation.acknowledged` | `[]` | Obligations the monitor can never see settle, which the operator checked and settled (e.g. in the CCIP explorer). Each entry is `{chain, txHash, note}` or `{chain, messageId, note}`: exactly one of `txHash` and `messageId` (32 bytes of hex), and a non-empty `note`. See [Acknowledged obligations](#acknowledged-obligations). |
| `chains` | at least one | Map from chain name (lowercase letters, digits, `-` and `_`) to a chain section. The name appears in every alert and metric. |

### `chains.<name>`

| Field | Default | Meaning |
| --- | --- | --- |
| `chainId` | required | EVM chain id. |
| `chainSelector` | required | CCIP chain selector (decimal). Ethereum `5009297550715157269`, BSC `11344663589394136015`. The other configured chains' selectors define the counterpart lane. |
| `rpcUrls` | required (one or more) | Fallback list, sticky: a request starts at the URL that answered last, and on failure tries the next URLs in order, wrapping around. A recovered earlier URL is used again only after the current one fails. See [RPC requirements](#rpc-requirements). |
| `rpcTimeoutMs` | `20000` | Per-request timeout. |
| `rpcRetryCount` | `2` | Retries per URL before moving on to the next. |
| `explorerUrl` | required | Block explorer base for transaction and address links. |
| `confirmations` | `3` | Logs and state are processed at the confirmed head (`latest − confirmations`). |
| `pollIntervalSec` | `15` | Cycle interval. |
| `maxLogRange` | `500` | Largest `eth_getLogs` block range. Failing ranges are split further. |
| `startBlock` | unset | First block scanned on a fresh state file. See [startBlock and the state file](#startblock-and-the-state-file). |
| `staleAfterSec` | `300` | The chain's scan is stale once, for longer than this, it has not been caught up (no successful cycle left the cursor at the confirmed head) or its confirmed head has not risen (a stuck or lagging RPC node). A stale scan raises `health.stale-telemetry` (high; critical after 3×), fails `/healthz`, withholds the heartbeat and skips reconciliation. The same limit applies to a state rule's reads (`<rule>.read-failed` turns high after it, critical after 3×) and to the replay of skipped CCIP blocks (`health.ccip-gap-replay`, the same thresholds): either one failing for longer also fails `/healthz` and withholds the heartbeat, but does not skip reconciliation. It does not apply to reconciliation's own reads, which have `reconciliation.staleAfterSec`. Chains without regular blocks need a larger value. It must also exceed the RPC worst case: one request can take `len(rpcUrls) × (rpcRetryCount + 1) × rpcTimeoutMs` (60 s per URL with the defaults), and a cycle makes many sequential request rounds. |
| `contracts.token` | required | SAHARA token. With a Manager, it must equal `Manager.TOKEN()`, or address resolution fails every cycle. |
| `contracts.registry` | required | CCIP TokenAdminRegistry. With a Manager, it must equal `Manager.TOKEN_ADMIN_REGISTRY()`, or address resolution fails every cycle. |
| `contracts.router` | `getRouter()` of a watched pool | CCIP Router. |
| `contracts.pool` | unset | The pool to watch before a Manager exists. With a Manager, registered pools are discovered. |
| `contracts.manager` | unset | LiquidityManager. Setting it enables the Manager rules and the Manager-dependent defaults below. |
| `contracts.timelock` | `Manager.owner()` | Set it explicitly: `state-manager.owner` only checks the Manager owner against a configured Timelock. |
| `contracts.controller` | the registered pool spec's `rateLimitAdmin` | GuardianController. Set it explicitly as well. |
| `reserves.legacyWallets` | `[]` | Reserve wallets until migrated: flow-monitored and counted in `R`. List every wallet that holds SAHARA reserves before the first run: an incomplete list reads as a critical backing breach (see [Quick start](#quick-start)). |
| `reserves.extraPools` | `[]` | Retired or replacement pools that still hold inventory or obligations (watched pools). |
| `reserves.extraEndpoints` | `[]` | Any other reserve address counted in `R` and flow-monitored. |
| `expected.governanceSafe` | unset | Governance Safe address (alias `governanceSafe`). |
| `expected.guardian` | unset | Expected `Manager.guardian()` (address or alias). |
| `expected.fundingOperators` / `recallOperators` | unset | Each must stay enabled (`state-manager.*-operator`) and hold no Timelock role. |
| `expected.timelockDelaySec` | unset | Expected `getMinDelay()` (72 h = `259200`). |
| `expected.timelockRoles.admins` / `proposers` / `executors` / `cancellers` | unset | Holders that must have each role (addresses or aliases). Each list is optional. |
| `expected.tokenOwner` | see defaults | Token `owner()`. |
| `expected.tokenPaused` | `false` | Expected `paused()`. |
| `expected.poolOwner` | see defaults | `owner()` of every watched pool. |
| `expected.registryAdmin` | see defaults | Registry administrator of SAHARA. |
| `expected.rebalancer` | see defaults | Pool `getRebalancer()`. `adapter` = the adapter registered for that pool. |
| `expected.rateLimitAdmin` | see defaults | Pool `getRateLimitAdmin()`. |
| `expected.onRamp` | unset | Router `getOnRamp(remote selector)`. Pin it to be alerted on lane upgrades. |
| `expected.offRamps` | unset | Exact set of Router OffRamps for the remote selector. |
| `expected.rateLimits.outbound` / `inbound` | unset | `{enabled, capacity, rate}` (whole tokens, tokens per second) for the remote chain. A lockdown or a disabled bucket alerts regardless. |
| `limits.budgetLowPct` | `20` | Budget available below this percentage of capacity raises a warning. |
| `limits.largeTransfer` | unset | A single bridge lock or release at or above this raises a warning. |
| `limits.outflowWindowSec` | `3600` | Sliding window for pool outflows. |
| `limits.outflowWindowAmount` | unset (window off) | Pool outflow within the window at or above this raises `flows.outflow-window` (high). |
| `limits.inflowMergeSec` | `600` | Unexplained inflows from outside the reserves to one endpoint within this many seconds of an alerted one are merged into one summary (see [Flows](#flows)). `0` alerts each on its own. |
| `ccip.enabled` | `true` | Track SAHARA CCIP messages (needed for `I`, failed and stuck messages). `false` makes reconciliation blocking-incomplete, and open `<chain>:ccip:*` conditions are dropped at the next start. Being an operator choice, it stays the `reconcile.incomplete` warning and does not count toward `health.reconcile-stale`. Turning it on again leaves the blocks scanned meanwhile as a gap, which keeps reconciliation INCOMPLETE until the daemon has replayed it (see [Skipped CCIP blocks](#skipped-ccip-blocks)). |
| `ccip.stuckAfterSec` | `7200` | A message sent from this chain and not executed after this long raises `reconcile.stuck-message`. |

An `expected` entry that is unset is not asserted, with one exception: the Manager-dependent defaults below.

### Address aliases and Manager-dependent defaults

`expected.guardian`, `tokenOwner`, `poolOwner`, `registryAdmin`, `rebalancer`, `rateLimitAdmin` and the
`timelockRoles` lists accept an address or an alias. Aliases are resolved against the live deployment every cycle:

| Alias | Resolves to |
| --- | --- |
| `timelock` | `contracts.timelock`, else `Manager.owner()` |
| `manager` | `contracts.manager` |
| `controller` | `contracts.controller`, else the registered pool spec's `rateLimitAdmin` |
| `adapter` | The adapter registered in the Manager for the pool being checked (nothing is asserted if none is registered) |
| `governanceSafe` | `expected.governanceSafe` |
| `zero` | `address(0)` |

An alias whose contract is unknown (e.g. `timelock` before a Manager exists and without `contracts.timelock`) asserts
nothing.

Once `contracts.manager` is set, these defaults apply to every entry you leave unset:
`tokenOwner`, `poolOwner` and `registryAdmin` = `timelock`; `rebalancer` = `adapter`; `rateLimitAdmin` = `controller`.

### Before, during and after the handover

Today the legacy project multisig `0x6601ee913f8b431F300120Dc0FFDee670Ba4e109` owns the pool and the token and
administers SAHARA in the TokenAdminRegistry. `0xd3B8d71d8Dd31288c7E60B1aF082846601020F22` is the pool rebalancer and
`rateLimitAdmin`. This holds on both chains (see the fork tests' pre-handover assertions in
`test/fork/ForkLiquidity.t.sol`).

1. **Before the Manager is deployed** (`contracts.manager` unset). No defaults apply. Pin today's holders so any
   change alerts:

   ```yaml
   expected:
     tokenOwner: "0x6601ee913f8b431F300120Dc0FFDee670Ba4e109"
     poolOwner: "0x6601ee913f8b431F300120Dc0FFDee670Ba4e109"
     registryAdmin: "0x6601ee913f8b431F300120Dc0FFDee670Ba4e109"
     rebalancer: "0xd3B8d71d8Dd31288c7E60B1aF082846601020F22"
     rateLimitAdmin: "0xd3B8d71d8Dd31288c7E60B1aF082846601020F22"
   ```

   With `rebalancer` pinned and no adapter registered, `LiquidityAdded`/`LiquidityRemoved` by that rebalancer alert
   as high (`pool.liquidity`) instead of critical.

   List every wallet that holds SAHARA reserves on the chain in `reserves.legacyWallets` (or `extraEndpoints`) now,
   before reconciliation runs. Without them `R` is only the pool balance and `reconcile.backing` reports a false
   critical breach (see [Quick start](#quick-start)).
2. **Manager deployed, handover not executed.** Set `contracts.manager`, `contracts.timelock` and
   `contracts.controller`, so that the Timelock queue, including the handover batch, is decoded with the Manager ABI.
   Keep the five entries above and the reserve wallets from phase 1. Without the five entries, the defaults
   immediately raise critical conditions for every one of them. Expected conditions in this window:
   - `state-manager.verify-handover` (critical) until the Timelock owns the token and administers the registry;
   - after the legacy MultiSend (handover step 1), `state-registry.pending-admin` (critical) until the Timelock batch
     runs `acceptAdminRole`. Update `tokenOwner: timelock` and `rateLimitAdmin: controller` once step 1 is in.
   - The handover batch itself is a critical `timelock.scheduled`. Compare it call by call with the `Handover`
     script's plan.
3. **After the Timelock batch executes.** Remove the five overrides so the defaults apply. Set `expected.guardian`,
   the operators and `timelockRoles`. Keep the legacy wallets in `reserves.legacyWallets` until their reserves are
   migrated (handover step 3; each transfer to the Manager appears as an info `flows.reserve-migration`). Remove a
   wallet only once it is empty: its balance leaves `R` with it.

### Acknowledged obligations

Some obligations never settle where the monitor can see them. They stay counted in `I` (as "uncertain") and keep
`reconcile.incomplete` ("uncertain") open, however old:

- a lock on a watched pool without a matching CCIP message;
- a bridge transaction whose receipt cannot be fetched, so its pool log cannot be tied to its message. Its receipt is
  looked up again at every scanned chunk (at most 10 transactions per chunk, the least tried first) and never given
  up;
- a message sent to a chain selector that is not configured.

Once the operator has checked one of them (e.g. in the [CCIP explorer](https://ccip.chain.link)), list it in
`reconciliation.acknowledged`:

```yaml
reconciliation:
  acknowledged:
    - chain: ethereum      # the chain of the transaction
      txHash: "0x<64 hex digits>"
      note: "Released on BSC in 0x…, checked in the CCIP explorer on 2026-10-28"
    - chain: bsc           # the chain the message was sent from
      messageId: "0x<64 hex digits>"
      note: "…"
```

- **By `txHash`** (`chain` = the chain of the transaction): a lock without a matching message, or a bridge
  transaction whose receipt cannot be fetched.
- **By `messageId`** (`chain` = the chain the message was sent from): a message to a chain selector that is not
  configured.
- **Validation.** Exactly one of `txHash` and `messageId`, 32 bytes of hex (`0x` and 64 hex digits, any case), and a
  non-empty `note`.
- **Effect.** An acknowledged item is listed in the `check` report as `[acknowledged: <note>]`. It is not counted in
  `I`, in "uncertain" or in the report's entry count, and it does not keep `reconcile.incomplete` open.
- **Limits.** Pending or failed messages to configured chains, and gaps, cannot be acknowledged: they clear once the
  monitor sees them settle or scans the blocks. An entry that matches nothing is ignored without a warning, so a
  mistyped hash leaves the item counted.
- **Receipt lookups continue.** If an acknowledged transaction's receipt is fetched later, its real message takes
  over and is counted or settled like any other.

### RPC requirements

- **`eth_getLogs` over `maxLogRange` blocks**, with address arrays and topic OR-arrays. A range the provider rejects
  is halved, down to single blocks. This costs requests and time. Splitting is depth-first: on a provider that
  rejects every request (rate limit, outage), the first single block fails after a few dozen requests. If a single
  block fails, the scan stops, the cycle fails and is retried with backoff (the poll interval, doubled per failure,
  at most 5 min). Free public endpoints usually reject large ranges. In our tests `eth.drpc.org` accepted
  about 100 blocks, `bsc-dataseed` rejected 5000 and `1rpc.io` allowed 50. Use a provider or node that serves the
  configured range, and set `maxLogRange` to what it allows (paid providers usually allow 2000 or more).
- **`eth_call` at recent blocks.** State rules read at the confirmed head. Reconciliation reads balances at the
  `finalized` block, or at the confirmed head if the tag is not supported. The node must keep state for recent blocks,
  not only the latest one. Reads that keep failing (a pruned node, a rate limit, a view that reverts) make the chain
  stale after `staleAfterSec` (see `<state-rule>.read-failed` in [Live-state checks](#live-state-checks)).
  Reconciliation's `balanceOf` and `totalSupply` reads at the finalized block can fail while the reads at the
  confirmed head work. They block reconciliation and raise `health.reconcile-stale` after
  `reconciliation.staleAfterSec` (see "Blocked runs" in [CCIP and reconciliation](#ccip-and-reconciliation)).
- **Block timestamps.** The CCIP rule reads the timestamp of each forward chunk's last block
  (`eth_getBlockByNumber`), which drives the pruning of settled messages. If it fails, pruning waits (warn log
  `ccip: block timestamp unavailable, pruning waits`).
- **History for skipped CCIP blocks.** The replay of [skipped CCIP blocks](#skipped-ccip-blocks) needs `eth_getLogs`
  for old blocks and the Router's ramps (`eth_call`) at each replayed chunk's last block. A node without that state
  logs `ccip: Router ramps unreadable at a gap's block, using the known ramps`. The replay then watches the known
  ramps (the stored ones and `expected.offRamps`) and the OffRamps the Router listed at the gap's two ends, which
  are stored with the gap when it is recorded. It misses only a FAILURE on an OffRamp the Router listed solely
  inside the gap, or any FAILURE on an OffRamp the Router has since removed in a gap stored by an earlier version
  (without those OffRamps): that message counts in `I` as pending, not failed. An archive RPC avoids this. So does
  listing that OffRamp in `expected.offRamps` while the gap is replayed, which also raises `state-router.off-ramps`
  as long as the Router does not list it.
- **Request pattern.** Up to 4 `eth_getLogs` requests run in flight per scan. Other reads use JSON-RPC batches of up
  to 10 calls.
- **Fallback URLs.** Each URL gets `rpcRetryCount` retries and `rpcTimeoutMs` per attempt before the next URL is
  tried. The fallback is sticky: requests start at the URL that answered last. A hung primary therefore costs
  `(rpcRetryCount + 1) × rpcTimeoutMs` once, not on every request. A recovered primary is used again only after the
  current URL fails. The worst case for one request is `len(rpcUrls) × (rpcRetryCount + 1) × rpcTimeoutMs`, and a
  cycle makes many sequential request rounds. Keep `staleAfterSec` well above that.
- **Secrets.** The path, query and password of every RPC URL are redacted from logs. A key embedded in the hostname is
  not redacted, so use providers that put the key in the path or query.

## startBlock and the state file

**First start.** On a chain with no stored cursor, `h` is the confirmed head.

- If `startBlock` is set and `<= h`, the daemon runs a targeted, muted backfill:
  1. It runs only the Timelock rule (`timelockEventsRule`) and the CCIP rule (`ccipEventsRule`) over
     `[startBlock, h]`, in `maxLogRange` chunks.
  2. Alerts are muted: event alerts are counted, not sent, and no condition is opened or resolved.
  3. Progress (`backfill.next`) is saved after each chunk, so a crash resumes where it stopped.
  4. Then the cursor becomes `h` and normal processing starts at `h + 1`.
- Without `startBlock`, the cursor starts at `h − 1`. The first normal range is `[h, h]` and nothing earlier is
  tracked.

**While the backfill runs.** The whole backfill runs inside the chain's first cycle. Muting covers only the event
alerts of the replayed rules; health alerts are not muted. Until the backfill completes:

- no other event rule and no state rule runs for that chain, so the chain is not monitored;
- `health.stale-telemetry` fires once the backfill outlasts `staleAfterSec`. While the backfill keeps progressing it
  stays at warning (it is expected on every fresh deployment); once a backfill cycle fails it escalates as usual
  (high; critical after 3 × `staleAfterSec`). Its "Backfill" field reads "first-start backfill in progress at block
  X of Y". The alert is accurate: the chain really is unmonitored. Its note asks the Guardian to `pauseRecall()`,
  which can only matter once a Manager exists;
- `/healthz` returns 503, so Docker marks the container unhealthy after its 120 s start period;
- no heartbeat is sent, so the dead-man's switch fires;
- `health.started` waits until every chain has its starting cursor, and reconciliation does not start.

A backfill from near the Timelock deployment takes minutes. One from an old CCIP failure, or from `startBlock: 0`,
can take hours with a small `maxLogRange`. Plan the first start: do it before the alerts are relied on and tell the
on-call, pause the dead-man's switch, or start with a larger `staleAfterSec` and lower it once `health.started`
arrives. A restart during the backfill resumes from `backfill.next`.

The backfill is targeted because replaying all history would page every historical critical and high event. What has
to be known from history is the set of pending Timelock operations and CCIP messages. After the backfill, whatever of
that history is still open surfaces through conditions:

- the Timelock queue rule raises `timelock-queue.soon` and `.ready` or `.blocked` (with the cancel instruction) for
  pending operations;
- reconciliation raises `reconcile.failed-messages` and `reconcile.stuck-message`.

The start-up message (`health.started`) lists, per chain:

- the starting cursor;
- the backfill range, or "no backfill: Timelock proposals and CCIP messages before block N are not tracked – set
  startBlock" (and a `startBlock` above the confirmed head, which is ignored);
- the CCIP blocks not scanned yet, if any (see [Skipped CCIP blocks](#skipped-ccip-blocks));
- the number of pending Timelock operations known;
- the number of suppressed historical event alerts.

It also lists a reconciliation that was blocked when the process stopped ("Reconciliation", see Restarts below), and
the open conditions dropped at this start because no rule evaluates them any more (see Lifecycle under
[Delivery behaviour](#delivery-behaviour-srcalertstelegramts-srcalertsmanagerts)).

`check` shows the pending operations count and the next ETA. The next ETA reads "(executable now)" once it has
passed, even for an operation still blocked by its predecessor. A pending operation more than 24 h from its ETA raises
nothing until it enters the 24 h window. To see its full `timelock.scheduled` alert and cancel calldata now, run
`scan` over its scheduling block.

**Choosing `startBlock`.** Use the earliest of these blocks:

- the Timelock deployment block (or the block of the oldest proposal that may still be pending);
- the send block of any SAHARA CCIP message that may still be in flight or failed.

Failed messages wait for manual execution indefinitely. Check the [CCIP explorer](https://ccip.chain.link) for open
failures on both pools before choosing the block. The backfill costs about
`(h − startBlock) / maxLogRange` `eth_getLogs` rounds per chain, more where the provider rejects ranges and they are
split. The same span of time is many more blocks on BSC than on Ethereum. See "While the backfill runs" above for
what to expect until it completes.

**Keep the state file.** It holds the scan cursors, open conditions and sent-alert keys, alerts not delivered yet and
which alert targets are failing, pending Timelock operations, CCIP send and execution records and the blocks not
scanned for them, the outflow window, the conditions carried over failed reads, since when state reads and CCIP gap
replays have been failing, and since when reconciliation has been blocked. Back it up together with the config. Run
one daemon per state file. `check` opens it read-only and can run next to the daemon.

**Restarts.** The daemon resumes from the stored cursor. The RPC's confirmed head may be below the cursor, for
example on a lagging or syncing node or after a provider change. Then nothing is scanned and the state rules do not
run until the node reaches the cursor. Their open conditions are kept, not resolved. The chain does not count as
caught up, so it turns stale after `staleAfterSec`. A `health.stale-telemetry` condition that was open at the
restart stays open at its severity: no "resolved" message and no downgrade from critical to high, while the RPC is
down or its head is still at or below the stored cursor. It resolves only after a catch-up to a head above the
cursor.

Failed state reads and failed CCIP gap replays also keep counting from their first failure, not from the restart. If a
stored failure is older than `staleAfterSec`, `/healthz` returns 503 before the first cycle. Nothing is sent on
resume: an open `<rule>.read-failed` condition keeps its severity, escalates from its stored age at the next state
check, and resolves only when the reads succeed. Stored read failures of state rules that no longer exist are dropped
at start. Alerts not delivered before the process stopped are sent first, and an alert target that was failing stays
failing until it delivers (see [Delivery behaviour](#delivery-behaviour-srcalertstelegramts-srcalertsmanagerts)).

A blocked reconciliation keeps counting the same way, from the start of its first blocked run and through the downtime.
The carried age counts at once for `/healthz` (503 before the first run if it is already over
`reconciliation.staleAfterSec`), the heartbeat, `sahara_monitor_reconcile_stale` and
`sahara_monitor_reconcile_blocked_seconds`, and the start-up message lists it ("Reconciliation"). The alert itself is
raised, escalated or resolved only by the first reconciliation run of the new process, which waits until every chain has
caught up. Until then an open `health.reconcile-stale` stays as it was, with its reminders, and nothing is sent at
start-up. If that run is still blocked, the carried age counts at once: past the limit it pages (high, or critical past
3 × the limit; nothing new if the condition is already open at that severity). If it completes, nothing is sent, or a
real "resolved" if the condition was open. With `reconciliation.enabled: false` the stored age is cleared and an open
`health.reconcile-stale` is dropped without a "resolved" message (listed under "Open conditions dropped"). The same drop
happens when the condition is open but the state file holds no blocked age (an older or edited state file).

**If it is lost,** the next start is a first start again:

- cursors restart from `startBlock` (muted backfill) or from the head;
- open conditions are opened again as new, with new firing messages;
- the 7-day event dedupe is gone. A muted backfill sends no event alerts, but health alerts are not muted (see "While
  the backfill runs");
- pending Timelock operations and CCIP messages are known again only if `startBlock` still precedes them. Messages
  before the new first scanned block are invisible to `I`;
- until the CCIP rule has scanned a range, `check` reports reconciliation INCOMPLETE ("no blocks scanned for CCIP
  messages yet"). The daemon does not reconcile before every chain has caught up, by which time it has;
- kept reconciliation conditions are forgotten, and a blocked reconciliation counts again from its next blocked run;
- alerts not delivered yet are lost, and so is the failing state of the alert targets.

### Skipped CCIP blocks

Blocks the CCIP rule did not process, for example while `ccip.enabled` was false, are a gap in its coverage. Only the
CCIP rule can have gaps: the daemon cursor only moves over contiguous ranges, and every other rule, the Timelock rule
included, runs on every chunk. When a forward chunk finds a gap, the warn log `ccip: blocks skipped between scans;
reconciliation is incomplete until they are scanned` records it.

What was sent or executed in a gap is unknown, so `I` cannot be bounded:

- Reconciliation is INCOMPLETE with the blocking reason "`<chain>`: blocks A–B were not scanned for CCIP messages;
  what was sent or executed there is unknown until they are scanned": no `I`, no margin, and an open
  `reconcile.backing` is kept, not resolved.
- A gap never expires. It clears only when its blocks are scanned. Gaps stored by an earlier version, which were
  non-blocking then, are blocking too, and are replayed.
- A gap does not count toward `health.reconcile-stale`: a replay that progresses can take hours and never pages. One
  that keeps failing raises `health.ccip-gap-replay` (see Failures below).
- The gap stores the OffRamps the Router listed at its two ends. Its replay watches them also when the RPC no longer
  serves the Router's state there, or when the Router dropped them before a replayed chunk's last block (see
  [RPC requirements](#rpc-requirements)).

The daemon replays gaps by itself:

- **When.** Only on chains with `ccip.enabled`, and only in a cycle whose forward scan reached the confirmed head,
  after the state checks, so live blocks keep priority. Only the CCIP rule replays them.
- **How much.** Lowest blocks first, at most 5 `maxLogRange` chunks per cycle. No chunk starts 30 s after the replay
  began, and a chunk's `eth_getLogs` sends no new request 30 s after the chunk started (requests in flight finish);
  such an error reads "eth_getLogs failed at blocks X-Y (stopped) for …". The live scan therefore waits at most about
  60 s, plus one round of requests in flight, per cycle.
- **Muted.** Like the first-start backfill, the replay raises no `ccip.message-failed` or other alert for history.
  Failed or stuck messages found there are reported by reconciliation (`reconcile.failed-messages`,
  `reconcile.stuck-message`). Pools are those resolved at the current head, as for the first-start backfill.
- **Progress.** The replayed blocks leave the gap in `ccip:scan:<chain>`, saved with the state file. Logs: debug
  `ccip: replayed skipped blocks` (`from`, `to`, `chunks`, `remainingGaps`), then info `ccip: every skipped block
  replayed; reconciliation can complete`.
- **Visibility.** The start-up message lists, per chain, "CCIP blocks not scanned yet (replayed muted in the
  background; reconciliation is incomplete until done): 400–600, 650–650 (202 blocks)". This includes the restart
  right after `ccip.enabled` is turned on again: the blocks between the CCIP cursor and the daemon cursor are listed
  before the first forward chunk records them as a gap. `/healthz` shows them as `ccipGaps`, and the daily summary as
  "CCIP blocks not scanned yet".
- **Duration.** About gap blocks / `maxLogRange` / 5 cycles. With `maxLogRange: 500` and a 15 s poll interval, two
  weeks of Ethereum (about 100k blocks) take about 10 minutes. Two weeks of BSC (about 1.6M blocks) take about 2.7
  hours, during which reconciliation stays INCOMPLETE.

**Failures.** A chunk that fails logs the warning `ccip: replay of skipped blocks failed, retrying with backoff`
(`from`, `to`, `failures`, `retryInMs`, `error`) and sets `ccipGapError` in `/healthz`. It does not fail the cycle (no
cycle backoff, no `health.stale-telemetry`). That gap is retried after the poll interval, doubled per failure in a row
up to 5 minutes, and only after the gaps that do replay, so one gap an RPC cannot serve does not hold up the others.
Once a replay has failed for more than `staleAfterSec`, counted from its first failure (also across restarts),
`health.ccip-gap-replay` fires (high; critical after 3 × `staleAfterSec`) and the chain counts as stale: `/healthz`
returns 503 and the heartbeat is withheld. A gap replayed on a node without archive state can miss failures (see
[RPC requirements](#rpc-requirements)).

## Rule catalog

Every alert carries `rule <id>` in its footer. Alert keys (in logs and the `alerts` state namespace) use the rule
family, not the dotted id. The families are `manager`, `controller`, `pool`, `token`, `registry`, `router`, `timelock`,
`flows` and `ccip` for events. Conditions also use `timelock-queue`, `health` and the state rule ids (e.g.
`state-pool`). Keys have these forms:

- events: `<chain>:<family>:<txHash>:<logIndex>`;
- Timelock events, per scheduling:
  - `<chain>:timelock:scheduled:<id>` for the first scheduling of an id, and `<chain>:timelock:scheduled:<id>:<txHash>`
    for a re-schedule of an id cancelled in an earlier transaction;
  - `<chain>:timelock:scheduled:<id>:<txHash>:<n>` for the n-th later scheduling (n >= 1) of an id within one
    transaction (schedule, cancel and schedule again in one Safe multiSend);
  - a proposal the monitor could not decode: `<chain>:timelock:scheduled:<id>:<txHash>`, with the same `:<n>` suffix
    for n >= 1;
  - a replayed chunk reuses the keys the transaction's schedulings were first alerted under (the first one is stored
    with the operation, the later ones follow from the transaction hash and their ordinal);
  - `<chain>:timelock:executed:<id>`;
- conditions: `<chain>:<family>:<subject>`, e.g. `<chain>:timelock-queue:<id>:ready`,
  `<chain>:health:stale-telemetry`, `<chain>:health:ccip-gap-replay`, `<chain>:state-pool:<pool>:owner`,
  `<chain>:<state-rule>:read-failed`;
- reconciliation: `global:reconcile:backing`, `…:failed`, `…:incomplete`, `…:supply:<chain>`, `…:stuck:<messageId>`,
  and `global:health:reconcile-stale` for blocked runs;
- start-up and daily summary: `global:health:started:<ms>`, `global:health:daily-summary:<date>`. Digests and test
  messages use `digest:…` and `test-alert:…`.

Kinds:

- **event**: sent once per key;
- **condition**: open while it holds; reminded and resolved.

Alerts that name addresses link to the block explorer.

### Manager and Guardian

| Rule | Kind | Severity | Meaning | First action |
| --- | --- | --- | --- | --- |
| `manager.guardian-action` | event | high | A Guardian restriction ran. The alert names the `LiquidityManager` function behind the `GuardianAction` and the configuration event it emitted. A `(0, 0)` budget reduction (`reduceAggregateFundingBudget`, `reducePoolFundingBudget` or `reduceRecallLimits` to capacity 0 and rate 0) adds a "Capacity before" field: the budget's capacity at the block before the event, or "unknown (read failed)". A replay of old blocks on a node without archive state can give "unknown". The note depends on it. Capacity > 0: the budget stays configured, and a Timelock restore starts empty and refills at its rate. Capacity 0: the budget was probably never configured, so cancel a queued first configuration instead (it would start full). Unknown: both. | Confirm with the Guardian Safe signers. Undoing it needs a Timelock operation. See [Guardian reduced a never-configured budget](#runbook-mapping). |
| `manager.config` | event | **Critical**: `GuardianSet`, `PoolSpecSet`, `AdapterRegistered`, `AdapterReplaced`, `ReservesMigrated`, `OwnershipTransferStarted`, `OwnershipTransferred`, `PoolMigrationApprovalSet` with a non-zero source, an operator granted. **High**: everything else. **Critical whenever** the Timelock is known but the transaction has no matching Timelock `CallExecuted`. | An owner (Timelock) configuration change, with the Timelock operation id; a call of a batch is numbered as in `timelock.executed` ("Timelock operation (call 4/12)"). Operator roles that `setGuardian` revokes from the new Guardian are folded into the `GuardianSet` alert. | Match it with the reviewed `timelock.executed`. "Changed outside the Timelock": check `Manager.owner()` now. |
| `manager.funded` / `manager.recalled` | event | info | `fund`/`recall` executed (amount, pool, adapter, operator). | None if the operator and amount are expected. |
| `controller.proposal-cancelled` | event | high | The Guardian cancelled a Timelock operation through the GuardianController. The operation is described if it was tracked. The same transaction also raises `timelock.cancelled`, attributed to the Guardian, which lists any pending operations the cancellation stalls. "Was executable at" is the ETA of the scheduling it cancelled, also when the id was scheduled again in the same block range. | If it was not an agreed cancellation, the Governance Safe re-proposes it. A cancelled Guardian change is re-proposed as a single protected `setGuardian` call with predecessor 0, the one form the Guardian cannot cancel (the note says so). |
| `controller.lockdown` | event | critical | The Guardian locked down a pool for a remote chain (both buckets enabled, capacity 0, rate 0). The pool's own rate-limit event is folded in. | The bridge is halted on that lane. Restoration needs a Timelock `setChainRateLimiterConfig`, which restarts the buckets empty. |

### Timelock queue

| Rule | Kind | Severity | Meaning | First action |
| --- | --- | --- | --- | --- |
| `timelock.scheduled` | event | Highest severity of its calls (see below). At least high for a protected `setGuardian` with a non-zero predecessor and for `setGuardian` calldata that is not protected. Critical when the operation id does not match the logged calls, or when the monitor could not decode it. | A proposal was scheduled. The alert shows the id, ETA, how it was scheduled, every decoded call with warnings (value attached, non-canonical calldata), the predecessor, the salt and the cancel instruction. A transaction that schedules, cancels and schedules the same id again is alerted in log order (scheduled, cancelled, scheduled), one alert per scheduling, and the operation is stored in its on-chain end state: pending, with the live scheduling's delay, ETA and cancel calldata, and its `timelock-queue` reminders. A scheduling cancelled later in the same transaction keeps its normal severity; its title ends with " (cancelled in the same transaction)" and, instead of the cancel instruction and note, it has the field "Status: Cancelled later in this transaction: not pending, nothing to cancel". | Review every call before the ETA. If it is not expected, the Guardian Safe sends the cancel transaction from the alert. |
| `timelock.cancelled` | event | critical if the operation contains `setGuardian` or was protected, or if a pending operation that names it as predecessor is a protected `setGuardian` or contains `setGuardian` (title suffix "(stalls a pending Guardian recovery)"); else high | A proposal was cancelled, by the Guardian (via the GuardianController) or by a `CANCELLER_ROLE` holder directly. Every pending operation whose predecessor is the cancelled id is listed as "Stalls pending operation" (id and summary). The note then explains that OpenZeppelin reverts their `execute` with `TimelockUnexecutedPredecessor` until the predecessor is executed. A cancelled predecessor must therefore be scheduled again, with the same calls and salt, and executed first. For a stalled Guardian recovery it adds that the Guardian can cancel a re-proposed predecessor again, so the recovery must be re-proposed with predecessor 0. A cancelled operation that contains `setGuardian` gets a note to re-propose it as a single protected call (`LiquidityManager.setGuardian(newGuardian)` alone, value 0, predecessor 0); in any other form the Guardian can cancel it again. | Confirm it was agreed. A cancelled Guardian replacement, or a cancelled predecessor of one, is what a compromised Guardian would do. |
| `timelock.executed` | event | critical if the operation was critical, else high | An operation executed. The calls are decoded from `CallExecuted`, so operations scheduled before monitoring started are still described. | Confirm it is the proposal that was reviewed. |
| `timelock.delay` | event | critical | `MinDelayChange`. | Confirm it was an agreed `updateDelay`. |
| `timelock.role` | event | critical | `RoleGranted`, `RoleRevoked` or `RoleAdminChanged`, with the role named. | Confirm it was an agreed Timelock operation. Check `state-timelock`. |
| `timelock-queue.soon` | condition | The operation's severity one level lower (critical → high, otherwise warning) | A pending operation becomes executable within 24 h. Repeats the cancel instruction. | Final review window. |
| `timelock-queue.ready` | condition | the operation's severity | A pending operation is executable now: its ETA passed, and its predecessor is 0 or executed. | Governance executes it, or it is cancelled. |
| `timelock-queue.blocked` | condition (`<chain>:timelock-queue:<id>:blocked`) | the operation's severity | Raised instead of `.ready`: the ETA passed ("Executable at" shows "(ETA passed)"), but the non-zero predecessor is not executed, so `execute` reverts. The "Predecessor" field gives its id and state: "not scheduled: cancelled or never proposed", "scheduled, not executable yet" or "executable, not executed yet". It carries the usual cancel fields and note. A normal chained operation also passes through this state: when its predecessor executes, `.blocked` resolves and `.ready` fires, so expect two messages. If the predecessor's state cannot be read, the operation is reported as `.ready` and `.read-failed` lists `<predecessor> (predecessor of <id>)`. | Execute the predecessor first. A cancelled predecessor must be scheduled again with the same calls and salt. A stalled Guardian recovery is re-proposed with predecessor 0. |
| `timelock-queue.read-failed` | condition | warning after `alerts.transientFailureGraceSec`; high after `staleAfterSec`, critical after 3 × `staleAfterSec` (as `<state-rule>.read-failed`) | `getOperationState`/`getTimestamp` of an operation, a block timestamp or a predecessor's state could not be read. "Failed reads" lists `block N timestamp`, `<id>` and `<predecessor> (predecessor of <id>)`. The failure age is tracked per read. Operations are evaluated against their stored ETA. | Check the RPC. Once high, treat it as stale telemetry (see [Live-state checks](#live-state-checks)). |

**Severity of a proposal.** Each call is decoded against the ABI of its target and classified:

- **Critical calls:**
  - these Manager functions: `setGuardian`, `migrateReserves`, `transferOwnership`, `acceptOwnership`,
    `registerAdapter`, `replaceAdapter`, `setPoolSpec`, `setPoolMigrationApproval`, `setFundingOperator`,
    `setRecallOperator`;
  - every call to a pool, the registry, the token, the Timelock itself (`updateDelay`, roles), the GuardianController,
    an adapter, the Router or an unknown target;
  - any call with value > 0;
  - an unrecognised selector;
  - arguments that do not decode;
  - an empty operation.
- **High calls:** every other Manager function.

**Cancel instruction.** The alert contains one of these, depending on the operation:

- **Normal operation.** A "Guardian action" line (call `GuardianController.cancel(address,uint256,bytes,bytes32,bytes32)`
  or `cancelBatch(address[],uint256[],bytes[],bytes32,bytes32)` with value 0 before the ETA), followed by
  `Cancel tx: to` (the GuardianController) and `Cancel tx: calldata` (the ABI-encoded call). Once the ETA has passed
  (`timelock-queue.ready` and `.blocked`) the line and the note say to cancel now: OpenZeppelin cancels a pending
  operation until it is executed.
- **Protected `setGuardian`** (Manager target, value 0, exactly the 36-byte canonical calldata, single call). The
  alert says "Guardian cannot cancel (protected setGuardian); only the Governance Safe can cancel via
  Timelock.cancel(id)" and gives `Governance cancel: to` (the Timelock) and `Governance cancel: calldata`
  (`cancel(id)`). The GuardianController would revert `ProtectedOperation`.
- **No cancel calldata possible** (no GuardianController resolved, or an operation id that does not match its calls).
  The alert gives only the governance cancel, and says why.

How the Guardian Safe uses the calldata:

1. Create a custom transaction to the `to` address, with value 0 and the calldata as data.
2. Long calldata is split into parts labelled "append without separator". Join them in order.
3. Choose between `cancel` and `cancelBatch` by recomputing the operation id: a one-call `scheduleBatch` hashes
   differently from `schedule`. The controller recomputes the id from the arguments, so wrong calldata reverts and
   cannot cancel anything else.

**Guardian recovery (`setGuardian`).** These cases are flagged in the alert:

- **Protected, predecessor 0.** Title "Guardian recovery scheduled on Timelock (protected setGuardian)".
- **Protected, non-zero predecessor.** Severity at least high, with a warning: the recovery cannot execute before the
  predecessor, and cancelling the predecessor stalls it (runbook: the predecessor must be 0). Cancelling that
  predecessor later raises a critical `timelock.cancelled` that lists the stalled recovery, and after its ETA the
  recovery shows as `timelock-queue.blocked`.
- **`setGuardian` that is not protected.** This covers a call inside a batch of several calls, value attached,
  padded calldata, dirty upper bits or a non-Manager target. Severity at least high, with a warning that the current
  Guardian can cancel this recovery.

**Replayed chunks.** A chunk is processed again when a later rule failed on it, or after a crash. The Timelock rule
then reaches the same state with the same alert keys, so nothing is alerted twice. An id cancelled and scheduled
again, in one transaction (e.g. to change its delay) or in two transactions of the chunk, stays pending with its
reminders.

### Pool, token, registry and Router configuration

| Rule | Kind | Severity | Meaning | First action |
| --- | --- | --- | --- | --- |
| `pool.liquidity` | event | critical; high when no adapter is registered for the pool and the provider is `expected.rebalancer` | `LiquidityAdded`/`LiquidityRemoved` by anyone but the pool's adapter. Adapter moves are covered by `manager.funded`/`recalled`. | Someone else holds the rebalancer role: check `getRebalancer()` and the Timelock queue. |
| `pool.config` | event | critical | `LiquidityTransferred`, `RebalancerSet`, `RateLimitAdminSet`, `RouterUpdated`, `ChainAdded` (with its remote pools), `ChainRemoved`, `RemotePoolAdded`/`Removed`, `OwnershipTransferRequested`/`Transferred`. Attributed to a Timelock operation when one executed it. | Match it with a reviewed Timelock operation. Otherwise treat it as a compromise of the pool owner. |
| `pool.rate-limits` | event | high | Rate-limit change (`ChainConfigured`, or `ConfigChanged` alone). The title says "set to lockdown" or "disabled (unlimited)" when applicable. | Match it with the Timelock operation in the attribution field. |
| `pool.allowlist` | event | high | `AllowListAdd`/`AllowListRemove`. | Confirm it was intended. |
| `token.paused` | event | critical | SAHARA paused: every transfer reverts, including bridge settlement, funding and recall. | Contact the token owner. Expect failed CCIP messages. |
| `token.unpaused` | event | high | SAHARA unpaused. | Confirm it was intended. |
| `token.owner` | event | critical | Token ownership transferred. | Confirm it is the handover. Otherwise treat it as a compromise. |
| `registry.pool` | event | critical | `PoolSet`: the registry maps SAHARA to another pool (or none, which disables bridging). | Confirm it is a planned migration. |
| `registry.admin` | event | critical | Administrator transfer requested or completed. | Confirm it is the handover. |
| `router.ramps` | event | high | Chainlink changed the OnRamp or the OffRamps for the counterpart lane. All ramp changes in one transaction are reported as one alert. | Confirm the lane upgrade with Chainlink, then update `expected.onRamp`/`offRamps`. |
| `router.owner` | event | high | Router ownership transfer requested or completed. | Inform Chainlink and verify. |

### Flows

One alert is raised per unexplained transfer. Its severity is the higher of the sender's and the receiver's findings,
and each finding is listed as `Check (<severity>)`. Explanations count only if the Manager or a watched pool emitted
them with the exact amount, and each explanation accounts for one transfer. Zero-value transfers are ignored.

Anyone holding 1 wei of SAHARA can raise the four `*-inflow` rules, so their unexplained transfers from outside the
reserves are merged per receiving endpoint. Without merging, a flood of 10,000 dust transfers (one block, about 40M
gas) would be 10,000 high messages, and at Telegram's 20 messages per minute per chat every alert raised after them
would wait about 8 hours. With merging:

- The first such transfer to an endpoint is alerted on its own at once and opens a window of `limits.inflowMergeSec`
  (wall clock, default 10 minutes).
- Later ones to that endpoint within the window are counted, not alerted. Once the window has closed, the next scanned
  range sends one summary under the same rule and severity: the number of merged transfers, their total, the largest,
  the senders and the blocks.
- A transfer at or above `limits.largeTransfer` is always alerted on its own. So is any transfer with a reserve endpoint
  as the sender (an internal move).
- `scan` does not merge: it prints every transfer.

| Rule | Kind | Severity | Meaning | First action |
| --- | --- | --- | --- | --- |
| `flows.manager-outflow` | event | critical | SAHARA left the Manager without a matching `Funded` (to its adapter) or `ReservesMigrated`. | Treat it as a compromise. Check the token owner and `paused()`, the Manager owner, and the transaction. |
| `flows.adapter-outflow` | event | critical | SAHARA left an adapter outside `fund`/`recall`. | Inspect the transaction now. |
| `flows.pool-outflow` | event | critical | SAHARA left a pool without `ReleasedOrMinted` (bridge release) or `LiquidityRemoved`. | See [Unexpected pool outflow](#runbook-mapping). |
| `flows.pool-inflow` | event | high | Direct transfer to a pool without `LiquidityAdded`, `LiquidityTransferred` or a bridge lock. It bypasses `provideLiquidity` and increases releasable inventory outside the budgets. Merged (see above). | Identify the sender. Check reconciliation. |
| `flows.adapter-inflow` | event | high | SAHARA sent directly to an adapter. It is unrecoverable: the adapter has no rescue function. Merged (see above). | Exclude it from capacity planning. Find the sender. |
| `flows.endpoint-outflow` | event | high | Outflow from a legacy wallet or extra endpoint to anything but the Manager. | Confirm with the wallet owners. |
| `flows.approval` | event | high | An endpoint approved a spender. The only exception is the adapter's approval to its pool inside `Funded`, which is reset in the same call. | Confirm the intent and revoke the approval if it is unexpected. |
| `flows.large-transfer` | event | warning | A single bridge lock or release at or above `limits.largeTransfer`. | Check the matching leg on the other chain. |
| `flows.reserve-migration` | event | info | A legacy wallet or extra endpoint sent SAHARA to the Manager (handover step 3). | None. |
| `flows.manager-inflow` | event | info | Inflow to the Manager outside a recall. Merged (see above). | None if expected (e.g. migration). |
| `flows.endpoint-inflow` | event | info | Inflow to a legacy wallet or extra endpoint. Merged (see above) when the sender is not a reserve endpoint. | None if expected. |
| `flows.outflow-window` | condition | high | Pool outflows within `limits.outflowWindowSec` reached `limits.outflowWindowAmount`. All outflow kinds count: releases, recalls, withdrawals and unexplained. Resolves when the window drains. | Check releases against source-chain locks. If they are not backed: Guardian lockdown and `pauseRecall()`. |

### Live-state checks

The state rules run once per new confirmed head, at that head. They do not run while the RPC's confirmed head is
below the stored cursor: their open conditions are then kept, neither confirmed nor resolved (see
[Restarts](#startblock-and-the-state-file)). All of them are conditions (rule `<state-rule>.<check>`). The state rules
are `state-token`, `state-registry`, `state-pool`, `state-manager`, `state-adapter`, `state-inventory`,
`state-router`, `state-timelock`, `state-controller` and `timelock-queue`.

| Rule | Severity | Meaning |
| --- | --- | --- |
| `state-token.owner` | critical | Token `owner()` differs from `expected.tokenOwner`. |
| `state-token.paused` | critical | `paused()` differs from `expected.tokenPaused`. |
| `state-registry.admin` | critical | Registry administrator differs from `expected.registryAdmin`. |
| `state-registry.pending-admin` | critical | A registry administrator transfer is pending. `verifyHandover()` fails and `registerAdapter` is blocked. |
| `state-registry.pool` | critical | The registry maps SAHARA to no pool. Or it maps a pool not registered in the Manager (with adapters registered), or not configured (without). |
| `state-router.on-ramp` | high | Router OnRamp for the remote chain differs from `expected.onRamp`. The remote chain is each other configured chain; only a single-chain config falls back to the Manager pool spec's remote selector (a spec naming another lane is `state-pool.chains` or `state-pool.lane`). |
| `state-router.off-ramps` | high | Router OffRamps for the remote chain differ from `expected.offRamps`. Added and removed ramps are listed. |
| `state-pool.owner` / `.rebalancer` / `.rate-limit-admin` | critical | Pool authority differs from the expected one. Checked on every watched pool, retired pools included. |
| `state-pool.router` / `.type-and-version` / `.chains` / `.remote-token` / `.remote-pools` | critical | A live pool (the registry pool, or a fundable migration target) differs from its Manager pool spec. Funding fails. |
| `state-pool.lane` | critical | With more than one chain configured: a live pool's Manager spec names a remote chain that is not configured, so its CCIP messages, Router ramps and in-flight amounts are not watched. |
| `state-pool.lockdown` | critical | Live pool rate limits are enabled with capacity 0 and rate 0: the bridge is locked down. |
| `state-pool.rate-limit-disabled` | critical | Live pool bucket disabled: transfers are unlimited in that direction. |
| `state-pool.rate-limit-mismatch` | high | Live pool bucket differs from `expected.rateLimits`. |
| `state-manager.owner` | critical | Manager owner is not the configured `contracts.timelock`. |
| `state-manager.pending-owner` | critical | A Manager ownership transfer is pending. |
| `state-manager.guardian` | critical | `guardian()` differs from `expected.guardian`. |
| `state-manager.verify-handover` | critical | `verifyHandover()` reverts. The decoded custom error is shown. |
| `state-manager.verify-adapter` | critical | `verifyAdapter(id)` reverts for an adapter with funding enabled. Funding that pool fails. |
| `state-manager.budget-exhausted` | high | Aggregate funding, per-pool funding or recall budget: capacity > 0 and available 0. The time to refill is shown. Shares its key with `.budget-low`, so a partial refill is a downgrade, routed by the peak severity (see Routing). |
| `state-manager.budget-low` | warning | Available below `limits.budgetLowPct` of capacity. Capacity 0 raises nothing. The snapshot shows it as "capacity 0 (unconfigured or reduced to 0)". |
| `state-manager.funding-paused` / `.recall-paused` | warning | Funding or recall paused. Restoring it needs the Timelock. |
| `state-manager.funding-operator` / `.recall-operator` | warning | An expected operator is suspended. |
| `state-manager.adapter-funding-disabled` / `.adapter-recall-disabled` | warning | The live pool's adapter is restricted. |
| `state-adapter.allowance` | critical | An adapter (any ever registered) has a non-zero allowance to a watched pool. This should be impossible. Funding reverts with `NonZeroAllowance`. |
| `state-adapter.balance` | warning | An adapter holds SAHARA (stranded: no rescue function). |
| `state-inventory.below-minimum` | critical for the registry pool, warning for a migration target | Pool balance below `minimum`: inbound bridge releases may fail. Shares its key with `.below-trigger`, so a partial refill is a downgrade, routed by the peak severity (see Routing). |
| `state-inventory.below-trigger` | warning | Balance below `max(minimum, refillTrigger)`. "Fund up to target" shows `max(minimum, refillTarget) − balance`. |
| `state-timelock.min-delay` | critical | `getMinDelay()` differs from `expected.timelockDelaySec`. |
| `state-timelock.controller-canceller` | critical | The GuardianController lacks `CANCELLER_ROLE`: the Guardian cannot cancel proposals. |
| `state-timelock.missing-role` | critical | An expected `timelockRoles` holder lost its role. |
| `state-timelock.forbidden-role` | critical | The live or expected Guardian, or an operator, holds any Timelock role. Or the GuardianController holds ADMIN, PROPOSER or EXECUTOR. |
| `state-controller.manager` / `.timelock` | critical | GuardianController `MANAGER()`/`TIMELOCK()` is not this deployment's Manager/Timelock. |
| `<state-rule>.read-failed` (key `<chain>:<state-rule>:read-failed`) | warning after `alerts.transientFailureGraceSec`; high after `staleAfterSec`; critical after 3 × `staleAfterSec` | One or more reads of that rule failed. "Failed reads" has one line per function, counted when it failed more than once ("Timelock.hasRole(…) ×56"), at most 10 lines. Conditions open from the last cycle that the failed reads could have confirmed stay open, without a false "resolved", until the reads succeed again. Once high it is stale telemetry (see below). |

The first action for every state condition is the same. Find the transaction that changed the state (the matching
event alert, or the Timelock queue) and treat an unexplained change as a compromise of the authority involved.

**Failed reads are stale telemetry.** Every state rule counts, `timelock-queue` included: each one verifies an
authority, a role, a pause, a rate limit or lockdown, the Router's ramps, budgets and inventory, or the Timelock
queue, and none is display-only. A view that reverts after an upgrade counts the same as an RPC or transport failure,
because the monitor cannot tell a failing read from a changed subject. A view that is permanently missing is a
monitoring gap to fix.

- **Age.** Each read counts from its first failure until that read succeeds. The rule's age is that of its oldest
  failing read, so different reads failing on alternate checks do not escalate. A read the check did not make (e.g.
  one made only with a value whose read failed) keeps counting. A state rule that throws, or whose check is aborted,
  counts as every read failing. A check with no failure clears every age.
- **Escalation.** The condition is raised as a warning once its age reaches `alerts.transientFailureGraceSec` (60 s by
  default; a shorter failure sends nothing), then sent again as high once its age exceeds `staleAfterSec`
  and as critical after 3 × `staleAfterSec`, the thresholds of `health.stale-telemetry`. Each change reaches the
  high and critical routes as a new message, and the resolution is routed at the peak severity. The title does not
  change. The fields "Failing for: `<duration>` since `<time>` (limit `<staleAfterSec>`)" and "Last successful read:
  `<time>`" (or "none recorded") are added. At high and critical the note starts with "These reads have failed for
  longer than staleAfterSec: what `<rule>` verifies is unknown, which is stale telemetry. Design §5: …", which asks
  the Guardian to call `LiquidityManager.pauseRecall()`.
- **When.** The condition escalates only when the state rules run, at each new confirmed head. While the head is
  stuck, or the RPC is behind the cursor, no state check runs and `health.stale-telemetry` covers the chain.
  `/healthz`, the heartbeat and `/metrics` compute the age continuously from the stored failure start.
- **Stale chain.** Once any state rule's reads have failed for more than `staleAfterSec`, the chain is stale:
  `/healthz` returns 503 with status `stale` and the heartbeat is withheld. Reconciliation is not skipped for it: its
  own reads are fresh or fail on their own (an incomplete report).
- **A rule that throws** raises no condition and is not synced, so its open conditions stay as they were and
  Telegram hears nothing about it. It still counts as failing for `/healthz`, the heartbeat and `/metrics`, so the
  dead-man's switch fires once it has thrown for more than `staleAfterSec`.
- **`check`** is unchanged: a failed read there is a warning, with no age and no escalation.

### CCIP and reconciliation

| Rule | Kind | Severity | Meaning | First action |
| --- | --- | --- | --- | --- |
| `ccip.message-failed` | event | critical | A SAHARA message failed on the destination (the alert is raised on the destination chain), with the decoded failure reason. The SAHARA stays owed and counts in `I`. | See [Failed CCIP message](#runbook-mapping). |
| `ccip.message-executed` | event | info | A previously failed message was executed (manually). | None. |
| `ccip.ramps-unknown` | condition | warning | The Router's ramps cannot be read. Only the last known OffRamps are watched. | Check the RPC. |
| `reconcile.backing` | condition | critical | `R − I` is below `reconciliation.requiredBacking` at the snapshot blocks. Evaluated only when no blocking `reconcile.incomplete` reason exists. A reserve wallet missing from `reserves.legacyWallets` reads as a breach (the fields show each chain's reserves). | See [Backing breach](#runbook-mapping). |
| `reconcile.failed-messages` | condition | critical | One or more SAHARA messages are awaiting manual execution. One condition lists them all. | Fix the cause, then execute them manually. |
| `reconcile.stuck-message` | condition | warning | A message has no execution after the source chain's `ccip.stuckAfterSec` (one condition per message). | Check it in the CCIP explorer. |
| `reconcile.total-supply` | condition | critical | `totalSupply` on a chain differs from `requiredBacking` (the supply is fixed). | Investigate the token contract. |
| `reconcile.incomplete` | condition | warning | Title "Reconciliation incomplete" when a reason is blocking, "uncertain" otherwise. In the daemon, a run blocked only by failures (a chain unreachable, CCIP tracking not started, the CCIP scan behind) raises it only once the blocked span has lasted `alerts.transientFailureGraceSec`, so one failed run between good ones sends nothing (`check` always shows it). **Blocking** reasons: a chain is unreachable; CCIP tracking is disabled or not started; "`<chain>`: blocks A–B were not scanned for CCIP messages; what was sent or executed there is unknown until they are scanned" (a gap, see [Skipped CCIP blocks](#skipped-ccip-blocks)); or "`<chain>`: CCIP scan behind its finalized block (snapshot capped at block X, finalized Y): N release(s) on `<other>` (amount) of messages `<chain>` has not scanned yet". The last one means the counterpart already released messages whose locks are after the capped snapshot. It clears by itself once the lagging scan catches up, e.g. after a restart or a long first backfill. "finalized Y" is the confirmed head where the RPC lacks the `finalized` tag. While any blocking reason holds, the status is INCOMPLETE, `I` and the margin are unknown and an open `reconcile.backing` is kept, but `R` is still reported. The blocking reasons that are failures (a chain unreachable, CCIP tracking not started, the CCIP scan behind) escalate to `health.reconcile-stale` once the daemon's runs have been blocked for longer than `reconciliation.staleAfterSec`. CCIP tracking disabled and gaps stay this warning. **Caveats** (non-blocking, `R − I` still evaluated, never counted as blocked): bridge transactions not yet linked to their message (receipt lookups failing), locks without a matching message, ramp logs not fetched or not recorded yet ("ramp logs of blocks X–Y not fetched yet"), unreadable ramps, messages to unconfigured selectors, and "a message was released although its lock is after its source chain's snapshot block (source finalized block behind the destination's execution), subtracted from I". Items listed in `reconciliation.acknowledged` are left out of the caveats (see [Acknowledged obligations](#acknowledged-obligations)). | Blocking: treat as stale telemetry and keep recall disabled. A caveat that never clears: check it in the CCIP explorer, then acknowledge it. |

**When reconciliation runs.** The daemon reconciles every `reconciliation.intervalSec`, starting once every chain has
caught up since the start. A run is skipped while any chain has not caught up yet or its scan is stale, because
balances read from a stuck or lagging RPC are old. Failing state reads or CCIP gap replays do not skip it: its own
reads are fresh or fail on their own (an incomplete report), and a gap makes it INCOMPLETE anyway. While it is
skipped, the last report and its `global:reconcile:*` conditions stay as they are.
`sahara_monitor_reconcile_last_run_timestamp_seconds` ages and the daily summary shows the old run time. An
unreachable chain therefore shows up as `reconcile.incomplete` ("`<chain>` unreachable") only for an outage shorter
than `staleAfterSec`. A longer one skips the run and is reported by `health.stale-telemetry`. `check` always runs
reconciliation.

**Blocked runs.** A run that does happen can still be blocked by a failure while every chain is fresh. Examples are a
node that serves the confirmed head but fails `balanceOf` or `totalSupply` at the finalized block (pruned state, a rate
limit), a head read that fails for the `finalized` tag and the confirmed-head fallback alike, or a run that throws
(logged as `reconciliation failed` and counted in `sahara_monitor_reconcile_failures_total`). Such runs count as blocked
when they throw, or when they are INCOMPLETE for at least one blocking reason that is a failure: a chain unreachable,
CCIP tracking not started, or the CCIP scan behind its finalized block. `ccip.enabled: false` (an operator choice, only
the `reconcile.incomplete` warning) and CCIP gaps (a replay in progress; a failing one is `health.ccip-gap-replay`) do
not count, and caveats never block. The clock starts at the start of the first blocked run. It stops at a run that
evaluates `R − I` (ok or breach), or that is INCOMPLETE only for reasons that do not count. A skipped run neither starts
nor stops it, so a span that is open keeps growing while runs are skipped. Once the span exceeds
`reconciliation.staleAfterSec`, `health.reconcile-stale` fires (high; critical after 3×), `/healthz` returns 503 and the
heartbeat is withheld. The condition is evaluated after every run and at every health tick (30 s), once a run has
returned in this process.

**Kept conditions.** When a run cannot re-evaluate a condition, the condition stays open with a "Not re-evaluated in
the latest reconciliation" note instead of resolving. This applies to a breach while `R` or `I` is unknown (any
blocking reason) and to a supply condition while its chain is unreachable.

**Report.** `check` prints the composition of `R` and `I`. The line "I (in flight): X (N entries, M failed)" counts
the entries in `I`, without acknowledged ones. Each entry is listed with its status, e.g. `[pending]`,
`[failed: <reason>]`, `[unlinked]` or `[acknowledged: <note>]`. Acknowledged entries are listed only: they are not in
`I` or in "uncertain".

### Health and other

| Rule | Kind | Severity | Meaning | First action |
| --- | --- | --- | --- | --- |
| `health.stale-telemetry` | condition (`<chain>:health:stale-telemetry`) | high after `staleAfterSec`; critical after 3 × `staleAfterSec`; warning while a first-start backfill is progressing without failures | The chain's events and state are not being verified. Either trigger fires it. **Not caught up**: no successful cycle left the cursor at the confirmed head. An RPC whose head is below the stored cursor does not count as caught up, and the alert then shows "RPC behind: the confirmed head is N blocks below the processed block". Title "Stale telemetry: `<chain>` not caught up for X". **Head not advancing**: the confirmed head has not risen although cycles succeed, which means a stuck or lagging RPC node. Title "… head not advancing for X". Fields: last caught up, stale for, processed block, confirmed head, "Head last advanced" (after a restart with the condition open, the carried-over estimate until the head rises above the stored cursor), lag, backfill progress during a first-start backfill, failed cycles in a row, last error. Staleness counts from the start until the first catch-up. A condition open at a restart keeps its age and severity (see [Restarts](#startblock-and-the-state-file)). It covers the scan only: failing state reads escalate their own `<state-rule>.read-failed` condition, a failing CCIP gap replay raises `health.ccip-gap-replay`, and blocked reconciliation runs raise `health.reconcile-stale`. | Keep recall disabled until it resolves (design §5). Fix the RPC or the process. During a first-start backfill, see "While the backfill runs". |
| `health.ccip-gap-replay` | condition (`<chain>:health:ccip-gap-replay`) | high after `staleAfterSec`; critical after 3 × `staleAfterSec` | The replay of [skipped CCIP blocks](#skipped-ccip-blocks) has failed for longer than `staleAfterSec`, counted from its first failure (also across restarts). What was sent or executed there is unknown, so `I` cannot be bounded and reconciliation stays INCOMPLETE. Title "CCIP blocks on `<chain>` cannot be replayed for X: in-flight amount unbounded". Fields: "Blocks not scanned", "Failing for", "Failing replays" (per failing chunk: its first block, attempts and since when) and "Last error". The chain counts as stale meanwhile (`/healthz` 503, no heartbeat). Resolves once no gap replay is failing. | Keep recall disabled (design §5: the note asks the Guardian to call `LiquidityManager.pauseRecall()`). Make an RPC endpoint serve `eth_getLogs` for these blocks (full history, its range limit). |
| `health.reconcile-stale` | condition (`global:health:reconcile-stale`, no chain) | high after `reconciliation.staleAfterSec`; critical after 3 × `reconciliation.staleAfterSec` | The daemon's reconciliation runs have been blocked for longer than `reconciliation.staleAfterSec`, so `R − I` at the finalized blocks is unverified. Blocked: a run that throws, or one INCOMPLETE because a chain is unreachable (its finalized head, `balanceOf` or `totalSupply` reads fail), CCIP tracking has not started or a CCIP scan is behind its finalized block. Not counted: `ccip.enabled: false` (only the `reconcile.incomplete` warning), CCIP gaps still being replayed (a failing replay is `health.ccip-gap-replay`) and the non-blocking caveats. Counts from the start of the first blocked run and clears at a run that evaluates `R − I` or is INCOMPLETE only for reasons that do not count; skipped runs change nothing (see "Blocked runs" in [CCIP and reconciliation](#ccip-and-reconciliation)). Evaluated after every run and every health tick (30 s). Title "Reconciliation blocked for X: R − I not verified". Fields: "Blocked for" (`<duration>` since `<time>` (limit `<limit>`)), "Last complete reconciliation" (or "none recorded"), and "Blocking reasons" (the last blocked run's failure reasons, one per line) or "Last error" (when it threw). The blocked age survives a restart, downtime included; only the first run of the new process raises, escalates or resolves the condition (see [Restarts](#startblock-and-the-state-file)). | Keep recall disabled (design §5: the note asks the Guardian to call `LiquidityManager.pauseRecall()`). Check the reasons or the error: that the RPC endpoints answer `eth_call` at the finalized block (rate limits, a pruned node), `npm run check` and the monitor logs. |
| `health.started` | event | info | Start-up: per chain, the starting cursor, the backfill range (or the "no backfill" warning, or an ignored `startBlock`), the CCIP blocks not scanned yet (when there are any), the pending Timelock operations known and the suppressed historical alerts. When the state file has reconciliation blocked, a "Reconciliation" field: "Blocked for `<duration>` since `<time>` (limit `<limit>`) at the start, still counted until a run completes", then "Last error: …" or the blocking reasons. Also the open conditions dropped at this start ("Open conditions dropped (no longer evaluated: chain removed, reconciliation or CCIP disabled)"), which include a `health.reconcile-stale` open without a stored blocked age (an older or edited state file): dropped, not resolved. Sent once every chain has its starting cursor, so it waits for a first-start backfill. | Check the backfill range, the blocks still to replay, a blocked reconciliation and any dropped conditions. |
| `health.daily-summary` | event | info | Daily status at `alerts.dailySummaryUtc`: each chain's block, lag and freshness, pool inventory, budgets, pauses, the Timelock queue, the last reconciliation (with its time, which is old while runs are skipped), open conditions by severity, and deliveries per sink (", N undelivered" while messages wait for its targets, "FAILING since …" while one of them is failing). A chain's line gains segments separated by "; ": "state reads failing: `<rule>` for `<duration>`, …" ("STATE READS STALE: …" once over `staleAfterSec`) and "CCIP blocks not scanned yet: A–B (N blocks)". While reconciliation is blocked its line ends with "; blocked for `<duration>` since `<time>` (limit `<limit>`): `<reasons or error>`" ("BLOCKED" once over `reconciliation.staleAfterSec`), also after "not run yet". | Read it. |
| `digest` | event | warning or info | More than 20 info/warning messages waiting for one route (a burst, or a backlog while it was down), folded into one message for that route. Title "`<N>` info/warning alerts (digest)", with one line per alert key at its latest status (see Backlog bounding under [Delivery behaviour](#delivery-behaviour-srcalertstelegramts-srcalertsmanagerts)). | Read the listed alerts. |
| `test-alert` | event | info | Sent by `test-alert`. | None. |

## Runbook mapping

How the alerts map to the responses in the root README's runbook notes and design §5:

| Situation | Alerts | Response |
| --- | --- | --- |
| Stale telemetry | `health.stale-telemetry`; `<state-rule>.read-failed` at high or critical; `health.ccip-gap-replay`; `health.reconcile-stale`; `/healthz` 503 and no heartbeat; `reconcile.incomplete` (blocking) only for an outage shorter than `staleAfterSec`, after which reconciliation is skipped and its last report kept | In-flight obligations cannot be bounded, so recall stays disabled until telemetry recovers. Recall operators stop calling `recall`. If needed, the Guardian enforces it with `LiquidityManager.pauseRecall()`; restoring it is a Timelock `setRecallPaused(false)` (full delay). |
| Reconciliation blocked | `reconcile.incomplete` (blocking: "`<chain>` unreachable", "no blocks scanned for CCIP messages yet" or "CCIP scan behind its finalized block"), or only the log `reconciliation failed` when a run throws; then `health.reconcile-stale` (high after `reconciliation.staleAfterSec`, critical after 3×), `/healthz` 503 and no heartbeat, while every chain can be fresh | `R − I` is unverified: treat it as stale telemetry and keep recall disabled (`pauseRecall()`) until a run completes. Read "Blocking reasons" or "Last error" in the alert (or `reconcile` in `/healthz`). Usually an RPC that fails `eth_call` at the finalized block (pruned state, a rate limit): fix or add an endpoint. Run `check` to see the report. The condition resolves at the next run that is not blocked. |
| Alert delivery failing | `/healthz` 503 `delivery-failing`, no heartbeat, `sahara_monitor_alert_sink_failing{sink,target}` 1, the warn log `alert delivery failing…`; the broken route receives nothing, the other routes still do | Read `failingKind` and `lastError` of the target in `/healthz` and fix the route as in [When Telegram fails](#when-telegram-fails) (bot token, chat id, the bot's membership or rights). Its alerts are kept and delivered in order once it works, also across a restart. A `message` failure was a single message dropped for that route: the route stays failing until it delivers at that severity or above. |
| Backing breach | `reconcile.backing` | First compare each chain's reserves in the alert with the expected holdings: a breach of billions from the first run usually means reserve wallets missing from `reserves.legacyWallets`. Otherwise look for `flows.*-outflow`, `pool.liquidity` and `flows.pool-inflow` around the snapshot blocks. The Guardian pauses recalls (`pauseRecall()`) until reconciled. Re-run `check` to see the composition of `R` and `I` per chain and lane. |
| Failed CCIP message | `ccip.message-failed` (destination chain), then `reconcile.failed-messages` | Read the failure reason. `TokenHandlingError(target=<pool or token>, err=ERC20InsufficientBalance(…truncated))` means the destination pool lacks inventory: fund it (Funding Operator `fund`, within budgets), then execute the message manually from the CCIP explorer link in the alert. A rate-limit error means waiting for the bucket to refill. On OffRamp 2.0.0, a failed manual attempt reverts and leaves no log. The message counts in `I` until `ccip.message-executed`. |
| CCIP blocks skipped | `reconcile.incomplete` (blocking, "blocks A–B were not scanned for CCIP messages"), then `health.ccip-gap-replay` if the replay keeps failing | Treat it as stale telemetry: keep recall disabled until reconciliation completes. The daemon replays the blocks by itself (see [Skipped CCIP blocks](#skipped-ccip-blocks)); if it cannot, give it an RPC that serves `eth_getLogs` for them. |
| Obligation that never settles in view | `reconcile.incomplete` ("uncertain"): a lock without a matching message, a transaction whose receipt cannot be fetched, or a message to an unconfigured chain selector | Check it in the CCIP explorer. Once it has settled, list it in `reconciliation.acknowledged` (see [Acknowledged obligations](#acknowledged-obligations)). |
| Unexpected pool outflow | `flows.pool-outflow`, `flows.outflow-window`, `pool.liquidity`, `state-pool.rebalancer` | If the releases are not backed by source-chain locks, the Guardian halts the bridge with `GuardianController.lockdown(pool)` and pauses recall. Check the Timelock queue for rebalancer or owner changes. Restoring the rate limits needs the Timelock: `setChainRateLimiterConfig` starts the buckets from zero, while `applyChainUpdates` starts them full and rewrites the remote configuration, so review it or cancel it during an incident. |
| Protected `setGuardian` scheduled | `timelock.scheduled` (protected), then `timelock-queue.soon`/`.ready` | The Guardian cannot cancel it. Confirm with the Governance Safe signers. If it is unintended, only the Governance Safe can cancel it, with `Timelock.cancel(id)`; the calldata is in the alert. A non-zero predecessor or unprotected calldata is flagged: re-schedule as a single canonical call with predecessor `bytes32(0)` after checking `isProtectedCall`. A cancelled recovery, or a cancelled predecessor of one, raises a critical `timelock.cancelled`. |
| Operation blocked by its predecessor | `timelock-queue.blocked`; earlier a `timelock.cancelled` listing it under "Stalls pending operation" | `execute` reverts with `TimelockUnexecutedPredecessor` until the predecessor is executed. Execute the predecessor first. If it was cancelled, the Governance Safe schedules it again with the same calls and salt, and executes it after the delay. A stalled Guardian recovery is re-proposed with predecessor `bytes32(0)` instead, because the Guardian can cancel a re-proposed predecessor again. |
| Any other proposal | `timelock.scheduled` | Review every decoded call. If it is unexpected, the Guardian Safe sends the cancel transaction in the alert before the ETA. `timelock.executed` confirms what ran. |
| Budget low or exhausted | `state-manager.budget-low`, `state-manager.budget-exhausted` | The note gives the time to refill (refill rate 0: only a Timelock reconfiguration helps). Keepers fund up to `max(minimum, trigger)`. `state-inventory.below-trigger` already uses this, and `manager.guardian-action` for `raisePoolMinimum` repeats it. |
| Guardian reduced a never-configured budget | `manager.guardian-action` with a `(0, 0)` effect and "Capacity before" 0 | The budget stays unconfigured (snapshot "capacity 0 (unconfigured or reduced to 0)", no budget alert). Its first Timelock configuration would start it full, so cancel that queued first configuration instead (cancel calldata in its `timelock.scheduled`). With "Capacity before" above 0 the budget stays configured: a queued Timelock restore starts empty and refills at its rate, so do not cancel it for this reason. With "unknown (read failed)", check the budget's history before deciding. |
| Pool migration | `manager.config` (`PoolMigrationApprovalSet`), `registry.pool`, `state-registry.pool`, `pool.config` (`LiquidityTransferred`) | Revoke the approval in the cutover batch. After an owner-mediated `transferLiquidity`, reset the old pool's rebalancer to its adapter (`state-pool.rebalancer`). |
| Token or registry administration moved | `token.owner`, `registry.admin`, `state-manager.verify-handover` | `registerAdapter` is blocked until the Timelock holds both again. Funding, recall and `replaceAdapter` keep working. |

## CLI

```
node src/cli.ts <command> [--config <path>]      # default config: ./config.yaml
```

Logs are JSON lines on stderr. Human-readable output is on stdout.

| Command | What it does | Exit code |
| --- | --- | --- |
| `run [--dry-run]` | Starts the daemon. `--dry-run` uses the console sink only (no Telegram, no heartbeat) and an in-memory store: the state file is neither read nor written. On SIGINT/SIGTERM it stops polling, finishes the in-flight cycle, flushes alerts, cancels pending delivery retries and gives sends in progress up to 10 s, saves the store, closes the HTTP server and exits. Alerts not delivered by then stay in the state file and are delivered at the next start (warn `alerts not delivered yet are kept for the next start`, `messages`). A second signal exits at once, as a crash would (see Durability under [Delivery behaviour](#delivery-behaviour-srcalertstelegramts-srcalertsmanagerts)). | 0 on signal; 2 on a usage or config error or when it cannot start (e.g. the HTTP port is in use) |
| `check` | One-shot, read-only report. It resolves addresses, runs every state rule at each chain's confirmed head, then runs reconciliation (if enabled) against the real state file, opened read-only and never saved, with a non-delivering alerter. It prints the addresses, the snapshots, every violated condition and the reconciliation report. | 0 = no critical/high condition, 1 = at least one critical/high condition, 2 = config error, or an RPC failure while reading the head, resolving addresses or running reconciliation. Failed state or balance reads are warning conditions (`<rule>.read-failed`, with no age or escalation, unlike the daemon; reconciliation INCOMPLETE "… unreachable", with no `health.reconcile-stale`), so a run where nothing could be verified can still exit 0: check the output for them. |
| `test-alert` | Sends `TelegramSink.sendTest()` to every route and prints one line per route (chat id, thread id, ok or error). The test message is info severity, so it arrives silently. It posts directly, outside the daemon's outbox: it shows whether a route works (e.g. after a fix), but neither delivers the alerts kept for a failing route nor clears its failing state. It uses the sink's short retries, so a 429 with a `retry_after` above 5 s is reported as an error. | 0 = every route ok; 1 if any route failed or no `telegram` section is configured; 2 = usage or config error |
| `scan --chain <name> --from <block> --to <block>` | Replays every event rule over a historical range, with addresses resolved at `--to`. Alerts are printed by the console sink while the scan goes on. At the end it waits at most 10 s for the rest, and prints "N alert message(s) could not be printed." for any left. In-memory store, no Telegram. Use it to see what the monitor would have reported for an incident, or the full alert (with cancel calldata) of an old proposal. Reads at old blocks (e.g. "Capacity before" of a Guardian budget reduction) need an archive node, or show "unknown (read failed)". | 0 = range replayed; 2 = usage or config error, unknown chain, or an address-resolution or RPC failure ("Scan failed: …", after the alerts of the chunks already replayed) |

## HTTP endpoints

Served when `http` is configured. The server answers from cached status only and never waits for an RPC call or an
alert delivery.

- `GET /healthz`: `{"status", "chains", "reconcile", "deliveries"}` (`reconcile` only while reconciliation is
  enabled). Status `200 "ok"` when every chain is fresh, reconciliation is not stale and no alert target is failing.
  Otherwise `503` with `"stale"` (a chain or reconciliation is stale, which takes precedence) or `"delivery-failing"`
  (an alert target is failing, also one carried over a restart). A chain is stale when its scan is stale (`stale`),
  when a state rule's reads have failed for more than `staleAfterSec` (`readsStale`), or when the replay of its
  skipped CCIP blocks has failed for that long (`ccipGapReplayStale`). Reconciliation is stale when its runs have been
  blocked for more than `reconciliation.staleAfterSec` (`reconcile.stale`), even with every chain fresh. The Docker
  `HEALTHCHECK` uses it (see [Docker](#docker) before wiring it to restarts).
  - `chains.<name>`: `processedBlock`, `confirmedHead`, `lagBlocks`, `lastCaughtUpAt`, `headAdvancedAt` (ISO time or
    `null`), `staleForSec`, `stale`, `cycleFailures`, and `lastError` after a failed cycle. `lagBlocks` is negative
    while the RPC's confirmed head is below the processed block. After a restart with `health.stale-telemetry` open,
    `headAdvancedAt` shows the carried-over staleness estimate, not an observed advance, until the head rises above
    the stored cursor. `stale` and `staleForSec` cover the scan only.
  - State reads, per chain: `readsStale` (bool), `readsFailingForSec` (the longest-failing rule, `0` when none) and
    `failingReads` (`{<rule>: {since, lastOkAt, forSec}}`, ISO times, `lastOkAt` `null` when none was recorded; only
    the rules currently failing). These are computed continuously from the stored failure start.
  - CCIP gaps, per chain: `ccipGaps` (`[{from, to}]`, the CCIP blocks not scanned yet; `[]` when none or while CCIP
    tracking is disabled), `ccipGapReplayStale` (bool), `ccipGapFailingForSec` (`0` when no replay is failing) and
    `ccipGapError` (redacted): the latest error of a gap whose replay is still failing, present until no gap's replay
    is failing, and restored after a restart.
  - `reconcile` (absent while reconciliation is disabled): `stale` (bool), `blockedSince` (ISO time of the start of
    the first blocked run, `null` while not blocked), `blockedForSec` (`0` while not blocked), `lastCompleteAt` (ISO
    time of the last run that evaluated `R − I`, `null` when none was recorded), `failures` (runs that threw since the
    process start), and while blocked either `reasons` (the last blocked run's failure reasons) or `error` (when it
    threw), both redacted. Computed continuously from the stored start, so a blocked age carried over a restart
    counts before the first run.
  - `deliveries.<sink>` (e.g. `telegram`): `ok` (messages delivered), `failed` (messages dropped as
    undeliverable), `retries` (failed attempts whose message was kept for a retry), `failing`, and while failing
    `failingSince`, `failingKind` (`transient`, `route`, `message` or `unclassified`) and `lastError` (redacted). The
    counts are since the process start, summed over the sink's targets; the failure is that of its target failing
    longest. `targets` has the same fields per target, plus `outboxMessages` (messages it has yet to deliver) and
    `outboxOldestAgeSec` (how long the oldest of them has waited, `0` when none): `{<target id>: {ok, failed,
    retries, failing, failingSince?, failingKind?, lastError?, outboxMessages, outboxOldestAgeSec}}`. Telegram target
    ids are the route's chat id, or `<chatId>/<threadId>`; the console's is `stdout`. The failure fields survive a
    restart (see "Failing target" and "The cause shown" under
    [Delivery behaviour](#delivery-behaviour-srcalertstelegramts-srcalertsmanagerts)).
- `GET /metrics`: Prometheus text format with these metrics:

| Metric | Labels | Meaning |
| --- | --- | --- |
| `sahara_monitor_up` | | Always `1`. |
| `sahara_monitor_chain_processed_block` | `chain` | Last fully processed block (the cursor). |
| `sahara_monitor_chain_confirmed_head` | `chain` | Latest block minus the configured confirmations. |
| `sahara_monitor_chain_lag_blocks` | `chain` | Confirmed head minus processed block (negative while the RPC is behind the processed block). |
| `sahara_monitor_chain_last_caught_up_timestamp_seconds` | `chain` | Unix time the chain was last caught up to its confirmed head (`0`: never since the start). |
| `sahara_monitor_chain_stale` | `chain` | `1` when the chain has not been caught up, or its confirmed head has not advanced, for more than `staleAfterSec` (the scan only). |
| `sahara_monitor_chain_state_reads_stale` | `chain` | `1` when a state rule's reads have failed for more than `staleAfterSec`. |
| `sahara_monitor_chain_ccip_gap_replay_stale` | `chain` | `1` when the replay of the CCIP blocks the CCIP rule skipped has failed for more than `staleAfterSec`. |
| `sahara_monitor_chain_cycle_failures_total` | `chain` | Failed cycles. |
| `sahara_monitor_open_conditions` | `severity` | Open conditions. |
| `sahara_monitor_alert_deliveries_total` | `sink`, `target`, `result` (`ok` or `failed`) | Messages per target: `ok` delivered, `failed` dropped as undeliverable for that target (not a failed attempt). One series per route; `sum by (sink, result)` gives the per-sink totals. |
| `sahara_monitor_alert_delivery_retries_total` | `sink`, `target` | Failed delivery attempts whose message was kept and retried later (network, server, rate-limit or route errors). |
| `sahara_monitor_alert_sink_failing` | `sink`, `target` | `1` while the target is failing: an attempt failed (its message kept for a retry, or dropped) and nothing of that severity or above was delivered to it since. Kept across a restart. `max by (sink)` gives the per-sink flag. |
| `sahara_monitor_alert_outbox_messages` | `sink`, `target` | Messages the target has yet to deliver (kept in the state file across a restart). |
| `sahara_monitor_alert_outbox_oldest_age_seconds` | `sink`, `target` | Seconds the oldest message the target has yet to deliver has waited (`0` when none). |
| `sahara_monitor_reconcile_complete` | | `1` if the last report computed `R − I` (no blocking incomplete reason), else `0`. |
| `sahara_monitor_reconcile_backing_tokens` | | `R`, in whole tokens. Absent while a chain's balances are unreadable. |
| `sahara_monitor_reconcile_inflight_tokens` | | `I`, in whole tokens. Absent while any blocking incomplete reason exists. |
| `sahara_monitor_reconcile_margin_tokens` | | `R − I − requiredBacking`, in whole tokens. Absent while any blocking incomplete reason exists. |
| `sahara_monitor_reconcile_failed_messages` | | Failed SAHARA messages awaiting execution. |
| `sahara_monitor_reconcile_stuck_messages` | | Stuck messages. |
| `sahara_monitor_reconcile_last_run_timestamp_seconds` | | Time of the last reconciliation. It ages while runs are skipped (a chain stale or not caught up). |
| `sahara_monitor_reconcile_stale` | | `1` when reconciliation has been blocked for more than `reconciliation.staleAfterSec` (`/healthz` 503, heartbeat withheld). |
| `sahara_monitor_reconcile_blocked_seconds` | | Seconds reconciliation has been blocked (`0` while it is not). Kept across a restart. |
| `sahara_monitor_reconcile_failures_total` | | Reconciliation runs that threw since the process start. |

The report metrics (`sahara_monitor_reconcile_complete` to `…_last_run_timestamp_seconds`) have no sample until the
first run, and while reconciliation is disabled. `sahara_monitor_reconcile_stale`, `…_blocked_seconds` and
`…_failures_total` have a sample whenever reconciliation is enabled, also before the first run, and none while it is
disabled. A chain is stale for `/healthz` and the heartbeat when any of the three per-chain staleness gauges is `1`;
`sahara_monitor_reconcile_stale` at `1` has the same effect.

**Heartbeat.** When `alerts.heartbeatUrl` is set, the daemon fetches it with GET every 60 s (the first time 60 s
after the start). It does so only while every chain has caught up since the start and is not stale (its scan, its
state reads and the replay of its skipped CCIP blocks), reconciliation has not been blocked for longer than
`reconciliation.staleAfterSec`, and no alert target is failing (debug log `heartbeat skipped: alert delivery failing`,
`targets`: e.g. `"telegram -1001234567890"`). Never in a dry run. Point a dead-man's switch at it. It then fires
when:

- the process dies or hangs;
- a chain's RPCs fail, lag or stop advancing;
- a state rule's reads keep failing, or a state rule keeps throwing (which raises no Telegram alert of its own);
- the replay of skipped CCIP blocks keeps failing;
- reconciliation keeps throwing or stays blocked (e.g. its `balanceOf` reads at the finalized block fail);
- a Telegram route cannot take its alerts (bot removed, token revoked, chat migrated, Telegram unreachable or rate
  limiting it), or dropped one, until that route delivers again at the failed severity or above, also across a
  restart;
- a first-start backfill outlasts the switch's grace period (see "While the backfill runs").

Failures to reach the heartbeat URL are only logged, and the URL is redacted like the other secrets.

## State file

One JSON document (`stateFile`), split into namespaces. Bigints are stored as `{"$bigint": "<decimal>"}`.

| Namespace | Contents | Written by |
| --- | --- | --- |
| `alerts` | Sent event keys (kept 7 days), open conditions (`openedAt`, `lastSentAt`, `peakSeverity`), `queue` (messages emitted but not flushed yet), `outbox` and `targets`. `outbox` holds, in emission order, the messages flushed but not yet delivered or dropped by every target they are for, each `{message, targets, at, digest?, sent?}`: `targets` lists the targets still to take it as `<sink>:<target id>` (e.g. `telegram:-1001234567890`, `telegram:-1001234567890/42`, `console:stdout`), `at` is the unix ms it entered the outbox, and a digest keeps its content in `digest` (`{total, severity, counts, lines, more}`, `lines` = `[{key, text, count}]`) so a later fold merges into it. `sent` (`{"telegram:-1001234567890": 1}`) is present only while a target has accepted part of a message sent in several parts (longer than 4096 characters): the parts it took, removed once it delivers or drops the message; invalid values are ignored on load. `targets` has an entry for every configured target, `{failing?: {since, severity, error, kind}, retryAt?}`: its failure (`error` redacted, `kind` `transient`, `route`, `message` or `unclassified`) and the unix ms before which it is not retried (a `retry_after`, at most 24 h ahead). Messages not delivered yet, and failures, are kept across a stop. At start an outbox from an earlier version (`{message, sinks}`) moves to the targets of those sinks that admit each message, and the entries of a target no longer configured move to the targets of its sink added since (see Durability under [Delivery behaviour](#delivery-behaviour-srcalertstelegramts-srcalertsmanagerts)). | src/alerts/manager.ts |
| `daemon:<chain>` | `cursor` (last fully processed block), `backfill` (`from`, `to`, `next`, `done`), `reads` and `gapFailures`. `reads` = `{<state rule id>: {okAt, failingSince, failing}}`, written at every state check: `okAt` is the unix ms of the last check whose reads all succeeded, `failing` = `{<read>: since}` (unix ms; `*` stands for the whole rule) and `failingSince` is the earliest entry of `failing`. `gapFailures` = `{<block>: {since, failures, failedAt, error}}`, per CCIP gap chunk whose replay is failing, by its first block. | the daemon |
| `health` | `lastSummaryDate`, and `reconcile` = `{completeAt, blockedSince, reasons \| error}` (each optional), written after every reconciliation run: `completeAt` is the unix ms of the start of the last run that evaluated `R − I`, `blockedSince` that of the first blocked run (unset while not blocked), and `reasons` (the last blocked run's failure reasons) or `error` (redacted, when it threw). Cleared at start while reconciliation is disabled. | the daemon |
| `timelock:<chain>` | Tracked operations by id: pending ones, plus executed or cancelled ones for 30 days. Each keeps `alertKey`, the key of the first `timelock.scheduled` alert of the operation's scheduling transaction; later schedulings in that transaction derive their keys from the transaction hash and their ordinal (operations stored before this field existed recompute it on a rescan) | src/rules/timelock.ts |
| `timelock-cancels:<chain>` | Each cancelled scheduling of a tracked operation (id, summary, its own ETA, whether it contains `setGuardian`), keyed by `<txHash>:<logIndex>` of its `Cancelled` log, so `controller.proposal-cancelled` describes the scheduling it closed. Entries older than 30 days are pruned when a new one is recorded. |
| `events:<chain>` | Remote chain selector of each pool's Manager spec (Router ramp filter) | src/rules/events.ts |
| `flows:<chain>` | Pool outflows still inside the outflow window | src/rules/flows.ts |
| `state:<chain>` | Each state rule's conditions from the last cycle (carried forward while reads fail) | src/rules/state-common.ts |
| `ccip:sent:<chain>` | SAHARA messages sent from this chain's watched pools | src/ccip/tracker.ts |
| `ccip:exec:<chain>` | Executions of SAHARA messages on this chain's OffRamps, and counterpart failures not yet attributed | src/ccip/tracker.ts |
| `ccip:scan:<chain>` | CCIP scan cursor, `coveredAt` (block time of the cursor's last block), Router ramps, receipt lookups to retry, `backfills` (ramp logs to fetch and record, each with its ramps and `offRampLanes`, the OffRamps' source lanes), unlinked locks, `gaps` (scan gaps, each with `offRampLanes`, the OffRamps the Router listed at its ends). State saved without `offRampLanes` loads without error: a backfill's lanes are taken from the stored ramps, and a gap without them is replayed as before (see [RPC requirements](#rpc-requirements)). | src/ccip/tracker.ts |
| `reconcile` | The reconciliation conditions of the last run | src/rules/reconcile.ts |

**CCIP retention.** Nothing that can change `I` is dropped because of its age. Locks that cannot be tied to a message
are kept, and counted in `I` unless acknowledged (see [Acknowledged obligations](#acknowledged-obligations)); gaps
are kept until their blocks are scanned. Transactions whose receipt lookup keeps failing (at most 10 lookups per
scanned chunk, the least tried first) and ramp logs still to fetch or record are retried and never given up.
Settled records are dropped by scan coverage in block time, not by wall-clock age, so the result does not depend on
which chain is scanned first:

- an executed message's records are dropped once both chains' scans are 14 days (block time) past the send and the
  execution;
- an execution without a send record (sent before the scanned history, or a failure of another token) is dropped once
  its source chain's scan has no gaps, is 14 days past its first execution attempt, and has no lock waiting for its
  receipt (an acknowledged one included);
- a SAHARA failure that is not executed yet is never dropped.

The state file therefore holds about 14 days of settled messages, also during and after a backfill of old blocks.
Pruning reads the other chain's CCIP state as it is at that moment, so a concurrent loop (e.g. a gap replay) cannot
make it drop an execution.

## Limitations

**Data freshness and history**

- **Confirmed, not finalized.** Logs are processed at `latest − confirmations`, at least once, and are not
  reorg-corrected. A reorg deeper than `confirmations` can leave a phantom alert or CCIP record. Reconciliation
  balances are always read at the finalized block, or at the confirmed head if `finalized` is unsupported, capped at
  the last block the CCIP rule processed. A capped chain can miss locks that its counterpart has already released,
  because the counterpart's snapshot is later. When the counterpart shows such releases of messages the capped chain
  has not scanned, the run is incomplete (blocking `reconcile.incomplete`, "CCIP scan behind its finalized block")
  instead of a false breach. A capped chain without such releases is evaluated normally, e.g. BSC capped a few
  blocks behind in steady state.
- **History before the first scanned block.** Proposals and CCIP messages before it are invisible. An execution of an
  untracked operation is still reported (`timelock.executed`, "Scheduling not seen by the monitor"). Blocks skipped
  between two CCIP scans make reconciliation INCOMPLETE (blocking) until the daemon has replayed them (see
  [Skipped CCIP blocks](#skipped-ccip-blocks)).

**Coverage of CCIP and pools**

- **OffRamps.** Executions are watched on the OffRamps the Router lists for the counterpart selectors at the start or
  the end of each scanned range. An EVM2EVM OffRamp the Router retires inside a range keeps the source lane it had at
  the range start, which matters with more than one counterpart chain. When the logs of ramps that appeared
  mid-range cannot be fetched (warn `ccip: ramp logs unavailable, will retry`), the retry (a backfill in
  `ccip:scan:<chain>`) keeps those OffRamps and their lanes until its logs are recorded. Their executions in that
  range are then recorded and alerted even after the Router dropped them: a FAILURE raises `ccip.message-failed`. A
  transaction of the retry that cannot be recorded keeps the whole retry (warn `ccip: backfilled transaction not
  recorded, will refetch`), which refetches it next cycle, so the caveat "ramp logs of blocks X–Y not fetched yet"
  can last longer than the fetch. A SUCCESS on
  any other OffRamp is still seen through the pool's `ReleasedOrMinted`. A FAILURE there is not. The same applies to
  a replayed gap whose Router state the RPC no longer has, except on the OffRamps stored with the gap (see
  [RPC requirements](#rpc-requirements)). EVM2EVMOffRamp 1.2.0 cannot release SAHARA (`UnsupportedToken`).
- **Only watched pools.** These are the registered pools, the registry pool, `contracts.pool` and
  `reserves.extraPools`. SAHARA bridged through any other pool is outside `R` and `I`. Locks that cannot be tied to a
  message, and messages to unconfigured chain selectors, are counted in `I` as "uncertain" until they are listed in
  `reconciliation.acknowledged`.
- **Retired pools are only partly checked.** On a pool that is neither the registry pool nor a fundable migration
  target, only the authorities (owner, rebalancer, `rateLimitAdmin`) are asserted. Its remote configuration and rate
  limits appear in the snapshot only.

**Accounting rules**

- **Flows.** An explanation is accepted only from the Manager or a watched pool, and only with the exact amount.
  Anyone can emit look-alike events from other contracts.
- **Message stores.** Messages are joined across chains through the one shared state file, so both chains must run in
  the same process with the same state file.

**Alerting**

- **At least once, per route, unless the route rejects the message.** Undelivered messages survive an outage, a stop
  and a crash, and each route gets them in order once it works. A message in flight at a crash (of a long message,
  the part in flight), or a retried Telegram request that Telegram had posted, can arrive twice. A route drops only
  a message it rejects as such (a `message` failure, or an unclassified error three times), and only for itself.
  Open conditions come back with their next reminder; event alerts do not. The route then counts as failing until it
  delivers at that severity or above, which withholds the heartbeat and fails `/healthz`, also across a restart.
- **The failure cause shown can be an older drop.** While a dropped message keeps a route failing, `/healthz` keeps
  showing that drop as `failingKind` and `lastError`, also during a later outage that affects only less severe
  messages; the outbox gauges, `retries` and the warn log show that outage (see "The cause shown" under
  [Delivery behaviour](#delivery-behaviour-srcalertstelegramts-srcalertsmanagerts)).
- **Backlog while a route is down.** Its info and warning messages are folded into digests and a reminder replaces
  the older ones of its condition, but critical and high messages are kept one by one, so the state file grows with
  them (see Backlog bounding).
- **Routes to one chat share its rate limit.** Two routes to topics of the same chat send at most 20 messages per
  minute between them.

**RPC**

- **Range limits.** Small `maxLogRange` values, and providers that reject ranges, make catch-up, backfill and gap
  replay slow. A single block that still fails stalls the chain, which ends in `health.stale-telemetry`. In a gap
  replay it stalls only that gap, which ends in `health.ccip-gap-replay`.
- **Redaction.** RPC API keys embedded in a hostname are not redacted.

## Development

| Script | Command | Purpose |
| --- | --- | --- |
| `npm start` | `node src/cli.ts run` | Daemon |
| `npm run check` | `node src/cli.ts check` | One-shot report |
| `npm run test-alert` | `node src/cli.ts test-alert` | Telegram test |
| `npm run gen:abi` | `node scripts/gen-abi.ts` | Regenerates `src/abi/generated.ts` from the Foundry output (`forge build` in the repository root first) |
| `npm run typecheck` | `tsc --noEmit` | Type check (no emit; Node runs the sources directly) |
| `npm test` | `vitest run` | Unit tests (offline; `test/**/*.test.ts` except `test/e2e`) |
| `npm run test:e2e` | `vitest run --config vitest.e2e.config.ts` | End-to-end tests against a local anvil chain |

CI (`.github/workflows/test.yml`, job "Monitor (TypeScript)") runs these steps:

1. `npm ci`.
2. The ABI drift check: `forge build --root ..`, `npm run gen:abi`, then `git diff --exit-code src/abi/generated.ts`.
   The monitor's ABIs cannot drift from the contracts.
3. Typecheck, unit tests and end-to-end tests.

The external and CCIP ABIs (`src/abi/external.ts`, `src/abi/ccip.ts`) are written by hand from verified sources. See
`src/abi/VERIFICATION.md` for the method, topic0 values and sample transactions.

Style: run unbuilt with Node type stripping. Relative imports use the `.ts` extension, type-only imports use
`import type`, and there are no enums, namespaces or parameter properties (`erasableSyntaxOnly`).

Alert sinks implement `AlertSink` (`src/types.ts`): `targets` (default: one, named after the sink), `admits(message,
target)` and `send(message, target, progress?)`. `send` delivers to one target, retries in the call only briefly
and throws a `DeliveryError` whose `kind` (`transient`, `route` or `message`) tells the alert manager to keep the
message or drop it for that target; any other error is unclassified. A sink that sends a message in parts resumes
after the `progress.sent` parts the target accepted and reports each accepted part to `progress.onPart`
(`SendProgress`), which the alert manager stores with the message. `TelegramSink` keeps no record of partial sends
itself: without `progress`, every call starts from part 1.

```
monitor/
  config.example.yaml       example configuration (copy to config.yaml)
  Dockerfile
  scripts/gen-abi.ts        ABI generator (Foundry out/ -> src/abi/generated.ts)
  src/
    cli.ts                  commands
    daemon.ts, health.ts    polling loop, backfill, health, HTTP, heartbeat
    config.ts               schema, env interpolation, defaults, aliases
    log.ts, store.ts, format.ts, types.ts
    abi/                    generated.ts (from forge), external.ts, ccip.ts, VERIFICATION.md
    alerts/                 manager.ts (lifecycle), telegram.ts, console.ts
    chain/                  client.ts (read-only RPC), scanner.ts (eth_getLogs), addresses.ts (resolution)
    rules/                  events.ts, timelock.ts + calls.ts, flows.ts, state*.ts, reconcile.ts, common.ts
    ccip/                   tracker.ts (ccip rule), store.ts, inflight.ts (I)
  test/                     unit tests (vitest) with fixtures and helpers; e2e/ runs against anvil
```
