# SAHARA Liquidity Manager

Contracts that replace discretionary SAHARA reserve transfers with bounded, on-chain liquidity operations for the
Ethereum ⇄ BSC Chainlink CCIP lane. One independent deployment per chain.

```
Governance Safe ──schedule──▶ SaharaTimelock (72h) ──owns──▶ LiquidityManager · CCIP pool · registry admin · token
Guardian Safe ──restrict──▶ LiquidityManager
              └──────────▶ GuardianController ──▶ Timelock.cancel  (everything except its own removal)
                                             └─▶ pool.setChainRateLimiterConfig  (zero-only lockdown)

Funding Operator ─ fund(adapterId, amount) ─▶ LiquidityManager ─▶ CCIPPoolAdapter ─ provideLiquidity ─▶ LockReleaseTokenPool
Recall Operator ── recall(adapterId, amount) ▶ LiquidityManager ◀─ CCIPPoolAdapter ◀ withdrawLiquidity ─ LockReleaseTokenPool
```

| Contract | Purpose |
| --- | --- |
| [`LiquidityManager`](src/LiquidityManager.sol) | Holds unallocated reserves. Adapter registry, pool verification, funding budgets, recall limits, pool minimums, Guardian restrictions. Non-upgradeable, `Ownable2Step`, owned by the Timelock. |
| [`CCIPPoolAdapter`](src/CCIPPoolAdapter.sol) | Sole rebalancer of one `LockReleaseTokenPool`. Immutable Manager, token and pool; `fund`/`recall` callable only by the Manager. No owner, no rescue, no arbitrary calls. |
| [`GuardianController`](src/GuardianController.sol) | Holds the Timelock `CANCELLER_ROLE` and the pool `rateLimitAdmin`. The current Guardian (read from the Manager) cancels any proposal except a standalone `setGuardian`, and can only zero the pool rate limits. Ownerless. |
| [`SaharaTimelock`](src/SaharaTimelock.sol) | OpenZeppelin `TimelockController`: self-administered, delay bounded by immutable `[MINIMUM_DELAY, MAXIMUM_DELAY]`, explicit executors, GuardianController as additional canceller. |
| [`TokenBucket`](src/libraries/TokenBucket.sol) | Capacity/refill budget that never resets usage. |

Deployed dependencies, identical addresses on both chains: SAHARA `0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111`
(fixed supply, OZ v5 ERC20 + Pausable + Ownable) and the CCIP pool `0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4`
(`LockReleaseTokenPool 1.6.3-dev`).

## Permissions

| Operation | Caller | Timing |
| --- | --- | --- |
| `fund(adapterId, amount)` | Funding Operator | Immediate, within limits |
| `recall(adapterId, amount)` | Recall Operator | Immediate, within limits and above the pool minimum |
| `pauseFunding`, `pauseRecall`, `suspendFundingOperator`, `suspendRecallOperator`, `restrictAdapter`, `revokePoolMigrationApproval`, `reduceMaxFundingPerCall`, `reduceAggregateFundingBudget`, `reducePoolFundingBudget`, `reduceRecallLimits`, `raisePoolMinimum` | Guardian | Immediate, restrict only |
| `registerAdapter`, `replaceAdapter`, `setAdapterStatus` (reactivate), `setPoolSpec`, `setPoolThresholds`, `setPoolMigrationApproval` | Timelock | Full delay |
| `setFundingOperator`, `setRecallOperator`, `setFundingPaused`, `setRecallPaused`, `setMaxFundingPerCall`, `setAggregateFundingBudget`, `setPoolFundingBudget`, `setRecallLimits` | Timelock | Full delay |
| `setGuardian` (remove or replace) | Timelock | Full delay; the only proposal the Guardian cannot cancel |
| `migrateReserves`, `recoverToken`, `transferOwnership` | Timelock | Full delay |
| Adapter `fund` / `recall` | The immutable Manager | Same transaction |
| `GuardianController.cancel` / `cancelBatch` | Current Guardian | Immediate |
| `GuardianController.lockdown(pool)` | Current Guardian | Immediate, zero-only |
| Views (`getAdapter`, `getAdapterHistory`, `getPoolSpec`, `getPoolThresholds`, budget getters, `verifyAdapter`, `verifyHandover`, …) | Anyone | Read-only |

