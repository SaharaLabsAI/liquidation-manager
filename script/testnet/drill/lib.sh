#!/usr/bin/env bash
# Shared helpers for the testnet drill. Source from a step script with CHAIN=sepolia|bsc set.
#
# Modes:
#   live (default)       RPC from chains/<chain>.env; state in deployments/<chain>.env, tx log in deployments/<chain>.txlog
#   fork (FORK_RPC=url)  same steps against an anvil fork (see fork.sh); state in deployments/<chain>.fork.env and
#                        Timelock delays are skipped with evm_increaseTime. Use it to rehearse a step before broadcasting.
#
# Every state-changing call is gas-estimated first (a revert aborts the step before anything is sent), must end with
# status 1 and is appended to the tx log. Expected reverts are checked with eth_call against the exact error selector.
# Timelock operations are persisted under a label before they are scheduled, so a step that dies part-way can be run
# again: a pending operation with the same label and calldata is reused, a stale one is cancelled.
set -euo pipefail

DRILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTNET_DIR="$(dirname "$DRILL_DIR")"
ROOT_DIR="$(cd "$TESTNET_DIR/../.." && pwd)"
# Another drill (script/mainnet-fork) reuses these helpers with its own accounts/params/chains and state directory.
CONFIG_DIR=${DRILL_CONFIG_DIR:-$DRILL_DIR}
DEPLOYMENTS_DIR=${DRILL_DEPLOYMENTS_DIR:-$TESTNET_DIR/deployments}
SALT_PREFIX=${DRILL_SALT_PREFIX:-lm-testnet-drill}

: "${CHAIN:?set CHAIN=sepolia or CHAIN=bsc}"
# cast and forge read CHAIN as their --chain option: keep it a shell variable only.
export -n CHAIN
# shellcheck source=/dev/null
source "$CONFIG_DIR/accounts.env"
# shellcheck source=/dev/null
source "$CONFIG_DIR/params.env"
# shellcheck source=/dev/null
source "$CONFIG_DIR/chains/$CHAIN.env"

if [ -n "${FORK_RPC:-}" ]; then
  MODE=fork
  RPC=$FORK_RPC
  DEPLOYMENT_FILE="$DEPLOYMENTS_DIR/$CHAIN.fork.env"
  TXLOG="$DEPLOYMENTS_DIR/$CHAIN.fork.txlog"
  # The fork keeps the testnet chain id; keep its forge broadcast records away from the live ones.
  export FOUNDRY_BROADCAST="$DEPLOYMENTS_DIR/fork-broadcast"
  BROADCAST_DIR=$FOUNDRY_BROADCAST
else
  MODE=live
  DEPLOYMENT_FILE="$DEPLOYMENTS_DIR/$CHAIN.env"
  TXLOG="$DEPLOYMENTS_DIR/$CHAIN.txlog"
  BROADCAST_DIR="$ROOT_DIR/broadcast"
fi
mkdir -p "$DEPLOYMENTS_DIR"
touch "$DEPLOYMENT_FILE" "$TXLOG"
# shellcheck source=/dev/null
source "$DEPLOYMENT_FILE"

STEP="${STEP:-$(basename "$0" .sh)}"
NOTE=""

ZERO=0x0000000000000000000000000000000000000000
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
UINT_MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935
TRANSFER_TOPIC=0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
MIN_GAS=${MIN_GAS:-0.002}
# Public RPCs drop connections: fail a hung request after 20 s (default 45) so the retries below can take over.
export ETH_RPC_TIMEOUT=${ETH_RPC_TIMEOUT:-20}

# ---------------------------------------------------------------- output

say() {
  NOTE="$*"
  printf '\n\033[1m[%s %s] %s\033[0m\n' "$CHAIN" "$MODE" "$*"
}
ok() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
info() { printf '  ..   %s\n' "$*"; }
die() {
  printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2
  exit 1
}

# fail_point <name>: aborts here when FAIL_AT=<name>, to rehearse resuming a step on a fork.
fail_point() {
  if [ "${FAIL_AT:-}" = "$1" ]; then die "injected failure at '$1' (FAIL_AT)"; fi
}

# ---------------------------------------------------------------- state

