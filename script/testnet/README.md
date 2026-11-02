# Testnet drill

End-to-end rehearsal of the liquidity contracts on **Ethereum Sepolia ⇄ BNB Chain testnet** with real Chainlink CCIP:
deployment, the production handover, fund / recall, CCIP transfers through the handed-over pools, every Guardian
restriction, Timelock cancellation and Guardian recovery, bridge lockdown, and every emergency extraction path. The
procedures for production are in [`EMERGENCY.md`](../../EMERGENCY.md); this directory is the executable rehearsal of them.

TESTNET ONLY. `TestnetDeploy` refuses chain ids 1 and 56, and the drill keys are throwaway keystores.

## Test bed

The deployer keystore (`deployer`, `0x07dc9C65e03d269f3E05A1C3F85E3e10a32d6783`) already runs a copy of the production
setup on both testnets, in the same pre-handover state as mainnet (it plays the legacy multisig):

| | Sepolia | BSC testnet |
| --- | --- | --- |
| MTK token (OZ ERC20 + Pausable + Ownable, stands in for SAHARA) | `0x8643a10dB4dEC8c1714213dD3313C45C3CE87416` | same address |
| `LockReleaseTokenPool 1.6.3-dev` (same version as mainnet) | `0xA864a1D27195F5b00B42f612229505bB09DFdc1d` | `0x9496255737DF25a4335e6436aFf9622661887082` |
| TokenAdminRegistry 1.5.0 | `0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82` | `0xF8f2A4466039Ac8adf9944fD67DBb3bb13888f2B` |
| Router 1.2.0 (OnRamp 2.0.0 on the lane) | `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59` | `0xE1053aE1857476f36A3C62580FF9b016E8EE8F6f` |
| CCIP chain selector | `16015286601757825753` | `13264668187771770619` |

Roles ([`drill/accounts.env`](drill/accounts.env)) are foundry keystores with an empty password: `lmtest-governance` owns
the 1-of-1 **Governance Safe**, `lmtest-guardian` owns the 1-of-1 **Guardian Safe** (Safe 1.4.1, same address on both
chains), `lmtest-funding` / `lmtest-recall` are the operators, `lmtest-guardian2` is the replacement Guardian,
`lmtest-recovery` receives extracted reserves and `lmtest-user` receives the CCIP test transfers. Safe transactions use
the owner's pre-validated signature (`r = owner, s = 0, v = 1`), so every Governance action goes Safe →
`Timelock.schedule*` / `execute*` exactly as in production. Operating parameters ([`drill/params.env`](drill/params.env))
are scaled to the ~100k MTK pools; the Timelock delay is 120 s (bounds 60 s – 30 days).

## Steps

Every step checks each state change (authorities, operation states, and balance changes taken from the transaction's
own `Transfer` logs, so concurrent CCIP releases cannot disturb them) and checks expected reverts with `eth_call`
against the exact custom-error selector. Every transaction is gas-estimated first, so a step aborts before it sends
anything that would revert, and is appended to `deployments/<chain>.txlog`. Deployed addresses and progress are kept
in `deployments/<chain>.env`.

Every step can be re-run after a failure. Timelock operations are saved under a label before they are scheduled; a
re-run reuses a pending operation with the same calldata, cancels a stale one and skips one that already executed.
Steps with a deliberately degraded window (handover half done, pool locked down, token paused, pool drained) resume
from on-chain state: 07 schedules its restore before the lockdown, 08 schedules the unpause together with the pause.

| Step | What it does |
| --- | --- |
| `00-setup.sh` | Gas for the drill accounts, Governance and Guardian Safes (created by their owners, deployer nonce untouched) |
| `01-deploy.sh` | `TestnetDeploy` = `Deploy.deploy()` (same nonce order and `_checkWiring`) with the short delay |
| `02-handover.sh` | `Handover.s.sol` preflight + simulation, the 4 legacy calls as printed, the Governance Safe schedules / executes the printed 12-call batch, reserves into the Manager |
| `03-fund-recall.sh` | Role, limit and budget checks; fund 2 × 30k (pool budget exhausted), recall 30k, exact balance deltas |
| `04-bridge.sh send\|wait` | Real CCIP transfer through the pools (lock on the source, release on the destination) |
| `05-guardian.sh` | Every Guardian restriction (pauses, suspensions, adapter restriction, lower limits and budgets, higher pool minimum); the Guardian cannot loosen anything; one Timelock batch restores everything |
| `06-governance.sh` | Guardian cancels a malicious `migrateReserves` and a mixed batch; Governance withdraws its own proposal; protected `setGuardian` cannot be cancelled and revokes the old Guardian at once |
| `07-lockdown.sh` | Guardian `lockdown(pool)` zeroes both buckets, CCIP sends revert at the source; only the Timelock restores (buckets restart at zero) |
| `08-extraction.sh` | E1 destination checks · E2 `recoverToken` · E3 `replaceAdapter` · E4 token pause/unpause · E5 pool drain bypassing the Manager · E6 `migrateReserves(max)` · E7 back to operations |
| `09-finalize.sh` | Guardian back to the Guardian Safe, final state |
| `10-unwind-sim.sh` | Fork only: authorities back to the legacy owner (full exit from the liquidity contracts) |
| `11-extra.sh` | X1 full exit through the Manager (relax limits, recall the whole pool, fund it back) · X2 cancel a Ready operation, same-salt re-schedule, Done ids are final · X3 fund/recall during a lockdown, `InvalidRateLimitRate` · X4 delayed owner brakes `registry.setPool(token, 0)` + `pool.setRebalancer(0)` |

```sh
cd script/testnet/drill
./run-live.sh bsc &              # 00 - 09 on one chain, in the CCIP-safe order; run one per chain in parallel
./run-live.sh sepolia &          # completed steps are recorded and skipped on a re-run
CHAIN=bsc ./11-extra.sh          # after 09, per chain
```

`run-live.sh` runs 05 and 06 while the CCIP test transfers are in flight and starts 07 – 09 only once both directions
are delivered (07, 08 and 11 also refuse to start before that): zeroed inbound buckets, a paused token or a drained
pool would make an in-flight release fail.

### Rehearsing on a fork first

Any step can run against an anvil fork of the live state before it is broadcast. Fork state lives in
`deployments/<chain>.fork.env` (seeded from the live file), forge broadcast records go to
`deployments/fork-broadcast/`, Timelock delays are skipped with `evm_increaseTime`, and CCIP delivery is skipped.

```sh
./fork.sh bsc 8546 &                                  # anvil --fork-url <bsc testnet>
FORK_RPC=http://127.0.0.1:8546 CHAIN=bsc ./08-extraction.sh
FAIL_AT=before-drain FORK_RPC=... CHAIN=bsc ./08-extraction.sh   # abort at a fail point, then re-run to resume
```

`rehearse-fork.sh <chain>` runs 00 – 10 on a fresh fork of the pre-handover test bed, aborting 02, 06, 07 and 08 at
their fail points and re-running them. It passed on both chains (196 and 200 checks) before the live run.

A fork runs anvil's EVM, not the chain's current fork rules. On 2026-10-31 Sepolia charged about 7× more gas for
contract creation than forge estimates locally (LiquidityManager 34.0M gas, SaharaTimelock 11.6M), so the first
Sepolia deployment ran out of gas although the fork run had passed; `chains/sepolia.env` now sets
`FORGE_GAS_MULTIPLIER=1000` and drill contracts are deployed with the chain's own `eth_estimateGas`.

## Live run

2026-10-31, both chains, all steps 00 – 09 and 11 (10 is fork only). Every check passed: **221 on BSC testnet, 222 on
Sepolia**, 91 transactions on each chain. The testnet stacks are left operational (Guardian back with the Guardian Safe,
`verifyHandover` and `verifyAdapter` pass, the adapter is the one installed by E3).

| | BSC testnet | Sepolia |
| --- | --- | --- |
| CCIP test transfer delivered | BSC → Sepolia: sent 04:07:37, released 04:08:36 (59 s) | Sepolia → BSC: sent 04:15:12, released 04:30:38 (15 min 26 s) |
| Lockdown | `ccipSend` reverts `TokenMaxCapacityExceeded`; restore restarts both buckets at 0 | same |
| E5 pool drain | 130,010 MTK in one transaction (per-call limit 30k, minimum 20k) | 129,990 MTK |
| X1 full exit through the Manager | whole pool recalled after one relaxation batch, funded back, limits restored | same |
| X4 delayed brakes | fund `PoolNotActiveInRegistry`, recall `Unauthorized`, `getFee` `UnsupportedToken` (`0xbf16aab6`), `migrateReserves` and lockdown still work | same |

