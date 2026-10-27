// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Errors} from "@openzeppelin/contracts/utils/Errors.sol";

import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";

import {ControllerTimelockBase} from "test/controller-timelock/utils/ControllerTimelockBase.sol";

/// @notice GuardianController cancellation: eligible proposals, protected Guardian removal, access control and the
/// exact protected-operation predicate.
contract GuardianControllerTest is ControllerTimelockBase {
  bytes32 internal constant SALT = keccak256("salt");

  // ================================================================
  // │                         Constructor                          │
  // ================================================================

  function test_constructor_setsImmutables() public view {
    assertEq(address(controller.MANAGER()), address(manager));
    assertEq(address(controller.TIMELOCK()), address(timelock));
  }

  function test_constructor_revertsOnZeroManager() public {
    vm.expectRevert(GuardianController.ZeroAddress.selector);
    new GuardianController(ILiquidityManager(address(0)), timelock);
  }

  function test_constructor_revertsOnZeroTimelock() public {
    vm.expectRevert(GuardianController.ZeroAddress.selector);
    new GuardianController(manager, TimelockController(payable(address(0))));
  }

  function test_fixture_controllerHoldsCancellerAndRateLimitAdmin() public view {
    assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), address(controller)));
    assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), address(controller)));
    assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(controller)));
    assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(controller)));
    assertEq(pool.getRateLimitAdmin(), address(controller));
    assertEq(manager.guardian(), guardian);
  }

  // ================================================================
  // │                Cancel ordinary single operations             │
  // ================================================================

  /// @dev Schedules, cancels through the controller as the Guardian, checks events, state and that the op can no
  /// longer execute after the delay.
  function _assertGuardianCancels(address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt)
    internal
    returns (bytes32 id)
  {
    id = _scheduleOp(target, value, data, predecessor, salt);

    vm.expectEmit(true, false, false, true, address(timelock));
    emit TimelockController.Cancelled(id);
    vm.expectEmit(true, true, false, true, address(controller));
    emit GuardianController.ProposalCancelled(id, guardian);
    vm.prank(guardian);
    controller.cancel(target, value, data, predecessor, salt);

    assertFalse(timelock.isOperation(id), "op removed");
    assertEq(timelock.getTimestamp(id), 0, "timestamp cleared");

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(
      abi.encodeWithSelector(TimelockController.TimelockUnexpectedOperationState.selector, id, _readyBitmap())
    );
    _executeOp(target, value, data, predecessor, salt);
  }

  function test_cancel_setFundingPausedFalse() public {
    vm.prank(guardian);
    manager.pauseFunding();
    _assertGuardianCancels(address(manager), 0, abi.encodeCall(LiquidityManager.setFundingPaused, (false)), 0, SALT);
    assertTrue(manager.fundingPaused(), "still paused");
  }

  function test_cancel_setMaxFundingPerCall() public {
    _assertGuardianCancels(
      address(manager), 0, abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (type(uint256).max)), 0, SALT
    );
    assertEq(manager.maxFundingPerCall(), MAX_FUNDING_PER_CALL);
  }

  function test_cancel_timelockGrantRole() public {
    bytes32 proposerRole = timelock.PROPOSER_ROLE();
    _assertGuardianCancels(
      address(timelock), 0, abi.encodeCall(IAccessControl.grantRole, (proposerRole, attacker)), 0, SALT
    );
    assertFalse(timelock.hasRole(proposerRole, attacker));
  }

  function test_cancel_timelockGrantCancellerRoleToGuardian() public {
    bytes32 cancellerRole = timelock.CANCELLER_ROLE();
    _assertGuardianCancels(
      address(timelock), 0, abi.encodeCall(IAccessControl.grantRole, (cancellerRole, guardian)), 0, SALT
    );
    assertFalse(timelock.hasRole(cancellerRole, guardian));
  }

  function test_cancel_timelockRevokeControllerCancellerRole() public {
    bytes32 cancellerRole = timelock.CANCELLER_ROLE();
    _assertGuardianCancels(
      address(timelock), 0, abi.encodeCall(IAccessControl.revokeRole, (cancellerRole, address(controller))), 0, SALT
    );
    assertTrue(timelock.hasRole(cancellerRole, address(controller)));
  }

  function test_cancel_timelockUpdateDelay() public {
    _assertGuardianCancels(
      address(timelock), 0, abi.encodeCall(TimelockController.updateDelay, (TIMELOCK_MINIMUM_DELAY)), 0, SALT
    );
    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY);
  }

  function test_cancel_migrateReserves() public {
    uint256 reserves = _balance(address(manager));
    _assertGuardianCancels(
      address(manager), 0, abi.encodeCall(LiquidityManager.migrateReserves, (attacker, reserves)), 0, SALT
    );
    assertEq(_balance(address(manager)), reserves);
    assertEq(_balance(attacker), 0);
  }

  function test_cancel_managerTransferOwnership() public {
    _assertGuardianCancels(address(manager), 0, abi.encodeCall(manager.transferOwnership, (attacker)), 0, SALT);
    assertEq(manager.pendingOwner(), address(0));
  }

  function test_cancel_poolAdministration() public {
    _assertGuardianCancels(
      address(pool), 0, abi.encodeCall(MockLockReleaseTokenPool.setRebalancer, (attacker)), 0, keccak256("a")
    );
    _assertGuardianCancels(
      address(pool), 0, abi.encodeCall(MockLockReleaseTokenPool.setRateLimitAdmin, (attacker)), 0, keccak256("b")
    );
    _assertGuardianCancels(
      address(pool), 0, abi.encodeCall(MockLockReleaseTokenPool.transferOwnership, (attacker)), 0, keccak256("c")
    );
    assertEq(pool.getRebalancer(), address(adapter));
    assertEq(pool.getRateLimitAdmin(), address(controller));
    assertEq(pool.owner(), address(timelock));
  }

  function test_cancel_poolRateLimitRestoration() public {
    _assertGuardianCancels(
      address(pool),
      0,
      _restoreCall(REMOTE_CHAIN_SELECTOR, _ccipBucket(type(uint128).max, 1), _ccipBucket(type(uint128).max, 1)),
      0,
      SALT
    );
  }

  function test_cancel_managerRoleGrantsAndAdapterChanges() public {
    _assertGuardianCancels(
      address(manager), 0, abi.encodeCall(LiquidityManager.setFundingOperator, (attacker, true)), 0, keccak256("1")
    );
    _assertGuardianCancels(
      address(manager), 0, abi.encodeCall(LiquidityManager.setRecallOperator, (attacker, true)), 0, keccak256("2")
    );
    _assertGuardianCancels(
      address(manager), 0, abi.encodeCall(LiquidityManager.replaceAdapter, (adapterId, attacker)), 0, keccak256("3")
    );
    _assertGuardianCancels(
      address(manager), 0, abi.encodeCall(LiquidityManager.setAdapterStatus, (adapterId, true, true)), 0, keccak256("4")
    );
    _assertGuardianCancels(
      address(manager),
      0,
      abi.encodeCall(LiquidityManager.setPoolMigrationApproval, (attacker, address(pool))),
      0,
      keccak256("5")
    );
    _assertGuardianCancels(
      address(manager), 0, abi.encodeCall(LiquidityManager.recoverToken, (attacker, attacker, 1)), 0, keccak256("6")
    );
  }

  function test_cancel_operationWithPredecessorAndSalt() public {
    bytes32 predecessor =
      _scheduleOp(address(manager), 0, abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (1)), 0, keccak256("pred"));
    _assertGuardianCancels(
      address(manager), 0, abi.encodeCall(LiquidityManager.setFundingPaused, (false)), predecessor, keccak256("x")
    );
    // The predecessor is untouched.
    assertTrue(timelock.isOperationPending(predecessor));
  }

  function test_cancel_operationWithValue() public {
    _assertGuardianCancels(attacker, 1 ether, "", 0, SALT);
  }

  function test_cancel_readyOperation() public {
    bytes memory data = abi.encodeCall(LiquidityManager.setFundingPaused, (false));
    bytes32 id = _scheduleOp(address(manager), 0, data, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    assertTrue(timelock.isOperationReady(id));

    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, SALT);
    assertFalse(timelock.isOperation(id));
  }

  function test_cancel_doesNotAffectOtherOperations() public {
    bytes memory a = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (1));
    bytes memory b = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (2));
    bytes32 idA = _scheduleOp(address(manager), 0, a, 0, SALT);
    bytes32 idB = _scheduleOp(address(manager), 0, b, 0, SALT);

    vm.prank(guardian);
    controller.cancel(address(manager), 0, a, 0, SALT);
    assertFalse(timelock.isOperation(idA));
    assertTrue(timelock.isOperationPending(idB));
  }

  /// @dev A cancelled operation can be scheduled again and then executes normally.
  function test_cancel_operationCanBeRescheduled() public {
    bytes memory data = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (7));
    bytes32 id = _scheduleOp(address(manager), 0, data, 0, SALT);
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, SALT);

    assertEq(_scheduleOp(address(manager), 0, data, 0, SALT), id);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeOp(address(manager), 0, data, 0, SALT);
    assertEq(manager.maxFundingPerCall(), 7);
  }

  // ================================================================
  // │                       Cancel batches                         │
  // ================================================================

  function _assertGuardianCancelsBatch(
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory payloads,
    bytes32 predecessor,
    bytes32 salt
  ) internal returns (bytes32 id) {
    id = _scheduleBatchOp(targets, values, payloads, predecessor, salt);

    vm.expectEmit(true, false, false, true, address(timelock));
    emit TimelockController.Cancelled(id);
    vm.expectEmit(true, true, false, true, address(controller));
    emit GuardianController.ProposalCancelled(id, guardian);
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, predecessor, salt);

    assertFalse(timelock.isOperation(id), "batch removed");

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(
      abi.encodeWithSelector(TimelockController.TimelockUnexpectedOperationState.selector, id, _readyBitmap())
    );
    _executeBatchOp(targets, values, payloads, predecessor, salt);
  }

  function test_cancelBatch_ordinaryBatch() public {
    _assertGuardianCancelsBatch(
      _targets2(address(manager), address(manager)),
      _values2(0, 0),
      _payloads2(
        abi.encodeCall(LiquidityManager.setFundingPaused, (false)),
        abi.encodeCall(LiquidityManager.setRecallPaused, (false))
      ),
      0,
      SALT
    );
  }

  function test_cancelBatch_singleOrdinaryCall() public {
    _assertGuardianCancelsBatch(
      _targets1(address(manager)),
      _values1(0),
      _payloads1(abi.encodeCall(LiquidityManager.migrateReserves, (attacker, 1))),
      0,
      SALT
    );
  }

  function test_cancelBatch_mixedSetGuardianThenOther() public {
    _assertGuardianCancelsBatch(
      _targets2(address(manager), address(manager)),
      _values2(0, 0),
      _payloads2(_setGuardianCall(newGuardian), abi.encodeCall(LiquidityManager.setFundingPaused, (false))),
      0,
      SALT
    );
    assertEq(manager.guardian(), guardian);
  }

  function test_cancelBatch_mixedOtherThenSetGuardian() public {
    _assertGuardianCancelsBatch(
      _targets2(address(manager), address(manager)),
      _values2(0, 0),
      _payloads2(abi.encodeCall(LiquidityManager.setFundingPaused, (false)), _setGuardianCall(newGuardian)),
      0,
      SALT
    );
  }

  function test_cancelBatch_mixedAcrossTargets() public {
    _assertGuardianCancelsBatch(
      _targets2(address(manager), address(pool)),
      _values2(0, 0),
      _payloads2(_setGuardianCall(newGuardian), abi.encodeCall(MockLockReleaseTokenPool.setRebalancer, (attacker))),
      0,
      SALT
    );
  }

  function test_cancelBatch_twoSetGuardianCalls() public {
    _assertGuardianCancelsBatch(
      _targets2(address(manager), address(manager)),
      _values2(0, 0),
      _payloads2(_setGuardianCall(newGuardian), _setGuardianCall(attacker)),
      0,
      SALT
    );
  }

  function test_cancelBatch_twoIdenticalSetGuardianCalls() public {
    _assertGuardianCancelsBatch(
      _targets2(address(manager), address(manager)),
      _values2(0, 0),
      _payloads2(_setGuardianCall(newGuardian), _setGuardianCall(newGuardian)),
      0,
      SALT
    );
  }

  function test_cancelBatch_emptyBatch() public {
    _assertGuardianCancelsBatch(new address[](0), new uint256[](0), new bytes[](0), 0, SALT);
  }

  function test_cancelBatch_batchOfOneSetGuardianWithValue() public {
    _assertGuardianCancelsBatch(
      _targets1(address(manager)), _values1(1), _payloads1(_setGuardianCall(newGuardian)), 0, SALT
    );
  }

  function test_cancelBatch_batchOfOneSetGuardianOtherTarget() public {
    _assertGuardianCancelsBatch(
      _targets1(address(timelock)), _values1(0), _payloads1(_setGuardianCall(newGuardian)), 0, SALT
    );
  }

  function test_cancelBatch_batchOfOneSetGuardianTrailingByte() public {
    _assertGuardianCancelsBatch(
      _targets1(address(manager)),
      _values1(0),
      _payloads1(bytes.concat(_setGuardianCall(newGuardian), hex"00")),
      0,
      SALT
    );
  }

  function test_cancelBatch_batchOfOneSetGuardianDirtyBits() public {
    _assertGuardianCancelsBatch(
      _targets1(address(manager)),
      _values1(0),
      _payloads1(
        bytes.concat(
          ILiquidityManager.setGuardian.selector, bytes32(uint256(uint160(newGuardian)) | (uint256(1) << 160))
        )
      ),
      0,
      SALT
    );
  }

  function test_cancelBatch_readyBatch() public {
    address[] memory targets = _targets2(address(manager), address(manager));
    uint256[] memory values = _values2(0, 0);
    bytes[] memory payloads =
      _payloads2(_setGuardianCall(newGuardian), abi.encodeCall(LiquidityManager.setFundingPaused, (false)));
    bytes32 id = _scheduleBatchOp(targets, values, payloads, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    assertTrue(timelock.isOperationReady(id));

    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, SALT);
    assertFalse(timelock.isOperation(id));
  }

  // ================================================================
  // │                  Access control and ordering                 │
  // ================================================================

  function testFuzz_cancel_revertsForNonGuardian(address caller) public {
    vm.assume(caller != guardian);
    bytes memory data = abi.encodeCall(LiquidityManager.setFundingPaused, (false));
    bytes32 id = _scheduleOp(address(manager), 0, data, 0, SALT);

    vm.expectRevert(_notGuardianRevert(caller));
    vm.prank(caller);
    controller.cancel(address(manager), 0, data, 0, SALT);
    assertTrue(timelock.isOperationPending(id));
  }

  function testFuzz_cancelBatch_revertsForNonGuardian(address caller) public {
    vm.assume(caller != guardian);
    address[] memory targets = _targets1(address(manager));
    uint256[] memory values = _values1(0);
    bytes[] memory payloads = _payloads1(abi.encodeCall(LiquidityManager.setFundingPaused, (false)));
    bytes32 id = _scheduleBatchOp(targets, values, payloads, 0, SALT);

    vm.expectRevert(_notGuardianRevert(caller));
    vm.prank(caller);
    controller.cancelBatch(targets, values, payloads, 0, SALT);
    assertTrue(timelock.isOperationPending(id));
  }

  function test_cancel_revertsForPrivilegedNonGuardians() public {
    bytes memory data = abi.encodeCall(LiquidityManager.setFundingPaused, (false));
    _scheduleOp(address(manager), 0, data, 0, SALT);

    address[6] memory callers =
      [governanceSafe, address(timelock), address(manager), address(controller), fundingOperator, recallOperator];
    for (uint256 i = 0; i < callers.length; ++i) {
      vm.expectRevert(_notGuardianRevert(callers[i]));
      vm.prank(callers[i]);
      controller.cancel(address(manager), 0, data, 0, SALT);
    }
  }

  /// @dev The guardian check runs before the protected-operation check.
  function test_cancel_nonGuardianOnProtectedOp_revertsCallerNotGuardian() public {
    bytes memory data = _setGuardianCall(attacker);
    _scheduleOp(address(manager), 0, data, 0, SALT);

    vm.expectRevert(_notGuardianRevert(attacker));
    vm.prank(attacker);
    controller.cancel(address(manager), 0, data, 0, SALT);

    vm.expectRevert(_notGuardianRevert(attacker));
    vm.prank(attacker);
    controller.cancelBatch(_targets1(address(manager)), _values1(0), _payloads1(data), 0, SALT);
  }

  /// @dev Protection is decided from the contents alone, before the Timelock is called.
  function test_cancel_protectedUnscheduledOp_revertsProtectedOperation() public {
    bytes memory data = _setGuardianCall(newGuardian);
    bytes32 id = timelock.hashOperation(address(manager), 0, data, 0, SALT);
    assertFalse(timelock.isOperation(id));

    vm.expectRevert(_protectedRevert(id));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, SALT);

    bytes32 batchId = timelock.hashOperationBatch(_targets1(address(manager)), _values1(0), _payloads1(data), 0, SALT);
    vm.expectRevert(_protectedRevert(batchId));
    vm.prank(guardian);
    controller.cancelBatch(_targets1(address(manager)), _values1(0), _payloads1(data), 0, SALT);
  }

  function test_cancel_guardianRemoved_nobodyCanCancel() public {
    vm.prank(address(timelock));
    manager.setGuardian(address(0));

    bytes memory data = abi.encodeCall(LiquidityManager.setFundingPaused, (false));
    bytes32 id = _scheduleOp(address(manager), 0, data, 0, SALT);

    vm.expectRevert(_notGuardianRevert(guardian));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, SALT);
    assertTrue(timelock.isOperationPending(id));
  }

  /// @dev The guardian is read live from the Manager on every call.
  function test_cancel_followsManagerGuardian() public {
    vm.prank(address(timelock));
    manager.setGuardian(newGuardian);

    bytes memory data = abi.encodeCall(LiquidityManager.setFundingPaused, (false));
    bytes32 id = _scheduleOp(address(manager), 0, data, 0, SALT);

    vm.expectRevert(_notGuardianRevert(guardian));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, SALT);

    vm.expectEmit(true, true, false, true, address(controller));
    emit GuardianController.ProposalCancelled(id, newGuardian);
    vm.prank(newGuardian);
    controller.cancel(address(manager), 0, data, 0, SALT);
    assertFalse(timelock.isOperation(id));
  }

  /// @dev The Guardian EOA holds no Timelock role: it cannot cancel an id directly, bypassing the controller.
  function test_guardian_cannotCancelOnTimelockDirectly() public {
    bytes32 id = _scheduleOp(address(manager), 0, _setGuardianCall(newGuardian), 0, SALT);
    bytes32 cancellerRole = timelock.CANCELLER_ROLE();

    vm.expectRevert(
      abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, cancellerRole)
    );
    vm.prank(guardian);
    timelock.cancel(id);
    assertTrue(timelock.isOperationPending(id));
  }

  /// @dev The controller exposes no id-based cancel: an id cannot be cancelled without revealing its contents.
  function test_controller_hasNoIdBasedCancel() public {
    bytes32 id = _scheduleOp(address(manager), 0, _setGuardianCall(newGuardian), 0, SALT);

    vm.prank(guardian);
    (bool ok,) = address(controller).call(abi.encodeWithSignature("cancel(bytes32)", id));
    assertFalse(ok, "cancel(bytes32) must not exist");

    vm.prank(guardian);
    (ok,) = address(controller).call(abi.encodeWithSelector(TimelockController.cancel.selector, id));
    assertFalse(ok, "Timelock cancel selector must not exist");

    vm.prank(guardian);
    (ok,) = address(controller).call(abi.encodePacked(id));
    assertFalse(ok, "no fallback");

    assertTrue(timelock.isOperationPending(id));
  }

  /// @dev Once governance revokes the controller's CANCELLER_ROLE, cancellation fails at the Timelock.
  function test_cancel_revertsWhenControllerLosesCancellerRole() public {
    bytes32 cancellerRole = timelock.CANCELLER_ROLE();
    _scheduleAndExecute(
      address(timelock), abi.encodeCall(IAccessControl.revokeRole, (cancellerRole, address(controller))), SALT
    );
    assertFalse(timelock.hasRole(cancellerRole, address(controller)));

    bytes memory data = abi.encodeCall(LiquidityManager.setFundingPaused, (false));
    bytes32 id = _scheduleOp(address(manager), 0, data, 0, keccak256("other"));
    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector, address(controller), cancellerRole
      )
    );
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, keccak256("other"));
    assertTrue(timelock.isOperationPending(id));
  }

  // ================================================================
  // │              Timelock state errors (non-pending)             │
  // ================================================================

  function test_cancel_revertsForUnknownOperation() public {
    bytes memory data = abi.encodeCall(LiquidityManager.setFundingPaused, (false));
    bytes32 id = timelock.hashOperation(address(manager), 0, data, 0, SALT);
    vm.expectRevert(_notPendingRevert(id));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, SALT);
  }

  function test_cancel_revertsForExecutedOperation() public {
    bytes memory data = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (1));
    bytes32 id = _scheduleOp(address(manager), 0, data, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeOp(address(manager), 0, data, 0, SALT);
    assertTrue(timelock.isOperationDone(id));

    vm.expectRevert(_notPendingRevert(id));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, SALT);
    assertTrue(timelock.isOperationDone(id));
  }

  function test_cancel_revertsForAlreadyCancelledOperation() public {
    bytes memory data = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (1));
    bytes32 id = _scheduleOp(address(manager), 0, data, 0, SALT);
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, SALT);

    vm.expectRevert(_notPendingRevert(id));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, SALT);
  }

  /// @dev Each field of the operation is bound to the id: changing any one of them misses the scheduled op.
  function test_cancel_revertsWhenAnyFieldDiffers() public {
    bytes memory data = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (1));
    bytes32 predecessor = keccak256("pred");
    bytes32 id = _scheduleOp(address(manager), 0, data, predecessor, SALT);

    bytes memory otherData = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (2));
    vm.startPrank(guardian);
    vm.expectRevert(_notPendingRevert(timelock.hashOperation(address(pool), 0, data, predecessor, SALT)));
    controller.cancel(address(pool), 0, data, predecessor, SALT);
    vm.expectRevert(_notPendingRevert(timelock.hashOperation(address(manager), 1, data, predecessor, SALT)));
    controller.cancel(address(manager), 1, data, predecessor, SALT);
    vm.expectRevert(_notPendingRevert(timelock.hashOperation(address(manager), 0, otherData, predecessor, SALT)));
    controller.cancel(address(manager), 0, otherData, predecessor, SALT);
    vm.expectRevert(_notPendingRevert(timelock.hashOperation(address(manager), 0, data, bytes32(0), SALT)));
    controller.cancel(address(manager), 0, data, bytes32(0), SALT);
    vm.expectRevert(_notPendingRevert(timelock.hashOperation(address(manager), 0, data, predecessor, bytes32(0))));
    controller.cancel(address(manager), 0, data, predecessor, bytes32(0));
    vm.stopPrank();

    assertTrue(timelock.isOperationPending(id));
  }

  function test_cancelBatch_revertsForUnknownBatch() public {
    address[] memory targets = _targets2(address(manager), address(manager));
    uint256[] memory values = _values2(0, 0);
    bytes[] memory payloads = _payloads2(_setGuardianCall(newGuardian), _setGuardianCall(attacker));
    bytes32 id = timelock.hashOperationBatch(targets, values, payloads, 0, SALT);
    vm.expectRevert(_notPendingRevert(id));
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, SALT);
  }

  function test_cancelBatch_revertsForExecutedBatch() public {
    address[] memory targets = _targets2(address(manager), address(manager));
    uint256[] memory values = _values2(0, 0);
    bytes[] memory payloads = _payloads2(
      abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (1)),
      abi.encodeCall(LiquidityManager.setFundingPaused, (true))
    );
    bytes32 id = _scheduleBatchOp(targets, values, payloads, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeBatchOp(targets, values, payloads, 0, SALT);

    vm.expectRevert(_notPendingRevert(id));
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, SALT);
  }

  function test_cancelBatch_revertsForAlreadyCancelledBatch() public {
    address[] memory targets = _targets1(address(manager));
    uint256[] memory values = _values1(0);
    bytes[] memory payloads = _payloads1(abi.encodeCall(LiquidityManager.setFundingPaused, (false)));
    bytes32 id = _scheduleBatchOp(targets, values, payloads, 0, SALT);
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, SALT);

    vm.expectRevert(_notPendingRevert(id));
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, SALT);
  }

  /// @dev Single and batch ids are distinct: a batch-of-one cannot be cancelled with `cancel` and vice versa.
  function test_cancel_singleAndBatchIdsAreDistinct() public {
    bytes memory data = abi.encodeCall(LiquidityManager.setFundingPaused, (false));
    bytes32 batchId = _scheduleBatchOp(_targets1(address(manager)), _values1(0), _payloads1(data), 0, SALT);

    bytes32 singleId = timelock.hashOperation(address(manager), 0, data, 0, SALT);
    assertTrue(singleId != batchId);
    vm.expectRevert(_notPendingRevert(singleId));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, SALT);
    assertTrue(timelock.isOperationPending(batchId));
  }

  /// @dev Arrays of mismatched length can never be scheduled, so they never match a scheduled id.
  function test_cancelBatch_mismatchedLengths_revertTimelockState() public {
    bytes memory data = _setGuardianCall(newGuardian);
    bytes32 protectedBatch = _scheduleBatchOp(_targets1(address(manager)), _values1(0), _payloads1(data), 0, SALT);

    address[] memory targets = _targets1(address(manager));
    uint256[] memory values = _values1(0);
    bytes[] memory payloads = _payloads2(data, "");
    vm.expectRevert(_notPendingRevert(timelock.hashOperationBatch(targets, values, payloads, 0, SALT)));
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, SALT);

    targets = _targets2(address(manager), address(manager));
    payloads = _payloads1(data);
    vm.expectRevert(_notPendingRevert(timelock.hashOperationBatch(targets, values, payloads, 0, SALT)));
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, SALT);

    targets = _targets1(address(manager));
    values = new uint256[](0);
    vm.expectRevert(_notPendingRevert(timelock.hashOperationBatch(targets, values, payloads, 0, SALT)));
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, SALT);

    assertTrue(timelock.isOperationPending(protectedBatch));
  }

  // ================================================================
  // │                    Protected setGuardian                     │
  // ================================================================

  function _assertProtectedSingle(address account, bytes32 predecessor, bytes32 salt) internal returns (bytes32 id) {
    bytes memory data = _setGuardianCall(account);
    id = _scheduleOp(address(manager), 0, data, predecessor, salt);
    vm.expectRevert(_protectedRevert(id));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, predecessor, salt);
    assertTrue(timelock.isOperationPending(id), "protected op still pending");
  }

  function _assertProtectedBatch(address account, bytes32 predecessor, bytes32 salt) internal returns (bytes32 id) {
    address[] memory targets = _targets1(address(manager));
    uint256[] memory values = _values1(0);
    bytes[] memory payloads = _payloads1(_setGuardianCall(account));
    id = _scheduleBatchOp(targets, values, payloads, predecessor, salt);
    vm.expectRevert(_protectedRevert(id));
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, predecessor, salt);
    assertTrue(timelock.isOperationPending(id), "protected batch still pending");
  }

  function test_protected_singleSetGuardian() public {
    _assertProtectedSingle(newGuardian, 0, 0);
  }

  function test_protected_singleSetGuardianWithSalt() public {
    _assertProtectedSingle(newGuardian, 0, SALT);
  }

  function test_protected_singleSetGuardianZero() public {
    _assertProtectedSingle(address(0), 0, 0);
  }

  function test_protected_singleSetGuardianToCurrentGuardian() public {
    _assertProtectedSingle(guardian, 0, 0);
  }

  function test_protected_singleSetGuardianWithNonZeroPredecessor() public {
    bytes32 predecessor =
      _scheduleOp(address(manager), 0, abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (1)), 0, keccak256("pred"));
    bytes32 id = _assertProtectedSingle(newGuardian, predecessor, SALT);

    // Both become ready; executing the predecessor first lets the protected op execute.
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeOp(address(manager), 0, abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (1)), 0, keccak256("pred"));
    _executeOp(address(manager), 0, _setGuardianCall(newGuardian), predecessor, SALT);
    assertTrue(timelock.isOperationDone(id));
    assertEq(manager.guardian(), newGuardian);
  }

  function test_protected_singleSetGuardianWithArbitraryPredecessor() public {
    _assertProtectedSingle(newGuardian, bytes32(type(uint256).max), SALT);
  }

  function test_protected_singleSetGuardianWhenReady() public {
    bytes memory data = _setGuardianCall(newGuardian);
    bytes32 id = _scheduleOp(address(manager), 0, data, 0, 0);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    assertTrue(timelock.isOperationReady(id));

    vm.expectRevert(_protectedRevert(id));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, 0, 0);
    assertTrue(timelock.isOperationReady(id));
  }

  function test_protected_batchOfOneSetGuardian() public {
    _assertProtectedBatch(newGuardian, 0, 0);
  }

  function test_protected_batchOfOneSetGuardianZero() public {
    _assertProtectedBatch(address(0), 0, SALT);
  }

  function test_protected_batchOfOneSetGuardianWithNonZeroPredecessor() public {
    _assertProtectedBatch(newGuardian, keccak256("some predecessor"), SALT);
  }

  function test_protected_batchOfOneWhenReady() public {
    address[] memory targets = _targets1(address(manager));
    uint256[] memory values = _values1(0);
    bytes[] memory payloads = _payloads1(_setGuardianCall(newGuardian));
    bytes32 id = _scheduleBatchOp(targets, values, payloads, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);

    vm.expectRevert(_protectedRevert(id));
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, SALT);
    assertTrue(timelock.isOperationReady(id));
  }

  function test_protected_singleExecutesAfterDelay() public {
    bytes32 id = _assertProtectedSingle(newGuardian, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);

    vm.expectEmit(true, true, false, true, address(manager));
    emit ILiquidityManager.GuardianSet(guardian, newGuardian);
    _executeOp(address(manager), 0, _setGuardianCall(newGuardian), 0, SALT);

    assertTrue(timelock.isOperationDone(id));
    assertEq(manager.guardian(), newGuardian);
  }

  function test_protected_batchOfOneExecutesAfterDelay() public {
    bytes32 id = _assertProtectedBatch(address(0), 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeBatchOp(_targets1(address(manager)), _values1(0), _payloads1(_setGuardianCall(address(0))), 0, SALT);
    assertTrue(timelock.isOperationDone(id));
    assertEq(manager.guardian(), address(0));
  }

  function testFuzz_protected_singleAlwaysReverts(address account, bytes32 predecessor, bytes32 salt) public {
    _assertProtectedSingle(account, predecessor, salt);
  }

  function testFuzz_protected_batchOfOneAlwaysReverts(address account, bytes32 predecessor, bytes32 salt) public {
    _assertProtectedBatch(account, predecessor, salt);
  }

  // ================================================================
  // │            Not protected: near-miss setGuardian ops          │
  // ================================================================

  function test_notProtected_nonZeroValue() public {
    _assertGuardianCancels(address(manager), 1, _setGuardianCall(newGuardian), 0, SALT);
  }

  function test_notProtected_trailingByte() public {
    bytes memory data = bytes.concat(_setGuardianCall(newGuardian), hex"00");
    assertEq(data.length, 37);
    _assertGuardianCancels(address(manager), 0, data, 0, SALT);
  }

  function test_notProtected_trailingWord() public {
    bytes memory data = bytes.concat(_setGuardianCall(newGuardian), bytes32(0));
    assertEq(data.length, 68);
    _assertGuardianCancels(address(manager), 0, data, 0, SALT);
  }

  /// @dev Documents why only the canonical 36-byte form is protected: a padded call would still set the guardian if
  /// executed, so governance must schedule the canonical encoding for the protected recovery path.
  function test_notProtected_trailingByteWouldStillExecuteIfNotCancelled() public {
    bytes memory data = bytes.concat(_setGuardianCall(newGuardian), hex"00");
    assertFalse(controller.isProtectedCall(address(manager), 0, data));
    _scheduleAndExecute(address(manager), data, SALT);
    assertEq(manager.guardian(), newGuardian);
  }

  function test_notProtected_shortCalldata() public {
    bytes memory full = _setGuardianCall(newGuardian);
    bytes memory data = new bytes(35);
    for (uint256 i = 0; i < 35; ++i) {
      data[i] = full[i];
    }
    _assertGuardianCancels(address(manager), 0, data, 0, SALT);
  }

  function test_notProtected_selectorOnly() public {
    _assertGuardianCancels(address(manager), 0, abi.encodePacked(ILiquidityManager.setGuardian.selector), 0, SALT);
  }

  function test_notProtected_emptyCalldata() public {
    _assertGuardianCancels(address(manager), 0, "", 0, SALT);
  }

  function test_notProtected_dirtyUpperBits() public {
    bytes memory data =
      bytes.concat(ILiquidityManager.setGuardian.selector, bytes32(uint256(uint160(newGuardian)) | (uint256(1) << 255)));
    assertEq(data.length, 36);
    _assertGuardianCancels(address(manager), 0, data, 0, SALT);
  }

  /// @dev A dirty-bit setGuardian op is not protected, and it cannot execute anyway (ABI decoding rejects it).
  function test_notProtected_dirtyUpperBitsCannotExecute() public {
    bytes memory data =
      bytes.concat(ILiquidityManager.setGuardian.selector, bytes32(uint256(uint160(newGuardian)) | (uint256(1) << 160)));
    _scheduleOp(address(manager), 0, data, 0, SALT);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    // The Manager's ABI decoder reverts with empty data, which the Timelock surfaces as Errors.FailedCall().
    vm.expectRevert(Errors.FailedCall.selector);
    _executeOp(address(manager), 0, data, 0, SALT);
    assertEq(manager.guardian(), guardian);
  }

  function test_notProtected_sameShapeDifferentSelector() public {
    // transferOwnership(address) has the same 36-byte shape and would hand the Manager to `attacker`.
    _assertGuardianCancels(address(manager), 0, abi.encodeCall(manager.transferOwnership, (attacker)), 0, SALT);
    _assertGuardianCancels(
      address(manager), 0, abi.encodeCall(LiquidityManager.suspendFundingOperator, (attacker)), 0, keccak256("2")
    );
  }

  function test_notProtected_setGuardianOnOtherManager() public {
    LiquidityManager other = new LiquidityManager(address(token), registry, address(timelock), guardian);
    _assertGuardianCancels(address(other), 0, _setGuardianCall(newGuardian), 0, SALT);
    assertEq(other.guardian(), guardian);
  }

  function test_notProtected_setGuardianOnOtherTargets() public {
    bytes memory data = _setGuardianCall(newGuardian);
    _assertGuardianCancels(address(controller), 0, data, 0, keccak256("controller"));
    _assertGuardianCancels(address(timelock), 0, data, 0, keccak256("timelock"));
    _assertGuardianCancels(address(pool), 0, data, 0, keccak256("pool"));
    _assertGuardianCancels(address(adapter), 0, data, 0, keccak256("adapter"));
    _assertGuardianCancels(attacker, 0, data, 0, keccak256("eoa"));
  }

  // ================================================================
  // │                       isProtectedCall                        │
  // ================================================================

  function test_isProtectedCall_canonical() public view {
    assertTrue(controller.isProtectedCall(address(manager), 0, _setGuardianCall(newGuardian)));
    assertTrue(controller.isProtectedCall(address(manager), 0, _setGuardianCall(address(0))));
    assertTrue(controller.isProtectedCall(address(manager), 0, _setGuardianCall(address(type(uint160).max))));
  }

  function test_isProtectedCall_rejectsNearMisses() public view {
    bytes memory canonical = _setGuardianCall(newGuardian);
    assertFalse(controller.isProtectedCall(address(manager), 1, canonical), "value");
    assertFalse(controller.isProtectedCall(address(controller), 0, canonical), "target");
    assertFalse(controller.isProtectedCall(address(0), 0, canonical), "zero target");
    assertFalse(controller.isProtectedCall(address(manager), 0, bytes.concat(canonical, hex"00")), "37 bytes");
    assertFalse(controller.isProtectedCall(address(manager), 0, ""), "empty");
    assertFalse(
      controller.isProtectedCall(address(manager), 0, abi.encodePacked(ILiquidityManager.setGuardian.selector)), "4"
    );
    assertFalse(
      controller.isProtectedCall(address(manager), 0, abi.encodeCall(manager.transferOwnership, (newGuardian))),
      "selector"
    );
    assertFalse(
      controller.isProtectedCall(
        address(manager),
        0,
        bytes.concat(
          ILiquidityManager.setGuardian.selector, bytes32(uint256(uint160(newGuardian)) | (uint256(1) << 160))
        )
      ),
      "dirty bit 160"
    );
  }

  /// @dev Independent reference: protected iff target is the Manager, value is zero and `data` is exactly the
  /// canonical ABI encoding of `setGuardian(a)` for some address `a`.
  function _referenceIsProtected(address target, uint256 value, bytes memory data) internal view returns (bool) {
    if (target != address(manager) || value != 0 || data.length < 36) return false;
    bytes32 word;
    assembly {
      word := mload(add(data, 36))
    }
    address decoded = address(uint160(uint256(word)));
    return keccak256(data) == keccak256(abi.encodeCall(ILiquidityManager.setGuardian, (decoded)));
  }

  function testFuzz_isProtectedCall_matchesReference_random(address target, uint256 value, bytes calldata data)
    public
    view
  {
    assertEq(controller.isProtectedCall(target, value, data), _referenceIsProtected(target, value, data));
  }

  function testFuzz_isProtectedCall_matchesReference_structured(
    bool toManager,
    bool zeroValue,
    uint8 shape,
    address account,
    uint96 dirt,
    bytes4 selector,
    bytes calldata extra,
    address otherTarget,
    uint256 value
  ) public view {
    address target = toManager ? address(manager) : otherTarget;
    if (!zeroValue) value = bound(value, 1, type(uint256).max);
    else value = 0;

    bytes4 sel = shape % 2 == 0 ? ILiquidityManager.setGuardian.selector : selector;
    bytes32 word = bytes32((uint256(dirt) << 160) | uint160(account));
    if (shape % 3 == 0) word = bytes32(uint256(uint160(account)));

    bytes memory data;
    uint8 form = shape % 5;
    if (form == 0 || form == 1) data = bytes.concat(sel, word);
    else if (form == 2) data = bytes.concat(sel, word, extra);
    else if (form == 3) data = extra;
    else data = bytes.concat(sel, bytes31(word));

    assertEq(controller.isProtectedCall(target, value, data), _referenceIsProtected(target, value, data));
  }

  function testFuzz_isProtectedCall_anyAddressCanonical(address account) public view {
    assertTrue(controller.isProtectedCall(address(manager), 0, _setGuardianCall(account)));
  }

  function testFuzz_isProtectedCall_dirtyBitsRejected(address account, uint96 dirt) public view {
    vm.assume(dirt != 0);
    bytes memory data =
      bytes.concat(ILiquidityManager.setGuardian.selector, bytes32((uint256(dirt) << 160) | uint160(account)));
    assertFalse(controller.isProtectedCall(address(manager), 0, data));
  }

  function testFuzz_isProtectedCall_trailingBytesRejected(address account, bytes calldata extra) public view {
    vm.assume(extra.length > 0);
    assertFalse(controller.isProtectedCall(address(manager), 0, bytes.concat(_setGuardianCall(account), extra)));
  }

  function testFuzz_isProtectedCall_truncatedRejected(address account, uint256 length) public view {
    length = bound(length, 0, 35);
    bytes memory full = _setGuardianCall(account);
    bytes memory data = new bytes(length);
    for (uint256 i = 0; i < length; ++i) {
      data[i] = full[i];
    }
    assertFalse(controller.isProtectedCall(address(manager), 0, data));
  }

  function testFuzz_isProtectedCall_nonZeroValueRejected(address account, uint256 value) public view {
    vm.assume(value != 0);
    assertFalse(controller.isProtectedCall(address(manager), value, _setGuardianCall(account)));
  }

  function testFuzz_isProtectedCall_otherTargetRejected(address target, address account) public view {
    vm.assume(target != address(manager));
    assertFalse(controller.isProtectedCall(target, 0, _setGuardianCall(account)));
  }

  function testFuzz_isProtectedCall_otherSelectorRejected(bytes4 selector, bytes32 word) public view {
    vm.assume(selector != ILiquidityManager.setGuardian.selector);
    assertFalse(controller.isProtectedCall(address(manager), 0, bytes.concat(selector, word)));
  }

  // ================================================================
  // │              Forgery: cannot hit a protected id              │
  // ================================================================

  /// @dev With a protected single op and a protected batch-of-one pending, no non-protected contents submitted by the
  /// Guardian can cancel either of them.
  function testFuzz_forgery_nonProtectedContentsNeverCancelProtectedOps(
    address target,
    uint256 value,
    bytes calldata data,
    bytes32 predecessor,
    bytes32 salt
  ) public {
    vm.assume(!controller.isProtectedCall(target, value, data));
    bytes32 single = _scheduleOp(address(manager), 0, _setGuardianCall(newGuardian), 0, 0);
    bytes32 batch =
      _scheduleBatchOp(_targets1(address(manager)), _values1(0), _payloads1(_setGuardianCall(newGuardian)), 0, 0);

    vm.startPrank(guardian);
    vm.expectRevert(_notPendingRevert(timelock.hashOperation(target, value, data, predecessor, salt)));
    controller.cancel(target, value, data, predecessor, salt);

    address[] memory targets = _targets1(target);
    uint256[] memory values = _values1(value);
    bytes[] memory payloads = _payloads1(data);
    vm.expectRevert(_notPendingRevert(timelock.hashOperationBatch(targets, values, payloads, predecessor, salt)));
    controller.cancelBatch(targets, values, payloads, predecessor, salt);

    targets = _targets2(address(manager), target);
    values = _values2(0, value);
    payloads = _payloads2(_setGuardianCall(newGuardian), data);
    vm.expectRevert(_notPendingRevert(timelock.hashOperationBatch(targets, values, payloads, predecessor, salt)));
    controller.cancelBatch(targets, values, payloads, predecessor, salt);
    vm.stopPrank();

    assertTrue(timelock.isOperationPending(single));
    assertTrue(timelock.isOperationPending(batch));
  }

  /// @dev Submitting a protected single op's contents through `cancelBatch` (and vice versa) is still refused.
  function test_forgery_crossShapeSubmissionRefused() public {
    bytes memory data = _setGuardianCall(newGuardian);
    bytes32 single = _scheduleOp(address(manager), 0, data, 0, SALT);
    bytes32 batch = _scheduleBatchOp(_targets1(address(manager)), _values1(0), _payloads1(data), 0, SALT);

    vm.startPrank(guardian);
    vm.expectRevert(_protectedRevert(batch));
    controller.cancelBatch(_targets1(address(manager)), _values1(0), _payloads1(data), 0, SALT);
    vm.expectRevert(_protectedRevert(single));
    controller.cancel(address(manager), 0, data, 0, SALT);
    vm.stopPrank();

    assertTrue(timelock.isOperationPending(single));
    assertTrue(timelock.isOperationPending(batch));
  }

  /// @dev The controller hashes canonically encoded arguments. A single-op preimage always has its `data` offset
  /// (0xa0) in word 2, while a batch-of-one preimage has its `payloads` offset (0x120) there, so no single-op contents
  /// can alias a batch id (or vice versa) without a keccak collision.
  function testFuzz_forgery_singleAndBatchPreimagesNeverAlias(
    address target,
    uint256 value,
    bytes calldata data,
    bytes32 predecessor,
    bytes32 salt
  ) public pure {
    bytes memory single = abi.encode(target, value, data, predecessor, salt);
    bytes memory batch = abi.encode(_targets1(target), _values1(value), _payloads1(data), predecessor, salt);
    uint256 singleWord2;
    uint256 batchWord2;
    assembly {
      singleWord2 := mload(add(single, 96))
      batchWord2 := mload(add(batch, 96))
    }
    assertEq(singleWord2, 0xa0);
    assertEq(batchWord2, 0x120);
  }
}
