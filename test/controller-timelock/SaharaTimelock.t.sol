// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Vm} from "forge-std/Vm.sol";

import {LiquidityManager} from "src/LiquidityManager.sol";
import {SaharaTimelock} from "src/SaharaTimelock.sol";

import {ControllerTimelockBase} from "test/controller-timelock/utils/ControllerTimelockBase.sol";

/// @notice SaharaTimelock: bounded delay, self-administration, explicit executors, proposers that keep their
/// CANCELLER_ROLE, additional cancellers and role layout.
contract SaharaTimelockTest is ControllerTimelockBase {
  bytes32 internal constant SALT = keccak256("timelock");

  bytes32 internal DEFAULT_ADMIN;
  bytes32 internal PROPOSER;
  bytes32 internal EXECUTOR;
  bytes32 internal CANCELLER;

  function setUp() public override {
    super.setUp();
    DEFAULT_ADMIN = timelock.DEFAULT_ADMIN_ROLE();
    PROPOSER = timelock.PROPOSER_ROLE();
    EXECUTOR = timelock.EXECUTOR_ROLE();
    CANCELLER = timelock.CANCELLER_ROLE();
  }

  function _deploy(
    uint256 minDelay,
    uint256 minimumDelay,
    uint256 maximumDelay,
    address[] memory proposers,
    address[] memory executors,
    address[] memory cancellers
  ) internal returns (SaharaTimelock) {
    return new SaharaTimelock(minDelay, minimumDelay, maximumDelay, proposers, executors, cancellers);
  }

  /// @dev Deploys with the fixture bounds [TIMELOCK_MINIMUM_DELAY, TIMELOCK_MAXIMUM_DELAY].
  function _deploy(
    uint256 minDelay,
    address[] memory proposers,
    address[] memory executors,
    address[] memory cancellers
  ) internal returns (SaharaTimelock) {
    return _deploy(minDelay, TIMELOCK_MINIMUM_DELAY, TIMELOCK_MAXIMUM_DELAY, proposers, executors, cancellers);
  }

  function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
    return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, role);
  }

  function _insufficientDelay(uint256 delay, uint256 minDelay) internal pure returns (bytes memory) {
    return abi.encodeWithSelector(TimelockController.TimelockInsufficientDelay.selector, delay, minDelay);
  }

  function _invalidDelayBounds(uint256 minimumDelay, uint256 maximumDelay) internal pure returns (bytes memory) {
    return abi.encodeWithSelector(SaharaTimelock.InvalidDelayBounds.selector, minimumDelay, maximumDelay);
  }

  function _delayOutOfBounds(uint256 delay, uint256 minimumDelay, uint256 maximumDelay)
    internal
    pure
    returns (bytes memory)
  {
    return abi.encodeWithSelector(SaharaTimelock.DelayOutOfBounds.selector, delay, minimumDelay, maximumDelay);
  }

  /// @dev DelayOutOfBounds against the fixture bounds.
  function _delayOutOfBounds(uint256 delay) internal pure returns (bytes memory) {
    return _delayOutOfBounds(delay, TIMELOCK_MINIMUM_DELAY, TIMELOCK_MAXIMUM_DELAY);
  }

  function _notReadyRevert(bytes32 id) internal pure returns (bytes memory) {
    return abi.encodeWithSelector(TimelockController.TimelockUnexpectedOperationState.selector, id, _readyBitmap());
  }

  function _updateDelayCall(uint256 newDelay) internal pure returns (bytes memory) {
    return abi.encodeCall(TimelockController.updateDelay, (newDelay));
  }

  function _probeCall(uint256 n) internal pure returns (bytes memory) {
    return abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (n));
  }

  function _pair(address a, address b) internal pure returns (address[] memory accounts) {
    accounts = new address[](2);
    accounts[0] = a;
    accounts[1] = b;
  }

  // ================================================================
  // │                         Constructor                          │
  // ================================================================

  function test_fixture_delays() public view {
    assertEq(timelock.MINIMUM_DELAY(), TIMELOCK_MINIMUM_DELAY);
    assertEq(timelock.MAXIMUM_DELAY(), TIMELOCK_MAXIMUM_DELAY);
    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);
  }

  function test_regression_constructor_revertsWhenMinDelayBelowMinimum() public {
    vm.expectRevert(_delayOutOfBounds(TIMELOCK_MINIMUM_DELAY - 1));
    _deploy(TIMELOCK_MINIMUM_DELAY - 1, _single(governanceSafe), _single(governanceSafe), _single(address(controller)));
  }

  function test_regression_constructor_revertsWithZeroDelayAndNonZeroMinimum() public {
    vm.expectRevert(_delayOutOfBounds(0, 1, TIMELOCK_MAXIMUM_DELAY));
    _deploy(0, 1, TIMELOCK_MAXIMUM_DELAY, _single(governanceSafe), _single(governanceSafe), new address[](0));
  }

  function test_regression_constructor_revertsWhenMinDelayAboveMaximum() public {
    vm.expectRevert(_delayOutOfBounds(TIMELOCK_MAXIMUM_DELAY + 1));
    _deploy(TIMELOCK_MAXIMUM_DELAY + 1, _single(governanceSafe), _single(governanceSafe), _single(address(controller)));

    vm.expectRevert(_delayOutOfBounds(type(uint256).max));
    _deploy(type(uint256).max, _single(governanceSafe), _single(governanceSafe), _single(address(controller)));
  }

  /// @dev A zero lower bound is rejected (it previously meant "no floor").
  function test_regression_constructor_revertsWithZeroMinimumDelay() public {
    vm.expectRevert(_invalidDelayBounds(0, TIMELOCK_MAXIMUM_DELAY));
    _deploy(
      TIMELOCK_DELAY, 0, TIMELOCK_MAXIMUM_DELAY, _single(governanceSafe), _single(governanceSafe), new address[](0)
    );

    vm.expectRevert(_invalidDelayBounds(0, 0));
    _deploy(0, 0, 0, _single(governanceSafe), _single(governanceSafe), new address[](0));
  }

  function test_regression_constructor_revertsWhenMinimumAboveMaximum() public {
    vm.expectRevert(_invalidDelayBounds(48 hours, 24 hours));
    _deploy(36 hours, 48 hours, 24 hours, _single(governanceSafe), _single(governanceSafe), new address[](0));

    vm.expectRevert(_invalidDelayBounds(TIMELOCK_MAXIMUM_DELAY + 1, TIMELOCK_MAXIMUM_DELAY));
    _deploy(
      TIMELOCK_DELAY,
      TIMELOCK_MAXIMUM_DELAY + 1,
      TIMELOCK_MAXIMUM_DELAY,
      _single(governanceSafe),
      _single(governanceSafe),
      new address[](0)
    );
  }

  function test_constructor_minDelayEqualToMinimum() public {
    SaharaTimelock t =
      _deploy(TIMELOCK_MINIMUM_DELAY, _single(governanceSafe), _single(governanceSafe), _single(address(controller)));
    assertEq(t.MINIMUM_DELAY(), TIMELOCK_MINIMUM_DELAY);
    assertEq(t.MAXIMUM_DELAY(), TIMELOCK_MAXIMUM_DELAY);
    assertEq(t.getMinDelay(), TIMELOCK_MINIMUM_DELAY);
  }

  function test_constructor_minDelayEqualToMaximum() public {
    SaharaTimelock t =
      _deploy(TIMELOCK_MAXIMUM_DELAY, _single(governanceSafe), _single(governanceSafe), _single(address(controller)));
    assertEq(t.getMinDelay(), TIMELOCK_MAXIMUM_DELAY);
  }

  /// @dev Equal bounds pin the delay.
  function test_constructor_equalBoundsFixTheDelay() public {
    SaharaTimelock t = _deploy(
      TIMELOCK_DELAY, TIMELOCK_DELAY, TIMELOCK_DELAY, _single(governanceSafe), _single(governanceSafe), new address[](0)
    );
    assertEq(t.MINIMUM_DELAY(), TIMELOCK_DELAY);
    assertEq(t.MAXIMUM_DELAY(), TIMELOCK_DELAY);
    assertEq(t.getMinDelay(), TIMELOCK_DELAY);
  }

  /// @dev Mirrors the constructor's check order: bounds, then the initial delay.
  function testFuzz_constructor_delayBounds(uint256 minDelay, uint256 minimumDelay, uint256 maximumDelay) public {
    address[] memory safe = _single(governanceSafe);
    if (minimumDelay == 0 || minimumDelay > maximumDelay || maximumDelay > timelock.MAXIMUM_DELAY_CAP()) {
      vm.expectRevert(_invalidDelayBounds(minimumDelay, maximumDelay));
      _deploy(minDelay, minimumDelay, maximumDelay, safe, safe, new address[](0));
    } else if (minDelay < minimumDelay || minDelay > maximumDelay) {
      vm.expectRevert(_delayOutOfBounds(minDelay, minimumDelay, maximumDelay));
      _deploy(minDelay, minimumDelay, maximumDelay, safe, safe, new address[](0));
    } else {
      SaharaTimelock t = _deploy(minDelay, minimumDelay, maximumDelay, safe, safe, new address[](0));
      assertEq(t.MINIMUM_DELAY(), minimumDelay);
      assertEq(t.MAXIMUM_DELAY(), maximumDelay);
      assertEq(t.getMinDelay(), minDelay);
    }
  }

  function testFuzz_constructor_validBounds(uint256 minDelay, uint256 minimumDelay, uint256 maximumDelay) public {
    minimumDelay = bound(minimumDelay, 1, 90 days);
    maximumDelay = bound(maximumDelay, minimumDelay, 90 days);
    minDelay = bound(minDelay, minimumDelay, maximumDelay);
    SaharaTimelock t =
      _deploy(minDelay, minimumDelay, maximumDelay, _single(governanceSafe), _single(governanceSafe), new address[](0));
    assertEq(t.MINIMUM_DELAY(), minimumDelay);
    assertEq(t.MAXIMUM_DELAY(), maximumDelay);
    assertEq(t.getMinDelay(), minDelay);
  }

  /// @dev Open execution is no longer allowed: a zero executor is rejected instead of opening EXECUTOR_ROLE.
  function test_regression_constructor_rejectsOpenExecutor() public {
    vm.expectRevert(SaharaTimelock.InvalidExecutors.selector);
    _deploy(TIMELOCK_DELAY, _single(governanceSafe), _single(address(0)), _single(guardian));

    vm.expectRevert(SaharaTimelock.InvalidExecutors.selector);
    _deploy(TIMELOCK_DELAY, _single(governanceSafe), _pair(governanceSafe, address(0)), _single(guardian));

    vm.expectRevert(SaharaTimelock.InvalidExecutors.selector);
    _deploy(TIMELOCK_DELAY, _single(governanceSafe), _pair(address(0), governanceSafe), _single(guardian));
  }

  function test_regression_constructor_rejectsEmptyExecutors() public {
    vm.expectRevert(SaharaTimelock.InvalidExecutors.selector);
    _deploy(TIMELOCK_DELAY, _single(governanceSafe), new address[](0), _single(address(controller)));
  }

  /// @dev A zero proposer is rejected (it used to be granted PROPOSER_ROLE harmlessly).
  function test_regression_constructor_rejectsZeroAddressProposer() public {
    vm.expectRevert(SaharaTimelock.ZeroAddress.selector);
    _deploy(TIMELOCK_DELAY, _single(address(0)), _single(governanceSafe), new address[](0));

    vm.expectRevert(SaharaTimelock.ZeroAddress.selector);
    _deploy(TIMELOCK_DELAY, _pair(governanceSafe, address(0)), _single(governanceSafe), _single(address(controller)));
  }

  /// @dev A zero canceller is rejected (it used to be granted CANCELLER_ROLE harmlessly).
  function test_regression_constructor_rejectsZeroAddressCanceller() public {
    vm.expectRevert(SaharaTimelock.ZeroAddress.selector);
    _deploy(TIMELOCK_DELAY, _single(governanceSafe), _single(governanceSafe), _single(address(0)));

    vm.expectRevert(SaharaTimelock.ZeroAddress.selector);
    _deploy(TIMELOCK_DELAY, _single(governanceSafe), _single(governanceSafe), _pair(address(controller), address(0)));
  }

  /// @dev Check order: delay bounds, initial delay, executors, proposers, cancellers.
  function test_regression_constructor_checkOrder() public {
    address[] memory zero = _single(address(0));
    address[] memory none = new address[](0);
    address[] memory safe = _single(governanceSafe);

    vm.expectRevert(_invalidDelayBounds(0, TIMELOCK_MAXIMUM_DELAY));
    _deploy(type(uint256).max, 0, TIMELOCK_MAXIMUM_DELAY, zero, none, zero);

    vm.expectRevert(_delayOutOfBounds(type(uint256).max));
    _deploy(type(uint256).max, TIMELOCK_MINIMUM_DELAY, TIMELOCK_MAXIMUM_DELAY, zero, none, zero);

    vm.expectRevert(SaharaTimelock.InvalidExecutors.selector);
    _deploy(TIMELOCK_DELAY, zero, none, zero);

    vm.expectRevert(SaharaTimelock.ZeroAddress.selector);
    _deploy(TIMELOCK_DELAY, zero, safe, zero);

    vm.expectRevert(SaharaTimelock.ZeroAddress.selector);
    _deploy(TIMELOCK_DELAY, safe, safe, zero);

    _deploy(TIMELOCK_DELAY, safe, safe, none);
  }

  function test_regression_constructor_rejectsEmptyProposers() public {
    vm.expectRevert(SaharaTimelock.InvalidProposers.selector);
    _deploy(TIMELOCK_DELAY, new address[](0), _single(governanceSafe), _single(address(controller)));
  }

  /// @dev Every proposer must be able to execute its own operations (e.g. the protected Guardian removal).
  function test_regression_constructor_rejectsProposerThatIsNotExecutor() public {
    address keeper = makeAddr("keeper");
    vm.expectRevert(abi.encodeWithSelector(SaharaTimelock.ProposerMustBeExecutor.selector, governanceSafe));
    _deploy(TIMELOCK_DELAY, _single(governanceSafe), _single(keeper), _single(address(controller)));

    // A keeper may execute in addition to the proposer.
    SaharaTimelock t =
      _deploy(TIMELOCK_DELAY, _single(governanceSafe), _pair(governanceSafe, keeper), _single(address(controller)));
    assertTrue(t.hasRole(t.EXECUTOR_ROLE(), governanceSafe));
    assertTrue(t.hasRole(t.EXECUTOR_ROLE(), keeper));
  }

  function test_regression_constructor_rejectsMaximumDelayAboveCap() public {
    uint256 cap = timelock.MAXIMUM_DELAY_CAP();
    assertEq(cap, 90 days);
    vm.expectRevert(_invalidDelayBounds(TIMELOCK_MINIMUM_DELAY, cap + 1));
    _deploy(
      TIMELOCK_DELAY,
      TIMELOCK_MINIMUM_DELAY,
      cap + 1,
      _single(governanceSafe),
      _single(governanceSafe),
      new address[](0)
    );

    vm.expectRevert(_invalidDelayBounds(TIMELOCK_MINIMUM_DELAY, type(uint256).max));
    _deploy(
      TIMELOCK_DELAY,
      TIMELOCK_MINIMUM_DELAY,
      type(uint256).max,
      _single(governanceSafe),
      _single(governanceSafe),
      new address[](0)
    );

    SaharaTimelock t = _deploy(
      TIMELOCK_DELAY, TIMELOCK_MINIMUM_DELAY, cap, _single(governanceSafe), _single(governanceSafe), new address[](0)
    );
    assertEq(t.MAXIMUM_DELAY(), cap);
  }

  function test_constructor_emitsMinDelayChange() public {
    vm.expectEmit(false, false, false, true);
    emit TimelockController.MinDelayChange(0, TIMELOCK_DELAY);
    _deploy(TIMELOCK_DELAY, _single(governanceSafe), _single(governanceSafe), new address[](0));
  }

  /// @dev From the constructor's logs: DEFAULT_ADMIN_ROLE is granted exactly once, to the Timelock itself; no role is
  /// granted to the deployer; no role is revoked, so proposers keep the CANCELLER_ROLE OpenZeppelin grants them and
  /// explicit cancellers are granted it in addition.
  function test_constructor_roleEvents_selfAdminAndProposersKeepCanceller() public {
    address safe2 = makeAddr("safe2");
    address[] memory proposers = _pair(governanceSafe, safe2);

    vm.recordLogs();
    SaharaTimelock t = _deploy(TIMELOCK_DELAY, proposers, proposers, _single(guardian));
    Vm.Log[] memory logs = vm.getRecordedLogs();

    uint256 adminGrants;
    uint256 cancellerGrants;
    uint256 revocations;
    for (uint256 i = 0; i < logs.length; ++i) {
      if (logs[i].emitter != address(t)) continue;
      bytes32 topic0 = logs[i].topics[0];
      if (topic0 == IAccessControl.RoleGranted.selector) {
        bytes32 role = logs[i].topics[1];
        address account = address(uint160(uint256(logs[i].topics[2])));
        assertTrue(account != address(this), "no role for the deployer");
        if (role == DEFAULT_ADMIN) {
          assertEq(account, address(t), "admin only to self");
          ++adminGrants;
        } else if (role == CANCELLER) {
          assertTrue(account == governanceSafe || account == safe2 || account == guardian, "canceller grantee");
          ++cancellerGrants;
        }
      } else if (topic0 == IAccessControl.RoleRevoked.selector) {
        ++revocations;
      }
    }
    assertEq(adminGrants, 1, "one admin grant");
    assertEq(cancellerGrants, 3, "both proposers and the explicit canceller");
    assertEq(revocations, 0, "no role is revoked");
    assertTrue(t.hasRole(CANCELLER, governanceSafe));
    assertTrue(t.hasRole(CANCELLER, safe2));
    assertTrue(t.hasRole(CANCELLER, guardian));
    assertFalse(t.hasRole(PROPOSER, guardian));
  }

  // ================================================================
  // │                         Role layout                          │
  // ================================================================

  /// @dev The Safe proposes, executes and (as a proposer) cancels.
  function test_roles_governanceSafe() public view {
    assertTrue(timelock.hasRole(PROPOSER, governanceSafe));
    assertTrue(timelock.hasRole(EXECUTOR, governanceSafe));
    assertTrue(timelock.hasRole(CANCELLER, governanceSafe), "proposer keeps CANCELLER_ROLE");
    assertFalse(timelock.hasRole(DEFAULT_ADMIN, governanceSafe));
  }

  function test_roles_controllerHoldsOnlyCancellerRole() public view {
    assertTrue(timelock.hasRole(CANCELLER, address(controller)));
    assertFalse(timelock.hasRole(PROPOSER, address(controller)));
    assertFalse(timelock.hasRole(EXECUTOR, address(controller)));
    assertFalse(timelock.hasRole(DEFAULT_ADMIN, address(controller)));
  }

  function test_roles_guardianEoaHasNone() public view {
    assertFalse(timelock.hasRole(PROPOSER, guardian));
    assertFalse(timelock.hasRole(EXECUTOR, guardian));
    assertFalse(timelock.hasRole(CANCELLER, guardian));
    assertFalse(timelock.hasRole(DEFAULT_ADMIN, guardian));
  }

  function test_roles_adminOnlySelf() public view {
    assertTrue(timelock.hasRole(DEFAULT_ADMIN, address(timelock)));
    address[6] memory others =
      [address(this), governanceSafe, guardian, address(controller), address(manager), address(0)];
    for (uint256 i = 0; i < others.length; ++i) {
      assertFalse(timelock.hasRole(DEFAULT_ADMIN, others[i]));
    }
  }

  function test_roles_deployerHasNone() public view {
    assertFalse(timelock.hasRole(PROPOSER, address(this)));
    assertFalse(timelock.hasRole(EXECUTOR, address(this)));
    assertFalse(timelock.hasRole(CANCELLER, address(this)));
    assertFalse(timelock.hasRole(DEFAULT_ADMIN, address(this)));
  }

  function test_roles_noOpenRoles() public view {
    assertFalse(timelock.hasRole(PROPOSER, address(0)));
    assertFalse(timelock.hasRole(EXECUTOR, address(0)));
    assertFalse(timelock.hasRole(CANCELLER, address(0)));
  }

  function test_roles_roleAdminsAreDefaultAdmin() public view {
    assertEq(timelock.getRoleAdmin(PROPOSER), DEFAULT_ADMIN);
    assertEq(timelock.getRoleAdmin(EXECUTOR), DEFAULT_ADMIN);
    assertEq(timelock.getRoleAdmin(CANCELLER), DEFAULT_ADMIN);
    assertEq(timelock.getRoleAdmin(DEFAULT_ADMIN), DEFAULT_ADMIN);
  }

  function test_regression_constructor_multipleProposersAllCancel() public {
    address[] memory proposers = new address[](3);
    proposers[0] = makeAddr("p0");
    proposers[1] = makeAddr("p1");
    proposers[2] = makeAddr("p2");
    SaharaTimelock t = _deploy(TIMELOCK_DELAY, proposers, proposers, new address[](0));
    for (uint256 i = 0; i < proposers.length; ++i) {
      assertTrue(t.hasRole(PROPOSER, proposers[i]));
      assertTrue(t.hasRole(CANCELLER, proposers[i]));
    }
  }

  /// @dev With no explicit cancellers, the proposer alone can cancel.
  function test_constructor_proposerCancelsWithoutExplicitCancellers() public {
    SaharaTimelock t = _deploy(TIMELOCK_DELAY, _single(governanceSafe), _single(governanceSafe), new address[](0));
    vm.prank(governanceSafe);
    t.schedule(address(manager), 0, _probeCall(1), 0, SALT, TIMELOCK_DELAY);
    bytes32 id = t.hashOperation(address(manager), 0, _probeCall(1), 0, SALT);

    vm.expectRevert(_unauthorized(attacker, CANCELLER));
    vm.prank(attacker);
    t.cancel(id);

    vm.prank(governanceSafe);
    t.cancel(id);
    assertFalse(t.isOperation(id));
  }

  /// @dev An account passed as both proposer and explicit canceller holds CANCELLER_ROLE once.
  function test_constructor_proposerAlsoExplicitCanceller() public {
    SaharaTimelock t =
      _deploy(TIMELOCK_DELAY, _single(governanceSafe), _single(governanceSafe), _single(governanceSafe));
    assertTrue(t.hasRole(PROPOSER, governanceSafe));
    assertTrue(t.hasRole(CANCELLER, governanceSafe));
  }

  function test_constructor_multipleCancellers() public {
    address[] memory cancellers = _pair(makeAddr("c0"), makeAddr("c1"));
    SaharaTimelock t = _deploy(TIMELOCK_DELAY, _single(governanceSafe), _single(governanceSafe), cancellers);
    assertTrue(t.hasRole(CANCELLER, cancellers[0]));
    assertTrue(t.hasRole(CANCELLER, cancellers[1]));
    assertFalse(t.hasRole(PROPOSER, cancellers[0]));
    assertFalse(t.hasRole(EXECUTOR, cancellers[0]));
  }

  // ================================================================
  // │                        Executor role                         │
  // ================================================================

  function test_closedExecutor_revertsForOthers() public {
    bytes memory data = _probeCall(1);
    _scheduleOp(address(manager), 0, data, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);

    address[4] memory callers = [attacker, guardian, address(controller), address(this)];
    for (uint256 i = 0; i < callers.length; ++i) {
      vm.expectRevert(_unauthorized(callers[i], EXECUTOR));
      vm.prank(callers[i]);
      timelock.execute(address(manager), 0, data, 0, SALT);
    }
    _executeOp(address(manager), 0, data, 0, SALT);
    assertEq(manager.maxFundingPerCall(), 1);
  }

  function test_closedExecutor_executeBatchRevertsForOthers() public {
    address[] memory targets = _targets1(address(manager));
    uint256[] memory values = _values1(0);
    bytes[] memory payloads = _payloads1(_probeCall(1));
    _scheduleBatchOp(targets, values, payloads, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);

    vm.expectRevert(_unauthorized(attacker, EXECUTOR));
    vm.prank(attacker);
    timelock.executeBatch(targets, values, payloads, 0, SALT);
  }

  function testFuzz_closedExecutor_revertsForNonExecutors(address caller) public {
    vm.assume(caller != governanceSafe);
    bytes memory data = _probeCall(3);
    _scheduleOp(address(manager), 0, data, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);

    vm.expectRevert(_unauthorized(caller, EXECUTOR));
    vm.prank(caller);
    timelock.execute(address(manager), 0, data, 0, SALT);
  }

  // ================================================================
  // │                   Proposer / canceller roles                 │
  // ================================================================

  function test_schedule_revertsForNonProposers() public {
    address[5] memory callers = [attacker, guardian, address(controller), address(timelock), address(this)];
    for (uint256 i = 0; i < callers.length; ++i) {
      vm.expectRevert(_unauthorized(callers[i], PROPOSER));
      vm.prank(callers[i]);
      timelock.schedule(address(manager), 0, _probeCall(1), 0, SALT, TIMELOCK_DELAY);

      vm.expectRevert(_unauthorized(callers[i], PROPOSER));
      vm.prank(callers[i]);
      timelock.scheduleBatch(
        _targets1(address(manager)), _values1(0), _payloads1(_probeCall(1)), 0, SALT, TIMELOCK_DELAY
      );
    }
  }

  function test_cancel_revertsForGuardianAndOthers() public {
    bytes32 id = _scheduleOp(address(manager), 0, _probeCall(1), 0, SALT);
    address[3] memory callers = [guardian, attacker, address(this)];
    for (uint256 i = 0; i < callers.length; ++i) {
      vm.expectRevert(_unauthorized(callers[i], CANCELLER));
      vm.prank(callers[i]);
      timelock.cancel(id);
    }
    assertTrue(timelock.isOperationPending(id));
  }

  /// @dev The controller holds the raw role; the restriction to eligible ops lives in the controller itself.
  function test_cancel_controllerRawRoleWorks() public {
    bytes32 id = _scheduleOp(address(manager), 0, _probeCall(1), 0, SALT);
    vm.expectEmit(true, false, false, true, address(timelock));
    emit TimelockController.Cancelled(id);
    vm.prank(address(controller));
    timelock.cancel(id);
    assertFalse(timelock.isOperation(id));
  }

  function test_grantRole_directCallRevertsForSafe() public {
    vm.expectRevert(_unauthorized(governanceSafe, DEFAULT_ADMIN));
    vm.prank(governanceSafe);
    timelock.grantRole(CANCELLER, attacker);

    vm.expectRevert(_unauthorized(guardian, DEFAULT_ADMIN));
    vm.prank(guardian);
    timelock.grantRole(CANCELLER, guardian);
  }

  function test_revokeRole_directCallRevertsForSafe() public {
    vm.expectRevert(_unauthorized(governanceSafe, DEFAULT_ADMIN));
    vm.prank(governanceSafe);
    timelock.revokeRole(CANCELLER, address(controller));
  }

  function test_grantRole_viaTimelockOp() public {
    address executor2 = makeAddr("executor2");
    _scheduleAndExecute(address(timelock), abi.encodeCall(IAccessControl.grantRole, (EXECUTOR, executor2)), SALT);
    assertTrue(timelock.hasRole(EXECUTOR, executor2));
  }

  /// @dev Governance can drop its own cancellation power through a timelocked op.
  function test_revokeRole_safeCancellerViaTimelockOp() public {
    _scheduleAndExecute(address(timelock), abi.encodeCall(IAccessControl.revokeRole, (CANCELLER, governanceSafe)), SALT);
    assertFalse(timelock.hasRole(CANCELLER, governanceSafe));
    assertTrue(timelock.hasRole(PROPOSER, governanceSafe));

    bytes32 id = _scheduleOp(address(manager), 0, _probeCall(1), 0, keccak256("after"));
    vm.expectRevert(_unauthorized(governanceSafe, CANCELLER));
    vm.prank(governanceSafe);
    timelock.cancel(id);
  }

  // ================================================================
  // │           Governance Safe cancellation (proposer)            │
  // ================================================================

  function _assertSafeCancels(bytes32 id) internal {
    vm.expectEmit(true, false, false, true, address(timelock));
    emit TimelockController.Cancelled(id);
    vm.prank(governanceSafe);
    timelock.cancel(id);
    assertFalse(timelock.isOperation(id), "op removed");
    assertEq(timelock.getTimestamp(id), 0, "timestamp cleared");
  }

  /// @dev Proposers keep the CANCELLER_ROLE OpenZeppelin grants them: the Safe withdraws an ordinary op directly.
  function test_regression_cancel_safeCancelsOrdinaryOp() public {
    bytes memory data = _probeCall(1);
    bytes32 id = _scheduleOp(address(manager), 0, data, 0, SALT);
    _assertSafeCancels(id);

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(_notReadyRevert(id));
    _executeOp(address(manager), 0, data, 0, SALT);
    assertEq(manager.maxFundingPerCall(), MAX_FUNDING_PER_CALL);
  }

  /// @dev The Safe can withdraw its own protected Guardian replacement; the Guardian still cannot cancel it, neither
  /// through the controller (ProtectedOperation) nor on the Timelock directly (no role).
  function test_regression_cancel_safeCancelsProtectedSingleSetGuardian() public {
    bytes memory data = _setGuardianCall(newGuardian);
    assertTrue(controller.isProtectedCall(address(manager), 0, data));
    bytes32 id = _scheduleOp(address(manager), 0, data, 0, SALT);

    vm.expectRevert(_protectedRevert(id));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, SALT);
    vm.expectRevert(_unauthorized(guardian, CANCELLER));
    vm.prank(guardian);
    timelock.cancel(id);
    assertTrue(timelock.isOperationPending(id));

    _assertSafeCancels(id);

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(_notReadyRevert(id));
    _executeOp(address(manager), 0, data, 0, SALT);
    assertEq(manager.guardian(), guardian);
  }

  /// @dev Same for the batch-of-one shape, cancelled once already Ready.
  function test_regression_cancel_safeCancelsProtectedBatchOfOneSetGuardian() public {
    address[] memory targets = _targets1(address(manager));
    uint256[] memory values = _values1(0);
    bytes[] memory payloads = _payloads1(_setGuardianCall(address(0)));
    bytes32 id = _scheduleBatchOp(targets, values, payloads, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    assertTrue(timelock.isOperationReady(id));

    vm.expectRevert(_protectedRevert(id));
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, SALT);
    vm.expectRevert(_unauthorized(guardian, CANCELLER));
    vm.prank(guardian);
    timelock.cancel(id);
    assertTrue(timelock.isOperationReady(id));

    _assertSafeCancels(id);

    vm.expectRevert(_notReadyRevert(id));
    _executeBatchOp(targets, values, payloads, 0, SALT);
    assertEq(manager.guardian(), guardian);
  }

  /// @dev With the Guardian removed nobody can cancel through the controller, but the Safe can still withdraw a
  /// mistaken reserve migration before it executes.
  function test_regression_cancel_safeCancelsMistakenMigrationWithNoGuardian() public {
    _scheduleAndExecute(address(manager), _setGuardianCall(address(0)), keccak256("remove guardian"));
    assertEq(manager.guardian(), address(0));

    address wrongDestination = makeAddr("wrongDestination");
    bytes memory mistaken = abi.encodeCall(LiquidityManager.migrateReserves, (wrongDestination, type(uint256).max));
    bytes32 id = _scheduleOp(address(manager), 0, mistaken, 0, SALT);

    vm.expectRevert(_notGuardianRevert(guardian));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, mistaken, 0, SALT);
    assertTrue(timelock.isOperationPending(id));

    _assertSafeCancels(id);

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(_notReadyRevert(id));
    _executeOp(address(manager), 0, mistaken, 0, SALT);
    assertEq(_balance(address(manager)), MANAGER_RESERVES);
    assertEq(_balance(wrongDestination), 0);
  }

  function test_cancel_safeCancelRevertsForNonPendingOps() public {
    bytes memory data = _probeCall(1);
    bytes32 id = timelock.hashOperation(address(manager), 0, data, 0, SALT);
    vm.expectRevert(_notPendingRevert(id));
    vm.prank(governanceSafe);
    timelock.cancel(id);

    _scheduleOp(address(manager), 0, data, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeOp(address(manager), 0, data, 0, SALT);
    vm.expectRevert(_notPendingRevert(id));
    vm.prank(governanceSafe);
    timelock.cancel(id);
    assertTrue(timelock.isOperationDone(id));
  }

  /// @dev The Safe can cancel any pending op, protected or not; the Guardian is refused on the protected ones.
  function testFuzz_regression_cancel_safeCancelsAnyPendingOp(
    bool protectedShape,
    address target,
    uint256 value,
    bytes memory data,
    bytes32 predecessor,
    bytes32 salt
  ) public {
    if (protectedShape) {
      data = _setGuardianCall(target);
      target = address(manager);
      value = 0;
    }
    bytes32 id = _scheduleOp(target, value, data, predecessor, salt);
    if (controller.isProtectedCall(target, value, data)) {
      vm.expectRevert(_protectedRevert(id));
      vm.prank(guardian);
      controller.cancel(target, value, data, predecessor, salt);
    }
    _assertSafeCancels(id);
  }

  // ================================================================
  // │                     Delay and its bounds                     │
  // ================================================================

  /// @dev updateDelay is fully overridden: only the Timelock itself, whatever the value.
  function test_regression_updateDelay_onlyTimelockItself() public {
    address[6] memory callers =
      [governanceSafe, guardian, address(controller), address(manager), attacker, address(this)];
    uint256[3] memory delays = [uint256(0), TIMELOCK_MINIMUM_DELAY, type(uint256).max];
    for (uint256 i = 0; i < callers.length; ++i) {
      for (uint256 j = 0; j < delays.length; ++j) {
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnauthorizedCaller.selector, callers[i]));
        vm.prank(callers[i]);
        timelock.updateDelay(delays[j]);
      }
    }
    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);
  }

  function testFuzz_regression_updateDelay_revertsForExternalCallers(address caller, uint256 newDelay) public {
    vm.assume(caller != address(timelock));
    vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnauthorizedCaller.selector, caller));
    vm.prank(caller);
    timelock.updateDelay(newDelay);
    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);
  }

  /// @dev A call from the Timelock itself (what an executed op does) enforces the bounds.
  function test_regression_updateDelay_selfCallEnforcesBounds() public {
    vm.startPrank(address(timelock));
    vm.expectRevert(_delayOutOfBounds(0));
    timelock.updateDelay(0);
    vm.expectRevert(_delayOutOfBounds(TIMELOCK_MINIMUM_DELAY - 1));
    timelock.updateDelay(TIMELOCK_MINIMUM_DELAY - 1);
    vm.expectRevert(_delayOutOfBounds(TIMELOCK_MAXIMUM_DELAY + 1));
    timelock.updateDelay(TIMELOCK_MAXIMUM_DELAY + 1);
    vm.expectRevert(_delayOutOfBounds(type(uint256).max));
    timelock.updateDelay(type(uint256).max);
    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);

    vm.expectEmit(false, false, false, true, address(timelock));
    emit TimelockController.MinDelayChange(TIMELOCK_DELAY, TIMELOCK_MAXIMUM_DELAY);
    timelock.updateDelay(TIMELOCK_MAXIMUM_DELAY);
    vm.stopPrank();
    assertEq(timelock.getMinDelay(), TIMELOCK_MAXIMUM_DELAY);
  }

  function test_schedule_revertsBelowCurrentDelay() public {
    vm.expectRevert(_insufficientDelay(TIMELOCK_DELAY - 1, TIMELOCK_DELAY));
    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(1), 0, SALT, TIMELOCK_DELAY - 1);

    vm.expectRevert(_insufficientDelay(TIMELOCK_MINIMUM_DELAY, TIMELOCK_DELAY));
    vm.prank(governanceSafe);
    timelock.scheduleBatch(
      _targets1(address(manager)), _values1(0), _payloads1(_probeCall(1)), 0, SALT, TIMELOCK_MINIMUM_DELAY
    );
  }

  /// @dev Delay changes themselves must wait the existing delay.
  function test_updateDelay_mustBeScheduledWithExistingDelay() public {
    vm.expectRevert(_insufficientDelay(TIMELOCK_MINIMUM_DELAY, TIMELOCK_DELAY));
    vm.prank(governanceSafe);
    timelock.schedule(address(timelock), 0, _updateDelayCall(TIMELOCK_MINIMUM_DELAY), 0, SALT, TIMELOCK_MINIMUM_DELAY);
  }

  function test_updateDelay_raiseViaTimelock() public {
    uint256 raised = 96 hours;
    _scheduleOp(address(timelock), 0, _updateDelayCall(raised), 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectEmit(false, false, false, true, address(timelock));
    emit TimelockController.MinDelayChange(TIMELOCK_DELAY, raised);
    _executeOp(address(timelock), 0, _updateDelayCall(raised), 0, SALT);
    assertEq(timelock.getMinDelay(), raised);

    vm.expectRevert(_insufficientDelay(TIMELOCK_DELAY, raised));
    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(1), 0, SALT, TIMELOCK_DELAY);

    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(1), 0, SALT, raised);
  }

  /// @dev An `updateDelay` below MINIMUM_DELAY can be scheduled (contents are not inspected) but its execution
  /// reverts with the bound violation: the delay is unchanged and the op stays Ready until withdrawn.
  function test_regression_updateDelay_belowMinimumRevertsAtExecution() public {
    bytes memory data = _updateDelayCall(1 hours);
    bytes32 id = _scheduleOp(address(timelock), 0, data, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);

    vm.expectRevert(_delayOutOfBounds(1 hours));
    _executeOp(address(timelock), 0, data, 0, SALT);
    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);
    assertTrue(timelock.isOperationReady(id));
    assertFalse(timelock.isOperationDone(id));

    // One second below the floor is rejected too.
    bytes memory justBelow = _updateDelayCall(TIMELOCK_MINIMUM_DELAY - 1);
    _scheduleOp(address(timelock), 0, justBelow, 0, keccak256("just below"));
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(_delayOutOfBounds(TIMELOCK_MINIMUM_DELAY - 1));
    _executeOp(address(timelock), 0, justBelow, 0, keccak256("just below"));
    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);

    // Scheduling still requires the unchanged delay.
    vm.expectRevert(_insufficientDelay(TIMELOCK_MINIMUM_DELAY, TIMELOCK_DELAY));
    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(1), 0, keccak256("a"), TIMELOCK_MINIMUM_DELAY);

    // The failed op lingers as Ready; the Safe can withdraw it.
    _assertSafeCancels(id);
  }

  function test_regression_updateDelay_zeroRevertsAtExecution() public {
    bytes memory data = _updateDelayCall(0);
    bytes32 id = _scheduleOp(address(timelock), 0, data, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(_delayOutOfBounds(0));
    _executeOp(address(timelock), 0, data, 0, SALT);
    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);
    assertTrue(timelock.isOperationReady(id));

    vm.expectRevert(_insufficientDelay(0, TIMELOCK_DELAY));
    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(1), 0, keccak256("b"), 0);
  }

  function test_regression_updateDelay_aboveMaximumRevertsAtExecution() public {
    bytes memory data = _updateDelayCall(TIMELOCK_MAXIMUM_DELAY + 1);
    bytes32 id = _scheduleOp(address(timelock), 0, data, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(_delayOutOfBounds(TIMELOCK_MAXIMUM_DELAY + 1));
    _executeOp(address(timelock), 0, data, 0, SALT);
    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);
    assertTrue(timelock.isOperationReady(id));
  }

  /// @dev updateDelay(type(uint256).max) used to make every later `schedule` revert (below-delay or
  /// `block.timestamp + delay` overflow), freezing all Timelock-owned administration including the protected Guardian
  /// recovery path. It now reverts at execution and the Timelock keeps working.
  function test_regression_updateDelay_maxUint256CannotFreezeTimelock() public {
    bytes memory brick = _updateDelayCall(type(uint256).max);
    assertFalse(controller.isProtectedCall(address(timelock), 0, brick));
    bytes32 id = _scheduleOp(address(timelock), 0, brick, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);

    vm.expectRevert(_delayOutOfBounds(type(uint256).max));
    _executeOp(address(timelock), 0, brick, 0, SALT);
    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);
    assertTrue(timelock.isOperationReady(id));

    // The protected recovery path still schedules and executes with the normal delay.
    _scheduleAndExecute(address(manager), _setGuardianCall(newGuardian), keccak256("recovery"));
    assertEq(manager.guardian(), newGuardian);
  }

  function test_updateDelay_unboundedValueIsCancellableByGuardian() public {
    bytes memory brick = _updateDelayCall(type(uint256).max);
    bytes32 id = _scheduleOp(address(timelock), 0, brick, 0, SALT);
    vm.prank(guardian);
    controller.cancel(address(timelock), 0, brick, 0, SALT);
    assertFalse(timelock.isOperation(id));
  }

  /// @dev Both bounds are inclusive, and at the ceiling the Timelock still schedules and executes.
  function test_regression_updateDelay_exactBoundsSucceed() public {
    bytes memory lower = _updateDelayCall(TIMELOCK_MINIMUM_DELAY);
    _scheduleOp(address(timelock), 0, lower, 0, keccak256("min"));
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectEmit(false, false, false, true, address(timelock));
    emit TimelockController.MinDelayChange(TIMELOCK_DELAY, TIMELOCK_MINIMUM_DELAY);
    _executeOp(address(timelock), 0, lower, 0, keccak256("min"));
    assertEq(timelock.getMinDelay(), TIMELOCK_MINIMUM_DELAY);

    bytes memory raise = _updateDelayCall(TIMELOCK_MAXIMUM_DELAY);
    vm.prank(governanceSafe);
    timelock.schedule(address(timelock), 0, raise, 0, keccak256("max"), TIMELOCK_MINIMUM_DELAY);
    vm.warp(block.timestamp + TIMELOCK_MINIMUM_DELAY);
    vm.expectEmit(false, false, false, true, address(timelock));
    emit TimelockController.MinDelayChange(TIMELOCK_MINIMUM_DELAY, TIMELOCK_MAXIMUM_DELAY);
    _executeOp(address(timelock), 0, raise, 0, keccak256("max"));
    assertEq(timelock.getMinDelay(), TIMELOCK_MAXIMUM_DELAY);

    vm.expectRevert(_insufficientDelay(TIMELOCK_MAXIMUM_DELAY - 1, TIMELOCK_MAXIMUM_DELAY));
    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(5), 0, keccak256("p"), TIMELOCK_MAXIMUM_DELAY - 1);
    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(5), 0, keccak256("p"), TIMELOCK_MAXIMUM_DELAY);
    vm.warp(block.timestamp + TIMELOCK_MAXIMUM_DELAY);
    _executeOp(address(manager), 0, _probeCall(5), 0, keccak256("p"));
    assertEq(manager.maxFundingPerCall(), 5);
  }

  /// @dev After lowering to the floor, raising back is scheduled with the lowered delay and honoured exactly.
  function test_updateDelay_lowerThenRaise() public {
    _scheduleAndExecute(address(timelock), _updateDelayCall(TIMELOCK_MINIMUM_DELAY), keccak256("low"));
    assertEq(timelock.getMinDelay(), TIMELOCK_MINIMUM_DELAY);

    // Exactly the floor works and is enforced at execution.
    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(9), 0, keccak256("a"), TIMELOCK_MINIMUM_DELAY);
    vm.warp(block.timestamp + TIMELOCK_MINIMUM_DELAY - 1);
    vm.expectRevert(_notReadyRevert(timelock.hashOperation(address(manager), 0, _probeCall(9), 0, keccak256("a"))));
    _executeOp(address(manager), 0, _probeCall(9), 0, keccak256("a"));
    vm.warp(block.timestamp + 1);
    _executeOp(address(manager), 0, _probeCall(9), 0, keccak256("a"));
    assertEq(manager.maxFundingPerCall(), 9);

    vm.prank(governanceSafe);
    timelock.schedule(
      address(timelock), 0, _updateDelayCall(TIMELOCK_DELAY), 0, keccak256("high"), TIMELOCK_MINIMUM_DELAY
    );
    vm.warp(block.timestamp + TIMELOCK_MINIMUM_DELAY);
    _executeOp(address(timelock), 0, _updateDelayCall(TIMELOCK_DELAY), 0, keccak256("high"));
    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);
  }

  /// @dev MinDelayChange reports the delay actually in force before each change, and getMinDelay follows every
  /// update.
  function test_regression_updateDelay_minDelayChangeReportsPreviousDelay() public {
    uint256 raised = 96 hours;
    uint256 lowered = 48 hours;

    _scheduleOp(address(timelock), 0, _updateDelayCall(raised), 0, keccak256("raise"));
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectEmit(false, false, false, true, address(timelock));
    emit TimelockController.MinDelayChange(TIMELOCK_DELAY, raised);
    _executeOp(address(timelock), 0, _updateDelayCall(raised), 0, keccak256("raise"));
    assertEq(timelock.getMinDelay(), raised);

    vm.prank(governanceSafe);
    timelock.schedule(address(timelock), 0, _updateDelayCall(lowered), 0, keccak256("lower"), raised);
    vm.warp(block.timestamp + raised);
    vm.recordLogs();
    _executeOp(address(timelock), 0, _updateDelayCall(lowered), 0, keccak256("lower"));
    Vm.Log[] memory logs = vm.getRecordedLogs();
    uint256 changes;
    for (uint256 i = 0; i < logs.length; ++i) {
      if (logs[i].emitter != address(timelock) || logs[i].topics[0] != TimelockController.MinDelayChange.selector) {
        continue;
      }
      (uint256 oldDuration, uint256 newDuration) = abi.decode(logs[i].data, (uint256, uint256));
      assertEq(oldDuration, raised, "old = stored delay");
      assertEq(newDuration, lowered, "new delay");
      ++changes;
    }
    assertEq(changes, 1, "one MinDelayChange");
    assertEq(timelock.getMinDelay(), lowered);

    vm.expectRevert(_insufficientDelay(lowered - 1, lowered));
    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(1), 0, keccak256("x"), lowered - 1);
    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(1), 0, keccak256("x"), lowered);
  }

  /// @dev In range: executes, emits (old, new) and getMinDelay follows. Out of range: the execution reverts and nothing
  /// changes.
  function testFuzz_regression_updateDelay_boundsEnforcedAtExecution(uint256 newDelay) public {
    newDelay = bound(newDelay, 0, 2 * TIMELOCK_MAXIMUM_DELAY);
    bytes memory data = _updateDelayCall(newDelay);
    bytes32 id = _scheduleOp(address(timelock), 0, data, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);

    if (newDelay < TIMELOCK_MINIMUM_DELAY || newDelay > TIMELOCK_MAXIMUM_DELAY) {
      vm.expectRevert(_delayOutOfBounds(newDelay));
      _executeOp(address(timelock), 0, data, 0, SALT);
      assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);
      assertTrue(timelock.isOperationReady(id));
    } else {
      vm.expectEmit(false, false, false, true, address(timelock));
      emit TimelockController.MinDelayChange(TIMELOCK_DELAY, newDelay);
      _executeOp(address(timelock), 0, data, 0, SALT);
      assertEq(timelock.getMinDelay(), newDelay);
      assertTrue(timelock.isOperationDone(id));
    }
    assertGe(timelock.getMinDelay(), timelock.MINIMUM_DELAY());
    assertLe(timelock.getMinDelay(), timelock.MAXIMUM_DELAY());
  }

  function testFuzz_regression_updateDelay_aboveMaximumAlwaysReverts(uint256 newDelay) public {
    newDelay = bound(newDelay, TIMELOCK_MAXIMUM_DELAY + 1, type(uint256).max);
    vm.expectRevert(_delayOutOfBounds(newDelay));
    vm.prank(address(timelock));
    timelock.updateDelay(newDelay);
    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);
  }

  function testFuzz_schedule_respectsUpdatedDelay(uint256 newDelay, uint256 delay) public {
    newDelay = bound(newDelay, TIMELOCK_MINIMUM_DELAY, TIMELOCK_MAXIMUM_DELAY);
    delay = bound(delay, 0, 7300 days);
    _scheduleAndExecute(address(timelock), _updateDelayCall(newDelay), SALT);
    assertEq(timelock.getMinDelay(), newDelay);

    if (delay < newDelay) {
      vm.expectRevert(_insufficientDelay(delay, newDelay));
    }
    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(1), 0, keccak256("fuzz"), delay);
    if (delay >= newDelay) {
      bytes32 id = timelock.hashOperation(address(manager), 0, _probeCall(1), 0, keccak256("fuzz"));
      assertEq(timelock.getTimestamp(id), block.timestamp + delay);
    }
  }

  // ================================================================
  // │                  Inherited Timelock behaviour                │
  // ================================================================

  function test_schedule_duplicateReverts() public {
    bytes32 id = _scheduleOp(address(manager), 0, _probeCall(1), 0, SALT);
    vm.expectRevert(
      abi.encodeWithSelector(TimelockController.TimelockUnexpectedOperationState.selector, id, _unsetBitmap())
    );
    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(1), 0, SALT, TIMELOCK_DELAY);
  }

  function test_execute_revertsBeforeReady() public {
    bytes32 id = _scheduleOp(address(manager), 0, _probeCall(1), 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY - 1);
    vm.expectRevert(_notReadyRevert(id));
    _executeOp(address(manager), 0, _probeCall(1), 0, SALT);
  }

  function test_execute_revertsWithUnexecutedPredecessor() public {
    bytes32 predecessor = _scheduleOp(address(manager), 0, _probeCall(1), 0, keccak256("pred"));
    _scheduleOp(address(manager), 0, _probeCall(2), predecessor, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnexecutedPredecessor.selector, predecessor));
    _executeOp(address(manager), 0, _probeCall(2), predecessor, SALT);

    _executeOp(address(manager), 0, _probeCall(1), 0, keccak256("pred"));
    _executeOp(address(manager), 0, _probeCall(2), predecessor, SALT);
    assertEq(manager.maxFundingPerCall(), 2);
  }

  function test_executedOpCannotBeReplayed() public {
    bytes32 id = _scheduleOp(address(manager), 0, _probeCall(1), 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeOp(address(manager), 0, _probeCall(1), 0, SALT);
    vm.expectRevert(_notReadyRevert(id));
    _executeOp(address(manager), 0, _probeCall(1), 0, SALT);
    vm.expectRevert(
      abi.encodeWithSelector(TimelockController.TimelockUnexpectedOperationState.selector, id, _unsetBitmap())
    );
    vm.prank(governanceSafe);
    timelock.schedule(address(manager), 0, _probeCall(1), 0, SALT, TIMELOCK_DELAY);
  }

  function test_scheduleBatch_lengthMismatchReverts() public {
    vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockInvalidOperationLength.selector, 2, 1, 1));
    vm.prank(governanceSafe);
    timelock.scheduleBatch(
      _targets2(address(manager), address(manager)), _values1(0), _payloads1(_probeCall(1)), 0, SALT, TIMELOCK_DELAY
    );
  }

  function test_timelock_ownsManagerPoolAndToken() public view {
    assertEq(manager.owner(), address(timelock));
    assertEq(pool.owner(), address(timelock));
    assertEq(token.owner(), address(timelock));
    assertEq(registry.getTokenConfig(address(token)).administrator, address(timelock));
  }

  function test_timelock_acceptsEthAndForwardsValueOnlyViaOps() public {
    vm.deal(address(this), 1 ether);
    (bool ok,) = address(timelock).call{value: 1 ether}("");
    assertTrue(ok);
    assertEq(address(timelock).balance, 1 ether);

    address recipient = makeAddr("ethRecipient");
    _scheduleOp(recipient, 1 ether, "", 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeOp(recipient, 1 ether, "", 0, SALT);
    assertEq(recipient.balance, 1 ether);
  }
}
