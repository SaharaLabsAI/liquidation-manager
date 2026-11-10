#!/usr/bin/env bash
# Helpers for the mainnet activation rehearsal. FORK ONLY: every step runs against an anvil fork of Ethereum or BSC
# mainnet started by fork.sh (anvil --auto-impersonate). No key is ever used: every sender, including the real legacy
# multisig's owners, is impersonated, and native gas is set with anvil_setBalance.
#
# Reuses script/testnet/drill/lib.sh (checks, error decoding, Timelock operations through the Governance Safe) with this
# directory's accounts.env, params.env, chains/<chain>.env and deployments/ state, and overrides the parts that use
# keystores. Source from a step script with CHAIN=ethereum|bsc and FORK_RPC set.
set -euo pipefail

MAINNET_FORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${FORK_RPC:?FORK ONLY: start ./fork.sh <ethereum|bsc> <port> and set FORK_RPC=http://127.0.0.1:<port>}"
: "${CHAIN:?set CHAIN=ethereum or CHAIN=bsc}"
[ -f "$MAINNET_FORK_DIR/chains/$CHAIN.env" ] || {
  echo "unknown CHAIN $CHAIN (ethereum or bsc)" >&2
  exit 1
}
DRILL_CONFIG_DIR=$MAINNET_FORK_DIR
DRILL_DEPLOYMENTS_DIR=$MAINNET_FORK_DIR/deployments
DRILL_SALT_PREFIX=lm-mainnet-fork
# shellcheck source=../testnet/drill/lib.sh
source "$MAINNET_FORK_DIR/../testnet/drill/lib.sh"

# lib.sh has checked that FORK_RPC is anvil; also make sure it forks the chain this step was started for.
[ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || die "FORK_RPC $RPC is not a fork of $CHAIN (chain id $CHAIN_ID)"

# ---------------------------------------------------------------- actors (impersonated)

# actor name -> address; any 0x address is passed through (legacy multisig owners, reserve wallets, CCIP ramps)
acct_addr() {
  case "$1" in
    deployer) echo "$DEPLOYER" ;;
    governance-owner) echo "$GOV_OWNER" ;;
    guardian-owner) echo "$GUARDIAN_OWNER" ;;
    funding-operator) echo "$FUNDING_OP" ;;
    recall-operator) echo "$RECALL_OP" ;;
    bridge-user) echo "$BRIDGE_USER" ;;
    0x*) echo "$1" ;;
    *) die "unknown actor $1" ;;
  esac
}

# fund_native <address>: tops the account up to 100 native units (fork only).
fund_native() {
  if [ "$(math "$(cast balance "$1" --rpc-url "$RPC") < 10^18")" = 1 ]; then
    cast rpc --rpc-url "$RPC" anvil_setBalance "$1" 0x56BC75E2D63100000 >/dev/null
  fi
}
need_gas() {
  local k
  for k in "$@"; do fund_native "$(acct_addr "$k")"; done
}

# send <actor|address> <to> <sig|calldata> [args...] [--value x]: estimates (aborts on revert), sends as the
# impersonated account, requires status 1, logs, sets LAST_TX and LAST_RECEIPT.
send() {
  local acct=$1
  shift
  local from est gas out errf status
  from=$(acct_addr "$acct")
  fund_native "$from"
  est=$(cast estimate --rpc-url "$RPC" --from "$from" "$@" 2>&1) ||
    die "would revert ($acct: $1 ${2:0:42}): $(decode_error "$est")"
  gas=$((est * 13 / 10 + 30000))
  errf=$(mktemp)
  if ! out=$(cast send --rpc-url "$RPC" --unlocked --from "$from" --gas-limit "$gas" --json "$@" 2>"$errf"); then
    out=$(cat "$errf")
    rm -f "$errf"
    die "send failed ($acct: $1 ${2:0:42}): $(decode_error "$out")"
  fi
  rm -f "$errf"
  LAST_RECEIPT=$out
  LAST_TX=$(jq -r .transactionHash <<<"$out")
  printf '%s | %s | %s | %s | %s | %s\n' "$(date -u +%FT%TZ)" "$STEP" "$NOTE" "$acct" "$1 ${2:0:66}" "$LAST_TX" >>"$TXLOG"
  status=$(jq -r .status <<<"$out")
  [ "$status" = "0x1" ] || die "reverted: $LAST_TX"
  info "tx $LAST_TX ($acct)"
}

gov_exec() { safe_exec governance-owner "$GOVERNANCE_SAFE" "$1" "$2"; }

guardian_exec() {
  [ "$(lc "$(call "$MANAGER" 'guardian()(address)')")" = "$(lc "$GUARDIAN_SAFE")" ] ||
    die "the Manager's Guardian is not the Guardian Safe stand-in"
  safe_exec guardian-owner "$GUARDIAN_SAFE" "$1" "$2"
}

