#!/usr/bin/env bash
# Step 5: Guardian restrict-only powers (immediate) and the Timelock restore (full delay).
source "$(dirname "$0")/lib.sh"
require_vars MANAGER POOL GUARDIAN_SAFE
need_gas lmtest-guardian lmtest-governance lmtest-funding lmtest-recall
G=$(call "$MANAGER" 'guardian()(address)')
info "current Guardian: $G"
snapshot

say "raisePoolMinimum to the current pool balance: every recall now breaches the minimum"
pb=$(bal "$POOL")
guardian_exec "$MANAGER" "$(cast calldata 'raisePoolMinimum(address,uint256)' "$POOL" "$pb")"
assert_eq "pool minimum" "$(call "$MANAGER" 'getPoolThresholds(address)((uint256,uint256,uint256),bool)' "$POOL" | head -1 | tr -d '(' | cut -d, -f1 | num)" "$pb"
expect_revert "$RECALL_OP" 'PoolMinimumBreached(uint256,uint256,uint256)' "$MANAGER" 'recall(uint256,uint256)' 1 1000000000000000000
expect_revert "$G" 'NotARestriction()' "$MANAGER" 'raisePoolMinimum(address,uint256)' "$POOL" "$(math "$pb - 1")"

say "pauseFunding / pauseRecall"
guardian_exec "$MANAGER" "$(cast calldata 'pauseFunding()')"
guardian_exec "$MANAGER" "$(cast calldata 'pauseRecall()')"
expect_revert "$FUNDING_OP" 'FundingIsPaused()' "$MANAGER" 'fund(uint256,uint256)' 1 1000000000000000000
expect_revert "$RECALL_OP" 'RecallIsPaused()' "$MANAGER" 'recall(uint256,uint256)' 1 1000000000000000000

say "suspend both operators, restrict the adapter"
guardian_exec "$MANAGER" "$(cast calldata 'suspendFundingOperator(address)' "$FUNDING_OP")"
guardian_exec "$MANAGER" "$(cast calldata 'suspendRecallOperator(address)' "$RECALL_OP")"
guardian_exec "$MANAGER" "$(cast calldata 'restrictAdapter(uint256,bool,bool)' 1 true true)"
assert_eq "funding operator" "$(call "$MANAGER" 'isFundingOperator(address)(bool)' "$FUNDING_OP")" false
assert_eq "recall operator" "$(call "$MANAGER" 'isRecallOperator(address)(bool)' "$RECALL_OP")" false
assert_eq "adapter 1 (adapter, pool, funding, recall)" "$(call "$MANAGER" 'getAdapter(uint256)((address,address,bool,bool))' 1 | tr -d ' ')" "($(adapter_of),$POOL,false,false)"

say "lower the limits and budgets"
half_pool_rate=$(math "$POOL_FUNDING_RATE / 2")
half_agg_rate=$(math "$AGGREGATE_FUNDING_RATE / 2")
half_recall_rate=$(math "$RECALL_RATE / 2")
guardian_exec "$MANAGER" "$(cast calldata 'reduceMaxFundingPerCall(uint256)' 10000000000000000000000)"
guardian_exec "$MANAGER" "$(cast calldata 'reduceAggregateFundingBudget(uint256,uint256)' 50000000000000000000000 "$half_agg_rate")"
guardian_exec "$MANAGER" "$(cast calldata 'reducePoolFundingBudget(address,uint256,uint256)' "$POOL" 30000000000000000000000 "$half_pool_rate")"
guardian_exec "$MANAGER" "$(cast calldata 'reduceRecallLimits(uint256,uint256,uint256)' 10000000000000000000000 30000000000000000000000 "$half_recall_rate")"
assert_eq "maxFundingPerCall" "$(callnum "$MANAGER" 'maxFundingPerCall()(uint256)')" 10000000000000000000000
assert_eq "maxRecallPerCall" "$(callnum "$MANAGER" 'maxRecallPerCall()(uint256)')" 10000000000000000000000
info "pool budget now: $(call "$MANAGER" 'getPoolFundingBudget(address)((uint256,uint256,uint256))' "$POOL")"

say "The Guardian cannot loosen anything, nobody else can restrict"
expect_revert "$G" 'NotARestriction()' "$MANAGER" 'reduceMaxFundingPerCall(uint256)' 20000000000000000000000
expect_revert "$G" 'NotARestriction()' "$MANAGER" 'reduceRecallLimits(uint256,uint256,uint256)' 10000000000000000000000 30000000000000000000000 "$RECALL_RATE"
expect_revert "$G" 'OwnableUnauthorizedAccount(address)' "$MANAGER" 'setFundingPaused(bool)' false
expect_revert "$G" 'OwnableUnauthorizedAccount(address)' "$MANAGER" 'setAdapterStatus(uint256,bool,bool)' 1 true true
expect_revert "$G" 'OwnableUnauthorizedAccount(address)' "$MANAGER" 'migrateReserves(address,uint256)' "$G" 1
expect_revert "$FUNDING_OP" 'CallerNotGuardian(address)' "$MANAGER" 'pauseFunding()'
expect_revert "$GOVERNANCE_SAFE" 'CallerNotGuardian(address)' "$MANAGER" 'pauseRecall()'

say "Timelock restore batch (Governance Safe, full delay)"
batch_reset
batch_add "$MANAGER" "$(cast calldata 'setPoolThresholds(address,uint256,uint256,uint256)' "$POOL" "$POOL_MINIMUM" "$REFILL_TRIGGER" "$REFILL_TARGET")"
batch_add "$MANAGER" "$(cast calldata 'setFundingPaused(bool)' false)"
batch_add "$MANAGER" "$(cast calldata 'setRecallPaused(bool)' false)"
batch_add "$MANAGER" "$(cast calldata 'setFundingOperator(address,bool)' "$FUNDING_OP" true)"
batch_add "$MANAGER" "$(cast calldata 'setRecallOperator(address,bool)' "$RECALL_OP" true)"
batch_add "$MANAGER" "$(cast calldata 'setAdapterStatus(uint256,bool,bool)' 1 true true)"
batch_add "$MANAGER" "$(cast calldata 'setMaxFundingPerCall(uint256)' "$MAX_FUNDING_PER_CALL")"
batch_add "$MANAGER" "$(cast calldata 'setAggregateFundingBudget(uint256,uint256)' "$AGGREGATE_FUNDING_CAPACITY" "$AGGREGATE_FUNDING_RATE")"
batch_add "$MANAGER" "$(cast calldata 'setPoolFundingBudget(address,uint256,uint256)' "$POOL" "$POOL_FUNDING_CAPACITY" "$POOL_FUNDING_RATE")"
batch_add "$MANAGER" "$(cast calldata 'setRecallLimits(uint256,uint256,uint256)' "$MAX_RECALL_PER_CALL" "$RECALL_CAPACITY" "$RECALL_RATE")"
fail_point before-restore
tl_batch guardian-restore

say "Restored: small fund and recall go through again (consumed budget was not restored)"
info "pool budget: $(call "$MANAGER" 'getPoolFundingBudget(address)((uint256,uint256,uint256))' "$POOL")"
amt=$(small_amount)
m=$(bal "$MANAGER")
send lmtest-funding "$MANAGER" 'fund(uint256,uint256)' 1 "$amt"
send lmtest-recall "$MANAGER" 'recall(uint256,uint256)' 1 "$amt"
assert_delta "Manager after fund + recall of $(tok "$amt")" "$m" "$(bal "$MANAGER")" 0
snapshot
