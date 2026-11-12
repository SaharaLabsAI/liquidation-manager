#!/usr/bin/env bash
# Runs the whole mainnet activation (00 - 06) on a fresh anvil fork of one chain.
# Usage: ./rehearse.sh <ethereum|bsc> [port]      (both chains can run in parallel on different ports)
# The run must finish while the upstream RPC still serves the fork block's state (publicnode Ethereum: ~20 min);
# contracts are compiled before the fork starts.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CHAIN_NAME=${1:?usage: rehearse.sh <ethereum|bsc> [port]}
PORT=${2:-8547}
mkdir -p "$DIR/deployments"
LOG="$DIR/deployments/$CHAIN_NAME.fork.rehearsal.log"
: >"$LOG"

(cd "$DIR/../.." && forge build >/dev/null) || {
  echo "forge build failed"
  exit 1
}

"$DIR/fork.sh" "$CHAIN_NAME" "$PORT" >>"$LOG" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 1; done
export FORK_RPC="http://127.0.0.1:$PORT"
start=$(date +%s)

run() {
  echo "== $1" | tee -a "$LOG"
  CHAIN=$CHAIN_NAME "$DIR/$1.sh" >>"$LOG" 2>&1 || {
    tail -25 "$LOG"
    echo "REHEARSAL FAILED at $1 (log $LOG)"
    exit 1
  }
}

run 00-setup
run 01-deploy
run 02-handover
run 03-small-batch
run 04-full-reserves
run 05-delay-72h
run 06-report
sed -n '/Summary/,$p' "$LOG"
echo "REHEARSAL PASSED on $CHAIN_NAME: $(grep -ac '32mok' "$LOG") checks, $(wc -l <"$DIR/deployments/$CHAIN_NAME.fork.txlog" | tr -d ' ') transactions, $(($(date +%s) - start)) s, log $LOG"
