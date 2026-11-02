#!/usr/bin/env bash
# Step 2: the production handover, driven by script/Handover.s.sol exactly as on mainnet:
#   Handover preflight + simulation -> legacy owner calls (as printed) -> Governance Safe schedules the printed
#   scheduleBatch calldata -> wait the delay -> executes the printed executeBatch calldata -> reserves into the Manager.
# Resumable: the printed calldata and the operation id are saved before the first legacy call. Once any authority has
# moved, Handover's preflight can no longer pass, so a re-run continues from the saved calldata instead.
source "$(dirname "$0")/lib.sh"
require_vars GOVERNANCE_SAFE GUARDIAN_SAFE TIMELOCK MANAGER CONTROLLER ADAPTER
need_gas deployer lmtest-governance

registry_field() { call "$TOKEN_ADMIN_REGISTRY" 'getTokenConfig(address)((address,address,address))' "$TOKEN" | tr -d '() ' | cut -d, -f"$1"; }
is() { [ "$(lc "$1")" = "$(lc "$2")" ]; }

if is "$(call "$TOKEN" 'owner()(address)')" "$TIMELOCK" || is "$(call "$POOL" 'owner()(address)')" "$TIMELOCK" ||
  is "$(registry_field 1)" "$TIMELOCK" || is "$(registry_field 2)" "$TIMELOCK"; then
  say "Resuming the handover (authorities already moving; Handover preflight would fail)"
  require_vars HANDOVER_SCHEDULE_DATA HANDOVER_EXECUTE_DATA HANDOVER_OP_ID
  if is "$(call "$POOL" 'owner()(address)')" "$DEPLOYER"; then
    is "$(call "$POOL" 'getRateLimitAdmin()(address)')" "$CONTROLLER" ||
      send deployer "$POOL" 'setRateLimitAdmin(address)' "$CONTROLLER"
    send deployer "$POOL" 'transferOwnership(address)' "$TIMELOCK" # re-proposing is harmless
  fi
  if is "$(registry_field 1)" "$DEPLOYER" && ! is "$(registry_field 2)" "$TIMELOCK"; then
    send deployer "$TOKEN_ADMIN_REGISTRY" 'transferAdminRole(address,address)' "$TOKEN" "$TIMELOCK"
  fi
  is "$(call "$TOKEN" 'owner()(address)')" "$TIMELOCK" || send deployer "$TOKEN" 'transferOwnership(address)' "$TIMELOCK"
else
  say "Handover.s.sol: preflight, simulation and calldata"
  cd "$ROOT_DIR"
  export LEGACY_MULTISIG=$DEPLOYER GOVERNANCE_SAFE TOKEN TOKEN_ADMIN_REGISTRY POOL TIMELOCK MANAGER CONTROLLER ADAPTER \
    FUNDING_OPERATOR=$FUNDING_OP RECALL_OPERATOR=$RECALL_OP ROUTER REMOTE_CHAIN_SELECTOR REMOTE_TOKEN REMOTE_POOL \
    POOL_MINIMUM REFILL_TRIGGER REFILL_TARGET MAX_FUNDING_PER_CALL AGGREGATE_FUNDING_CAPACITY AGGREGATE_FUNDING_RATE \
    POOL_FUNDING_CAPACITY POOL_FUNDING_RATE MAX_RECALL_PER_CALL RECALL_CAPACITY RECALL_RATE
  export SALT=${HANDOVER_SALT:-$(cast keccak "lm-testnet-drill:$CHAIN:$MODE:handover:$(date +%s)")}
  out="$TESTNET_DIR/deployments/$CHAIN.$MODE.handover.out"
  forge script script/Handover.s.sol:Handover --rpc-url "$RPC" >"$out.tmp" 2>&1 || {
    cat "$out.tmp"
    die "Handover script failed"
  }
  grep -q "Preflight and handover simulation passed." "$out.tmp" || die "Handover preflight/simulation failed: see $out.tmp"
  mv "$out.tmp" "$out"
  sed -n '/== Logs ==/,$p' "$out" | awk 'length($0) < 300' # the batch calldata lines are too long to show

  # The printed log lines, in order: legacy calls as (target, calldata) pairs, then the Timelock address, the
  # scheduleBatch calldata and the executeBatch calldata.
  logs=$(awk '/== Logs ==/{f=1; next} f && NF {sub(/^[ \t]+/, ""); print}' "$out")
  legacy=$(awk '/Legacy multisig calls/{f=1; next} /Timelock.scheduleBatch/{f=0} f' <<<"$logs")
  schedule_target=$(awk '/Timelock.scheduleBatch/{getline; print; exit}' <<<"$logs")
  schedule_data=$(awk '/Timelock.scheduleBatch/{getline; getline; print; exit}' <<<"$logs")
  execute_data=$(awk '/Timelock.executeBatch/{getline; print; exit}' <<<"$logs")
  assert_eq "printed Timelock" "$schedule_target" "$TIMELOCK"
  [ "$(wc -l <<<"$legacy" | tr -d ' ')" = 8 ] || die "expected 4 legacy calls, got: $legacy"
  # executeBatch calldata = selector ++ abi.encode(targets, values, payloads, predecessor, salt), which is exactly
  # the preimage of hashOperationBatch.
  save HANDOVER_SCHEDULE_DATA "$schedule_data"
  save HANDOVER_EXECUTE_DATA "$execute_data"
  save HANDOVER_OP_ID "$(cast keccak "0x${execute_data:10}")"

  say "Legacy owner (deployer) calls: rateLimitAdmin -> controller, propose the Timelock as pool owner and registry admin, token ownership -> Timelock"
  n=0
  while read -r target && read -r data; do
    send deployer "$target" "$data"
    n=$((n + 1))
    fail_point "legacy-$n"
  done <<<"$legacy"
