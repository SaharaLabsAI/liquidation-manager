#!/usr/bin/env bash
# Step 3: small batch under the 24 h delay. SMALL_BATCH (1M) moves from the first reserve wallet into the Manager, is
# funded into the pool and recalled back; the handed-over pool still serves the CCIP ramps; the Guardian brake works
# while the delay is short.
source "$(dirname "$0")/lib.sh"
require_vars MANAGER POOL ADAPTER TIMELOCK CONTROLLER RESERVE_WALLETS
need_gas funding-operator recall-operator

assert_eq "timelock delay (activation)" "$(callnum "$TIMELOCK" 'getMinDelay()(uint256)')" "$TIMELOCK_DELAY"
source_wallet=$(reserve_wallets | head -1)

say "Small batch: $(tok "$SMALL_BATCH") SAHARA from reserve wallet $source_wallet into the Manager (plain transfer)"
send "$source_wallet" "$TOKEN" 'transfer(address,uint256)' "$MANAGER" "$SMALL_BATCH"
assert_tx_delta "Manager" "$MANAGER" "$SMALL_BATCH"
assert_tx_delta "reserve wallet" "$source_wallet" "-$SMALL_BATCH"
snapshot
budgets

say "Role and argument checks (eth_call)"
expect_revert "$DEPLOYER" 'CallerNotFundingOperator(address)' "$MANAGER" 'fund(uint256,uint256)' 1 1
expect_revert "$RECALL_OP" 'CallerNotFundingOperator(address)' "$MANAGER" 'fund(uint256,uint256)' 1 1
expect_revert "$FUNDING_OP" 'CallerNotRecallOperator(address)' "$MANAGER" 'recall(uint256,uint256)' 1 1
expect_revert "$FUNDING_OP" 'ExceedsPerCallLimit(uint256,uint256)' "$MANAGER" 'fund(uint256,uint256)' 1 "$(math "$MAX_FUNDING_PER_CALL + 1")"
expect_revert "$FUNDING_OP" 'CallerNotManager(address)' "$ADAPTER" 'fund(uint256)' 1

say "fund(1, $(tok "$SMALL_BATCH")): Manager -> adapter -> pool.provideLiquidity"
send funding-operator "$MANAGER" 'fund(uint256,uint256)' 1 "$SMALL_BATCH"
assert_tx_delta "Manager" "$MANAGER" "-$SMALL_BATCH"
assert_tx_delta "pool" "$POOL" "$SMALL_BATCH"
assert_tx_delta "adapter" "$ADAPTER" 0
assert_eq "adapter -> pool allowance" "$(callnum "$TOKEN" 'allowance(address,address)(uint256)' "$ADAPTER" "$POOL")" 0
assert_eq "pool budget consumed" "$(pool_budget_available)" "$(math "$POOL_FUNDING_CAPACITY - $SMALL_BATCH")"
assert_eq "aggregate budget consumed" "$(aggregate_budget_available)" "$(math "$AGGREGATE_FUNDING_CAPACITY - $SMALL_BATCH")"

say "recall(1, $(tok "$SMALL_BATCH")): pool.withdrawLiquidity -> adapter -> Manager"
pool_budget_before=$(pool_budget_available)
send recall-operator "$MANAGER" 'recall(uint256,uint256)' 1 "$SMALL_BATCH"
assert_tx_delta "Manager" "$MANAGER" "$SMALL_BATCH"
assert_tx_delta "pool" "$POOL" "-$SMALL_BATCH"
assert_tx_delta "adapter" "$ADAPTER" 0
assert_eq "recall budget consumed" "$(recall_budget_available)" "$(math "$RECALL_CAPACITY - $SMALL_BATCH")"
# The pool budget only refills with time (rate x seconds per block); a recall never credits it back.
refill=$(math "$(pool_budget_available) - $pool_budget_before")
assert_eq "pool budget not credited by the recall (refill $(tok "$refill") < $(tok "$SMALL_BATCH"))" \
  "$(math "$refill < $SMALL_BATCH")" 1
budgets

