#!/usr/bin/env bash
# Prints a markdown summary of a live drill run: deployed contracts and every transaction by step, with explorer links.
# Usage: ./report.sh <sepolia|bsc>
set -euo pipefail
DRILL_DIR="$(cd "$(dirname "$0")" && pwd)"
CHAIN_NAME=${1:?usage: report.sh <sepolia|bsc>}
DEPLOYMENTS="$(dirname "$DRILL_DIR")/deployments"
EXPLORER=$(bash -c "source '$DRILL_DIR/chains/$CHAIN_NAME.env'; echo \$EXPLORER")
get() { grep -s "^$1=" "$DEPLOYMENTS/$CHAIN_NAME.env" | tail -1 | cut -d= -f2 || true; }
addr() { [ -n "$1" ] && echo "[\`$1\`]($EXPLORER/address/$1)" || echo "—"; }

echo "### $CHAIN_NAME"
echo
echo "| Contract | Address |"
echo "| --- | --- |"
for k in GOVERNANCE_SAFE GUARDIAN_SAFE TIMELOCK MANAGER CONTROLLER ADAPTER_ORIGINAL ADAPTER STRAY_TOKEN; do
  v=$(get $k)
  [ -n "$v" ] || continue
  echo "| $k | $(addr "$v") |"
done
msg=$(get BRIDGE_MSG_ID)
[ -z "$msg" ] || echo "| CCIP test transfer | [\`${msg:0:18}…\`](https://ccip.chain.link/msg/$msg) |"
echo
echo "<details><summary>$(grep -c . "$DEPLOYMENTS/$CHAIN_NAME.txlog") transactions by step</summary>"
echo
echo "| Step | Action | Sender | Tx |"
echo "| --- | --- | --- | --- |"
awk -F' \\| ' -v ex="$EXPLORER" '{
  h = $6; gsub(/ /, "", h)
  printf "| %s | %s | %s | [%s…](%s/tx/%s) |\n", $2, $3, $4, substr(h, 1, 12), ex, h
}' "$DEPLOYMENTS/$CHAIN_NAME.txlog"
echo
echo "</details>"