Guardian restrictions are enforced in code: limits, budget capacities and refill rates only decrease; the pool
minimum only increases; pauses, suspensions and adapter restrictions only switch off. Restoring any of them requires
the Timelock. Every Guardian call emits `GuardianAction(guardian, selector)`. Operator roles are mutually exclusive
and cannot be granted to the Guardian; `setGuardian` revokes any operator role the new Guardian held (it never
reverts). `renounceOwnership` is disabled.

## Fund and recall

`fund(adapterId, amount)`:
1. Funding Operator, funding not paused, adapter funding enabled, `0 < amount <= maxFundingPerCall`.
2. Pool verification (below).
3. Consumes the aggregate and the per-pool funding budget.
4. Manager → adapter (`amount`); adapter approves exactly `amount` (zero allowance required on entry), calls
   `provideLiquidity(amount)`, resets the allowance to zero and checks it.
5. Requires Manager −amount, pool +amount, adapter balance unchanged (measured before the transfer) and zero
   adapter-to-pool allowance; otherwise the whole transaction reverts.

`recall(adapterId, amount)`:
1. Recall Operator, recall not paused, adapter recall enabled, `0 < amount <= maxRecallPerCall`.
2. Consumes the recall budget; requires `poolBalance - amount >= poolMinimum`.
3. Adapter calls `withdrawLiquidity(amount)` (the pool pays only its rebalancer) and forwards `amount` to the
   immutable Manager.
4. Requires Manager +amount, pool −amount, adapter balance unchanged.

No operation takes a caller-selected recipient, target or calldata. The registry fixes the pool; recalls can only
reach the Manager.

### Pool verification

Run at `registerAdapter`, `replaceAdapter`, before every `fund`, and on demand via `verifyAdapter(adapterId)`. The
pool address comes from the Manager's registry, never from the adapter.

- adapter and pool have code; adapter reports this Manager, the token and the registered pool;
- `pool.getToken()` is SAHARA and `typeAndVersion()` equals the pinned string;
- the TokenAdminRegistry maps SAHARA to the pool (or, with a migration approval, to the approved source pool);
- `pool.getRebalancer()` is the adapter; `pool.getRouter()` is the approved Router;
- the pool supports exactly one chain, the counterpart selector, with the expected remote token and exactly the
  expected remote-pool set;
- `pool.owner()` is the Manager's owner (the Timelock) and `pool.getRateLimitAdmin()` is the approved
  GuardianController.

`registerAdapter` additionally requires pool thresholds to be set and `verifyHandover()`: the Timelock administers
SAHARA in the TokenAdminRegistry (no transfer pending) and owns the token. `replaceAdapter` runs the pool checks only,
so an emergency replacement never depends on token or registry administration.

### Budgets

Funding is bounded by a per-call limit, an aggregate capacity/refill bucket across all pools (including old and
replacement pools during a cutover) and a per-pool bucket keyed by pool address. Recall is bounded by a per-call limit
and a recall bucket. Buckets refill linearly at `rate` tokens per second up to `capacity`.

- Usage is never reset: recalls never credit funding budgets; re-registration, adapter replacement, pause/unpause and
  reconfiguration keep the consumed amount (`available = min(refilled, newCapacity)`).
- A bucket's first configuration by the Timelock starts it full. A Guardian reduction of a never-configured bucket
  leaves it unconfigured.
- One adapter id per pool, forever, so aliases cannot multiply budgets.
- Budgets bound Manager funding only. Initial inventory, user inflows, direct transfers to the pool and owner-mediated
  pool migrations are outside them.

## Governance and Guardian recovery

- The Governance Safe is the sole proposer and keeps `CANCELLER_ROLE`, so it can withdraw its own proposals. The
  GuardianController is the only other canceller. The Guardian Safe holds no Timelock role.
- The Timelock administers itself. `updateDelay` must be scheduled with the current delay and stays within
  `[MINIMUM_DELAY, MAXIMUM_DELAY]` (`MAXIMUM_DELAY` itself is capped at 90 days). Executors are explicit accounts (no
  open execution), and every proposer must also be an executor, so governance can always execute its own recovery.