# save KEY VALUE: persists KEY=VALUE in the deployment file and sets it in this shell.
save() {
  local key=$1 value=$2
  [ -n "$value" ] || die "refusing to save an empty $key (a read failed?)"
  grep -v "^$key=" "$DEPLOYMENT_FILE" >"$DEPLOYMENT_FILE.tmp" || true
  echo "$key=$value" >>"$DEPLOYMENT_FILE.tmp"
  mv "$DEPLOYMENT_FILE.tmp" "$DEPLOYMENT_FILE"
  printf -v "$key" '%s' "$value"
}

# unsave KEY: removes KEY from the deployment file and this shell.
unsave() {
  grep -v "^$1=" "$DEPLOYMENT_FILE" >"$DEPLOYMENT_FILE.tmp" || true
  mv "$DEPLOYMENT_FILE.tmp" "$DEPLOYMENT_FILE"
  unset "$1"
}

require_vars() {
  local v
  for v in "$@"; do [ -n "${!v:-}" ] || die "$v is not set (run the earlier steps first)"; done
}

# keystore name -> address
acct_addr() {
  case "$1" in
    deployer) echo "$DEPLOYER" ;;
    lmtest-governance) echo "$GOV_OWNER" ;;
    lmtest-guardian) echo "$GUARDIAN_OWNER" ;;
    lmtest-guardian2) echo "$GUARDIAN2" ;;
    lmtest-funding) echo "$FUNDING_OP" ;;
    lmtest-recall) echo "$RECALL_OP" ;;
    lmtest-recovery) echo "$RECOVERY" ;;
    lmtest-user) echo "$BRIDGE_USER" ;;
    lmtest-attacker) echo "$ATTACKER" ;;
    *) die "unknown keystore $1" ;;
  esac
}

# ---------------------------------------------------------------- numbers

lc() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
num() { awk '{print $1}'; } # strips cast's " [1e18]" annotation
math() { BC_LINE_LENGTH=0 bc <<<"$1"; }
tok() { # wei -> whole tokens with 4 decimals, for display
  local v
  v=$(math "scale=4; $1 / 10^18")
  case "$v" in .* | -.*) v=${v/./0.} ;; esac
  echo "$v"
}
# tuple_field <cast tuple output> <n>: the n-th field of "(a [x], b, ...)" without annotations
tuple_field() { tr -d '() ' <<<"$1" | sed 's/\[[^]]*\]//g' | cut -d, -f"$2"; }

# ---------------------------------------------------------------- reads

# _cast_call <args>: cast call with up to 3 attempts on transport errors (never retried on a revert).
_cast_call() {
  local out i
  for i in 1 2 3; do
    if out=$(cast call --rpc-url "$RPC" "$@" 2>&1); then
      printf '%s\n' "$out"
      return 0
    fi
    case "$out" in *revert*) break ;; esac
    sleep 2
  done
  printf '%s\n' "$out"
  return 1
}
call() {
  local out
  out=$(_cast_call "$@") || die "call failed: $1 ${2:0:60}: $(decode_error "$out")"
  printf '%s\n' "$out"
}
callnum() { call "$@" | num; }
bal() { callnum "$TOKEN" 'balanceOf(address)(uint256)' "$1"; }

# need_gas <keystore>...: every account a step sends from must hold at least MIN_GAS native.
need_gas() {
  local k a b
  for k in "$@"; do
    a=$(acct_addr "$k")
    b=$(cast balance "$a" --rpc-url "$RPC")
    [ "$(math "$b >= $(cast to-wei "$MIN_GAS")")" = 1 ] ||
      die "$k ($a) has $(cast from-wei "$b") native, below $MIN_GAS: top it up (00-setup.sh)"
  done
}

