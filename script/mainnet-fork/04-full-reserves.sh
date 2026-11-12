#!/usr/bin/env bash
# Step 4: every reserve wallet moves its whole SAHARA balance into the Manager (plain transfers; the funding budgets
# bound only Manager -> pool funding, not reserves entering the Manager).
source "$(dirname "$0")/lib.sh"
require_vars MANAGER RESERVE_WALLETS RESERVES_TOTAL

manager_before=$(bal "$MANAGER")
moved=0
for w in $(reserve_wallets); do
  amount=$(bal "$w")
  if [ "$amount" = 0 ]; then
    info "reserve wallet $w is empty"
    continue
  fi
  say "Reserve wallet $w -> Manager: whole balance $(tok "$amount") SAHARA"
  send "$w" "$TOKEN" 'transfer(address,uint256)' "$MANAGER" "$amount"
  assert_tx_delta "Manager" "$MANAGER" "$amount"
  assert_eq "reserve wallet $w balance" "$(bal "$w")" 0
  moved=$(math "$moved + $amount")
done

say "All reserves are in the Manager"
assert_eq "Manager balance" "$(bal "$MANAGER")" "$(math "$manager_before + $moved")"
assert_eq "Manager holds every reserve token (small batch + the rest)" "$(bal "$MANAGER")" "$RESERVES_TOTAL"
assert_eq "pool liquidity unchanged" "$(bal "$POOL")" "$POOL_BALANCE_BEFORE"
expect_ok "$DEPLOYER" "$MANAGER" 'verifyAdapter(uint256)' 1
snapshot
