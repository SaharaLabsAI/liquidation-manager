#!/usr/bin/env bash
# Step 5: Governance raises the Timelock delay from the 24 h activation delay to 72 h. updateDelay is itself a Timelock
# operation, so it waits the current (24 h) delay. Also shows that an operation scheduled before the change keeps its
# 24 h ready time: the queue must be checked (and anything unexpected cancelled) when the delay changes.
source "$(dirname "$0")/lib.sh"
require_vars TIMELOCK MANAGER GOVERNANCE_SAFE
need_gas governance-owner

delay() { callnum "$TIMELOCK" 'getMinDelay()(uint256)'; }
SCHEDULE_SIG='schedule(address,uint256,bytes,bytes32,bytes32,uint256)'

say "Before: delay $(delay)s, bounds [$TIMELOCK_MINIMUM_DELAY, $TIMELOCK_MAXIMUM_DELAY]"
assert_eq "timelock delay" "$(delay)" "$TIMELOCK_DELAY"
expect_revert "$GOVERNANCE_SAFE" 'TimelockUnauthorizedCaller(address)' "$TIMELOCK" 'updateDelay(uint256)' "$FINAL_TIMELOCK_DELAY"
expect_revert "$TIMELOCK" 'DelayOutOfBounds(uint256,uint256,uint256)' "$TIMELOCK" 'updateDelay(uint256)' "$((TIMELOCK_MINIMUM_DELAY - 1))"
expect_revert "$TIMELOCK" 'DelayOutOfBounds(uint256,uint256,uint256)' "$TIMELOCK" 'updateDelay(uint256)' "$((TIMELOCK_MAXIMUM_DELAY + 1))"
expect_ok "$TIMELOCK" "$TIMELOCK" 'updateDelay(uint256)' "$FINAL_TIMELOCK_DELAY"

say "A probe operation scheduled under the 24 h delay just before the change (no-op setMaxFundingPerCall)"
probe=$(cast calldata 'setMaxFundingPerCall(uint256)' "$MAX_FUNDING_PER_CALL")
tl_schedule pre-change-probe "$MANAGER" "$probe"
PROBE_ID=$OP_ID

say "Governance Safe schedules updateDelay($FINAL_TIMELOCK_DELAY) under the ${TIMELOCK_DELAY}s delay"
tl_schedule delay-72h "$TIMELOCK" "$(cast calldata 'updateDelay(uint256)' "$FINAL_TIMELOCK_DELAY")"
expect_revert "$GOVERNANCE_SAFE" 'TimelockUnexpectedOperationState(bytes32,bytes32)' "$TIMELOCK" \
  'execute(address,uint256,bytes,bytes32,bytes32)' "$OP_TARGET" 0 "$OP_DATA" "$ZERO32" "$OP_SALT"
tl_execute
topic=$(cast keccak 'MinDelayChange(uint256,uint256)')
assert_eq "MinDelayChange(old, new)" "$(jq -r --arg t "$topic" '[.logs[] | select(.topics[0]==$t)][0].data' <<<"$LAST_RECEIPT")" \
  "$(cast abi-encode 'f(uint256,uint256)' "$TIMELOCK_DELAY" "$FINAL_TIMELOCK_DELAY")"
assert_eq "timelock delay" "$(delay)" "$FINAL_TIMELOCK_DELAY"
assert_eq "MINIMUM_DELAY (immutable floor)" "$(callnum "$TIMELOCK" 'MINIMUM_DELAY()(uint256)')" "$TIMELOCK_MINIMUM_DELAY"

say "An operation scheduled before the change is Ready under the old 24 h delay"
assert_eq "probe state (2 = ready)" "$(op_state "$PROBE_ID")" 2
gov_exec "$TIMELOCK" "$(cast calldata 'cancel(bytes32)' "$PROBE_ID")"
assert_eq "probe withdrawn by Governance (0)" "$(op_state "$PROBE_ID")" 0
_op_clear pre-change-probe

say "New operations need the full 72 h"
salt=$(cast keccak "lm-mainnet-fork:$CHAIN:short-delay-probe")
expect_revert "$GOVERNANCE_SAFE" 'TimelockInsufficientDelay(uint256,uint256)' "$TIMELOCK" "$SCHEDULE_SIG" \
  "$MANAGER" 0 "$probe" "$ZERO32" "$salt" "$TIMELOCK_DELAY"
expect_revert "$GOVERNANCE_SAFE" 'TimelockInsufficientDelay(uint256,uint256)' "$TIMELOCK" "$SCHEDULE_SIG" \
  "$MANAGER" 0 "$probe" "$ZERO32" "$salt" "$((FINAL_TIMELOCK_DELAY - 1))"
tl_schedule post-change-probe "$MANAGER" "$probe"
cast rpc --rpc-url "$RPC" evm_increaseTime $((TIMELOCK_DELAY + 1)) >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null
assert_eq "probe state 24 h after scheduling (1 = waiting)" "$(op_state "$OP_ID")" 1
cast rpc --rpc-url "$RPC" evm_increaseTime $((FINAL_TIMELOCK_DELAY - TIMELOCK_DELAY)) >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null
assert_eq "probe state 72 h after scheduling (2 = ready)" "$(op_state "$OP_ID")" 2
gov_exec "$TIMELOCK" "$(cast calldata 'cancel(bytes32)' "$OP_ID")"
assert_eq "probe withdrawn by Governance (0)" "$(op_state "$OP_ID")" 0
_op_clear post-change-probe
