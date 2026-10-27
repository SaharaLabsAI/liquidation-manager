// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";

/// @notice `LockReleaseTokenPool 1.6.3-dev` replica whose `provideLiquidity` misbehaves in a test-selected way. Every
/// view the Manager verifies is the honest replica's, so the pool passes registration and the pre-funding checks.
contract MaliciousPool is MockLockReleaseTokenPool {
  using SafeERC20 for IERC20;

  enum Mode {
    Honest, // pulls exactly `amount` from the rebalancer
    PullLess, // pulls `amount - delta`
    PullMore, // pulls `amount + delta` from the rebalancer
    PullNothing, // pulls nothing
    PullAndDivert, // pulls `amount`, then forwards `delta` of its inventory to `sink`
    PullToSink, // transferFrom(rebalancer, sink, amount): the pool itself receives nothing
    PullPlusSidecar, // pulls `amount` from the rebalancer and `delta` from `sink` (pre-approved)
    ReenterFund, // calls `fund` on the Manager
    ReenterRecall // calls `recall` on the Manager

  }

  Mode public mode;
  uint256 public delta;
  address public sink;
  ILiquidityManager public reentryManager;
  uint256 public reentryAdapterId;

  constructor(address token, address router) MockLockReleaseTokenPool(token, router) {}

  function setMode(Mode newMode, uint256 newDelta, address newSink) external {
    mode = newMode;
    delta = newDelta;
    sink = newSink;
  }

  function setReentry(ILiquidityManager manager, uint256 adapterId) external {
    reentryManager = manager;
    reentryAdapterId = adapterId;
  }

  function provideLiquidity(uint256 amount) external override {
    if (s_rebalancer != msg.sender) revert Unauthorized(msg.sender);
    Mode m = mode;
    if (m == Mode.Honest) {
      i_token.safeTransferFrom(msg.sender, address(this), amount);
    } else if (m == Mode.PullLess) {
      i_token.safeTransferFrom(msg.sender, address(this), amount - delta);
    } else if (m == Mode.PullMore) {
      i_token.safeTransferFrom(msg.sender, address(this), amount + delta);
    } else if (m == Mode.PullNothing) {
      // Leaves the tokens with the rebalancer.
    } else if (m == Mode.PullAndDivert) {
      i_token.safeTransferFrom(msg.sender, address(this), amount);
      i_token.safeTransfer(sink, delta);
    } else if (m == Mode.PullToSink) {
      i_token.safeTransferFrom(msg.sender, sink, amount);
    } else if (m == Mode.PullPlusSidecar) {
      i_token.safeTransferFrom(msg.sender, address(this), amount);
      i_token.safeTransferFrom(sink, address(this), delta);
    } else if (m == Mode.ReenterFund) {
      reentryManager.fund(reentryAdapterId, amount);
    } else {
      reentryManager.recall(reentryAdapterId, amount);
    }
    emit LiquidityAdded(msg.sender, amount);
  }
}