# ---------------------------------------------------------------- legacy multisig (real Safe, owners impersonated)

# multisend_data: reads "target" / "calldata" line pairs from stdin and prints MultiSendCallOnly.multiSend calldata
# (each call packed as operation 0 ++ to ++ value 0 ++ data length ++ data).
multisend_data() {
  local packed=0x t d
  while read -r t && read -r d; do
    d=${d#0x}
    packed+="00$(lc "${t#0x}")$(printf '%064x' 0)$(printf '%064x' $((${#d} / 2)))$d"
  done
  cast calldata 'multiSend(bytes)' "$packed"
}

# legacy_safe_exec <to> <data> <operation>: executes a transaction of the live legacy multisig at its current nonce,
# signed by its first <threshold> owners: all but one approve the Safe transaction hash on chain (approveHash), the
# last one executes; every signature is the pre-validated form (r = owner, s = 0, v = 1), sorted by owner address.
# Sets LEGACY_SAFE_TX_HASH.
legacy_safe_exec() {
  local to=$1 data=$2 op=$3 nonce threshold signers executor s sigs=0x
  nonce=$(callnum "$LEGACY_MULTISIG" 'nonce()(uint256)')
  threshold=$(callnum "$LEGACY_MULTISIG" 'getThreshold()(uint256)')
  LEGACY_SAFE_TX_HASH=$(call "$LEGACY_MULTISIG" \
    'getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)' \
    "$to" 0 "$data" "$op" 0 0 0 "$ZERO" "$ZERO" "$nonce")
  info "legacy Safe tx: nonce $nonce, threshold $threshold, safeTxHash $LEGACY_SAFE_TX_HASH"
  signers=$(call "$LEGACY_MULTISIG" 'getOwners()(address[])' | tr -d '[] ' | tr ',' '\n' | head -n "$threshold")
  [ "$(wc -l <<<"$signers" | tr -d ' ')" = "$threshold" ] || die "legacy Safe has fewer owners than its threshold"
  executor=$(tail -1 <<<"$signers")
  while read -r s; do
    [ "$s" = "$executor" ] && continue
    send "$s" "$LEGACY_MULTISIG" 'approveHash(bytes32)' "$LEGACY_SAFE_TX_HASH"
  done <<<"$signers"
  while read -r s; do
    sigs+="000000000000000000000000${s#0x}$(printf '%064x' 0)01"
  done < <(lc "$signers" | sort)
  send "$executor" "$LEGACY_MULTISIG" \
    'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' \
    "$to" 0 "$data" "$op" 0 0 0 "$ZERO" "$ZERO" "$sigs"
  assert_eq "legacy Safe nonce" "$(callnum "$LEGACY_MULTISIG" 'nonce()(uint256)')" "$((nonce + 1))"
}

# ---------------------------------------------------------------- token balances (fork only)

# deal_token <address> <amount>: sets the SAHARA balance by writing the token's balance mapping (fork only; the total
# supply is not adjusted).
deal_token() {
  local slot=${TOKEN_BALANCE_SLOT:-} s
  if [ -z "$slot" ]; then
    for s in $(seq 0 20); do
      if [ "$(cast to-dec "$(cast storage "$TOKEN" "$(cast index address "$POOL" "$s")" --rpc-url "$RPC")")" = "$(bal "$POOL")" ]; then
        slot=$s
        break
      fi
    done
    [ -n "$slot" ] || die "cannot find the balance mapping slot of $TOKEN"
    save TOKEN_BALANCE_SLOT "$slot"
  fi
  cast rpc --rpc-url "$RPC" anvil_setStorageAt "$TOKEN" "$(cast index address "$1" "$slot")" \
    "$(cast to-uint256 "$2")" >/dev/null
  assert_eq "SAHARA balance of $1" "$(bal "$1")" "$2"
}

reserve_wallets() { tr ',' '\n' <<<"$RESERVE_WALLETS" | sed '/^$/d'; }

# ---------------------------------------------------------------- views

budgets() {
  info "aggregate budget (capacity, rate, available): $(call "$MANAGER" 'getAggregateFundingBudget()((uint256,uint256,uint256))')"
  info "pool budget      (capacity, rate, available): $(call "$MANAGER" 'getPoolFundingBudget(address)((uint256,uint256,uint256))' "$POOL")"
  info "recall budget    (capacity, rate, available): $(call "$MANAGER" 'getRecallBudget()((uint256,uint256,uint256))')"
}

snapshot() {
  local r w=0
  for r in $(reserve_wallets); do w=$(math "$w + $(bal "$r")"); done
  info "balances: Manager $(tok "$(bal "$MANAGER")") | pool $(tok "$(bal "$POOL")") | adapter $(tok "$(bal "$ADAPTER")") | reserve wallets $(tok "$w") SAHARA"
}
