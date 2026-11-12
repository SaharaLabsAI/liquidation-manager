#!/usr/bin/env bash
# Step 0: checks the live pre-handover state, creates the 1-of-1 Governance and Guardian Safe stand-ins (Safe 1.4.1)
# and prepares the reserve wallet(s).
source "$(dirname "$0")/lib.sh"

SAFE_SINGLETON=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762 # SafeL2 1.4.1 (same address on Ethereum and BSC)
SAFE_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67   # SafeProxyFactory 1.4.1
SAFE_FALLBACK=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99  # CompatibilityFallbackHandler 1.4.1
SAFE_GUARD_SLOT=0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8 # keccak256("guard_manager.guard.address")

registry_config() { call "$TOKEN_ADMIN_REGISTRY" 'getTokenConfig(address)((address,address,address))' "$TOKEN" | tr -d ' '; }

say "Live pre-handover state (fork block $(cast block-number --rpc-url "$RPC"))"
assert_eq "chain id" "$(cast chain-id --rpc-url "$RPC")" "$CHAIN_ID"
assert_eq "pool version" "$(call "$POOL" 'typeAndVersion()(string)')" '"LockReleaseTokenPool 1.6.3-dev"'
assert_eq "pool token" "$(call "$POOL" 'getToken()(address)')" "$TOKEN"
assert_eq "pool router" "$(call "$POOL" 'getRouter()(address)')" "$ROUTER"
assert_eq "pool supported chains" "$(call "$POOL" 'getSupportedChains()(uint64[])' | sed 's/ \[[^]]*\]//g')" "[$REMOTE_CHAIN_SELECTOR]"
assert_eq "pool owner (legacy multisig)" "$(call "$POOL" 'owner()(address)')" "$LEGACY_MULTISIG"
assert_eq "pool rebalancer" "$(call "$POOL" 'getRebalancer()(address)')" "$PREVIOUS_REBALANCER"
assert_eq "pool rateLimitAdmin" "$(call "$POOL" 'getRateLimitAdmin()(address)')" "$PREVIOUS_REBALANCER"
assert_eq "registry config (admin, pending, pool)" "$(registry_config)" "($LEGACY_MULTISIG,$ZERO,$POOL)"
assert_eq "token owner (legacy multisig)" "$(call "$TOKEN" 'owner()(address)')" "$LEGACY_MULTISIG"
assert_eq "token paused" "$(call "$TOKEN" 'paused()(bool)')" false
info "legacy multisig: Safe $(call "$LEGACY_MULTISIG" 'VERSION()(string)'), $(callnum "$LEGACY_MULTISIG" 'getThreshold()(uint256)') of $(call "$LEGACY_MULTISIG" 'getOwners()(address[])' | tr ',' '\n' | wc -l | tr -d ' ') owners, nonce $(callnum "$LEGACY_MULTISIG" 'nonce()(uint256)')"
assert_eq "legacy multisig guard (none: the MultiSend is not filtered)" \
  "$(cast storage "$LEGACY_MULTISIG" "$SAFE_GUARD_SLOT" --rpc-url "$RPC")" "$ZERO32"
assert_eq "MultiSendCallOnly deployed" "$([ "$(cast code "$MULTISEND_CALL_ONLY" --rpc-url "$RPC")" != 0x ] && echo yes)" yes
save POOL_BALANCE_BEFORE "$(bal "$POOL")"
info "pool liquidity before the activation: $(tok "$POOL_BALANCE_BEFORE") SAHARA"
rate_limits
info "deployer $DEPLOYER: nonce $(cast nonce "$DEPLOYER" --rpc-url "$RPC") (the four contract addresses follow from it)"

# create_safe <owner actor> <label> <varName>
create_safe() {
  local owner_actor=$1 label=$2 var=$3 owner init salt predicted
  owner=$(acct_addr "$owner_actor")
  init=$(cast calldata 'setup(address[],uint256,address,bytes,address,address,uint256,address)' \
    "[$owner]" 1 "$ZERO" 0x "$SAFE_FALLBACK" "$ZERO" 0 "$ZERO")
  salt=$(cast keccak "lm-mainnet-fork:$label")
  predicted=$(call --from "$owner" "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)(address)' \
    "$SAFE_SINGLETON" "$init" "$salt")
  send "$owner_actor" "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)' "$SAFE_SINGLETON" "$init" "$salt"
  save "$var" "$predicted"
  assert_eq "$label owners" "$(call "${!var}" 'getOwners()(address[])')" "[$owner]"
  assert_eq "$label threshold" "$(callnum "${!var}" 'getThreshold()(uint256)')" 1
}

say "Governance Safe and Guardian Safe stand-ins (1-of-1 SafeL2 1.4.1)"
assert_eq "Safe singleton version" "$(call "$SAFE_SINGLETON" 'VERSION()(string)')" '"1.4.1"'
create_safe governance-owner governance-safe GOVERNANCE_SAFE
create_safe guardian-owner guardian-safe GUARDIAN_SAFE

say "Reserve wallets"
if [ -z "$RESERVE_WALLETS" ]; then
  info "no RESERVE_WALLETS given: simulated wallet $RESERVE_WALLET receives $(tok "$RESERVE_AMOUNT") SAHARA on the fork"
  deal_token "$RESERVE_WALLET" "$RESERVE_AMOUNT"
  save RESERVE_WALLETS "$RESERVE_WALLET"
else
  save RESERVE_WALLETS "$RESERVE_WALLETS"
fi
total=0
for w in $(reserve_wallets); do
  b=$(bal "$w")
  info "reserve wallet $w: $(tok "$b") SAHARA"
  total=$(math "$total + $b")
done
[ "$(math "$total >= $SMALL_BATCH")" = 1 ] || die "the reserve wallets hold less than the small batch"
save RESERVES_TOTAL "$total"
info "reserves to move into the Manager: $(tok "$total") SAHARA"
