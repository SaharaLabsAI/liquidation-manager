#!/usr/bin/env bash
# Runs `forge test` with the given arguments and fails if any test was skipped.
# A skipped test is reported as passing by forge, which would hide a check that never ran.
set -euo pipefail

log="$(mktemp)"
forge test "$@" 2>&1 | tee "$log"

summary="$(grep -E '^Ran [0-9]+ test suites? in ' "$log" | tail -n 1 || true)"
if [[ -z "$summary" ]]; then
  echo "::error::No forge test summary found; refusing to treat the run as passing."
  exit 1
fi
if ! grep -Eq ', 0 skipped \(' <<<"$summary"; then
  echo "::error::Skipped tests are not allowed: $summary"
  exit 1
fi
