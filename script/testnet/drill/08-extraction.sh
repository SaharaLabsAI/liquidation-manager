#!/usr/bin/env bash
# Step 8: emergency extraction. Every path that moves reserves out of the Manager, the adapter or the pool without the
# operators, plus the token-level kill switch. All of them are Timelock operations (full delay, cancellable by the
# Guardian), so they are rehearsed here end to end:
#   E1 migrateReserves / recoverToken destination and token checks (eth_call from the Timelock)
#   E2 recoverToken for a stray non-reserve token sent to the Manager
#   E3 replaceAdapter (new adapter becomes the pool rebalancer in the same batch)
#   E4 token pause / unpause by the Timelock as token owner
#   E5 pool drain bypassing the Manager: the Timelock becomes rebalancer, withdraws, pays the recovery address and
#      hands the rebalancer back to the adapter in one batch
#   E6 migrateReserves(recovery, max): the whole Manager balance out
#   E7 back to operations: the recovery account returns the reserves to the Manager and the inventory to the pool
# Resumable: each part records completion (E2_DONE ... E7_*) and the Timelock operations are persisted, so a re-run
# skips what is done and continues a pending operation. Unset the E*_DONE keys to rehearse a part again.
source "$(dirname "$0")/lib.sh"
require_vars MANAGER CONTROLLER POOL TIMELOCK
need_gas deployer lmtest-governance lmtest-funding lmtest-recall lmtest-recovery
require_no_inflight
cd "$ROOT_DIR"

# deploy_contract <artifact> <constructor types> [constructor args...]: deploys from the deployer with cast, so the gas
# comes from the chain's own eth_estimateGas (forge's local estimate is too low on Sepolia); prints the address.
deploy_contract() {
  local artifact=$1 types=$2 code args
  shift 2
  code=$(forge inspect "$artifact" bytecode)
  args=$(cast abi-encode "constructor($types)" "$@")
  send deployer --create "$code${args#0x}" >&2
  cast to-check-sum-address "$(jq -r .contractAddress <<<"$LAST_RECEIPT")"
}
paused() { call "$TOKEN" 'paused()(bool)'; }

snapshot

# ---------------------------------------------------------------- E1
say "E1 Destination checks: reserves can only leave to an address that can hand them back"
if [ "$(paused)" = false ] && [ "$(bal "$MANAGER")" != 0 ]; then
  A=$(adapter_of)
  for dest in "$A" "$POOL" "$CONTROLLER" "$TOKEN" "$MANAGER"; do
    expect_revert "$TIMELOCK" 'InvalidMigrationDestination(address)' "$MANAGER" 'migrateReserves(address,uint256)' "$dest" "$UINT_MAX"
  done
  expect_revert "$TIMELOCK" 'ZeroAddress()' "$MANAGER" 'migrateReserves(address,uint256)' "$ZERO" 1
  expect_revert "$TIMELOCK" 'CannotRecoverReserveToken()' "$MANAGER" 'recoverToken(address,address,uint256)' "$TOKEN" "$RECOVERY" 1
  expect_revert "$GOVERNANCE_SAFE" 'OwnableUnauthorizedAccount(address)' "$MANAGER" 'migrateReserves(address,uint256)' "$RECOVERY" 1
  expect_ok "$TIMELOCK" "$MANAGER" 'migrateReserves(address,uint256)' "$RECOVERY" "$UINT_MAX"
else
  info "token paused or Manager empty (earlier partial run): skipped"
fi

# ---------------------------------------------------------------- E2
if [ "${E2_DONE:-}" != 1 ]; then
  say "E2 recoverToken: a stray token sent to the Manager by mistake"
  if [ -z "${STRAY_TOKEN:-}" ]; then
    addr=$(deploy_contract script/testnet/StrayToken.sol:StrayToken address "$MANAGER")
    save STRAY_TOKEN "$addr"
  fi
  amount=$(callnum "$STRAY_TOKEN" 'balanceOf(address)(uint256)' "$MANAGER")
  info "STRAY $STRAY_TOKEN, Manager holds $(tok "$amount")"
  if [ "$amount" != 0 ]; then
    tl_single recover-stray "$MANAGER" "$(cast calldata 'recoverToken(address,address,uint256)' "$STRAY_TOKEN" "$RECOVERY" "$amount")"
  fi
  assert_eq "STRAY at recovery" "$(callnum "$STRAY_TOKEN" 'balanceOf(address)(uint256)' "$RECOVERY")" 1000000000000000000000
  assert_eq "STRAY at Manager" "$(callnum "$STRAY_TOKEN" 'balanceOf(address)(uint256)' "$MANAGER")" 0
  save E2_DONE 1
