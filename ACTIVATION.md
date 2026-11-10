# Mainnet activation

The procedure that activates the liquidity contracts on Ethereum and BNB Chain: deploy and hand over under a short
(24 h) Timelock delay, test with a small batch, move every reserve into the LiquidityManager, then raise the delay to
72 h. Each step is the same on both chains; the chains are independent and can be activated in parallel.

Every step marked with a rehearsal step in brackets, e.g. **[02]**, was rehearsed on anvil forks of Ethereum and BSC
mainnet against the live SAHARA token, `LockReleaseTokenPool 1.6.3-dev`, TokenAdminRegistry 1.5.0, Router 1.2.0 and the
real legacy multisig ([`script/mainnet-fork/`](script/mainnet-fork/README.md), 2026-11-09: 168 checks and 28
transactions per chain, all passed). Incident procedures are in [`EMERGENCY.md`](EMERGENCY.md).

## 1. Parameters and actors

| | Value |
| --- | --- |
| Activation delay (`TIMELOCK_DELAY`) | 86,400 s (24 h) |
| Delay floor (`TIMELOCK_MINIMUM_DELAY`) | 86,400 s (24 h), immutable: the lowest delay any later `updateDelay` can set |
| Delay ceiling (`TIMELOCK_MAXIMUM_DELAY`) | 2,592,000 s (30 days), immutable |
| Delay after activation | 259,200 s (72 h) |
| Small batch | 1,000,000 SAHARA |
| Operating parameters (pool minimum / trigger / target, per-call limits, budgets) | **TBD** per the design document. The rehearsal used placeholders: 20M / 50M / 100M, 25M per call, aggregate 100M at 100M/day, pool 50M at 50M/day, recall 50M at 50M/day |

| Actor | Role in the activation |
| --- | --- |
| Deployer | fresh EOA, no pending transaction; runs `script/Deploy.s.sol`. The four contract addresses follow from its nonce |
| Legacy multisig `0x6601…e109` | today's pool owner, TokenAdminRegistry administrator and token owner. Ethereum: Safe 1.3.0, BSC: SafeL2 1.4.1, 5 of 6 owners on both |
| Governance Safe | sole Timelock proposer and executor; schedules and executes every Timelock operation |
| Guardian Safe | restrictions, cancellation (through the GuardianController) and lockdown |
| Funding / Recall Operator | `fund` / `recall` |
| Reserve wallets | every wallet holding SAHARA reserves on the chain; list them in the monitor's `reserves.legacyWallets` before the first run ([monitor handover notes](monitor/README.md#before-during-and-after-the-handover)) |

Live addresses (same on both chains unless noted): SAHARA `0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111`, pool
`0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4`, TokenAdminRegistry Ethereum `0xb22764f98dD05c789929716D677382Df22C05Cb6` /
BSC `0x736Fd8660c443547a85e4Eaf70A49C1b7Bb008fc`, Router Ethereum `0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D` / BSC
`0x34B03Cb9086d7D758AC55af71584F81A598759FE`, previous rebalancer and rateLimitAdmin
`0xd3B8d71d8Dd31288c7E60B1aF082846601020F22`.

## 2. Timeline

| When | Step |
| --- | --- |
| T0 | 0 preconditions, 1 deploy, 2a Handover script, 2b Governance schedules the handover batch |
| T0 + 24 h | 2c-2e legacy MultiSend, then Governance executes the batch: the contracts are live under a 24 h delay |
| right after | 3 small batch |
| after the small batch passed | 4 every reserve into the Manager; 5a Governance schedules `updateDelay(72 h)` |
| + 24 h | 5b execute `updateDelay`: 72 h from here on; 6 final state |

Steps 4 and 5a do not depend on each other: reserve moves are plain transfers, not Timelock operations. Scheduling
`updateDelay` as soon as the small batch has passed (before or together with step 4) brings the 72 h delay into force
earliest. The rehearsal ran them in the order 4, then 5.

## 3. Steps

All Timelock operations are scheduled by the Governance Safe with predecessor `bytes32(0)` and the current
`getMinDelay()`, and executed by it with the same arguments once Ready.

### Step 0. Preconditions [00]

Check on each chain, immediately before deploying:

- pool `typeAndVersion()` = `LockReleaseTokenPool 1.6.3-dev`, `getToken()` = SAHARA, `getRouter()` = the Router,
  `getSupportedChains()` = exactly the counterpart selector (Ethereum `5009297550715157269`, BSC
  `11344663589394136015`);
