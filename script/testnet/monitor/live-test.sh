#!/usr/bin/env bash
# Live alert test: drives on-chain scenarios on a testnet drill deployment and waits for the monitor daemon's alerts.
#   CHAIN=bsc|sepolia ./live-test.sh <scenario>...
# Scenarios (each restores what it changes):
#   brakes       registry.setPool(token, 0) + setRebalancer(0), then restore
#   ccip-send    CCIP transfer of MON_CCIP_AMOUNT from the legacy wallet to the remote chain; ccip-wait: until released
#   predecessor  op A, protected setGuardian B with predecessor A: soon/ready/blocked, Guardian cancels A, Governance B
#   guardian     every Guardian restriction that leaves a state condition, then one Timelock restore batch
#   limits       Guardian budget reduction and pool-minimum raise, funding into the low budget, two restore batches
#   skew         one batch skews the pool spec, starts Manager and registry transfers, moves a CANCELLER role, the
#                delay and the rateLimitAdmin; one batch (plus a Guardian renounce) restores them
#   ratelimits   outbound bucket disabled and inbound changed, Guardian lockdown, restore (buckets restart from zero,
#                so run it last: the next transfers have to wait for the refill)
#   inflow       lmtest-user sends 1 MTK to the legacy wallet (flows.endpoint-inflow)
# Changes are undone by a restore operation scheduled BEFORE the change executes; if an expectation fails, the exit trap
# executes it (or cancels both when the change never ran). FAIL_AT=<scenario>-after-change rehearses that path.
# The daemon must be running (mon_start in lib.sh).
source "$(dirname "$0")/../drill/lib.sh"
source "$(dirname "$0")/lib.sh"
require_vars MANAGER CONTROLLER TIMELOCK POOL GOVERNANCE_SAFE GUARDIAN_SAFE RL_OUT_CAPACITY RL_OUT_RATE RL_IN_CAPACITY RL_IN_RATE
mon_running || die "start the monitor first (see README)"
CANCELLER_ROLE=$(cast keccak CANCELLER_ROLE)
MON_CCIP_AMOUNT=${MON_CCIP_AMOUNT:-600000000000000000000}
POOL_LC=$(lc "$POOL")

# ---------------------------------------------------------------- cleanup on failure

