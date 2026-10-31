#!/usr/bin/env bash
# Step 11: further emergency levers from the completeness review, run after 09 on a quiet lane.
#   X1 Full exit THROUGH the Manager: one Timelock batch relaxes the pool minimum, recall and funding limits; the
#      Recall Operator pulls the whole pool into the Manager and the Funding Operator puts it back; a second batch
#      restores the operating parameters
#   X2 Timelock operation lifecycle: the Guardian cancels a READY operation; a cancelled operation can be scheduled
#      again with the same salt, an executed one cannot
#   X3 Lockdown does not stop fund / recall; a restore with rate > capacity is rejected
#   X4 Owner-held delayed brakes: registry.setPool(token, 0) delists the token and pool.setRebalancer(0) freezes the
#      pool's liquidity functions; one batch restores both
# Resumable: X1_DONE ... X4_DONE record completed parts.
source "$(dirname "$0")/lib.sh"
require_vars MANAGER CONTROLLER POOL TIMELOCK RL_OUT_CAPACITY RL_OUT_RATE RL_IN_CAPACITY RL_IN_RATE
need_gas deployer lmtest-governance lmtest-guardian lmtest-funding lmtest-recall
require_no_inflight

snapshot

# ---------------------------------------------------------------- X1
if [ "${X1_DONE:-}" != 1 ]; then
  say "X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back"
  [ -n "${X1_P:-}" ] || save X1_P "$(bal "$POOL")" # the inventory before X1, kept across re-runs
  P=$X1_P
  info "pool inventory $(tok "$P"); with the operating limits a recall stops at $(tok "$MAX_RECALL_PER_CALL") per call and the $(tok "$POOL_MINIMUM") minimum"
  if [ "$(math "$(bal "$POOL") > 0")" = 1 ] && [ "$(callnum "$MANAGER" 'maxRecallPerCall()(uint256)')" != "$P" ]; then
    expect_revert "$RECALL_OP" 'ExceedsPerCallLimit(uint256,uint256)' "$MANAGER" 'recall(uint256,uint256)' 1 "$P"
    batch_reset
    batch_add "$MANAGER" "$(cast calldata 'setPoolThresholds(address,uint256,uint256,uint256)' "$POOL" 0 0 0)"
    batch_add "$MANAGER" "$(cast calldata 'setRecallLimits(uint256,uint256,uint256)' "$P" "$P" "$P")"
    batch_add "$MANAGER" "$(cast calldata 'setMaxFundingPerCall(uint256)' "$P")"
    batch_add "$MANAGER" "$(cast calldata 'setPoolFundingBudget(address,uint256,uint256)' "$POOL" "$P" "$P")"
    batch_add "$MANAGER" "$(cast calldata 'setAggregateFundingBudget(uint256,uint256)' "$P" "$P")"
    tl_batch x1-relax
    # Raised budgets keep the consumed amount and refill at `rate` per second: one block later they are full.
    [ "$MODE" = live ] || { cast rpc --rpc-url "$RPC" evm_increaseTime 2 >/dev/null; cast rpc --rpc-url "$RPC" evm_mine >/dev/null; }
    [ "$MODE" = fork ] || sleep "$BLOCK_TIME"
  fi
  if [ "$(bal "$POOL")" != 0 ] && [ "${X1_RECALLED:-}" != 1 ]; then
    send lmtest-recall "$MANAGER" 'recall(uint256,uint256)' 1 "$P"
    save X1_RECALLED 1
    fail_point x1-after-recall
    assert_tx_delta "pool (whole inventory recalled)" "$POOL" "-$P"
    assert_tx_delta "Manager" "$MANAGER" "$P"
  fi
  assert_eq "pool balance" "$(bal "$POOL")" 0
  if [ "${X1_REFUNDED:-}" != 1 ]; then
    send lmtest-funding "$MANAGER" 'fund(uint256,uint256)' 1 "$P"
    save X1_REFUNDED 1
    assert_tx_delta "pool (refunded)" "$POOL" "$P"
  fi
  batch_reset
  batch_add "$MANAGER" "$(cast calldata 'setPoolThresholds(address,uint256,uint256,uint256)' "$POOL" "$POOL_MINIMUM" "$REFILL_TRIGGER" "$REFILL_TARGET")"
  batch_add "$MANAGER" "$(cast calldata 'setRecallLimits(uint256,uint256,uint256)' "$MAX_RECALL_PER_CALL" "$RECALL_CAPACITY" "$RECALL_RATE")"
  batch_add "$MANAGER" "$(cast calldata 'setMaxFundingPerCall(uint256)' "$MAX_FUNDING_PER_CALL")"
  batch_add "$MANAGER" "$(cast calldata 'setPoolFundingBudget(address,uint256,uint256)' "$POOL" "$POOL_FUNDING_CAPACITY" "$POOL_FUNDING_RATE")"
  batch_add "$MANAGER" "$(cast calldata 'setAggregateFundingBudget(uint256,uint256)' "$AGGREGATE_FUNDING_CAPACITY" "$AGGREGATE_FUNDING_RATE")"
  tl_batch x1-restore
  assert_eq "maxRecallPerCall restored" "$(callnum "$MANAGER" 'maxRecallPerCall()(uint256)')" "$MAX_RECALL_PER_CALL"
  assert_eq "pool minimum restored" "$(tuple_field "$(call "$MANAGER" 'getPoolThresholds(address)((uint256,uint256,uint256),bool)' "$POOL" | head -1)" 1)" "$POOL_MINIMUM"
  save X1_DONE 1
