# External and CCIP ABI verification

Checked on 2026-10-28 for `src/abi/external.ts` and `src/abi/ccip.ts`. `test/abi.test.ts` asserts every topic0 below
and decodes the captured receipts in `test/fixtures/ccip/`.

## Method

1. **Verified source.** Every ABI entry was taken from the verified source, not from memory:
   - Sourcify full or partial match: the pool, registry, router and token on Ethereum; the registry, router and token on
     BSC; OffRamp 2.0.0 on Ethereum; EVM2EVMOnRamp 1.5.0 and 1.2.0, and EVM2EVMOffRamp 1.5.0 and 1.2.0, on both chains.
   - OnRamp 2.0.0 is verified on Etherscan, not Sourcify. Its `OnRamp.sol` is identical on chainlink-ccip tag
     `contracts-ccip-v2.0.0` and on `main`.
   - The deployed OffRamp 2.0.0 source differs from that tag only in the `IRMNRemote` versus `IRMN` import name.
     `MessageV1Codec.sol` and `Internal.sol` are byte-identical.
2. **Same code on both chains.** Contracts that are verified on only one chain were compared by runtime bytecode, and
   they differ only in immutables:
   - Pool: 15,423 bytes, 60 differing bytes in 3 runs.
   - OffRamp 2.0.0: 24,253 bytes, 116 differing bytes in 7 runs.
   - OnRamp 2.0.0: 24,050 bytes, 110 differing bytes in 7 runs.

   `typeAndVersion()` matches on both chains: "LockReleaseTokenPool 1.6.3-dev", "OnRamp 2.0.0" and "OffRamp 2.0.0".
3. **topic0.** Computed with viem `toEventSelector` and cross-checked with `cast sig-event`. Each one was compared with
   real logs; the sample transactions are listed below.
4. **Views.** The following views were called live with `cast call`, and each returned plausible values:
   - OnRamp 2.0.0: `getExpectedNextMessageNumber` and `getDestChainConfig`.
   - OffRamp 2.0.0: `getExecutionState(bytes32)` (2 for a SUCCESS message, 3 for a FAILURE message) and
     `getSourceChainConfig`.
   - EVM2EVMOffRamp: `getExecutionState(uint64)`.
   - EVM2EVMOnRamp and EVM2EVMOffRamp: `getStaticConfig`, decoded with the shared 1.2.0-prefix layout. The tests cover
     this using captured return data.

## Contracts

