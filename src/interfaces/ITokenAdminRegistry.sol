// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface of the Chainlink CCIP `TokenAdminRegistry` (1.5.0).
interface ITokenAdminRegistry {
  struct TokenConfig {
    address administrator; // Current administrator of the token's registry entry.
    address pendingAdministrator; // Proposed administrator, if a transfer is in progress.
    address tokenPool; // Pool CCIP uses for the token.
  }

  /// @notice Returns the pool CCIP uses for `token`, or address(0) if none is set.
  function getPool(address token) external view returns (address);

  function getTokenConfig(address token) external view returns (TokenConfig memory);
}
