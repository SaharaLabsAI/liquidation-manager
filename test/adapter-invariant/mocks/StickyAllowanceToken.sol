// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Non-standard ERC20 whose `approve(spender, 0)` returns true without clearing the allowance. It is the only
/// way to reach the adapter's exit-side zero-allowance check, which guards against tokens that do not honour a reset.
contract StickyAllowanceToken is ERC20 {
  bool public sticky = true;

  constructor(address holder, uint256 supply) ERC20("Sticky", "STICKY") {
    _mint(holder, supply);
  }

  function setSticky(bool value) external {
    sticky = value;
  }

  function approve(address spender, uint256 value) public override returns (bool) {
    if (sticky && value == 0) return true;
    return super.approve(spender, value);
  }
}
