// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/Script.sol";

import {Deploy} from "script/Deploy.s.sol";
import {ITokenAdminRegistry} from "src/interfaces/ITokenAdminRegistry.sol";

interface IPoolTokenView {
  function getToken() external view returns (address);
}

/// @notice TESTNET ONLY. Deploys the liquidity contracts exactly like `Deploy` (same nonce order, same `_checkWiring`)
/// but with a short Timelock delay, so the handover, fund/recall and emergency procedures can be rehearsed end to end
/// in one session. `Deploy`'s production preflight enforces a minimum delay of at least one day; this script keeps the
/// other preflight checks and refuses to run on Ethereum mainnet or BSC.
/// @dev Required env: TOKEN, TOKEN_ADMIN_REGISTRY, POOL, GOVERNANCE_SAFE, GUARDIAN_SAFE.
/// Optional env: TIMELOCK_DELAY (default 120 s), TIMELOCK_MINIMUM_DELAY (default 60 s), TIMELOCK_MAXIMUM_DELAY
/// (default 30 days), EXECUTOR (default: the Governance Safe only).
/// Usage: forge script script/testnet/TestnetDeploy.s.sol:TestnetDeploy --sig 'deployTestnet()' --rpc-url <rpc>
/// --account <deployer> --sender <deployer> --broadcast --slow
contract TestnetDeploy is Deploy {
  function deployTestnet() external returns (Deployment memory deployment) {
    require(block.chainid != 1 && block.chainid != 56, "TestnetDeploy: mainnet chain");

    Config memory config = Config({
      token: vm.envAddress("TOKEN"),
      tokenAdminRegistry: vm.envAddress("TOKEN_ADMIN_REGISTRY"),
      pool: vm.envAddress("POOL"),
      governanceSafe: vm.envAddress("GOVERNANCE_SAFE"),
      guardianSafe: vm.envAddress("GUARDIAN_SAFE"),
      executor: address(0),
      delay: vm.envOr("TIMELOCK_DELAY", uint256(120)),
      minimumDelay: vm.envOr("TIMELOCK_MINIMUM_DELAY", uint256(60)),
      maximumDelay: vm.envOr("TIMELOCK_MAXIMUM_DELAY", uint256(30 days))
    });
    config.executor = vm.envOr("EXECUTOR", config.governanceSafe);

    vm.startBroadcast();
    (, address deployer,) = vm.readCallers();
    _testnetPreflight(deployer, config);
    deployment = deploy(deployer, config);
    vm.stopBroadcast();

    console2.log("SaharaTimelock     ", address(deployment.timelock));
    console2.log("LiquidityManager   ", address(deployment.manager));
    console2.log("GuardianController ", address(deployment.controller));
    console2.log("CCIPPoolAdapter    ", address(deployment.adapter));
  }

  /// @dev `Deploy._preflight` without the one-day minimum-delay floor.
  function _testnetPreflight(address deployer, Config memory config) internal {
    require(_rpcNonce(deployer, "pending") == _rpcNonce(deployer, "latest"), "deployer has pending transactions");
    require(config.guardianSafe != address(0), "no Guardian");
    require(config.governanceSafe.code.length != 0, "Governance Safe has no code");
    require(config.guardianSafe.code.length != 0, "Guardian Safe has no code");
    require(deployer != config.governanceSafe && deployer != config.guardianSafe, "deployer must not be a Safe");
    require(config.executor != config.guardianSafe && config.executor != deployer, "invalid extra executor");
    require(config.tokenAdminRegistry.code.length != 0, "registry has no code");
    require(
      ITokenAdminRegistry(config.tokenAdminRegistry).getPool(config.token) == config.pool, "registry does not map pool"
    );
    require(IPoolTokenView(config.pool).getToken() == config.token, "pool token");
  }
}
