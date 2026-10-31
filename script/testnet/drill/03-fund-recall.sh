#!/usr/bin/env bash
# Step 3: routine fund / recall through the adapter, with the per-call limits, budgets and role checks. Amounts are
# sized from the live budgets (consumed budget is never restored), so the step can be re-run.
source "$(dirname "$0")/lib.sh"
require_vars MANAGER POOL ADAPTER
need_gas lmtest-funding lmtest-recall
A=$(adapter_of)

budgets() {
  info "aggregate budget (capacity, rate, available): $(call "$MANAGER" 'getAggregateFundingBudget()((uint256,uint256,uint256))')"
  info "pool budget      (capacity, rate, available): $(call "$MANAGER" 'getPoolFundingBudget(address)((uint256,uint256,uint256))' "$POOL")"
  info "recall budget    (capacity, rate, available): $(call "$MANAGER" 'getRecallBudget()((uint256,uint256,uint256))')"
}

# fund_ok / recall_ok <amount>: the transaction moves exactly <amount> between the Manager and the pool (from its own
# Transfer logs) and leaves the adapter balance and allowance at zero.
fund_ok() {
  send lmtest-funding "$MANAGER" 'fund(uint256,uint256)' 1 "$1"
  assert_tx_delta "Manager" "$MANAGER" "-$1"
  assert_tx_delta "pool" "$POOL" "$1"
  assert_tx_delta "adapter" "$A" 0
  assert_eq "adapter -> pool allowance" "$(callnum "$TOKEN" 'allowance(address,address)(uint256)' "$A" "$POOL")" 0
}
recall_ok() {
  send lmtest-recall "$MANAGER" 'recall(uint256,uint256)' 1 "$1"
  assert_tx_delta "Manager" "$MANAGER" "$1"
  assert_tx_delta "pool" "$POOL" "-$1"
  assert_tx_delta "adapter" "$A" 0
}

# fund 1000 MTK more than the available pool budget (only meaningful while that stays under the per-call limit)
budget_exceeded_check() {
  local over
  over=$(math "$(pool_budget_available) + 1000 * 10^18")
  if [ "$(math "$over <= $MAX_FUNDING_PER_CALL")" = 1 ]; then
    expect_revert "$FUNDING_OP" 'BudgetExceeded(uint256,uint256)' "$MANAGER" 'fund(uint256,uint256)' 1 "$over"
  else
    info "pool budget not exhausted, BudgetExceeded check skipped"
  fi
}

say "Starting point"
snapshot
budgets

say "Role and argument checks (eth_call)"
expect_revert "$DEPLOYER" 'CallerNotFundingOperator(address)' "$MANAGER" 'fund(uint256,uint256)' 1 1
expect_revert "$RECALL_OP" 'CallerNotFundingOperator(address)' "$MANAGER" 'fund(uint256,uint256)' 1 1
expect_revert "$FUNDING_OP" 'CallerNotRecallOperator(address)' "$MANAGER" 'recall(uint256,uint256)' 1 1
expect_revert "$FUNDING_OP" 'UnknownAdapter(uint256)' "$MANAGER" 'fund(uint256,uint256)' 2 1
expect_revert "$FUNDING_OP" 'ZeroAmount()' "$MANAGER" 'fund(uint256,uint256)' 1 0
expect_revert "$FUNDING_OP" 'ExceedsPerCallLimit(uint256,uint256)' "$MANAGER" 'fund(uint256,uint256)' 1 "$(math "$MAX_FUNDING_PER_CALL + 1")"
expect_revert "$RECALL_OP" 'ExceedsPerCallLimit(uint256,uint256)' "$MANAGER" 'recall(uint256,uint256)' 1 "$(math "$MAX_RECALL_PER_CALL + 1")"
expect_revert "$FUNDING_OP" 'CallerNotManager(address)' "$A" 'fund(uint256)' 1
expect_revert "$RECALL_OP" 'CallerNotManager(address)' "$A" 'recall(uint256)' 1

say "fund up to maxFundingPerCall ($(tok "$MAX_FUNDING_PER_CALL")) twice: the pool budget ($(tok "$POOL_FUNDING_CAPACITY")) runs out"
for i in 1 2; do
  amount=$(min_of "$MAX_FUNDING_PER_CALL" "$(pool_budget_available)" "$(aggregate_budget_available)")
  amount=$(math "$amount / 10^18 * 10^18") # whole tokens
  if [ "$(math "$amount >= 10^18")" = 1 ]; then fund_ok "$amount"; else info "budget below 1 MTK, skipping fund $i"; fi
done
budgets
budget_exceeded_check

say "recall up to maxRecallPerCall ($(tok "$MAX_RECALL_PER_CALL")) back to the Manager, never below the pool minimum"
headroom=$(math "$(bal "$POOL") - $POOL_MINIMUM")
amount=$(min_of "$MAX_RECALL_PER_CALL" "$(recall_budget_available)" "$headroom")
amount=$(math "$amount / 10^18 * 10^18")
[ "$(math "$amount >= 10^18")" = 1 ] || die "nothing recallable (recall budget or pool headroom below 1 MTK)"
recall_ok "$amount"
budgets
info "recall does not credit the funding budgets (usage is never reset):"
budget_exceeded_check
snapshot
