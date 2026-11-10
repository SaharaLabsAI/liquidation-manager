#!/usr/bin/env bash
# Step 2: the production handover driven by script/Handover.s.sol, in the schedule-first order of the README (shortest
# mixed-authority window):
#   Handover preflight + simulation + printed calldata -> Governance Safe schedules the printed 12-call batch under the
#   24 h delay -> (delay passes) a premature executeBatch reverts and the batch stays Ready -> the real 5-of-6 legacy
#   multisig sends the 4 printed calls in one MultiSend -> Governance Safe executes the batch.
source "$(dirname "$0")/lib.sh"
require_vars GOVERNANCE_SAFE GUARDIAN_SAFE TIMELOCK MANAGER CONTROLLER ADAPTER
need_gas governance-owner

registry_config() { call "$TOKEN_ADMIN_REGISTRY" 'getTokenConfig(address)((address,address,address))' "$TOKEN" | tr -d ' '; }

say "Handover.s.sol: preflight, simulation and calldata"
cd "$ROOT_DIR"
export LEGACY_MULTISIG GOVERNANCE_SAFE TOKEN TOKEN_ADMIN_REGISTRY POOL TIMELOCK MANAGER CONTROLLER ADAPTER \
  FUNDING_OPERATOR=$FUNDING_OP RECALL_OPERATOR=$RECALL_OP ROUTER REMOTE_CHAIN_SELECTOR REMOTE_TOKEN REMOTE_POOL \
  POOL_MINIMUM REFILL_TRIGGER REFILL_TARGET MAX_FUNDING_PER_CALL AGGREGATE_FUNDING_CAPACITY AGGREGATE_FUNDING_RATE \
  POOL_FUNDING_CAPACITY POOL_FUNDING_RATE MAX_RECALL_PER_CALL RECALL_CAPACITY RECALL_RATE
export SALT
SALT=$(cast keccak "lm-mainnet-fork:$CHAIN:handover:$(date +%s)")
out="$DEPLOYMENTS_DIR/$CHAIN.fork.handover.out"
forge script script/Handover.s.sol:Handover --rpc-url "$RPC" >"$out" 2>&1 || {
  tail -30 "$out"
  die "Handover script failed (log $out)"
}
grep -q "Preflight and handover simulation passed." "$out" || die "Handover preflight/simulation failed: see $out"
ok "Handover preflight and simulation passed"

# The printed log lines, in order: legacy calls as (target, calldata) pairs, then the Timelock address, the
# scheduleBatch calldata and the executeBatch calldata.
logs=$(awk '/== Logs ==/{f=1; next} f && NF {sub(/^[ \t]+/, ""); print}' "$out")
legacy=$(awk '/Legacy multisig calls/{f=1; next} /Timelock.scheduleBatch/{f=0} f' <<<"$logs")
schedule_target=$(awk '/Timelock.scheduleBatch/{getline; print; exit}' <<<"$logs")
schedule_data=$(awk '/Timelock.scheduleBatch/{getline; getline; print; exit}' <<<"$logs")
execute_data=$(awk '/Timelock.executeBatch/{getline; print; exit}' <<<"$logs")
assert_eq "printed Timelock" "$schedule_target" "$TIMELOCK"
assert_eq "printed legacy calls" "$(($(wc -l <<<"$legacy") / 2))" 4
save HANDOVER_SCHEDULE_DATA "$schedule_data"
save HANDOVER_EXECUTE_DATA "$execute_data"
# executeBatch calldata = selector ++ abi.encode(targets, values, payloads, predecessor, salt): the hashOperationBatch preimage
save HANDOVER_OP_ID "$(cast keccak "0x${execute_data:10}")"
save LEGACY_MULTISEND_DATA "$(multisend_data <<<"$legacy")"

say "Governance Safe -> Timelock.scheduleBatch (12 calls) under the ${TIMELOCK_DELAY}s delay, before any legacy call"
gov_exec "$TIMELOCK" "$HANDOVER_SCHEDULE_DATA"
topic=$(cast keccak 'CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)')
assert_eq "operation id in CallScheduled" \
  "$(jq -r --arg t "$topic" '[.logs[] | select(.topics[0]==$t)][0].topics[1]' <<<"$LAST_RECEIPT")" "$HANDOVER_OP_ID"
