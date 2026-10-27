// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {TokenBucket} from "src/libraries/TokenBucket.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";

import {RecallAdminBase} from "test/recall-admin/RecallAdminBase.sol";
import {MaliciousAdapter} from "test/recall-admin/mocks/MaliciousAdapter.sol";
import {MaliciousPool} from "test/recall-admin/mocks/MaliciousPool.sol";

contract LiquidityManagerRecallTest is RecallAdminBase {
  uint256 internal constant AMOUNT = 10_000_000e18;

  // ================================================================
  // │                       Happy path                             │
  // ================================================================

  function test_recall_movesExactAmountAndEmits() public {
    uint256 managerBefore = _balance(address(manager));
    uint256 poolBefore = _balance(address(pool));

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Recalled(adapterId, address(pool), recallOperator, address(adapter), AMOUNT);
    _recall(AMOUNT);

    assertEq(_balance(address(manager)), managerBefore + AMOUNT, "manager");
    assertEq(_balance(address(pool)), poolBefore - AMOUNT, "pool");
    assertEq(_balance(address(adapter)), 0, "adapter");
    assertEq(manager.getRecallBudget().available, RECALL_CAPACITY - AMOUNT, "recall budget");
  }

  function testFuzz_recall_movesExactAmount(uint256 amount) public {
    amount = bound(amount, 1, MAX_RECALL_PER_CALL);
    uint256 managerBefore = _balance(address(manager));
    uint256 poolBefore = _balance(address(pool));

    _recall(amount);

    assertEq(_balance(address(manager)), managerBefore + amount);
    assertEq(_balance(address(pool)), poolBefore - amount);
    assertEq(_balance(address(adapter)), 0);
    assertEq(manager.getRecallBudget().available, RECALL_CAPACITY - amount);
  }

  function test_recall_preservesUnsolicitedAdapterBalance() public {
    _seed(address(adapter), 1_234e18);
    uint256 managerBefore = _balance(address(manager));

    _recall(AMOUNT);

    assertEq(_balance(address(adapter)), 1_234e18, "unsolicited balance untouched");
    assertEq(_balance(address(manager)), managerBefore + AMOUNT);
  }

  function test_recall_unsolicitedPoolInflowCountsAsInventory() public {
    // Pool at the minimum: nothing recallable.
    _setPoolBalance(address(pool), POOL_MINIMUM);
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, POOL_MINIMUM, 1, POOL_MINIMUM)
    );
    _recall(1);

    // A direct transfer to the pool raises recallable inventory.
    _seed(address(pool), AMOUNT);
    _recall(AMOUNT);
    assertEq(_balance(address(pool)), POOL_MINIMUM);
  }

  // ================================================================
  // │                      Access control                          │
  // ================================================================

  function test_recall_revertsForNonOperator() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, attacker));
    _recallAs(attacker, adapterId, AMOUNT);
  }

  function test_recall_revertsForFundingOperator() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, fundingOperator));
    _recallAs(fundingOperator, adapterId, AMOUNT);
  }

  function test_recall_revertsForGuardian() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, guardian));
    _recallAs(guardian, adapterId, AMOUNT);
  }

  function test_recall_revertsForOwner() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, address(timelock)));
    _recallAs(address(timelock), adapterId, AMOUNT);
  }

  function test_recall_revertsForGovernanceSafeAdapterAndPool() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, governanceSafe));
    _recallAs(governanceSafe, adapterId, AMOUNT);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, address(adapter)));
    _recallAs(address(adapter), adapterId, AMOUNT);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, address(pool)));
    _recallAs(address(pool), adapterId, AMOUNT);
  }

  function testFuzz_recall_revertsForAnyNonOperator(address caller) public {
    vm.assume(caller != recallOperator);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, caller));
    _recallAs(caller, adapterId, AMOUNT);
  }

  function test_recall_roleCheckedBeforeEverythingElse() public {
    vm.prank(guardian);
    manager.pauseRecall();
    // Paused, unknown adapter and zero amount: the role error still comes first.
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, attacker));
    _recallAs(attacker, 0, 0);
  }

  function test_recall_revertsAfterOwnerRevokesOperator() public {
    vm.prank(address(timelock));
    manager.setRecallOperator(recallOperator, false);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, recallOperator));
    _recall(AMOUNT);
  }

  function test_recall_revertsAfterGuardianSuspendsOperator() public {
    vm.prank(guardian);
    manager.suspendRecallOperator(recallOperator);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, recallOperator));
    _recall(AMOUNT);
  }

  function test_recall_newlyGrantedOperatorCanRecall() public {
    address keeper = makeAddr("recallKeeper");
    vm.prank(address(timelock));
    manager.setRecallOperator(keeper, true);

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Recalled(adapterId, address(pool), keeper, address(adapter), AMOUNT);
    _recallAs(keeper, adapterId, AMOUNT);
  }

  // ================================================================
  // │                           Pause                              │
  // ================================================================

  function test_recall_revertsWhenPausedByOwner() public {
    vm.prank(address(timelock));
    manager.setRecallPaused(true);
    vm.expectRevert(ILiquidityManager.RecallIsPaused.selector);
    _recall(AMOUNT);
  }

  function test_recall_revertsWhenPausedByGuardian() public {
    vm.prank(guardian);
    manager.pauseRecall();
    vm.expectRevert(ILiquidityManager.RecallIsPaused.selector);
    _recall(AMOUNT);
  }

  function test_recall_resumesAfterOwnerUnpause() public {
    vm.prank(guardian);
    manager.pauseRecall();
    vm.prank(address(timelock));
    manager.setRecallPaused(false);
    _recall(AMOUNT);
    assertEq(_balance(address(pool)), POOL_INVENTORY - AMOUNT);
  }

  function test_recall_pauseCheckedBeforeAdapterLookup() public {
    vm.prank(guardian);
    manager.pauseRecall();
    vm.expectRevert(ILiquidityManager.RecallIsPaused.selector);
    _recallAs(recallOperator, 99, 0);
  }

  function test_recall_worksWhileFundingPaused() public {
    vm.startPrank(guardian);
    manager.pauseFunding();
    manager.suspendFundingOperator(fundingOperator);
    manager.restrictAdapter(adapterId, true, false);
    vm.stopPrank();

    _recall(AMOUNT);
    assertEq(_balance(address(pool)), POOL_INVENTORY - AMOUNT);
  }

  function test_recall_unaffectedByFundingPauseFlagFromOwner() public {
    vm.prank(address(timelock));
    manager.setFundingPaused(true);
    _recall(AMOUNT);
    assertEq(_balance(address(pool)), POOL_INVENTORY - AMOUNT);
  }

  // ================================================================
  // │                      Adapter lookup                          │
  // ================================================================

  function test_recall_revertsForAdapterIdZero() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 0));
    _recallAs(recallOperator, 0, AMOUNT);
  }

  function test_recall_revertsForUnregisteredAdapterId() public {
    uint256 next = manager.adapterCount() + 1;
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, next));
    _recallAs(recallOperator, next, AMOUNT);
  }

  function testFuzz_recall_revertsForUnknownAdapterId(uint256 id) public {
    vm.assume(id == 0 || id > manager.adapterCount());
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, id));
    _recallAs(recallOperator, id, AMOUNT);
  }

  function test_recall_revertsWhenRecallDisabledByOwner() public {
    vm.prank(address(timelock));
    manager.setAdapterStatus(adapterId, true, false);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RecallDisabled.selector, adapterId));
    _recall(AMOUNT);
  }

  function test_recall_revertsWhenRecallDisabledByGuardian() public {
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, false, true);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RecallDisabled.selector, adapterId));
    _recall(AMOUNT);
  }

  function test_recall_recallDisabledCheckedBeforeAmount() public {
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, false, true);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RecallDisabled.selector, adapterId));
    _recall(0);
  }

  function test_recall_worksWhenOnlyFundingDisabled() public {
    vm.prank(address(timelock));
    manager.setAdapterStatus(adapterId, false, true);
    _recall(AMOUNT);
    assertEq(_balance(address(pool)), POOL_INVENTORY - AMOUNT);
  }

  function test_recall_reenabledByOwnerAfterGuardianRestriction() public {
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, true, true);
    vm.prank(address(timelock));
    manager.setAdapterStatus(adapterId, false, true);
    _recall(AMOUNT);
    assertEq(_balance(address(pool)), POOL_INVENTORY - AMOUNT);
  }

  function test_recall_disablingOneAdapterLeavesOthersUsable() public {
    MaliciousPool pool2 = new MaliciousPool(address(token), router);
    (, uint256 id2) = _registerPool(pool2);

    vm.prank(guardian);
    manager.restrictAdapter(adapterId, false, true);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RecallDisabled.selector, adapterId));
    _recall(AMOUNT);
    _recallAs(recallOperator, id2, AMOUNT);
    assertEq(_balance(address(pool2)), POOL_INVENTORY - AMOUNT);
  }

  // ================================================================
  // │                     Amount and per-call                      │
  // ================================================================

  function test_recall_revertsOnZeroAmount() public {
    vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
    _recall(0);
  }

  function test_recall_zeroAmountCheckedBeforePerCallLimit() public {
    vm.prank(address(timelock));
    manager.setRecallLimits(0, RECALL_CAPACITY, RECALL_RATE);
    vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
    _recall(0);
  }

  function test_recall_atPerCallLimitSucceeds() public {
    _recall(MAX_RECALL_PER_CALL);
    assertEq(_balance(address(pool)), POOL_INVENTORY - MAX_RECALL_PER_CALL);
  }

  function test_recall_aboveperCallLimitReverts() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        ILiquidityManager.ExceedsPerCallLimit.selector, MAX_RECALL_PER_CALL + 1, MAX_RECALL_PER_CALL
      )
    );
    _recall(MAX_RECALL_PER_CALL + 1);
  }

  function testFuzz_recall_abovePerCallLimitReverts(uint256 amount) public {
    amount = bound(amount, MAX_RECALL_PER_CALL + 1, type(uint256).max);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.ExceedsPerCallLimit.selector, amount, MAX_RECALL_PER_CALL));
    _recall(amount);
  }

  function test_recall_zeroPerCallLimitBlocksAll() public {
    vm.prank(address(timelock));
    manager.setRecallLimits(0, RECALL_CAPACITY, RECALL_RATE);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.ExceedsPerCallLimit.selector, 1, 0));
    _recall(1);
  }

  function test_recall_perCallLimitReducedByGuardian() public {
    vm.prank(guardian);
    manager.reduceRecallLimits(AMOUNT, RECALL_CAPACITY, RECALL_RATE);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.ExceedsPerCallLimit.selector, AMOUNT + 1, AMOUNT));
    _recall(AMOUNT + 1);
    _recall(AMOUNT);
  }

  function test_recall_perCallCheckedBeforeBudget() public {
    _recall(MAX_RECALL_PER_CALL);
    _recall(MAX_RECALL_PER_CALL);
    assertEq(manager.getRecallBudget().available, 0);
    vm.expectRevert(
      abi.encodeWithSelector(
        ILiquidityManager.ExceedsPerCallLimit.selector, MAX_RECALL_PER_CALL + 1, MAX_RECALL_PER_CALL
      )
    );
    _recall(MAX_RECALL_PER_CALL + 1);
  }

  // ================================================================
  // │                        Recall budget                         │
  // ================================================================

  function test_recall_budgetExhaustion() public {
    _recall(MAX_RECALL_PER_CALL);
    _recall(MAX_RECALL_PER_CALL);
    assertEq(manager.getRecallBudget().available, 0);

    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1, 0));
    _recall(1);
  }

  function test_recall_budgetRefillsOverTime() public {
    _recall(MAX_RECALL_PER_CALL);
    _recall(MAX_RECALL_PER_CALL);

    vm.warp(block.timestamp + 1_000);
    uint256 refilled = 1_000 * RECALL_RATE;
    assertEq(manager.getRecallBudget().available, refilled);

    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, refilled + 1, refilled));
    _recall(refilled + 1);

    _recall(refilled);
    assertEq(manager.getRecallBudget().available, 0);
  }

  function test_recall_budgetRefillCappedAtCapacity() public {
    _recall(MAX_RECALL_PER_CALL);
    vm.warp(block.timestamp + 30 days);
    ILiquidityManager.BudgetState memory state = manager.getRecallBudget();
    assertEq(state.available, RECALL_CAPACITY);
    assertEq(state.capacity, RECALL_CAPACITY);
    assertEq(state.rate, RECALL_RATE);
  }

  function test_recall_budgetZeroCapacityBlocksAll() public {
    vm.prank(address(timelock));
    manager.setRecallLimits(MAX_RECALL_PER_CALL, 0, 0);
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1, 0));
    _recall(1);
    vm.warp(block.timestamp + 365 days);
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1, 0));
    _recall(1);
  }

  function test_recall_budgetIsGlobalAcrossPools() public {
    MaliciousPool pool2 = new MaliciousPool(address(token), router);
    (, uint256 id2) = _registerPool(pool2);

    _recall(MAX_RECALL_PER_CALL);
    _recallAs(recallOperator, id2, MAX_RECALL_PER_CALL);

    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1, 0));
    _recall(1);
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1, 0));
    _recallAs(recallOperator, id2, 1);
  }

  function test_recall_budgetCheckedBeforePoolMinimum() public {
    _recall(MAX_RECALL_PER_CALL);
    _recall(MAX_RECALL_PER_CALL);
    // Pool is at 30M with a 20M minimum: 15M would also breach the minimum, but the budget fails first.
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 15_000_000e18, 0));
    _recall(15_000_000e18);
  }

  function test_recall_failedRecallDoesNotConsumeBudget() public {
    _setPoolBalance(address(pool), POOL_MINIMUM + AMOUNT);
    uint256 availableBefore = manager.getRecallBudget().available;
    vm.expectRevert(
      abi.encodeWithSelector(
        ILiquidityManager.PoolMinimumBreached.selector, POOL_MINIMUM + AMOUNT, AMOUNT + 1, POOL_MINIMUM
      )
    );
    _recall(AMOUNT + 1);
    assertEq(manager.getRecallBudget().available, availableBefore);
  }

  function test_recall_doesNotCreditFundingBudgets() public {
    _fund(AMOUNT);
    ILiquidityManager.BudgetState memory aggregateBefore = manager.getAggregateFundingBudget();
    ILiquidityManager.BudgetState memory poolBudgetBefore = manager.getPoolFundingBudget(address(pool));
    assertEq(aggregateBefore.available, AGGREGATE_FUNDING_CAPACITY - AMOUNT);
    assertEq(poolBudgetBefore.available, POOL_FUNDING_CAPACITY - AMOUNT);

    _recall(AMOUNT);

    assertEq(manager.getAggregateFundingBudget().available, aggregateBefore.available, "aggregate");
    assertEq(manager.getPoolFundingBudget(address(pool)).available, poolBudgetBefore.available, "pool");
  }

  function test_recall_fundDoesNotCreditRecallBudget() public {
    _recall(MAX_RECALL_PER_CALL);
    uint256 recallAvailable = manager.getRecallBudget().available;
    _fund(MAX_FUNDING_PER_CALL);
    assertEq(manager.getRecallBudget().available, recallAvailable);
  }

  function test_recall_budgetReducedByGuardianKeepsUsage() public {
    _recall(AMOUNT); // 40M left
    vm.prank(guardian);
    manager.reduceRecallLimits(MAX_RECALL_PER_CALL, 45_000_000e18, RECALL_RATE);
    assertEq(manager.getRecallBudget().available, 40_000_000e18, "not reset to new capacity");
    vm.prank(guardian);
    manager.reduceRecallLimits(MAX_RECALL_PER_CALL, 5_000_000e18, 0);
    assertEq(manager.getRecallBudget().available, 5_000_000e18, "capped");
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 5_000_000e18 + 1, 5_000_000e18));
    _recall(5_000_000e18 + 1);
  }

  function testFuzz_recall_budgetRefillMatchesModel(uint256 used, uint256 elapsed) public {
    used = bound(used, 1, MAX_RECALL_PER_CALL);
    elapsed = bound(elapsed, 0, 3 days);
    _recall(used);
    vm.warp(block.timestamp + elapsed);

    uint256 expected = _min(RECALL_CAPACITY, RECALL_CAPACITY - used + elapsed * RECALL_RATE);
    assertEq(manager.getRecallBudget().available, expected);

    if (expected < MAX_RECALL_PER_CALL) {
      vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, expected + 1, expected));
      _recall(expected + 1);
    }
  }

  // ================================================================
  // │                        Pool minimum                          │
  // ================================================================

  function test_recall_poolMinimumExactBoundarySucceeds() public {
    _setPoolBalance(address(pool), 25_000_000e18);
    _recall(5_000_000e18);
    assertEq(_balance(address(pool)), POOL_MINIMUM);
  }

  function test_recall_poolMinimumOneWeiBelowReverts() public {
    _setPoolBalance(address(pool), 25_000_000e18);
    vm.expectRevert(
      abi.encodeWithSelector(
        ILiquidityManager.PoolMinimumBreached.selector, 25_000_000e18, 5_000_000e18 + 1, POOL_MINIMUM
      )
    );
    _recall(5_000_000e18 + 1);
  }

  function test_recall_amountAboveBalanceReverts() public {
    _setPoolBalance(address(pool), 10_000_000e18);
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, 10_000_000e18, 15_000_000e18, POOL_MINIMUM)
    );
    _recall(15_000_000e18);
  }

  function test_recall_amountAboveBalanceRevertsWithZeroMinimum() public {
    vm.prank(address(timelock));
    manager.setPoolThresholds(address(pool), 0, 0, 0);
    _setPoolBalance(address(pool), 10_000_000e18);
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, 10_000_000e18, 10_000_000e18 + 1, 0)
    );
    _recall(10_000_000e18 + 1);
  }

  function test_recall_zeroMinimumAllowsFullDrain() public {
    vm.prank(address(timelock));
    manager.setPoolThresholds(address(pool), 0, 0, 0);
    _setPoolBalance(address(pool), 10_000_000e18);
    _recall(10_000_000e18);
    assertEq(_balance(address(pool)), 0);
  }

  function test_recall_poolAlreadyBelowMinimumBlocksAnyRecall() public {
    _setPoolBalance(address(pool), 15_000_000e18);
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, 15_000_000e18, 1, POOL_MINIMUM)
    );
    _recall(1);
  }

  function test_recall_emptyPoolReverts() public {
    _setPoolBalance(address(pool), 0);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, 0, 1, POOL_MINIMUM));
    _recall(1);
  }

  function test_recall_respectsGuardianRaisedMinimum() public {
    vm.prank(guardian);
    manager.raisePoolMinimum(address(pool), 70_000_000e18);
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, POOL_INVENTORY, AMOUNT + 1, 70_000_000e18)
    );
    _recall(AMOUNT + 1);
    _recall(AMOUNT);
    assertEq(_balance(address(pool)), 70_000_000e18);
  }

  function test_recall_minimumIsPerPool() public {
    MaliciousPool pool2 = new MaliciousPool(address(token), router);
    (, uint256 id2) = _registerPool(pool2);
    vm.prank(guardian);
    manager.raisePoolMinimum(address(pool), POOL_INVENTORY);

    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, POOL_INVENTORY, 1, POOL_INVENTORY)
    );
    _recall(1);
    _recallAs(recallOperator, id2, AMOUNT);
  }

  function testFuzz_recall_poolMinimum(uint256 poolBalance, uint256 minimum, uint256 amount) public {
    poolBalance = bound(poolBalance, 0, 500_000_000e18);
    minimum = bound(minimum, 0, 500_000_000e18);
    amount = bound(amount, 1, MAX_RECALL_PER_CALL);
    vm.prank(address(timelock));
    manager.setPoolThresholds(address(pool), minimum, minimum, minimum);
    _setPoolBalance(address(pool), poolBalance);
    uint256 managerBefore = _balance(address(manager));

    bool allowed = amount <= poolBalance && poolBalance - amount >= minimum;
    if (!allowed) {
      vm.expectRevert(
        abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, poolBalance, amount, minimum)
      );
    }
    _recall(amount);

    if (allowed) {
      assertEq(_balance(address(pool)), poolBalance - amount);
      assertEq(_balance(address(manager)), managerBefore + amount);
      assertGe(_balance(address(pool)), minimum);
    } else {
      assertEq(_balance(address(pool)), poolBalance);
      assertEq(_balance(address(manager)), managerBefore);
    }
  }

  // ================================================================
  // │         Recall skips the pre-funding pool checks             │
  // ================================================================

  /// @dev The drifted pool fails `verifyAdapter` and `fund` with `verifyError`, while recall still returns funds.
  function _assertRecallIgnoresDrift(bytes memory verifyError) internal {
    vm.expectRevert(verifyError);
    manager.verifyAdapter(adapterId);
    vm.expectRevert(verifyError);
    _fund(1e18);

    uint256 managerBefore = _balance(address(manager));
    uint256 poolBefore = _balance(address(pool));
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Recalled(adapterId, address(pool), recallOperator, address(adapter), AMOUNT);
    _recall(AMOUNT);
    assertEq(_balance(address(manager)), managerBefore + AMOUNT);
    assertEq(_balance(address(pool)), poolBefore - AMOUNT);
    assertEq(_balance(address(adapter)), 0);
  }

  function test_recall_worksWhenRegistryPointsElsewhere() public {
    address newPool = makeAddr("replacementPool");
    registry.setPool(address(token), newPool);
    _assertRecallIgnoresDrift(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), newPool)
    );
  }

  function test_recall_worksWhenRegistryCleared() public {
    registry.setPool(address(token), address(0));
    _assertRecallIgnoresDrift(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), address(0))
    );
  }

  function test_recall_worksAfterMigrationApprovalRevoked() public {
    MaliciousPool pool2 = new MaliciousPool(address(token), router);
    (, uint256 id2) = _registerPool(pool2);
    vm.prank(guardian);
    manager.revokePoolMigrationApproval(address(pool2));

    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool2), address(pool))
    );
    _fundAs(fundingOperator, id2, 1e18);

    _recallAs(recallOperator, id2, AMOUNT);
    assertEq(_balance(address(pool2)), POOL_INVENTORY - AMOUNT);
  }

  function test_recall_worksWhenPoolVersionDrifted() public {
    vm.prank(address(timelock));
    pool.setTypeAndVersion("LockReleaseTokenPool 1.7.0");
    _assertRecallIgnoresDrift(
      abi.encodeWithSelector(
        ILiquidityManager.PoolVersionMismatch.selector, address(pool), "LockReleaseTokenPool 1.7.0"
      )
    );
  }

  function test_recall_worksWhenPoolRouterDrifted() public {
    address otherRouter = makeAddr("otherRouter");
    vm.prank(address(timelock));
    pool.setRouter(otherRouter);
    _assertRecallIgnoresDrift(
      abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, address(pool), otherRouter)
    );
  }

  function test_recall_worksWhenPoolGainedChain() public {
    vm.prank(address(timelock));
    pool.addChain(
      OTHER_CHAIN_SELECTOR,
      abi.encode(REMOTE_TOKEN),
      abi.encode(OTHER_REMOTE_POOL),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
    _assertRecallIgnoresDrift(abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, address(pool)));
  }

  function test_recall_worksWhenPoolLostChain() public {
    vm.prank(address(timelock));
    pool.removeChain(REMOTE_CHAIN_SELECTOR);
    _assertRecallIgnoresDrift(abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, address(pool)));
  }

  function test_recall_worksWhenRemoteTokenDrifted() public {
    vm.prank(address(timelock));
    pool.setRemoteToken(REMOTE_CHAIN_SELECTOR, abi.encode(attacker));
    _assertRecallIgnoresDrift(abi.encodeWithSelector(ILiquidityManager.PoolRemoteTokenMismatch.selector, address(pool)));
  }

  function test_recall_worksWhenRemotePoolAdded() public {
    vm.prank(address(timelock));
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    _assertRecallIgnoresDrift(abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool)));
  }

  function test_recall_worksWhenRemotePoolSwapped() public {
    vm.startPrank(address(timelock));
    pool.removeRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(REMOTE_POOL));
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    vm.stopPrank();
    _assertRecallIgnoresDrift(abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool)));
  }

  function test_recall_worksWhenPoolOwnerDrifted() public {
    vm.prank(address(timelock));
    pool.transferOwnership(attacker);
    _assertRecallIgnoresDrift(
      abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, address(pool), attacker)
    );
  }

  function test_recall_worksWhenRateLimitAdminDrifted() public {
    vm.prank(address(timelock));
    pool.setRateLimitAdmin(attacker);
    _assertRecallIgnoresDrift(
      abi.encodeWithSelector(ILiquidityManager.PoolRateLimitAdminMismatch.selector, address(pool), attacker)
    );
  }

  function test_recall_worksWhenManagerSpecChanged() public {
    // The spec no longer carries the pool owner; change another expectation instead.
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.rateLimitAdmin = attacker;
    vm.prank(address(timelock));
    manager.setPoolSpec(address(pool), spec);
    _assertRecallIgnoresDrift(
      abi.encodeWithSelector(ILiquidityManager.PoolRateLimitAdminMismatch.selector, address(pool), address(controller))
    );
  }

  function test_recall_worksWhenManagerOwnerChanged() public {
    // The pool owner is compared with the Manager's owner: moving only the Manager blocks funding, not recall.
    address newOwner = makeAddr("newOwner");
    vm.prank(address(timelock));
    manager.transferOwnership(newOwner);
    vm.prank(newOwner);
    manager.acceptOwnership();
    _assertRecallIgnoresDrift(
      abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, address(pool), address(timelock))
    );
  }

  function test_recall_worksWhenHandoverBroken() public {
    // Registry administration and token ownership are checked on (re)registration only, not on fund or recall.
    registry.setAdministrator(address(token), attacker);
    vm.prank(address(timelock));
    token.transferOwnership(attacker);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, attacker));
    manager.verifyHandover();
    manager.verifyAdapter(adapterId);
    _recall(AMOUNT);
    assertEq(_balance(address(pool)), POOL_INVENTORY - AMOUNT);
  }

  function test_recall_worksAfterPoolLockdown() public {
    vm.prank(guardian);
    controller.lockdown(address(pool));
    _recall(AMOUNT);
    assertEq(_balance(address(pool)), POOL_INVENTORY - AMOUNT);
  }

  function test_recall_revertsWhenAdapterLostRebalancerRole() public {
    vm.prank(address(timelock));
    pool.setRebalancer(attacker);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, address(pool), attacker));
    manager.verifyAdapter(adapterId);
    // Recall needs the adapter to be the rebalancer; the pool rejects it.
    vm.expectRevert(abi.encodeWithSelector(MockLockReleaseTokenPool.Unauthorized.selector, address(adapter)));
    _recall(AMOUNT);
  }

  function test_recall_revertsWhileTokenPaused() public {
    // The token is owned by the Timelock after handover.
    vm.prank(address(timelock));
    token.pause();
    vm.expectRevert(Pausable.EnforcedPause.selector);
    _recall(AMOUNT);
    vm.prank(address(timelock));
    token.unpause();
    _recall(AMOUNT);
  }

  // ================================================================
  // │                       Malicious pool                         │
  // ================================================================

  function _maliciousPool() internal returns (MaliciousPool pool2, CCIPPoolAdapter adapter2, uint256 id2) {
    pool2 = new MaliciousPool(address(token), router);
    (adapter2, id2) = _registerPool(pool2);
  }

  function test_recall_maliciousPoolHonestModeWorks() public {
    (MaliciousPool pool2, CCIPPoolAdapter adapter2, uint256 id2) = _maliciousPool();
    uint256 managerBefore = _balance(address(manager));
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Recalled(id2, address(pool2), recallOperator, address(adapter2), AMOUNT);
    _recallAs(recallOperator, id2, AMOUNT);
    assertEq(_balance(address(manager)), managerBefore + AMOUNT);
    assertEq(_balance(address(pool2)), POOL_INVENTORY - AMOUNT);
  }

  function test_recall_maliciousPoolPaysLess_withAdapterFloat() public {
    (MaliciousPool pool2, CCIPPoolAdapter adapter2, uint256 id2) = _maliciousPool();
    pool2.configure(MaliciousPool.Mode.PayLess, 1, address(0));
    _seed(address(adapter2), 1e18);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    _recallAs(recallOperator, id2, AMOUNT);
  }

  function test_recall_maliciousPoolPaysLess_noFloat() public {
    (MaliciousPool pool2, CCIPPoolAdapter adapter2, uint256 id2) = _maliciousPool();
    pool2.configure(MaliciousPool.Mode.PayLess, 1, address(0));
    // The adapter cannot forward more than it received.
    vm.expectRevert(
      abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(adapter2), AMOUNT - 1, AMOUNT)
    );
    _recallAs(recallOperator, id2, AMOUNT);
  }

  function test_recall_maliciousPoolPaysMore() public {
    (MaliciousPool pool2,, uint256 id2) = _maliciousPool();
    pool2.configure(MaliciousPool.Mode.PayMore, 1, address(0));
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    _recallAs(recallOperator, id2, AMOUNT);
  }

  function test_recall_maliciousPoolPaysSomeoneElse_withAdapterFloat() public {
    (MaliciousPool pool2, CCIPPoolAdapter adapter2, uint256 id2) = _maliciousPool();
    pool2.configure(MaliciousPool.Mode.PayOther, 0, attacker);
    // With enough unsolicited float, the Manager and pool deltas are both exactly `amount`; only the adapter balance
    // check catches the diversion.
    _seed(address(adapter2), AMOUNT);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    _recallAs(recallOperator, id2, AMOUNT);
    assertEq(_balance(address(adapter2)), AMOUNT);
    assertEq(_balance(attacker), 0);
  }

  function test_recall_maliciousPoolPaysSomeoneElse_noFloat() public {
    (MaliciousPool pool2, CCIPPoolAdapter adapter2, uint256 id2) = _maliciousPool();
    pool2.configure(MaliciousPool.Mode.PayOther, 0, attacker);
    vm.expectRevert(
      abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(adapter2), 0, AMOUNT)
    );
    _recallAs(recallOperator, id2, AMOUNT);
  }

  function test_recall_maliciousPoolPaysNothing_withAdapterFloat() public {
    (MaliciousPool pool2, CCIPPoolAdapter adapter2, uint256 id2) = _maliciousPool();
    pool2.configure(MaliciousPool.Mode.PayNothing, 0, address(0));
    _seed(address(adapter2), AMOUNT);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    _recallAs(recallOperator, id2, AMOUNT);
  }

  function test_recall_maliciousPoolReentersRecall() public {
    (MaliciousPool pool2,, uint256 id2) = _maliciousPool();
    pool2.configure(MaliciousPool.Mode.ReenterRecall, 0, address(0));
    pool2.configureReentry(manager, id2);
    vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    _recallAs(recallOperator, id2, AMOUNT);
  }

  function test_recall_maliciousPoolReentersFund() public {
    (MaliciousPool pool2,, uint256 id2) = _maliciousPool();
    pool2.configure(MaliciousPool.Mode.ReenterFund, 0, address(0));
    pool2.configureReentry(manager, adapterId);
    vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    _recallAs(recallOperator, id2, AMOUNT);
  }

  function testFuzz_recall_maliciousPoolPayingWrongAmountReverts(uint256 amount, uint256 delta, bool more) public {
    amount = bound(amount, 2, MAX_RECALL_PER_CALL);
    delta = bound(delta, 1, more ? 1_000_000e18 : amount - 1);
    (MaliciousPool pool2, CCIPPoolAdapter adapter2, uint256 id2) = _maliciousPool();
    pool2.configure(more ? MaliciousPool.Mode.PayMore : MaliciousPool.Mode.PayLess, delta, address(0));
    _seed(address(adapter2), MAX_RECALL_PER_CALL);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    _recallAs(recallOperator, id2, amount);
  }

  // ================================================================
  // │                      Malicious adapter                       │
  // ================================================================

  function _maliciousAdapter() internal returns (MaliciousAdapter bad) {
    bad = new MaliciousAdapter(address(manager), address(token), address(pool));
    _installAdapter(address(bad));
  }

  function test_recall_maliciousAdapterHonestModeWorks() public {
    MaliciousAdapter bad = _maliciousAdapter();
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Recalled(adapterId, address(pool), recallOperator, address(bad), AMOUNT);
    _recall(AMOUNT);
    assertEq(_balance(address(pool)), POOL_INVENTORY - AMOUNT);
  }

  function test_recall_maliciousAdapterKeepsTokens() public {
    MaliciousAdapter bad = _maliciousAdapter();
    bad.configure(MaliciousAdapter.Mode.Keep, 0, address(0));
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    _recall(AMOUNT);
  }

  function test_recall_maliciousAdapterForwardsLess() public {
    MaliciousAdapter bad = _maliciousAdapter();
    bad.configure(MaliciousAdapter.Mode.ForwardLess, 1, address(0));
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    _recall(AMOUNT);
  }

  function test_recall_maliciousAdapterForwardsFromFloatWithoutWithdrawing() public {
    MaliciousAdapter bad = _maliciousAdapter();
    bad.configure(MaliciousAdapter.Mode.ForwardFromFloat, 0, address(0));
    _seed(address(bad), AMOUNT);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    _recall(AMOUNT);
  }

  function test_recall_maliciousAdapterSkimsExtraFromPool() public {
    MaliciousAdapter bad = _maliciousAdapter();
    // Manager +amount and adapter unchanged; only the pool delta check catches the skim.
    bad.configure(MaliciousAdapter.Mode.Skim, 1_000_000e18, attacker);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    _recall(AMOUNT);
    assertEq(_balance(attacker), 0);
  }

  function test_recall_maliciousAdapterDivertsToThirdParty() public {
    MaliciousAdapter bad = _maliciousAdapter();
    // Pool -amount and adapter unchanged; only the Manager delta check catches the diversion.
    bad.configure(MaliciousAdapter.Mode.Divert, 0, attacker);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    _recall(AMOUNT);
    assertEq(_balance(attacker), 0);
  }

  function test_recall_maliciousAdapterForwardsExtra() public {
    MaliciousAdapter bad = _maliciousAdapter();
    bad.configure(MaliciousAdapter.Mode.ForwardExtra, 1, address(0));
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    _recall(AMOUNT);
  }

  function test_recall_maliciousAdapterReenters() public {
    MaliciousAdapter bad = _maliciousAdapter();
    bad.configure(MaliciousAdapter.Mode.Reenter, 0, address(0));
    bad.configureReentry(adapterId);
    vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    _recall(AMOUNT);
  }

  function testFuzz_recall_maliciousAdapterSkimReverts(uint256 amount, uint256 skim) public {
    amount = bound(amount, 1, MAX_RECALL_PER_CALL);
    skim = bound(skim, 1, 30_000_000e18);
    MaliciousAdapter bad = _maliciousAdapter();
    bad.configure(MaliciousAdapter.Mode.Skim, skim, attacker);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    _recall(amount);
  }
}