| Contract | Version | Ethereum | BSC | Source |
|---|---|---|---|---|
| SAHARA token | OZ v5 ERC20+Pausable+Permit+Ownable | 0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111 | same | [Sourcify 1](https://repo.sourcify.dev/1/0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111), [Sourcify 56](https://repo.sourcify.dev/56/0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111) |
| Pool | LockReleaseTokenPool 1.6.3-dev | 0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4 | same (bytecode = ETH) | [Sourcify 1](https://repo.sourcify.dev/1/0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4) |
| TokenAdminRegistry | 1.5.0 | 0xb22764f98dD05c789929716D677382Df22C05Cb6 | 0x736Fd8660c443547a85e4Eaf70A49C1b7Bb008fc | Sourcify 1 / 56 |
| Router | Router 1.2.0 | 0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D | 0x34B03Cb9086d7D758AC55af71584F81A598759FE | Sourcify 1 / 56 |
| OnRamp (current) | OnRamp 2.0.0 | 0xc3423F3FB30857D9C14717b119884b1B63d250b7 | 0x84a0797B31Ac0d3E1D06157663dd4b18cFFdA188 | [Etherscan](https://etherscan.io/address/0xc3423F3FB30857D9C14717b119884b1B63d250b7#code), [tag v2.0.0](https://github.com/smartcontractkit/chainlink-ccip/blob/contracts-ccip-v2.0.0/chains/evm/contracts/onRamp/OnRamp.sol) |
| OffRamp (current) | OffRamp 2.0.0 | 0x408428bca0e24A25ac8baAc1b70f64AF257717c3 | 0x4914044f8d787bd5DC7528f00775D850dC54477e | [Sourcify 1](https://repo.sourcify.dev/1/0x408428bca0e24A25ac8baAc1b70f64AF257717c3) |
| OnRamp (pre-2.0) | EVM2EVMOnRamp 1.5.0 | 0x948306C220Ac325fa9392A6E601042A3CD0b480d | 0x35C724666ba31632A56Bad4390eb69f206ab60C7 | Sourcify 1 / 56 |
| OffRamp (pre-2.0) | EVM2EVMOffRamp 1.5.0 | 0x66d84fedED0e51aeB47ceD1BB2fc0221Ae8D7C12 | 0xF616733641D420207b8F30db9C4cE39684768991 | Sourcify 1 / 56 |
| OnRamp (legacy) | EVM2EVMOnRamp 1.2.0 | 0x91D25A56Db77aD5147437d8B83Eb563D46eBFa69 | 0x0Bf40b034872D0b364f3DCec04C7434a4Da1C8d9 | Sourcify 1 / 56 |
| OffRamp (legacy) | EVM2EVMOffRamp 1.2.0 | 0x7Afe7088aff57173565F4b034167643AA8b9171c | 0x181Bb1E97b0bDD1D85E741ad0943552D3682cc35 | Sourcify 1 / 56 |

The pre-2.0 and legacy ramps were found from the `getStaticConfig()` of the OffRamps that the Router still authorises.
EVM2EVMOffRamp 1.2.0 cannot release SAHARA, because `getPoolBySourceToken(SAHARA)` reverts with
`UnsupportedToken(0xFDFf…)`.

## Events

| Contract | Event (verified signature) | topic0 | Sample tx (chain, block) |
|---|---|---|---|
| OnRamp 2.0.0 | `CCIPMessageSent(uint64 indexed destChainSelector, address indexed sender, bytes32 indexed messageId, address feeToken, uint256 tokenAmountBeforeTokenPoolFees, bytes encodedMessage, (address issuer, uint32 destGasLimit, uint32 destBytesOverhead, uint256 feeTokenAmount, bytes extraArgs)[] receipts, bytes[] verifierBlobs)` | 0x371bc2ff0a006f4ef863b1d27a065d4e9f938b6d883eb154572b4aea593b32cc | ETH 0xa2369c2c9f81061bf215b6e36911d6a5404283f982f18c8f4c57ab53a2322c0e (26220231); BSC 0x805f791df8627ef8328abf8b546290a10c32b1e6c48e362c93805d3bef5ee1c6 (125558398) |
| EVM2EVMOnRamp 1.5.0 / 1.2.0 | `CCIPSendRequested((uint64 sourceChainSelector, address sender, address receiver, uint64 sequenceNumber, uint256 gasLimit, bool strict, uint64 nonce, address feeToken, uint256 feeTokenAmount, bytes data, (address token, uint256 amount)[] tokenAmounts, bytes[] sourceTokenData, bytes32 messageId) message)` | 0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd | ETH 0x441aa6fc375c331de3cdfdd8b44a4b0b6c2c93c30e4b5edc41d3f13b3a6bbc9e (25228030); BSC 0x0cbf8dce295f837813f4e9b3d0d93a32c622e149d21a43a299e472f91a970124 (101836592) |
| OffRamp 2.0.0 | `ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed messageNumber, bytes32 indexed messageId, uint8 state, bytes returnData)` | 0x8c324ce1367b83031769f6a813e3bb4c117aba2185789d66b98b791405be6df2 | ETH 0x38159c706218dc3bbda86453dcd2e03f38931f447b0361d33a8af4deb3246eae (26114582); BSC 0xa165c2e36b641bf0fc1d7b943f59e3e481e3363ffacb5d0515d29a5bc4104054 (128385025); FAILURE ETH 0x248a470bc19277268e32b4b471423f509662f54a365c54ebbed2b157ebe546a1 (26049494) |
| EVM2EVMOffRamp 1.5.0 / 1.2.0 | `ExecutionStateChanged(uint64 indexed sequenceNumber, bytes32 indexed messageId, uint8 state, bytes returnData)` | 0xd4f851956a5d67c3997d1c9205045fef79bae2947fdee7e9e2641abc7391ef65 | ETH 0x7f678ea2bd9a465e4fbc91847d04d5dc35c7ef0aef26b90aa0f33ea686d641a2 (25228052); BSC 0xcc209b995fa3830d8042d82c0e691094e3c9e39eb9b74380d82431bcdca36701 (101838270, batch of 3) |
| Pool | `LockedOrBurned(uint64 indexed remoteChainSelector, address token, address sender, uint256 amount)` | 0xf33bc26b4413b0e7f19f1ea739fdf99098c0061f1f87d954b11f5293fad9ae10 | ETH 0x441aa6fc…bc9e (25228030); BSC 0x805f791d…e1c6 |
| Pool | `ReleasedOrMinted(uint64 indexed remoteChainSelector, address token, address sender, address recipient, uint256 amount)` | 0xfc5e3a5bddc11d92c2dc20fae6f7d5eb989f056be35239f7de7e86150609abc0 | ETH 0x7f678ea2…41a2 (25228052); BSC 0xa165c2e3…4054 |
| Pool | `OutboundRateLimitConsumed(uint64 indexed remoteChainSelector, address token, uint256 amount)` | 0xff0133389f9bb82d5b9385826160eaf2328039f6fa950eeb8cf0836da8178944 | ETH 0x441aa6fc…bc9e |
| Pool | `InboundRateLimitConsumed(uint64 indexed remoteChainSelector, address token, uint256 amount)` | 0x50f6fbee3ceedce6b7fd7eaef18244487867e6718aec7208187efb6b7908c14c | ETH 0x7f678ea2…41a2 |
| Pool | `LiquidityAdded(address indexed provider, uint256 indexed amount)` | 0xc17cea59c2955cb181b03393209566960365771dbba9dc3d510180e7cb312088 | ETH 0xccafffeca2c7704f7329bab1696a32cbcd57d0356c367356b82b41f8ad4a3e50 (25227556) |
| Pool | `LiquidityRemoved(address indexed provider, uint256 indexed amount)` | 0xc2c3f06e49b9f15e7b4af9055e183b0d73362e033ad82a07dec9bf9840171719 | not emitted yet (verified ABI only) |
| Pool | `LiquidityTransferred(address indexed from, uint256 amount)` | 0x6fa7abcf1345d1d478e5ea0da6b5f26a90eadb0546ef15ed3833944fbfd1db62 | not emitted yet |
| Pool | `RebalancerSet(address oldRebalancer, address newRebalancer)` | 0x64187bd7b97e66658c91904f3021d7c28de967281d18b1a20742348afdd6a6b3 | ETH 0x08605aedce80a9f92dd2a8e6d82446ecba50333cacaf6659d562acab771d938f (25227504) |
| Pool | `RateLimitAdminSet(address rateLimitAdmin)` | 0x44676b5284b809a22248eba0da87391d79098be38bb03154be88a58bf4d09174 | ETH 0x1c84127170cc1250a3e22a7643a3a8345823a83bffab3cd119e9aae3ea44523a (25227588) |
| Pool | `RouterUpdated(address oldRouter, address newRouter)` | 0x02dc5c233404867c793b749c6d644beb2277536d18a7e7974d3f238e4c6f1684 | not emitted yet |
| Pool | `ChainAdded(uint64 remoteChainSelector, bytes remoteToken, (bool,uint128,uint128) outboundRateLimiterConfig, (bool,uint128,uint128) inboundRateLimiterConfig)` | 0x8d340f17e19058004c20453540862a9c62778504476f6756755cb33bcd6c38c2 | ETH 0x2e22453505b98bf22070f758cd1d92e443808875e30a08423e6046997ccd24b9 (25227423) |
| Pool | `ChainConfigured(uint64 remoteChainSelector, (bool,uint128,uint128) outboundRateLimiterConfig, (bool,uint128,uint128) inboundRateLimiterConfig)` | 0x0350d63aa5f270e01729d00d627eeb8f3429772b1818c016c66a588a864f912b | not emitted yet |
| Pool | `ChainRemoved(uint64 remoteChainSelector)` | 0x5204aec90a3c794d8e90fded8b46ae9c7c552803e7e832e0c1d358396d859916 | not emitted yet |
| Pool | `RemotePoolAdded(uint64 indexed remoteChainSelector, bytes remotePoolAddress)` | 0x7d628c9a1796743d365ab521a8b2a4686e419b3269919dc9145ea2ce853b54ea | ETH 0x2e224535…24b9 (25227423) |
| Pool | `RemotePoolRemoved(uint64 indexed remoteChainSelector, bytes remotePoolAddress)` | 0x52d00ee4d9bd51b40168f2afc5848837288ce258784ad914278791464b3f4d76 | not emitted yet |
| Pool | `AllowListAdd(address sender)` / `AllowListRemove(address sender)` | 0x2640d4d76caf8bf478aabfa982fa4e1c4eb71a37f93cd15e80dbc657911546d8 / 0x800671136ab6cfee9fbe5ed1fb7ca417811aca3cf864800d127b927adedf7566 | not emitted yet |
| Pool (RateLimiter lib) | `ConfigChanged((bool isEnabled, uint128 capacity, uint128 rate) config)` | 0x9ea3374b67bf275e6bb9c8ae68f9cae023e1c528b4b27e092f0bb209d3531c19 | not emitted yet (twice per rate-limit change, before ChainConfigured) |
| Pool / Router / Registry (Chainlink Ownable2Step) | `OwnershipTransferRequested(address indexed from, address indexed to)` | 0xed8889f560326eb138920d842192f0eb3dd22b4f139c87a2c57538e05bae1278 | ETH pool 0x3270dfb3499cac5171d3280b9772110a28a4651062e5e2bcd350f2b2a390a545 (25228219) |
| Pool / Router / Registry / token | `OwnershipTransferred(address indexed from, address indexed to)` (token: `previousOwner`, `newOwner`) | 0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0 | ETH pool 0x048e9fcefa073981a7574e51edce986d51a382d51e6774a4528ff6b6f8719333 (25228279) |
| TokenAdminRegistry | `PoolSet(address indexed token, address indexed previousPool, address indexed newPool)` | 0x754449ec3aff3bd528bfce43ae9319c4a381b67fcd1d20097b3b24dacaecc35d | ETH 0x008d83db986435e8ab3d39c3110e42d0fa048688decf886db640d6adb87af911 (25227904) |
| TokenAdminRegistry | `AdministratorTransferRequested(address indexed token, address indexed currentAdmin, address indexed newAdmin)` | 0xc54c3051ff16e63bb9203214432372aca006c589e3653619b577a3265675b716 | ETH 0x54fef62f4a472dd94c959c5a7a8f47e53e0aa55689df62ac029d5d11c8b56dc3 (25225050) |
| TokenAdminRegistry | `AdministratorTransferred(address indexed token, address indexed newAdmin)` | 0x399b55200f7f639a63d76efe3dcfa9156ce367058d6b673041b84a628885f5a7 | ETH 0x4c13c39276c612f0e8e564beacd0b8a544c63343f159f1d65c216fd2b9e224f8 (25227852) |
| Router 1.2.0 | `OnRampSet(uint64 indexed destChainSelector, address onRamp)` | 0x1f7d0ec248b80e5c0dde0ee531c4fc8fdb6ce9a2b3d90f560c74acd6a7202f23 | verified ABI |
| Router 1.2.0 | `OffRampAdded(uint64 indexed sourceChainSelector, address offRamp)` | 0xa4bdf64ebdf3316320601a081916a75aa144bcef6c4beeb0e9fb1982cacc6b94 | verified ABI |
| Router 1.2.0 | `OffRampRemoved(uint64 indexed sourceChainSelector, address offRamp)` | 0xa823809efda3ba66c873364eec120fa0923d9fabda73bc97dd5663341e2d9bcb | verified ABI |
| Router 1.2.0 | `MessageExecuted(bytes32 messageId, uint64 sourceChainSelector, address offRamp, bytes32 calldataHash)` | 0x9b877de93ea9895756e337442c657f95a34fc68e7eb988bdfa693d5be83016b6 | BSC 0xcc209b99…6701 (other tokens' messages only; never for token-only transfers) |
| SAHARA token | `Transfer(address indexed from, address indexed to, uint256 value)` | 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef | every sample above |
| SAHARA token | `Approval(address indexed owner, address indexed spender, uint256 value)` | 0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925 | ETH 0x6687937aebda1d7e60666a2d7718d5b4110bf44645888fd66c0b62d746d25bfc |
| SAHARA token | `Paused(address account)` / `Unpaused(address account)` | 0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258 / 0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa | verified ABI |

### Removed from the scaffold

The scaffold declared `Locked(address indexed sender, uint256 amount)` (0x9f1ec8c8…) and
`Released(address indexed sender, address indexed recipient, uint256 amount)` (0x2d87480f…). These are the pre-1.5
pool events, and the 1.6.3-dev pool never emits them. They are replaced by `LockedOrBurned`, `ReleasedOrMinted` and the
two `*RateLimitConsumed` events.

## MessageExecutionState

`Internal.MessageExecutionState` is defined the same way in the 1.2.0, 1.5.0 and 2.0.0 libraries:
`UNTOUCHED = 0`, `IN_PROGRESS = 1`, `SUCCESS = 2`, `FAILURE = 3`.

## Log order in real receipts

### Source transaction

The order is:

1. SAHARA `Transfer(from = Router caller, to = pool)`. The Router 1.2.0 pulls the tokens straight into the pool.
2. Fee-token transfers, which may come before or after step 1.
3. Pool `OutboundRateLimitConsumed(remote)`.
4. Pool `LockedOrBurned(remote, token, sender = OnRamp, amount)`.
5. The OnRamp send event.

On OnRamp 2.0.0, `CCIPMessageSent.sender` (topic2) is the Router caller, which is the `from` of the Transfer into the
pool. For EVM2EVM, this is `message.sender`.

### Destination transaction

The order is:

1. Pool `InboundRateLimitConsumed(remote)`.
2. SAHARA `Transfer(pool → receiver)`.
3. Pool `ReleasedOrMinted(remote, token, sender = OffRamp, recipient, amount)`.
4. The OffRamp `ExecutionStateChanged` of the same message.

The pool logs belong to the **next** `ExecutionStateChanged` in the transaction. EVM2EVMOffRamp 1.5.0 batches several
messages into one transaction; for example, BSC 0xcc209b99 contains sequence numbers 22377, 22378 and 22379, and only
22379 is SAHARA.

A FAILURE emits only the `ExecutionStateChanged` log, because the token release reverted. Its `returnData` is truncated
to 132 bytes. On OffRamp 2.0.0, `TokenHandlingError(address target, bytes err)` is therefore always cut inside `err`.
`describeExecutionError` recovers the target and the name of the inner error.

## Lane history (Ethereum pool, Blockscout logs)

- **Ethereum releases.** There were 604 `ReleasedOrMinted` events between blocks 25228052 and 26114582. 603 came from
  EVM2EVMOffRamp 1.5.0 and 1 came from OffRamp 2.0.0 (block 26114582).
- **Ethereum locks.** There were 16 `LockedOrBurned` events:
  - blocks 25228030 to 25604051: through EVM2EVMOnRamp 1.5.0;
  - from 26067166 onwards: through OnRamp 2.0.0.
- **BSC.** Both kinds of execution were seen in samples: OffRamp 2.0.0 (0xa165c2e3, 0xdd0e05f1) and 1.5.0 (0xcc209b99,
  0x85f8718a). BSC history was not scanned exhaustively.
- **Failures on the BSC → Ethereum lane** (OffRamp 2.0.0 on Ethereum): 1,853 executions were scanned up to block
  26287635. There were 5 FAILUREs, all for other tokens:
  - 0xd5864a73… (number 319) was retried to SUCCESS in 0xe32a4cd4….
  - 0x87128c53… (number 89) was still FAILURE on 2026-10-28.

  No SAHARA execution failure was found.
