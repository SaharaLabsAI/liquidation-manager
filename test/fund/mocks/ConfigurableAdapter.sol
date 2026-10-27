// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILiquidityAdapter} from "src/interfaces/ILiquidityAdapter.sol";
import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";

/// @notice Adapter with mutable reported bindings and a test-selected `fund` behaviour. The real manager, token and
/// pool are kept in immutables so access control and token movements do not depend on the reported bindings.
contract ConfigurableAdapter is ILiquidityAdapter {
  using SafeERC20 for IERC20;

  error CallerNotManager(address caller);

  enum Mode {
    Honest, // approve amount, provideLiquidity(amount), reset allowance
    KeepPart, // approve and provide `amount - delta`, keep `delta`
    LeaveAllowance, // approve `amount + delta`, provide `amount`, no reset
    Divert, // approve and provide `amount - delta`, reset, send `delta` to `sink`
    OverPull, // approve and provide `amount + delta` (spends pre-existing balance), reset
    NoOp, // keeps everything
    DirectTransfer // transfers `amount` to the pool, bypassing provideLiquidity

  }

  address public MANAGER;
  address public TOKEN;
  address public POOL;

  address internal immutable i_manager;
  IERC20 internal immutable i_token;
  address internal immutable i_pool;

  Mode public mode;
  uint256 public delta;
  address public sink;

  constructor(address manager, address token, address pool) {
    MANAGER = manager;
    TOKEN = token;
    POOL = pool;
    i_manager = manager;
    i_token = IERC20(token);
    i_pool = pool;
  }

  function setBindings(address manager, address token, address pool) external {
    MANAGER = manager;
    TOKEN = token;
    POOL = pool;
  }

  function setMode(Mode newMode, uint256 newDelta, address newSink) external {
    mode = newMode;
    delta = newDelta;
    sink = newSink;
  }

  function fund(uint256 amount) external {
    if (msg.sender != i_manager) revert CallerNotManager(msg.sender);
    Mode m = mode;
    ILockReleaseTokenPool pool = ILockReleaseTokenPool(i_pool);
    if (m == Mode.Honest) {
      i_token.forceApprove(i_pool, amount);
      pool.provideLiquidity(amount);
      i_token.forceApprove(i_pool, 0);
    } else if (m == Mode.KeepPart) {
      i_token.forceApprove(i_pool, amount - delta);
      pool.provideLiquidity(amount - delta);
      i_token.forceApprove(i_pool, 0);
    } else if (m == Mode.LeaveAllowance) {
      i_token.forceApprove(i_pool, amount + delta);
      pool.provideLiquidity(amount);
    } else if (m == Mode.Divert) {
      i_token.forceApprove(i_pool, amount - delta);
      pool.provideLiquidity(amount - delta);
      i_token.forceApprove(i_pool, 0);
      i_token.safeTransfer(sink, delta);
    } else if (m == Mode.OverPull) {
      i_token.forceApprove(i_pool, amount + delta);
      pool.provideLiquidity(amount + delta);
      i_token.forceApprove(i_pool, 0);
    } else if (m == Mode.NoOp) {
      // Keeps the tokens.
    } else {
      i_token.safeTransfer(i_pool, amount);
    }
  }

  function recall(uint256 amount) external {
    if (msg.sender != i_manager) revert CallerNotManager(msg.sender);
    ILockReleaseTokenPool(i_pool).withdrawLiquidity(amount);
    i_token.safeTransfer(i_manager, amount);
  }
}
