// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";

/// @notice Parts of the deployed `LockReleaseTokenPool 1.6.3-dev` (TokenPool + Chainlink Ownable2Step + RateLimiter)
/// that `ILockReleaseTokenPool` does not expose. Copied from the verified source; used only by the fork tests.
interface IRealLockReleaseTokenPool {
  // ---------------------------------------------------------------- types (Chainlink layouts)

  /// @dev RateLimiter.TokenBucket, field order as in the deployed library.
  struct TokenBucket {
    uint128 tokens;
    uint32 lastUpdated;
    bool isEnabled;
    uint128 capacity;
    uint128 rate;
  }

  struct ChainUpdate {
    uint64 remoteChainSelector;
    bytes[] remotePoolAddresses;
    bytes remoteTokenAddress;
    ILockReleaseTokenPool.RateLimiterConfig outboundRateLimiterConfig;
    ILockReleaseTokenPool.RateLimiterConfig inboundRateLimiterConfig;
  }

  /// @dev Pool.LockOrBurnInV1.
  struct LockOrBurnInV1 {
    bytes receiver;
    uint64 remoteChainSelector;
    address originalSender;
    uint256 amount;
    address localToken;
  }

  struct LockOrBurnOutV1 {
    bytes destTokenAddress;
    bytes destPoolData;
  }

  /// @dev Pool.ReleaseOrMintInV1.
  struct ReleaseOrMintInV1 {
    bytes originalSender;
    uint64 remoteChainSelector;
    address receiver;
    uint256 sourceDenominatedAmount;
    address localToken;
    bytes sourcePoolAddress;
    bytes sourcePoolData;
    bytes offchainTokenData;
  }

  struct ReleaseOrMintOutV1 {
    uint256 destinationAmount;
  }

  // ---------------------------------------------------------------- errors

  error Unauthorized(address caller);
  error InsufficientLiquidity();
  error NonExistentChain(uint64 remoteChainSelector);
  error ZeroAddressInvalid();
  // Chainlink Ownable2Step
  error OnlyCallableByOwner();
  error MustBeProposedOwner();
  error CannotTransferToSelf();
  // RateLimiter
  error TokenMaxCapacityExceeded(uint256 capacity, uint256 requested, address tokenAddress);
  error TokenRateLimitReached(uint256 minWaitInSeconds, uint256 available, address tokenAddress);
  error InvalidRateLimitRate(ILockReleaseTokenPool.RateLimiterConfig rateLimiterConfig);
  error DisabledNonZeroRateLimit(ILockReleaseTokenPool.RateLimiterConfig config);

  // ---------------------------------------------------------------- events

  event LiquidityAdded(address indexed provider, uint256 indexed amount);
  event LiquidityRemoved(address indexed provider, uint256 indexed amount);
  event RebalancerSet(address oldRebalancer, address newRebalancer);
  event RateLimitAdminSet(address rateLimitAdmin);
  event ChainConfigured(
    uint64 remoteChainSelector,
    ILockReleaseTokenPool.RateLimiterConfig outboundRateLimiterConfig,
    ILockReleaseTokenPool.RateLimiterConfig inboundRateLimiterConfig
  );
  event OwnershipTransferRequested(address indexed from, address indexed to);
  event OwnershipTransferred(address indexed from, address indexed to);

  // ---------------------------------------------------------------- owner / admin

  function setRebalancer(address rebalancer) external;

  function setRateLimitAdmin(address rateLimitAdmin) external;

  function transferOwnership(address to) external;

  function acceptOwnership() external;

  function setRouter(address newRouter) external;

  function addRemotePool(uint64 remoteChainSelector, bytes calldata remotePoolAddress) external;

  function removeRemotePool(uint64 remoteChainSelector, bytes calldata remotePoolAddress) external;

  function applyChainUpdates(uint64[] calldata remoteChainSelectorsToRemove, ChainUpdate[] calldata chainsToAdd)
    external;

