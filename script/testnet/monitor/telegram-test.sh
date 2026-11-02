#!/usr/bin/env bash
# Telegram delivery test: restarts the daemon on temporary copies of the config, then on the original again.
#   CHAIN=bsc ./telegram-test.sh route     a second route to a chat that does not exist: that route fails as `route`,
#                                         /healthz 503 delivery-failing while the real chat keeps receiving; removing
#                                         the route drops its kept messages and /healthz recovers
#   CHAIN=bsc ./telegram-test.sh outage    telegram.apiUrl on a closed port plus 21 extra expected funding operators
#                                         (21 warnings): messages are kept (transient), /healthz 503; back on the real
#                                         API they are delivered in order, the warnings and their resolutions folded
#                                         into a digest
# Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID in monitor/.env and the telegram section in the config.
source "$(dirname "$0")/../drill/lib.sh"
source "$(dirname "$0")/lib.sh"
ORIGINAL=$MON_CONFIG
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:9465/healthz}
COPY=$(mktemp "${TMPDIR:-/tmp}/monitor-telegram.XXXXXX")
trap 'rm -f "$COPY"' EXIT
grep -q '^telegram:' "$ORIGINAL" || die "no telegram section in $ORIGINAL"
BOGUS_CHAT=-1000000000001

health() { curl -s "$HEALTH_URL"; }

expect_health() { # <http code> <timeout>
  local start
  start=$(date +%s)
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL")" = "$1" ]; do
    [ $(($(date +%s) - start)) -lt "$2" ] || die "/healthz did not return $1 within $2 s"
    sleep 5
  done
  ok "/healthz returns $1 ($(health | jq -r .status))"
}

expect_log() { # <jq predicate> <description> [timeout]
  local line
  line=$(_await "${3:-300}" "$1" "$2")
  ok "log: $(jq -r '[.msg, (.target // empty), (.kind // empty), (.messages // empty | tostring)] | join(" | ")' <<<"$line")"
}

restart_on() { # <config>
  mon_stop
  MON_CONFIG=$1
  mon_start
}

test_route() {
  say "Telegram: a second route to a chat that does not exist"
  awk -v bogus="$BOGUS_CHAT" '{ print } /^    - chatId: \$\{TELEGRAM_CHANNEL_ID\}$/ { route = 1; next }
    route && /^      minSeverity:/ { printf "    - chatId: \"%s\"\n      minSeverity: info\n", bogus; route = 0 }' \
    "$ORIGINAL" >"$COPY"
  [ "$(grep -c 'chatId:' "$COPY")" = 2 ] || die "could not add the second route"
  restart_on "$COPY"
  expect_log ".msg | test(\"alert delivery failing: the route needs a fix\")" "route failure of $BOGUS_CHAT"
  expect_health 503 120
  health | jq -c --arg b "$BOGUS_CHAT" '.deliveries.telegram.targets | to_entries[] |
    {target: .key, ok: .value.ok, failing: .value.failing, kind: .value.failingKind, error: .value.lastError}'
  [ "$(health | jq --arg b "$BOGUS_CHAT" '[.deliveries.telegram.targets | to_entries[] | select(.key != $b) | .value.ok > 0] | all')" = true ] ||
    die "the real chat did not receive the start-up message"
  ok "the real chat kept receiving"
  say "Telegram: the route removed again"
  restart_on "$ORIGINAL"
  expect_log ".msg == \"alerts not delivered to targets no longer configured are dropped\"" "drop of the removed route's messages" 120
  expect_health 200 180
}

test_outage() {
  say "Telegram: API unreachable while 21 warnings open"
  local extra="" i
  for i in $(seq 1 21); do extra+=", \"0x$(printf '%040x' $((0xa000 + i)))\""; done
  awk -v chain="  $MON_CHAIN:" -v extra="$extra" '
    $0 == chain { on = 1 }
    on && /^      fundingOperators: \[/ { sub(/\]$/, extra "]"); on = 0 }
    { print }
    /^  botToken:/ { print "  apiUrl: http://127.0.0.1:9" }' "$ORIGINAL" >"$COPY"
  [ "$(grep -c 'apiUrl: http://127.0.0.1:9' "$COPY")" = 1 ] || die "could not set apiUrl"
  restart_on "$COPY"
  expect_log ".msg | test(\"alert delivery failing; its alerts are kept\")" "transient delivery failure" 120
  local opened
  opened=$(_await 300 ".msg == \"condition opened\" and (.key | test(\"state-manager:funding-operator:0x0+a0\"))" "fake operator warnings") ||
    die "no fake operator warning"
  sleep 20
  expect_health 503 60
  health | jq -c '.deliveries.telegram.targets | to_entries[] | {target: .key, failing: .value.failing, kind: .value.failingKind, error: .value.lastError, outbox: .value.outboxMessages}'
  say "Telegram: API back"
  mark
  restart_on "$ORIGINAL"
  expect_log ".msg == \"alerts not delivered before the last shutdown are sent again\"" "kept messages sent again" 60
  expect_log ".msg == \"alert delivery recovered\"" "delivery recovered" 300
  expect_resolved "state-manager:funding-operator:0x0+a015" 300
  expect_health 200 300
  health | jq -c '.deliveries.telegram.targets | to_entries[] | {target: .key, ok: .value.ok, failing: .value.failing, outbox: .value.outboxMessages}'
}

[ $# -gt 0 ] || die "usage: CHAIN=bsc $0 route|outage..."
for t in "$@"; do
  STEP="monitor-telegram-$t"
  "test_$t"
done
