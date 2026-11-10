#!/usr/bin/env bash
# Step 1: deploys SaharaTimelock, LiquidityManager, GuardianController and CCIPPoolAdapter with the production script
# (script/Deploy.s.sol, unchanged: its preflight, nonce order and wiring checks) under the 24 h activation delay.
source "$(dirname "$0")/lib.sh"
require_vars GOVERNANCE_SAFE GUARDIAN_SAFE
need_gas deployer

nonce=$(cast nonce "$DEPLOYER" --rpc-url "$RPC")
say "Deploy.s.sol (delay ${TIMELOCK_DELAY}s, bounds [${TIMELOCK_MINIMUM_DELAY}s, ${TIMELOCK_MAXIMUM_DELAY}s]), deployer nonce $nonce"
info "predicted: Timelock $(cast compute-address "$DEPLOYER" --nonce "$nonce" | awk '{print $NF}') Manager $(cast compute-address "$DEPLOYER" --nonce $((nonce + 1)) | awk '{print $NF}')"
cd "$ROOT_DIR"
unset EXECUTOR
export TOKEN TOKEN_ADMIN_REGISTRY POOL GOVERNANCE_SAFE GUARDIAN_SAFE TIMELOCK_DELAY TIMELOCK_MINIMUM_DELAY \
  TIMELOCK_MAXIMUM_DELAY
out="$DEPLOYMENTS_DIR/$CHAIN.fork.deploy.out"
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --slow \
  >"$out" 2>&1 || {
  tail -30 "$out"
  die "Deploy.s.sol failed (log $out)"
}
grep -E 'SaharaTimelock|LiquidityManager|GuardianController|CCIPPoolAdapter' "$out" | grep -v '^\s*\[' | sed 's/^/  ..   /' || true

run_json="$BROADCAST_DIR/Deploy.s.sol/$CHAIN_ID/run-latest.json"
addr_of() { jq -r --arg n "$1" '[.transactions[] | select(.transactionType=="CREATE" and .contractName==$n)][-1].contractAddress' "$run_json"; }
save TIMELOCK "$(cast to-check-sum-address "$(addr_of SaharaTimelock)")"
save MANAGER "$(cast to-check-sum-address "$(addr_of LiquidityManager)")"
save CONTROLLER "$(cast to-check-sum-address "$(addr_of GuardianController)")"
save ADAPTER "$(cast to-check-sum-address "$(addr_of CCIPPoolAdapter)")"
jq -r '.transactions[] | "\(.hash) \(.contractName) \(.contractAddress)"' "$run_json" | while read -r h n a; do
  printf '%s | %s | deploy %s | deployer | CREATE %s | %s\n' "$(date -u +%FT%TZ)" "$STEP" "$n" "$a" "$h" >>"$TXLOG"
done

say "Post-deploy checks"
for i in 0 1 2 3; do
  v=(TIMELOCK MANAGER CONTROLLER ADAPTER)
  assert_eq "${v[$i]} at deployer nonce $((nonce + i))" "${!v[$i]}" \
    "$(cast compute-address "$DEPLOYER" --nonce $((nonce + i)) | awk '{print $NF}')"
done
assert_eq "timelock delay" "$(callnum "$TIMELOCK" 'getMinDelay()(uint256)')" "$TIMELOCK_DELAY"
assert_eq "timelock MINIMUM_DELAY" "$(callnum "$TIMELOCK" 'MINIMUM_DELAY()(uint256)')" "$TIMELOCK_MINIMUM_DELAY"
assert_eq "timelock MAXIMUM_DELAY" "$(callnum "$TIMELOCK" 'MAXIMUM_DELAY()(uint256)')" "$TIMELOCK_MAXIMUM_DELAY"
assert_eq "manager owner" "$(call "$MANAGER" 'owner()(address)')" "$TIMELOCK"
assert_eq "manager guardian" "$(call "$MANAGER" 'guardian()(address)')" "$GUARDIAN_SAFE"
assert_eq "manager token" "$(call "$MANAGER" 'TOKEN()(address)')" "$TOKEN"
assert_eq "manager registry" "$(call "$MANAGER" 'TOKEN_ADMIN_REGISTRY()(address)')" "$TOKEN_ADMIN_REGISTRY"
assert_eq "controller manager" "$(call "$CONTROLLER" 'MANAGER()(address)')" "$MANAGER"
assert_eq "controller timelock" "$(call "$CONTROLLER" 'TIMELOCK()(address)')" "$TIMELOCK"
assert_eq "adapter manager" "$(call "$ADAPTER" 'MANAGER()(address)')" "$MANAGER"
assert_eq "adapter pool" "$(call "$ADAPTER" 'POOL()(address)')" "$POOL"
has_role() { call "$TIMELOCK" 'hasRole(bytes32,address)(bool)' "$(call "$TIMELOCK" "$1()(bytes32)")" "$2"; }
assert_eq "Governance Safe PROPOSER_ROLE" "$(has_role PROPOSER_ROLE "$GOVERNANCE_SAFE")" true
assert_eq "Governance Safe EXECUTOR_ROLE" "$(has_role EXECUTOR_ROLE "$GOVERNANCE_SAFE")" true
assert_eq "Governance Safe CANCELLER_ROLE" "$(has_role CANCELLER_ROLE "$GOVERNANCE_SAFE")" true
assert_eq "controller CANCELLER_ROLE" "$(has_role CANCELLER_ROLE "$CONTROLLER")" true
assert_eq "Guardian Safe CANCELLER_ROLE" "$(has_role CANCELLER_ROLE "$GUARDIAN_SAFE")" false
assert_eq "deployer DEFAULT_ADMIN_ROLE" "$(has_role DEFAULT_ADMIN_ROLE "$DEPLOYER")" false
assert_eq "timelock self-administered" "$(has_role DEFAULT_ADMIN_ROLE "$TIMELOCK")" true
info "TIMELOCK=$TIMELOCK MANAGER=$MANAGER CONTROLLER=$CONTROLLER ADAPTER=$ADAPTER"