CLEANUP=()
on_exit() {
  local rc=$? c
  trap - EXIT
  [ "$rc" -ne 0 ] && [ ${#CLEANUP[@]} -gt 0 ] || exit "$rc"
  printf '\n\033[1m[%s] failed: running cleanup\033[0m\n' "$CHAIN"
  for c in "${CLEANUP[@]}"; do eval "$c" || printf '  cleanup step failed: %s\n' "$c"; done
  exit "$rc"
}
trap on_exit EXIT

# undo_pair <change id> <restore label>: after a failure, executes the restore if the change ran, else cancels both.
# The change is identified by its id: tl_execute forgets the label of an executed operation.
undo_pair() {
  local change=$1 restore
  restore=$(_op_get "$2" ID)
  if [ -n "$change" ] && [ "$(op_state "$change")" = 3 ]; then
    [ -z "$restore" ] || [ "$(op_state "$restore")" = 3 ] || tl_execute_label "$2"
  else
    [ -z "$change" ] || [ "$(op_state "$change")" = 0 ] || gov_exec "$TIMELOCK" "$(cast calldata 'cancel(bytes32)' "$change")"
    [ -z "$restore" ] || [ "$(op_state "$restore")" = 0 ] || gov_exec "$TIMELOCK" "$(cast calldata 'cancel(bytes32)' "$restore")"
    _op_clear "$2"
  fi
}

# ---------------------------------------------------------------- helpers

# require_quiet_bridge: no drill or monitor-test transfer in flight in either direction.
require_quiet_bridge() {
  require_no_inflight
  local remote
  remote=$(bash -c "source '$TESTNET_DIR/deployments/$REMOTE_CHAIN.env' 2>/dev/null; echo \${MON_CCIP_DELIVERED:-1}")
  [ "${MON_CCIP_DELIVERED:-1}" = 1 ] && [ "$remote" = 1 ] ||
    die "a monitor test transfer is in flight (run ccip-wait on the sending chain first)"
}

# schedule_raw <target> <calldata> <predecessor> <label>: single operation with a predecessor; sets RAW_ID RAW_SALT.
schedule_raw() {
  RAW_SALT=$(cast keccak "lm-monitor-test:$CHAIN:$4:$(date +%s)")
  RAW_ID=$(call "$TIMELOCK" 'hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)' "$1" 0 "$2" "$3" "$RAW_SALT")
  gov_exec "$TIMELOCK" "$(cast calldata 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' \
    "$1" 0 "$2" "$3" "$RAW_SALT" "$(callnum "$TIMELOCK" 'getMinDelay()(uint256)')")"
}

pool_spec_data() { # <typeAndVersion> <router> <selector> <remoteToken> <remotePool> <rateLimitAdmin>
  cast calldata 'setPoolSpec(address,(string,address,uint64,bytes,bytes[],address))' "$POOL" \
    "(\"$1\",$2,$3,$(cast abi-encode 'f(address)' "$4"),[$(cast abi-encode 'f(address)' "$5")],$6)"
}

# simulate_batch: every call of BATCH_* succeeds from the Timelock in the current state.
simulate_batch() {
  local i
  for i in "${!BATCH_T[@]}"; do expect_ok "$TIMELOCK" "${BATCH_T[$i]}" "${BATCH_D[$i]}"; done
}

# ---------------------------------------------------------------- scenarios

scenario_brakes() {
  say "Monitor test: owner-held brakes (registry delisting, rebalancer zeroed) and their restore"
  require_quiet_bridge
  local a
  a=$(adapter_of)
  batch_reset
  batch_add "$TOKEN_ADMIN_REGISTRY" "$(cast calldata 'setPool(address,address)' "$TOKEN" "$POOL")"
  batch_add "$POOL" "$(cast calldata 'setRebalancer(address)' "$a")"
  simulate_batch
  CHANGE_ID=
  CLEANUP+=('undo_pair "$CHANGE_ID" mon-brake-restore')
  tl_schedule_batch mon-brake-restore
  mark
  batch_reset
  batch_add "$TOKEN_ADMIN_REGISTRY" "$(cast calldata 'setPool(address,address)' "$TOKEN" "$ZERO")"
  batch_add "$POOL" "$(cast calldata 'setRebalancer(address)' "$ZERO")"
  tl_schedule_batch mon-brake
  CHANGE_ID=$OP_ID
  expect_event timelock.scheduled "setPool"
  expect_opened "timelock-queue:$OP_ID:soon"
  tl_execute_label mon-brake
  fail_point brakes-after-change
  expect_event timelock.executed "setPool"
  expect_event registry.pool "removed"
  expect_event pool.config "Rebalancer"
  expect_opened "state-registry:pool" critical
  expect_opened "state-pool:$POOL_LC:rebalancer" critical
  expect_opened "state-manager:verify-adapter:1" critical
  mark
  tl_execute_label mon-brake-restore
  expect_resolved "state-registry:pool"
  expect_resolved "state-pool:$POOL_LC:rebalancer"
  expect_resolved "state-manager:verify-adapter:1"
  CLEANUP=()
}

scenario_ccip_send() {
  say "Monitor test: CCIP send $(tok "$MON_CCIP_AMOUNT") MTK $CHAIN -> $REMOTE_CHAIN from the legacy wallet"
  [ "${MON_CCIP_DELIVERED:-1}" = 1 ] || die "the previous monitor test transfer $MON_CCIP_MSG_ID is not released yet"
  local fee value topic msg
  fee=$(ccip_fee "$BRIDGE_USER" "$MON_CCIP_AMOUNT")
  value=$(math "$fee * 105 / 100")
  mark
  save MON_CCIP_SENT_AT "$(date -u +%FT%TZ)"
  send deployer "$TOKEN" 'approve(address,uint256)' "$ROUTER" "$MON_CCIP_AMOUNT"
  expect_event flows.approval
  send deployer "$ROUTER" "ccipSend(uint64,$CCIP_MSG_TYPE)" "$REMOTE_CHAIN_SELECTOR" \
    "$(ccip_message "$BRIDGE_USER" "$MON_CCIP_AMOUNT")" --value "$value"
  topic=$(cast keccak 'CCIPMessageSent(uint64,address,bytes32,address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[])')
  msg=$(jq -r --arg t "$topic" '[.logs[] | select(.topics[0]==$t)][0].topics[3]' <<<"$LAST_RECEIPT")
  [ -n "$msg" ] && [ "$msg" != null ] || die "no CCIPMessageSent in $LAST_TX"
  save MON_CCIP_MSG_ID "$msg"
  save MON_CCIP_DELIVERED 0
  info "messageId $msg  https://ccip.chain.link/msg/$msg"
  expect_event flows.endpoint-outflow
}

# ccip-wait: waits for the large-release alert on the remote chain, from any log line written after the send.
scenario_ccip_wait() {
  require_vars MON_CCIP_MSG_ID MON_CCIP_SENT_AT
  say "Monitor test: wait for the release of $MON_CCIP_MSG_ID on $REMOTE_CHAIN"
  local remote_mon
  case "$REMOTE_CHAIN" in bsc) remote_mon=bsc-testnet ;; *) remote_mon=$REMOTE_CHAIN ;; esac
  MARK=1
  _await 5400 ".msg == \"event alert\" and .rule == \"flows.large-transfer\" and .time > \"$MON_CCIP_SENT_AT\" and (.key | startswith(\"$remote_mon:\"))" \
    "large release on $remote_mon" >/dev/null
  ok "release seen on $remote_mon (flows.large-transfer)"
  save MON_CCIP_DELIVERED 1
}