fi

st=$(op_state "$HANDOVER_OP_ID")
if [ "$st" != 3 ]; then
  assert_eq "pool owner (legacy until the Timelock accepts)" "$(call "$POOL" 'owner()(address)')" "$DEPLOYER"
  assert_eq "pool rateLimitAdmin" "$(call "$POOL" 'getRateLimitAdmin()(address)')" "$CONTROLLER"
  assert_eq "token owner" "$(call "$TOKEN" 'owner()(address)')" "$TIMELOCK"
  assert_eq "registry pending admin" "$(registry_field 2)" "$TIMELOCK"
fi

if [ "$st" = 0 ]; then
  say "Governance Safe -> Timelock.scheduleBatch (12 calls)"
  gov_exec "$TIMELOCK" "$HANDOVER_SCHEDULE_DATA"
  topic=$(cast keccak 'CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)')
  assert_eq "operation id in CallScheduled" \
    "$(jq -r --arg t "$topic" '[.logs[] | select(.topics[0]==$t)][0].topics[1]' <<<"$LAST_RECEIPT")" "$HANDOVER_OP_ID"
  st=$(op_state "$HANDOVER_OP_ID")
  assert_eq "handover batch state" "$st" 1
  fail_point after-schedule
fi
if [ "$st" != 3 ]; then
  expect_revert "$DEPLOYER" 'AccessControlUnauthorizedAccount(address,bytes32)' "$TIMELOCK" "$HANDOVER_EXECUTE_DATA"
  say "Wait for the delay, then Governance Safe -> Timelock.executeBatch"
  tl_wait "$HANDOVER_OP_ID"
  gov_exec "$TIMELOCK" "$HANDOVER_EXECUTE_DATA"
  assert_eq "handover batch state" "$(op_state "$HANDOVER_OP_ID")" 3
fi

say "Post-handover authorities"
assert_eq "pool owner" "$(call "$POOL" 'owner()(address)')" "$TIMELOCK"
assert_eq "pool rebalancer" "$(call "$POOL" 'getRebalancer()(address)')" "$ADAPTER"
assert_eq "pool rateLimitAdmin" "$(call "$POOL" 'getRateLimitAdmin()(address)')" "$CONTROLLER"
assert_eq "registry config (admin, pending, pool)" \
  "$(call "$TOKEN_ADMIN_REGISTRY" 'getTokenConfig(address)((address,address,address))' "$TOKEN" | tr -d ' ')" \
  "($TIMELOCK,$ZERO,$POOL)"
assert_eq "token owner" "$(call "$TOKEN" 'owner()(address)')" "$TIMELOCK"
assert_eq "adapter id of the pool" "$(callnum "$MANAGER" 'adapterIdByPool(address)(uint256)' "$POOL")" 1
assert_eq "funding operator" "$(call "$MANAGER" 'isFundingOperator(address)(bool)' "$FUNDING_OP")" true
assert_eq "recall operator" "$(call "$MANAGER" 'isRecallOperator(address)(bool)' "$RECALL_OP")" true
expect_ok "$DEPLOYER" "$MANAGER" 'verifyHandover()'
expect_ok "$DEPLOYER" "$MANAGER" 'verifyAdapter(uint256)' 1
expect_revert "$DEPLOYER" 'Unauthorized(address)' "$POOL" 'withdrawLiquidity(uint256)' 1

if [ "${HANDOVER_RESERVES_SENT:-}" != 1 ]; then
  say "Legacy reserves -> Manager (plain transfer of $(tok "$MANAGER_RESERVES") MTK)"
  send deployer "$TOKEN" 'transfer(address,uint256)' "$MANAGER" "$MANAGER_RESERVES"
  save HANDOVER_RESERVES_SENT 1
  assert_tx_delta "Manager" "$MANAGER" "$MANAGER_RESERVES"
fi
snapshot