# Refuse to run against the wrong network.
if [ "$MODE" = live ]; then
  [ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN_ID" ] || die "RPC $RPC is not chain $CHAIN_ID"
else
  cast rpc --rpc-url "$RPC" web3_clientVersion 2>/dev/null | grep -qi anvil || die "FORK_RPC $RPC is not an anvil fork"
fi

# ---------------------------------------------------------------- error decoding

KNOWN_ERRORS=(
  'Unauthorized(address)' 'InsufficientLiquidity()' 'NonExistentChain(uint64)' 'ZeroAddressInvalid()'
  'OnlyCallableByOwner()' 'MustBeProposedOwner()' 'CannotTransferToSelf()'
  'TokenMaxCapacityExceeded(uint256,uint256,address)' 'TokenRateLimitReached(uint256,uint256,address)'
  'OnlyAdministrator(address,address)' 'OnlyPendingAdministrator(address,address)'
  'EnforcedPause()' 'ExpectedPause()' 'OwnableUnauthorizedAccount(address)'
  'ERC20InsufficientBalance(address,uint256,uint256)' 'ERC20InsufficientAllowance(address,uint256,uint256)'
  'AccessControlUnauthorizedAccount(address,bytes32)' 'TimelockUnexpectedOperationState(bytes32,bytes32)'
  'TimelockUnexecutedPredecessor(bytes32)' 'TimelockInsufficientDelay(uint256,uint256)'
  'TimelockUnauthorizedCaller(address)' 'BudgetExceeded(uint256,uint256)' 'UnsupportedToken(address)'
  'InvalidRateLimitRate((bool,uint128,uint128))' 'Error(string)'
)

# decode_error <cast output>: names the custom error in a revert, if known
decode_error() {
  local data sel sig
  data=$(grep -oE 'data: "0x[0-9a-fA-F]+' <<<"$1" | head -1 | sed 's/data: "//') || true
  [ -n "$data" ] || {
    echo "$1"
    return
  }
  sel=$(lc "${data:0:10}")
  while read -r sig; do
    [ -n "$sig" ] || continue
    if [ "$(cast sig "$sig")" = "$sel" ]; then
      echo "$sig  data=$data"
      return
    fi
  done < <(printf '%s\n' "${KNOWN_ERRORS[@]}"; abi_errors)
  echo "unknown error $sel  data=$data"
}

abi_errors() {
  local f
  for f in LiquidityManager GuardianController CCIPPoolAdapter SaharaTimelock; do
    jq -r '.abi[] | select(.type=="error") | "\(.name)(\(.inputs | map(.type) | join(",")))"' \
      "$ROOT_DIR/out/$f.sol/$f.json" 2>/dev/null || true
  done
}

# ---------------------------------------------------------------- writes

# send <keystore> <to> <sig|calldata> [args...] [--value x]: estimates (aborts on revert, retries transport errors),
# broadcasts once, then polls the receipt itself (a dropped RPC connection while waiting does not lose the transaction),
# requires status 1, logs, sets LAST_TX and LAST_RECEIPT. A failed broadcast is never retried: the node may have
# received it.
send() {
  local acct=$1
  shift
  local from out est gas status hash i nonce0
  from=$(acct_addr "$acct")
  for i in 1 2 3 4 5; do
    if est=$(cast estimate --rpc-url "$RPC" --from "$from" "$@" 2>&1); then break; fi
    case "$est" in *revert*) die "would revert ($acct: $1 ${2:0:42}): $(decode_error "$est")" ;; esac
    [ "$i" -lt 5 ] || die "estimate failed ($acct: $1 ${2:0:42}): $est"
    sleep 3
  done
  gas=$((est * 13 / 10 + 30000))
  nonce0=$(cast nonce "$from" --rpc-url "$RPC" 2>/dev/null || echo '?')
  if ! out=$(cast send --rpc-url "$RPC" --account "$acct" --password '' --gas-limit "$gas" --async "$@" 2>&1); then
    die "broadcast failed ($acct: $1 ${2:0:42}); the account's nonce was $nonce0, check whether it moved before re-running: $(decode_error "$out")"
  fi
  hash=$(grep -oE '0x[0-9a-fA-F]{64}' <<<"$out" | tail -1)
  [ -n "$hash" ] || die "no transaction hash from cast send: $out"
  LAST_TX=$hash
  printf '%s | %s | %s | %s | %s | %s\n' "$(date -u +%FT%TZ)" "$STEP" "$NOTE" "$acct" "$1 ${2:0:66}" "$hash" >>"$TXLOG"
  out=
  for i in $(seq 1 180); do
    out=$(cast receipt "$hash" --rpc-url "$RPC" --async --json 2>/dev/null) || out=
    [ -n "$out" ] && [ "$(jq -r '.status // empty' <<<"$out" 2>/dev/null)" != "" ] && break
    out=
    sleep 4
  done
  [ -n "$out" ] || die "no receipt for $hash after 12 min ($acct: $1 ${2:0:42})"
  LAST_RECEIPT=$out
  status=$(jq -r .status <<<"$out")
  [ "$status" = "0x1" ] || die "reverted on chain: $hash"
  info "tx $hash ($acct)"
}