- Protected operation: `LiquidityManager.setGuardian(address)` with value 0 and exactly the canonical 36-byte
  calldata, scheduled as a single operation or a batch of exactly one call. The Guardian cannot cancel it; mixed
  batches and every other proposal remain cancellable. `setGuardian` has no pause or Guardian-controlled checks, and
  replacing the Guardian on the Manager revokes its restriction, cancellation and lockdown authority at once.
- Lockdown sets both rate-limit buckets of every supported chain of a recognised pool (registered in the Manager or
  currently mapped in the TokenAdminRegistry) to enabled, zero capacity, zero refill. Restoration needs the Timelock as
  pool owner.

## Deployment and handover

Per chain, from a fresh deployer with no pending transaction:

```sh
TOKEN=0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111 TOKEN_ADMIN_REGISTRY=<registry> POOL=0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4 \
GOVERNANCE_SAFE=<safe> GUARDIAN_SAFE=<guardian> \
forge script script/Deploy.s.sol:Deploy --rpc-url <rpc> --sender <deployer> --broadcast --slow --verify
```

`Deploy` creates the Timelock, Manager, GuardianController and adapter in a fixed nonce order (the Timelock grants
`CANCELLER_ROLE` to the controller's predicted address). Before broadcasting it checks the inputs (Safes are
contracts, the registry maps SAHARA to the pool, no pending deployer transaction); afterwards it checks the wiring and
that the deployer, the Guardian and the controller hold no unexpected Timelock role. `EXECUTOR` optionally adds a
keeper as executor next to the Governance Safe. Recover from an interrupted broadcast only with
`forge script --resume`; never continue manually from a partially deployed Timelock.

Then `script/Handover.s.sol:Handover` (env additionally `LEGACY_MULTISIG`, `GOVERNANCE_SAFE`) checks live state and
prints the calls for the handover (`HandoverPlan`):

- preflight: deployment wiring (controller bindings and `CANCELLER_ROLE`, Safe roles by duty: the legacy multisig may
  also be the Governance Safe), the legacy multisig still holding every authority, the live pool matching the full
  PoolSpec (version, Router, counterpart chain, remote token and remote pools), operator and threshold sanity;
- simulation: runs the legacy calls and the Timelock batch on the current state and requires `verifyHandover`,
  `verifyAdapter` and the pool authorities to hold afterwards, then reverts the state. Any input that would make the
  batch revert is caught before the legacy multisig hands over the (single-step) token ownership.


1. Legacy multisig (current pool owner, registry administrator and token owner), ideally one MultiSend:
   `pool.setRateLimitAdmin(controller)`, `pool.transferOwnership(timelock)`,
   `registry.transferAdminRole(SAHARA, timelock)`, `SAHARA.transferOwnership(timelock)`.
   The Guardian can lock the pool down from this point; the existing rebalancer keeps operating.
2. Governance Safe schedules one Timelock batch and executes it after the delay: `pool.acceptOwnership()`,
   `pool.setRebalancer(adapter)`, `registry.acceptAdminRole(SAHARA)`, `setPoolSpec`, `setPoolThresholds`, budgets and
   limits, operators, `registerAdapter`. The batch is atomic and `registerAdapter` re-verifies every authority.
   To keep the mixed-authority window short (token already with the Timelock, pool and registry still with the legacy
   multisig), schedule the batch first and send the legacy MultiSend shortly before it becomes executable; a batch
   that reverts stays scheduled and can be executed once the legacy calls are in. Before execution, the legacy
   multisig can abort by proposing `address(0)` as pool owner and registry administrator; returning the token needs a
   Timelock operation.
