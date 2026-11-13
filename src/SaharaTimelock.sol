// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title SaharaTimelock
/// @notice OpenZeppelin `TimelockController` with a bounded delay, explicit executors and additional cancellers.
/// - The Timelock administers itself (no admin account). Delay changes go through `updateDelay`, which is itself
///   timelocked, and must stay within [`MINIMUM_DELAY`, `MAXIMUM_DELAY`].
/// - Proposers (the Governance Safe) keep the CANCELLER_ROLE OpenZeppelin grants them, so governance can withdraw its
///   own proposals. `cancellers` (the GuardianController) are granted CANCELLER_ROLE in addition.
/// - Executors must be explicit accounts; open execution (address(0)) is rejected. Every proposer must also be an
///   executor, so governance can always execute its own operations, including a Guardian removal.
/// @custom:security-contact security@saharalabs.ai
contract SaharaTimelock is TimelockController {
  error InvalidDelayBounds(uint256 minimumDelay, uint256 maximumDelay);
  error DelayOutOfBounds(uint256 delay, uint256 minimumDelay, uint256 maximumDelay);
  error InvalidProposers();
  error InvalidExecutors();
  error ProposerMustBeExecutor(address proposer);
  error ZeroAddress();

  /// @notice Hard cap on `MAXIMUM_DELAY`.
  uint256 public constant MAXIMUM_DELAY_CAP = 90 days;

  /// @notice Lowest delay `updateDelay` accepts.
  uint256 public immutable MINIMUM_DELAY;
  /// @notice Highest delay `updateDelay` accepts, so a mistaken update cannot freeze the Timelock.
  uint256 public immutable MAXIMUM_DELAY;

  uint256 private s_delay;

  /// @param minDelay Initial delay, within [`minimumDelay`, `maximumDelay`].
  /// @param minimumDelay Immutable lower bound on the delay; must be non-zero.
  /// @param maximumDelay Immutable upper bound on the delay, at most `MAXIMUM_DELAY_CAP`.
  /// @param proposers Accounts granted PROPOSER_ROLE and CANCELLER_ROLE (the Governance Safe); non-empty, and each
  /// must also be listed in `executors`.
  /// @param executors Accounts granted EXECUTOR_ROLE; non-empty, no address(0).
  /// @param cancellers Accounts additionally granted CANCELLER_ROLE (the GuardianController).
  constructor(
    uint256 minDelay,
    uint256 minimumDelay,
    uint256 maximumDelay,
    address[] memory proposers,
    address[] memory executors,
    address[] memory cancellers
  ) TimelockController(minDelay, proposers, executors, address(0)) {
    if (minimumDelay == 0 || minimumDelay > maximumDelay || maximumDelay > MAXIMUM_DELAY_CAP) {
      revert InvalidDelayBounds(minimumDelay, maximumDelay);
    }
    if (minDelay < minimumDelay || minDelay > maximumDelay) {
      revert DelayOutOfBounds(minDelay, minimumDelay, maximumDelay);
    }
    if (executors.length == 0) revert InvalidExecutors();
    for (uint256 i = 0; i < executors.length; ++i) {
      if (executors[i] == address(0)) revert InvalidExecutors();
    }
    if (proposers.length == 0) revert InvalidProposers();
    for (uint256 i = 0; i < proposers.length; ++i) {
      if (proposers[i] == address(0)) revert ZeroAddress();
      if (!hasRole(EXECUTOR_ROLE, proposers[i])) revert ProposerMustBeExecutor(proposers[i]);
    }
    for (uint256 i = 0; i < cancellers.length; ++i) {
      if (cancellers[i] == address(0)) revert ZeroAddress();
      _grantRole(CANCELLER_ROLE, cancellers[i]);
    }
    MINIMUM_DELAY = minimumDelay;
    MAXIMUM_DELAY = maximumDelay;
    s_delay = minDelay;
  }

  /// @notice The delay operations must be scheduled with.
  function getMinDelay() public view override returns (uint256) {
    return s_delay;
  }

  /// @notice Changes the delay. Only callable by the Timelock itself, i.e. through a scheduled operation that waits the
  /// current delay.
  function updateDelay(uint256 newDelay) external override {
    if (msg.sender != address(this)) revert TimelockUnauthorizedCaller(msg.sender);
    if (newDelay < MINIMUM_DELAY || newDelay > MAXIMUM_DELAY) {
      revert DelayOutOfBounds(newDelay, MINIMUM_DELAY, MAXIMUM_DELAY);
    }
    emit MinDelayChange(s_delay, newDelay);
    s_delay = newDelay;
  }
}
