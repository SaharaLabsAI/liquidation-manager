#!/usr/bin/env bash
# Helpers for the live monitor test. Source after ../drill/lib.sh (CHAIN=bsc|sepolia).
# The daemon runs from monitor/ with the testnet config and monitor/.env (the Telegram bot token and chat id): alerts go
# to Telegram (to deployments/monitor.out only without a telegram section), JSON logs to deployments/monitor.log.
# Expectations wait for log lines written after the last `mark`.

MON_DIR="$ROOT_DIR/monitor"
MON_CONFIG=${MON_CONFIG:-$TESTNET_DIR/monitor/config.yaml}
MON_OUT="$TESTNET_DIR/deployments/monitor.out"
MON_LOG="$TESTNET_DIR/deployments/monitor.log"
case "$CHAIN" in
  bsc) MON_CHAIN=bsc-testnet ;;
  *) MON_CHAIN=$CHAIN ;;
esac
EXPECT_TIMEOUT=${EXPECT_TIMEOUT:-300}

# The daemon is found by its command line: `node` may be a version-manager shim that runs the real node as a child, so a
# recorded pid can be the wrong process.
_mon_pids() { pgrep -f "src/cli.ts run --config $MON_CONFIG" || true; }
mon_running() { [ -n "$(_mon_pids)" ]; }

# mon_start [extra env assignments...]: starts the daemon unless it runs, then waits for health.started.
mon_start() {
  if mon_running; then
    info "monitor already running (pids $(_mon_pids | xargs))"
    return 0
  fi
  touch "$MON_OUT" "$MON_LOG"
  mark
  # In its own session with no inherited descriptors, so it outlives this script and holds none of its pipes.
  (cd "$MON_DIR" && exec env "$@" python3 -c \
    'import os, sys; os.setsid(); os.closerange(3, 1024); os.execvp(sys.argv[1], sys.argv[1:])' \
    node --env-file-if-exists=.env src/cli.ts run --config "$MON_CONFIG" </dev/null >>"$MON_OUT" 2>>"$MON_LOG") &
  sleep 2
  info "monitor started (pids $(_mon_pids | xargs)), config $MON_CONFIG"
  expect_event_any health.started 600
}

# mon_stop: SIGTERM, then waits up to 90 s for the in-flight cycle and the state save.
mon_stop() {
  mon_running || return 0
  local i
  # shellcheck disable=SC2046
  kill -TERM $(_mon_pids) 2>/dev/null || true
  for i in $(seq 1 90); do
    mon_running || break
    sleep 1
  done
  ! mon_running || die "monitor (pids $(_mon_pids | xargs)) did not stop within 90 s"
  info "monitor stopped"
}

# mark: later expectations only look at log lines written from now on.
mark() { MARK=$(($(wc -l <"$MON_LOG" 2>/dev/null || echo 0) + 1)); }

# _await <timeout> <jq predicate> <description>: waits for a JSON log line after MARK matching the predicate and prints
# it. Lines that are not JSON (e.g. a stack trace) are skipped.
_await() {
  local timeout=$1 pred=$2 what=$3 start line
  start=$(date +%s)
  while :; do
    mon_running || die "monitor is not running (waiting for $what); see $MON_LOG"
    line=$(tail -n +"$MARK" "$MON_LOG" | jq -R -c "fromjson? // empty | select($pred)" 2>/dev/null | head -1) || line=
    if [ -n "$line" ]; then
      printf '%s' "$line"
      return 0
    fi
    [ $(($(date +%s) - start)) -lt "$timeout" ] || die "no $what within ${timeout}s (log lines from $MARK of $MON_LOG)"
    sleep 3
  done
}

# expect_event <rule> [title regex] [timeout]: an event alert of this chain.
expect_event() {
  local rule=$1 re=${2:-.} line
  line=$(_await "${3:-$EXPECT_TIMEOUT}" \
    ".msg == \"event alert\" and .rule == \"$rule\" and (.key | startswith(\"$MON_CHAIN:\")) and (.title | test(\"$re\"))" \
    "event $rule /$re/ on $MON_CHAIN")
  ok "alert $(jq -r '"[\(.severity | ascii_upcase)] \(.title)"' <<<"$line")  ($rule)"
}

# expect_event_any <rule> [timeout]: an event alert on any chain (or none, e.g. health.started).
expect_event_any() {
  local line
  line=$(_await "${2:-$EXPECT_TIMEOUT}" ".msg == \"event alert\" and .rule == \"$1\"" "event $1")
  ok "alert $(jq -r '"[\(.severity | ascii_upcase)] \(.title)"' <<<"$line")  ($1)"
}

# _key_re <regex>: anchors a condition key regex to this chain unless it is global or already anchored.
_key_re() {
  case "$1" in
    ^* | global:*) printf '%s' "$1" ;;
    *) printf '^%s:%s' "$MON_CHAIN" "$1" ;;
  esac
}

# expect_opened <key regex> [severity] [timeout]: a condition of this chain opened (or changed to <severity>).
expect_opened() {
  local re sev=${2:-} line pred
  re=$(_key_re "$1")
  pred="(.msg == \"condition opened\" or .msg == \"condition severity changed\") and (.key | test(\"$re\"; \"i\"))"
  [ -z "$sev" ] || pred="$pred and ((.severity // .to) == \"$sev\")"
  line=$(_await "${3:-$EXPECT_TIMEOUT}" "$pred" "condition /$re/${sev:+ at $sev}")
  ok "condition $(jq -r '"[\((.severity // .to) | ascii_upcase)] \(.title // .key)"' <<<"$line")"
}

# expect_resolved <key regex> [timeout]: a condition of this chain resolved.
expect_resolved() {
  local line re
  re=$(_key_re "$1")
  line=$(_await "${2:-$EXPECT_TIMEOUT}" ".msg == \"condition resolved\" and (.key | test(\"$re\"; \"i\"))" "resolution of /$re/")
  ok "resolved $(jq -r .key <<<"$line")"
}

# expect_no_event <rule> <seconds>: no event alert of this rule on this chain for that long.
expect_no_event() {
  sleep "$2"
  if tail -n +"$MARK" "$MON_LOG" | jq -R -e -c "fromjson? // empty | select(.msg == \"event alert\" and .rule == \"$1\" and (.key | startswith(\"$MON_CHAIN:\")))" >/dev/null 2>&1; then
    die "unexpected $1 alert on $MON_CHAIN"
  fi
  ok "no $1 alert on $MON_CHAIN for ${2}s"
}

# alert_text <key regex>: the last rendered alert whose footer key matches, from monitor.out.
alert_text() {
  awk -v re="$1" 'BEGIN { RS = "\n\n" } $0 ~ "key " re { last = $0 } END { print last }' "$MON_OUT"
}
