// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";

/// @notice Stand-in for the deployed SAHARA token: fixed-supply OZ v5 ERC20 with owner pause.
contract MockSahara is ERC20Pausable, Ownable {
  uint256 public constant SUPPLY = 10_000_000_000e18;

  constructor(address holder) ERC20("Sahara AI", "SAHARA") Ownable(msg.sender) {
    _mint(holder, SUPPLY);
  }

  function pause() external onlyOwner {
    _pause();
  }

  function unpause() external onlyOwner {
    _unpause();
  }
}