# safe_exec <ownerKeystore> <safe> <to> <calldata>: executes a call from a 1-of-1 Safe. The signature is the owner's
# pre-validated signature (r = owner, s = 0, v = 1), which Safe accepts because the owner is msg.sender. With
# safeTxGas = 0 and gasPrice = 0 a failing inner call reverts the whole transaction (GS013).
safe_exec() {
  local owner=$1 safe=$2 to=$3 data=$4 o
  o=$(lc "$(acct_addr "$owner")")
  local sig="0x000000000000000000000000${o#0x}0000000000000000000000000000000000000000000000000000000000000000""01"
  send "$owner" "$safe" 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' \
    "$to" 0 "$data" 0 0 0 0 "$ZERO" "$ZERO" "$sig"
}

gov_exec() { safe_exec lmtest-governance "$GOVERNANCE_SAFE" "$1" "$2"; }

# guardian_exec <to> <calldata>: acts as whoever the Manager currently records as Guardian.
guardian_exec() {
  local g
  g=$(lc "$(call "$MANAGER" 'guardian()(address)')")
  if [ "$g" = "$(lc "$GUARDIAN_SAFE")" ]; then
    safe_exec lmtest-guardian "$GUARDIAN_SAFE" "$1" "$2"
  elif [ "$g" = "$(lc "$GUARDIAN2")" ]; then
    send lmtest-guardian2 "$1" "$2"
  else
    die "no drill key for the current Guardian $g"
  fi
}

# tx_delta <address>: net token change of <address> in LAST_RECEIPT, summed from the token's Transfer logs. Unlike
# before/after balances it is immune to other transactions (e.g. an incoming CCIP release) and to lagging RPC nodes.
tx_delta() {
  local topic total=0 from to data
  topic=$(lc "$(cast abi-encode 'f(address)' "$1")")
  while read -r from to data; do
    [ -n "$from" ] || continue
    if [ "$to" = "$topic" ]; then total=$(math "$total + $(cast to-dec "$data")"); fi
    if [ "$from" = "$topic" ]; then total=$(math "$total - $(cast to-dec "$data")"); fi
  done < <(jq -r --arg t "$(lc "$TOKEN")" --arg e "$TRANSFER_TOPIC" \
    '.logs[] | select((.address | ascii_downcase) == $t and .topics[0] == $e) | "\(.topics[1]) \(.topics[2]) \(.data)"' \
    <<<"$LAST_RECEIPT")
  echo "$total"
}

# assert_tx_delta <label> <address> <expected signed delta in wei>: checks LAST_RECEIPT
assert_tx_delta() {
  local d
  d=$(tx_delta "$2")
  if [ "$d" = "$3" ]; then ok "$1 changed by $(tok "$3") in $LAST_TX"; else die "$1: expected change $3 in $LAST_TX, got $d"; fi
}

# ---------------------------------------------------------------- expectations

assert_eq() {
  if [ "$(lc "$2")" = "$(lc "$3")" ]; then ok "$1 = $3"; else die "$1: expected $3, got $2"; fi
}

assert_delta() { # <label> <before> <after> <expected signed delta in wei>
  local d
  d=$(math "$3 - $2")
  if [ "$d" = "$4" ]; then ok "$1 changed by $(tok "$4")"; else die "$1: expected change $4, got $d"; fi
}

# expect_revert <from> <errorSignature> <to> <sig|calldata> [args...]: eth_call must revert with exactly that error.
expect_revert() {
  local from=$1 err=$2
  shift 2
  local sel out
  sel=$(cast sig "$err")
  if out=$(_cast_call --from "$from" "$@"); then
    die "expected $err, but the call succeeded: $1 ${2:0:42}"
  fi
  if grep -qi "data: \"$sel" <<<"$out"; then
    ok "reverts $err  ($(echo "$2" | cut -c1-48))"
  else
    die "expected $err ($sel), got: $(decode_error "$out")"
  fi
}

