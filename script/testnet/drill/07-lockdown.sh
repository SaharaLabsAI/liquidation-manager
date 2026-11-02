#!/usr/bin/env bash
# Step 7: bridge lockdown by the Guardian (immediate, zero-only) and restoration by the Timelock (pool owner).
# The restore is scheduled BEFORE the lockdown, so its delay overlaps the checks and it stays pending on chain if the
# step dies: a re-run on a locked pool goes straight to executing it.
source "$(dirname "$0")/lib.sh"
require_vars MANAGER CONTROLLER POOL
need_gas deployer lmtest-governance lmtest-guardian2
require_no_inflight

RL_SIG='getCurrentOutboundRateLimiterState(uint64)((uint128,uint32,bool,uint128,uint128))'
state_out() { call "$POOL" "$RL_SIG" "$REMOTE_CHAIN_SELECTOR"; }
state_in() { call "$POOL" "${RL_SIG/Outbound/Inbound}" "$REMOTE_CHAIN_SELECTOR"; }
restore_data() {
  cast calldata 'setChainRateLimiterConfig(uint64,(bool,uint128,uint128),(bool,uint128,uint128))' \
    "$REMOTE_CHAIN_SELECTOR" "(true,$RL_OUT_CAPACITY,$RL_OUT_RATE)" "(true,$RL_IN_CAPACITY,$RL_IN_RATE)"
}
amount=10000000000000000000

say "Current rate limits"
rate_limits
o=$(state_out) i=$(state_in)
if [ "$(tuple_field "$o" 4)" != 0 ]; then
  save RL_OUT_CAPACITY "$(tuple_field "$o" 4)"
  save RL_OUT_RATE "$(tuple_field "$o" 5)"
  save RL_IN_CAPACITY "$(tuple_field "$i" 4)"
  save RL_IN_RATE "$(tuple_field "$i" 5)"

  say "Governance schedules the restore first (pending while the pool is locked down)"
  tl_schedule rate-limit-restore "$POOL" "$(restore_data)"

  say "Guardian -> GuardianController.lockdown(pool)"
  guardian_exec "$CONTROLLER" "$(cast calldata 'lockdown(address)' "$POOL")"
  fail_point after-lockdown
  rate_limits
  o=$(state_out) i=$(state_in)
  assert_eq "outbound (enabled, capacity, rate)" "$(tuple_field "$o" 3),$(tuple_field "$o" 4),$(tuple_field "$o" 5)" "true,0,0"
  assert_eq "inbound (enabled, capacity, rate)" "$(tuple_field "$i" 3),$(tuple_field "$i" 4),$(tuple_field "$i" 5)" "true,0,0"

  say "Bridge transfers are refused at the source"
  send deployer "$TOKEN" 'approve(address,uint256)' "$ROUTER" "$amount"
  fee=$(ccip_fee "$BRIDGE_USER" "$amount")
  expect_revert "$DEPLOYER" 'TokenMaxCapacityExceeded(uint256,uint256,address)' "$ROUTER" \
    "ccipSend(uint64,$CCIP_MSG_TYPE)" "$REMOTE_CHAIN_SELECTOR" "$(ccip_message "$BRIDGE_USER" "$amount")" --value "$fee"

  say "Only the pool owner restores: the Guardian cannot, even through the controller"
  G=$(call "$MANAGER" 'guardian()(address)')
  expect_revert "$G" 'Unauthorized(address)' "$POOL" 'setChainRateLimiterConfig(uint64,(bool,uint128,uint128),(bool,uint128,uint128))' \
    "$REMOTE_CHAIN_SELECTOR" "(true,$RL_OUT_CAPACITY,$RL_OUT_RATE)" "(true,$RL_IN_CAPACITY,$RL_IN_RATE)"
else
  say "Pool is locked down (earlier run): resuming the restore"
  require_vars RL_OUT_CAPACITY RL_OUT_RATE RL_IN_CAPACITY RL_IN_RATE
  [ "$RL_OUT_CAPACITY" != 0 ] || die "no saved non-zero rate limits to restore: restore by hand"
  tl_schedule rate-limit-restore "$POOL" "$(restore_data)" # reuses the pending one
fi

say "Timelock restores the original limits (buckets restart from zero and refill)"
tl_execute
rate_limits
o=$(state_out)
assert_eq "outbound (enabled, capacity, rate)" "$(tuple_field "$o" 3),$(tuple_field "$o" 4),$(tuple_field "$o" 5)" "true,$RL_OUT_CAPACITY,$RL_OUT_RATE"
waited=0
until [ "$(math "$(tuple_field "$(state_out)" 1) >= $amount")" = 1 ]; do
  if [ "$MODE" = fork ]; then
    cast rpc --rpc-url "$RPC" evm_increaseTime 30 >/dev/null
    cast rpc --rpc-url "$RPC" evm_mine >/dev/null
  fi
  sleep 3
  waited=$((waited + 3))
  [ $waited -lt 600 ] || die "outbound bucket did not refill"
done
info "outbound bucket refilled to $(tok "$(tuple_field "$(state_out)" 1)") MTK after ~${waited}s"
send deployer "$TOKEN" 'approve(address,uint256)' "$ROUTER" "$amount"
fee=$(ccip_fee "$BRIDGE_USER" "$amount")
expect_ok "$DEPLOYER" "$ROUTER" "ccipSend(uint64,$CCIP_MSG_TYPE)" "$REMOTE_CHAIN_SELECTOR" \
  "$(ccip_message "$BRIDGE_USER" "$amount")" --value "$(math "$fee * 105 / 100")"
send deployer "$TOKEN" 'approve(address,uint256)' "$ROUTER" 0