scenario_predecessor() {
  say "Monitor test: queue conditions and a Guardian recovery stalled by its cancelled predecessor"
  local data_a data_b id_a salt_a
  data_a=$(cast calldata 'setFundingPaused(bool)' false)
  data_b=$(cast calldata 'setGuardian(address)' "$GUARDIAN_SAFE")
  mark
  schedule_raw "$MANAGER" "$data_a" "$ZERO32" pred-a
  id_a=$RAW_ID
  salt_a=$RAW_SALT
  CLEANUP+=("[ \"\$(op_state $id_a)\" = 0 ] || gov_exec \"\$TIMELOCK\" \"\$(cast calldata 'cancel(bytes32)' $id_a)\"")
  expect_event timelock.scheduled "setFundingPaused"
  expect_opened "timelock-queue:$id_a:soon"
  schedule_raw "$MANAGER" "$data_b" "$id_a" pred-b
  CLEANUP+=("[ \"\$(op_state $RAW_ID)\" = 0 ] || gov_exec \"\$TIMELOCK\" \"\$(cast calldata 'cancel(bytes32)' $RAW_ID)\"")
  expect_event timelock.scheduled "setGuardian|Guardian recovery"
  info "B = $RAW_ID waits for A = $id_a"
  tl_wait "$id_a"
  expect_opened "timelock-queue:$id_a:ready"
  expect_opened "timelock-queue:$RAW_ID:blocked"
  mark
  guardian_exec "$CONTROLLER" "$(cast calldata 'cancel(address,uint256,bytes,bytes32,bytes32)' "$MANAGER" 0 "$data_a" "$ZERO32" "$salt_a")"
  expect_event controller.proposal-cancelled
  expect_event timelock.cancelled "stalls a pending Guardian recovery"
  expect_resolved "timelock-queue:$id_a:ready"
  mark
  gov_exec "$TIMELOCK" "$(cast calldata 'cancel(bytes32)' "$RAW_ID")"
  expect_event timelock.cancelled
  expect_resolved "timelock-queue:$RAW_ID:blocked"
  CLEANUP=()
}

