// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {SaharaTimelock} from "src/SaharaTimelock.sol";
import {ITokenAdminRegistry} from "src/interfaces/ITokenAdminRegistry.sol";

interface IPoolToken {
  function getToken() external view returns (address);
}

/// @notice Deploys the liquidity contracts for one chain. The deployer keeps no privileges: the Timelock owns the
/// Manager from construction and administers itself, and the GuardianController is granted CANCELLER_ROLE at the
/// Timelock's construction (its address is predicted from the deployer nonce and checked afterwards).
/// @dev Required env: TOKEN, TOKEN_ADMIN_REGISTRY, POOL, GOVERNANCE_SAFE, GUARDIAN_SAFE.
/// Optional env: TIMELOCK_DELAY (default 72 hours), TIMELOCK_MINIMUM_DELAY (default 48 hours),
/// TIMELOCK_MAXIMUM_DELAY (default 30 days), EXECUTOR (an additional executor next to the Governance Safe, e.g. a
/// keeper; default none).
/// Usage: forge script script/Deploy.s.sol:Deploy --rpc-url <rpc> --sender <deployer> --broadcast --slow --verify
/// The four deployments are separate transactions whose addresses depend on the deployer nonce: use a fresh deployer
/// with no pending transaction, always pass --slow, and recover from an interrupted broadcast only with
/// `forge script --resume`. Re-check the live deployment with `Handover` (its preflight) before using it.
contract Deploy is Script {
  struct Config {
    address token;
    address tokenAdminRegistry;
    address pool;
    address governanceSafe;
    address guardianSafe;
    address executor;
    uint256 delay;
    uint256 minimumDelay;
    uint256 maximumDelay;
  }

  struct Deployment {
    SaharaTimelock timelock;
    LiquidityManager manager;
    GuardianController controller;
    CCIPPoolAdapter adapter;
  }

  function run() external returns (Deployment memory deployment) {
    Config memory config = Config({
      token: vm.envAddress("TOKEN"),
      tokenAdminRegistry: vm.envAddress("TOKEN_ADMIN_REGISTRY"),
      pool: vm.envAddress("POOL"),
      governanceSafe: vm.envAddress("GOVERNANCE_SAFE"),
      guardianSafe: vm.envAddress("GUARDIAN_SAFE"),
      executor: address(0),
      delay: vm.envOr("TIMELOCK_DELAY", uint256(72 hours)),
      minimumDelay: vm.envOr("TIMELOCK_MINIMUM_DELAY", uint256(48 hours)),
      maximumDelay: vm.envOr("TIMELOCK_MAXIMUM_DELAY", uint256(30 days))
    });
    config.executor = vm.envOr("EXECUTOR", config.governanceSafe);

    vm.startBroadcast();
    (, address deployer,) = vm.readCallers();
    _preflight(deployer, config);
    deployment = deploy(deployer, config);
    vm.stopBroadcast();

    console2.log("SaharaTimelock     ", address(deployment.timelock));
    console2.log("LiquidityManager   ", address(deployment.manager));
    console2.log("GuardianController ", address(deployment.controller));
    console2.log("CCIPPoolAdapter    ", address(deployment.adapter));
  }

  /// @notice Deploys in a fixed order: timelock (nonce n), manager (n + 1), controller (n + 2), adapter (n + 3), and
  /// checks the resulting wiring.
  function deploy(address deployer, Config memory config) public returns (Deployment memory deployment) {
    require(config.governanceSafe != config.guardianSafe, "Governance and Guardian must differ");

    uint64 nonce = vm.getNonce(deployer);
    address predictedController = vm.computeCreateAddress(deployer, nonce + 2);

    deployment.timelock = new SaharaTimelock(
      config.delay,
      config.minimumDelay,
      config.maximumDelay,
      _single(config.governanceSafe),
      _executors(config),
      _single(predictedController)
    );
    deployment.manager = new LiquidityManager(
      config.token, ITokenAdminRegistry(config.tokenAdminRegistry), address(deployment.timelock), config.guardianSafe
    );
    deployment.controller = new GuardianController(deployment.manager, deployment.timelock);
    deployment.adapter = new CCIPPoolAdapter(address(deployment.manager), config.token, config.pool);

    _checkWiring(deployer, config, deployment);
  }

  /// @dev Checks on the live inputs before anything is broadcast. The addresses of all four contracts are derived
  /// from the deployer nonce, so a pending deployer transaction would bind them to the wrong Timelock address. The
  /// pending-nonce check is best effort (some RPCs report the latest nonce as pending); a fresh deployer and `--slow`
  /// are the actual protection.
  function _preflight(address deployer, Config memory config) internal {
    require(_rpcNonce(deployer, "pending") == _rpcNonce(deployer, "latest"), "deployer has pending transactions");
    require(config.guardianSafe != address(0), "no Guardian");
    require(config.governanceSafe.code.length != 0, "Governance Safe has no code");
    require(config.guardianSafe.code.length != 0, "Guardian Safe has no code");
    require(deployer != config.governanceSafe && deployer != config.guardianSafe, "deployer must not be a Safe");
    require(config.executor != config.guardianSafe && config.executor != deployer, "invalid extra executor");
    require(config.minimumDelay >= 1 days, "minimum delay below 1 day");
    require(config.tokenAdminRegistry.code.length != 0, "registry has no code");
    require(
      ITokenAdminRegistry(config.tokenAdminRegistry).getPool(config.token) == config.pool, "registry does not map pool"
    );
    require(IPoolToken(config.pool).getToken() == config.token, "pool token");
  }

  function _checkWiring(address deployer, Config memory config, Deployment memory d) internal view {
    SaharaTimelock timelock = d.timelock;
    require(timelock.MINIMUM_DELAY() == config.minimumDelay, "minimum delay");
    require(timelock.MAXIMUM_DELAY() == config.maximumDelay, "maximum delay");
    require(timelock.getMinDelay() == config.delay, "delay");
    require(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)), "timelock is not self-administered");

    require(timelock.hasRole(timelock.PROPOSER_ROLE(), config.governanceSafe), "safe is not proposer");
    require(timelock.hasRole(timelock.EXECUTOR_ROLE(), config.governanceSafe), "safe is not executor");
    require(timelock.hasRole(timelock.CANCELLER_ROLE(), config.governanceSafe), "safe is not canceller");
    require(timelock.hasRole(timelock.CANCELLER_ROLE(), address(d.controller)), "controller is not canceller");
    if (config.executor != address(0)) {
      require(timelock.hasRole(timelock.EXECUTOR_ROLE(), config.executor), "executor missing");
    }

    address[3] memory unprivileged = [deployer, config.guardianSafe, address(d.controller)];
    for (uint256 i = 0; i < unprivileged.length; ++i) {
      address account = unprivileged[i];
      require(!timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), account), "unexpected timelock admin");
      require(!timelock.hasRole(timelock.PROPOSER_ROLE(), account), "unexpected proposer");
      require(!timelock.hasRole(timelock.EXECUTOR_ROLE(), account), "unexpected executor");
      if (account != address(d.controller)) {
        require(!timelock.hasRole(timelock.CANCELLER_ROLE(), account), "unexpected canceller");
      }
    }

    require(d.manager.owner() == address(timelock), "manager owner");
    require(d.manager.guardian() == config.guardianSafe, "manager guardian");
    require(d.manager.TOKEN() == config.token, "manager token");
    require(address(d.manager.TOKEN_ADMIN_REGISTRY()) == config.tokenAdminRegistry, "manager registry");

    require(address(d.controller.MANAGER()) == address(d.manager), "controller manager");
    require(address(d.controller.TIMELOCK()) == address(timelock), "controller timelock");

    require(d.adapter.MANAGER() == address(d.manager), "adapter manager");
    require(d.adapter.TOKEN() == config.token, "adapter token");
    require(d.adapter.POOL() == config.pool, "adapter pool");
  }

  function _rpcNonce(address account, string memory blockTag) internal returns (uint256 nonce) {
    bytes memory raw =
      vm.rpc("eth_getTransactionCount", string.concat('["', vm.toString(account), '","', blockTag, '"]'));
    for (uint256 i = 0; i < raw.length; ++i) {
      nonce = (nonce << 8) | uint8(raw[i]);
    }
  }

  /// @dev The Governance Safe always executes; `config.executor` is added when it is a different account.
  function _executors(Config memory config) internal pure returns (address[] memory executors) {
    if (config.executor == config.governanceSafe || config.executor == address(0)) {
      return _single(config.governanceSafe);
    }
    executors = new address[](2);
    executors[0] = config.governanceSafe;
    executors[1] = config.executor;
  }

  function _single(address account) internal pure returns (address[] memory accounts) {
    accounts = new address[](1);
    accounts[0] = account;
  }
}