  function setChainRateLimiterConfigs(
    uint64[] calldata remoteChainSelectors,
    ILockReleaseTokenPool.RateLimiterConfig[] calldata outboundConfigs,
    ILockReleaseTokenPool.RateLimiterConfig[] calldata inboundConfigs
  ) external;

  function transferLiquidity(address from, uint256 amount) external;

  // ---------------------------------------------------------------- views

  function getCurrentOutboundRateLimiterState(uint64 remoteChainSelector) external view returns (TokenBucket memory);

  function getCurrentInboundRateLimiterState(uint64 remoteChainSelector) external view returns (TokenBucket memory);

  function getRmnProxy() external view returns (address);

  function getTokenDecimals() external view returns (uint8);

  function getAllowListEnabled() external view returns (bool);

  function isSupportedToken(address token) external view returns (bool);

  // ---------------------------------------------------------------- CCIP ramps

  function lockOrBurn(LockOrBurnInV1 calldata lockOrBurnIn) external returns (LockOrBurnOutV1 memory);

  function releaseOrMint(ReleaseOrMintInV1 calldata releaseOrMintIn) external returns (ReleaseOrMintOutV1 memory);
}

/// @notice CCIP `TokenAdminRegistry 1.5.0` administration (verified selectors on both chains).
interface IRealTokenAdminRegistry {
  struct TokenConfig {
    address administrator;
    address pendingAdministrator;
    address tokenPool;
  }

  error OnlyAdministrator(address sender, address token);
  error OnlyPendingAdministrator(address sender, address token);
  error AlreadyRegistered(address token);

  event AdministratorTransferRequested(address indexed token, address indexed currentAdmin, address indexed newAdmin);
  event AdministratorTransferred(address indexed token, address indexed newAdmin);

  function getPool(address token) external view returns (address);

  function getTokenConfig(address token) external view returns (TokenConfig memory);

  function isAdministrator(address localToken, address administrator) external view returns (bool);

  function setPool(address localToken, address pool) external;

  /// @notice Administrator only. Sets `pendingAdministrator` (address(0) withdraws a proposal); nothing else changes
  /// until the proposed administrator accepts.
  function transferAdminRole(address localToken, address newAdmin) external;

  /// @notice Pending administrator only: becomes the administrator and clears `pendingAdministrator`.
  function acceptAdminRole(address localToken) external;

  /// @notice Registry owner / registry modules only; reverts for tokens that already have an administrator.
  function proposeAdministrator(address localToken, address administrator) external;

  function owner() external view returns (address);

  function typeAndVersion() external view returns (string memory);
}

/// @notice CCIP `Router 1.2.0`.
interface IRealRouter {
  struct OffRamp {
    uint64 sourceChainSelector;
    address offRamp;
  }

  function getOnRamp(uint64 destChainSelector) external view returns (address);

  function isOffRamp(uint64 sourceChainSelector, address offRamp) external view returns (bool);

  function getOffRamps() external view returns (OffRamp[] memory);

  function typeAndVersion() external view returns (string memory);
}

/// @notice Deployed SAHARA token: OZ v5 ERC20 + ERC20Pausable + ERC20Permit + Ownable.
interface IRealSahara {
  error EnforcedPause();
  error OwnableUnauthorizedAccount(address account);

  function owner() external view returns (address);

  function transferOwnership(address newOwner) external;

  function pause() external;

  function unpause() external;

  function paused() external view returns (bool);

  function totalSupply() external view returns (uint256);

  function decimals() external view returns (uint8);

  function balanceOf(address account) external view returns (uint256);

  function allowance(address owner, address spender) external view returns (uint256);
}

/// @notice A contract the real TokenAdminRegistry accepts as a SAHARA pool (it only checks `isSupportedToken`). Used
/// to forge a registry mapping away from the real pool.
contract DecoyRegistryPool {
  address public immutable TOKEN;

  constructor(address token) {
    TOKEN = token;
  }

  function isSupportedToken(address token) external view returns (bool) {
    return token == TOKEN;
  }
}