guardian_restore_batch() {
  batch_reset
  batch_add "$MANAGER" "$(cast calldata 'setFundingPaused(bool)' false)"
  batch_add "$MANAGER" "$(cast calldata 'setRecallPaused(bool)' false)"
  batch_add "$MANAGER" "$(cast calldata 'setFundingOperator(address,bool)' "$FUNDING_OP" true)"
  batch_add "$MANAGER" "$(cast calldata 'setRecallOperator(address,bool)' "$RECALL_OP" true)"
  batch_add "$MANAGER" "$(cast calldata 'setAdapterStatus(uint256,bool,bool)' 1 true true)"
}

scenario_guardian() {
  say "Monitor test: Guardian restrictions as state conditions, then the Timelock restore"
  guardian_restore_batch
  CLEANUP+=("tl_execute_label mon-guardian-restore")
  tl_schedule_batch mon-guardian-restore
  mark
  guardian_exec "$MANAGER" "$(cast calldata 'pauseFunding()')"
  guardian_exec "$MANAGER" "$(cast calldata 'pauseRecall()')"
  guardian_exec "$MANAGER" "$(cast calldata 'suspendFundingOperator(address)' "$FUNDING_OP")"
  guardian_exec "$MANAGER" "$(cast calldata 'suspendRecallOperator(address)' "$RECALL_OP")"
  guardian_exec "$MANAGER" "$(cast calldata 'restrictAdapter(uint256,bool,bool)' 1 true true)"
  expect_event manager.guardian-action "restricted an adapter"
  expect_opened "state-manager:funding-paused" warning
  expect_opened "state-manager:recall-paused" warning
  expect_opened "state-manager:funding-operator:" warning
  expect_opened "state-manager:recall-operator:" warning
  expect_opened "state-manager:adapter:1:funding-disabled" warning
  expect_opened "state-manager:adapter:1:recall-disabled" warning
  mark
  tl_execute_label mon-guardian-restore
  CLEANUP=()
  for k in funding-paused recall-paused funding-operator: recall-operator: adapter:1:funding-disabled adapter:1:recall-disabled; do
    expect_resolved "state-manager:$k"
  done
}

scenario_limits() {
  say "Monitor test: budget low and exhausted, pool below its minimum, and their restore"
  # Step: refill rate = capacity (the budget is full again within a second), pool trigger above the balance.
  batch_reset
  batch_add "$MANAGER" "$(cast calldata 'setPoolFundingBudget(address,uint256,uint256)' "$POOL" "$POOL_FUNDING_CAPACITY" "$POOL_FUNDING_CAPACITY")"
  batch_add "$MANAGER" "$(cast calldata 'setPoolThresholds(address,uint256,uint256,uint256)' "$POOL" "$POOL_MINIMUM" 150000000000000000000000 200000000000000000000000)"
  CLEANUP+=("tl_execute_label mon-limits-step" "tl_execute_label mon-limits-restore")
  tl_schedule_batch mon-limits-step
  batch_reset
  batch_add "$MANAGER" "$(cast calldata 'setPoolFundingBudget(address,uint256,uint256)' "$POOL" "$POOL_FUNDING_CAPACITY" "$POOL_FUNDING_RATE")"
  batch_add "$MANAGER" "$(cast calldata 'setPoolThresholds(address,uint256,uint256,uint256)' "$POOL" "$POOL_MINIMUM" "$REFILL_TRIGGER" "$REFILL_TARGET")"
  tl_schedule_batch mon-limits-restore
  mark
  guardian_exec "$MANAGER" "$(cast calldata 'reducePoolFundingBudget(address,uint256,uint256)' "$POOL" 100000000000000000000 0)"
  expect_event manager.guardian-action "reduced a pool funding budget"
  send lmtest-funding "$MANAGER" 'fund(uint256,uint256)' 1 90000000000000000000
  expect_event manager.funded
  expect_opened "state-manager:budget:" warning
  send lmtest-funding "$MANAGER" 'fund(uint256,uint256)' 1 10000000000000000000
  expect_opened "state-manager:budget:" high
  guardian_exec "$MANAGER" "$(cast calldata 'raisePoolMinimum(address,uint256)' "$POOL" 200000000000000000000000)"
  expect_opened "state-inventory:$POOL_LC" critical
  mark
  tl_execute_label mon-limits-step
  expect_resolved "state-manager:budget:"
  expect_opened "state-inventory:$POOL_LC" warning
  mark
  tl_execute_label mon-limits-restore
  CLEANUP=()
  expect_resolved "state-inventory:$POOL_LC"
}

