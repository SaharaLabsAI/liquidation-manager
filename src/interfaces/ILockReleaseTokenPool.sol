// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface of the Chainlink CCIP `LockReleaseTokenPool` used by the liquidity contracts.
/// @dev Signatures are copied from the verified source of the deployed SAHARA pool
/// (`LockReleaseTokenPool 1.6.3-dev`, 0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4 on Ethereum and BSC).
interface ILockReleaseTokenPool {
  /// @notice Mirrors `RateLimiter.Config` of the pool.
  struct RateLimiterConfig {
    bool isEnabled;
    uint128 capacity;
    uint128 rate;
  }

  // ---------------------------------------------------------------- liquidity

  /// @notice Pulls `amount` from the rebalancer (msg.sender) with `transferFrom`. Only callable by the rebalancer.
  function provideLiquidity(uint256 amount) external;

  /// @notice Pays `amount` to the rebalancer (msg.sender). Only callable by the rebalancer.
  function withdrawLiquidity(uint256 amount) external;

  function getRebalancer() external view returns (address);

  // ---------------------------------------------------------------- configuration

  function typeAndVersion() external view returns (string memory);

  function getToken() external view returns (address);

  function getRouter() external view returns (address);

  function owner() external view returns (address);

  function getRateLimitAdmin() external view returns (address);

  function getSupportedChains() external view returns (uint64[] memory);

  function isSupportedChain(uint64 remoteChainSelector) external view returns (bool);

  function getRemoteToken(uint64 remoteChainSelector) external view returns (bytes memory);

  function getRemotePools(uint64 remoteChainSelector) external view returns (bytes[] memory);

  function isRemotePool(uint64 remoteChainSelector, bytes memory remotePoolAddress) external view returns (bool);

  // ---------------------------------------------------------------- rate limits

  /// @notice Callable by the pool owner or the rate limit admin.
  function setChainRateLimiterConfig(
    uint64 remoteChainSelector,
    RateLimiterConfig memory outboundConfig,
    RateLimiterConfig memory inboundConfig
  ) external;
}