| Action | BSC testnet | Sepolia |
| --- | --- | --- |
| Handover batch executed (12 calls, Safe → Timelock) | [`0x13f756fb…`](https://testnet.bscscan.com/tx/0x13f756fbabecead2b03e231399c123792ee2995c0cbe126d5c4739f91bccf5bf) | [`0x341d222c…`](https://sepolia.etherscan.io/tx/0x341d222cfd461cd9d757a58253b75518ab4e2958fe12c1f2d72e28c9520b56cd) |
| CCIP send (1,000 MTK) | [`0x929d7916…`](https://testnet.bscscan.com/tx/0x929d7916a914615374b6d48cc5f6e9fba9ec027329e4f0141945ad9fed7c950d) | [`0x3e61bdf7…`](https://sepolia.etherscan.io/tx/0x3e61bdf704f86b294f66e586377d6373a9f28d191da706a7208f3159e353d8e3) |
| Guardian cancels malicious `migrateReserves(attacker, max)` | [`0xc1d128ce…`](https://testnet.bscscan.com/tx/0xc1d128ce1cf9ca0c4555d9afb05eddb6a03e85e142e242bd36fceb520a384b55) | [`0x83a632a7…`](https://sepolia.etherscan.io/tx/0x83a632a7bd7c077b3092b14469c831fef51013b33b2ce6de05a2610d769c049e) |
| Protected `setGuardian(guardian2)` executed | [`0xc9111951…`](https://testnet.bscscan.com/tx/0xc911195170d1fd366f49c069a4db2f8c83da02bf91ad2bdc3079f78857c9edf8) | [`0xd609aa7a…`](https://sepolia.etherscan.io/tx/0xd609aa7ad72a4fa1c5123b011fc23dfe536132a2a62224bc0752020853a8f387) |
| Guardian `lockdown(pool)` | [`0xe8f66a4d…`](https://testnet.bscscan.com/tx/0xe8f66a4d3e4bdb948df3313fd00e94a0cff3dd0916b4d5a0e68487b1059c48d3) | [`0xf335c38c…`](https://sepolia.etherscan.io/tx/0xf335c38cab378eaccc6c16afa8579a0bb080c69c4b2beafa72663e6f3471e5b6) |
| E3 `[setRebalancer(new), replaceAdapter]` executed | [`0x8a5c4358…`](https://testnet.bscscan.com/tx/0x8a5c4358789a94d09fa978c5b756f34caae7b756b0e4be4270a91fb51bdab2c9) | [`0xc206f90e…`](https://sepolia.etherscan.io/tx/0xc206f90e0164f7f38c6194859740235cbc3c382e66c9c4772abd5cd639c9b973) |
| E5 pool drain to recovery (130,010 / 129,990 MTK, one tx) | [`0xfd6a6946…`](https://testnet.bscscan.com/tx/0xfd6a6946c1fdebbcee3f402b80088f1064930449899136061ecf2219981cc457) | [`0xb74889a7…`](https://sepolia.etherscan.io/tx/0xb74889a7be952ed6db28ee03b1c6b6e91605f2081f25337c129c8fe258d2825c) |
| E6 `migrateReserves(recovery, max)` (470,000 MTK) | [`0x2817eb3f…`](https://testnet.bscscan.com/tx/0x2817eb3fdc757ba1793f737061a6a7a22b0c7c7586de421b9cebbf6e24b9dea9) | [`0xdccec921…`](https://sepolia.etherscan.io/tx/0xdccec921e05d8cfa665cccef1649d2cd7198350f11390c30e7b316a5026815c5) |

### Findings during the run

- **Sepolia gas.** The first Sepolia deployment ran out of gas
  ([`0xa9693387…`](https://sepolia.etherscan.io/tx/0xa9693387f9bade015ad2bb70aac82eae5a7e450fa0d5678a5f9fd279413411f3)):
  Sepolia charged SaharaTimelock 11.6M gas, LiquidityManager 34.0M, GuardianController 7.1M and CCIPPoolAdapter 2.7M,
  about 7× forge 1.2.3's local estimate (on BSC testnet the same contracts cost 1.7M, 4.8M, 1.0M and 0.4M), while a
  plain transfer cost 12,000. The fork rehearsal could not catch it because anvil runs the local EVM rules. Fixed with
  `FORGE_GAS_MULTIPLIER` for Sepolia and chain-estimated deployments in 08; see the production note in
  [EMERGENCY.md §5](../../EMERGENCY.md#5-gotchas).
- **Public RPC drops.** publicnode dropped connections on Sepolia: one receipt poll failed after the transaction had
  landed (05's small fund, recovered from its `Funded` log and completed by hand), and slow requests stretched one
  Timelock wait to 15 minutes. `send` now broadcasts once and polls the receipt itself, and requests time out after 20 s.
- **Pre-broadcast review.** An adversarial review of the scripts found a race in the Timelock wait (two reads per poll,
  aborting when the operation turned Ready in between) and that 02, 07 and 08 could not be resumed after a failure
  mid-way. Both were fixed and the resume paths rehearsed with fail points before the live run.

### Not rehearsed yet

- The README's schedule-first handover order (batch scheduled before the legacy calls, a premature `executeBatch`
  reverting `MustBeProposedOwner` while the operation stays Ready). The live run used the order `Handover.s.sol`
  prints: legacy calls first, then the batch. The completeness review rated the schedule-first rehearsal high
  priority; it was not changed mid-run.
- A hostile Guardian as one timeline (it pauses, locks down and cancels a restore; Governance replaces it, then
  restores in a second delay). 05 and 06 cover the parts separately.
- EMERGENCY.md R9 (abandon the Manager, including revoking the old controller's `CANCELLER_ROLE`) and the R1
  unpause / migrate / pause bracket.
- Pool migration with a second pool (`setPoolMigrationApproval`, `transferLiquidity(oldPool, type(uint256).max)`).
- Moving to a new Timelock with a new GuardianController.
- The full unwind to the legacy owner (10) ran on forks only.

### bsc

| Contract | Address |
| --- | --- |
| GOVERNANCE_SAFE | [`0x3949Fa522Ab7677f59E0BCD9dE80f41eFD97097B`](https://testnet.bscscan.com/address/0x3949Fa522Ab7677f59E0BCD9dE80f41eFD97097B) |
| GUARDIAN_SAFE | [`0x71B397916aad393B20a68651AdC3a0D9fD64b26C`](https://testnet.bscscan.com/address/0x71B397916aad393B20a68651AdC3a0D9fD64b26C) |
| TIMELOCK | [`0x5FEf2963ee460e9015b5e1B3939b3D9F79adB1e8`](https://testnet.bscscan.com/address/0x5FEf2963ee460e9015b5e1B3939b3D9F79adB1e8) |
| MANAGER | [`0x743C250a6B324b84e35D18910E90f146bd06963a`](https://testnet.bscscan.com/address/0x743C250a6B324b84e35D18910E90f146bd06963a) |
| CONTROLLER | [`0xE3eAb5bD04dC7c52335Eec1CB50E5DCCFf1F8943`](https://testnet.bscscan.com/address/0xE3eAb5bD04dC7c52335Eec1CB50E5DCCFf1F8943) |
| ADAPTER_ORIGINAL | [`0x18F66aedbaFD12E646df7F351002c8E662248C4a`](https://testnet.bscscan.com/address/0x18F66aedbaFD12E646df7F351002c8E662248C4a) |
| ADAPTER | [`0xe517C7FfF02248B18B897c67122A0cd522A19F0f`](https://testnet.bscscan.com/address/0xe517C7FfF02248B18B897c67122A0cd522A19F0f) |
| STRAY_TOKEN | [`0xc84D7f77b1FF66AC89e495b74c6F71a6C854aEd9`](https://testnet.bscscan.com/address/0xc84D7f77b1FF66AC89e495b74c6F71a6C854aEd9) |
| CCIP test transfer | [`0x558477f53d2e7c0f…`](https://ccip.chain.link/msg/0x558477f53d2e7c0f7de9f3f7d56b6e4f141dcfbdde1ae0f1f82d7cf21486360d) |

<details><summary>91 transactions by step</summary>

| Step | Action | Sender | Tx |
| --- | --- | --- | --- |
| 00-setup | Gas top-ups from the deployer | deployer | [0x5dd931ddca…](https://testnet.bscscan.com/tx/0x5dd931ddcabb41b1a0889e1bd5a7e7fb4cbc8b3a82f7a5c40cbd00bf8780da65) |
| 00-setup | Gas top-ups from the deployer | deployer | [0x626fdee34d…](https://testnet.bscscan.com/tx/0x626fdee34d05614889a5b116211106b81e59066207968c617c293ef94706be95) |
| 00-setup | Gas top-ups from the deployer | deployer | [0x74db39975d…](https://testnet.bscscan.com/tx/0x74db39975d649eead5f54b6c8a1c1bae48d890db03cc03ec12623e7bde68461b) |
| 00-setup | Gas top-ups from the deployer | deployer | [0xbbf2b2703b…](https://testnet.bscscan.com/tx/0xbbf2b2703b415d4936fdb4e0b126ba39c8cc1b03ecca9d9c177bd3fae00bbf32) |
| 00-setup | Gas top-ups from the deployer | deployer | [0x3914bceac4…](https://testnet.bscscan.com/tx/0x3914bceac4e480270518c1204682154861f40a4b90102be6ca008573d3771c76) |
| 00-setup | Gas top-ups from the deployer | deployer | [0xfed8ef6f42…](https://testnet.bscscan.com/tx/0xfed8ef6f42bdd8cb76b1bff705799ec75e6a11a558a8c1f75c6088d911f95be2) |
| 00-setup | Governance Safe (1-of-1, owner lmtest-governance) | lmtest-governance | [0x8781cfe6c2…](https://testnet.bscscan.com/tx/0x8781cfe6c2c9b92b19764dc95c6ccc046feeff5b5fd9ba1056f9b6236d629bb4) |
| 00-setup | Guardian Safe (1-of-1, owner lmtest-guardian) | lmtest-guardian | [0x1886f32710…](https://testnet.bscscan.com/tx/0x1886f32710477152072ca776f54b4034a590ee6c5dc19dcc3dd7334c6531df50) |
| 01-deploy | deploy SaharaTimelock | deployer | [0x05a490f478…](https://testnet.bscscan.com/tx/0x05a490f478a038d93a318395899d0b7da29a64a889985ee189b1be39d69678d6) |
| 01-deploy | deploy LiquidityManager | deployer | [0x338b03e13a…](https://testnet.bscscan.com/tx/0x338b03e13a1020eb86b0182d0db440d41be6f8b309834b3764c7ae3e09d1c078) |
| 01-deploy | deploy GuardianController | deployer | [0xa2f49399ba…](https://testnet.bscscan.com/tx/0xa2f49399bafa50206dc8b58355dd1ae5a1c0902bb538a76292791e646bedf259) |
| 01-deploy | deploy CCIPPoolAdapter | deployer | [0x03c237e63a…](https://testnet.bscscan.com/tx/0x03c237e63a45262695b63d6cc2987704d7cc025e9c8b15307e7eb338bf445a94) |
| 02-handover | Legacy owner (deployer) calls: rateLimitAdmin -> controller, propose the Timelock as pool owner and registry admin, token ownership -> Timelock | deployer | [0x3d701479e3…](https://testnet.bscscan.com/tx/0x3d701479e322a2ec055758ccdbca83b2da380923a078da7c3dd917bfc6a23ebb) |
| 02-handover | Legacy owner (deployer) calls: rateLimitAdmin -> controller, propose the Timelock as pool owner and registry admin, token ownership -> Timelock | deployer | [0x80ffdb5e0f…](https://testnet.bscscan.com/tx/0x80ffdb5e0f0d67afb65a51897b3dd4a1698d969785010337a5ff3a5b6577967d) |
| 02-handover | Legacy owner (deployer) calls: rateLimitAdmin -> controller, propose the Timelock as pool owner and registry admin, token ownership -> Timelock | deployer | [0xe743a00a8d…](https://testnet.bscscan.com/tx/0xe743a00a8daab94c2691c07397d5f3f1e780edd3079e66594840a891c80d3867) |
| 02-handover | Legacy owner (deployer) calls: rateLimitAdmin -> controller, propose the Timelock as pool owner and registry admin, token ownership -> Timelock | deployer | [0x6ddcc8cbdf…](https://testnet.bscscan.com/tx/0x6ddcc8cbdf7bb7a09eb78f046526059a1ff5743d5a96424252807de88bf606b2) |
| 02-handover | Governance Safe -> Timelock.scheduleBatch (12 calls) | lmtest-governance | [0x4570ada88a…](https://testnet.bscscan.com/tx/0x4570ada88a44ff49f594923051246b5b297d4a05ad32782e707920f511a460b8) |
| 02-handover | Wait for the delay, then Governance Safe -> Timelock.executeBatch | lmtest-governance | [0x13f756fbab…](https://testnet.bscscan.com/tx/0x13f756fbabecead2b03e231399c123792ee2995c0cbe126d5c4739f91bccf5bf) |
| 02-handover | Legacy reserves -> Manager (plain transfer of 500000.0000 MTK) | deployer | [0x708bc4cdb7…](https://testnet.bscscan.com/tx/0x708bc4cdb718045d28920bcfe6e5f6143abde84b824c6cf0129a927a2aae672f) |
| 03-fund-recall | fund up to maxFundingPerCall (30000.0000) twice: the pool budget (60000.0000) runs out | lmtest-funding | [0x6bfd5cc10e…](https://testnet.bscscan.com/tx/0x6bfd5cc10e2d1548393333399b3056fd89341b4dc5b6b4ffd27f26db57228938) |
| 03-fund-recall | fund up to maxFundingPerCall (30000.0000) twice: the pool budget (60000.0000) runs out | lmtest-funding | [0xc8798da850…](https://testnet.bscscan.com/tx/0xc8798da850da32044149364f03260c8289c0cb2a2ae0a462e2a933e5684755b1) |
| 03-fund-recall | recall up to maxRecallPerCall (30000.0000) back to the Manager, never below the pool minimum | lmtest-recall | [0xd7c9ccd97d…](https://testnet.bscscan.com/tx/0xd7c9ccd97d27c4e6b71acfe1d3238ef4699edf0d2cefdf5bd3b63ecc0c66fa54) |
| 04-bridge | CCIP send 1000.0000 MTK: bsc -> sepolia (receiver 0xB06588e58Ed0920E737F9306778e753c7e67e77e) | deployer | [0xb4d7e5484e…](https://testnet.bscscan.com/tx/0xb4d7e5484e1086f30cd2a55c94d3991c6e895441192f1ba41aa3dd8ba9d0d1b0) |
| 04-bridge | CCIP send 1000.0000 MTK: bsc -> sepolia (receiver 0xB06588e58Ed0920E737F9306778e753c7e67e77e) | deployer | [0x929d7916a9…](https://testnet.bscscan.com/tx/0x929d7916a914615374b6d48cc5f6e9fba9ec027329e4f0141945ad9fed7c950d) |
| 05-guardian | raisePoolMinimum to the current pool balance: every recall now breaches the minimum | lmtest-guardian | [0xd1cd74cb2b…](https://testnet.bscscan.com/tx/0xd1cd74cb2b14d2fb45f28ae280e3e0c1a70485c7cb68a02113a9113dfed76ceb) |
| 05-guardian | pauseFunding / pauseRecall | lmtest-guardian | [0xcf02419b77…](https://testnet.bscscan.com/tx/0xcf02419b77e8e2ab4f3c1eb5857a09c6403160ca0cc331d66e03eb295cc2a447) |
| 05-guardian | pauseFunding / pauseRecall | lmtest-guardian | [0xbd76136ae8…](https://testnet.bscscan.com/tx/0xbd76136ae88dec65ddcc63c907ebf16694262b1a092c4a6af3a0ae749d275b85) |
| 05-guardian | suspend both operators, restrict the adapter | lmtest-guardian | [0xdb34ac13ed…](https://testnet.bscscan.com/tx/0xdb34ac13ede8f6b1b6ff8c3a9cacbb1645ae63d0b07ccae163b3a6fdac1e81d4) |
| 05-guardian | suspend both operators, restrict the adapter | lmtest-guardian | [0x25ec31c9e8…](https://testnet.bscscan.com/tx/0x25ec31c9e8c418ca303663db87ea8300517e43b5b796f045bcb1165658e7e6f7) |
| 05-guardian | suspend both operators, restrict the adapter | lmtest-guardian | [0x3942e4bcbb…](https://testnet.bscscan.com/tx/0x3942e4bcbb08f416f3c581479f4a1e6ff6d0b1fdb39a8f3b1405a1f93b5d60ef) |
| 05-guardian | lower the limits and budgets | lmtest-guardian | [0xe504c88192…](https://testnet.bscscan.com/tx/0xe504c881922ad2366cb1058e897244827c5aed8d09e311c9cc18f19f33ebb16d) |
| 05-guardian | lower the limits and budgets | lmtest-guardian | [0xeb3f43819c…](https://testnet.bscscan.com/tx/0xeb3f43819c7cb66236e490978f7f6627e1389c353c845d26dc96edede13502e9) |
| 05-guardian | lower the limits and budgets | lmtest-guardian | [0xe6c45487d0…](https://testnet.bscscan.com/tx/0xe6c45487d0964b2b83f5abf9efe2e1d6a08f1257fc6ccde2fca215a1e8c05e27) |
| 05-guardian | lower the limits and budgets | lmtest-guardian | [0x848e1aec0d…](https://testnet.bscscan.com/tx/0x848e1aec0d52515c4cf5b5aa530b376fa5c3338bbd0e36f171b5863de67869a1) |
| 05-guardian | Timelock restore batch (Governance Safe, full delay) | lmtest-governance | [0xa6397c7755…](https://testnet.bscscan.com/tx/0xa6397c7755427a43b5137888b83900acfc8b7a866b63fbb2dc02b5a9c740d368) |
| 05-guardian | Timelock restore batch (Governance Safe, full delay) | lmtest-governance | [0xca074e938e…](https://testnet.bscscan.com/tx/0xca074e938e93ff800e5ee534ae6992fce31edee9b3cdaa6945eb8eab50737241) |
| 05-guardian | Restored: small fund and recall go through again (consumed budget was not restored) | lmtest-funding | [0x7b7b3cf297…](https://testnet.bscscan.com/tx/0x7b7b3cf297c549bdcf9a3c011ab5d95935dcea0cb8b554d6506629e9e957801c) |
| 05-guardian | Restored: small fund and recall go through again (consumed budget was not restored) | lmtest-recall | [0x4e445b4e8d…](https://testnet.bscscan.com/tx/0x4e445b4e8df4ca8ae5fe48e83a8e93ee179d1c272d0691f2f96079c031603602) |
| 06-governance | Malicious proposal: migrateReserves(attacker, max) -> cancelled by the Guardian | lmtest-governance | [0x081eff6efc…](https://testnet.bscscan.com/tx/0x081eff6efc4c1c8891c6f8254f25998c3d816ca13c83909e6567bba5dfa69922) |
| 06-governance | Malicious proposal: migrateReserves(attacker, max) -> cancelled by the Guardian | lmtest-guardian | [0xc1d128ce1c…](https://testnet.bscscan.com/tx/0xc1d128ce1cf9ca0c4555d9afb05eddb6a03e85e142e242bd36fceb520a384b55) |
| 06-governance | Mixed batch [setGuardian(guardian2), setFundingPaused(true)] is not protected -> cancelled by the Guardian | lmtest-governance | [0x31612c03e8…](https://testnet.bscscan.com/tx/0x31612c03e816f100cbce39784c10ebbee03119afbed2349a7f33bdde664324ff) |
| 06-governance | Mixed batch [setGuardian(guardian2), setFundingPaused(true)] is not protected -> cancelled by the Guardian | lmtest-guardian | [0x1e5cbbe15f…](https://testnet.bscscan.com/tx/0x1e5cbbe15f008e9490cc963ae742604206db4d9a23668db73902d5ba5aa1f35c) |
| 06-governance | The Governance Safe withdraws its own proposal (it keeps CANCELLER_ROLE) | lmtest-governance | [0xc63a8a66c9…](https://testnet.bscscan.com/tx/0xc63a8a66c9add991dd32fdf18a6cab799776f91c83377b3b7dfee044113f2bc9) |
| 06-governance | The Governance Safe withdraws its own proposal (it keeps CANCELLER_ROLE) | lmtest-governance | [0x2b92276187…](https://testnet.bscscan.com/tx/0x2b92276187046362bca0645a161788a3d3ee3f65bd0e3a4e72d012fbc7af0b77) |
| 06-governance | Guardian recovery: Governance schedules setGuardian(guardian2) alone, predecessor 0 | lmtest-governance | [0xff07f1945c…](https://testnet.bscscan.com/tx/0xff07f1945ce5da0f306ecf7be7622ba54a1301ff498ba700be160e0b371ede4d) |
| 06-governance | Guardian recovery: Governance schedules setGuardian(guardian2) alone, predecessor 0 | lmtest-governance | [0xc911195170…](https://testnet.bscscan.com/tx/0xc911195170d1fd366f49c069a4db2f8c83da02bf91ad2bdc3079f78857c9edf8) |
| 07-lockdown | Governance schedules the restore first (pending while the pool is locked down) | lmtest-governance | [0x83f2b12022…](https://testnet.bscscan.com/tx/0x83f2b120225e3c5d9dfeb65c4bffb774abcf76920501bd2374daa842f9c19dd8) |
| 07-lockdown | Guardian -> GuardianController.lockdown(pool) | lmtest-guardian2 | [0xe8f66a4d3e…](https://testnet.bscscan.com/tx/0xe8f66a4d3e4bdb948df3313fd00e94a0cff3dd0916b4d5a0e68487b1059c48d3) |
| 07-lockdown | Bridge transfers are refused at the source | deployer | [0x159a149ad9…](https://testnet.bscscan.com/tx/0x159a149ad9214e28e5357995e3b4aae2ab87aa59f9c38554001d7681cc1f1b79) |
| 07-lockdown | Timelock restores the original limits (buckets restart from zero and refill) | lmtest-governance | [0xe66e8c83ce…](https://testnet.bscscan.com/tx/0xe66e8c83ce507e6e053bd27015efc8907bf34cd8251b4394da0855b0aed0c4a2) |
| 07-lockdown | Timelock restores the original limits (buckets restart from zero and refill) | deployer | [0x9d5f014dc9…](https://testnet.bscscan.com/tx/0x9d5f014dc9037abbf11118e20edf8879512ddd532cc51ebe3279629bf1b8720e) |
| 07-lockdown | Timelock restores the original limits (buckets restart from zero and refill) | deployer | [0xc7d949ee14…](https://testnet.bscscan.com/tx/0xc7d949ee1473e3127c19bf2e6269b36ad433ff1c4a1cd31d54a593df1328dcea) |
| 08-extraction | E2 recoverToken: a stray token sent to the Manager by mistake | deployer | [0x2ec0474133…](https://testnet.bscscan.com/tx/0x2ec0474133ee211a10ea9002c4c3908450b4c6868c55de2cdfe36d2c4240723e) |
| 08-extraction | E2 recoverToken: a stray token sent to the Manager by mistake | lmtest-governance | [0xe8c0dbec37…](https://testnet.bscscan.com/tx/0xe8c0dbec3717d046cba34d2c67a0110a8f159b07d1330c61bfff08ea525c269e) |
| 08-extraction | E2 recoverToken: a stray token sent to the Manager by mistake | lmtest-governance | [0x9645a48aa2…](https://testnet.bscscan.com/tx/0x9645a48aa2f74212e98c7e5c652b51ec30968a2ff1cbf0532e1d009e79d23740) |
| 08-extraction | E3 replaceAdapter: deploy a new adapter, make it the rebalancer and swap it in atomically | deployer | [0xe488b00136…](https://testnet.bscscan.com/tx/0xe488b0013672cb03c56ad4e33fbcda52e682fd6b07c9533f32de1b7273e3b9e4) |
| 08-extraction | E3 replaceAdapter: deploy a new adapter, make it the rebalancer and swap it in atomically | lmtest-governance | [0xbe235af9b3…](https://testnet.bscscan.com/tx/0xbe235af9b3424db9a22487d156082c7333dbef5cc2e909b06d6a88fafa5712b6) |
| 08-extraction | E3 replaceAdapter: deploy a new adapter, make it the rebalancer and swap it in atomically | lmtest-governance | [0x15151e6f13…](https://testnet.bscscan.com/tx/0x15151e6f131cfb6f9b4602823cb1ea7c79a5dd2e8ffe8998991b3fb725170521) |
| 08-extraction | E3 replaceAdapter: deploy a new adapter, make it the rebalancer and swap it in atomically | lmtest-funding | [0xf4b9eb32f5…](https://testnet.bscscan.com/tx/0xf4b9eb32f5a85489ebec17996f43692406d198328676ca270f989cac2e3550d8) |
| 08-extraction | E3 replaceAdapter: deploy a new adapter, make it the rebalancer and swap it in atomically | lmtest-recall | [0x8a5c435878…](https://testnet.bscscan.com/tx/0x8a5c4358789a94d09fa978c5b756f34caae7b756b0e4be4270a91fb51bdab2c9) |
| 08-extraction | E4 Token pause by the Timelock (token owner): every transfer stops, including fund, recall and migration | lmtest-governance | [0x723352ad2b…](https://testnet.bscscan.com/tx/0x723352ad2b0a4d43ccd34890cc3282b8291de51c2ff485dbba64bff6eb60ad0d) |
| 08-extraction | E4 Token pause by the Timelock (token owner): every transfer stops, including fund, recall and migration | lmtest-governance | [0x57a7f5ec7e…](https://testnet.bscscan.com/tx/0x57a7f5ec7e0fdd6e52ea8cad375aacf4e16bb99528d08d6981714742db65e139) |
| 08-extraction | E4 Token pause by the Timelock (token owner): every transfer stops, including fund, recall and migration | lmtest-governance | [0x772b1f1395…](https://testnet.bscscan.com/tx/0x772b1f13959a717a95dadd1fa6ce536c03fce11d73a606b8c0cd70a89b206e65) |
| 08-extraction | E4 Token pause by the Timelock (token owner): every transfer stops, including fund, recall and migration | lmtest-governance | [0xdd0ceb6772…](https://testnet.bscscan.com/tx/0xdd0ceb67725733226da6c4a4f42fc578fdedde74f0dae3892a376ad2b08242ff) |
| 08-extraction | E5 Pool drain bypassing the Manager (no per-call limit, budget or pool minimum) | lmtest-governance | [0x197ed82f6e…](https://testnet.bscscan.com/tx/0x197ed82f6ec2976c58a7dd30d838910d9edbb741ab53fdaf52a97efefd2f7a6f) |
| 08-extraction | E5 Pool drain bypassing the Manager (no per-call limit, budget or pool minimum) | lmtest-governance | [0xfd6a6946c1…](https://testnet.bscscan.com/tx/0xfd6a6946c1fdebbcee3f402b80088f1064930449899136061ecf2219981cc457) |
| 08-extraction | E6 migrateReserves(recovery, max): the whole Manager balance | lmtest-governance | [0xb55f5ec109…](https://testnet.bscscan.com/tx/0xb55f5ec109396f315ec2168bd5c9b0bd92b638a6785e9d29a9f03002844d4d22) |
| 08-extraction | E6 migrateReserves(recovery, max): the whole Manager balance | lmtest-governance | [0x2817eb3fdc…](https://testnet.bscscan.com/tx/0x2817eb3fdc757ba1793f737061a6a7a22b0c7c7586de421b9cebbf6e24b9dea9) |
| 08-extraction | E7 Back to operations: recovery returns the reserves to the Manager and the inventory to the pool | lmtest-recovery | [0x5fb549115c…](https://testnet.bscscan.com/tx/0x5fb549115c0fb34c622978536737e172027472ab2ead7d4b6b2db693242e8464) |
| 08-extraction | E7 Back to operations: recovery returns the reserves to the Manager and the inventory to the pool | lmtest-recovery | [0x5aadfae485…](https://testnet.bscscan.com/tx/0x5aadfae485e8356056a70eac8a9bd70222438514a57d3b157ecd59fe12889e8f) |
| 09-finalize | Protected setGuardian(Guardian Safe) | lmtest-governance | [0xc91ead7967…](https://testnet.bscscan.com/tx/0xc91ead79672dffa055c9a8c5710801f3ad0684e4bb0306fb326908e70b81115a) |
| 09-finalize | Protected setGuardian(Guardian Safe) | lmtest-governance | [0x6d2a8e9341…](https://testnet.bscscan.com/tx/0x6d2a8e93412ad1cb9f1bbb9795001a1dd13a89b45bb01d1d15a40a647abd0c43) |
| 11-extra | X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back | lmtest-governance | [0x464bfa6232…](https://testnet.bscscan.com/tx/0x464bfa6232a462a6c8b9047a500eb770f7ea65e81c0e8484181301448f08640e) |
| 11-extra | X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back | lmtest-governance | [0xb57963fa4d…](https://testnet.bscscan.com/tx/0xb57963fa4da55ff0d0c77102ddc67668d0d892eed71fdfad6f8150838fbfcf9f) |
| 11-extra | X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back | lmtest-recall | [0x7e80af8cc3…](https://testnet.bscscan.com/tx/0x7e80af8cc37f493170ebe16267c5c9fa374ea38cbd0a9b9bb2812d5d4c581545) |
| 11-extra | X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back | lmtest-funding | [0x335e753bb8…](https://testnet.bscscan.com/tx/0x335e753bb8fc5692d71b480da5a86d32b75dec10c76a9e1c048ee872b2b8228f) |
| 11-extra | X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back | lmtest-governance | [0x2d925da90a…](https://testnet.bscscan.com/tx/0x2d925da90a2144c9586745c34f9d5f01318d670846b8d1ccb563a0608de13cec) |
| 11-extra | X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back | lmtest-governance | [0x220b6e8830…](https://testnet.bscscan.com/tx/0x220b6e8830eb01f78dcec9ce7bcadf773e0a631cf43a2cb434b69d155b5281ce) |
| 11-extra | X2 Operation lifecycle: cancel when READY, re-schedule with the same salt, a Done id cannot come back | lmtest-governance | [0x27ee98c297…](https://testnet.bscscan.com/tx/0x27ee98c2975a90e35e271b1eecdc9c401d0ff517a25876923f622915eb74a162) |
| 11-extra | X2 Operation lifecycle: cancel when READY, re-schedule with the same salt, a Done id cannot come back | lmtest-guardian | [0x8844db7cbf…](https://testnet.bscscan.com/tx/0x8844db7cbfff0bef5b5780a6ef4496bdcadb24ff3ea0ecec1022232418168c59) |
| 11-extra | X2 Operation lifecycle: cancel when READY, re-schedule with the same salt, a Done id cannot come back | lmtest-governance | [0x03f7b682f2…](https://testnet.bscscan.com/tx/0x03f7b682f282cf93d02fd0383fb1fc776dde929140c9cbd4ee0b10c95fac0739) |
| 11-extra | X2 Operation lifecycle: cancel when READY, re-schedule with the same salt, a Done id cannot come back | lmtest-governance | [0x95b50e369b…](https://testnet.bscscan.com/tx/0x95b50e369bcd837bb408862b14edddea51c760005ab560ac630af818b184621f) |
| 11-extra | X3 Lockdown leaves the Manager's fund / recall working; rate > capacity is rejected | lmtest-governance | [0x99f0db47a7…](https://testnet.bscscan.com/tx/0x99f0db47a7dda07d632bbd3ce3a2fb9fef8acf12fb4058e2e1a81508abd06c51) |
| 11-extra | X3 Lockdown leaves the Manager's fund / recall working; rate > capacity is rejected | lmtest-guardian | [0x84fbf39d84…](https://testnet.bscscan.com/tx/0x84fbf39d84fb81fb7d7f9df5c3811e4e076ab763c6452b9f5382f8783c468a35) |
| 11-extra | X3 Lockdown leaves the Manager's fund / recall working; rate > capacity is rejected | lmtest-funding | [0x45b13783c5…](https://testnet.bscscan.com/tx/0x45b13783c57fe27fdc321eecd13db37a2504454fb499ec826f4489871e1ed59f) |
| 11-extra | X3 Lockdown leaves the Manager's fund / recall working; rate > capacity is rejected | lmtest-recall | [0x0fdeea22cc…](https://testnet.bscscan.com/tx/0x0fdeea22ccf1cb0893d556f3ccd25d0f9844ecaab58004930858030923828053) |
| 11-extra | X3 Lockdown leaves the Manager's fund / recall working; rate > capacity is rejected | lmtest-governance | [0x43f8c006c9…](https://testnet.bscscan.com/tx/0x43f8c006c948070013cf44e06c619c4e0816436d2c17e95db82bb8aa3210bc3d) |
| 11-extra | X4 Owner-held delayed brakes: delist the token in the registry and zero the rebalancer, then restore | lmtest-governance | [0x00f10a31f5…](https://testnet.bscscan.com/tx/0x00f10a31f51466b43ccb1d8daabc495f91bfd2ed4b493fdd5ed2b9d30e06e8e3) |
| 11-extra | X4 Owner-held delayed brakes: delist the token in the registry and zero the rebalancer, then restore | lmtest-governance | [0x9c2928997a…](https://testnet.bscscan.com/tx/0x9c2928997a458eb13cfa21cd90c5e565f8aa571f4d6264875f91c934005ba753) |
| 11-extra | X4 Owner-held delayed brakes: delist the token in the registry and zero the rebalancer, then restore | lmtest-governance | [0x3132a9a488…](https://testnet.bscscan.com/tx/0x3132a9a488662b360c1e7bc149fe2c8fea954d2ef1796e799fac39f1fabf112f) |
| 11-extra | X4 Owner-held delayed brakes: delist the token in the registry and zero the rebalancer, then restore | lmtest-governance | [0x5d1bb14370…](https://testnet.bscscan.com/tx/0x5d1bb1437036cee6ec870b872568af43e1e090609cc2e5883aa39f112db64422) |

</details>

### sepolia

| Contract | Address |
| --- | --- |
| GOVERNANCE_SAFE | [`0x3949Fa522Ab7677f59E0BCD9dE80f41eFD97097B`](https://sepolia.etherscan.io/address/0x3949Fa522Ab7677f59E0BCD9dE80f41eFD97097B) |
| GUARDIAN_SAFE | [`0x71B397916aad393B20a68651AdC3a0D9fD64b26C`](https://sepolia.etherscan.io/address/0x71B397916aad393B20a68651AdC3a0D9fD64b26C) |
| TIMELOCK | [`0x6032FA5E8b9C1B30406CcbE740Ec277dC3D9fea6`](https://sepolia.etherscan.io/address/0x6032FA5E8b9C1B30406CcbE740Ec277dC3D9fea6) |
| MANAGER | [`0x9Bc0Aa79b7d18E335293cC327b5c4b21718fd87F`](https://sepolia.etherscan.io/address/0x9Bc0Aa79b7d18E335293cC327b5c4b21718fd87F) |
| CONTROLLER | [`0xCA704e8B652ef7733741927B47a176607D07571d`](https://sepolia.etherscan.io/address/0xCA704e8B652ef7733741927B47a176607D07571d) |
| ADAPTER_ORIGINAL | [`0x436E7Ce4F9EBE3797a7c94fc3C8648a292fD46be`](https://sepolia.etherscan.io/address/0x436E7Ce4F9EBE3797a7c94fc3C8648a292fD46be) |
| ADAPTER | [`0x76A18A671E369c6D6d18D34037fd3C50C78112a4`](https://sepolia.etherscan.io/address/0x76A18A671E369c6D6d18D34037fd3C50C78112a4) |
| STRAY_TOKEN | [`0xaaE7DB6968Aed52a622b3aD85aa4f04C6c6CD0dC`](https://sepolia.etherscan.io/address/0xaaE7DB6968Aed52a622b3aD85aa4f04C6c6CD0dC) |
| CCIP test transfer | [`0xe9a497ca73e0657c…`](https://ccip.chain.link/msg/0xe9a497ca73e0657caa0661a3f7e1b76768df71416c56313fb7a5a36f250470c5) |

<details><summary>91 transactions by step</summary>

| Step | Action | Sender | Tx |
| --- | --- | --- | --- |
| 00-setup | Gas top-ups from the deployer | deployer | [0xf5dd597e8c…](https://sepolia.etherscan.io/tx/0xf5dd597e8c71dd00ff5193cdf350893f74b53e8b1e2728d9b3b91513580297af) |
| 00-setup | Gas top-ups from the deployer | deployer | [0x6ee2ae0e2a…](https://sepolia.etherscan.io/tx/0x6ee2ae0e2ab6a6dde05159705ec4ac5748b6452394d334ec585b7a51938e03ca) |
| 00-setup | Gas top-ups from the deployer | deployer | [0x153b4cec22…](https://sepolia.etherscan.io/tx/0x153b4cec22d0b2e51a67b2777a79a0d20a4ae0f7108da1411e7603ab8488c985) |
| 00-setup | Gas top-ups from the deployer | deployer | [0xe57d7dea9a…](https://sepolia.etherscan.io/tx/0xe57d7dea9a553053bc16a2170d20f9be8cb8500a2ae32e18d760678ade43c804) |
| 00-setup | Gas top-ups from the deployer | deployer | [0x17b04a0970…](https://sepolia.etherscan.io/tx/0x17b04a0970cc62ca0f4960cb5104c7b9f76b35df3996c371089ef87dcf121e2b) |
| 00-setup | Gas top-ups from the deployer | deployer | [0xc9b1964274…](https://sepolia.etherscan.io/tx/0xc9b1964274bce52fb7522eb94ae283700166f5664c9e5adc16834994c7ce0fa1) |
| 00-setup | Governance Safe (1-of-1, owner lmtest-governance) | lmtest-governance | [0x5f27630032…](https://sepolia.etherscan.io/tx/0x5f2763003242a1664cc0a1ec5206974d004b9d9b8161dbd87f27b9641e369165) |
| 00-setup | Guardian Safe (1-of-1, owner lmtest-guardian) | lmtest-guardian | [0x6da971f136…](https://sepolia.etherscan.io/tx/0x6da971f13630c2bea0215020dced90f51745d98f8ef1182a43105e26b62307e7) |
| 01-deploy | deploy SaharaTimelock | deployer | [0x5346a66c24…](https://sepolia.etherscan.io/tx/0x5346a66c24891c5e93292b3c8ecec8b4c48dbea435a3859c33e5b9eb162e50e2) |
| 01-deploy | deploy LiquidityManager | deployer | [0x5c0e2a9d80…](https://sepolia.etherscan.io/tx/0x5c0e2a9d808c315da51a9d1fc7701dba3728a42bd4bef34224a37836605077ee) |
| 01-deploy | deploy GuardianController | deployer | [0x8ad9538d48…](https://sepolia.etherscan.io/tx/0x8ad9538d48b34606e54c05d8425b4381e591ab307d8297d1aa173ac51bb88f7f) |
| 01-deploy | deploy CCIPPoolAdapter | deployer | [0x44da21747a…](https://sepolia.etherscan.io/tx/0x44da21747abae12498c0d8c6784d473b4c33a57ed518a52e19c7fbc40aa5bdc1) |
| 02-handover | Legacy owner (deployer) calls: rateLimitAdmin -> controller, propose the Timelock as pool owner and registry admin, token ownership -> Timelock | deployer | [0x2b34e1272a…](https://sepolia.etherscan.io/tx/0x2b34e1272a0af83ad2c8e563f8d4d25650383d225e76a960b772f2d8f62512f9) |
| 02-handover | Legacy owner (deployer) calls: rateLimitAdmin -> controller, propose the Timelock as pool owner and registry admin, token ownership -> Timelock | deployer | [0xb17f040c55…](https://sepolia.etherscan.io/tx/0xb17f040c55aceb53f226a5c1d0a92266ff512257b251aa14de3822f5067ef975) |
| 02-handover | Legacy owner (deployer) calls: rateLimitAdmin -> controller, propose the Timelock as pool owner and registry admin, token ownership -> Timelock | deployer | [0x72b10c1dc1…](https://sepolia.etherscan.io/tx/0x72b10c1dc1f2af8658300b0fa381984d9d4894995411b3df750d9421d273ca38) |
| 02-handover | Legacy owner (deployer) calls: rateLimitAdmin -> controller, propose the Timelock as pool owner and registry admin, token ownership -> Timelock | deployer | [0xa9570c01ff…](https://sepolia.etherscan.io/tx/0xa9570c01ff3f0d50eeee07151e3519663c5ea16e20979a8c38a9a0123c5623a5) |
| 02-handover | Governance Safe -> Timelock.scheduleBatch (12 calls) | lmtest-governance | [0x93326a4aff…](https://sepolia.etherscan.io/tx/0x93326a4affd852d412e18462a173c10c389d54fce9f1f8a8b6f035654a1af858) |
| 02-handover | Wait for the delay, then Governance Safe -> Timelock.executeBatch | lmtest-governance | [0x341d222cfd…](https://sepolia.etherscan.io/tx/0x341d222cfd461cd9d757a58253b75518ab4e2958fe12c1f2d72e28c9520b56cd) |
| 02-handover | Legacy reserves -> Manager (plain transfer of 500000.0000 MTK) | deployer | [0xc3a2034922…](https://sepolia.etherscan.io/tx/0xc3a2034922cd024e0c1b41a07fc52bec2b57bfddae5f75cc8fbe5cb7025a3a02) |
| 03-fund-recall | fund up to maxFundingPerCall (30000.0000) twice: the pool budget (60000.0000) runs out | lmtest-funding | [0xc413c5f30b…](https://sepolia.etherscan.io/tx/0xc413c5f30b4d87f7fce3d4f42cf95c513b739ef45a84a3c2e3861b004443859a) |
| 03-fund-recall | fund up to maxFundingPerCall (30000.0000) twice: the pool budget (60000.0000) runs out | lmtest-funding | [0xd5a0a17482…](https://sepolia.etherscan.io/tx/0xd5a0a174828ae1edbcc1517765c7634d0d47378de9cf18df61d4722dc7d81e1e) |
| 03-fund-recall | recall up to maxRecallPerCall (30000.0000) back to the Manager, never below the pool minimum | lmtest-recall | [0x59aaec17ed…](https://sepolia.etherscan.io/tx/0x59aaec17edab8fa9e744ffe2a5cd7015e23a3f1058dcefddec7c698d0ea35fc4) |
| 04-bridge | CCIP send 1000.0000 MTK: sepolia -> bsc (receiver 0xB06588e58Ed0920E737F9306778e753c7e67e77e) | deployer | [0x2a07706fe9…](https://sepolia.etherscan.io/tx/0x2a07706fe9748b81fd1df5526ae0f7a4129eb694fa27a8c64ec1253caecfaf7b) |
| 04-bridge | CCIP send 1000.0000 MTK: sepolia -> bsc (receiver 0xB06588e58Ed0920E737F9306778e753c7e67e77e) | deployer | [0x3e61bdf704…](https://sepolia.etherscan.io/tx/0x3e61bdf704f86b294f66e586377d6373a9f28d191da706a7208f3159e353d8e3) |
| 05-guardian | raisePoolMinimum to the current pool balance: every recall now breaches the minimum | lmtest-guardian | [0xbd5f73ec93…](https://sepolia.etherscan.io/tx/0xbd5f73ec93f3a42aa62570af4877d318e8b24bd2fb18f0a22248ff4d1316eae8) |
| 05-guardian | pauseFunding / pauseRecall | lmtest-guardian | [0xf8eea1ec5a…](https://sepolia.etherscan.io/tx/0xf8eea1ec5a59d54e9c37cb3d37b3c4573702860f8411e9150352089456795c1e) |
| 05-guardian | pauseFunding / pauseRecall | lmtest-guardian | [0xce84c7ab13…](https://sepolia.etherscan.io/tx/0xce84c7ab139428dfd28e5b116f867b56ca09ae54386eaba26e1b6649b4406f56) |
| 05-guardian | suspend both operators, restrict the adapter | lmtest-guardian | [0xb59bb690e0…](https://sepolia.etherscan.io/tx/0xb59bb690e0f1985031da0d05a969134242f39ee0c99a1ea52e75b9887e7d918b) |
| 05-guardian | suspend both operators, restrict the adapter | lmtest-guardian | [0xd1c46b555b…](https://sepolia.etherscan.io/tx/0xd1c46b555b88dbdf075930a07a5fceb6b977897745b62830f291fca61fe6b741) |
| 05-guardian | suspend both operators, restrict the adapter | lmtest-guardian | [0x82c63a5e58…](https://sepolia.etherscan.io/tx/0x82c63a5e5833f20ff8d356f8ffc3b4cb74c309e91486c99799a37b9910239eaf) |
| 05-guardian | lower the limits and budgets | lmtest-guardian | [0xd5e3fe3459…](https://sepolia.etherscan.io/tx/0xd5e3fe34595500316143cd0398c577b848781afd12d1c9cac1b2c9c1b3a7265a) |
| 05-guardian | lower the limits and budgets | lmtest-guardian | [0x5034e80126…](https://sepolia.etherscan.io/tx/0x5034e80126f4b1e3919605d478c219b912698bf6857877865f92bbdc3672541a) |
| 05-guardian | lower the limits and budgets | lmtest-guardian | [0xfeb4ade229…](https://sepolia.etherscan.io/tx/0xfeb4ade2292393bbb6ae920d43f5d3408c6d4cc9adb334a31307f3ab7298b3c3) |
| 05-guardian | lower the limits and budgets | lmtest-guardian | [0xc2a6d41562…](https://sepolia.etherscan.io/tx/0xc2a6d41562b9b8767e3e1e80edde48f908cefecee813eef81632f30bdc2596ca) |
| 05-guardian | Timelock restore batch (Governance Safe, full delay) | lmtest-governance | [0x7c9082b83a…](https://sepolia.etherscan.io/tx/0x7c9082b83a5f9ec21330949eb6224b2005315fd0c64d805c6220f399cecd9980) |
| 05-guardian | Timelock restore batch (Governance Safe, full delay) | lmtest-governance | [0x938827c35e…](https://sepolia.etherscan.io/tx/0x938827c35e1bf8fa3a3dea236ca5bd500a6f46f5d9dc21aa27679e4397fade88) |
| 05-guardian | Restored (resumed after an RPC drop): the fund of 100 landed in 0x1e9548c7bf1699b6a45ef105ce8698c7ed3153f0834d1eddae67edf1c9641689, now the recall | lmtest-recall | [0xaff73ca0b0…](https://sepolia.etherscan.io/tx/0xaff73ca0b05bc84d90fd30ea688f213a980c32919d2ae22e85fa7e4476b308d7) |
| 05-guardian | Restored: small fund and recall go through again | lmtest-funding | [0x1e9548c7bf…](https://sepolia.etherscan.io/tx/0x1e9548c7bf1699b6a45ef105ce8698c7ed3153f0834d1eddae67edf1c9641689) |
| 06-governance | Malicious proposal: migrateReserves(attacker, max) -> cancelled by the Guardian | lmtest-governance | [0x6f25c3fd02…](https://sepolia.etherscan.io/tx/0x6f25c3fd02b1860829dcc6bd002976aa1cfd779f3139026a7de12f688dacc9f4) |
| 06-governance | Malicious proposal: migrateReserves(attacker, max) -> cancelled by the Guardian | lmtest-guardian | [0x83a632a7bd…](https://sepolia.etherscan.io/tx/0x83a632a7bd7c077b3092b14469c831fef51013b33b2ce6de05a2610d769c049e) |
| 06-governance | Mixed batch [setGuardian(guardian2), setFundingPaused(true)] is not protected -> cancelled by the Guardian | lmtest-governance | [0x3bfbe6cfe3…](https://sepolia.etherscan.io/tx/0x3bfbe6cfe310f163269cca55191e5b6df8f904a55e74936eebf8413a273a07f8) |
| 06-governance | Mixed batch [setGuardian(guardian2), setFundingPaused(true)] is not protected -> cancelled by the Guardian | lmtest-guardian | [0x5abdfb8583…](https://sepolia.etherscan.io/tx/0x5abdfb8583ab2528be942df28ed1688eee76858b1443c13abbaa4bee61341bd5) |
| 06-governance | The Governance Safe withdraws its own proposal (it keeps CANCELLER_ROLE) | lmtest-governance | [0xccfad4732d…](https://sepolia.etherscan.io/tx/0xccfad4732d10231c93a323e21b59e8bf4e04bf6c860d111d8c839310fa66b515) |
| 06-governance | The Governance Safe withdraws its own proposal (it keeps CANCELLER_ROLE) | lmtest-governance | [0xd576fcaea0…](https://sepolia.etherscan.io/tx/0xd576fcaea092b2a8ffda9753cffc47a0e691c3f8e28c478b282bfcad03f5d486) |
| 06-governance | Guardian recovery: Governance schedules setGuardian(guardian2) alone, predecessor 0 | lmtest-governance | [0x2324cb89c9…](https://sepolia.etherscan.io/tx/0x2324cb89c96e34f132c2858e3e7e09e58c5ea05231d2aef6280a0c94175cddce) |
| 06-governance | Guardian recovery: Governance schedules setGuardian(guardian2) alone, predecessor 0 | lmtest-governance | [0xd609aa7ad7…](https://sepolia.etherscan.io/tx/0xd609aa7ad72a4fa1c5123b011fc23dfe536132a2a62224bc0752020853a8f387) |
| 07-lockdown | Governance schedules the restore first (pending while the pool is locked down) | lmtest-governance | [0xd71ac84946…](https://sepolia.etherscan.io/tx/0xd71ac849468ebf60a2d8930bda2db9a65349de180e8b0c1e4282d2a979f9667a) |
| 07-lockdown | Guardian -> GuardianController.lockdown(pool) | lmtest-guardian2 | [0xf335c38cab…](https://sepolia.etherscan.io/tx/0xf335c38cab378eaccc6c16afa8579a0bb080c69c4b2beafa72663e6f3471e5b6) |
| 07-lockdown | Bridge transfers are refused at the source | deployer | [0xe8c0a7f50e…](https://sepolia.etherscan.io/tx/0xe8c0a7f50eb04d374a2f2792f321755e21caaf183c14e324812cc464d43cc940) |
| 07-lockdown | Timelock restores the original limits (buckets restart from zero and refill) | lmtest-governance | [0xae281e0ed0…](https://sepolia.etherscan.io/tx/0xae281e0ed0dbdec469f4c318f4eebcf11c9ed3cea7d9c93de5578dbfda6089e3) |
| 07-lockdown | Timelock restores the original limits (buckets restart from zero and refill) | deployer | [0x2b280c345c…](https://sepolia.etherscan.io/tx/0x2b280c345cd614cb9af652715109753445e6233335110e95eb8b7bb79e1785e4) |
| 07-lockdown | Timelock restores the original limits (buckets restart from zero and refill) | deployer | [0x149bb388cf…](https://sepolia.etherscan.io/tx/0x149bb388cf1c854880118507c19940d65d3fb753bdd3c24b06dac4a66ee429d8) |
| 08-extraction | E2 recoverToken: a stray token sent to the Manager by mistake | deployer | [0x1a1f0cd9f4…](https://sepolia.etherscan.io/tx/0x1a1f0cd9f4996b4844a13d1dcdf38025baf5e5a4398a9ab91d0d15952e8abdb0) |
| 08-extraction | E2 recoverToken: a stray token sent to the Manager by mistake | lmtest-governance | [0x29b8c4f598…](https://sepolia.etherscan.io/tx/0x29b8c4f5983c5151ba9237ef5c577e49dc3b1fa2c308304c938f6cc13304538f) |
| 08-extraction | E2 recoverToken: a stray token sent to the Manager by mistake | lmtest-governance | [0x36adb3e9b6…](https://sepolia.etherscan.io/tx/0x36adb3e9b64c3c76eca0cf8acbe8229355c2efd4f0c5865922a8a7fedb065683) |
| 08-extraction | E3 replaceAdapter: deploy a new adapter, make it the rebalancer and swap it in atomically | deployer | [0x2ecef433bd…](https://sepolia.etherscan.io/tx/0x2ecef433bd1b1b4b6c567c6cee5a95a512be2113e8c82c684a4df5c798b6cd0a) |
| 08-extraction | E3 replaceAdapter: deploy a new adapter, make it the rebalancer and swap it in atomically | lmtest-governance | [0xb54df41eac…](https://sepolia.etherscan.io/tx/0xb54df41eacd08d46e79e106525163a3bb188ded24e2b84c59967dfbd61c2fcde) |
| 08-extraction | E3 replaceAdapter: deploy a new adapter, make it the rebalancer and swap it in atomically | lmtest-governance | [0xaa886a28f8…](https://sepolia.etherscan.io/tx/0xaa886a28f8f179c53bc4bfc8eb2a0f26f728751ae7ef0cec7214474999389b9b) |
| 08-extraction | E3 replaceAdapter: deploy a new adapter, make it the rebalancer and swap it in atomically | lmtest-funding | [0x8c8277b2b8…](https://sepolia.etherscan.io/tx/0x8c8277b2b8ddfa2b68eb1f6ebd0fffe9308eb87f37ec1e5f0cf434b341469d79) |
| 08-extraction | E3 replaceAdapter: deploy a new adapter, make it the rebalancer and swap it in atomically | lmtest-recall | [0xc206f90e01…](https://sepolia.etherscan.io/tx/0xc206f90e0164f7f38c6194859740235cbc3c382e66c9c4772abd5cd639c9b973) |
| 08-extraction | E4 Token pause by the Timelock (token owner): every transfer stops, including fund, recall and migration | lmtest-governance | [0xf2aa5fce53…](https://sepolia.etherscan.io/tx/0xf2aa5fce5341093b5be7eb0eac584f06b8317d6de2d886520ffbae209be14626) |
| 08-extraction | E4 Token pause by the Timelock (token owner): every transfer stops, including fund, recall and migration | lmtest-governance | [0xc288d68f55…](https://sepolia.etherscan.io/tx/0xc288d68f55c2403b4a582a978cba925e1e90cb3e9ff10b9ad4268005788d199b) |
| 08-extraction | E4 Token pause by the Timelock (token owner): every transfer stops, including fund, recall and migration | lmtest-governance | [0x18381cb5fc…](https://sepolia.etherscan.io/tx/0x18381cb5fcee0f50fb3669a431aa35d2dc25cb57c925d3e31f20189ec306df42) |
| 08-extraction | E4 Token pause by the Timelock (token owner): every transfer stops, including fund, recall and migration | lmtest-governance | [0xb68a650e1b…](https://sepolia.etherscan.io/tx/0xb68a650e1b36416c88a7526c0b49967a71e118d033eef2e7550fcfd317a31e73) |
| 08-extraction | E5 Pool drain bypassing the Manager (no per-call limit, budget or pool minimum) | lmtest-governance | [0x85c2a5f444…](https://sepolia.etherscan.io/tx/0x85c2a5f4441ba3861d7f43394b07425b42370a9220873255692a6ad057d4244c) |
| 08-extraction | E5 Pool drain bypassing the Manager (no per-call limit, budget or pool minimum) | lmtest-governance | [0xb74889a7be…](https://sepolia.etherscan.io/tx/0xb74889a7be952ed6db28ee03b1c6b6e91605f2081f25337c129c8fe258d2825c) |
| 08-extraction | E6 migrateReserves(recovery, max): the whole Manager balance | lmtest-governance | [0x5d5103c9fe…](https://sepolia.etherscan.io/tx/0x5d5103c9fea458446a1302016634e9492ef8552b0f7ed617e82f93917f7cf19d) |
| 08-extraction | E6 migrateReserves(recovery, max): the whole Manager balance | lmtest-governance | [0xdccec921e0…](https://sepolia.etherscan.io/tx/0xdccec921e05d8cfa665cccef1649d2cd7198350f11390c30e7b316a5026815c5) |
| 08-extraction | E7 Back to operations: recovery returns the reserves to the Manager and the inventory to the pool | lmtest-recovery | [0x136d977772…](https://sepolia.etherscan.io/tx/0x136d9777720463c2cec263d56aabde8bd6da5ac060520ea7b004550570117d4f) |
| 08-extraction | E7 Back to operations: recovery returns the reserves to the Manager and the inventory to the pool | lmtest-recovery | [0x83aa6a6ce2…](https://sepolia.etherscan.io/tx/0x83aa6a6ce2f7c0e98ff004c889f8c8152eb7f30fecfeb9d87472a7861021b7b4) |
| 09-finalize | Protected setGuardian(Guardian Safe) | lmtest-governance | [0xb24cb3ecd6…](https://sepolia.etherscan.io/tx/0xb24cb3ecd623dd954ddab994ea06b7c0ef0dd10bfab4c59800731cf5f6dd55f6) |
| 09-finalize | Protected setGuardian(Guardian Safe) | lmtest-governance | [0xe07e4ba83c…](https://sepolia.etherscan.io/tx/0xe07e4ba83c4d863263fc942967d6cd5c73a838376add3497851671c13432bc4d) |
| 11-extra | X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back | lmtest-governance | [0x891fea48eb…](https://sepolia.etherscan.io/tx/0x891fea48ebf8c6c7c1cd7242aa758ef7020aa025c0dfec56f7c73ca6e7c15095) |
| 11-extra | X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back | lmtest-governance | [0xff498fe88e…](https://sepolia.etherscan.io/tx/0xff498fe88e697b0de29514e460f10cc487af1232931a1f44ca5595b02a5cbd63) |
| 11-extra | X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back | lmtest-recall | [0xabef2a6810…](https://sepolia.etherscan.io/tx/0xabef2a6810781a96489a4b8169ffe1e99a5a100d0d96f3f23783920b484104f5) |
| 11-extra | X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back | lmtest-funding | [0x78cbb80a83…](https://sepolia.etherscan.io/tx/0x78cbb80a83968fc319c563567c5ac71ed1b86be6030b73a77f60a14688517b68) |
| 11-extra | X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back | lmtest-governance | [0x4c6600399a…](https://sepolia.etherscan.io/tx/0x4c6600399a136cffd83f7b9ec560143ec6f7981c9df3f49dac584d859706ca4c) |
| 11-extra | X1 Full exit through the Manager: relax the limits by Timelock, recall the whole pool, fund it back | lmtest-governance | [0x1566980c93…](https://sepolia.etherscan.io/tx/0x1566980c9360c1131bf1a00f4ed882fc9f041b3122604877d4fd617e79fe41c0) |
| 11-extra | X2 Operation lifecycle: cancel when READY, re-schedule with the same salt, a Done id cannot come back | lmtest-governance | [0xebca5f7ff4…](https://sepolia.etherscan.io/tx/0xebca5f7ff42792c0f01c793c779f60bbc163d7834392e8ca5d2dd06405dca83b) |
| 11-extra | X2 Operation lifecycle: cancel when READY, re-schedule with the same salt, a Done id cannot come back | lmtest-guardian | [0xea28f1314d…](https://sepolia.etherscan.io/tx/0xea28f1314d707b2ecac88bafd0ce3770afefbde3f9ad20862594d24102296a27) |
| 11-extra | X2 Operation lifecycle: cancel when READY, re-schedule with the same salt, a Done id cannot come back | lmtest-governance | [0x6697aea6e7…](https://sepolia.etherscan.io/tx/0x6697aea6e73f8ba0dd5472a2c9843e090801be6f5a69278228f96643ade71146) |
| 11-extra | X2 Operation lifecycle: cancel when READY, re-schedule with the same salt, a Done id cannot come back | lmtest-governance | [0xfeda9eaed3…](https://sepolia.etherscan.io/tx/0xfeda9eaed368a9c7bf2723c0e8f5bd37811c376c3b7e507661780a66704cf80d) |
| 11-extra | X3 Lockdown leaves the Manager's fund / recall working; rate > capacity is rejected | lmtest-governance | [0xe16ba1e2ba…](https://sepolia.etherscan.io/tx/0xe16ba1e2ba090cfc29f45ae38c3789d05cba31dbb77dbe17b72bbee6d42f2f49) |
| 11-extra | X3 Lockdown leaves the Manager's fund / recall working; rate > capacity is rejected | lmtest-guardian | [0x9b71c0a700…](https://sepolia.etherscan.io/tx/0x9b71c0a700a78067d43eca36fe4b3bf605c933922c7a64eefadfbf0bf79d3e84) |
| 11-extra | X3 Lockdown leaves the Manager's fund / recall working; rate > capacity is rejected | lmtest-funding | [0xa9d683907e…](https://sepolia.etherscan.io/tx/0xa9d683907e86a0285fd55203e1f41bb9a50457575069e39f656054ac05eddc0e) |
| 11-extra | X3 Lockdown leaves the Manager's fund / recall working; rate > capacity is rejected | lmtest-recall | [0x59684cb40c…](https://sepolia.etherscan.io/tx/0x59684cb40c1124b02f566a7d2ac6268e59b7324494323c9aa48530b478f5b76a) |
| 11-extra | X3 Lockdown leaves the Manager's fund / recall working; rate > capacity is rejected | lmtest-governance | [0x368b21a0d9…](https://sepolia.etherscan.io/tx/0x368b21a0d92c7f0ad636f22ceb01d81a23da99f1c381215d33d85f3e69a3a5a8) |
| 11-extra | X4 Owner-held delayed brakes: delist the token in the registry and zero the rebalancer, then restore | lmtest-governance | [0xecce66a0ce…](https://sepolia.etherscan.io/tx/0xecce66a0ce31d08ab0a0e706463a7a7f33b14c2a30da645bcc0137f38f3873ec) |
| 11-extra | X4 Owner-held delayed brakes: delist the token in the registry and zero the rebalancer, then restore | lmtest-governance | [0x81abe93d69…](https://sepolia.etherscan.io/tx/0x81abe93d69286700d86981b5dd3df110c751e2317e9fb8dbf18bb98f47f9bac9) |
| 11-extra | X4 Owner-held delayed brakes: delist the token in the registry and zero the rebalancer, then restore | lmtest-governance | [0xb0a9fbeb05…](https://sepolia.etherscan.io/tx/0xb0a9fbeb05000a04cea83249add390a53f1a0cf1144b9b4a9c4d3c2300454d25) |
| 11-extra | X4 Owner-held delayed brakes: delist the token in the registry and zero the rebalancer, then restore | lmtest-governance | [0x53a3980890…](https://sepolia.etherscan.io/tx/0x53a39808909995d50b7d2bda34db7e002b4218093fed0e392dee3667c7b7f2fc) |

</details>

## Monitor alert test

The read-only monitor ([`monitor/`](../../monitor)) was tested against this deployment on 2026-10-31 and 2026-11-01
with [`monitor/config.yaml`](monitor/config.yaml): MTK in place of SAHARA, the deployer as the legacy reserve wallet,
`requiredBacking` = one chain's supply (1,000,000), the drill's 120 s delay and rate limits, and a Telegram route to a
test group (`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_ID` in `monitor/.env`). The on-chain, fault and config tests ran
with alerts on stdout before the Telegram route was added; the delivery tests ran against Telegram.

```sh
cd monitor
node --env-file=.env src/cli.ts check --config ../script/testnet/monitor/config.yaml     # one-shot report
node --env-file=.env src/cli.ts scan --config ../script/testnet/monitor/config.yaml --chain bsc-testnet \
  --from <block> --to <block>
cd ../script/testnet/monitor
CHAIN=bsc bash -c 'source ../drill/lib.sh; source lib.sh; mon_start'       # daemon; JSON logs in deployments/monitor.log
CHAIN=bsc ./live-test.sh brakes predecessor guardian limits skew ratelimits inflow
CHAIN=bsc ./live-test.sh ccip-send && CHAIN=bsc ./live-test.sh ccip-wait   # per sending chain
CHAIN=bsc ./fault-test.sh reads outage      # daemon's BSC RPC behind rpc-fault-proxy.mjs (see the script header)
CHAIN=bsc ./config-flip-test.sh
CHAIN=bsc ./telegram-test.sh route outage
```

Every live scenario schedules its restore operation before the change executes; if an expectation fails, the exit
trap executes the restore (or cancels both when the change never ran). `FAIL_AT=<scenario>-after-change` rehearses that
path; it was rehearsed live on `brakes`.

**Replay of the drill** (`scan` over each chain's drill blocks): 140 alerts on each chain, identical rule and severity
counts. Every transaction that touches the system raised an alert; the 13 without one are gas top-ups, Safe creations,
contract creations that emit no events, `approve(Router, 0)` and the stray-token deployment. The cancel calldata of all
19 Guardian-cancellable proposals hashes to its operation id with the right `cancel`/`cancelBatch` selector, and both
protected `setGuardian` proposals offer only the governance `cancel(id)`. Sepolia's publicnode RPC prunes historical
state, so the Sepolia replay ran through an anvil fork of an archive-capable RPC.

**Live daemon** (BSC testnet unless noted): every expected alert fired and every condition resolved after the restore.

| Scenario | Alerts and conditions seen |
| --- | --- |
| `brakes` | `registry.pool`, `pool.config`; `state-registry.pool`, `state-pool.rebalancer`, `state-manager.verify-adapter` (critical), resolved |
| `ccip-send` / `ccip-wait` (both directions, 600 MTK) | `flows.approval`, `flows.endpoint-outflow`, `flows.large-transfer` on the destination; Sepolia → BSC took about 17 min, so `reconcile.stuck-message` (600 s) opened and resolved on release |
| `predecessor` | `timelock-queue.soon`, `.ready`, `.blocked` (protected `setGuardian` behind its predecessor); the Guardian's cancel of the predecessor raised critical `timelock.cancelled` "(stalls a pending Guardian recovery)" |
| `guardian` | `manager.guardian-action`; six `state-manager` warnings (pauses, operators, adapter flags), resolved by one Timelock batch |
| `limits` | `state-manager.budget-low` → `.budget-exhausted`; `state-inventory.below-minimum` (critical) → `.below-trigger` (warning), resolved |
| `skew` | `timelock.role`, `timelock.delay`, `registry.admin`, `pool.config`; 12 critical conditions (pool spec router / version / remote token / remote pools, rateLimitAdmin, `verify-adapter`, Manager pending owner, registry pending admin, `verify-handover`, controller without `CANCELLER_ROLE`, Guardian holding it, delay), resolved |
| `ratelimits` | `pool.rate-limits` "disabled (unlimited)"; `state-pool.rate-limit-disabled` (critical), `.rate-limit-mismatch` (high), then `controller.lockdown` and `state-pool.lockdown`, resolved |
| `inflow` | `flows.endpoint-inflow` |
| `fault-test.sh reads` | `state-manager.read-failed` warning → high after `staleAfterSec`; `reconcile.incomplete` "unreachable"; `health.reconcile-stale` after 6 min; `/healthz` 503 → 200 |
| `fault-test.sh outage` | `health.stale-telemetry` high after 3 min; `/healthz` 503 → 200 |
| `config-flip-test.sh` | `reconcile.backing`, `reconcile.total-supply` (critical), `state-router.on-ramp` (high), resolved on the original config |
| Telegram, normal | `test-alert`, then `predecessor` again with the fixes below: 12 messages delivered, none failed |
| `telegram-test.sh route` | A second route to a chat that does not exist fails as `route` ("400 Bad Request: chat not found"), `/healthz` 503 `delivery-failing` while the real group keeps receiving; with the route removed its kept message is dropped and `/healthz` is 200 again |
| `telegram-test.sh outage` | API on a closed port: messages kept as `transient`, `/healthz` 503; the 21 extra-operator warnings fold into one digest. Back on the real API: the kept messages are sent again, "alert delivery recovered", the warnings resolve into the same digest (2 messages in all), outbox empty |

Not covered on testnet: `ccip.message-failed` / `reconcile.failed-messages`
(a failed message needs a manual execution to clear), `health.ccip-gap-replay`, `digest`, and the rules testnet
cannot produce (Router ramps and owner, pool allowlist, unexplained Manager / adapter / pool outflows, adapter
allowance, adapter dust, which is irreversible). These rely on the monitor's unit and e2e tests.

### Monitor findings

None changes what is detected or its severity; they are wrong, misleading or noisy alerts. The first eight are fixed in
`monitor/` (with regression tests that fail on the old code); the rest are open.

- **Call numbers in Timelock attribution were 0-based**: config events said "Timelock operation (call #3)" for the
  call `timelock.executed` lists as "Call 4/12", and the first call of a batch had no number. Now "(call 4/12)".
- **Cancel guidance after the ETA**: `timelock-queue.ready` and `.blocked` repeated "cancel … before <ETA>" when the ETA
  had passed (seen live in `predecessor`). They now say to cancel now: OpenZeppelin cancels until execution.
- **Wrong ETA in `controller.proposal-cancelled`** when the same id was re-scheduled in the same processed block range
  (it showed the re-scheduled ETA). The Timelock rule now records each cancelled scheduling for it.
- **Cancelled unprotected `setGuardian`**: the note told governance to re-propose the same operation, which the
  Guardian can cancel again, and the critical `timelock.cancelled` had no note. Both now say to re-propose it as a
  single protected call with predecessor 0.
- **Durations dropped seconds**: a 120 → 121 s delay change read "Timelock delay changed: 2m -> 2m". The delay titles
  now keep seconds ("2m 1s").
- **`state-pool.router` title** said "Pool Router changed to Router" when the Manager's spec had changed. Now "Pool
  Router is X, spec requires Y".
- **`state-router` followed the Manager's spec**: a spec with a wrong remote selector also raised "Router OnRamp /
  OffRamps changed" for that selector. Now only the configured lanes are checked, and the new `state-pool.lane`
  reports a spec on a lane that is not configured.
- **Passing RPC errors paged the channel**: every failed read raised a warning at once and listed every read
  ("Cannot verify state-timelock: 70 read(s) failed", resolved 26 s later), and one failed reconciliation run between
  good ones raised and resolved `reconcile.incomplete` (20 times in a day on publicnode). Now a failure raises its
  warning only after `alerts.transientFailureGraceSec` (60 s; escalation unchanged), and "Failed reads" has one line per
  function, counted ("Timelock.hasRole(…) ×56"), at most 10 lines.
- **Hard-coded "SAHARA"** in two titles (`Registry maps SAHARA to no pool`, `SAHARA sent directly to …`); cosmetic on
  testnet only.
- By design (documented): `flows.outflow-window` opens once at high and stays silent while the window keeps growing (in
  the drill, a routine 30k recall held it open through a 130k pool drain, which `pool.liquidity` reported), and a
  `replaceAdapter` proposal carries no reminder to check the new adapter's bytecode before the ETA.