- pool `owner()` = legacy multisig, `getRebalancer()` and `getRateLimitAdmin()` = `0xd3B8…0F22`;
- registry `getTokenConfig(SAHARA)` = (legacy multisig, no pending administrator, the pool);
- token `owner()` = legacy multisig, `paused()` = false;
- the legacy multisig's version, threshold and nonce; it has **no guard** set (storage slot
  `keccak256("guard_manager.guard.address")` is zero), so the MultiSend in step 2d is not filtered;
- `MultiSendCallOnly` is deployed (Safe 1.3.0 `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D` on Ethereum, Safe 1.4.1
  `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` on BSC);
- the Governance and Guardian Safes are deployed, with the intended owners and thresholds;
- record the pool liquidity and each reserve wallet's balance: they are the reference for steps 3, 4 and 6.

### Step 1. Deploy [01]

```sh
TOKEN=0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111 TOKEN_ADMIN_REGISTRY=<registry> POOL=0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4 \
GOVERNANCE_SAFE=<safe> GUARDIAN_SAFE=<guardian> \
TIMELOCK_DELAY=86400 TIMELOCK_MINIMUM_DELAY=86400 TIMELOCK_MAXIMUM_DELAY=2592000 \
forge script script/Deploy.s.sol:Deploy --rpc-url <rpc> --sender <deployer> --broadcast --slow --verify
```

`Deploy.s.sol` is used unchanged: its preflight requires a floor of at least one day, which 24 h meets. Leave
`EXECUTOR` unset unless a keeper executor is intended.

Checks:

- SaharaTimelock, LiquidityManager, GuardianController and CCIPPoolAdapter at deployer nonces n, n+1, n+2, n+3;
- Timelock `getMinDelay()` = 86,400, `MINIMUM_DELAY()` = 86,400, `MAXIMUM_DELAY()` = 2,592,000, self-administered;
- Manager `owner()` = Timelock, `guardian()` = Guardian Safe, `TOKEN()` and `TOKEN_ADMIN_REGISTRY()` as intended;
- GuardianController `MANAGER()` / `TIMELOCK()`, adapter `MANAGER()` / `POOL()` as intended;
- Governance Safe holds PROPOSER, EXECUTOR and CANCELLER; the GuardianController holds CANCELLER; the Guardian Safe
  and the deployer hold no Timelock role.

Gas: a fork runs anvil's EVM rules, not the chain's current fork, so it does not validate deployment gas (on Sepolia
contract creation cost about 7x forge's estimate, see [`script/testnet/`](script/testnet/README.md#findings-during-the-run)).
Check the estimate against the chain's own `eth_estimateGas` before broadcasting.

### Step 2. Handover, schedule-first [02]

**2a. Handover script.** With the env of [`script/Handover.s.sol`](script/Handover.s.sol) (deployment addresses,
operators, `ROUTER`, `REMOTE_CHAIN_SELECTOR`, `REMOTE_TOKEN` = SAHARA, `REMOTE_POOL` = the pool, operating parameters,
`LEGACY_MULTISIG`, `GOVERNANCE_SAFE`, `SALT`):

```sh
forge script script/Handover.s.sol:Handover --rpc-url <rpc>
```

It must print `Preflight and handover simulation passed.`, then the 4 legacy calls and the Governance Safe's
`scheduleBatch` / `executeBatch` calldata. The operation id is `keccak256` of the `executeBatch` arguments (the
calldata without its selector).

**2b. Governance Safe schedules the batch** (12 calls, in this order): `pool.acceptOwnership()`,
`pool.setRebalancer(adapter)`, `registry.acceptAdminRole(SAHARA)`, `setPoolSpec`, `setPoolThresholds`,
`setPoolFundingBudget`, `setAggregateFundingBudget`, `setMaxFundingPerCall`, `setRecallLimits`,
`setFundingOperator`, `setRecallOperator`, `registerAdapter(adapter, pool)`.

Checks: `CallScheduled` carries the expected operation id; state Waiting; `executeBatch` reverts
`TimelockUnexpectedOperationState`; pool and token still owned by the legacy multisig. The Guardian can cancel this
batch (it is not a protected call).

**2c. The delay passes.** The batch is Ready. Executing it before the legacy calls reverts `MustBeProposedOwner()`
(the pool has no pending owner yet) and leaves it Ready, so an early execution attempt costs nothing.

**2d. Legacy multisig: one MultiSend**, sent shortly before or after the batch becomes Ready (this keeps the
mixed-authority window short):

| # | Target | Call | Selector |
| --- | --- | --- | --- |
| 1 | pool | `setRateLimitAdmin(controller)` | `0x7d54534e` |
| 2 | pool | `transferOwnership(timelock)` | `0xf2fde38b` |
| 3 | registry | `transferAdminRole(SAHARA, timelock)` | `0xddadfa8e` |
| 4 | SAHARA | `transferOwnership(timelock)` | `0xf2fde38b` |

Safe transaction: `to` = `MultiSendCallOnly` of the Safe's version (Ethereum 1.3.0 `0x40A2…130D`, BSC 1.4.1
`0x9641…02e2`), value 0, `data` = `multiSend(bytes)` with each call packed as `uint8(0) ++ target ++ uint256(0) ++
uint256(len) ++ calldata`, **operation 1 (delegatecall)**, safeTxGas 0, baseGas 0, gasPrice 0, no gas token, no refund
receiver. With safeTxGas and gasPrice 0 a failing inner call reverts the whole transaction (`GS013`). Five owners sign
the `safeTxHash` at the Safe's nonce at signing time (the rehearsal used `approveHash` by four owners plus execution by
the fifth).