3. Move legacy reserves into the Manager with plain transfers. The monitor counts reserves in `R` only at the
   addresses it knows, so list every reserve wallet in its `reserves.legacyWallets` from its first run and keep each
   one there until it is empty (see the monitor's
   [handover notes](monitor/README.md#before-during-and-after-the-handover)).

Operating parameters (pool minimum/trigger/target, funding and recall limits, budgets) are still TBD per the design
document and are passed to `Handover` through the environment.

### Runbook notes

- Schedule a Guardian recovery as exactly `abi.encodeCall(LiquidityManager.setGuardian, (newGuardian))`, value 0,
  **predecessor `bytes32(0)`**, single operation, and check `GuardianController.isProtectedCall` first. A recovery
  with a predecessor can be stalled by cancelling the predecessor; padded calldata is not protected.
- Pending protected `setGuardian` operations belong on the queue watch list; only the Governance Safe can withdraw them.
- Full-balance reserve migration: `migrateReserves(to, type(uint256).max)`. Adapters and other contracts bound to the
  Manager (including the GuardianController) and pools known to the Manager or the registry are rejected as
  destinations. Check any other destination off-chain.
- Pool migration: pre-fund the replacement pool with `setPoolMigrationApproval(newPool, currentRegistryPool)`; the
  approval is inactive while the registry maps the token to any other pool, but it is not consumed: revoke it
  (`setPoolMigrationApproval(newPool, address(0))`) in the cutover batch, or it becomes active again if the registry
  ever returns to the source pool. The new pool's budget starts full, so the aggregate budget
  is what bounds old and new pools together. Owner-mediated `transferLiquidity` bypasses the Manager budgets and
  requires resetting the old pool's rebalancer to its adapter afterwards.
- Restoring rate limits with `setChainRateLimiterConfig` starts the buckets from zero; `applyChainUpdates` (chain
  removal and re-add) starts them full and also rewrites remote configuration: review or cancel during incidents.
- `replaceAdapter` runs the full pool verification, so a retired pool's adapter can only be replaced while the pool
  still matches its spec (with a migration approval if it is no longer in the registry). Recall through the existing
  adapter does not depend on these checks.
- The GuardianController is bound to one Manager. Replacing the Manager requires a new controller (new canceller and
  `rateLimitAdmin`), arranged while an honest Guardian is in place.
- The TokenAdminRegistry address is immutable in the Manager; a CCIP registry migration requires a new Manager.
- Never renounce token ownership or move registry administration away from the Timelock: `registerAdapter` (new pools)
  would be permanently blocked. Funding, recall and `replaceAdapter` do not depend on it.
- `raisePoolMinimum` may lift the minimum above the published refill trigger/target; keepers should use
  `max(minimum, trigger)`. A Guardian reduction of a never-configured budget emits a `(0, 0)` event but leaves the
  budget unconfigured; to keep a new budget from starting full, cancel the queued first configuration instead.
- `setGuardian` has no revert path so recovery always executes. `updateDelay` with an out-of-range value reverts at
  execution and stays scheduled until cancelled.
- Monitor: Manager, adapter and pool balances and inflows, `Funded`/`Recalled`, `GuardianAction` and every
  configuration event, Timelock `CallScheduled`/`Cancelled`/`MinDelayChange` and role events, pool owner, rebalancer,
  `rateLimitAdmin`, Router, remote configuration and rate limits, registry mapping and administrator, token owner and
  `paused()`. The read-only monitor in [`monitor/`](monitor/README.md) covers all of these; its
  [rule catalog](monitor/README.md#rule-catalog) lists every alert with its severity and first response.

## Development

```sh
forge build --sizes
forge test                                   # unit, fuzz and invariant tests (offline)
RUN_FORK_TESTS=true forge test --match-path 'test/fork/*'   # against live Ethereum and BSC state
```

Fork tests read `ETH_RPC_URL` and `BSC_RPC_URL` (defaulting to public endpoints) and exercise the real pool,
TokenAdminRegistry, Router and token, including the full deploy-and-handover sequence and the scripts' `run()` entry
points. CI runs them in a separate job; set the `ETH_RPC_URL`/`BSC_RPC_URL` repository secrets to avoid public RPC
rate limits. The local
`MockLockReleaseTokenPool` reproduces the liquidity, rebalancer and rate-limit validation semantics but not the
two-step ownership or token-bucket accounting; the fork tests are authoritative for those.

The off-chain duties from the design (cross-chain reconciliation `R − I ≥ 10B`, stale-telemetry alerts for recall
suspension, 24/7 monitoring and Telegram alerting) are implemented by the read-only monitor in
[`monitor/`](monitor/README.md). It holds no keys and only alerts; recall suspension and every other response is a
Guardian or Timelock action.

Design documents are kept outside version control (`docs/`). Section 8 of the design draft (deployment and migration
requirements) is referenced but not included; the migration mechanism here is a proposal pending that section.
