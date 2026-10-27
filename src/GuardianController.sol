// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ILiquidityManager} from "./interfaces/ILiquidityManager.sol";
import {ILockReleaseTokenPool} from "./interfaces/ILockReleaseTokenPool.sol";

/// @title GuardianController
/// @notice Restricted controller through which the current Guardian (as recorded by the `LiquidityManager`) cancels
/// Timelock proposals and locks down the CCIP pool's rate limits.
/// - Holds the Timelock's CANCELLER_ROLE. Every proposal is cancellable except a standalone `setGuardian` call on the
///   Manager, so the Guardian cannot cancel its own removal or replacement.
/// - Holds the pool's rateLimitAdmin. It can only set both buckets of every supported chain to enabled with zero
///   capacity and zero refill; restoring them requires the pool owner (the Timelock).
/// @dev Non-upgradeable and ownerless. Removing or replacing the Guardian on the Manager revokes its authority here.
contract GuardianController {
  error CallerNotGuardian(address caller);
  error ProtectedOperation(bytes32 id);
  error PoolNotRecognized(address pool);
  error PoolHasNoChains(address pool);
  error ZeroAddress();

  event ProposalCancelled(bytes32 indexed id, address indexed guardian);
  event PoolLockedDown(address indexed pool, uint64 indexed remoteChainSelector, address indexed guardian);

  ILiquidityManager public immutable MANAGER;
  TimelockController public immutable TIMELOCK;

  modifier onlyGuardian() {
    if (msg.sender != MANAGER.guardian()) revert CallerNotGuardian(msg.sender);
    _;
  }

  constructor(ILiquidityManager manager, TimelockController timelock) {
    if (address(manager) == address(0) || address(timelock) == address(0)) revert ZeroAddress();
    MANAGER = manager;
    TIMELOCK = timelock;
  }

  /// @notice Cancels a pending operation scheduled with `TimelockController.schedule`.
  /// @dev The id is recomputed from the full operation, so the target, value, calldata, predecessor and salt are all
  /// bound to it.
  function cancel(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt)
    external
    onlyGuardian
  {
    bytes32 id = TIMELOCK.hashOperation(target, value, data, predecessor, salt);
    if (isProtectedCall(target, value, data)) revert ProtectedOperation(id);
    TIMELOCK.cancel(id);
    emit ProposalCancelled(id, msg.sender);
  }

  /// @notice Cancels a pending operation scheduled with `TimelockController.scheduleBatch`.
  /// @dev Only a batch consisting of exactly one protected call is protected; mixed batches remain cancellable.
  function cancelBatch(
    address[] calldata targets,
    uint256[] calldata values,
    bytes[] calldata payloads,
    bytes32 predecessor,
    bytes32 salt
  ) external onlyGuardian {
    bytes32 id = TIMELOCK.hashOperationBatch(targets, values, payloads, predecessor, salt);
    if (
      targets.length == 1 && values.length == 1 && payloads.length == 1
        && isProtectedCall(targets[0], values[0], payloads[0])
    ) revert ProtectedOperation(id);
    TIMELOCK.cancel(id);
    emit ProposalCancelled(id, msg.sender);
  }

  /// @notice Sets both rate limit buckets of every chain supported by `pool` to enabled, zero capacity and zero
  /// refill, halting bridge transfers through it.
  /// @param pool A pool registered in the Manager, or the pool the TokenAdminRegistry currently maps the token to.
  function lockdown(address pool) external onlyGuardian {
    if (
      pool == address(0)
        || (MANAGER.adapterIdByPool(pool) == 0 && MANAGER.TOKEN_ADMIN_REGISTRY().getPool(MANAGER.TOKEN()) != pool)
    ) revert PoolNotRecognized(pool);

    uint64[] memory chains = ILockReleaseTokenPool(pool).getSupportedChains();
    if (chains.length == 0) revert PoolHasNoChains(pool);

    ILockReleaseTokenPool.RateLimiterConfig memory zero =
      ILockReleaseTokenPool.RateLimiterConfig({isEnabled: true, capacity: 0, rate: 0});
    for (uint256 i = 0; i < chains.length; ++i) {
      ILockReleaseTokenPool(pool).setChainRateLimiterConfig(chains[i], zero, zero);
      emit PoolLockedDown(pool, chains[i], msg.sender);
    }
  }

  /// @notice Whether a call is the Guardian removal or replacement the Guardian may not cancel:
  /// `MANAGER.setGuardian(address)` with zero value and exactly one well-formed address argument.
  function isProtectedCall(address target, uint256 value, bytes calldata data) public view returns (bool) {
    if (target != address(MANAGER) || value != 0 || data.length != 36) return false;
    if (bytes4(data[:4]) != ILiquidityManager.setGuardian.selector) return false;
    return uint256(bytes32(data[4:36])) >> 160 == 0;
  }
}