assert_eq "handover batch state (1 = waiting)" "$(op_state "$HANDOVER_OP_ID")" 1
expect_revert "$GOVERNANCE_SAFE" 'TimelockUnexpectedOperationState(bytes32,bytes32)' "$TIMELOCK" "$HANDOVER_EXECUTE_DATA"
assert_eq "pool owner (legacy until the batch runs)" "$(call "$POOL" 'owner()(address)')" "$LEGACY_MULTISIG"
assert_eq "token owner (legacy until the MultiSend)" "$(call "$TOKEN" 'owner()(address)')" "$LEGACY_MULTISIG"

say "The delay passes; executing before the legacy calls reverts and leaves the batch Ready"
tl_wait "$HANDOVER_OP_ID"
expect_revert "$GOVERNANCE_SAFE" 'MustBeProposedOwner()' "$TIMELOCK" "$HANDOVER_EXECUTE_DATA"
assert_eq "handover batch state (2 = ready)" "$(op_state "$HANDOVER_OP_ID")" 2

say "Legacy multisig (real $(callnum "$LEGACY_MULTISIG" 'getThreshold()(uint256)')-of-n Safe, owners impersonated): one MultiSend with the 4 printed calls"
while read -r t && read -r d; do info "$t ${d:0:10}"; done <<<"$legacy"
legacy_safe_exec "$MULTISEND_CALL_ONLY" "$LEGACY_MULTISEND_DATA" 1
save LEGACY_SAFE_TX_HASH "$LEGACY_SAFE_TX_HASH"
assert_eq "pool owner (legacy until the Timelock accepts)" "$(call "$POOL" 'owner()(address)')" "$LEGACY_MULTISIG"
assert_eq "pool rateLimitAdmin" "$(call "$POOL" 'getRateLimitAdmin()(address)')" "$CONTROLLER"
assert_eq "pool rebalancer (unchanged until the batch)" "$(call "$POOL" 'getRebalancer()(address)')" "$PREVIOUS_REBALANCER"
assert_eq "token owner" "$(call "$TOKEN" 'owner()(address)')" "$TIMELOCK"
assert_eq "registry config (admin, pending, pool)" "$(registry_config)" "($LEGACY_MULTISIG,$TIMELOCK,$POOL)"

say "Governance Safe -> Timelock.executeBatch"
gov_exec "$TIMELOCK" "$HANDOVER_EXECUTE_DATA"
assert_eq "handover batch state (3 = done)" "$(op_state "$HANDOVER_OP_ID")" 3

say "Post-handover authorities"
assert_eq "pool owner" "$(call "$POOL" 'owner()(address)')" "$TIMELOCK"
assert_eq "pool rebalancer" "$(call "$POOL" 'getRebalancer()(address)')" "$ADAPTER"
assert_eq "pool rateLimitAdmin" "$(call "$POOL" 'getRateLimitAdmin()(address)')" "$CONTROLLER"
assert_eq "registry config (admin, pending, pool)" "$(registry_config)" "($TIMELOCK,$ZERO,$POOL)"
assert_eq "token owner" "$(call "$TOKEN" 'owner()(address)')" "$TIMELOCK"
assert_eq "adapter id of the pool" "$(callnum "$MANAGER" 'adapterIdByPool(address)(uint256)' "$POOL")" 1
assert_eq "funding operator" "$(call "$MANAGER" 'isFundingOperator(address)(bool)' "$FUNDING_OP")" true
assert_eq "recall operator" "$(call "$MANAGER" 'isRecallOperator(address)(bool)' "$RECALL_OP")" true
expect_ok "$DEPLOYER" "$MANAGER" 'verifyHandover()'
expect_ok "$DEPLOYER" "$MANAGER" 'verifyAdapter(uint256)' 1

say "The legacy multisig and the previous rebalancer keep no authority"
expect_revert "$LEGACY_MULTISIG" 'OnlyCallableByOwner()' "$POOL" 'setRebalancer(address)' "$LEGACY_MULTISIG"
expect_revert "$LEGACY_MULTISIG" 'OnlyCallableByOwner()' "$POOL" 'transferOwnership(address)' "$LEGACY_MULTISIG"
expect_revert "$LEGACY_MULTISIG" 'OnlyAdministrator(address,address)' "$TOKEN_ADMIN_REGISTRY" 'setPool(address,address)' "$TOKEN" "$ZERO"
expect_revert "$LEGACY_MULTISIG" 'OwnableUnauthorizedAccount(address)' "$TOKEN" 'pause()'
expect_revert "$PREVIOUS_REBALANCER" 'Unauthorized(address)' "$POOL" 'withdrawLiquidity(uint256)' 1
assert_eq "pool liquidity unchanged by the handover" "$(bal "$POOL")" "$POOL_BALANCE_BEFORE"
