#!/usr/bin/env bash
# Rehearses the whole drill (00 - 10) on a fresh anvil fork of one chain, including the resume paths: selected steps
# are first aborted at a fail point (FAIL_AT) and then re-run to completion.
# Usage: ./rehearse-fork.sh <sepolia|bsc> [port]
set -euo pipefail
DRILL_DIR="$(cd "$(dirname "$0")" && pwd)"
CHAIN_NAME=${1:?usage: rehearse-fork.sh <sepolia|bsc> [port]}
PORT=${2:-8546}
LOG="$(dirname "$DRILL_DIR")/deployments/$CHAIN_NAME.fork.rehearsal.log"
: >"$LOG"

"$DRILL_DIR/fork.sh" "$CHAIN_NAME" "$PORT" >>"$LOG" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do cast chain-id --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 1; done
export FORK_RPC="http://127.0.0.1:$PORT"

run() { # <step> [args]: must succeed
  echo "== $*" | tee -a "$LOG"
  CHAIN=$CHAIN_NAME "$DRILL_DIR/$1.sh" "${@:2}" >>"$LOG" 2>&1 || {
    tail -20 "$LOG"
    echo "REHEARSAL FAILED at $*"
    exit 1
  }
}
abort_at() { # <fail point> <step> [args]: must fail exactly at the fail point
  echo "== $2 (aborting at $1)" | tee -a "$LOG"
  if FAIL_AT=$1 CHAIN=$CHAIN_NAME "$DRILL_DIR/$2.sh" "${@:3}" >>"$LOG" 2>&1; then
    echo "REHEARSAL FAILED: $2 did not stop at $1"
    exit 1
  fi
  grep -q "injected failure at '$1'" "$LOG" || {
    tail -20 "$LOG"
    echo "REHEARSAL FAILED: $2 failed before reaching $1"
    exit 1
  }
}

run 00-setup
run 01-deploy
abort_at legacy-2 02-handover       # nothing has moved yet: the re-run starts from Handover.s.sol again
abort_at legacy-3 02-handover       # registry admin proposed: the re-run takes the resume path
abort_at after-schedule 02-handover # resume path, batch scheduled
run 02-handover
run 03-fund-recall
run 04-bridge send
run 05-guardian
abort_at before-guardian-cancel 06-governance
run 06-governance
abort_at after-lockdown 07-lockdown
run 07-lockdown
abort_at after-pause 08-extraction
abort_at before-drain 08-extraction
run 08-extraction
run 09-finalize
run 10-unwind-sim
echo "REHEARSAL PASSED: $(grep -ac '32mok' "$LOG") checks, log $LOG"
