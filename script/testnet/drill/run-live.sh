#!/usr/bin/env bash
# Runs the live drill on one chain, in the order that keeps CCIP messages safe: the steps that do not touch the pool's
# rate limits, the token or the pool inventory (05, 06) run while the test transfers are in flight; 07 - 09 start
# only once both directions are delivered. Run one instance per chain (they can run in parallel); every step is
# resumable, so after a failure fix the cause and start the script again.
# Usage: ./run-live.sh <sepolia|bsc>
set -euo pipefail
DRILL_DIR="$(cd "$(dirname "$0")" && pwd)"
CHAIN_NAME=${1:?usage: run-live.sh <sepolia|bsc>}
[ -z "${FORK_RPC:-}" ] || {
  echo "run-live.sh is for the live testnets; unset FORK_RPC"
  exit 1
}
DEPLOYMENTS="$(dirname "$DRILL_DIR")/deployments"
LOG="$DEPLOYMENTS/$CHAIN_NAME.live.log"
REMOTE=$([ "$CHAIN_NAME" = bsc ] && echo sepolia || echo bsc)

flag() { grep -s "^$2=" "$DEPLOYMENTS/$1.env" | tail -1 | cut -d= -f2; }
set_flag() {
  sed -i '' "/^$1=/d" "$DEPLOYMENTS/$CHAIN_NAME.env"
  echo "$1=1" >>"$DEPLOYMENTS/$CHAIN_NAME.env"
}
# step <script> [args]: runs a step once; completed steps are recorded (DRILL_DONE_*) and skipped on a re-run.
step() {
  local key
  key="DRILL_DONE_$(echo "$*" | tr '[:lower:] -' '[:upper:]__')"
  if [ "$(flag "$CHAIN_NAME" "$key")" = 1 ]; then
    echo "== $* already done" | tee -a "$LOG"
    return
  fi
  echo "== $(date -u +%FT%TZ) $*" | tee -a "$LOG"
  CHAIN=$CHAIN_NAME "$DRILL_DIR/$1.sh" "${@:2}" >>"$LOG" 2>&1 || {
    tail -15 "$LOG" | sed 's/\x1b\[[0-9;]*m//g'
    echo "LIVE RUN STOPPED at $*"
    exit 1
  }
  set_flag "$key"
}

step 00-setup
step 01-deploy
step 02-handover
step 03-fund-recall
step 04-bridge send
step 05-guardian
step 06-governance
step 04-bridge wait
echo "== $(date -u +%FT%TZ) waiting for the $REMOTE -> $CHAIN_NAME transfer to be delivered" | tee -a "$LOG"
for _ in $(seq 1 360); do
  [ "$(flag "$REMOTE" BRIDGE_DELIVERED)" = 1 ] && break
  sleep 15
done
[ "$(flag "$REMOTE" BRIDGE_DELIVERED)" = 1 ] || {
  echo "LIVE RUN STOPPED: $REMOTE -> $CHAIN_NAME transfer not confirmed after 90 min"
  exit 1
}
step 07-lockdown
step 08-extraction
step 09-finalize
echo "LIVE RUN COMPLETE on $CHAIN_NAME: $(grep -ac '32mok' "$LOG") checks passed, log $LOG"
