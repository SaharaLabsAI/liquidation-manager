// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TESTNET ONLY. A non-reserve token minted straight to `holder`, used to rehearse
/// `LiquidityManager.recoverToken` for tokens sent to the Manager by mistake.
contract StrayToken is ERC20 {
  constructor(address holder) ERC20("Stray Test Token", "STRAY") {
    _mint(holder, 1_000e18);
  }
}
