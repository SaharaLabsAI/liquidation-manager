#!/usr/bin/env bash
# Starts an anvil fork of Ethereum or BSC mainnet (latest block, every account impersonable) and resets this chain's
# rehearsal state, so the steps can run with
#   FORK_RPC=http://127.0.0.1:<port> CHAIN=<chain> ./<step>.sh
# Usage: ./fork.sh <ethereum|bsc> [port]   (runs in the foreground; stop it with Ctrl-C)
# The upstream RPC is ETH_RPC_URL / BSC_RPC_URL (default publicnode). A non-archive upstream serves the fork block's
# state only while it is recent (publicnode Ethereum: about 100 blocks, 20 min), so finish a run within that window or
# use an archive RPC.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CHAIN=${1:?usage: fork.sh <ethereum|bsc> [port]}
PORT=${2:-8545}
# shellcheck source=/dev/null
source "$DIR/chains/$CHAIN.env"
mkdir -p "$DIR/deployments"
: >"$DIR/deployments/$CHAIN.fork.env"
: >"$DIR/deployments/$CHAIN.fork.txlog"
rm -rf "$DIR/deployments/fork-broadcast/Deploy.s.sol/$CHAIN_ID"
echo "fork of $CHAIN mainnet at http://127.0.0.1:$PORT (state reset)"
exec anvil --fork-url "$RPC" --port "$PORT" --auto-impersonate --silent