# expect_ok <from> <to> <sig|calldata> [args...]: eth_call must succeed.
expect_ok() {
  local from=$1
  shift
  local out
  out=$(_cast_call --from "$from" "$@") || die "expected success: $1 ${2:0:42}: $(decode_error "$out")"
  ok "succeeds  ($(echo "$2" | cut -c1-48))"
}

# ---------------------------------------------------------------- Timelock (through the Governance Safe)

op_state() { callnum "$TIMELOCK" 'getOperationState(bytes32)(uint8)' "$1"; } # 0 Unset 1 Waiting 2 Ready 3 Done

batch_reset() {
  BATCH_T=()
  BATCH_D=()
}
batch_add() { # <target> <calldata>
  BATCH_T+=("$1")
  BATCH_D+=("$2")
}
_batch_args() {
  local IFS=, values=() t
  for t in "${BATCH_T[@]}"; do values+=(0); done
  BT="[${BATCH_T[*]}]"
  BV="[${values[*]}]"
  BD="[${BATCH_D[*]}]"
}

new_salt() { OP_SALT=$(cast keccak "$SALT_PREFIX:$CHAIN:$MODE:$1:$(date +%s)"); }

# tl_wait <id>: blocks until the operation is Ready. One state read per poll; transient RPC errors are retried;
# Unset (cancelled / unknown) and Done abort.
tl_wait() {
  if [ "$MODE" = fork ]; then
    cast rpc --rpc-url "$RPC" evm_increaseTime "$(($(callnum "$TIMELOCK" 'getMinDelay()(uint256)') + 1))" >/dev/null
    cast rpc --rpc-url "$RPC" evm_mine >/dev/null
  fi
  local waited=0 fails=0 s start
  start=$(date +%s)
  while :; do
    s=$(cast call --rpc-url "$RPC" "$TIMELOCK" 'getOperationState(bytes32)(uint8)' "$1" 2>/dev/null | num) || s=
    case "$s" in
      2) break ;;
      1) fails=0 ;;
      0 | 3) die "operation $1 is not pending (state $s: 0 = cancelled or unknown, 3 = already executed)" ;;
      *)
        fails=$((fails + 1))
        [ $fails -lt 20 ] || die "cannot read the state of operation $1"
        ;;
    esac
    sleep 6
    waited=$(($(date +%s) - start))
    [ $waited -lt 1800 ] || die "operation $1 not ready after 1800 s (state $s)"
  done
  # One more block, so a lagging node behind a load-balanced RPC agrees when execute is estimated.
  [ "$MODE" = fork ] || sleep "$BLOCK_TIME"
  info "operation ready after ${waited}s"
}

op_key() { printf 'OP_%s' "$(tr '[:lower:]-' '[:upper:]_' <<<"$1")"; }
_op_get() {
  local v
  v="$(op_key "$1")_$2"
  printf '%s' "${!v:-}"
}
_op_persist() { # <label> <single|batch>
  local k
  k=$(op_key "$1")
  save "${k}_ID" "$OP_ID"
  save "${k}_SALT" "$OP_SALT"
  save "${k}_KIND" "$2"
  if [ "$2" = single ]; then
    save "${k}_TARGET" "$OP_TARGET"
    save "${k}_DATA" "$OP_DATA"
  else
    save "${k}_BT" "$BT"
    save "${k}_BV" "$BV"
    save "${k}_BD" "$BD"
  fi
}
_op_clear() {
  local k s
  k=$(op_key "$1")
  for s in ID SALT KIND TARGET DATA BT BV BD; do unsave "${k}_$s"; done
}
_op_load() { # <label>: loads a persisted operation into OP_* / BT BV BD
  OP_LABEL=$1
  OP_ID=$(_op_get "$1" ID)
  OP_SALT=$(_op_get "$1" SALT)
  OP_KIND=$(_op_get "$1" KIND)
  OP_TARGET=$(_op_get "$1" TARGET)
  OP_DATA=$(_op_get "$1" DATA)
  BT=$(_op_get "$1" BT)
  BV=$(_op_get "$1" BV)
  BD=$(_op_get "$1" BD)
  [ -n "$OP_ID" ] || die "no persisted operation '$1'"
}