# The skewed spec keeps the remote chain selector, so the remote token and pools are compared (a selector the pool does
# not support raises state-pool chains instead and skips them).
SKEW_KEYS=("state-pool:$POOL_LC:router" "state-pool:$POOL_LC:type-and-version"
  "state-pool:$POOL_LC:remote-token" "state-pool:$POOL_LC:remote-pools" "state-pool:$POOL_LC:rate-limit-admin"
  "state-manager:verify-adapter:1" "state-manager:pending-owner" "state-registry:pending-admin"
  "state-manager:verify-handover" "state-timelock:missing-role:CANCELLER:$(lc "$CONTROLLER")"
  "state-timelock:forbidden-role:CANCELLER:$(lc "$GUARDIAN_SAFE")" "state-timelock:min-delay")

renounce_guardian_canceller() {
  [ "$(call "$TIMELOCK" 'hasRole(bytes32,address)(bool)' "$CANCELLER_ROLE" "$GUARDIAN_SAFE")" = false ] ||
    guardian_exec "$TIMELOCK" "$(cast calldata 'renounceRole(bytes32,address)' "$CANCELLER_ROLE" "$GUARDIAN_SAFE")"
}

scenario_skew() {
  say "Monitor test: spec, ownership, registry admin, roles, delay and rateLimitAdmin skewed by one batch, then restored"
  local spec_before delay k
  spec_before=$(call "$MANAGER" 'getPoolSpec(address)((string,address,uint64,bytes,bytes[],address),bool)' "$POOL")
  delay=$(callnum "$TIMELOCK" 'getMinDelay()(uint256)')
  batch_reset
  batch_add "$MANAGER" "$(pool_spec_data "LockReleaseTokenPool 1.6.3-dev" "$ROUTER" "$REMOTE_CHAIN_SELECTOR" \
    "$REMOTE_TOKEN" "$REMOTE_POOL" "$CONTROLLER")"
  batch_add "$MANAGER" "$(cast calldata 'transferOwnership(address)' "$ZERO")"
  batch_add "$TOKEN_ADMIN_REGISTRY" "$(cast calldata 'transferAdminRole(address,address)' "$TOKEN" "$ZERO")"
  batch_add "$TIMELOCK" "$(cast calldata 'grantRole(bytes32,address)' "$CANCELLER_ROLE" "$CONTROLLER")"
  batch_add "$TIMELOCK" "$(cast calldata 'updateDelay(uint256)' "$delay")"
  batch_add "$POOL" "$(cast calldata 'setRateLimitAdmin(address)' "$CONTROLLER")"
  simulate_batch
  CHANGE_ID=
  CLEANUP+=('undo_pair "$CHANGE_ID" mon-skew-restore' renounce_guardian_canceller)
  tl_schedule_batch mon-skew-restore
  mark
  batch_reset
  batch_add "$MANAGER" "$(pool_spec_data "LockReleaseTokenPool 1.6.3-dev-x" "$DEPLOYER" "$REMOTE_CHAIN_SELECTOR" \
    0x000000000000000000000000000000000000dEaD 0x000000000000000000000000000000000000bEEF "$CONTROLLER")"
  batch_add "$MANAGER" "$(cast calldata 'transferOwnership(address)' "$GOVERNANCE_SAFE")"
  batch_add "$TOKEN_ADMIN_REGISTRY" "$(cast calldata 'transferAdminRole(address,address)' "$TOKEN" "$GOVERNANCE_SAFE")"
  batch_add "$TIMELOCK" "$(cast calldata 'revokeRole(bytes32,address)' "$CANCELLER_ROLE" "$CONTROLLER")"
  batch_add "$TIMELOCK" "$(cast calldata 'grantRole(bytes32,address)' "$CANCELLER_ROLE" "$GUARDIAN_SAFE")"
  batch_add "$TIMELOCK" "$(cast calldata 'updateDelay(uint256)' $((delay + 1)))"
  batch_add "$POOL" "$(cast calldata 'setRateLimitAdmin(address)' "$GOVERNANCE_SAFE")"
  simulate_batch
  tl_schedule_batch mon-skew
  CHANGE_ID=$OP_ID
  tl_execute_label mon-skew
  fail_point skew-after-change
  expect_event timelock.executed
  expect_event timelock.role "revoked"
  expect_event timelock.delay
  expect_event registry.admin
  expect_event pool.config "Rate limit admin"
  for k in "${SKEW_KEYS[@]}"; do expect_opened "$k" critical; done
  mark
  tl_execute_label mon-skew-restore
  renounce_guardian_canceller
  CLEANUP=()
  assert_eq "pool spec restored" "$(call "$MANAGER" 'getPoolSpec(address)((string,address,uint64,bytes,bytes[],address),bool)' "$POOL")" "$spec_before"
  assert_eq "Timelock delay restored" "$(callnum "$TIMELOCK" 'getMinDelay()(uint256)')" "$delay"
  for k in "${SKEW_KEYS[@]}"; do expect_resolved "$k"; done
}

