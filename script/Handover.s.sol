// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {ILiquidityAdapter} from "src/interfaces/ILiquidityAdapter.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";
import {IOwnable} from "src/interfaces/IOwnable.sol";
import {ITokenAdminRegistry} from "src/interfaces/ITokenAdminRegistry.sol";

/// @notice The calls that move existing authority from the legacy multisig to the new controls, and the Timelock
/// batch that completes the handover and configures the Manager. Shared by `Handover` and the fork tests.
library HandoverPlan {
  Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

  struct Params {
    address token;
    address tokenAdminRegistry;
    address pool;
    address timelock;
    address manager;
    address controller;
    address adapter;
    address fundingOperator;
    address recallOperator;
    ILiquidityManager.PoolSpec spec;
    ILiquidityManager.PoolThresholds thresholds;
    uint256 maxFundingPerCall;
    uint256 aggregateFundingCapacity;
    uint256 aggregateFundingRate;
    uint256 poolFundingCapacity;
    uint256 poolFundingRate;
    uint256 maxRecallPerCall;
    uint256 recallCapacity;
    uint256 recallRate;
  }

  struct Call {
    address target;
    bytes data;
  }

  /// @notice Checks, before anything is signed, that the deployment is wired as intended (the CONTROLLER, TIMELOCK,
  /// MANAGER and ADAPTER inputs are not otherwise verified on chain against each other), that the legacy multisig
  /// still holds every authority the handover moves, and that the live pool matches the full PoolSpec. The legacy
  /// multisig may itself be the Governance Safe.
  function preflight(Params memory p, address legacyMultisig, address governanceSafe) internal view {
    require(
      p.timelock.code.length != 0 && p.manager.code.length != 0 && p.controller.code.length != 0
        && p.adapter.code.length != 0,
      "deployment has no code"
    );

    LiquidityManager manager = LiquidityManager(p.manager);
    require(manager.owner() == p.timelock && manager.pendingOwner() == address(0), "manager owner");
    require(manager.TOKEN() == p.token, "manager token");
    require(address(manager.TOKEN_ADMIN_REGISTRY()) == p.tokenAdminRegistry, "manager registry");
    address guardian = manager.guardian();
    require(guardian != address(0) && guardian != governanceSafe, "guardian");

    GuardianController controller = GuardianController(p.controller);
    require(address(controller.MANAGER()) == p.manager, "controller manager");
    require(address(controller.TIMELOCK()) == p.timelock, "controller timelock");
    require(p.spec.rateLimitAdmin == p.controller, "rateLimitAdmin must be the controller");

    ILiquidityAdapter adapter = ILiquidityAdapter(p.adapter);
    require(
      adapter.MANAGER() == p.manager && adapter.TOKEN() == p.token && adapter.POOL() == p.pool, "adapter bindings"
    );

    TimelockController timelock = TimelockController(payable(p.timelock));
    require(timelock.hasRole(timelock.CANCELLER_ROLE(), p.controller), "controller is not canceller");
    require(
      timelock.hasRole(timelock.PROPOSER_ROLE(), governanceSafe)
        && timelock.hasRole(timelock.EXECUTOR_ROLE(), governanceSafe),
      "governance roles"
    );
    // Roles follow duties: the Guardian never holds a Timelock role; the legacy multisig holds none unless it is
    // also the Governance Safe.
    _requireNoTimelockRole(timelock, guardian);
    if (legacyMultisig != governanceSafe) _requireNoTimelockRole(timelock, legacyMultisig);

    ILockReleaseTokenPool pool = ILockReleaseTokenPool(p.pool);
    require(pool.owner() == legacyMultisig, "pool owner is not the legacy multisig");
    require(pool.getToken() == p.token, "pool token");
    require(keccak256(bytes(pool.typeAndVersion())) == keccak256(bytes(p.spec.typeAndVersion)), "pool version");
    require(pool.getRouter() == p.spec.router, "pool router");
    uint64 selector = p.spec.remoteChainSelector;
    uint64[] memory chains = pool.getSupportedChains();
    require(chains.length == 1 && chains[0] == selector, "pool chains");
    require(keccak256(pool.getRemoteToken(selector)) == keccak256(p.spec.remoteToken), "pool remote token");
    require(pool.getRemotePools(selector).length == p.spec.remotePools.length, "pool remote pools");
    for (uint256 i = 0; i < p.spec.remotePools.length; ++i) {
      require(pool.isRemotePool(selector, p.spec.remotePools[i]), "pool remote pools");
    }
    ITokenAdminRegistry.TokenConfig memory config = ITokenAdminRegistry(p.tokenAdminRegistry).getTokenConfig(p.token);
    require(config.administrator == legacyMultisig && config.pendingAdministrator == address(0), "registry admin");
    require(config.tokenPool == p.pool, "registry pool");
    require(IOwnable(p.token).owner() == legacyMultisig, "token owner");

    require(p.fundingOperator != address(0) && p.recallOperator != address(0), "operator is zero");
    require(p.fundingOperator != p.recallOperator, "operators must differ");
    address[3] memory privileged = [guardian, governanceSafe, p.timelock];
    for (uint256 i = 0; i < privileged.length; ++i) {
      require(p.fundingOperator != privileged[i] && p.recallOperator != privileged[i], "operator holds another role");
    }
    require(
      p.thresholds.minimum <= p.thresholds.refillTrigger && p.thresholds.refillTrigger <= p.thresholds.refillTarget,
      "thresholds"
    );
  }

  /// @notice Runs the whole handover against the current state and reverts the state afterwards: the legacy multisig
  /// calls, then the Timelock batch scheduled and executed by the Governance Safe after the delay. Requires the same
  /// end state the Manager enforces (`verifyHandover`, `verifyAdapter`) plus the pool authorities, so any input that
  /// would make the real batch revert is caught before anything is signed. Uses cheatcodes; simulation only.
  function simulate(Params memory p, address legacyMultisig, address governanceSafe, bytes32 salt) internal {
    uint256 snapshot = vm.snapshotState();

    Call[] memory calls = legacyMultisigCalls(p);
    for (uint256 i = 0; i < calls.length; ++i) {
      vm.prank(legacyMultisig);
      (bool success, bytes memory returnData) = calls[i].target.call(calls[i].data);
      _bubble(success, returnData);
    }

    TimelockController timelock = TimelockController(payable(p.timelock));
    (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = timelockBatch(p);
    uint256 delay = timelock.getMinDelay();
    vm.prank(governanceSafe);
    timelock.scheduleBatch(targets, values, payloads, bytes32(0), salt, delay);
    vm.warp(block.timestamp + delay);
    vm.prank(governanceSafe);
    timelock.executeBatch(targets, values, payloads, bytes32(0), salt);

    LiquidityManager manager = LiquidityManager(p.manager);
    manager.verifyHandover();
    uint256 adapterId = manager.adapterIdByPool(p.pool);
    require(adapterId != 0 && manager.getAdapter(adapterId).adapter == p.adapter, "simulated registration");
    manager.verifyAdapter(adapterId);
    ILockReleaseTokenPool pool = ILockReleaseTokenPool(p.pool);
    require(
      pool.owner() == p.timelock && pool.getRebalancer() == p.adapter && pool.getRateLimitAdmin() == p.controller,
      "simulated pool authorities"
    );
    require(manager.isFundingOperator(p.fundingOperator) && manager.isRecallOperator(p.recallOperator), "operators");

    vm.revertToState(snapshot);
  }

  function _requireNoTimelockRole(TimelockController timelock, address account) private view {
    require(
      !timelock.hasRole(timelock.PROPOSER_ROLE(), account) && !timelock.hasRole(timelock.EXECUTOR_ROLE(), account)
        && !timelock.hasRole(timelock.CANCELLER_ROLE(), account),
      "unexpected timelock role"
    );
  }

  function _bubble(bool success, bytes memory returnData) private pure {
    if (success) return;
    assembly {
      revert(add(returnData, 32), mload(returnData))
    }
  }

  /// @notice Calls the legacy multisig (current pool owner, registry administrator and token owner) makes, ideally
  /// in one MultiSend transaction. They hand the rate limit admin to the GuardianController at once, so the Guardian
  /// can lock the pool down during the handover window, and propose the Timelock as pool owner and registry admin.
  /// The current rebalancer keeps operating until the Timelock batch executes; until then the legacy multisig remains
  /// pool owner (it can still redirect pool liquidity) and the Manager refuses to register or fund the pool.
  function legacyMultisigCalls(Params memory p) internal pure returns (Call[] memory calls) {
    calls = new Call[](4);
    calls[0] = Call(p.pool, abi.encodeWithSignature("setRateLimitAdmin(address)", p.controller));
    calls[1] = Call(p.pool, abi.encodeWithSignature("transferOwnership(address)", p.timelock));
    calls[2] =
      Call(p.tokenAdminRegistry, abi.encodeWithSignature("transferAdminRole(address,address)", p.token, p.timelock));
    calls[3] = Call(p.token, abi.encodeWithSignature("transferOwnership(address)", p.timelock));
  }

  /// @notice The Timelock batch, scheduled by the Governance Safe once the legacy calls are done. It accepts pool
  /// ownership, makes the adapter the sole rebalancer, accepts registry administration, configures the Manager and
  /// registers the adapter. The batch is atomic: `registerAdapter` re-verifies every authority it relies on.
  function timelockBatch(Params memory p)
    internal
    pure
    returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
  {
    uint256 n = 12;
    targets = new address[](n);
    values = new uint256[](n);
    payloads = new bytes[](n);
    uint256 i;
    (targets[i], payloads[i++]) = (p.pool, abi.encodeWithSignature("acceptOwnership()"));
    (targets[i], payloads[i++]) = (p.pool, abi.encodeWithSignature("setRebalancer(address)", p.adapter));
    (targets[i], payloads[i++]) = (p.tokenAdminRegistry, abi.encodeWithSignature("acceptAdminRole(address)", p.token));
    (targets[i], payloads[i++]) = (p.manager, abi.encodeCall(LiquidityManager.setPoolSpec, (p.pool, p.spec)));
    (targets[i], payloads[i++]) = (
      p.manager,
      abi.encodeCall(
        LiquidityManager.setPoolThresholds,
        (p.pool, p.thresholds.minimum, p.thresholds.refillTrigger, p.thresholds.refillTarget)
      )
    );
    (targets[i], payloads[i++]) = (
      p.manager,
      abi.encodeCall(LiquidityManager.setPoolFundingBudget, (p.pool, p.poolFundingCapacity, p.poolFundingRate))
    );
    (targets[i], payloads[i++]) = (
      p.manager,
      abi.encodeCall(LiquidityManager.setAggregateFundingBudget, (p.aggregateFundingCapacity, p.aggregateFundingRate))
    );
    (targets[i], payloads[i++]) =
      (p.manager, abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (p.maxFundingPerCall)));
    (targets[i], payloads[i++]) = (
      p.manager, abi.encodeCall(LiquidityManager.setRecallLimits, (p.maxRecallPerCall, p.recallCapacity, p.recallRate))
    );
    (targets[i], payloads[i++]) =
      (p.manager, abi.encodeCall(LiquidityManager.setFundingOperator, (p.fundingOperator, true)));
    (targets[i], payloads[i++]) =
      (p.manager, abi.encodeCall(LiquidityManager.setRecallOperator, (p.recallOperator, true)));
    (targets[i], payloads[i++]) = (p.manager, abi.encodeCall(LiquidityManager.registerAdapter, (p.adapter, p.pool)));
    assert(i == n);
  }
}

