// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ILiquidityAdapter} from "src/interfaces/ILiquidityAdapter.sol";

/// @notice Adapter that reports arbitrary bindings and does nothing. Used to reach the Manager's binding and pool
/// checks with combinations `CCIPPoolAdapter`'s constructor would reject.
contract StubAdapter is ILiquidityAdapter {
  address public MANAGER;
  address public TOKEN;
  address public POOL;

  constructor(address manager, address token, address pool) {
    MANAGER = manager;
    TOKEN = token;
    POOL = pool;
  }

  function fund(uint256) external {}

  function recall(uint256) external {}
}
