#!/usr/bin/env bash
# Config flip test: conditions the testnet cannot produce on chain, raised by restarting the daemon on a copy of the
# config with expectations it cannot meet, then resolved by restarting it on the original config.
#   CHAIN=bsc ./config-flip-test.sh
# The copy sets requiredBacking to 2,000,000 (R is about 1,998,000, and differs from the 1,000,000 supply on both chains)
# and pins a wrong OnRamp for this chain:
#   reconcile.backing and reconcile.total-supply (critical), state-router.on-ramp (high).
source "$(dirname "$0")/../drill/lib.sh"
source "$(dirname "$0")/lib.sh"
ORIGINAL=$MON_CONFIG
FLIPPED=$(mktemp "${TMPDIR:-/tmp}/monitor-flip.XXXXXX")
trap 'rm -f "$FLIPPED"' EXIT
onramp=$(call "$ROUTER" 'getOnRamp(uint64)(address)' "$REMOTE_CHAIN_SELECTOR")
sed -e 's/^  requiredBacking: "1000000"$/  requiredBacking: "2000000"/' \
  -e "s/onRamp: \"$onramp\"/onRamp: \"$DEPLOYER\"/" "$ORIGINAL" >"$FLIPPED"
[ "$(diff "$ORIGINAL" "$FLIPPED" | grep -c '^>')" = 2 ] || die "the config copy does not differ in exactly two lines"

say "Config flip: requiredBacking 2,000,000 and a wrong OnRamp for $MON_CHAIN"
mon_stop
MON_CONFIG=$FLIPPED
mon_start
expect_opened "state-router:on-ramp:" high 120
expect_opened "global:reconcile:supply:" critical 400
expect_opened "global:reconcile:backing" critical 400
mon_stop

say "Config flip: back to the original config"
MON_CONFIG=$ORIGINAL
mon_start
expect_resolved "state-router:on-ramp:" 120
expect_resolved "global:reconcile:backing" 400
expect_resolved "global:reconcile:supply:" 400
