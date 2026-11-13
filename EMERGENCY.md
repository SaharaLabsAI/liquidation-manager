# Emergency runbook

What can be stopped, by whom and how fast, and every way to get SAHARA out of the LiquidityManager, the adapter and
the CCIP pool. Everything marked with a drill step in brackets, e.g. **[08 E5]**, was rehearsed on Sepolia ⇄ BSC
testnet with the real `LockReleaseTokenPool 1.6.3-dev`, TokenAdminRegistry 1.5.0 and Router 1.2.0
([`script/testnet/`](script/testnet/README.md)). Items marked **(not drilled)** are derived from the code and have not
been rehearsed yet; R10 was simulated on a fork only.

Contract references: [`LiquidityManager`](src/LiquidityManager.sol) (LM), [`GuardianController`](src/GuardianController.sol)
(GC), [`SaharaTimelock`](src/SaharaTimelock.sol) (TL). After the handover the Timelock owns the Manager, the pool and
the token and administers the token in the TokenAdminRegistry. The Governance Safe is its only proposer and executor.

## 1. Levers at a glance

| Lever | Who | Takes effect | Stops | Does not stop | Undo |
| --- | --- | --- | --- | --- | --- |
| `pauseFunding`, `suspendFundingOperator`, `restrictAdapter(id, true, _)`, `reduceMaxFundingPerCall`, `reduce*FundingBudget` | Guardian | Immediately | Manager → pool funding | recall, bridge, Timelock ops | Timelock, full delay **[05]** |
| `pauseRecall`, `suspendRecallOperator`, `restrictAdapter(id, _, true)`, `reduceRecallLimits`, `raisePoolMinimum` | Guardian | Immediately | pool → Manager recall | funding, bridge, Timelock ops | Timelock, full delay **[05]** |
| `GC.lockdown(pool)` | Guardian | Immediately | CCIP sends **and** releases through that pool (both buckets of every supported chain set to enabled, capacity 0, rate 0), including the releases of messages already in flight to this chain (R5) | fund, recall, every Timelock pool operation **[11 X3]**; sends on the other chain | Timelock `pool.setChainRateLimiterConfig`, buckets restart **empty** **[07]**; then execute the failed messages manually (R5) |
| `GC.cancel` / `GC.cancelBatch` | Guardian | Immediately | any pending operation, Waiting **or Ready** **[06, 11 X2]** | a standalone `setGuardian(address)` (protected) **[06]** | Re-schedule (same salt allowed after a cancel) **[11 X2]** |
| `TL.cancel(id)` | Governance Safe | Immediately | any pending operation, protected ones included **[06]** | | |
| `token.pause()` | Timelock | **After the full delay** | every SAHARA transfer: fund, recall, `migrateReserves`, CCIP lock and release, user transfers **[08 E4]** | | Timelock `unpause()`, full delay |
| `registry.setPool(SAHARA, 0)` | Timelock | After the full delay | bridging (token delisted) and fund (`PoolNotActiveInRegistry`) | recall, `migrateReserves`, lockdown **[11 X4]** | Timelock `setPool(SAHARA, pool)` |
| `pool.setRebalancer(0)` | Timelock | After the full delay | fund and recall (and any pool withdrawal by the adapter) | `migrateReserves` **[11 X4]** | Timelock `setRebalancer(adapter)` |
| `setGuardian(new)` (standalone) | Timelock | After the full delay | every power of the old Guardian, at once **[06]** | | |

There is **no immediate way to move funds**. Everything that moves SAHARA to an address of governance's choice is a
Timelock operation: it waits the full delay and the Guardian can cancel it until it executes. The only immediate
brakes are the Guardian's restrictions and the lockdown, and none of them moves funds. The token pause is not an
emergency switch: the Guardian cannot pause, and the Timelock's pause waits the full delay.

## 2. Where SAHARA can be and how it gets out