fi

# ---------------------------------------------------------------- E3
if [ "${E3_DONE:-}" != 1 ]; then
  say "E3 replaceAdapter: deploy a new adapter, make it the rebalancer and swap it in atomically"
  [ -n "${ADAPTER_ORIGINAL:-}" ] || save ADAPTER_ORIGINAL "$(adapter_of)"
  if [ -z "${E3_NEW_ADAPTER:-}" ]; then
    addr=$(deploy_contract src/CCIPPoolAdapter.sol:CCIPPoolAdapter address,address,address "$MANAGER" "$TOKEN" "$POOL")
    save E3_NEW_ADAPTER "$addr"
  fi
  NEW=$E3_NEW_ADAPTER
  info "old adapter $ADAPTER_ORIGINAL, new adapter $NEW"
  if [ "$(lc "$(adapter_of)")" != "$(lc "$NEW")" ]; then
    [ "$(lc "$(call "$POOL" 'getRebalancer()(address)')")" = "$(lc "$NEW")" ] ||
      expect_revert "$TIMELOCK" 'PoolRebalancerMismatch(address,address)' "$MANAGER" 'replaceAdapter(uint256,address)' 1 "$NEW"
    batch_reset
    batch_add "$POOL" "$(cast calldata 'setRebalancer(address)' "$NEW")"
    batch_add "$MANAGER" "$(cast calldata 'replaceAdapter(uint256,address)' 1 "$NEW")"
    tl_batch replace-adapter
  fi
  save ADAPTER "$NEW"
  assert_eq "registry entry" "$(adapter_of)" "$NEW"
  assert_eq "pool rebalancer" "$(call "$POOL" 'getRebalancer()(address)')" "$NEW"
  assert_eq "adapter history" "$(call "$MANAGER" 'getAdapterHistory()(address[])' | tr -d ' ')" "[$ADAPTER_ORIGINAL,$NEW]"
  expect_ok "$DEPLOYER" "$MANAGER" 'verifyAdapter(uint256)' 1
  expect_revert "$ADAPTER_ORIGINAL" 'Unauthorized(address)' "$POOL" 'withdrawLiquidity(uint256)' 1
  expect_revert "$TIMELOCK" 'InvalidMigrationDestination(address)' "$MANAGER" 'migrateReserves(address,uint256)' "$ADAPTER_ORIGINAL" 1
  amt=$(small_amount)
  send lmtest-funding "$MANAGER" 'fund(uint256,uint256)' 1 "$amt"
  assert_tx_delta "pool (fund through the new adapter)" "$POOL" "$amt"
  assert_tx_delta "new adapter" "$NEW" 0
  send lmtest-recall "$MANAGER" 'recall(uint256,uint256)' 1 "$amt"
  assert_tx_delta "Manager (recall through the new adapter)" "$MANAGER" "$amt"
  save E3_DONE 1
fi

# ---------------------------------------------------------------- E4
if [ "${E4_DONE:-}" != 1 ]; then
  say "E4 Token pause by the Timelock (token owner): every transfer stops, including fund, recall and migration"
  if [ "$(paused)" = false ]; then
    info "pause and unpause are scheduled back to back, so the token is paused only between two Safe transactions"
    tl_schedule token-pause "$TOKEN" "$(cast calldata 'pause()')"
    tl_schedule token-unpause "$TOKEN" "$(cast calldata 'unpause()')"
    tl_execute_label token-pause
    fail_point after-pause
    assert_eq "token paused" "$(paused)" true
    expect_revert "$FUNDING_OP" 'EnforcedPause()' "$MANAGER" 'fund(uint256,uint256)' 1 1000000000000000000
    expect_revert "$RECALL_OP" 'EnforcedPause()' "$MANAGER" 'recall(uint256,uint256)' 1 1000000000000000000
    expect_revert "$TIMELOCK" 'EnforcedPause()' "$MANAGER" 'migrateReserves(address,uint256)' "$RECOVERY" 1
    expect_revert "$DEPLOYER" 'EnforcedPause()' "$TOKEN" 'transfer(address,uint256)' "$RECOVERY" 1
    expect_revert "$(call "$MANAGER" 'guardian()(address)')" 'OwnableUnauthorizedAccount(address)' "$TOKEN" 'unpause()'
  else
    info "token still paused from an earlier run: executing the unpause"
  fi
  tl_single token-unpause "$TOKEN" "$(cast calldata 'unpause()')" # reuses the pending one
  assert_eq "token paused" "$(paused)" false
  save E4_DONE 1
