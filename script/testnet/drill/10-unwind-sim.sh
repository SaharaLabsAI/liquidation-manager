#!/usr/bin/env bash
# Step 10 (FORK ONLY): full unwind of the handover. The Timelock hands pool ownership, registry administration and
# token ownership back to the legacy owner and migrates the reserves; the legacy owner accepts and takes the rebalancer
# role back. This abandons the liquidity contracts, so it is only simulated on an anvil fork of the live state.
source "$(dirname "$0")/lib.sh"
[ "$MODE" = fork ] || die "10-unwind-sim.sh only runs against a fork (FORK_RPC)"
require_vars MANAGER POOL TIMELOCK
need_gas deployer lmtest-governance

say "Timelock batch: propose the legacy owner everywhere, migrate the reserves"
M=$(bal "$MANAGER")
d=$(bal "$DEPLOYER")
batch_reset
batch_add "$POOL" "$(cast calldata 'transferOwnership(address)' "$DEPLOYER")"
batch_add "$TOKEN_ADMIN_REGISTRY" "$(cast calldata 'transferAdminRole(address,address)' "$TOKEN" "$DEPLOYER")"
batch_add "$TOKEN" "$(cast calldata 'transferOwnership(address)' "$DEPLOYER")"
batch_add "$MANAGER" "$(cast calldata 'migrateReserves(address,uint256)' "$DEPLOYER" "$UINT_MAX")"
tl_batch unwind
assert_delta "legacy owner reserves" "$d" "$(bal "$DEPLOYER")" "$M"
assert_eq "token owner (single step)" "$(call "$TOKEN" 'owner()(address)')" "$DEPLOYER"

say "Legacy owner accepts and takes the rebalancer role back"
send deployer "$POOL" 'acceptOwnership()'
send deployer "$TOKEN_ADMIN_REGISTRY" 'acceptAdminRole(address)' "$TOKEN"
send deployer "$POOL" 'setRebalancer(address)' "$DEPLOYER"
assert_eq "pool owner" "$(call "$POOL" 'owner()(address)')" "$DEPLOYER"
assert_eq "registry config" "$(call "$TOKEN_ADMIN_REGISTRY" 'getTokenConfig(address)((address,address,address))' "$TOKEN" | tr -d ' ')" "($DEPLOYER,$ZERO,$POOL)"
assert_eq "pool rebalancer" "$(call "$POOL" 'getRebalancer()(address)')" "$DEPLOYER"
info "the Manager can no longer fund (the adapter is no longer the rebalancer, the Timelock no longer the pool owner):"
expect_revert "$DEPLOYER" 'PoolRebalancerMismatch(address,address)' "$MANAGER" 'verifyAdapter(uint256)' 1
info "the GuardianController keeps rateLimitAdmin until the legacy owner resets it (setRateLimitAdmin)"
