#!/usr/bin/env bash
# Step 0: gas for the drill accounts and the two 1-of-1 Safes (Governance, Guardian).
# The Safes are created by their owners (not the deployer) with a fixed salt, so they get the same address on both
# chains and the deployer nonce stays untouched for TestnetDeploy.
source "$(dirname "$0")/lib.sh"

SAFE_SINGLETON=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762 # SafeL2 1.4.1
SAFE_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67   # SafeProxyFactory 1.4.1
SAFE_FALLBACK=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99  # CompatibilityFallbackHandler 1.4.1

say "Preconditions: chain, legacy owner state"
assert_eq "chain id" "$(cast chain-id --rpc-url "$RPC")" "$CHAIN_ID"
assert_eq "Safe singleton version" "$(call "$SAFE_SINGLETON" 'VERSION()(string)')" '"1.4.1"'
assert_eq "pool owner (legacy)" "$(call "$POOL" 'owner()(address)')" "$DEPLOYER"
assert_eq "token owner (legacy)" "$(call "$TOKEN" 'owner()(address)')" "$DEPLOYER"
assert_eq "registry pool" "$(call "$TOKEN_ADMIN_REGISTRY" 'getPool(address)(address)' "$TOKEN")" "$POOL"
info "deployer: $(cast balance "$DEPLOYER" --ether --rpc-url "$RPC") native, $(tok "$(bal "$DEPLOYER")") MTK, nonce $(cast nonce "$DEPLOYER" --rpc-url "$RPC")"

say "Gas top-ups from the deployer"
topup() { # <address> <amount in ether>
  local have
  have=$(cast balance "$1" --rpc-url "$RPC")
  if [ "$(math "$have < $(cast to-wei "$2") / 2")" = 1 ]; then
    send deployer "$1" --value "$2ether"
  else
    info "$1 already has $(cast from-wei "$have")"
  fi
}
topup "$GOV_OWNER" "$GAS_GOV_OWNER"
topup "$GUARDIAN_OWNER" "$GAS_GUARDIAN_OWNER"
topup "$GUARDIAN2" "$GAS_GUARDIAN2"
topup "$FUNDING_OP" "$GAS_FUNDING_OP"
topup "$RECALL_OP" "$GAS_RECALL_OP"
topup "$RECOVERY" "$GAS_RECOVERY"

# create_safe <ownerKeystore> <label> <varName>
create_safe() {
  local owner_ks=$1 label=$2 var=$3 owner init salt predicted
  owner=$(acct_addr "$owner_ks")
  init=$(cast calldata 'setup(address[],uint256,address,bytes,address,address,uint256,address)' \
    "[$owner]" 1 "$ZERO" 0x "$SAFE_FALLBACK" "$ZERO" 0 "$ZERO")
  salt=$(cast keccak "lm-testnet-drill:$label")
  predicted=$(call --from "$owner" "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)(address)' \
    "$SAFE_SINGLETON" "$init" "$salt" 2>/dev/null || true)
  if [ -n "${!var:-}" ] && [ "$(cast code "${!var}" --rpc-url "$RPC")" != 0x ]; then
    info "$label Safe already deployed at ${!var}"
  else
    [ -n "$predicted" ] || die "cannot predict the $label Safe address"
    send "$owner_ks" "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)' "$SAFE_SINGLETON" "$init" "$salt"
    save "$var" "$predicted"
  fi
  assert_eq "$label Safe owners" "$(call "${!var}" 'getOwners()(address[])')" "[$owner]"
  assert_eq "$label Safe threshold" "$(callnum "${!var}" 'getThreshold()(uint256)')" 1
}

say "Governance Safe (1-of-1, owner lmtest-governance)"
create_safe lmtest-governance governance-safe GOVERNANCE_SAFE
say "Guardian Safe (1-of-1, owner lmtest-guardian)"
create_safe lmtest-guardian guardian-safe GUARDIAN_SAFE

say "Safe execution path check (eth_call of a no-op execTransaction from each owner)"
o=$(lc "$GOV_OWNER")
expect_ok "$GOV_OWNER" "$GOVERNANCE_SAFE" \
  'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)(bool)' \
  "$GOVERNANCE_SAFE" 0 0x 0 0 0 0 "$ZERO" "$ZERO" \
  "0x000000000000000000000000${o#0x}000000000000000000000000000000000000000000000000000000000000000001"

info "GOVERNANCE_SAFE=$GOVERNANCE_SAFE GUARDIAN_SAFE=$GUARDIAN_SAFE"