scenario_ratelimits() {
  say "Monitor test: outbound bucket disabled, inbound changed, lockdown, restore (buckets restart from zero)"
  require_quiet_bridge
  local restore
  restore=$(cast calldata 'setChainRateLimiterConfig(uint64,(bool,uint128,uint128),(bool,uint128,uint128))' \
    "$REMOTE_CHAIN_SELECTOR" "(true,$RL_OUT_CAPACITY,$RL_OUT_RATE)" "(true,$RL_IN_CAPACITY,$RL_IN_RATE)")
  CHANGE_ID=
  CLEANUP+=('undo_pair "$CHANGE_ID" mon-rl-restore')
  tl_schedule mon-rl-restore "$POOL" "$restore"
  mark
  tl_schedule mon-rl-skew "$POOL" "$(cast calldata 'setChainRateLimiterConfig(uint64,(bool,uint128,uint128),(bool,uint128,uint128))' \
    "$REMOTE_CHAIN_SELECTOR" "(false,0,0)" "(true,90000000000000000000000,$RL_IN_RATE)")"
  CHANGE_ID=$OP_ID
  tl_execute_label mon-rl-skew
  fail_point ratelimits-after-change
  expect_event pool.rate-limits "disabled"
  expect_opened "state-pool:$POOL_LC:.*:outbound" critical
  expect_opened "state-pool:$POOL_LC:.*:inbound" high
  guardian_exec "$CONTROLLER" "$(cast calldata 'lockdown(address)' "$POOL")"
  expect_event controller.lockdown
  expect_opened "state-pool:$POOL_LC:.*:lockdown" critical
  mark
  tl_execute_label mon-rl-restore
  CLEANUP=()
  expect_resolved "state-pool:$POOL_LC:.*:lockdown"
}

scenario_inflow() {
  say "Monitor test: an outside account sends MTK to the legacy wallet"
  [ "$(math "$(cast balance "$BRIDGE_USER" --rpc-url "$RPC") < 1000000000000000")" = 0 ] ||
    send deployer "$BRIDGE_USER" --value 0.002ether
  mark
  send lmtest-user "$TOKEN" 'transfer(address,uint256)' "$DEPLOYER" 1000000000000000000
  expect_event flows.endpoint-inflow
}

[ $# -gt 0 ] || die "usage: CHAIN=<chain> $0 <scenario>..."
for s in "$@"; do
  STEP="monitor-$s"
  "scenario_${s//-/_}"
done