Checks: Safe nonce +1; pool `getRateLimitAdmin()` = GuardianController (the Guardian can lock the pool down from now
on); pool `owner()` still the legacy multisig and `getRebalancer()` still `0xd3B8…0F22` (the old rebalancer keeps
operating until the batch); token `owner()` = Timelock; registry pending administrator = Timelock.

Until the batch executes, the legacy multisig can abort by proposing `address(0)` as pool owner and registry
administrator; returning the token then needs a Timelock operation.

**2e. Governance Safe executes the batch.** State Done.

**2f. Checks after the handover:**

- pool `owner()` = Timelock, `getRebalancer()` = adapter, `getRateLimitAdmin()` = GuardianController;
- registry config = (Timelock, no pending administrator, the pool); token `owner()` = Timelock;
- `adapterIdByPool(pool)` = 1; both operators set; `verifyHandover()` and `verifyAdapter(1)` pass;
- the legacy multisig can no longer `setRebalancer` / `transferOwnership` on the pool (`OnlyCallableByOwner`),
  `setPool` in the registry (`OnlyAdministrator`) or `pause` the token (`OwnableUnauthorizedAccount`); the previous
  rebalancer can no longer `withdrawLiquidity` (`Unauthorized`);
- pool liquidity unchanged.

### Step 3. Small batch under the 24 h delay [03]

| # | Actor | Action | Expected (from the transaction's own `Transfer` logs) |
| --- | --- | --- | --- |
| 3a | reserve wallet | `SAHARA.transfer(manager, 1M)` | Manager +1M, wallet −1M |
| 3b | anyone (`eth_call`) | role and argument checks | `fund` by a non-operator or the Recall Operator: `CallerNotFundingOperator`; `recall` by the Funding Operator: `CallerNotRecallOperator`; `fund` above the per-call limit: `ExceedsPerCallLimit`; adapter `fund` directly: `CallerNotManager` |
| 3c | Funding Operator | `fund(1, 1M)` | Manager −1M, pool +1M, adapter balance and adapter→pool allowance 0; pool and aggregate budgets −1M |
| 3d | Recall Operator | `recall(1, 1M)` | Manager +1M, pool −1M, adapter 0; recall budget −1M; the funding budgets are not credited back (they only refill with time) |
| 3e | CCIP user | receives a release from the counterpart chain, then sends SAHARA back with `Router.ccipSend` | inbound: pool −amount, user +amount; outbound: pool +amount, `LockedOrBurned` from the pool; `lockOrBurn` by a non-ramp reverts `CallerIsNotARampOnRouter` |
| 3f | Governance + Guardian | Governance schedules a test `migrateReserves(<test address>, max)`; the Guardian cancels it through `GuardianController.cancel` | state Unset (cancelled); the Guardian brake works under the short delay |

Pass criteria: `verifyHandover()` and `verifyAdapter(1)` pass, the Manager holds exactly the 1M small batch, pool
liquidity is back to its step 0 value (plus or minus real bridge traffic in production).

On mainnet, 3e is a real CCIP transfer of a small amount in each direction, which also needs the counterpart chain
activated; wait for delivery before step 4. In the rehearsal the inbound release came from an impersonated OffRamp and
the outbound send was a real `ccipSend` (fee 0.000255 ETH on Ethereum, 0.00315 BNB on BSC for 1,000 SAHARA).