say "CCIP through the handed-over pool: inbound release of $(tok "$BRIDGE_AMOUNT") to a user (OffRamp impersonated), then a real Router.ccipSend back"
offramp=$(call "$ROUTER" 'getOffRamps()((uint64,address)[])' | grep -oE "\(${REMOTE_CHAIN_SELECTOR}[^)]*\)" | tail -1 |
  grep -oE '0x[0-9a-fA-F]{40}')
[ -n "$offramp" ] || die "no offRamp for the remote chain on the Router"
assert_eq "Router authorises the offRamp" "$(call "$ROUTER" 'isOffRamp(uint64,address)(bool)' "$REMOTE_CHAIN_SELECTOR" "$offramp")" true
info "onRamp $(call "$ROUTER" 'getOnRamp(uint64)(address)' "$REMOTE_CHAIN_SELECTOR"), offRamp $offramp"
user_word=$(cast abi-encode 'f(address)' "$BRIDGE_USER")
send "$offramp" "$POOL" 'releaseOrMint((bytes,uint64,address,uint256,address,bytes,bytes,bytes))' \
  "($user_word,$REMOTE_CHAIN_SELECTOR,$BRIDGE_USER,$BRIDGE_AMOUNT,$TOKEN,$(cast abi-encode 'f(address)' "$REMOTE_POOL"),$(cast abi-encode 'f(uint256)' 18),0x)"
assert_tx_delta "pool (inbound release)" "$POOL" "-$BRIDGE_AMOUNT"
assert_tx_delta "user" "$BRIDGE_USER" "$BRIDGE_AMOUNT"
send bridge-user "$TOKEN" 'approve(address,uint256)' "$ROUTER" "$BRIDGE_AMOUNT"
fee=$(ccip_fee "$BRIDGE_USER" "$BRIDGE_AMOUNT")
info "CCIP fee $(cast from-wei "$fee") native"
send bridge-user "$ROUTER" "ccipSend(uint64,$CCIP_MSG_TYPE)" "$REMOTE_CHAIN_SELECTOR" \
  "$(ccip_message "$BRIDGE_USER" "$BRIDGE_AMOUNT")" --value "$fee"
assert_tx_delta "pool (outbound lock)" "$POOL" "$BRIDGE_AMOUNT"
assert_tx_delta "user" "$BRIDGE_USER" "-$BRIDGE_AMOUNT"
lock_topic=$(cast keccak 'LockedOrBurned(uint64,address,address,uint256)')
assert_eq "LockedOrBurned emitted by the pool" \
  "$(jq -r --arg t "$lock_topic" --arg p "$(lc "$POOL")" '[.logs[] | select((.address|ascii_downcase)==$p and .topics[0]==$t)] | length' <<<"$LAST_RECEIPT")" 1
expect_revert "$BRIDGE_USER" 'CallerIsNotARampOnRouter(address)' "$POOL" 'lockOrBurn((bytes,uint64,address,uint256,address))' \
  "($user_word,$REMOTE_CHAIN_SELECTOR,$BRIDGE_USER,1,$TOKEN)"
rate_limits

say "Guardian brake under the short delay: Governance proposes migrateReserves(attacker, max), the Guardian cancels it"
data=$(cast calldata 'migrateReserves(address,uint256)' "$ATTACKER" "$UINT_MAX")
assert_eq "isProtectedCall(migrateReserves)" "$(call "$CONTROLLER" 'isProtectedCall(address,uint256,bytes)(bool)' "$MANAGER" 0 "$data")" false
tl_schedule malicious-migrate "$MANAGER" "$data"
guardian_exec "$CONTROLLER" "$(cast calldata 'cancel(address,uint256,bytes,bytes32,bytes32)' "$MANAGER" 0 "$data" "$ZERO32" "$OP_SALT")"
assert_eq "malicious operation state (0 = cancelled)" "$(op_state "$OP_ID")" 0
_op_clear malicious-migrate

say "Small batch passed"
expect_ok "$DEPLOYER" "$MANAGER" 'verifyHandover()'
expect_ok "$DEPLOYER" "$MANAGER" 'verifyAdapter(uint256)' 1
assert_eq "Manager holds the small batch" "$(bal "$MANAGER")" "$SMALL_BATCH"
assert_eq "pool liquidity back to the pre-activation balance" "$(bal "$POOL")" "$POOL_BALANCE_BEFORE"
snapshot
