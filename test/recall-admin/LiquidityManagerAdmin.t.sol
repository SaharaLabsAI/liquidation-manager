// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {ITokenAdminRegistry} from "src/interfaces/ITokenAdminRegistry.sol";
import {TokenBucket} from "src/libraries/TokenBucket.sol";

import {MockSahara} from "test/mocks/MockSahara.sol";

import {RecallAdminBase} from "test/recall-admin/RecallAdminBase.sol";

contract LiquidityManagerAdminTest is RecallAdminBase {
  uint256 internal constant AMOUNT = 10_000_000e18;

  address internal newGuardian = makeAddr("newGuardian");
  address internal newOperator = makeAddr("newOperator");
  address internal newOwner = makeAddr("newOwner");

  function _newManager() internal returns (LiquidityManager) {
    return new LiquidityManager(address(token), registry, address(timelock), guardian);
  }

  // ================================================================
  // │                        Constructor                           │
  // ================================================================

  function test_constructor_initialState() public {
    LiquidityManager fresh = _newManager();
    assertEq(fresh.TOKEN(), address(token));
    assertEq(address(fresh.TOKEN_ADMIN_REGISTRY()), address(registry));
    assertEq(fresh.owner(), address(timelock));
    assertEq(fresh.pendingOwner(), address(0));
    assertEq(fresh.guardian(), guardian);
    assertEq(fresh.adapterCount(), 0);
    assertFalse(fresh.fundingPaused());
    assertFalse(fresh.recallPaused());
    assertEq(fresh.maxFundingPerCall(), 0);
    assertEq(fresh.maxRecallPerCall(), 0);
  }

  function test_constructor_everythingClosedUntilConfigured() public {
    LiquidityManager fresh = _newManager();
    ILiquidityManager.BudgetState memory zero;
    _assertBudget(fresh.getAggregateFundingBudget(), zero);
    _assertBudget(fresh.getRecallBudget(), zero);
    _assertBudget(fresh.getPoolFundingBudget(address(pool)), zero);
    assertFalse(fresh.isFundingOperator(fundingOperator));
    assertFalse(fresh.isRecallOperator(recallOperator));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 1));
    fresh.getAdapter(1);
  }

  function test_constructor_emitsGuardianSet() public {
    address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
    vm.expectEmit(true, true, true, true, predicted);
    emit ILiquidityManager.GuardianSet(address(0), guardian);
    _newManager();
  }

  function test_constructor_allowsZeroGuardian() public {
    LiquidityManager fresh = new LiquidityManager(address(token), registry, address(timelock), address(0));
    assertEq(fresh.guardian(), address(0));
  }

  function test_constructor_revertsOnZeroToken() public {
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    new LiquidityManager(address(0), registry, address(timelock), guardian);
  }

  function test_constructor_revertsOnZeroRegistry() public {
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    new LiquidityManager(address(token), ITokenAdminRegistry(address(0)), address(timelock), guardian);
  }

  function test_constructor_revertsOnZeroOwner() public {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
    new LiquidityManager(address(token), registry, address(0), guardian);
  }

  // ================================================================
  // │                         setGuardian                          │
  // ================================================================

  function test_setGuardian_replacesAndEmits() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.GuardianSet(guardian, newGuardian);
    vm.prank(address(timelock));
    manager.setGuardian(newGuardian);
    assertEq(manager.guardian(), newGuardian);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, guardian));
    vm.prank(guardian);
    manager.pauseFunding();

    vm.prank(newGuardian);
    manager.pauseFunding();
    assertTrue(manager.fundingPaused());
  }

  function test_setGuardian_toZeroRevokesAllGuardianPowers() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.GuardianSet(guardian, address(0));
    vm.prank(address(timelock));
    manager.setGuardian(address(0));
    assertEq(manager.guardian(), address(0));

    bytes memory notGuardian = abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, guardian);
    vm.startPrank(guardian);
    vm.expectRevert(notGuardian);
    manager.pauseFunding();
    vm.expectRevert(notGuardian);
    manager.pauseRecall();
    vm.expectRevert(notGuardian);
    manager.suspendFundingOperator(fundingOperator);
    vm.expectRevert(notGuardian);
    manager.suspendRecallOperator(recallOperator);
    vm.expectRevert(notGuardian);
    manager.restrictAdapter(adapterId, true, true);
    vm.expectRevert(notGuardian);
    manager.revokePoolMigrationApproval(address(pool));
    vm.expectRevert(notGuardian);
    manager.reduceMaxFundingPerCall(0);
    vm.expectRevert(notGuardian);
    manager.reduceAggregateFundingBudget(0, 0);
    vm.expectRevert(notGuardian);
    manager.reducePoolFundingBudget(address(pool), 0, 0);
    vm.expectRevert(notGuardian);
    manager.reduceRecallLimits(0, 0, 0);
    vm.expectRevert(notGuardian);
    manager.raisePoolMinimum(address(pool), POOL_INVENTORY);

    // Controller authority is derived from the Manager's guardian, so it is revoked too.
    bytes memory controllerNotGuardian = abi.encodeWithSelector(GuardianController.CallerNotGuardian.selector, guardian);
    vm.expectRevert(controllerNotGuardian);
    controller.lockdown(address(pool));
    vm.expectRevert(controllerNotGuardian);
    controller.cancel(address(manager), 0, "", bytes32(0), bytes32(0));
    vm.stopPrank();

    // Nobody (in particular not address(0) semantics leaking) can act as guardian.
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, attacker));
    vm.prank(attacker);
    manager.pauseFunding();
  }

  function test_setGuardian_worksWhileEverythingRestricted() public {
    vm.startPrank(guardian);
    manager.pauseFunding();
    manager.pauseRecall();
    manager.restrictAdapter(adapterId, true, true);
    manager.reduceMaxFundingPerCall(0);
    manager.reduceRecallLimits(0, 0, 0);
    manager.reduceAggregateFundingBudget(0, 0);
    controller.lockdown(address(pool));
    vm.stopPrank();

    vm.prank(address(timelock));
    manager.setGuardian(newGuardian);
    assertEq(manager.guardian(), newGuardian);
  }

  function test_setGuardian_sameAddressAllowed() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.GuardianSet(guardian, guardian);
    vm.prank(address(timelock));
    manager.setGuardian(guardian);
    assertEq(manager.guardian(), guardian);
  }

  function test_setGuardian_throughTimelockCannotBeCancelledByGuardian() public {
    bytes memory data = abi.encodeCall(LiquidityManager.setGuardian, (newGuardian));
    bytes32 id = _schedule(address(manager), data, bytes32(0), bytes32("rotate"));

    vm.expectRevert(abi.encodeWithSelector(GuardianController.ProtectedOperation.selector, id));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, bytes32(0), bytes32("rotate"));

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.prank(governanceSafe);
    timelock.execute(address(manager), 0, data, bytes32(0), bytes32("rotate"));
    assertEq(manager.guardian(), newGuardian);
  }

  // ================================================================
  // │                        Operator roles                        │
  // ================================================================

  function test_setFundingOperator_grantsAndEmits() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.FundingOperatorSet(newOperator, true);
    vm.prank(address(timelock));
    manager.setFundingOperator(newOperator, true);
    assertTrue(manager.isFundingOperator(newOperator));
    assertFalse(manager.isRecallOperator(newOperator));

    _fundAs(newOperator, adapterId, AMOUNT);
  }

  function test_setFundingOperator_revokesAndEmits() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.FundingOperatorSet(fundingOperator, false);
    vm.prank(address(timelock));
    manager.setFundingOperator(fundingOperator, false);
    assertFalse(manager.isFundingOperator(fundingOperator));

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, fundingOperator));
    _fund(AMOUNT);
  }

  function test_setFundingOperator_revertsOnZeroAddress() public {
    vm.startPrank(address(timelock));
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    manager.setFundingOperator(address(0), true);
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    manager.setFundingOperator(address(0), false);
    vm.stopPrank();
  }

  function test_setFundingOperator_rejectsRecallOperator() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorRolesMustBeSeparate.selector, recallOperator));
    vm.prank(address(timelock));
    manager.setFundingOperator(recallOperator, true);
    assertFalse(manager.isFundingOperator(recallOperator));
    assertTrue(manager.isRecallOperator(recallOperator));
  }

  function test_setFundingOperator_revokeOnRecallOperatorIsAllowed() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.FundingOperatorSet(recallOperator, false);
    vm.prank(address(timelock));
    manager.setFundingOperator(recallOperator, false);
    assertFalse(manager.isFundingOperator(recallOperator));
    assertTrue(manager.isRecallOperator(recallOperator), "recall role untouched");
  }

  function test_setFundingOperator_allowedAfterRecallRoleRevoked() public {
    vm.startPrank(address(timelock));
    manager.setRecallOperator(recallOperator, false);
    manager.setFundingOperator(recallOperator, true);
    vm.stopPrank();
    assertTrue(manager.isFundingOperator(recallOperator));
    assertFalse(manager.isRecallOperator(recallOperator));
  }

  function test_setFundingOperator_restoresGuardianSuspension() public {
    vm.prank(guardian);
    manager.suspendFundingOperator(fundingOperator);
    assertFalse(manager.isFundingOperator(fundingOperator));
    vm.prank(address(timelock));
    manager.setFundingOperator(fundingOperator, true);
    _fund(AMOUNT);
  }

  function test_setRecallOperator_grantsAndEmits() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.RecallOperatorSet(newOperator, true);
    vm.prank(address(timelock));
    manager.setRecallOperator(newOperator, true);
    assertTrue(manager.isRecallOperator(newOperator));
    assertFalse(manager.isFundingOperator(newOperator));

    _recallAs(newOperator, adapterId, AMOUNT);
  }

  function test_setRecallOperator_revokesAndEmits() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.RecallOperatorSet(recallOperator, false);
    vm.prank(address(timelock));
    manager.setRecallOperator(recallOperator, false);
    assertFalse(manager.isRecallOperator(recallOperator));
  }

  function test_setRecallOperator_revertsOnZeroAddress() public {
    vm.startPrank(address(timelock));
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    manager.setRecallOperator(address(0), true);
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    manager.setRecallOperator(address(0), false);
    vm.stopPrank();
  }

  function test_setRecallOperator_rejectsFundingOperator() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorRolesMustBeSeparate.selector, fundingOperator));
    vm.prank(address(timelock));
    manager.setRecallOperator(fundingOperator, true);
    assertFalse(manager.isRecallOperator(fundingOperator));
    assertTrue(manager.isFundingOperator(fundingOperator));
  }

  function test_setRecallOperator_revokeOnFundingOperatorIsAllowed() public {
    vm.prank(address(timelock));
    manager.setRecallOperator(fundingOperator, false);
    assertFalse(manager.isRecallOperator(fundingOperator));
    assertTrue(manager.isFundingOperator(fundingOperator), "funding role untouched");
  }

  function test_setRecallOperator_allowedAfterFundingRoleRevoked() public {
    vm.startPrank(address(timelock));
    manager.setFundingOperator(fundingOperator, false);
    manager.setRecallOperator(fundingOperator, true);
    vm.stopPrank();
    assertTrue(manager.isRecallOperator(fundingOperator));
    assertFalse(manager.isFundingOperator(fundingOperator));
  }

  function test_setRecallOperator_restoresGuardianSuspension() public {
    vm.prank(guardian);
    manager.suspendRecallOperator(recallOperator);
    vm.prank(address(timelock));
    manager.setRecallOperator(recallOperator, true);
    _recall(AMOUNT);
  }

  /// @dev Expected revert data of an operator grant: role separation is checked first, then the Guardian exclusion.
  function _expectedGrantError(address operator, bool holdsOtherRole) internal view returns (bytes memory) {
    if (holdsOtherRole) {
      return abi.encodeWithSelector(ILiquidityManager.OperatorRolesMustBeSeparate.selector, operator);
    }
    if (operator == manager.guardian()) {
      return abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, operator);
    }
    return "";
  }

  /// @dev Under any sequence of owner grants/revokes and Guardian suspensions, no address holds both roles, and the
  /// owner setters never grant a role to the Guardian.
  function testFuzz_operatorRoles_neverOverlap(address operator, uint8[12] memory ops) public {
    vm.assume(operator != address(0));
    for (uint256 i = 0; i < ops.length; ++i) {
      uint8 op = ops[i] % 6;
      bool wasFunding = manager.isFundingOperator(operator);
      bool wasRecall = manager.isRecallOperator(operator);
      bool ok;
      bytes memory ret;
      if (op == 0) {
        bytes memory expected = _expectedGrantError(operator, wasRecall);
        vm.prank(address(timelock));
        (ok, ret) = address(manager).call(abi.encodeCall(LiquidityManager.setFundingOperator, (operator, true)));
        assertEq(ok, expected.length == 0);
        if (!ok) assertEq(ret, expected);
      } else if (op == 1) {
        vm.prank(address(timelock));
        manager.setFundingOperator(operator, false);
      } else if (op == 2) {
        bytes memory expected = _expectedGrantError(operator, wasFunding);
        vm.prank(address(timelock));
        (ok, ret) = address(manager).call(abi.encodeCall(LiquidityManager.setRecallOperator, (operator, true)));
        assertEq(ok, expected.length == 0);
        if (!ok) assertEq(ret, expected);
      } else if (op == 3) {
        vm.prank(address(timelock));
        manager.setRecallOperator(operator, false);
      } else if (op == 4) {
        vm.prank(guardian);
        manager.suspendFundingOperator(operator);
      } else {
        vm.prank(guardian);
        manager.suspendRecallOperator(operator);
      }
      assertFalse(manager.isFundingOperator(operator) && manager.isRecallOperator(operator), "roles overlap");
      if (operator == guardian) {
        assertFalse(manager.isFundingOperator(operator) || manager.isRecallOperator(operator), "guardian granted");
      }
    }
  }

  /// @dev The fuzzer may not hit the Guardian address; pin the case explicitly.
  function test_operatorRoles_neverOverlap_guardianCase() public {
    uint8[12] memory ops = [0, 2, 1, 0, 3, 2, 4, 0, 5, 2, 0, 2];
    testFuzz_operatorRoles_neverOverlap(guardian, ops);
  }

  // ================================================================
  // │                         Pause flags                          │
  // ================================================================

  function test_setFundingPaused_togglesAndEmits() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.FundingPausedSet(true);
    vm.prank(address(timelock));
    manager.setFundingPaused(true);
    assertTrue(manager.fundingPaused());
    vm.expectRevert(ILiquidityManager.FundingIsPaused.selector);
    _fund(AMOUNT);

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.FundingPausedSet(false);
    vm.prank(address(timelock));
    manager.setFundingPaused(false);
    assertFalse(manager.fundingPaused());
    _fund(AMOUNT);
  }

  function test_setFundingPaused_ownerLiftsGuardianPause() public {
    vm.prank(guardian);
    manager.pauseFunding();
    vm.prank(address(timelock));
    manager.setFundingPaused(false);
    _fund(AMOUNT);
  }

  function test_setFundingPaused_doesNotAffectRecall() public {
    vm.prank(address(timelock));
    manager.setFundingPaused(true);
    assertFalse(manager.recallPaused());
    _recall(AMOUNT);
  }

  function test_setRecallPaused_togglesAndEmits() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.RecallPausedSet(true);
    vm.prank(address(timelock));
    manager.setRecallPaused(true);
    assertTrue(manager.recallPaused());
    vm.expectRevert(ILiquidityManager.RecallIsPaused.selector);
    _recall(AMOUNT);

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.RecallPausedSet(false);
    vm.prank(address(timelock));
    manager.setRecallPaused(false);
    assertFalse(manager.recallPaused());
    _recall(AMOUNT);
  }

  function test_setRecallPaused_doesNotAffectFunding() public {
    vm.prank(address(timelock));
    manager.setRecallPaused(true);
    assertFalse(manager.fundingPaused());
    _fund(AMOUNT);
  }

  function test_guardianCannotLiftPausesThroughOwnerSetters() public {
    vm.startPrank(guardian);
    manager.pauseFunding();
    manager.pauseRecall();
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
    manager.setFundingPaused(false);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
    manager.setRecallPaused(false);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
    manager.setRecallLimits(type(uint256).max, type(uint256).max, type(uint256).max);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
    manager.setAdapterStatus(adapterId, true, true);
    vm.stopPrank();
    assertTrue(manager.fundingPaused());
    assertTrue(manager.recallPaused());
  }

  function test_setRecallOperator_throughTimelock() public {
    _scheduleAndExecute(
      address(manager), abi.encodeCall(LiquidityManager.setRecallOperator, (newOperator, true)), bytes32("grant")
    );
    assertTrue(manager.isRecallOperator(newOperator));
    _recallAs(newOperator, adapterId, AMOUNT);
  }

  // ================================================================
  // │                      maxFundingPerCall                       │
  // ================================================================

  function test_setMaxFundingPerCall_setsAndEmits() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.MaxFundingPerCallSet(AMOUNT);
    vm.prank(address(timelock));
    manager.setMaxFundingPerCall(AMOUNT);
    assertEq(manager.maxFundingPerCall(), AMOUNT);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.ExceedsPerCallLimit.selector, AMOUNT + 1, AMOUNT));
    _fund(AMOUNT + 1);
    _fund(AMOUNT);
  }

  function test_setMaxFundingPerCall_zeroBlocksFunding() public {
    vm.prank(address(timelock));
    manager.setMaxFundingPerCall(0);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.ExceedsPerCallLimit.selector, 1, 0));
    _fund(1);
  }

  function test_setMaxFundingPerCall_ownerRaisesAfterGuardianReduce() public {
    vm.prank(guardian);
    manager.reduceMaxFundingPerCall(1e18);
    vm.prank(address(timelock));
    manager.setMaxFundingPerCall(MAX_FUNDING_PER_CALL);
    assertEq(manager.maxFundingPerCall(), MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);
  }

  // ================================================================
  // │                   Aggregate funding budget                   │
  // ================================================================

  function test_setAggregateFundingBudget_firstConfigurationStartsFull() public {
    LiquidityManager fresh = _newManager();
    vm.expectEmit(true, true, true, true, address(fresh));
    emit ILiquidityManager.AggregateFundingBudgetSet(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    vm.prank(address(timelock));
    fresh.setAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    _assertBudget(
      fresh.getAggregateFundingBudget(),
      ILiquidityManager.BudgetState(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE, AGGREGATE_FUNDING_CAPACITY)
    );
  }

  function test_setAggregateFundingBudget_raiseDoesNotRestoreConsumed() public {
    _fund(MAX_FUNDING_PER_CALL);
    vm.prank(address(timelock));
    manager.setAggregateFundingBudget(4 * AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    _assertBudget(
      manager.getAggregateFundingBudget(),
      ILiquidityManager.BudgetState(
        4 * AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE, AGGREGATE_FUNDING_CAPACITY - MAX_FUNDING_PER_CALL
      )
    );
  }

  function test_setAggregateFundingBudget_lowerCapsAvailable() public {
    vm.prank(address(timelock));
    manager.setAggregateFundingBudget(AMOUNT, AGGREGATE_FUNDING_RATE);
    assertEq(manager.getAggregateFundingBudget().available, AMOUNT);
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, AMOUNT + 1, AMOUNT));
    _fund(AMOUNT + 1);
  }

  function test_setAggregateFundingBudget_elapsedTimeRefilledAtOldRate() public {
    _fund(MAX_FUNDING_PER_CALL);
    vm.warp(block.timestamp + 100);
    vm.prank(address(timelock));
    manager.setAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, 0);
    uint256 expected = AGGREGATE_FUNDING_CAPACITY - MAX_FUNDING_PER_CALL + 100 * AGGREGATE_FUNDING_RATE;
    assertEq(manager.getAggregateFundingBudget().available, expected);
    vm.warp(block.timestamp + 10 days);
    assertEq(manager.getAggregateFundingBudget().available, expected, "no refill at rate 0");
  }

  function test_setAggregateFundingBudget_zeroFirstThenRaiseStartsEmpty() public {
    LiquidityManager fresh = _newManager();
    vm.startPrank(address(timelock));
    fresh.setAggregateFundingBudget(0, 0);
    fresh.setAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    vm.stopPrank();
    assertEq(fresh.getAggregateFundingBudget().available, 0, "only the first configuration starts full");
    vm.warp(block.timestamp + 10);
    assertEq(fresh.getAggregateFundingBudget().available, 10 * AGGREGATE_FUNDING_RATE);
  }

  // ================================================================
  // │                     Pool funding budget                      │
  // ================================================================

  function test_setPoolFundingBudget_revertsOnZeroPool() public {
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(0), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
  }

  function test_setPoolFundingBudget_setsEmitsAndStartsFull() public {
    address futurePool = makeAddr("futurePool");
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.PoolFundingBudgetSet(futurePool, AMOUNT, 7);
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(futurePool, AMOUNT, 7);
    _assertBudget(manager.getPoolFundingBudget(futurePool), ILiquidityManager.BudgetState(AMOUNT, 7, AMOUNT));
  }

  function test_setPoolFundingBudget_raiseDoesNotRestoreConsumed() public {
    _fund(MAX_FUNDING_PER_CALL);
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(pool), 4 * POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    _assertBudget(
      manager.getPoolFundingBudget(address(pool)),
      ILiquidityManager.BudgetState(
        4 * POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE, POOL_FUNDING_CAPACITY - MAX_FUNDING_PER_CALL
      )
    );
  }

  function test_setPoolFundingBudget_lowerCapsAvailable() public {
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(pool), AMOUNT, POOL_FUNDING_RATE);
    assertEq(manager.getPoolFundingBudget(address(pool)).available, AMOUNT);
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, AMOUNT + 1, AMOUNT));
    _fund(AMOUNT + 1);
  }

  function test_setPoolFundingBudget_isPerPool() public {
    address otherPool = makeAddr("otherPool");
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(otherPool, 1, 1);
    _assertBudget(
      manager.getPoolFundingBudget(address(pool)),
      ILiquidityManager.BudgetState(POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE, POOL_FUNDING_CAPACITY)
    );
  }

  function test_setPoolFundingBudget_ownerRestoresAfterGuardianReduce() public {
    vm.prank(guardian);
    manager.reducePoolFundingBudget(address(pool), AMOUNT, 0);
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    ILiquidityManager.BudgetState memory state = manager.getPoolFundingBudget(address(pool));
    assertEq(state.capacity, POOL_FUNDING_CAPACITY);
    assertEq(state.available, AMOUNT, "restoration does not refill");
    vm.warp(block.timestamp + 100);
    assertEq(manager.getPoolFundingBudget(address(pool)).available, AMOUNT + 100 * POOL_FUNDING_RATE);
  }

  // ================================================================
  // │                        Recall limits                         │
  // ================================================================

  function test_setRecallLimits_setsAndEmits() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.RecallLimitsSet(AMOUNT, 2 * RECALL_CAPACITY, 2 * RECALL_RATE);
    vm.prank(address(timelock));
    manager.setRecallLimits(AMOUNT, 2 * RECALL_CAPACITY, 2 * RECALL_RATE);
    assertEq(manager.maxRecallPerCall(), AMOUNT);
    ILiquidityManager.BudgetState memory state = manager.getRecallBudget();
    assertEq(state.capacity, 2 * RECALL_CAPACITY);
    assertEq(state.rate, 2 * RECALL_RATE);
    assertEq(state.available, RECALL_CAPACITY, "not refilled to the new capacity");
  }

  function test_setRecallLimits_firstConfigurationStartsFull() public {
    LiquidityManager fresh = _newManager();
    vm.prank(address(timelock));
    fresh.setRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE);
    assertEq(fresh.maxRecallPerCall(), MAX_RECALL_PER_CALL);
    _assertBudget(fresh.getRecallBudget(), ILiquidityManager.BudgetState(RECALL_CAPACITY, RECALL_RATE, RECALL_CAPACITY));
  }

  function test_setRecallLimits_raiseDoesNotRestoreConsumed() public {
    _recall(MAX_RECALL_PER_CALL);
    vm.prank(address(timelock));
    manager.setRecallLimits(MAX_RECALL_PER_CALL, 4 * RECALL_CAPACITY, RECALL_RATE);
    assertEq(manager.getRecallBudget().available, RECALL_CAPACITY - MAX_RECALL_PER_CALL);
  }

  function test_setRecallLimits_lowerCapsAvailable() public {
    vm.prank(address(timelock));
    manager.setRecallLimits(MAX_RECALL_PER_CALL, AMOUNT, RECALL_RATE);
    assertEq(manager.getRecallBudget().available, AMOUNT);
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, AMOUNT + 1, AMOUNT));
    _recall(AMOUNT + 1);
  }

  function test_setRecallLimits_ownerRestoresAfterGuardianReduce() public {
    vm.prank(guardian);
    manager.reduceRecallLimits(1e18, 1e18, 0);
    vm.prank(address(timelock));
    manager.setRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE);
    assertEq(manager.maxRecallPerCall(), MAX_RECALL_PER_CALL);
    assertEq(manager.getRecallBudget().available, 1e18, "restoration does not refill");
    vm.warp(block.timestamp + 1_000);
    assertEq(manager.getRecallBudget().available, 1e18 + 1_000 * RECALL_RATE);
  }

  function testFuzz_setRecallLimits_keepsUsage(
    uint256 used,
    uint256 elapsed,
    uint256 newCapacity,
    uint256 newRate,
    uint256 elapsedAfter
  ) public {
    used = bound(used, 0, MAX_RECALL_PER_CALL);
    elapsed = bound(elapsed, 0, 10 days);
    newCapacity = bound(newCapacity, 0, 1e30);
    newRate = bound(newRate, 0, 1e24);
    elapsedAfter = bound(elapsedAfter, 0, 10 days);

    if (used > 0) _recall(used);
    vm.warp(block.timestamp + elapsed);
    uint256 refilled = _min(RECALL_CAPACITY, RECALL_CAPACITY - used + elapsed * RECALL_RATE);

    vm.prank(address(timelock));
    manager.setRecallLimits(MAX_RECALL_PER_CALL, newCapacity, newRate);
    uint256 expected = _min(refilled, newCapacity);
    _assertBudget(manager.getRecallBudget(), ILiquidityManager.BudgetState(newCapacity, newRate, expected));

    vm.warp(block.timestamp + elapsedAfter);
    assertEq(manager.getRecallBudget().available, _min(newCapacity, expected + elapsedAfter * newRate));
  }

  // ================================================================
  // │                       migrateReserves                        │
  // ================================================================

  function test_migrateReserves_revertsOnZeroTo() public {
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    vm.prank(address(timelock));
    manager.migrateReserves(address(0), AMOUNT);
  }

  function test_migrateReserves_revertsOnZeroAmount() public {
    vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
    vm.prank(address(timelock));
    manager.migrateReserves(newOwner, 0);
  }

  function test_migrateReserves_transfersAndEmits() public {
    address successor = makeAddr("successorManager");
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.ReservesMigrated(successor, AMOUNT);
    vm.prank(address(timelock));
    manager.migrateReserves(successor, AMOUNT);
    assertEq(_balance(successor), AMOUNT);
    assertEq(_balance(address(manager)), MANAGER_RESERVES - AMOUNT);
  }

  function testFuzz_migrateReserves(uint256 amount) public {
    amount = bound(amount, 1, MANAGER_RESERVES);
    address successor = makeAddr("successorManager");
    vm.prank(address(timelock));
    manager.migrateReserves(successor, amount);
    assertEq(_balance(successor), amount);
    assertEq(_balance(address(manager)), MANAGER_RESERVES - amount);
  }

  function test_migrateReserves_revertsAboveBalance() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        IERC20Errors.ERC20InsufficientBalance.selector, address(manager), MANAGER_RESERVES, MANAGER_RESERVES + 1
      )
    );
    vm.prank(address(timelock));
    manager.migrateReserves(newOwner, MANAGER_RESERVES + 1);
  }

  function test_migrateReserves_worksWhileRestricted() public {
    vm.startPrank(guardian);
    manager.pauseFunding();
    manager.pauseRecall();
    manager.restrictAdapter(adapterId, true, true);
    vm.stopPrank();
    vm.prank(address(timelock));
    manager.migrateReserves(newOwner, MANAGER_RESERVES);
    assertEq(_balance(address(manager)), 0);
  }

  function test_migrateReserves_throughTimelock() public {
    bytes memory data = abi.encodeCall(LiquidityManager.migrateReserves, (newOwner, AMOUNT));
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, governanceSafe));
    vm.prank(governanceSafe);
    manager.migrateReserves(newOwner, AMOUNT);

    _scheduleAndExecute(address(manager), data, bytes32("migrate"));
    assertEq(_balance(newOwner), AMOUNT);
  }

  // ================================================================
  // │                         recoverToken                         │
  // ================================================================

  function test_recoverToken_rejectsReserveToken() public {
    vm.expectRevert(ILiquidityManager.CannotRecoverReserveToken.selector);
    vm.prank(address(timelock));
    manager.recoverToken(address(token), treasury, AMOUNT);
  }

  function test_recoverToken_reserveCheckPrecedesZeroRecipient() public {
    vm.expectRevert(ILiquidityManager.CannotRecoverReserveToken.selector);
    vm.prank(address(timelock));
    manager.recoverToken(address(token), address(0), AMOUNT);
  }

  function test_recoverToken_revertsOnZeroRecipient() public {
    MockSahara stray = new MockSahara(address(manager));
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    vm.prank(address(timelock));
    manager.recoverToken(address(stray), address(0), 1e18);
  }

  function test_recoverToken_zeroAmountIsAllowed() public {
    MockSahara stray = new MockSahara(address(manager));
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.TokenRecovered(address(stray), treasury, 0);
    vm.prank(address(timelock));
    manager.recoverToken(address(stray), treasury, 0);
    assertEq(stray.balanceOf(treasury), 0);
  }

  function test_recoverToken_revertsAboveBalance() public {
    MockSahara stray = new MockSahara(treasury);
    vm.prank(treasury);
    stray.transfer(address(manager), 5e18);
    vm.expectRevert(
      abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(manager), 5e18, 5e18 + 1)
    );
    vm.prank(address(timelock));
    manager.recoverToken(address(stray), treasury, 5e18 + 1);
  }

  function test_recoverToken_recoversOtherTokenAndEmits() public {
    MockSahara stray = new MockSahara(address(manager));
    uint256 reservesBefore = _balance(address(manager));

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.TokenRecovered(address(stray), treasury, 5e18);
    vm.prank(address(timelock));
    manager.recoverToken(address(stray), treasury, 5e18);

    assertEq(stray.balanceOf(treasury), 5e18);
    assertEq(stray.balanceOf(address(manager)), stray.SUPPLY() - 5e18);
    assertEq(_balance(address(manager)), reservesBefore, "reserves untouched");
  }

  // ================================================================
  // │                          Ownership                           │
  // ================================================================

  function test_renounceOwnership_revertsForOwner() public {
    vm.expectRevert(ILiquidityManager.OwnershipCannotBeRenounced.selector);
    vm.prank(address(timelock));
    manager.renounceOwnership();
    assertEq(manager.owner(), address(timelock));
  }

  function test_renounceOwnership_revertsForAnyone() public {
    vm.expectRevert(ILiquidityManager.OwnershipCannotBeRenounced.selector);
    vm.prank(attacker);
    manager.renounceOwnership();
    assertEq(manager.owner(), address(timelock));
  }

  function test_transferOwnership_isTwoStep() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit Ownable2Step.OwnershipTransferStarted(address(timelock), newOwner);
    vm.prank(address(timelock));
    manager.transferOwnership(newOwner);

    assertEq(manager.owner(), address(timelock), "owner unchanged until accepted");
    assertEq(manager.pendingOwner(), newOwner);

    // Pending owner has no authority yet; current owner keeps it.
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
    vm.prank(newOwner);
    manager.setGuardian(attacker);
    vm.prank(address(timelock));
    manager.setRecallPaused(true);
  }

  function test_acceptOwnership_revertsForNonPending() public {
    vm.prank(address(timelock));
    manager.transferOwnership(newOwner);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
    vm.prank(attacker);
    manager.acceptOwnership();
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(timelock)));
    vm.prank(address(timelock));
    manager.acceptOwnership();
  }

  function test_acceptOwnership_withoutPendingReverts() public {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
    vm.prank(newOwner);
    manager.acceptOwnership();
    assertEq(manager.owner(), address(timelock));
  }

  function test_acceptOwnership_completesTransfer() public {
    vm.prank(address(timelock));
    manager.transferOwnership(newOwner);

    vm.expectEmit(true, true, true, true, address(manager));
    emit Ownable.OwnershipTransferred(address(timelock), newOwner);
    vm.prank(newOwner);
    manager.acceptOwnership();

    assertEq(manager.owner(), newOwner);
    assertEq(manager.pendingOwner(), address(0));

    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(timelock)));
    vm.prank(address(timelock));
    manager.setGuardian(attacker);

    vm.prank(newOwner);
    manager.setGuardian(newGuardian);
    assertEq(manager.guardian(), newGuardian);
  }

  function test_transferOwnership_toZeroCancelsPending() public {
    vm.startPrank(address(timelock));
    manager.transferOwnership(newOwner);
    manager.transferOwnership(address(0));
    vm.stopPrank();
    assertEq(manager.pendingOwner(), address(0));
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
    vm.prank(newOwner);
    manager.acceptOwnership();
  }

  function test_transferOwnership_overwritesPending() public {
    vm.startPrank(address(timelock));
    manager.transferOwnership(attacker);
    manager.transferOwnership(newOwner);
    vm.stopPrank();
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
    vm.prank(attacker);
    manager.acceptOwnership();
    vm.prank(newOwner);
    manager.acceptOwnership();
    assertEq(manager.owner(), newOwner);
  }

  function test_transferOwnership_throughTimelock() public {
    _scheduleAndExecute(address(manager), abi.encodeCall(Ownable.transferOwnership, (newOwner)), bytes32("handover"));
    assertEq(manager.pendingOwner(), newOwner);
    vm.prank(newOwner);
    manager.acceptOwnership();
    assertEq(manager.owner(), newOwner);
  }

  // ================================================================
  // │                   Owner-only access control                  │
  // ================================================================

  /// @dev One call per owner-only function, with arguments that would succeed for the owner.
  function _ownerCalls() internal view returns (bytes[] memory calls) {
    calls = new bytes[](18);
    calls[0] = abi.encodeCall(LiquidityManager.setGuardian, (attacker));
    calls[1] = abi.encodeCall(LiquidityManager.setFundingOperator, (attacker, true));
    calls[2] = abi.encodeCall(LiquidityManager.setRecallOperator, (attacker, true));
    calls[3] = abi.encodeCall(LiquidityManager.setFundingPaused, (true));
    calls[4] = abi.encodeCall(LiquidityManager.setRecallPaused, (true));
    calls[5] = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (type(uint256).max));
    calls[6] = abi.encodeCall(LiquidityManager.setAggregateFundingBudget, (type(uint128).max, 1e30));
    calls[7] = abi.encodeCall(LiquidityManager.setPoolFundingBudget, (address(pool), type(uint128).max, 1e30));
    calls[8] = abi.encodeCall(LiquidityManager.setRecallLimits, (type(uint128).max, type(uint128).max, 1e30));
    calls[9] = abi.encodeCall(LiquidityManager.setPoolSpec, (address(pool), _poolSpec()));
    calls[10] = abi.encodeCall(LiquidityManager.setPoolThresholds, (address(pool), 0, 0, 0));
    calls[11] = abi.encodeCall(LiquidityManager.setPoolMigrationApproval, (attacker, address(pool)));
    calls[12] = abi.encodeCall(LiquidityManager.registerAdapter, (address(adapter), attacker));
    calls[13] = abi.encodeCall(LiquidityManager.replaceAdapter, (adapterId, attacker));
    calls[14] = abi.encodeCall(LiquidityManager.setAdapterStatus, (adapterId, false, false));
    calls[15] = abi.encodeCall(LiquidityManager.migrateReserves, (attacker, MANAGER_RESERVES));
    calls[16] = abi.encodeCall(LiquidityManager.recoverToken, (address(registry), attacker, 1));
    calls[17] = abi.encodeCall(Ownable.transferOwnership, (attacker));
  }

  /// @dev The same functions with arguments that would fail validation: the owner check must come first.
  function _ownerCallsWithInvalidArguments() internal pure returns (bytes[] memory calls) {
    ILiquidityManager.PoolSpec memory emptySpec;
    calls = new bytes[](11);
    calls[0] = abi.encodeCall(LiquidityManager.setFundingOperator, (address(0), true));
    calls[1] = abi.encodeCall(LiquidityManager.setRecallOperator, (address(0), true));
    calls[2] = abi.encodeCall(LiquidityManager.setPoolFundingBudget, (address(0), 1, 1));
    calls[3] = abi.encodeCall(LiquidityManager.setPoolSpec, (address(0), emptySpec));
    calls[4] = abi.encodeCall(LiquidityManager.setPoolThresholds, (address(0), 3, 2, 1));
    calls[5] = abi.encodeCall(LiquidityManager.setPoolMigrationApproval, (address(0), address(0)));
    calls[6] = abi.encodeCall(LiquidityManager.registerAdapter, (address(0), address(0)));
    calls[7] = abi.encodeCall(LiquidityManager.replaceAdapter, (0, address(0)));
    calls[8] = abi.encodeCall(LiquidityManager.setAdapterStatus, (0, true, true));
    calls[9] = abi.encodeCall(LiquidityManager.migrateReserves, (address(0), 0));
    calls[10] = abi.encodeCall(LiquidityManager.recoverToken, (address(0), address(0), 0));
  }

  function _assertOwnerCallsRevert(address caller, bytes[] memory calls) internal {
    bytes memory expected = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller);
    for (uint256 i = 0; i < calls.length; ++i) {
      vm.prank(caller);
      (bool ok, bytes memory ret) = address(manager).call(calls[i]);
      assertFalse(ok, "non-owner call succeeded");
      assertEq(ret, expected, "wrong revert data");
    }
  }

  function _assertStateUntouched() internal view {
    assertEq(manager.owner(), address(timelock));
    assertEq(manager.pendingOwner(), address(0));
    assertEq(manager.guardian(), guardian);
    assertFalse(manager.fundingPaused());
    assertFalse(manager.recallPaused());
    assertEq(manager.maxFundingPerCall(), MAX_FUNDING_PER_CALL);
    assertEq(manager.maxRecallPerCall(), MAX_RECALL_PER_CALL);
    assertEq(manager.adapterCount(), 1);
    assertEq(manager.getAdapter(adapterId).adapter, address(adapter));
    assertEq(_balance(address(manager)), MANAGER_RESERVES);
  }

  function test_ownerFunctions_rejectGuardian() public {
    _assertOwnerCallsRevert(guardian, _ownerCalls());
    _assertStateUntouched();
  }

  function test_ownerFunctions_rejectFundingOperator() public {
    _assertOwnerCallsRevert(fundingOperator, _ownerCalls());
    _assertStateUntouched();
  }

  function test_ownerFunctions_rejectRecallOperator() public {
    _assertOwnerCallsRevert(recallOperator, _ownerCalls());
    _assertStateUntouched();
  }

  function test_ownerFunctions_rejectGovernanceSafe() public {
    // The Safe is only the Timelock proposer; it has no direct authority.
    _assertOwnerCallsRevert(governanceSafe, _ownerCalls());
    _assertStateUntouched();
  }

  function test_ownerFunctions_rejectControllerAdapterAndPool() public {
    _assertOwnerCallsRevert(address(controller), _ownerCalls());
    _assertOwnerCallsRevert(address(adapter), _ownerCalls());
    _assertOwnerCallsRevert(address(pool), _ownerCalls());
    _assertStateUntouched();
  }

  function test_ownerFunctions_rejectPendingOwner() public {
    vm.prank(address(timelock));
    manager.transferOwnership(newOwner);
    _assertOwnerCallsRevert(newOwner, _ownerCalls());
  }

  function test_ownerFunctions_ownerCheckPrecedesArgumentValidation() public {
    _assertOwnerCallsRevert(attacker, _ownerCallsWithInvalidArguments());
    _assertOwnerCallsRevert(guardian, _ownerCallsWithInvalidArguments());
  }

  function testFuzz_ownerFunctions_rejectNonOwner(address caller) public {
    vm.assume(caller != address(timelock));
    _assertOwnerCallsRevert(caller, _ownerCalls());
    _assertStateUntouched();
  }

  // ================================================================
  // │                           Helpers                            │
  // ================================================================

  function _assertBudget(ILiquidityManager.BudgetState memory actual, ILiquidityManager.BudgetState memory expected)
    internal
    pure
  {
    assertEq(actual.capacity, expected.capacity, "capacity");
    assertEq(actual.rate, expected.rate, "rate");
    assertEq(actual.available, expected.available, "available");
  }
}