# _op_reuse <label> <kind> <calldata key>: decides what to do with an operation persisted under <label>.
# Returns 0 (and loads it) when it is pending or done with the same calldata; cancels it when it is pending with
# different calldata; returns 1 when a new operation must be scheduled.
_op_reuse() {
  local label=$1 kind=$2 key=$3 id st same=0
  OP_ALREADY_DONE=0
  id=$(_op_get "$label" ID)
  [ -n "$id" ] || return 1
  st=$(op_state "$id")
  if [ "$(_op_get "$label" KIND)" = "$kind" ]; then
    if [ "$kind" = single ]; then
      [ "$(lc "$(_op_get "$label" TARGET)$(_op_get "$label" DATA)")" = "$(lc "$key")" ] && same=1
    else
      [ "$(lc "$(_op_get "$label" BT)$(_op_get "$label" BD)")" = "$(lc "$key")" ] && same=1
    fi
  fi
  case "$st" in
    1 | 2)
      if [ $same = 1 ]; then
        _op_load "$label"
        info "reusing pending operation '$label' ($id, state $st)"
        return 0
      fi
      info "cancelling stale pending operation '$label' ($id)"
      gov_exec "$TIMELOCK" "$(cast calldata 'cancel(bytes32)' "$id")"
      ;;
    3)
      if [ $same = 1 ]; then
        _op_load "$label"
        OP_ALREADY_DONE=1
        info "operation '$label' ($id) was already executed in an earlier run"
        return 0
      fi
      ;;
  esac
  _op_clear "$label"
  return 1
}

# tl_schedule <label> <target> <calldata>: single operation, predecessor 0; sets OP_ID OP_SALT OP_TARGET OP_DATA.
tl_schedule() {
  OP_LABEL=$1
  OP_KIND=single
  _op_reuse "$1" single "$2$3" && return 0
  new_salt "$1"
  OP_TARGET=$2
  OP_DATA=$3
  local delay
  delay=$(callnum "$TIMELOCK" 'getMinDelay()(uint256)')
  OP_ID=$(call "$TIMELOCK" 'hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)' \
    "$OP_TARGET" 0 "$OP_DATA" "$ZERO32" "$OP_SALT")
  _op_persist "$1" single
  gov_exec "$TIMELOCK" "$(cast calldata 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' \
    "$OP_TARGET" 0 "$OP_DATA" "$ZERO32" "$OP_SALT" "$delay")"
  assert_eq "operation '$1' scheduled ($OP_ID) state" "$(op_state "$OP_ID")" 1
}

# tl_schedule_batch <label>: schedules BATCH_* (predecessor 0); sets OP_ID and OP_SALT.
tl_schedule_batch() {
  _batch_args
  OP_LABEL=$1
  OP_KIND=batch
  _op_reuse "$1" batch "$BT$BD" && return 0
  new_salt "$1"
  local delay
  delay=$(callnum "$TIMELOCK" 'getMinDelay()(uint256)')
  OP_ID=$(call "$TIMELOCK" 'hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32)(bytes32)' \
    "$BT" "$BV" "$BD" "$ZERO32" "$OP_SALT")
  _op_persist "$1" batch
  gov_exec "$TIMELOCK" "$(cast calldata 'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)' \
    "$BT" "$BV" "$BD" "$ZERO32" "$OP_SALT" "$delay")"
  assert_eq "batch '$1' scheduled ($OP_ID) state" "$(op_state "$OP_ID")" 1
}

# tl_execute: waits for and executes the current operation (OP_*), then forgets it.
tl_execute() {
  if [ "${OP_ALREADY_DONE:-0}" = 1 ]; then
    OP_ALREADY_DONE=0
    _op_clear "$OP_LABEL"
    return 0
  fi
  tl_wait "$OP_ID"
  if [ "$OP_KIND" = single ]; then
    gov_exec "$TIMELOCK" "$(cast calldata 'execute(address,uint256,bytes,bytes32,bytes32)' \
      "$OP_TARGET" 0 "$OP_DATA" "$ZERO32" "$OP_SALT")"
  else
    gov_exec "$TIMELOCK" "$(cast calldata 'executeBatch(address[],uint256[],bytes[],bytes32,bytes32)' \
      "$BT" "$BV" "$BD" "$ZERO32" "$OP_SALT")"
  fi
  assert_eq "operation '$OP_LABEL' executed, state" "$(op_state "$OP_ID")" 3
  _op_clear "$OP_LABEL"
}

