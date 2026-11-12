# Mainnet activation rehearsal (fork)

Executable rehearsal of [`ACTIVATION.md`](../../ACTIVATION.md) (the step-by-step procedure and its checks). Rehearses
the production activation of the liquidity contracts on **anvil forks of Ethereum and BNB Chain mainnet**,
against the live SAHARA token, `LockReleaseTokenPool 1.6.3-dev`, TokenAdminRegistry, Router and the real legacy
multisig:

1. deploy with the production `script/Deploy.s.sol` under a **24 h** Timelock delay;
2. hand over with the production `script/Handover.s.sol` (legacy multisig MultiSend + one Timelock batch);
3. **small batch** under the 24 h delay: 1M SAHARA into the Manager, `fund` 1M into the pool, `recall` 1M back, CCIP
   transfers in both directions through the handed-over pool, Guardian cancels a malicious proposal;
4. move **every reserve token** into the Manager;
5. raise the Timelock delay to **72 h** (`updateDelay`, itself waiting the 24 h delay).

FORK ONLY. `lib.sh` refuses to run without `FORK_RPC` pointing at anvil with the right chain id, and no key is used:
every sender (the legacy multisig's owners included) is impersonated by anvil.

## Decisions

| | Value | Why |
| --- | --- | --- |
| Activation delay | `TIMELOCK_DELAY=86400` (24 h) | short enough to activate and test within a day |
| Delay floor | `TIMELOCK_MINIMUM_DELAY=86400` (24 h) | the initial delay cannot be below the immutable floor; `Deploy.s.sol` refuses a floor below one day, so the script is used unchanged. The floor stays 24 h forever: lowering the delay to 24 h again later is possible, but needs a 72 h Timelock operation the Guardian can cancel |
| Ceiling | `TIMELOCK_MAXIMUM_DELAY=2592000` (30 days) | `Deploy.s.sol` default |
| Final delay | `FINAL_TIMELOCK_DELAY=259200` (72 h) | design |
| Small batch | `SMALL_BATCH=1M` | |
| Handover order | schedule-first (README "Deployment and handover"): batch scheduled, legacy MultiSend shortly before it is executable, then execute | shortest mixed-authority window |

Operating parameters in [`params.env`](params.env) (pool minimum/trigger/target, limits, budgets) are **placeholders**
(the values of `test/fork/ScriptRun.t.sol`); production values are still TBD.

## What is real and what is stood in

| | On the fork |
| --- | --- |
| SAHARA, pool, TokenAdminRegistry, Router, CCIP ramps | live contracts at the fork block |
| Legacy multisig `0x6601…e109` | live Safe (Ethereum: Safe 1.3.0, BSC: SafeL2 1.4.1, both 5 of 6). The 4 legacy calls run as one `MultiSendCallOnly` delegatecall Safe transaction: 4 owners `approveHash`, the 5th executes |
| `Deploy.s.sol`, `Handover.s.sol` | production scripts, unchanged (preflight, simulation, printed calldata) |
| Governance Safe, Guardian Safe | 1-of-1 SafeL2 1.4.1 stand-ins created on the fork (the real ones are not deployed yet) |
| Deployer, operators | stand-in addresses in [`accounts.env`](accounts.env) (keccak-derived, no keys). Set `MAINNET_DEPLOYER` to the real deployer to get the real mainnet contract addresses (they follow from its nonce) |
| Reserve wallets | Empty `RESERVE_WALLETS` (default, the only path run so far): one simulated wallet whose balance is written to `RESERVE_AMOUNT` (1B) in the token's balance mapping; the token's `totalSupply` is not adjusted. `RESERVE_WALLETS` (comma-separated) moves the whole balance of real wallets instead; not run yet, the reserve wallets are still to be listed |
| CCIP | outbound: a real `Router.ccipSend` (Router → OnRamp → pool `lockOrBurn`, fee from the live FeeQuoter); inbound: the OffRamp is impersonated to call `releaseOrMint`. No message is delivered to the other chain |
| Time | Timelock delays are skipped with `evm_increaseTime` |

## Steps

| Step | What it does |
| --- | --- |
| `00-setup.sh` | Live pre-handover state (pool version, Router, chains, owner, rebalancer, rateLimitAdmin, registry, token owner, legacy Safe version/threshold/nonce, no Safe guard, MultiSendCallOnly deployed), Safe stand-ins, reserve wallets |
| `01-deploy.sh` | `forge script script/Deploy.s.sol:Deploy --unlocked --sender $DEPLOYER --broadcast --slow` with the 24 h / 24 h / 30 d delays; addresses at deployer nonce n..n+3, delays, wiring, roles |
| `02-handover.sh` | `Handover.s.sol` preflight + simulation + calldata; Governance schedules the 12-call batch; after the delay a premature `executeBatch` reverts `MustBeProposedOwner()` and the batch stays Ready; the legacy multisig sends the 4 calls in one MultiSend; Governance executes; every authority moved, the legacy multisig and the previous rebalancer keep none |
| `03-small-batch.sh` | 1M reserve wallet → Manager; role checks; `fund(1, 1M)` and `recall(1, 1M)` with exact deltas from the transaction's `Transfer` logs, zero adapter balance/allowance, budget consumption (a recall never credits the funding budget); CCIP: release 1k to a user (impersonated OffRamp), the user sends it back with a real `Router.ccipSend` (pool +1k, `LockedOrBurned`), non-ramp callers rejected; the Guardian cancels `migrateReserves(attacker, max)` |
| `04-full-reserves.sh` | Every reserve wallet's whole balance → Manager; the Manager holds every reserve token, pool liquidity unchanged |
| `05-delay-72h.sh` | `updateDelay` only through the Timelock, bounds enforced; Governance schedules `updateDelay(72h)` under 24 h and executes it (`MinDelayChange(86400, 259200)`); an operation scheduled before the change is Ready after the old 24 h; new operations need 72 h (`TimelockInsufficientDelay` below it; Waiting after 24 h, Ready after 72 h) |
| `06-report.sh` | Final authorities, roles (deployer, Guardian Safe, legacy multisig hold none), delays, balances, budgets, summary |

```sh
cd script/mainnet-fork
./rehearse.sh ethereum 8548 &     # fresh fork, 00 - 06, log in deployments/<chain>.fork.rehearsal.log
./rehearse.sh bsc 8547 &
# one step at a time:
./fork.sh bsc 8547 &              # anvil --fork-url $BSC_RPC_URL --auto-impersonate (resets deployments/bsc.fork.*)
FORK_RPC=http://127.0.0.1:8547 CHAIN=bsc ./00-setup.sh
RESERVE_WALLETS=0x...,0x... ./rehearse.sh ethereum 8548   # with the real reserve wallets
```

The upstream RPC is `ETH_RPC_URL` / `BSC_RPC_URL` (default publicnode). publicnode Ethereum serves state only for the
last ~100 blocks (~20 min), and anvil reads the fork block's state lazily, so a run must finish within that window
(a full run takes under 2 minutes) or use an archive RPC. BSC publicnode served state 5,000 blocks back.

## Rehearsal run

2026-11-09, forge/anvil 1.2.3, simulated reserve wallet (1B SAHARA), placeholder operating parameters.

| | Ethereum (fork block 26378097) | BSC (fork block 132604814) |
| --- | --- | --- |
| Result | passed, 168 checks, 28 transactions, 105 s | passed, 168 checks, 28 transactions, 95 s |
| Pool liquidity (unchanged at the end) | 82,554,561.66 SAHARA | 117,446,759.27 SAHARA |
| Legacy MultiSend | Safe 1.3.0 nonce 46, `MultiSendCallOnly 1.3.0` | SafeL2 1.4.1 nonce 39, `MultiSendCallOnly 1.4.1` |
| `ccipSend` of 1k SAHARA after the 24 h warp | fee 0.000255 ETH, locked in the pool | fee 0.00315 BNB, locked in the pool |
| Manager after step 4 | 1,000,000,000 SAHARA | 1,000,000,000 SAHARA |
| Timelock delay after step 5 | 259,200 s (floor 86,400 s) | 259,200 s (floor 86,400 s) |

### Findings for the production activation

- **Operations scheduled before `updateDelay` keep their 24 h ready time.** OpenZeppelin fixes the ready timestamp at
  scheduling. Anything scheduled during the 24 h window (by mistake or by a compromised Governance Safe) is
  executable 24 h after scheduling even once the delay is 72 h. At the switch, check the queue (`CallScheduled`
  without `CallExecuted` / `Cancelled`) and cancel anything unexpected; the Guardian can cancel everything except a
  standalone `setGuardian`.
- **The legacy multisig is a different Safe version on each chain**: Safe 1.3.0 on Ethereum, SafeL2 1.4.1 on BSC, so
  the MultiSend target differs (`MultiSendCallOnly` 1.3.0 `0x40A2…130D` vs 1.4.1 `0x9641…02e2`) and must be called with
  operation 1 (delegatecall). Neither Safe has a guard set.
- **Schedule-first works as documented**: before the legacy MultiSend, `executeBatch` reverts `MustBeProposedOwner()`
  and the batch stays Ready, so it can be executed once the MultiSend is in. Between the MultiSend and the batch the
  Timelock already owns the token and the GuardianController is the pool's rateLimitAdmin.
- **The 24 h floor is permanent.** It is what made `Deploy.s.sol` usable unchanged; a shorter activation delay would
  need a lower floor in the script and in the deployed Timelock for good.
- **Gas is not validated by a fork.** anvil runs its own EVM rules, not the chain's current fork; on Sepolia contract
  creation cost ~7x forge's estimate (see the [testnet findings](../testnet/README.md#findings-during-the-run)).
  Deploy on mainnet with the chain's own `eth_estimateGas` and enough headroom.

### Not covered here

Real n-of-m Governance and Guardian Safes, the monitor (`monitor/`) watching the activation, real reserve wallets
(pass `RESERVE_WALLETS`), production operating parameters, CCIP delivery between the chains (rehearsed on testnet).
