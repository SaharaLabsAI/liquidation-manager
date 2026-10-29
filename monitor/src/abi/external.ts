// ABIs of the deployed contracts this repository does not build: the CCIP LockReleaseTokenPool (1.6.3-dev), the CCIP
// TokenAdminRegistry (1.5.0), the CCIP Router (1.2.0) and the SAHARA token (OZ v5 ERC20 + Pausable + Permit + Ownable).
// VERIFIED (2026-10-28) against the verified sources on Sourcify (pool, registry, router, token on Ethereum; registry,
// router, token on BSC) and real receipts on both chains. The BSC pool is not on Sourcify; its runtime bytecode equals
// the verified Ethereum pool except for immutables. Every event below exists in the verified ABI and its topic0 was
// checked against real logs where the event has fired (see src/abi/VERIFICATION.md). CCIP ramp ABIs: src/abi/ccip.ts.
import {parseAbi} from "viem";

export const tokenPoolAbi = parseAbi([
  // RateLimiter.Config / RateLimiter.TokenBucket
  "struct RateLimiterConfig { bool isEnabled; uint128 capacity; uint128 rate; }",
  "struct RateLimiterTokenBucket { uint128 tokens; uint32 lastUpdated; bool isEnabled; uint128 capacity; uint128 rate; }",

  // views
  "function typeAndVersion() view returns (string)",
  "function owner() view returns (address)",
  "function getToken() view returns (address)",
  "function getTokenDecimals() view returns (uint8)",
  "function isSupportedToken(address token) view returns (bool)",
  "function supportsInterface(bytes4 interfaceId) pure returns (bool)",
  "function getRouter() view returns (address)",
  "function getRebalancer() view returns (address)",
  "function getRateLimitAdmin() view returns (address)",
  "function getSupportedChains() view returns (uint64[])",
  "function isSupportedChain(uint64 remoteChainSelector) view returns (bool)",
  "function getRemoteToken(uint64 remoteChainSelector) view returns (bytes)",
  "function getRemotePools(uint64 remoteChainSelector) view returns (bytes[])",
  "function isRemotePool(uint64 remoteChainSelector, bytes remotePoolAddress) view returns (bool)",
  "function getCurrentOutboundRateLimiterState(uint64 remoteChainSelector) view returns (RateLimiterTokenBucket)",
  "function getCurrentInboundRateLimiterState(uint64 remoteChainSelector) view returns (RateLimiterTokenBucket)",
  "function getAllowListEnabled() view returns (bool)",
  "function getAllowList() view returns (address[])",
  "function getRmnProxy() view returns (address)",

  // owner / admin functions (decoded when scheduled on the Timelock)
  "function transferOwnership(address to)",
  "function acceptOwnership()",
  "function setRebalancer(address rebalancer)",
  "function setRateLimitAdmin(address rateLimitAdmin)",
  "function setRouter(address newRouter)",
  "function addRemotePool(uint64 remoteChainSelector, bytes remotePoolAddress)",
  "function removeRemotePool(uint64 remoteChainSelector, bytes remotePoolAddress)",
  "struct ChainUpdate { uint64 remoteChainSelector; bytes[] remotePoolAddresses; bytes remoteTokenAddress; RateLimiterConfig outboundRateLimiterConfig; RateLimiterConfig inboundRateLimiterConfig; }",
  "function applyChainUpdates(uint64[] remoteChainSelectorsToRemove, ChainUpdate[] chainsToAdd)",
  "function setChainRateLimiterConfig(uint64 remoteChainSelector, RateLimiterConfig outboundConfig, RateLimiterConfig inboundConfig)",
  "function setChainRateLimiterConfigs(uint64[] remoteChainSelectors, RateLimiterConfig[] outboundConfigs, RateLimiterConfig[] inboundConfigs)",
  "function applyAllowListUpdates(address[] removes, address[] adds)",
  "function provideLiquidity(uint256 amount)",
  "function withdrawLiquidity(uint256 amount)",
  "function transferLiquidity(address from, uint256 amount)",

  // Bridge legs. `sender` is msg.sender of lockOrBurn/releaseOrMint, i.e. the OnRamp / OffRamp, NOT the user; the user
  // is the `from` of the token Transfer into the pool (source) and `recipient` here (destination). Each is preceded
  // in the same call by the rate-limit event and, for a release, by the token Transfer pool -> recipient.
  "event LockedOrBurned(uint64 indexed remoteChainSelector, address token, address sender, uint256 amount)",
  "event ReleasedOrMinted(uint64 indexed remoteChainSelector, address token, address sender, address recipient, uint256 amount)",
  "event OutboundRateLimitConsumed(uint64 indexed remoteChainSelector, address token, uint256 amount)",
  "event InboundRateLimitConsumed(uint64 indexed remoteChainSelector, address token, uint256 amount)",

  // Liquidity (LockReleaseTokenPool)
  "event LiquidityAdded(address indexed provider, uint256 indexed amount)",
  "event LiquidityRemoved(address indexed provider, uint256 indexed amount)",
  "event LiquidityTransferred(address indexed from, uint256 amount)",
  "event RebalancerSet(address oldRebalancer, address newRebalancer)",

  // Configuration (TokenPool). A rate-limit change (setChainRateLimiterConfig[s]) emits ConfigChanged(outbound),
  // ConfigChanged(inbound), then ChainConfigured; applyChainUpdates emits RemotePoolAdded per pool, then ChainAdded.
  "event RateLimitAdminSet(address rateLimitAdmin)",
  "event RouterUpdated(address oldRouter, address newRouter)",
  "event ChainAdded(uint64 remoteChainSelector, bytes remoteToken, RateLimiterConfig outboundRateLimiterConfig, RateLimiterConfig inboundRateLimiterConfig)",
  "event ChainConfigured(uint64 remoteChainSelector, RateLimiterConfig outboundRateLimiterConfig, RateLimiterConfig inboundRateLimiterConfig)",
  "event ChainRemoved(uint64 remoteChainSelector)",
  "event RemotePoolAdded(uint64 indexed remoteChainSelector, bytes remotePoolAddress)",
  "event RemotePoolRemoved(uint64 indexed remoteChainSelector, bytes remotePoolAddress)",
  "event AllowListAdd(address sender)",
  "event AllowListRemove(address sender)",
  "event ConfigChanged(RateLimiterConfig config)",
  "event OwnershipTransferRequested(address indexed from, address indexed to)",
  "event OwnershipTransferred(address indexed from, address indexed to)",

  // errors (decode revert data, including the inner `err` of an OffRamp TokenHandlingError for this pool)
  "error AllowListNotEnabled()",
  "error BucketOverfilled()",
  "error CallerIsNotARampOnRouter(address caller)",
  "error CannotTransferToSelf()",
  "error ChainAlreadyExists(uint64 chainSelector)",
  "error ChainNotAllowed(uint64 remoteChainSelector)",
  "error CursedByRMN()",
  "error DisabledNonZeroRateLimit(RateLimiterConfig config)",
  "error InsufficientLiquidity()",
  "error InvalidDecimalArgs(uint8 expected, uint8 actual)",
  "error InvalidRateLimitRate(RateLimiterConfig rateLimiterConfig)",
  "error InvalidRemoteChainDecimals(bytes sourcePoolData)",
  "error InvalidRemotePoolForChain(uint64 remoteChainSelector, bytes remotePoolAddress)",
  "error InvalidSourcePoolAddress(bytes sourcePoolAddress)",
  "error InvalidToken(address token)",
  "error MismatchedArrayLengths()",
  "error MustBeProposedOwner()",
  "error NonExistentChain(uint64 remoteChainSelector)",
  "error OnlyCallableByOwner()",
  "error OverflowDetected(uint8 remoteDecimals, uint8 localDecimals, uint256 remoteAmount)",
  "error OwnerCannotBeZero()",
  "error PoolAlreadyAdded(uint64 remoteChainSelector, bytes remotePoolAddress)",
  "error SenderNotAllowed(address sender)",
  "error TokenMaxCapacityExceeded(uint256 capacity, uint256 requested, address tokenAddress)",
  "error TokenRateLimitReached(uint256 minWaitInSeconds, uint256 available, address tokenAddress)",
  "error Unauthorized(address caller)",
  "error ZeroAddressInvalid()",
]);