### Step 4. Every reserve into the Manager [04]

Each reserve wallet transfers its whole SAHARA balance to the Manager with a plain `transfer`. The funding budgets
bound only Manager → pool funding, not tokens entering the Manager.

Checks per transfer: Manager +balance, wallet balance 0. Afterwards: Manager balance = sum of all reserves recorded in
step 0 (the small batch is part of it), pool liquidity unchanged, `verifyAdapter(1)` passes. Keep every wallet in the
monitor's `reserves.legacyWallets` until it is empty.

### Step 5. Delay to 72 h [05]

`updateDelay` is only callable by the Timelock itself (`TimelockUnauthorizedCaller` otherwise), so it is a Timelock
operation that waits the current 24 h delay. It reverts `DelayOutOfBounds` outside `[24 h, 30 days]`.

**5a.** Governance Safe schedules `Timelock.updateDelay(259200)` (target = the Timelock, value 0).

**5b.** After 24 h, Governance Safe executes it. Checks: `MinDelayChange(86400, 259200)` emitted, `getMinDelay()` =
259,200, `MINIMUM_DELAY()` still 86,400.

**Operations scheduled before 5b keep their 24 h ready time.** OpenZeppelin fixes the ready timestamp when an
operation is scheduled, so anything scheduled during the 24 h window is executable 24 h after scheduling even after the
switch (the rehearsal scheduled a probe just before 5a; it was Ready right after 5b). At the switch, list every pending
operation (`CallScheduled` without a matching `CallExecuted` or `Cancelled`; the monitor alerts on every
`CallScheduled`) and cancel anything unexpected: the Guardian can cancel everything except a standalone
`setGuardian`, the Governance Safe can cancel everything.

After 5b, `schedule` with less than 72 h reverts `TimelockInsufficientDelay`; an operation scheduled with 72 h is still
Waiting after 24 h and Ready after 72 h.

### Step 6. Final state [06]

- Timelock: delay 259,200, bounds [86,400, 2,592,000]; Governance Safe PROPOSER, EXECUTOR, CANCELLER; GuardianController
  CANCELLER; the deployer, the Guardian Safe and the legacy multisig hold no role (DEFAULT_ADMIN, PROPOSER, EXECUTOR,
  CANCELLER).
- Manager: `owner()` = Timelock, `pendingOwner()` = 0, `guardian()` = Guardian Safe, adapter 1 = the deployed adapter,
  `verifyHandover()` and `verifyAdapter(1)` pass.
- Pool: owner Timelock, rebalancer adapter, rateLimitAdmin GuardianController. Registry: (Timelock, 0, pool). Token:
  owner Timelock, not paused.
- Balances: Manager = all reserves, adapter 0, reserve wallets 0, pool liquidity as in step 0 (plus or minus bridge
  traffic).
- Update the monitor configuration from the pre-handover to the post-handover phase
  ([monitor handover notes](monitor/README.md#before-during-and-after-the-handover)).

## 4. Rehearsal

```sh
cd script/mainnet-fork
./rehearse.sh ethereum 8548 &     # fresh anvil fork, steps 00 - 06
./rehearse.sh bsc 8547 &
RESERVE_WALLETS=0x...,0x... MAINNET_DEPLOYER=0x... ./rehearse.sh ethereum 8548   # real reserve wallets and deployer
```

| | Ethereum (fork block 26378097) | BSC (fork block 132604814) |
| --- | --- | --- |
| Result | 168 checks, 28 transactions, passed | 168 checks, 28 transactions, passed |
| Legacy MultiSend | Safe 1.3.0, nonce 46 | SafeL2 1.4.1, nonce 39 |
| Pool liquidity, unchanged at the end | 82,554,561.66 SAHARA | 117,446,759.27 SAHARA |
| Manager after step 4 | 1,000,000,000 SAHARA (simulated reserve) | 1,000,000,000 SAHARA (simulated reserve) |

What the rehearsal stood in for, and what is still open before the real activation:

- Governance and Guardian Safes were 1-of-1 stand-ins; the deployer and operators were keyless stand-in addresses.
  With `MAINNET_DEPLOYER` set to the real deployer, the rehearsal prints the real mainnet contract addresses.
- The reserve wallet was simulated (balance written into the token's storage, 1B). The reserve wallets per chain are
  still to be listed; the `RESERVE_WALLETS` path has not been run yet.
- Operating parameters were placeholders.
- No CCIP message was delivered between the chains (CCIP delivery was rehearsed on testnet).
- Deployment gas was not validated (see step 1).