/// @notice Runs `HandoverPlan.preflight` and `HandoverPlan.simulate` against live state, then prints the legacy
/// multisig calls and the Governance Safe's `scheduleBatch`/`executeBatch` calldata for the handover. Nothing is
/// broadcast. Run it before the legacy multisig signs anything.
/// @dev Env: LEGACY_MULTISIG, GOVERNANCE_SAFE, TOKEN, TOKEN_ADMIN_REGISTRY, POOL, TIMELOCK, MANAGER, CONTROLLER,
/// ADAPTER, FUNDING_OPERATOR,
/// RECALL_OPERATOR, ROUTER, REMOTE_CHAIN_SELECTOR, REMOTE_TOKEN, REMOTE_POOL, POOL_MINIMUM, REFILL_TRIGGER,
/// REFILL_TARGET, MAX_FUNDING_PER_CALL, AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE, POOL_FUNDING_CAPACITY,
/// POOL_FUNDING_RATE, MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE; optional POOL_TYPE_AND_VERSION
/// (default "LockReleaseTokenPool 1.6.3-dev") and SALT (default 0).
contract Handover is Script {
  function run() external {
    HandoverPlan.Params memory p = params();
    address legacyMultisig = vm.envAddress("LEGACY_MULTISIG");
    address governanceSafe = vm.envAddress("GOVERNANCE_SAFE");
    HandoverPlan.preflight(p, legacyMultisig, governanceSafe);
    HandoverPlan.simulate(p, legacyMultisig, governanceSafe, vm.envOr("SALT", bytes32(0)));
    console2.log("Preflight and handover simulation passed.");

    console2.log("== Legacy multisig calls (in order, one MultiSend) ==");
    HandoverPlan.Call[] memory calls = HandoverPlan.legacyMultisigCalls(p);
    for (uint256 i = 0; i < calls.length; ++i) {
      console2.log(calls[i].target);
      console2.logBytes(calls[i].data);
    }

    (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = HandoverPlan.timelockBatch(p);
    bytes32 salt = vm.envOr("SALT", bytes32(0));
    uint256 delay = TimelockController(payable(p.timelock)).getMinDelay();

    console2.log("== Governance Safe -> Timelock.scheduleBatch ==");
    console2.log(p.timelock);
    console2.logBytes(abi.encodeCall(TimelockController.scheduleBatch, (targets, values, payloads, 0, salt, delay)));
    console2.log("== Governance Safe -> Timelock.executeBatch (after the delay) ==");
    console2.logBytes(abi.encodeCall(TimelockController.executeBatch, (targets, values, payloads, 0, salt)));
  }

  function params() public view returns (HandoverPlan.Params memory p) {
    p.token = vm.envAddress("TOKEN");
    p.tokenAdminRegistry = vm.envAddress("TOKEN_ADMIN_REGISTRY");
    p.pool = vm.envAddress("POOL");
    p.timelock = vm.envAddress("TIMELOCK");
    p.manager = vm.envAddress("MANAGER");
    p.controller = vm.envAddress("CONTROLLER");
    p.adapter = vm.envAddress("ADAPTER");
    p.fundingOperator = vm.envAddress("FUNDING_OPERATOR");
    p.recallOperator = vm.envAddress("RECALL_OPERATOR");

    p.spec.typeAndVersion = vm.envOr("POOL_TYPE_AND_VERSION", string("LockReleaseTokenPool 1.6.3-dev"));
    p.spec.router = vm.envAddress("ROUTER");
    p.spec.remoteChainSelector = uint64(vm.envUint("REMOTE_CHAIN_SELECTOR"));
    p.spec.remoteToken = abi.encode(vm.envAddress("REMOTE_TOKEN"));
    p.spec.remotePools = new bytes[](1);
    p.spec.remotePools[0] = abi.encode(vm.envAddress("REMOTE_POOL"));
    p.spec.rateLimitAdmin = p.controller;

    p.thresholds = ILiquidityManager.PoolThresholds({
      minimum: vm.envUint("POOL_MINIMUM"),
      refillTrigger: vm.envUint("REFILL_TRIGGER"),
      refillTarget: vm.envUint("REFILL_TARGET")
    });
    p.maxFundingPerCall = vm.envUint("MAX_FUNDING_PER_CALL");
    p.aggregateFundingCapacity = vm.envUint("AGGREGATE_FUNDING_CAPACITY");
    p.aggregateFundingRate = vm.envUint("AGGREGATE_FUNDING_RATE");
    p.poolFundingCapacity = vm.envUint("POOL_FUNDING_CAPACITY");
    p.poolFundingRate = vm.envUint("POOL_FUNDING_RATE");
    p.maxRecallPerCall = vm.envUint("MAX_RECALL_PER_CALL");
    p.recallCapacity = vm.envUint("RECALL_CAPACITY");
    p.recallRate = vm.envUint("RECALL_RATE");
  }
}
