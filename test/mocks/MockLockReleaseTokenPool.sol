// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {ILockReleaseTokenPool} from "../../src/interfaces/ILockReleaseTokenPool.sol";

/// @notice Behavioural replica of the parts of CCIP `LockReleaseTokenPool 1.6.3-dev` the liquidity contracts touch.
/// Liquidity, rebalancer, ownership, remote configuration and rate-limit admin semantics follow the verified source.
contract MockLockReleaseTokenPool is ILockReleaseTokenPool {
  using SafeERC20 for IERC20;
  using EnumerableSet for EnumerableSet.UintSet;
  using EnumerableSet for EnumerableSet.Bytes32Set;

  error Unauthorized(address caller);
  error InsufficientLiquidity();
  error NonExistentChain(uint64 remoteChainSelector);
  error InvalidRateLimitRate(RateLimiterConfig config);
  error DisabledNonZeroRateLimit(RateLimiterConfig config);

  event LiquidityAdded(address indexed provider, uint256 indexed amount);
  event LiquidityRemoved(address indexed provider, uint256 indexed amount);
  event RebalancerSet(address oldRebalancer, address newRebalancer);
  event ChainConfigured(uint64 remoteChainSelector, RateLimiterConfig outboundConfig, RateLimiterConfig inboundConfig);

  IERC20 internal immutable i_token;
  address internal s_owner;
  address internal s_router;
  address internal s_rebalancer;
  address internal s_rateLimitAdmin;
  string internal s_typeAndVersion = "LockReleaseTokenPool 1.6.3-dev";

  EnumerableSet.UintSet internal s_chains;
  mapping(uint64 => bytes) internal s_remoteToken;
  mapping(uint64 => EnumerableSet.Bytes32Set) internal s_remotePoolHashes;
  mapping(bytes32 => bytes) internal s_remotePoolByHash;
  mapping(uint64 => RateLimiterConfig) public outboundConfig;
  mapping(uint64 => RateLimiterConfig) public inboundConfig;

  modifier onlyOwner() {
    if (msg.sender != s_owner) revert Unauthorized(msg.sender);
    _;
  }

  constructor(address token, address router) {
    i_token = IERC20(token);
    s_router = router;
    s_owner = msg.sender;
  }

  // ---------------------------------------------------------------- liquidity (verbatim semantics)

  function provideLiquidity(uint256 amount) external virtual {
    if (s_rebalancer != msg.sender) revert Unauthorized(msg.sender);
    i_token.safeTransferFrom(msg.sender, address(this), amount);
    emit LiquidityAdded(msg.sender, amount);
  }

  function withdrawLiquidity(uint256 amount) external virtual {
    if (s_rebalancer != msg.sender) revert Unauthorized(msg.sender);
    if (i_token.balanceOf(address(this)) < amount) revert InsufficientLiquidity();
    i_token.safeTransfer(msg.sender, amount);
    emit LiquidityRemoved(msg.sender, amount);
  }

  function getRebalancer() external view returns (address) {
    return s_rebalancer;
  }

  function setRebalancer(address rebalancer) external onlyOwner {
    emit RebalancerSet(s_rebalancer, rebalancer);
    s_rebalancer = rebalancer;
  }

  // ---------------------------------------------------------------- user flows (test helpers)

  /// @notice Simulates a CCIP release to `receiver` (bridge outflow).
  function simulateRelease(address receiver, uint256 amount) external {
    i_token.safeTransfer(receiver, amount);
  }

  // ---------------------------------------------------------------- configuration

  function typeAndVersion() external view returns (string memory) {
    return s_typeAndVersion;
  }

  function setTypeAndVersion(string calldata typeAndVersion_) external onlyOwner {
    s_typeAndVersion = typeAndVersion_;
  }

  function getToken() external view returns (address) {
    return address(i_token);
  }

  function getRouter() external view returns (address) {
    return s_router;
  }

  function setRouter(address router) external onlyOwner {
    s_router = router;
  }

  function owner() external view returns (address) {
    return s_owner;
  }

  function transferOwnership(address newOwner) external onlyOwner {
    s_owner = newOwner;
  }

  function getRateLimitAdmin() external view returns (address) {
    return s_rateLimitAdmin;
  }

  function setRateLimitAdmin(address rateLimitAdmin) external onlyOwner {
    s_rateLimitAdmin = rateLimitAdmin;
  }

  function getSupportedChains() external view returns (uint64[] memory chains) {
    uint256[] memory values = s_chains.values();
    chains = new uint64[](values.length);
    for (uint256 i = 0; i < values.length; ++i) {
      chains[i] = uint64(values[i]);
    }
  }

  function isSupportedChain(uint64 remoteChainSelector) public view returns (bool) {
    return s_chains.contains(remoteChainSelector);
  }

  /// @notice Simplified `applyChainUpdates` for one chain.
  function addChain(
    uint64 remoteChainSelector,
    bytes calldata remoteToken,
    bytes calldata remotePool,
    RateLimiterConfig calldata outbound,
    RateLimiterConfig calldata inbound
  ) external onlyOwner {
    s_chains.add(remoteChainSelector);
    s_remoteToken[remoteChainSelector] = remoteToken;
    _addRemotePool(remoteChainSelector, remotePool);
    _setRateLimitConfig(remoteChainSelector, outbound, inbound);
  }

  function removeChain(uint64 remoteChainSelector) external onlyOwner {
    s_chains.remove(remoteChainSelector);
    bytes32[] memory hashes = s_remotePoolHashes[remoteChainSelector].values();
    for (uint256 i = 0; i < hashes.length; ++i) {
      s_remotePoolHashes[remoteChainSelector].remove(hashes[i]);
    }
    delete s_remoteToken[remoteChainSelector];
  }

  function setRemoteToken(uint64 remoteChainSelector, bytes calldata remoteToken) external onlyOwner {
    s_remoteToken[remoteChainSelector] = remoteToken;
  }

  function addRemotePool(uint64 remoteChainSelector, bytes calldata remotePool) external onlyOwner {
    if (!isSupportedChain(remoteChainSelector)) revert NonExistentChain(remoteChainSelector);
    _addRemotePool(remoteChainSelector, remotePool);
  }

  function removeRemotePool(uint64 remoteChainSelector, bytes calldata remotePool) external onlyOwner {
    s_remotePoolHashes[remoteChainSelector].remove(keccak256(remotePool));
  }

  function getRemoteToken(uint64 remoteChainSelector) external view returns (bytes memory) {
    return s_remoteToken[remoteChainSelector];
  }

  function getRemotePools(uint64 remoteChainSelector) external view returns (bytes[] memory pools) {
    bytes32[] memory hashes = s_remotePoolHashes[remoteChainSelector].values();
    pools = new bytes[](hashes.length);
    for (uint256 i = 0; i < hashes.length; ++i) {
      pools[i] = s_remotePoolByHash[hashes[i]];
    }
  }

  function isRemotePool(uint64 remoteChainSelector, bytes memory remotePool) external view returns (bool) {
    return s_remotePoolHashes[remoteChainSelector].contains(keccak256(remotePool));
  }

  // ---------------------------------------------------------------- rate limits

  function setChainRateLimiterConfig(
    uint64 remoteChainSelector,
    RateLimiterConfig memory outbound,
    RateLimiterConfig memory inbound
  ) external {
    if (msg.sender != s_rateLimitAdmin && msg.sender != s_owner) revert Unauthorized(msg.sender);
    _setRateLimitConfig(remoteChainSelector, outbound, inbound);
  }

  function _setRateLimitConfig(
    uint64 remoteChainSelector,
    RateLimiterConfig memory outbound,
    RateLimiterConfig memory inbound
  ) internal {
    if (!isSupportedChain(remoteChainSelector)) revert NonExistentChain(remoteChainSelector);
    _validate(outbound);
    _validate(inbound);
    outboundConfig[remoteChainSelector] = outbound;
    inboundConfig[remoteChainSelector] = inbound;
    emit ChainConfigured(remoteChainSelector, outbound, inbound);
  }

  /// @dev Same rule as RateLimiter 1.6.3-dev: enabled requires rate <= capacity (so 0/0 is allowed), disabled
  /// requires both zero.
  function _validate(RateLimiterConfig memory config) internal pure {
    if (config.isEnabled) {
      if (config.rate > config.capacity) revert InvalidRateLimitRate(config);
    } else if (config.rate != 0 || config.capacity != 0) {
      revert DisabledNonZeroRateLimit(config);
    }
  }

  function _addRemotePool(uint64 remoteChainSelector, bytes memory remotePool) internal {
    bytes32 poolHash = keccak256(remotePool);
    s_remotePoolHashes[remoteChainSelector].add(poolHash);
    s_remotePoolByHash[poolHash] = remotePool;
  }
}