# tl_execute_label <label>: executes an operation scheduled earlier under <label>.
tl_execute_label() {
  _op_load "$1"
  OP_ALREADY_DONE=0
  [ "$(op_state "$OP_ID")" != 3 ] || OP_ALREADY_DONE=1
  tl_execute
}

tl_single() {
  tl_schedule "$1" "$2" "$3"
  tl_execute
}

tl_batch() {
  tl_schedule_batch "$1"
  tl_execute
}

# ---------------------------------------------------------------- CCIP

# ccip_message <receiver> <amount>: the Client.EVM2AnyMessage tuple for a token-only transfer paid in native gas.
ccip_message() {
  echo "($(cast abi-encode 'f(address)' "$1"),0x,[($TOKEN,$2)],$ZERO,0x)"
}
CCIP_MSG_TYPE='(bytes,bytes,(address,uint256)[],address,bytes)'
ccip_fee() { callnum "$ROUTER" "getFee(uint64,$CCIP_MSG_TYPE)(uint256)" "$REMOTE_CHAIN_SELECTOR" "$(ccip_message "$1" "$2")"; }

rate_limits() { # prints outbound and inbound bucket state for the remote chain
  info "outbound (tokens, lastUpdated, enabled, capacity, rate): $(call "$POOL" \
    'getCurrentOutboundRateLimiterState(uint64)((uint128,uint32,bool,uint128,uint128))' "$REMOTE_CHAIN_SELECTOR")"
  info "inbound  (tokens, lastUpdated, enabled, capacity, rate): $(call "$POOL" \
    'getCurrentInboundRateLimiterState(uint64)((uint128,uint32,bool,uint128,uint128))' "$REMOTE_CHAIN_SELECTOR")"
}

# require_no_inflight: refuses to continue (live) unless the CCIP test transfers of both directions were delivered,
# so pausing the token, zeroing rate limits or draining the pool cannot fail a release in flight.
require_no_inflight() {
  [ "$MODE" = live ] || return 0
  local remote
  remote=$(bash -c "source '$DEPLOYMENTS_DIR/$REMOTE_CHAIN.env' 2>/dev/null; echo \${BRIDGE_DELIVERED:-}")
  [ "${BRIDGE_DELIVERED:-}" = 1 ] && [ "$remote" = 1 ] ||
    die "CCIP test transfers not confirmed delivered in both directions (run 04-bridge.sh wait on both chains)"
}

# ---------------------------------------------------------------- budgets and snapshot

pool_budget_available() { tuple_field "$(call "$MANAGER" 'getPoolFundingBudget(address)((uint256,uint256,uint256))' "$POOL")" 3; }
aggregate_budget_available() { tuple_field "$(call "$MANAGER" 'getAggregateFundingBudget()((uint256,uint256,uint256))')" 3; }
recall_budget_available() { tuple_field "$(call "$MANAGER" 'getRecallBudget()((uint256,uint256,uint256))')" 3; }
min_of() { math "a = $1; if ($2 < a) a = $2; if (${3:-$1} < a) a = ${3:-$1}; a"; }

# small_amount: min(100 MTK, available pool and aggregate funding budgets) for "it works again" checks after a
# restore (budgets refill slowly and consumed budget is never restored).
small_amount() { min_of 100000000000000000000 "$(pool_budget_available)" "$(aggregate_budget_available)"; }

adapter_of() { call "$MANAGER" 'getAdapter(uint256)((address,address,bool,bool))' "${1:-1}" | tr -d '() ' | cut -d, -f1; }

snapshot() {
  info "balances: Manager $(tok "$(bal "$MANAGER")") | pool $(tok "$(bal "$POOL")") | adapter $(tok "$(bal "$(adapter_of)")") | recovery $(tok "$(bal "$RECOVERY")") MTK"
}