| Location | Way out | Actor, delay | Limits | Drill |
| --- | --- | --- | --- | --- |
| Manager | `migrateReserves(to, amount)`; `type(uint256).max` moves the balance at execution | Timelock, 1 delay | none (no budget, no pause check) | **[08 E6]** |
| Pool | `recall` into the Manager | Recall Operator, immediate | `maxRecallPerCall`, recall budget, pool minimum | **[03]** |
| Pool | Manager-mediated full exit: relax the limits, then recall everything (R3) | Timelock (1 delay) + Recall Operator | none after the relaxation | **[11 X1]** |
| Pool | Pool-owner drain (R2), bypassing the Manager | Timelock, 1 delay | the pool balance only | **[08 E5]** |
| Pool | `newPool.transferLiquidity(oldPool, amount)` (pool migration; `type(uint256).max` = live balance) | Timelock, 1 delay | none | not drilled (needs a second pool) |
| Timelock | `token.transfer(to, amount)` as a Timelock operation (or inside the same batch, as in R2) | Timelock, 1 delay | none | **[08 E5]** |
| Adapter | **none**. SAHARA sent to an adapter outside fund/recall stays there forever | — | — | |
| GuardianController | **none** | — | — | |
| Other ERC20 at the Manager | `recoverToken(token, to, amount)` (SAHARA is rejected) | Timelock, 1 delay | none | **[08 E2]** |
| ETH / NFTs at the Manager, non-SAHARA tokens at the pool | **none** | — | — | |

`migrateReserves` rejects destinations that cannot give tokens back or would bypass the funding budgets: zero, the
Manager itself, the token, any adapter ever registered, the pool (any pool known to the Manager or the registry) and
contracts reporting this Manager as `MANAGER()`, e.g. the GuardianController (LM:397) **[08 E1]**. Any other
destination must be checked off-chain.

## 3. Recipes

All Timelock operations: the Governance Safe calls `schedule` / `scheduleBatch` with predecessor `bytes32(0)` and
`getMinDelay()`, waits, then calls `execute` / `executeBatch` with the same arguments. Collect the execute signatures
during the delay. Before scheduling, simulate the batch on a fork of the live chain (`script/testnet/drill/fork.sh`
does this for the testnets).

### R1 Reserves out of the Manager

```
LM.migrateReserves(dest, type(uint256).max)
```

Paused token: `migrateReserves` reverts `EnforcedPause` **[08 E4]**. Use one batch **(not drilled)**
`[token.unpause(), LM.migrateReserves(dest, max), token.pause()]`. If the token is unpaused before execution, the
first call reverts and the batch cannot run, so schedule a plain `migrateReserves` alongside it.

### R2 Pool drain bypassing the Manager (pool owner)

One batch, in this order **[08 E5]**:

```
pool.setRebalancer(timelock)
pool.withdrawLiquidity(x)          // pays msg.sender = the Timelock
token.transfer(dest, x)
pool.setRebalancer(currentAdapter) // LM.getAdapter(id).adapter
```

- Bypasses the operators, per-call limits, budgets, pool minimum, pauses and adapter status. On testnet it moved the
  whole pool (≈131k MTK against a 30k per-call limit and a 20k minimum) in one transaction, left nothing at the
  Timelock, and `verifyAdapter` passed afterwards.
- Without the last call the adapter is no longer the rebalancer: fund reverts `PoolRebalancerMismatch`, recall reverts
  `Unauthorized(adapter)`.
- `withdrawLiquidity` has no "max". `x` is fixed when the batch is scheduled; if the pool holds less at execution the
  batch reverts `InsufficientLiquidity` and stays Ready. Lock the pool down and pause recall first, so only direct
  transfers can still change the balance (they only raise it), and cancel the operation if it fails, so it cannot
  fire later when the pool refills.
- Draining below what in-flight CCIP releases need makes them fail on this chain; they can be executed manually on
  the OffRamp once inventory is back.

### R3 Full exit through the Manager

When the Manager should end up holding the pool inventory (e.g. before R1) **[11 X1]**:

```
batch: LM.setPoolThresholds(pool, 0, 0, 0)
       LM.setRecallLimits(P, P, P)          // rate >= capacity: the bucket is full one block later
then, in a later block: Recall Operator LM.recall(id, P)
```

Raising a budget never restores what was consumed: the available amount refills from where it was at `rate` per
second. A Guardian can re-restrict right after the batch; replace a hostile Guardian first (R6). `setAdapterStatus`
writes both flags: pass the current funding flag.

### R4 Replace the adapter

```
batch: pool.setRebalancer(newAdapter)
       LM.replaceAdapter(id, newAdapter)    // runs the full pool verification
```

`replaceAdapter` alone reverts `PoolRebalancerMismatch` **[08 E3]**. The old adapter stays in `getAdapterHistory`,
is rejected as a migration destination and can no longer withdraw from the pool. **Before the ETA, verify the new
adapter's bytecode against `CCIPPoolAdapter`**: `_verifyPool` only checks that its `MANAGER()`, `TOKEN()` and `POOL()`
views match (LM:550), and the batch makes it the pool's rebalancer, which can withdraw directly.

### R5 Bridge lockdown and restore

```
Guardian: GC.lockdown(pool)                                              // each chain separately
Timelock: pool.setChainRateLimiterConfig(remoteSelector, outCfg, inCfg) // original {true, capacity, rate}
```

- Record the limits before locking down. After the restore both buckets start at 0 and refill at `rate` **[07]**.
- `rate > capacity` reverts `InvalidRateLimitRate` **[11 X3]**. Do not use `applyChainUpdates` (remove + add) to
  restore: it starts the buckets full and rewrites the remote configuration.
- A restore can be scheduled before the lockdown so the delay overlaps the incident **[07]**; during an incident the
  Guardian must cancel any restore it did not expect.
- Messages already in flight to a locked-down chain fail there and wait for a manual execution after the restore
  (below).

**In-flight transfers (not drilled).** `run-live.sh` starts 07 only once every test transfer is delivered, so no
message was in flight during the testnet lockdown. The pool side is fork-tested against the live pools
(`test_fork_lockdown_haltsRealBridgeTransfers`, `testFuzz_fork_lockdownRejectsEveryTransfer`,
`test_fork_lockdown_timelockRestoresAndBucketsRefillFromZero`); the OffRamp side is as the monitor records it. Chain A
locked down, B its counterpart:

| Message | Effect |
| --- | --- |
| A → B, sent after the lockdown | `ccipSend` on A reverts `TokenMaxCapacityExceeded` (A's outbound bucket) **[07]**: nothing is locked, no message exists. |
| A → B, sent before the lockdown | Not affected by it (the outbound bucket was consumed at send): released on B, unless B is locked down too. |
| B → A, sent while B's outbound bucket is open (before B's lockdown, or at any time if B is not locked down) | B's pool has locked the SAHARA. The release on A reverts in A's inbound bucket with `TokenMaxCapacityExceeded`, so the execution fails on A's OffRamp: the receiver gets nothing, the SAHARA stays locked on B and the message stays in `I`. |

- The monitor raises `ccip.message-failed` on A, with the reason `TokenHandlingError(target=…,
  err=TokenMaxCapacityExceeded(…truncated))` on OffRamp 2.0.0, and lists the message in `reconcile.failed-messages`. A
  message the executor has not attempted yet shows up as `reconcile.stuck-message` after `ccip.stuckAfterSec` instead.
- Manual execution calls the same `releaseOrMint` and consumes the same bucket: it cannot bypass the lockdown, and after
  the restore it succeeds only once the bucket has refilled to the message's amount. On OffRamp 2.0.0 a manual attempt
  that fails again reverts and leaves no log, so retrying early only costs gas.

**Lock down both chains.** A's lockdown does not stop sends on B: until B is locked down as well, B keeps accepting
sends to A, locks their SAHARA, and every one of them fails on A. Locking B fails the A → B messages still in flight
there instead, a set that stops growing once A is locked. Each lockdown is a separate Guardian Safe transaction on its
own chain: prepare both, lock the chain whose releases are at risk first, then the other, and add the A → B messages
that fail on B to the list below.

