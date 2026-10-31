#!/usr/bin/env bash
# Step 6: Timelock cancellation and Guardian recovery.
#   - the Guardian cancels a malicious proposal (single operation and a mixed batch) through the GuardianController
#   - the Governance Safe withdraws one of its own proposals
#   - a standalone setGuardian is protected: the Guardian cannot cancel it; executing it replaces the Guardian and
#     revokes the old one's restriction, cancellation and lockdown authority at once
source "$(dirname "$0")/lib.sh"
require_vars MANAGER CONTROLLER TIMELOCK GUARDIAN_SAFE
need_gas lmtest-governance lmtest-guardian

# If the step dies between scheduling a test proposal and its cancellation, Governance withdraws it on exit, so no
# executable "malicious" operation is left behind.
cleanup_cancel_tests() {
  local label id st
  for label in malicious-migrate mixed-batch governance-withdraw; do
    id=$(_op_get "$label" ID)
    [ -n "$id" ] || continue
    st=$(op_state "$id" 2>/dev/null || echo '?')
    if [ "$st" = 1 ] || [ "$st" = 2 ]; then
      info "withdrawing leftover test proposal '$label' ($id)"
      gov_exec "$TIMELOCK" "$(cast calldata 'cancel(bytes32)' "$id")" || info "could not withdraw $id: cancel it by hand"
    fi
    _op_clear "$label"
  done
}
trap cleanup_cancel_tests EXIT

if [ "$(lc "$(call "$MANAGER" 'guardian()(address)')")" = "$(lc "$GUARDIAN2")" ]; then
  info "Guardian recovery already executed in an earlier run: only re-checking the powers"
  _op_clear guardian-recovery
else
assert_eq "Guardian before the drill" "$(call "$MANAGER" 'guardian()(address)')" "$GUARDIAN_SAFE"

say "Malicious proposal: migrateReserves(attacker, max) -> cancelled by the Guardian"
data=$(cast calldata 'migrateReserves(address,uint256)' "$ATTACKER" "$UINT_MAX")
assert_eq "isProtectedCall(migrateReserves)" "$(call "$CONTROLLER" 'isProtectedCall(address,uint256,bytes)(bool)' "$MANAGER" 0 "$data")" false
tl_schedule malicious-migrate "$MANAGER" "$data"
guardian_exec "$CONTROLLER" "$(cast calldata 'cancel(address,uint256,bytes,bytes32,bytes32)' "$MANAGER" 0 "$data" "$ZERO32" "$OP_SALT")"
assert_eq "malicious operation state (0 = cancelled)" "$(op_state "$OP_ID")" 0
_op_clear malicious-migrate
expect_revert "$GOVERNANCE_SAFE" 'TimelockUnexpectedOperationState(bytes32,bytes32)' "$TIMELOCK" \
  'execute(address,uint256,bytes,bytes32,bytes32)' "$MANAGER" 0 "$data" "$ZERO32" "$OP_SALT"

say "Mixed batch [setGuardian(guardian2), setFundingPaused(true)] is not protected -> cancelled by the Guardian"
batch_reset
batch_add "$MANAGER" "$(cast calldata 'setGuardian(address)' "$GUARDIAN2")"
batch_add "$MANAGER" "$(cast calldata 'setFundingPaused(bool)' true)"
tl_schedule_batch mixed-batch
fail_point before-guardian-cancel
guardian_exec "$CONTROLLER" "$(cast calldata 'cancelBatch(address[],uint256[],bytes[],bytes32,bytes32)' "$BT" "$BV" "$BD" "$ZERO32" "$OP_SALT")"
assert_eq "mixed batch state (0 = cancelled)" "$(op_state "$OP_ID")" 0
_op_clear mixed-batch

say "The Governance Safe withdraws its own proposal (it keeps CANCELLER_ROLE)"
tl_schedule governance-withdraw "$MANAGER" "$(cast calldata 'setFundingPaused(bool)' true)"
gov_exec "$TIMELOCK" "$(cast calldata 'cancel(bytes32)' "$OP_ID")"
assert_eq "withdrawn operation state" "$(op_state "$OP_ID")" 0
_op_clear governance-withdraw

say "Protection rules of isProtectedCall"
sg=$(cast calldata 'setGuardian(address)' "$GUARDIAN2")
assert_eq "setGuardian, value 0, 36 bytes" "$(call "$CONTROLLER" 'isProtectedCall(address,uint256,bytes)(bool)' "$MANAGER" 0 "$sg")" true
assert_eq "setGuardian with one padding byte" "$(call "$CONTROLLER" 'isProtectedCall(address,uint256,bytes)(bool)' "$MANAGER" 0 "${sg}00")" false
assert_eq "setGuardian with value 1" "$(call "$CONTROLLER" 'isProtectedCall(address,uint256,bytes)(bool)' "$MANAGER" 1 "$sg")" false
assert_eq "setGuardian on another target" "$(call "$CONTROLLER" 'isProtectedCall(address,uint256,bytes)(bool)' "$TIMELOCK" 0 "$sg")" false

say "Guardian recovery: Governance schedules setGuardian(guardian2) alone, predecessor 0"
tl_schedule guardian-recovery "$MANAGER" "$sg"
expect_revert "$GUARDIAN_SAFE" 'ProtectedOperation(bytes32)' "$CONTROLLER" \
  'cancel(address,uint256,bytes,bytes32,bytes32)' "$MANAGER" 0 "$sg" "$ZERO32" "$OP_SALT"
expect_revert "$GUARDIAN_SAFE" 'ProtectedOperation(bytes32)' "$CONTROLLER" \
  'cancelBatch(address[],uint256[],bytes[],bytes32,bytes32)' "[$MANAGER]" "[0]" "[$sg]" "$ZERO32" "$OP_SALT"
expect_revert "$GUARDIAN_SAFE" 'AccessControlUnauthorizedAccount(address,bytes32)' "$TIMELOCK" 'cancel(bytes32)' "$OP_ID"
tl_execute
assert_eq "Guardian" "$(call "$MANAGER" 'guardian()(address)')" "$GUARDIAN2"
fi

say "The old Guardian lost every power at once; the new one has them"
expect_revert "$GUARDIAN_SAFE" 'CallerNotGuardian(address)' "$MANAGER" 'pauseFunding()'
expect_revert "$GUARDIAN_SAFE" 'CallerNotGuardian(address)' "$CONTROLLER" 'lockdown(address)' "$POOL"
expect_revert "$GUARDIAN_SAFE" 'CallerNotGuardian(address)' "$CONTROLLER" \
  'cancel(address,uint256,bytes,bytes32,bytes32)' "$MANAGER" 0 "$(cast calldata 'setGuardian(address)' "$GUARDIAN_SAFE")" "$ZERO32" "$ZERO32"
expect_ok "$GUARDIAN2" "$MANAGER" 'pauseFunding()'
expect_ok "$GUARDIAN2" "$CONTROLLER" 'lockdown(address)' "$POOL"
