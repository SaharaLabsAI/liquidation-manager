#!/usr/bin/env bash
# Step 6: final state after the activation: every authority, role, delay and balance, then a summary.
source "$(dirname "$0")/lib.sh"
require_vars TIMELOCK MANAGER CONTROLLER ADAPTER GOVERNANCE_SAFE GUARDIAN_SAFE RESERVES_TOTAL

has_role() { call "$TIMELOCK" 'hasRole(bytes32,address)(bool)' "$(call "$TIMELOCK" "$1()(bytes32)")" "$2"; }

say "Timelock"
assert_eq "delay" "$(callnum "$TIMELOCK" 'getMinDelay()(uint256)')" "$FINAL_TIMELOCK_DELAY"
assert_eq "MINIMUM_DELAY" "$(callnum "$TIMELOCK" 'MINIMUM_DELAY()(uint256)')" "$TIMELOCK_MINIMUM_DELAY"
assert_eq "MAXIMUM_DELAY" "$(callnum "$TIMELOCK" 'MAXIMUM_DELAY()(uint256)')" "$TIMELOCK_MAXIMUM_DELAY"
for role in PROPOSER_ROLE EXECUTOR_ROLE CANCELLER_ROLE; do
  assert_eq "Governance Safe $role" "$(has_role $role "$GOVERNANCE_SAFE")" true
done
assert_eq "controller CANCELLER_ROLE" "$(has_role CANCELLER_ROLE "$CONTROLLER")" true
for who in "$DEPLOYER" "$GUARDIAN_SAFE" "$LEGACY_MULTISIG"; do
  for role in DEFAULT_ADMIN_ROLE PROPOSER_ROLE EXECUTOR_ROLE CANCELLER_ROLE; do
    assert_eq "$who $role" "$(has_role $role "$who")" false
  done
done

say "Manager, pool, registry, token"
assert_eq "manager owner" "$(call "$MANAGER" 'owner()(address)')" "$TIMELOCK"
assert_eq "manager pending owner" "$(call "$MANAGER" 'pendingOwner()(address)')" "$ZERO"
assert_eq "manager guardian" "$(call "$MANAGER" 'guardian()(address)')" "$GUARDIAN_SAFE"
assert_eq "pool owner" "$(call "$POOL" 'owner()(address)')" "$TIMELOCK"
assert_eq "pool rebalancer" "$(call "$POOL" 'getRebalancer()(address)')" "$ADAPTER"
assert_eq "pool rateLimitAdmin" "$(call "$POOL" 'getRateLimitAdmin()(address)')" "$CONTROLLER"
assert_eq "registry config (admin, pending, pool)" \
  "$(call "$TOKEN_ADMIN_REGISTRY" 'getTokenConfig(address)((address,address,address))' "$TOKEN" | tr -d ' ')" \
  "($TIMELOCK,$ZERO,$POOL)"
assert_eq "token owner" "$(call "$TOKEN" 'owner()(address)')" "$TIMELOCK"
assert_eq "token paused" "$(call "$TOKEN" 'paused()(bool)')" false
assert_eq "adapter (id 1)" "$(adapter_of 1)" "$ADAPTER"
expect_ok "$DEPLOYER" "$MANAGER" 'verifyHandover()'
expect_ok "$DEPLOYER" "$MANAGER" 'verifyAdapter(uint256)' 1

say "Balances"
assert_eq "Manager holds every reserve token" "$(bal "$MANAGER")" "$RESERVES_TOTAL"
assert_eq "pool liquidity (unchanged by the activation)" "$(bal "$POOL")" "$POOL_BALANCE_BEFORE"
assert_eq "adapter balance" "$(bal "$ADAPTER")" 0
for w in $(reserve_wallets); do assert_eq "reserve wallet $w" "$(bal "$w")" 0; done
budgets
snapshot

say "Summary ($CHAIN mainnet fork)"
cat <<EOF
  SaharaTimelock      $TIMELOCK   delay $FINAL_TIMELOCK_DELAY s (72 h), bounds [$TIMELOCK_MINIMUM_DELAY, $TIMELOCK_MAXIMUM_DELAY]
  LiquidityManager    $MANAGER   reserves $(tok "$(bal "$MANAGER")") SAHARA
  GuardianController  $CONTROLLER
  CCIPPoolAdapter     $ADAPTER
  Governance Safe     $GOVERNANCE_SAFE (stand-in)   Guardian Safe $GUARDIAN_SAFE (stand-in)
  Pool                $POOL   liquidity $(tok "$(bal "$POOL")") SAHARA
  Legacy MultiSend    safeTxHash $LEGACY_SAFE_TX_HASH (fork nonce; the real one depends on the nonce at signing)
  Transactions        $(wc -l <"$TXLOG" | tr -d ' ') (log $TXLOG)
EOF