export const tokenAdminRegistryAbi = parseAbi([
  "struct TokenConfig { address administrator; address pendingAdministrator; address tokenPool; }",
  "function getPool(address token) view returns (address)",
  "function getTokenConfig(address token) view returns (TokenConfig)",
  "function isAdministrator(address localToken, address administrator) view returns (bool)",
  "function typeAndVersion() view returns (string)",
  "function owner() view returns (address)",

  "function setPool(address localToken, address pool)",
  "function transferAdminRole(address localToken, address newAdmin)",
  "function acceptAdminRole(address localToken)",
  // Registry owner / registry modules only (Chainlink); reverts for tokens that already have an administrator.
  "function proposeAdministrator(address localToken, address administrator)",

  "event PoolSet(address indexed token, address indexed previousPool, address indexed newPool)",
  "event AdministratorTransferRequested(address indexed token, address indexed currentAdmin, address indexed newAdmin)",
  "event AdministratorTransferred(address indexed token, address indexed newAdmin)",
]);

export const routerAbi = parseAbi([
  "struct OffRamp { uint64 sourceChainSelector; address offRamp; }",
  "struct OnRamp { uint64 destChainSelector; address onRamp; }",
  "function getOnRamp(uint64 destChainSelector) view returns (address)",
  "function getOffRamps() view returns (OffRamp[])",
  "function isOffRamp(uint64 sourceChainSelector, address offRamp) view returns (bool)",
  "function isChainSupported(uint64 chainSelector) view returns (bool)",
  "function getArmProxy() view returns (address)",
  "function typeAndVersion() view returns (string)",
  "function owner() view returns (address)",

  // Router owner (Chainlink) only.
  "function applyRampUpdates(OnRamp[] onRampUpdates, OffRamp[] offRampRemoves, OffRamp[] offRampAdds)",

  "event OnRampSet(uint64 indexed destChainSelector, address onRamp)",
  "event OffRampAdded(uint64 indexed sourceChainSelector, address offRamp)",
  "event OffRampRemoved(uint64 indexed sourceChainSelector, address offRamp)",
  // Emitted by routeMessage only when the receiver contract is called; token-only transfers (the SAHARA bridge case)
  // never emit it, so it cannot be used to detect deliveries.
  "event MessageExecuted(bytes32 messageId, uint64 sourceChainSelector, address offRamp, bytes32 calldataHash)",
  "event OwnershipTransferRequested(address indexed from, address indexed to)",
  "event OwnershipTransferred(address indexed from, address indexed to)",
]);

export const saharaTokenAbi = parseAbi([
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",

  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function pause()",
  "function unpause()",
  // OZ Ownable (one step): there is no acceptOwnership/pendingOwner on the token.
  "function transferOwnership(address newOwner)",
  "function renounceOwnership()",

  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",

  "error EnforcedPause()",
  "error ExpectedPause()",
  "error OwnableUnauthorizedAccount(address account)",
  "error OwnableInvalidOwner(address owner)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);