**Track the unsettled messages.** From the lockdown on, keep the list of every SAHARA message not executed in either
direction (message id, direction, amount, receiver); it is the retry list. The monitor's `check` prints all of them
(failed and stuck, each with its CCIP explorer link) and `I` per lane; `ccip.message-failed` raises each failure,
`reconcile.failed-messages` shows the first 10 and counts the rest, `reconcile.stuck-message` raises each message
without an execution, and the [CCIP explorer](https://ccip.chain.link) for both pools is the cross-check. Messages
sent to a chain while it is locked down extend the list.

**Check the list before the restore.** Once the inbound bucket is restored, any message to that chain that the bucket
covers can be executed, listed or not: OffRamp 2.0.0 `execute` is permissionless. Before scheduling the restore, find
the source-chain send of every failed message that `check` shows with an unknown amount (no send seen). If there is
none, the message is unbacked: keep the lockdown and escalate instead of restoring.

**Retry after the restore.** On the destination chain of each listed message:

1. The restored inbound capacity must cover the largest listed amount: above the capacity the release reverts
   `TokenMaxCapacityExceeded` however long the bucket refills. Check it when restoring lower limits than before.
2. The bucket restarts empty **[07]**, so a message of `amount` can execute `amount / rate` seconds after the restore at
   the earliest, and later if new transfers consume the bucket first. With the current pool limits (capacity 300M,
   3,500 SAHARA/s): about 48 min for 10M, 24 h for the full capacity. `getCurrentInboundRateLimiterState(remote).tokens`
   is what is available now.
3. The pool must hold the amount, or the release fails with `ERC20InsufficientBalance` (e.g. after R2). Fund the pool
   first. If the Guardian paused funding, `fund` reverts `FundingIsPaused` until a Timelock `LM.setFundingPaused(false)`
   executes: schedule it together with the restore.
4. Execute the messages manually from the CCIP explorer, oldest first, each once the bucket covers it. A failed one
   raises `ccip.message-executed` and leaves `reconcile.failed-messages`; a stuck one raises nothing and its
   `reconcile.stuck-message` resolves. Both leave `I`.

To clear the backlog before new transfers compete for the inbound buckets, restore in two operations **(not
drilled)**: first `pool.setChainRateLimiterConfig(remote, {true, 0, 0}, inCfg)` on both chains (sends stay refused,
releases refill), then `(remote, outCfg, inCfg)` once the listed messages have executed. Record any that cannot (e.g.
a `ReceiverError` only the receiver can fix) and do not wait for them. Schedule both together, the second with the
first's operation id as `predecessor`: executed after the second, the first would close the outbound bucket again. The
second shows as `timelock-queue.blocked` until the first executes, then waits Ready (operations never expire); give
the Guardian Safe both ids so it does not cancel them as unexpected restores. On the `1.6.3-dev` pool, re-applying the
same `inCfg` keeps the inbound tokens (capped at the capacity, not reset). Until the second operation,
`state-pool.lockdown` stays open for the outbound direction.

### R6 Replace or remove the Guardian

```
Timelock.schedule(LM, 0, abi.encodeCall(LM.setGuardian, (newGuardian)), bytes32(0), salt, delay)
```

- Protected only as a single operation (or a batch of exactly that one call) with value 0 and exactly the 36-byte
  calldata; check `GC.isProtectedCall(LM, 0, data)` first. Padded calldata, value 1, another target and any mixed batch
  are cancellable **[06]**.
- Predecessor `bytes32(0)`: a recovery chained to a predecessor stalls if the predecessor is cancelled.
- On execution the old Guardian loses restriction, cancellation and lockdown at once **[06]**.
- A hostile Guardian cancels every other fix, so its replacement comes first and every other recovery takes a second
  delay.

### R7 Token pause

```
Timelock: token.pause() ... token.unpause()
```

Blocks every transfer including recall and `migrateReserves`, and the Guardian can neither pause nor unpause
**[08 E4]**. Scheduling the unpause right after the pause keeps the paused window to the gap between the two
executions.

### R8 Delayed owner brakes

```
batch: registry.setPool(SAHARA, address(0))   // bridge off, fund off
       pool.setRebalancer(address(0))          // fund and recall off
```

Recall stops (`Unauthorized`), fund stops (`PoolNotActiveInRegistry`), the Router refuses the token
(`UnsupportedToken`), while
`migrateReserves` and the lockdown keep working **[11 X4]**. Restore with
`[registry.setPool(SAHARA, pool), pool.setRebalancer(adapter)]`.

### R9 Abandon the Manager (not drilled)

Deploy a new Manager, GuardianController and adapter (same Timelock), then one batch in this order:
`TL.grantRole(CANCELLER_ROLE, newController)`, `pool.setRateLimitAdmin(newController)`, `pool.setRebalancer(newAdapter)`,
the new Manager's `setPoolSpec` (with `rateLimitAdmin = newController`), `setPoolThresholds`,
`setPoolFundingBudget`, `setAggregateFundingBudget`, `setMaxFundingPerCall`, `setRecallLimits`, `setFundingOperator`,
`setRecallOperator`, `newManager.registerAdapter(newAdapter, pool)`, `oldManager.migrateReserves(newManager, max)`,
`oldManager.setGuardian(address(0))`, `TL.revokeRole(CANCELLER_ROLE, oldController)`.

- Include `setMaxFundingPerCall`: it starts at 0 on a new Manager, so without it every `fund` reverts
  `ExceedsPerCallLimit` until another Timelock operation sets it. `setRecallLimits` does not set it.

- Revoke the old controller: each controller protects only its own Manager's `setGuardian`, so a second canceller
  could cancel a recovery on the new Manager.
- A GuardianController is bound to one Manager and one Timelock (both immutable). Moving to a new Timelock needs a new
  controller, `pool.setRateLimitAdmin` and an updated PoolSpec, and the token's `transferOwnership` is single-step:
  a wrong address loses pause and `registerAdapter` for good.
- The TokenAdminRegistry address is immutable in the Manager; a CCIP registry migration needs a new Manager.

### R10 Full exit to a legacy owner

```
batch: pool.transferOwnership(legacy)
       registry.transferAdminRole(SAHARA, legacy)
       token.transferOwnership(legacy)        // single step
       LM.migrateReserves(legacy, max)
legacy: pool.acceptOwnership(); registry.acceptAdminRole(SAHARA); pool.setRebalancer(...); pool.setRateLimitAdmin(...)
```

Simulated on a fork only **[10]**. Remove the Guardian separately (R6) if the contracts are abandoned.

## 4. Incident playbooks

| Incident | Immediately (Guardian, per chain) | Then (Timelock) | Getting reserves out |
| --- | --- | --- | --- |
| Funding Operator key compromised | `suspendFundingOperator`, `pauseFunding` | `setFundingOperator(new, true)` | not needed: fund can only move reserves into the registered pool, within the budgets |
| Recall Operator key compromised | `suspendRecallOperator`, `pauseRecall` | `setRecallOperator(new, true)` | not needed: recall can only pay the Manager |
| Malicious or mistaken proposal | `GC.cancel` / `cancelBatch` before execution (Ready included) | Governance can also `TL.cancel(id)` | — |
| Guardian compromised | (none: it is the problem) | R6 first (protected, cannot be cancelled), then restore what it restricted and cancel nothing it queued | after R6, R1 / R2 |
| Governance Safe compromised | cancel every non-protected operation before its ETA; lockdown on both chains; `pauseFunding` | — | only cancellation delays an attacker. Once a protected `setGuardian(rogue)` executes, the honest Guardian has no power |
| Adapter bug | `restrictAdapter(id, true, true)` | R4 (verify the new adapter's bytecode) | R2 if the pool must be emptied meanwhile |
| Pool bug, lane incident, remote-chain exploit | `lockdown` on **both** chains, `pauseFunding`; if releases are unbacked or telemetry is stale, `pauseRecall`; start the list of unsettled messages (R5) | R5 when resolved, after checking the unsettled messages are backed; then retry the failed messages (R5) | R2 (pool) and R1 (Manager), lockdown first |
| Registry mapping changed unexpectedly | `pauseFunding`, lockdown the registered pool (still recognised) | cancel any queued `setPool`; `registry.setPool(SAHARA, pool)` | recall still works (it does not check the registry) |
| Manager must be abandoned | `pauseFunding` | R9 | R9 migrates the reserves |
| Token-level emergency | lockdown on both chains | R7 | R1 with the unpause / migrate / pause batch |
| Tokens sent to the wrong contract | — | Manager: `recoverToken` (non-SAHARA) or nothing to do (SAHARA becomes reserves); Timelock: transfer | adapter, controller: lost |

## 5. Gotchas

- **Every response is per chain.** Each chain has its own Timelock, Manager, controller and token owner. A lockdown
  on one chain leaves the other one open: it keeps accepting sends whose releases fail on the locked chain (R5).
- **A lockdown fails what is in flight.** Releases of messages already sent to a locked-down chain fail, the SAHARA
  stays locked on the source chain, and only a manual execution after the restore, once the inbound bucket has
  refilled to the amount, delivers them. The restore lets anyone execute them: check they are backed first (R5).
- **Operations never expire.** A failed `execute` leaves the operation Ready, and it can succeed later when the state
  changes (a drain once the pool refills, an unpause bracket once the token is paused again). Cancel failed and
  abandoned operations.
- **Operation ids.** An executed id can never be scheduled again: `schedule` reverts `TimelockUnexpectedOperationState`.
  A cancelled id can be, with the same salt **[11 X2]**. Fixed-salt runbooks need a fresh salt per attempt.
- **Budgets are never reset.** Recall does not credit the funding budgets **[03]**, raising a capacity does not
  restore consumption, and a Guardian reduction caps the available amount.
- **The Guardian can only restrict.** It cannot loosen a limit (`NotARestriction`), unpause, re-enable an adapter or
  move funds **[05]**.
- **`renounceRole` on the Timelock is instant and permanent.** Renouncing the Governance Safe's `EXECUTOR_ROLE` or
  `PROPOSER_ROLE` freezes everything with one signature. Safe signers must reject any Safe transaction to the
  Timelock other than `schedule*`, `execute*` and `cancel`.
- **Governance Safe lost = reserves frozen.** No other proposer exists; only the Guardian's restrictions remain.
- **Independent signers.** Governance and Guardian need separate signer sets, and ideally separate signers per chain:
  one compromised key otherwise hits both roles or both chains.
- **Gas on newer forks.** On 2026-10-31 Sepolia charged about 7× more gas for contract creation than forge 1.2.3
  estimates locally: LiquidityManager used 34.0M gas (4.8M on BSC testnet), SaharaTimelock 11.6M (1.7M), while a
  plain transfer cost 12,000. The first testnet deployment ran out of gas. Before a production deployment, estimate every
  creation with the target chain's `eth_estimateGas` (or raise `--gas-estimate-multiplier`), and do not rely on anvil
  forks for gas: they run the local EVM rules.

## 6. What the contracts cannot cover

- Compromised Governance with an absent or compromised Guardian: funds can be moved after one delay and nothing
  cancels it.
- Compromised Governance with an honest Guardian: a protected `setGuardian(rogue)` takes over after one delay, the
  theft follows after a second one.
- Pool-level threats (a pool bug, a rebalancer abuse): the Guardian can lock the lane down but cannot revoke the
  rebalancer or pause the token; those are delayed Timelock operations.
- Chainlink-side changes (Router ramps, OffRamp or registry upgrades) happen outside these contracts; the monitor
  alerts on them.

The off-chain mitigations are Safe thresholds with independent signer sets, 24/7 queue monitoring
([`monitor/`](monitor/README.md), every `CallScheduled` is alerted) and this runbook rehearsed on testnet.