fi

# ---------------------------------------------------------------- X2
if [ "${X2_DONE:-}" != 1 ]; then
  say "X2 Operation lifecycle: cancel when READY, re-schedule with the same salt, a Done id cannot come back"
  data=$(cast calldata 'setFundingPaused(bool)' false)
  tl_schedule x2-op "$MANAGER" "$data"
  tl_wait "$OP_ID"
  assert_eq "state before the cancel (2 = Ready)" "$(op_state "$OP_ID")" 2
  guardian_exec "$CONTROLLER" "$(cast calldata 'cancel(address,uint256,bytes,bytes32,bytes32)' "$MANAGER" 0 "$data" "$ZERO32" "$OP_SALT")"
  assert_eq "state after the Guardian cancelled it while Ready" "$(op_state "$OP_ID")" 0
  delay=$(callnum "$TIMELOCK" 'getMinDelay()(uint256)')
  gov_exec "$TIMELOCK" "$(cast calldata 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' "$MANAGER" 0 "$data" "$ZERO32" "$OP_SALT" "$delay")"
  assert_eq "same id scheduled again after the cancel" "$(op_state "$OP_ID")" 1
  OP_KIND=single OP_TARGET=$MANAGER OP_DATA=$data OP_ALREADY_DONE=0
  tl_execute
  expect_revert "$GOVERNANCE_SAFE" 'TimelockUnexpectedOperationState(bytes32,bytes32)' "$TIMELOCK" \
    'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' "$MANAGER" 0 "$data" "$ZERO32" "$OP_SALT" "$delay"
  save X2_DONE 1
fi

