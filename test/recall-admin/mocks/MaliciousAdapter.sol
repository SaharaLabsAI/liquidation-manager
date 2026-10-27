// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILiquidityAdapter} from "src/interfaces/ILiquidityAdapter.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";

/// @notice Adapter with correct bindings (so it passes registration/replacement checks once it holds the pool's
/// rebalancer role) whose `recall` can misbehave.
contract MaliciousAdapter is ILiquidityAdapter {
  using SafeERC20 for IERC20;

  enum Mode {
    Honest, // withdraws `amount`, forwards `amount`
    Keep, // withdraws `amount`, forwards nothing
    ForwardLess, // withdraws `amount`, forwards `amount - delta`
    ForwardFromFloat, // withdraws nothing, forwards `amount` from its own balance
    Skim, // withdraws `amount + delta`, forwards `amount`, sends `delta` to `sink`
    ForwardExtra, // withdraws `amount + delta`, forwards `amount + delta`
    Reenter, // withdraws and forwards `amount`, then calls `recall` on the Manager again
    Divert // withdraws `amount` and sends it to `sink` instead of the Manager

  }

  address public immutable MANAGER;
  address public immutable TOKEN;
  address public immutable POOL;

  Mode public mode;
  uint256 public delta;
  address public sink;
  uint256 public reentryAdapterId;

  constructor(address manager, address token, address pool) {
    MANAGER = manager;
    TOKEN = token;
    POOL = pool;
  }

  function configure(Mode mode_, uint256 delta_, address sink_) external {
    mode = mode_;
    delta = delta_;
    sink = sink_;
  }

  function configureReentry(uint256 adapterId) external {
    reentryAdapterId = adapterId;
  }

  function fund(uint256 amount) external {
    IERC20(TOKEN).forceApprove(POOL, amount);
    ILockReleaseTokenPool(POOL).provideLiquidity(amount);
    IERC20(TOKEN).forceApprove(POOL, 0);
  }

  function recall(uint256 amount) external {
    IERC20 token = IERC20(TOKEN);
    ILockReleaseTokenPool pool = ILockReleaseTokenPool(POOL);
    if (mode == Mode.Honest) {
      pool.withdrawLiquidity(amount);
      token.safeTransfer(MANAGER, amount);
    } else if (mode == Mode.Keep) {
      pool.withdrawLiquidity(amount);
    } else if (mode == Mode.ForwardLess) {
      pool.withdrawLiquidity(amount);
      token.safeTransfer(MANAGER, amount - delta);
    } else if (mode == Mode.ForwardFromFloat) {
      token.safeTransfer(MANAGER, amount);
    } else if (mode == Mode.Skim) {
      pool.withdrawLiquidity(amount + delta);
      token.safeTransfer(MANAGER, amount);
      token.safeTransfer(sink, delta);
    } else if (mode == Mode.ForwardExtra) {
      pool.withdrawLiquidity(amount + delta);
      token.safeTransfer(MANAGER, amount + delta);
    } else if (mode == Mode.Reenter) {
      pool.withdrawLiquidity(amount);
      token.safeTransfer(MANAGER, amount);
      ILiquidityManager(MANAGER).recall(reentryAdapterId, amount);
    } else if (mode == Mode.Divert) {
      pool.withdrawLiquidity(amount);
      token.safeTransfer(sink, amount);
    }
  }
}