fi

# ---------------------------------------------------------------- E5
if [ "${E5_DONE:-}" != 1 ]; then
  say "E5 Pool drain bypassing the Manager (no per-call limit, budget or pool minimum)"
  A=$(adapter_of)
  [ -n "${E5_X:-}" ] || save E5_X "$(bal "$POOL")" # the inventory to drain, kept across re-runs
  X=$E5_X
  max_recall=$(callnum "$MANAGER" 'maxRecallPerCall()(uint256)')
  info "pool inventory $(tok "$X"); through the Manager at most $(tok "$max_recall") per call and never below the minimum"
  [ "$(math "$X > $max_recall")" = 0 ] ||
    expect_revert "$RECALL_OP" 'ExceedsPerCallLimit(uint256,uint256)' "$MANAGER" 'recall(uint256,uint256)' 1 "$X"
  batch_reset
  batch_add "$POOL" "$(cast calldata 'setRebalancer(address)' "$TIMELOCK")"
  batch_add "$POOL" "$(cast calldata 'withdrawLiquidity(uint256)' "$X")"
  batch_add "$TOKEN" "$(cast calldata 'transfer(address,uint256)' "$RECOVERY" "$X")"
  batch_add "$POOL" "$(cast calldata 'setRebalancer(address)' "$A")"
  if [ "$(bal "$POOL")" = 0 ] && [ -z "$(_op_get pool-drain ID)" ]; then
    info "pool already drained in an earlier run"
    was_done=1
  else
    tl_schedule_batch pool-drain
    was_done=$OP_ALREADY_DONE
    fail_point before-drain
    tl_execute
  fi
  if [ "$was_done" != 1 ]; then
    assert_tx_delta "pool" "$POOL" "-$X"
    assert_tx_delta "recovery" "$RECOVERY" "$X"
    assert_tx_delta "Timelock" "$TIMELOCK" 0
  fi
  assert_eq "pool rebalancer handed back" "$(call "$POOL" 'getRebalancer()(address)')" "$A"
  expect_ok "$DEPLOYER" "$MANAGER" 'verifyAdapter(uint256)' 1
  save E5_DONE 1
fi

# ---------------------------------------------------------------- E6
if [ "${E6_DONE:-}" != 1 ]; then
  say "E6 migrateReserves(recovery, max): the whole Manager balance"
  [ -n "${E6_MIGRATED:-}" ] || save E6_MIGRATED "$(bal "$MANAGER")" # kept across re-runs
  if [ "$(bal "$MANAGER")" = 0 ] && [ -z "$(_op_get migrate-all ID)" ]; then
    info "Manager already emptied in an earlier run"
    was_done=1
  else
    tl_schedule migrate-all "$MANAGER" "$(cast calldata 'migrateReserves(address,uint256)' "$RECOVERY" "$UINT_MAX")"
    was_done=$OP_ALREADY_DONE
    tl_execute
  fi
  if [ "$was_done" != 1 ]; then
    assert_tx_delta "Manager" "$MANAGER" "-$E6_MIGRATED"
    assert_tx_delta "recovery" "$RECOVERY" "$E6_MIGRATED"
  fi
  assert_eq "Manager balance" "$(bal "$MANAGER")" 0
  save E6_DONE 1
  snapshot
fi

# ---------------------------------------------------------------- E7
say "E7 Back to operations: recovery returns the reserves to the Manager and the inventory to the pool"
if [ "${E7_MANAGER_RETURNED:-}" != 1 ]; then
  send lmtest-recovery "$TOKEN" 'transfer(address,uint256)' "$MANAGER" "$E6_MIGRATED"
  save E7_MANAGER_RETURNED 1
  assert_tx_delta "Manager" "$MANAGER" "$E6_MIGRATED"
fi
if [ "${E7_POOL_RETURNED:-}" != 1 ]; then
  send lmtest-recovery "$TOKEN" 'transfer(address,uint256)' "$POOL" "$E5_X"
  save E7_POOL_RETURNED 1
  assert_tx_delta "pool" "$POOL" "$E5_X"
fi
expect_ok "$DEPLOYER" "$MANAGER" 'verifyAdapter(uint256)' 1
snapshot
