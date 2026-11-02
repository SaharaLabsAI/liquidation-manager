#!/usr/bin/env bash
# Step 4: a real CCIP transfer through the handed-over pools (lock on CHAIN, release on the remote chain).
#   CHAIN=<source> 04-bridge.sh send   locks BRIDGE_AMOUNT from the deployer, receiver BRIDGE_USER on the remote chain
#   CHAIN=<source> 04-bridge.sh wait   polls the remote chain until the release lands (Sepolia -> BSC waits for Sepolia
#                                      finality, roughly 20 minutes)
# Run it before the lockdown, token-pause and extraction drills (07, 08 refuse to start until both directions are
# delivered): zeroed inbound buckets, a paused token or a drained pool make in-flight messages fail on the destination.
source "$(dirname "$0")/lib.sh"
require_vars MANAGER POOL
mode=${1:-send}

# Remote chain RPC, without clobbering this chain's variables.
REMOTE_RPC=$(bash -c "source '$DRILL_DIR/chains/$REMOTE_CHAIN.env'; echo \$RPC")
rbal() { cast call --rpc-url "$REMOTE_RPC" "$REMOTE_TOKEN" 'balanceOf(address)(uint256)' "$1" | num; }

case "$mode" in
  send)
    need_gas deployer
    if [ "${BRIDGE_DELIVERED:-}" = 0 ]; then
      die "a test transfer ($BRIDGE_MSG_ID) is still waiting for delivery: run '$0 wait' first"
    fi
    say "CCIP send $(tok "$BRIDGE_AMOUNT") MTK: $CHAIN -> $REMOTE_CHAIN (receiver $BRIDGE_USER)"
    rate_limits
    fee=$(ccip_fee "$BRIDGE_USER" "$BRIDGE_AMOUNT")
    value=$(math "$fee * 105 / 100")
    info "fee quote $fee wei, paying $value wei (Router keeps the whole msg.value)"
    send deployer "$TOKEN" 'approve(address,uint256)' "$ROUTER" "$BRIDGE_AMOUNT"
    save BRIDGE_DEST_USER_BEFORE "$(rbal "$BRIDGE_USER")"
    save BRIDGE_DEST_POOL_BEFORE "$(rbal "$REMOTE_POOL")"
    send deployer "$ROUTER" "ccipSend(uint64,$CCIP_MSG_TYPE)" "$REMOTE_CHAIN_SELECTOR" \
      "$(ccip_message "$BRIDGE_USER" "$BRIDGE_AMOUNT")" --value "$value"
    save BRIDGE_SEND_TX "$LAST_TX"
    save BRIDGE_DELIVERED 0
    topic=$(cast keccak 'CCIPMessageSent(uint64,address,bytes32,address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[])')
    msg=$(jq -r --arg t "$topic" '[.logs[] | select(.topics[0]==$t)][0].topics[3]' <<<"$LAST_RECEIPT")
    [ -n "$msg" ] && [ "$msg" != null ] || die "no CCIPMessageSent in $LAST_TX"
    save BRIDGE_MSG_ID "$msg"
    info "messageId $msg  https://ccip.chain.link/msg/$msg"
    assert_tx_delta "deployer (sender)" "$DEPLOYER" "-$BRIDGE_AMOUNT"
    assert_tx_delta "source pool (locked)" "$POOL" "$BRIDGE_AMOUNT"
    ;;
  wait)
    require_vars BRIDGE_MSG_ID BRIDGE_DEST_USER_BEFORE BRIDGE_DEST_POOL_BEFORE
    say "Waiting for $BRIDGE_MSG_ID to be released on $REMOTE_CHAIN"
    if [ "$MODE" = fork ]; then
      info "fork mode: no CCIP delivery on a fork, skipping"
      exit 0
    fi
    expected=$(math "$BRIDGE_DEST_USER_BEFORE + $BRIDGE_AMOUNT")
    waited=0
    until [ "$(math "$(rbal "$BRIDGE_USER" || echo 0) >= $expected")" = 1 ]; do
      sleep 30
      waited=$((waited + 30))
      [ $waited -lt 5400 ] || die "not delivered after 90 min: https://ccip.chain.link/msg/$BRIDGE_MSG_ID"
      [ $((waited % 300)) -ne 0 ] || info "still waiting (${waited}s)"
    done
    assert_delta "receiver on $REMOTE_CHAIN" "$BRIDGE_DEST_USER_BEFORE" "$(rbal "$BRIDGE_USER")" "$BRIDGE_AMOUNT"
    info "remote pool change (other traffic may also move it): $(tok "$(math "$(rbal "$REMOTE_POOL") - $BRIDGE_DEST_POOL_BEFORE")") MTK"
    ok "delivered after ~${waited}s of polling"
    save BRIDGE_DELIVERED 1
    ;;
  *) die "usage: CHAIN=<chain> $0 send|wait" ;;
esac
