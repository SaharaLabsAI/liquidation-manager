// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ILiquidityAdapter} from "src/interfaces/ILiquidityAdapter.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";

/// @notice `MockLockReleaseTokenPool` whose liquidity functions can misbehave, and which records what the rebalancer
/// left it when `provideLiquidity` was called. It still passes every pool check the Manager performs, so it models a
/// pool that looks right but whose liquidity code is hostile or buggy.
contract ConfigurablePool is MockLockReleaseTokenPool {
  enum Mode {
    Honest,
    PullLess, // provideLiquidity pulls amount - delta
    PullNone, // provideLiquidity pulls nothing
    PayLess, // withdrawLiquidity pays amount - delta
    PayMore, // withdrawLiquidity pays amount + delta
    PayNone, // withdrawLiquidity pays nothing
    ReenterFund, // provideLiquidity calls back into the adapter's fund
    ReenterRecall, // withdrawLiquidity calls back into the adapter's recall
    PayElsewhere // withdrawLiquidity pays `amount` to `payee` instead of the rebalancer

  }

  Mode public mode;
  uint256 public delta;
  address public payee;

  uint256 public provideCalls;
  uint256 public recordedAllowance;
  uint256 public recordedRebalancerBalance;
  uint256 public withdrawCalls;

  constructor(address token, address router) MockLockReleaseTokenPool(token, router) {}

  function setMode(Mode newMode, uint256 newDelta) external {
    mode = newMode;
    delta = newDelta;
  }

  function setPayee(address newPayee) external {
    payee = newPayee;
  }

  function provideLiquidity(uint256 amount) external override {
    if (s_rebalancer != msg.sender) revert Unauthorized(msg.sender);
    ++provideCalls;
    recordedAllowance = i_token.allowance(msg.sender, address(this));
    recordedRebalancerBalance = i_token.balanceOf(msg.sender);

    if (mode == Mode.ReenterFund) {
      ILiquidityAdapter(msg.sender).fund(amount);
    } else if (mode == Mode.PullLess) {
      _pull(amount - delta);
    } else if (mode == Mode.PullNone) {
      // nothing
    } else {
      _pull(amount);
    }
    emit LiquidityAdded(msg.sender, amount);
  }

  function withdrawLiquidity(uint256 amount) external override {
    if (s_rebalancer != msg.sender) revert Unauthorized(msg.sender);
    ++withdrawCalls;
    if (i_token.balanceOf(address(this)) < amount) revert InsufficientLiquidity();

    if (mode == Mode.ReenterRecall) {
      ILiquidityAdapter(msg.sender).recall(amount);
    } else if (mode == Mode.PayLess) {
      _pay(msg.sender, amount - delta);
    } else if (mode == Mode.PayMore) {
      _pay(msg.sender, amount + delta);
    } else if (mode == Mode.PayNone) {
      // nothing
    } else if (mode == Mode.PayElsewhere) {
      _pay(payee, amount);
    } else {
      _pay(msg.sender, amount);
    }
    emit LiquidityRemoved(msg.sender, amount);
  }

  function _pull(uint256 amount) internal {
    // A plain transferFrom keeps the token's own revert data (e.g. ERC20InsufficientBalance) visible to tests.
    bool ok = IERC20(address(i_token)).transferFrom(msg.sender, address(this), amount);
    require(ok, "transferFrom returned false");
  }

  function _pay(address to, uint256 amount) internal {
    bool ok = IERC20(address(i_token)).transfer(to, amount);
    require(ok, "transfer returned false");
  }
}
