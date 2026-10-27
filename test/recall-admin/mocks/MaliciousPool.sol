// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";

/// @notice LockReleaseTokenPool replica whose `withdrawLiquidity` can misbehave. Everything else (configuration views,
/// rebalancer gate, `provideLiquidity`) is inherited unchanged, so it passes the Manager's registration checks.
contract MaliciousPool is MockLockReleaseTokenPool {
  using SafeERC20 for IERC20;

  enum Mode {
    Honest, // pays exactly `amount` to the rebalancer
    PayLess, // pays `amount - delta` to the rebalancer
    PayMore, // pays `amount + delta` to the rebalancer
    PayOther, // pays `amount` to `sink` instead of the rebalancer
    PayNothing, // pays nothing
    ReenterRecall, // calls `recall` on the Manager
    ReenterFund // calls `fund` on the Manager

  }

  Mode public mode;
  uint256 public delta;
  address public sink;
  ILiquidityManager public reentryManager;
  uint256 public reentryAdapterId;

  constructor(address token, address router) MockLockReleaseTokenPool(token, router) {}

  function configure(Mode mode_, uint256 delta_, address sink_) external {
    mode = mode_;
    delta = delta_;
    sink = sink_;
  }

  function configureReentry(ILiquidityManager manager, uint256 adapterId) external {
    reentryManager = manager;
    reentryAdapterId = adapterId;
  }

  function withdrawLiquidity(uint256 amount) external override {
    if (s_rebalancer != msg.sender) revert Unauthorized(msg.sender);
    if (mode == Mode.Honest) {
      i_token.safeTransfer(msg.sender, amount);
    } else if (mode == Mode.PayLess) {
      i_token.safeTransfer(msg.sender, amount - delta);
    } else if (mode == Mode.PayMore) {
      i_token.safeTransfer(msg.sender, amount + delta);
    } else if (mode == Mode.PayOther) {
      i_token.safeTransfer(sink, amount);
    } else if (mode == Mode.PayNothing) {
      // nothing
    } else if (mode == Mode.ReenterRecall) {
      reentryManager.recall(reentryAdapterId, amount);
    } else if (mode == Mode.ReenterFund) {
      reentryManager.fund(reentryAdapterId, amount);
    }
  }
}
