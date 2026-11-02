#!/usr/bin/env bash
# Starts an anvil fork of a drill chain and seeds its state file from the live one, so any step can be rehearsed with
#   FORK_RPC=http://127.0.0.1:<port> CHAIN=<chain> ./<step>.sh
# Usage: ./fork.sh <sepolia|bsc> [port]   (runs in the foreground; stop it with Ctrl-C)
set -euo pipefail
DRILL_DIR="$(cd "$(dirname "$0")" && pwd)"
CHAIN=${1:?usage: fork.sh <sepolia|bsc> [port]}
PORT=${2:-8545}
# shellcheck source=/dev/null
source "$DRILL_DIR/chains/$CHAIN.env"
DEPLOYMENTS="$(dirname "$DRILL_DIR")/deployments"
if [ -f "$DEPLOYMENTS/$CHAIN.env" ]; then cp "$DEPLOYMENTS/$CHAIN.env" "$DEPLOYMENTS/$CHAIN.fork.env"; else : >"$DEPLOYMENTS/$CHAIN.fork.env"; fi
: >"$DEPLOYMENTS/$CHAIN.fork.txlog"
echo "fork of $CHAIN at http://127.0.0.1:$PORT (state seeded from $CHAIN.env)"
exec anvil --fork-url "$RPC" --port "$PORT" --silent
