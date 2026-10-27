// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";

import {ControllerTimelockBase} from "test/controller-timelock/utils/ControllerTimelockBase.sol";

/// @notice End-to-end Guardian recovery: Governance removes or replaces a compromised Guardian through the protected
/// Timelock path; the old Guardian loses every power (Manager restrictions, cancellation, pool lockdown).
contract GuardianRecoveryTest is ControllerTimelockBase {
  bytes32 internal constant RECOVERY_SALT = keccak256("guardian recovery");
  bytes32 internal constant RESTORE_SALT = keccak256("restore operations");

  // ---------------------------------------------------------------- helpers

  /// @dev The compromised Guardian applies every restriction it has, immediately.
  function _guardianRestrictsEverything(address actor) internal {
    vm.startPrank(actor);
    manager.pauseFunding();
    manager.pauseRecall();
    manager.suspendFundingOperator(fundingOperator);
    manager.suspendRecallOperator(recallOperator);
    manager.restrictAdapter(adapterId, true, true);
    manager.reduceMaxFundingPerCall(0);
    manager.reduceAggregateFundingBudget(0, 0);
    manager.reducePoolFundingBudget(address(pool), 0, 0);
    manager.reduceRecallLimits(0, 0, 0);
    manager.raisePoolMinimum(address(pool), type(uint256).max);
    manager.revokePoolMigrationApproval(address(pool));
    controller.lockdown(address(pool));
    vm.stopPrank();
  }

  function _restorationBatch()
    internal
    view
    returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
  {
    uint256 n = 11;
    targets = new address[](n);
    values = new uint256[](n);
    payloads = new bytes[](n);
    for (uint256 i = 0; i < n; ++i) {
      targets[i] = address(manager);
    }
    payloads[0] = abi.encodeCall(LiquidityManager.setFundingPaused, (false));
    payloads[1] = abi.encodeCall(LiquidityManager.setRecallPaused, (false));
    payloads[2] = abi.encodeCall(LiquidityManager.setFundingOperator, (fundingOperator, true));
    payloads[3] = abi.encodeCall(LiquidityManager.setRecallOperator, (recallOperator, true));
    payloads[4] = abi.encodeCall(LiquidityManager.setAdapterStatus, (adapterId, true, true));
    payloads[5] = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (MAX_FUNDING_PER_CALL));
    payloads[6] =
      abi.encodeCall(LiquidityManager.setAggregateFundingBudget, (AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE));
    payloads[7] =
      abi.encodeCall(LiquidityManager.setPoolFundingBudget, (address(pool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE));
    payloads[8] = abi.encodeCall(LiquidityManager.setRecallLimits, (MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE));
    payloads[9] = abi.encodeCall(
      LiquidityManager.setPoolThresholds, (address(pool), POOL_MINIMUM, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET)
    );
    targets[10] = address(pool);
    payloads[10] =
      _restoreCall(REMOTE_CHAIN_SELECTOR, _ccipBucket(CCIP_CAPACITY, CCIP_RATE), _ccipBucket(CCIP_CAPACITY, CCIP_RATE));
  }

  function _assertManagerGuardianPowersRevoked(address actor) internal {
    bytes memory err = abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, actor);
    vm.startPrank(actor);
    vm.expectRevert(err);
    manager.pauseFunding();
    vm.expectRevert(err);
    manager.pauseRecall();
    vm.expectRevert(err);
    manager.suspendFundingOperator(fundingOperator);
    vm.expectRevert(err);
    manager.suspendRecallOperator(recallOperator);
    vm.expectRevert(err);
    manager.restrictAdapter(adapterId, true, true);
    vm.expectRevert(err);
    manager.revokePoolMigrationApproval(address(pool));
    vm.expectRevert(err);
    manager.reduceMaxFundingPerCall(0);
    vm.expectRevert(err);
    manager.reduceAggregateFundingBudget(0, 0);
    vm.expectRevert(err);
    manager.reducePoolFundingBudget(address(pool), 0, 0);
    vm.expectRevert(err);
    manager.reduceRecallLimits(0, 0, 0);
    vm.expectRevert(err);
    manager.raisePoolMinimum(address(pool), type(uint256).max);
    vm.stopPrank();
  }

  function _assertControllerPowersRevoked(address actor) internal {
    // A pending ordinary op the actor would like to cancel.
    bytes memory data = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (MAX_FUNDING_PER_CALL));
    bytes32 salt = keccak256(abi.encode("probe", actor, block.timestamp));
    bytes32 id = _scheduleOp(address(manager), 0, data, 0, salt);

    vm.startPrank(actor);
    vm.expectRevert(_notGuardianRevert(actor));
    controller.cancel(address(manager), 0, data, 0, salt);
    vm.expectRevert(_notGuardianRevert(actor));
    controller.cancelBatch(_targets1(address(manager)), _values1(0), _payloads1(data), 0, salt);
    vm.expectRevert(_notGuardianRevert(actor));
    controller.lockdown(address(pool));
    vm.stopPrank();

    assertTrue(timelock.isOperationPending(id));
  }

  // ================================================================
  // │                 Compromised Guardian replaced                │
  // ================================================================

  function test_recovery_compromisedGuardianReplaced() public {
    // 1. Governance queues the standalone replacement.
    bytes memory recovery = _setGuardianCall(newGuardian);
    bytes32 recoveryId = _scheduleOp(address(manager), 0, recovery, 0, RECOVERY_SALT);
    uint256 readyAt = block.timestamp + TIMELOCK_DELAY;

    // 2. The compromised Guardian restricts everything and halts the bridge.
    _guardianRestrictsEverything(guardian);
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
    assertTrue(manager.fundingPaused() && manager.recallPaused());

    // 3. It cannot cancel its own replacement in either shape.
    vm.startPrank(guardian);
    vm.expectRevert(_protectedRevert(recoveryId));
    controller.cancel(address(manager), 0, recovery, 0, RECOVERY_SALT);
    bytes32 batchShapeId =
      timelock.hashOperationBatch(_targets1(address(manager)), _values1(0), _payloads1(recovery), 0, RECOVERY_SALT);
    vm.expectRevert(_protectedRevert(batchShapeId));
    controller.cancelBatch(_targets1(address(manager)), _values1(0), _payloads1(recovery), 0, RECOVERY_SALT);
    vm.stopPrank();

    // 4. A restoration queued in parallel is cancellable by the compromised Guardian.
    (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _restorationBatch();
    bytes32 parallelRestore = _scheduleBatchOp(targets, values, payloads, 0, RESTORE_SALT);
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, RESTORE_SALT);
    assertFalse(timelock.isOperation(parallelRestore));

    // 5. The replacement is still pending at the deadline and executes despite every pause and the lockdown.
    vm.warp(readyAt);
    assertTrue(timelock.isOperationReady(recoveryId));
    vm.expectRevert(_protectedRevert(recoveryId));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, recovery, 0, RECOVERY_SALT);

    vm.expectEmit(true, true, false, true, address(manager));
    emit ILiquidityManager.GuardianSet(guardian, newGuardian);
    _executeOp(address(manager), 0, recovery, 0, RECOVERY_SALT);
    assertTrue(timelock.isOperationDone(recoveryId));
    assertEq(manager.guardian(), newGuardian);

    // 6. The old Guardian has lost every power.
    _assertManagerGuardianPowersRevoked(guardian);
    _assertControllerPowersRevoked(guardian);

    // 7. Restrictions persist until a separate, delayed restoration (full recovery needs another delay period).
    assertTrue(manager.fundingPaused());
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
    _scheduleBatchOp(targets, values, payloads, 0, keccak256("restore again"));
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeBatchOp(targets, values, payloads, 0, keccak256("restore again"));

    assertFalse(manager.fundingPaused());
    assertFalse(manager.recallPaused());
    _assertBuckets(
      address(pool), REMOTE_CHAIN_SELECTOR, _ccipBucket(CCIP_CAPACITY, CCIP_RATE), _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
    // Budgets were zeroed by the Guardian and refill under the restored rates; usage is not reset.
    assertEq(manager.getAggregateFundingBudget().available, 0);
    vm.warp(block.timestamp + 1 hours);
    _fund(1_000_000e18);
    _recall(1_000_000e18);

    // 8. The new Guardian holds the powers.
    vm.prank(newGuardian);
    manager.pauseFunding();
    vm.prank(newGuardian);
    controller.lockdown(address(pool));
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  function test_recovery_batchOfOneReplacement() public {
    address[] memory targets = _targets1(address(manager));
    uint256[] memory values = _values1(0);
    bytes[] memory payloads = _payloads1(_setGuardianCall(newGuardian));
    bytes32 id = _scheduleBatchOp(targets, values, payloads, 0, RECOVERY_SALT);

    _guardianRestrictsEverything(guardian);
    vm.expectRevert(_protectedRevert(id));
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, RECOVERY_SALT);

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeBatchOp(targets, values, payloads, 0, RECOVERY_SALT);
    assertEq(manager.guardian(), newGuardian);
    _assertManagerGuardianPowersRevoked(guardian);
    _assertControllerPowersRevoked(guardian);
  }

  function test_recovery_guardianRemovedEntirely() public {
    bytes memory removal = _setGuardianCall(address(0));
    bytes32 id = _scheduleOp(address(manager), 0, removal, 0, RECOVERY_SALT);

    vm.expectRevert(_protectedRevert(id));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, removal, 0, RECOVERY_SALT);

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeOp(address(manager), 0, removal, 0, RECOVERY_SALT);
    assertEq(manager.guardian(), address(0));

    _assertManagerGuardianPowersRevoked(guardian);
    _assertControllerPowersRevoked(guardian);
    _assertManagerGuardianPowersRevoked(attacker);
    _assertControllerPowersRevoked(attacker);
  }

  /// @dev After recovery the new Guardian can cancel ops that were queued before it took over.
  function test_recovery_newGuardianCancelsOpsQueuedEarlier() public {
    bytes memory malicious = abi.encodeCall(LiquidityManager.migrateReserves, (attacker, MANAGER_RESERVES));
    bytes32 maliciousId = _scheduleOp(address(manager), 0, malicious, 0, keccak256("m"));
    vm.warp(block.timestamp + 1 hours);
    _scheduleAndExecute(address(manager), _setGuardianCall(newGuardian), RECOVERY_SALT);

    // The malicious op is ready by now but has not been executed.
    assertTrue(timelock.isOperationReady(maliciousId));
    vm.prank(newGuardian);
    controller.cancel(address(manager), 0, malicious, 0, keccak256("m"));
    assertFalse(timelock.isOperation(maliciousId));
  }

  // ================================================================
  // │            Recovery shapes the Guardian CAN block            │
  // ================================================================

  /// @dev A replacement bundled with other calls is cancellable: Governance must use the standalone form.
  function test_recovery_mixedBatchIsCancellable() public {
    address[] memory targets = _targets2(address(manager), address(manager));
    uint256[] memory values = _values2(0, 0);
    bytes[] memory payloads =
      _payloads2(_setGuardianCall(newGuardian), abi.encodeCall(LiquidityManager.setFundingPaused, (false)));
    bytes32 id = _scheduleBatchOp(targets, values, payloads, 0, RECOVERY_SALT);

    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, 0, RECOVERY_SALT);
    assertFalse(timelock.isOperation(id));

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    assertEq(manager.guardian(), guardian);
  }

  /// @dev The protected op itself cannot be cancelled when it has a predecessor, but the Guardian can cancel an
  /// ordinary predecessor, which leaves the replacement permanently unexecutable. The review response states the
  /// recovery operation "will have no predecessor"; this test documents why that operational rule matters.
  function test_recovery_withCancellablePredecessorCanBeStalled() public {
    bytes memory predecessorCall = abi.encodeCall(LiquidityManager.setFundingPaused, (false));
    bytes32 predecessor = _scheduleOp(address(manager), 0, predecessorCall, 0, keccak256("pred"));
    bytes memory recovery = _setGuardianCall(newGuardian);
    bytes32 recoveryId = _scheduleOp(address(manager), 0, recovery, predecessor, RECOVERY_SALT);

    vm.expectRevert(_protectedRevert(recoveryId));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, recovery, predecessor, RECOVERY_SALT);

    vm.prank(guardian);
    controller.cancel(address(manager), 0, predecessorCall, 0, keccak256("pred"));

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnexecutedPredecessor.selector, predecessor));
    _executeOp(address(manager), 0, recovery, predecessor, RECOVERY_SALT);
    assertEq(manager.guardian(), guardian);

    // A standalone replacement (no predecessor) still goes through.
    _scheduleAndExecute(address(manager), recovery, keccak256("standalone"));
    assertEq(manager.guardian(), newGuardian);
  }

  // ================================================================
  // │            Compromised Governance (trust boundary)           │
  // ================================================================

  /// @dev Documents the accepted trust boundary: a compromised Governance Safe can schedule a protected replacement
  /// of an honest Guardian. The Guardian cancels the concurrent malicious ops, but after one delay it is replaced and
  /// the next queued ops can no longer be cancelled (design Section 4: "one delay may suffice").
  function test_trustBoundary_compromisedGovernanceReplacesHonestGuardian() public {
    address rogueGuardian = makeAddr("rogueGuardian");
    bytes memory steal = abi.encodeCall(LiquidityManager.migrateReserves, (attacker, MANAGER_RESERVES));

    bytes32 takeover = _scheduleOp(address(manager), 0, _setGuardianCall(rogueGuardian), 0, RECOVERY_SALT);
    _scheduleOp(address(manager), 0, steal, 0, keccak256("steal 1"));

    vm.startPrank(guardian);
    controller.cancel(address(manager), 0, steal, 0, keccak256("steal 1"));
    vm.expectRevert(_protectedRevert(takeover));
    controller.cancel(address(manager), 0, _setGuardianCall(rogueGuardian), 0, RECOVERY_SALT);
    vm.stopPrank();

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeOp(address(manager), 0, _setGuardianCall(rogueGuardian), 0, RECOVERY_SALT);

    // The honest Guardian is out; the second attempt cannot be cancelled by it.
    _scheduleOp(address(manager), 0, steal, 0, keccak256("steal 2"));
    vm.expectRevert(_notGuardianRevert(guardian));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, steal, 0, keccak256("steal 2"));

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    _executeOp(address(manager), 0, steal, 0, keccak256("steal 2"));
    assertEq(_balance(attacker), MANAGER_RESERVES);
  }
}
