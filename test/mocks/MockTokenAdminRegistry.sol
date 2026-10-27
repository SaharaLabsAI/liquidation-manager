// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ITokenAdminRegistry} from "../../src/interfaces/ITokenAdminRegistry.sol";

contract MockTokenAdminRegistry is ITokenAdminRegistry {
  mapping(address token => TokenConfig) internal s_configs;

  function setPool(address token, address pool) external {
    s_configs[token].tokenPool = pool;
  }

  function setAdministrator(address token, address administrator) external {
    s_configs[token].administrator = administrator;
  }

  function setPendingAdministrator(address token, address pendingAdministrator) external {
    s_configs[token].pendingAdministrator = pendingAdministrator;
  }

  function getPool(address token) external view returns (address) {
    return s_configs[token].tokenPool;
  }

  function getTokenConfig(address token) external view returns (TokenConfig memory) {
    return s_configs[token];
  }
}
