#!/usr/bin/env bash
# Telemetry fault test: the daemon's BSC RPC goes through rpc-fault-proxy.mjs, and faults are switched in its rules file.
#   CHAIN=bsc ./fault-test.sh reads    a Manager view and the token's totalSupply fail: state-manager.read-failed
#                                     (warning, high after staleAfterSec), reconcile.incomplete, health.reconcile-stale
#   CHAIN=bsc ./fault-test.sh outage   every request fails: health.stale-telemetry (high after staleAfterSec), /healthz 503
# Start the proxy and restart the daemon with BSC_TESTNET_RPC_URL pointing at it first (README).
source "$(dirname "$0")/../drill/lib.sh"
source "$(dirname "$0")/lib.sh"
RULES="$TESTNET_DIR/deployments/rpc-fault-rules.json"
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:9465/healthz}
STALE=$(awk -v chain="  $MON_CHAIN:" '$0 == chain {on = 1} on && /staleAfterSec:/ {print $2; exit}' "$MON_CONFIG")
[ -n "$STALE" ] || die "no staleAfterSec for $MON_CHAIN in $MON_CONFIG"
mon_running || die "start the monitor first"
trap 'echo "{}" >"$RULES"' EXIT

health_status() { curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL"; }

expect_health() { # <http code> <timeout>
  local start
  start=$(date +%s)
  until [ "$(health_status)" = "$1" ]; do
    [ $(($(date +%s) - start)) -lt "$2" ] || die "/healthz did not return $1 within $2 s"
    sleep 5
  done
  ok "/healthz returns $1"
}

fault_reads() {
  say "Fault test: Manager.getRecallBudget and token totalSupply reads fail"
  mark
  printf '{"failCalls": [{"to": "%s", "sel": "%s"}, {"to": "%s", "sel": "%s"}]}\n' \
    "$MANAGER" "$(cast sig 'getRecallBudget()')" "$TOKEN" "$(cast sig 'totalSupply()')" >"$RULES"
  expect_opened "state-manager:read-failed" warning 120
  expect_opened "global:reconcile:incomplete" warning 300
  expect_opened "state-manager:read-failed" high $((STALE + 120))
  expect_health 503 120
  expect_opened "global:health:reconcile-stale" high 600
  mark
  echo '{}' >"$RULES"
  expect_resolved "state-manager:read-failed" 120
  expect_resolved "global:health:reconcile-stale" 300
  expect_resolved "global:reconcile:incomplete" 300
  expect_health 200 300
}

fault_outage() {
  say "Fault test: the BSC RPC is down"
  mark
  echo '{"down": true}' >"$RULES"
  expect_opened "health:stale-telemetry" high $((STALE + 120))
  expect_health 503 60
  mark
  echo '{}' >"$RULES"
  expect_resolved "health:stale-telemetry" 300
  expect_health 200 300
}

[ $# -gt 0 ] || die "usage: CHAIN=bsc $0 reads|outage..."
for f in "$@"; do
  STEP="monitor-fault-$f"
  "fault_$f"
done