# ---------------------------------------------------------------- X3
restore_data() {
  cast calldata 'setChainRateLimiterConfig(uint64,(bool,uint128,uint128),(bool,uint128,uint128))' \
    "$REMOTE_CHAIN_SELECTOR" "(true,$RL_OUT_CAPACITY,$RL_OUT_RATE)" "(true,$RL_IN_CAPACITY,$RL_IN_RATE)"
}
if [ "${X3_DONE:-}" != 1 ]; then
  say "X3 Lockdown leaves the Manager's fund / recall working; rate > capacity is rejected"
  outcap=$(tuple_field "$(call "$POOL" 'getCurrentOutboundRateLimiterState(uint64)((uint128,uint32,bool,uint128,uint128))' "$REMOTE_CHAIN_SELECTOR")" 4)
  tl_schedule x3-restore "$POOL" "$(restore_data)"
  [ "$outcap" = 0 ] || guardian_exec "$CONTROLLER" "$(cast calldata 'lockdown(address)' "$POOL")"
  amt=$(small_amount)
  send lmtest-funding "$MANAGER" 'fund(uint256,uint256)' 1 "$amt"
  assert_tx_delta "pool (fund during lockdown)" "$POOL" "$amt"
  send lmtest-recall "$MANAGER" 'recall(uint256,uint256)' 1 "$amt"
  assert_tx_delta "pool (recall during lockdown)" "$POOL" "-$amt"
  expect_revert "$TIMELOCK" 'InvalidRateLimitRate((bool,uint128,uint128))' "$POOL" \
    'setChainRateLimiterConfig(uint64,(bool,uint128,uint128),(bool,uint128,uint128))' "$REMOTE_CHAIN_SELECTOR" \
    "(true,1000000000000000000,2000000000000000000)" "(true,$RL_IN_CAPACITY,$RL_IN_RATE)"
  tl_execute
  assert_eq "outbound capacity restored" "$(tuple_field "$(call "$POOL" 'getCurrentOutboundRateLimiterState(uint64)((uint128,uint32,bool,uint128,uint128))' "$REMOTE_CHAIN_SELECTOR")" 4)" "$RL_OUT_CAPACITY"
  save X3_DONE 1
fi

# ---------------------------------------------------------------- X4
if [ "${X4_DONE:-}" != 1 ]; then
  say "X4 Owner-held delayed brakes: delist the token in the registry and zero the rebalancer, then restore"
  A=$(adapter_of)
  if [ "$(lc "$(call "$TOKEN_ADMIN_REGISTRY" 'getPool(address)(address)' "$TOKEN")")" = "$(lc "$POOL")" ]; then
    batch_reset
    batch_add "$TOKEN_ADMIN_REGISTRY" "$(cast calldata 'setPool(address,address)' "$TOKEN" "$ZERO")"
    batch_add "$POOL" "$(cast calldata 'setRebalancer(address)' "$ZERO")"
    tl_batch x4-brake
    fail_point x4-after-brake
  fi
  assert_eq "registry pool" "$(call "$TOKEN_ADMIN_REGISTRY" 'getPool(address)(address)' "$TOKEN")" "$ZERO"
  assert_eq "pool rebalancer" "$(call "$POOL" 'getRebalancer()(address)')" "$ZERO"
  expect_revert "$FUNDING_OP" 'PoolNotActiveInRegistry(address,address)' "$MANAGER" 'fund(uint256,uint256)' 1 1000000000000000000
  expect_revert "$RECALL_OP" 'Unauthorized(address)' "$MANAGER" 'recall(uint256,uint256)' 1 1000000000000000000
  expect_revert "$DEPLOYER" 'UnsupportedToken(address)' "$ROUTER" "getFee(uint64,$CCIP_MSG_TYPE)(uint256)" "$REMOTE_CHAIN_SELECTOR" "$(ccip_message "$BRIDGE_USER" 1000000000000000000)"
  expect_ok "$TIMELOCK" "$MANAGER" 'migrateReserves(address,uint256)' "$RECOVERY" "$UINT_MAX"
  expect_ok "$(call "$MANAGER" 'guardian()(address)')" "$CONTROLLER" 'lockdown(address)' "$POOL"
  batch_reset
  batch_add "$TOKEN_ADMIN_REGISTRY" "$(cast calldata 'setPool(address,address)' "$TOKEN" "$POOL")"
  batch_add "$POOL" "$(cast calldata 'setRebalancer(address)' "$A")"
  tl_batch x4-restore
  assert_eq "registry pool" "$(call "$TOKEN_ADMIN_REGISTRY" 'getPool(address)(address)' "$TOKEN")" "$POOL"
  assert_eq "pool rebalancer" "$(call "$POOL" 'getRebalancer()(address)')" "$A"
  expect_ok "$DEPLOYER" "$MANAGER" 'verifyAdapter(uint256)' 1
  expect_ok "$DEPLOYER" "$ROUTER" "getFee(uint64,$CCIP_MSG_TYPE)(uint256)" "$REMOTE_CHAIN_SELECTOR" "$(ccip_message "$BRIDGE_USER" 1000000000000000000)"
  save X4_DONE 1
fi
snapshot
