// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Bridge adapter through which a `LiquidityManager` funds and recalls one pool.
interface ILiquidityAdapter {
  /// @notice The only address allowed to call `fund` and `recall`.
  function MANAGER() external view returns (address);

  /// @notice The token moved by the adapter.
  function TOKEN() external view returns (address);

  /// @notice The pool the adapter is bound to.
  function POOL() external view returns (address);

  /// @notice Moves `amount` tokens, previously transferred to the adapter by the manager, into the pool.
  function fund(uint256 amount) external;

  /// @notice Withdraws `amount` tokens from the pool and forwards them to the manager.
  function recall(uint256 amount) external;
}
