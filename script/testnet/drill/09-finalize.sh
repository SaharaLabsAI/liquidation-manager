#!/usr/bin/env bash
# Step 9: hand the Guardian role back to the Guardian Safe (protected setGuardian) and print the final state, leaving
# the testnet stack operational.
source "$(dirname "$0")/lib.sh"
require_vars MANAGER CONTROLLER POOL TIMELOCK GUARDIAN_SAFE
need_gas lmtest-governance

if [ "$(lc "$(call "$MANAGER" 'guardian()(address)')")" != "$(lc "$GUARDIAN_SAFE")" ]; then
  say "Protected setGuardian(Guardian Safe)"
  tl_single guardian-back "$MANAGER" "$(cast calldata 'setGuardian(address)' "$GUARDIAN_SAFE")"
fi

say "Final state"
assert_eq "Manager owner" "$(call "$MANAGER" 'owner()(address)')" "$TIMELOCK"
assert_eq "Guardian" "$(call "$MANAGER" 'guardian()(address)')" "$GUARDIAN_SAFE"
assert_eq "pool owner" "$(call "$POOL" 'owner()(address)')" "$TIMELOCK"
assert_eq "pool rebalancer" "$(call "$POOL" 'getRebalancer()(address)')" "$(adapter_of)"
assert_eq "pool rateLimitAdmin" "$(call "$POOL" 'getRateLimitAdmin()(address)')" "$CONTROLLER"
assert_eq "token owner" "$(call "$TOKEN" 'owner()(address)')" "$TIMELOCK"
assert_eq "token paused" "$(call "$TOKEN" 'paused()(bool)')" false
assert_eq "funding paused" "$(call "$MANAGER" 'fundingPaused()(bool)')" false
assert_eq "recall paused" "$(call "$MANAGER" 'recallPaused()(bool)')" false
expect_ok "$DEPLOYER" "$MANAGER" 'verifyHandover()'
expect_ok "$DEPLOYER" "$MANAGER" 'verifyAdapter(uint256)' 1
rate_limits
info "aggregate budget: $(call "$MANAGER" 'getAggregateFundingBudget()((uint256,uint256,uint256))')"
info "pool budget:      $(call "$MANAGER" 'getPoolFundingBudget(address)((uint256,uint256,uint256))' "$POOL")"
info "recall budget:    $(call "$MANAGER" 'getRecallBudget()((uint256,uint256,uint256))')"
snapshot
