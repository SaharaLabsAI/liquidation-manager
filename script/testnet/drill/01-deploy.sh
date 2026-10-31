#!/usr/bin/env bash
# Step 1: deploy SaharaTimelock, LiquidityManager, GuardianController and CCIPPoolAdapter with TestnetDeploy
# (Deploy's nonce order and wiring checks, short delay).
source "$(dirname "$0")/lib.sh"
require_vars GOVERNANCE_SAFE GUARDIAN_SAFE
need_gas deployer

if [ -n "${MANAGER:-}" ] && [ "$(cast code "$MANAGER" --rpc-url "$RPC")" != 0x ]; then
  die "already deployed (MANAGER=$MANAGER); remove it from $DEPLOYMENT_FILE to redeploy"
fi

say "TestnetDeploy (delay ${TIMELOCK_DELAY}s, bounds [${TIMELOCK_MINIMUM_DELAY}s, ${TIMELOCK_MAXIMUM_DELAY}s])"
cd "$ROOT_DIR"
export TOKEN TOKEN_ADMIN_REGISTRY POOL GOVERNANCE_SAFE GUARDIAN_SAFE TIMELOCK_DELAY TIMELOCK_MINIMUM_DELAY \
  TIMELOCK_MAXIMUM_DELAY
forge script script/testnet/TestnetDeploy.s.sol:TestnetDeploy --sig 'deployTestnet()' --rpc-url "$RPC" \
  --account deployer --password '' --sender "$DEPLOYER" --broadcast --slow \
  --gas-estimate-multiplier "${FORGE_GAS_MULTIPLIER:-130}" 2>&1 | tee "$TESTNET_DIR/deployments/$CHAIN.$MODE.deploy.out"

run_json="$BROADCAST_DIR/TestnetDeploy.s.sol/$CHAIN_ID/deployTestnet-latest.json"
addr_of() { jq -r --arg n "$1" '[.transactions[] | select(.transactionType=="CREATE" and .contractName==$n)][-1].contractAddress' "$run_json"; }
save TIMELOCK "$(cast to-check-sum-address "$(addr_of SaharaTimelock)")"
save MANAGER "$(cast to-check-sum-address "$(addr_of LiquidityManager)")"
save CONTROLLER "$(cast to-check-sum-address "$(addr_of GuardianController)")"
save ADAPTER "$(cast to-check-sum-address "$(addr_of CCIPPoolAdapter)")"
jq -r '.transactions[] | "\(.hash) \(.contractName) \(.contractAddress)"' "$run_json" | while read -r h n a; do
  printf '%s | %s | deploy %s | deployer | CREATE %s | %s\n' "$(date -u +%FT%TZ)" "$STEP" "$n" "$a" "$h" >>"$TXLOG"
done

say "Post-deploy checks"
assert_eq "manager owner" "$(call "$MANAGER" 'owner()(address)')" "$TIMELOCK"
assert_eq "manager guardian" "$(call "$MANAGER" 'guardian()(address)')" "$GUARDIAN_SAFE"
assert_eq "controller manager" "$(call "$CONTROLLER" 'MANAGER()(address)')" "$MANAGER"
assert_eq "controller timelock" "$(call "$CONTROLLER" 'TIMELOCK()(address)')" "$TIMELOCK"
assert_eq "adapter manager" "$(call "$ADAPTER" 'MANAGER()(address)')" "$MANAGER"
assert_eq "adapter pool" "$(call "$ADAPTER" 'POOL()(address)')" "$POOL"
assert_eq "timelock delay" "$(callnum "$TIMELOCK" 'getMinDelay()(uint256)')" "$TIMELOCK_DELAY"
CANCELLER=$(call "$TIMELOCK" 'CANCELLER_ROLE()(bytes32)')
assert_eq "controller has CANCELLER_ROLE" "$(call "$TIMELOCK" 'hasRole(bytes32,address)(bool)' "$CANCELLER" "$CONTROLLER")" true
assert_eq "Guardian Safe has no CANCELLER_ROLE" "$(call "$TIMELOCK" 'hasRole(bytes32,address)(bool)' "$CANCELLER" "$GUARDIAN_SAFE")" false
info "TIMELOCK=$TIMELOCK MANAGER=$MANAGER CONTROLLER=$CONTROLLER ADAPTER=$ADAPTER"
