// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";
import {TokenBucket} from "src/libraries/TokenBucket.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";
import {MockSahara} from "test/mocks/MockSahara.sol";
import {BaseTest} from "test/utils/BaseTest.sol";

/// @notice Guardian powers: who can call the Guardian functions, that they take effect immediately, that they can only
/// restrict, that only the owner (the Timelock) restores, that the Guardian can never move principal, and that
/// `setGuardian` revokes every Guardian power (Manager and GuardianController) at once.
contract GuardianPowersTest is BaseTest {
  address internal newGuardian = makeAddr("newGuardian");
  address internal otherPool = makeAddr("otherPool");

  uint256 internal constant GUARDIAN_FUNCTION_COUNT = 11;
  uint256 internal constant MANAGER_MUTATING_FUNCTION_COUNT = 33;

  /// @dev Comparable view of everything the Guardian functions can touch, plus the authority fields.
  struct Snapshot {
    address owner;
    address pendingOwner;
    address guardian;
    bool fundingPaused;
    bool recallPaused;
    bool fundingOperatorEnabled;
    bool recallOperatorEnabled;
    ILiquidityManager.Adapter adapterEntry;
    address migrationSource;
    uint256 maxFundingPerCall;
    uint256 maxRecallPerCall;
    ILiquidityManager.PoolThresholds thresholds;
    ILiquidityManager.BudgetState aggregate;
    ILiquidityManager.BudgetState poolBudget;
    ILiquidityManager.BudgetState recallBudget;
    uint256 managerBalance;
    uint256 poolBalance;
    uint256 adapterBalance;
    // Authorities outside the Manager that the Guardian must never be able to touch.
    address poolOwner;
    address poolRebalancer;
    address poolRateLimitAdmin;
    address tokenOwner;
    address registryAdministrator;
    address registryPendingAdministrator;
    address registryPool;
    uint256 adapterHistoryLength;
  }

  // ================================================================
  // │                       Access control                         │
  // ================================================================

  function test_guardianFunctions_revertForEveryNonGuardian() public {
    bytes[] memory calls = _guardianCalls();
    address[] memory callers = _nonGuardianCallers();
    bytes memory before = abi.encode(_snapshot());

    for (uint256 c = 0; c < callers.length; ++c) {
      for (uint256 i = 0; i < calls.length; ++i) {
        _assertReverts(
          callers[c],
          address(manager),
          calls[i],
          abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, callers[c])
        );
      }
    }
    assertEq(abi.encode(_snapshot()), before, "state changed by a rejected call");
  }

  function testFuzz_guardianFunctions_revertForAnyNonGuardian(address caller, uint256 index) public {
    vm.assume(caller != guardian);
    assumeNotForgeAddress(caller);
    bytes[] memory calls = _guardianCalls();
    bytes memory before = abi.encode(_snapshot());

    _assertReverts(
      caller,
      address(manager),
      calls[index % calls.length],
      abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, caller)
    );
    assertEq(abi.encode(_snapshot()), before);
  }

  function test_guardianFunctions_succeedForGuardian() public {
    bytes[] memory calls = _guardianCalls();
    assertEq(calls.length, GUARDIAN_FUNCTION_COUNT);
    for (uint256 i = 0; i < calls.length; ++i) {
      vm.prank(guardian);
      (bool ok, bytes memory ret) = address(manager).call(calls[i]);
      assertTrue(ok, string(abi.encodePacked("guardian call failed: ", vm.toString(i), " ", vm.toString(ret))));
    }

    assertTrue(manager.fundingPaused());
    assertTrue(manager.recallPaused());
    assertFalse(manager.isFundingOperator(fundingOperator));
    assertFalse(manager.isRecallOperator(recallOperator));
    ILiquidityManager.Adapter memory entry = manager.getAdapter(adapterId);
    assertFalse(entry.fundingEnabled);
    assertFalse(entry.recallEnabled);
    assertEq(manager.maxFundingPerCall(), MAX_FUNDING_PER_CALL - 1);
    assertEq(manager.maxRecallPerCall(), MAX_RECALL_PER_CALL - 1);
    assertEq(manager.getAggregateFundingBudget().capacity, AGGREGATE_FUNDING_CAPACITY - 1);
    assertEq(manager.getPoolFundingBudget(address(pool)).capacity, POOL_FUNDING_CAPACITY - 1);
    assertEq(manager.getRecallBudget().capacity, RECALL_CAPACITY - 1);
    assertEq(_thresholds(address(pool)).minimum, POOL_MINIMUM + 1);
  }

  // ================================================================
  // │                pauseFunding / pauseRecall                    │
  // ================================================================

  function test_pauseFunding_blocksFundingImmediately() public {
    vm.expectEmit(address(manager));
    emit ILiquidityManager.FundingPausedSet(true);
    vm.prank(guardian);
    manager.pauseFunding();
    assertTrue(manager.fundingPaused());

    vm.expectRevert(ILiquidityManager.FundingIsPaused.selector);
    _fund(1e18);

    // Recall is independent.
    _recall(1e18);
    assertFalse(manager.recallPaused());
  }

  function test_pauseFunding_isIdempotent() public {
    vm.startPrank(guardian);
    manager.pauseFunding();
    manager.pauseFunding();
    vm.stopPrank();
    assertTrue(manager.fundingPaused());
  }

  function test_pauseRecall_blocksRecallImmediately() public {
    vm.expectEmit(address(manager));
    emit ILiquidityManager.RecallPausedSet(true);
    vm.prank(guardian);
    manager.pauseRecall();
    assertTrue(manager.recallPaused());

    vm.expectRevert(ILiquidityManager.RecallIsPaused.selector);
    _recall(1e18);

    // Funding is independent.
    _fund(1e18);
    assertFalse(manager.fundingPaused());
  }

  function test_pauseRecall_isIdempotent() public {
    vm.startPrank(guardian);
    manager.pauseRecall();
    manager.pauseRecall();
    vm.stopPrank();
    assertTrue(manager.recallPaused());
  }

  // ================================================================
  // │            suspendFundingOperator / suspendRecallOperator    │
  // ================================================================

  function test_suspendFundingOperator_blocksFundingImmediately() public {
    vm.expectEmit(address(manager));
    emit ILiquidityManager.FundingOperatorSet(fundingOperator, false);
    vm.prank(guardian);
    manager.suspendFundingOperator(fundingOperator);
    assertFalse(manager.isFundingOperator(fundingOperator));

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, fundingOperator));
    _fund(1e18);

    // The recall role is untouched.
    assertTrue(manager.isRecallOperator(recallOperator));
    _recall(1e18);
  }

  function test_suspendRecallOperator_blocksRecallImmediately() public {
    vm.expectEmit(address(manager));
    emit ILiquidityManager.RecallOperatorSet(recallOperator, false);
    vm.prank(guardian);
    manager.suspendRecallOperator(recallOperator);
    assertFalse(manager.isRecallOperator(recallOperator));

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, recallOperator));
    _recall(1e18);

    assertTrue(manager.isFundingOperator(fundingOperator));
    _fund(1e18);
  }

  function testFuzz_suspendOperators_neverGrantsARole(address operator) public {
    bool recallBefore = manager.isRecallOperator(operator);

    vm.prank(guardian);
    manager.suspendFundingOperator(operator);
    assertFalse(manager.isFundingOperator(operator));
    assertEq(manager.isRecallOperator(operator), recallBefore, "funding suspension touched the recall role");

    vm.prank(guardian);
    manager.suspendRecallOperator(operator);
    assertFalse(manager.isRecallOperator(operator));
    assertFalse(manager.isFundingOperator(operator));
  }

  // ================================================================
  // │                        restrictAdapter                       │
  // ================================================================

  function test_restrictAdapter_disableFundingOnly() public {
    vm.expectEmit(address(manager));
    emit ILiquidityManager.AdapterStatusSet(adapterId, false, true);
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, true, false);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.FundingDisabled.selector, adapterId));
    _fund(1e18);
    _recall(1e18);
  }

  function test_restrictAdapter_disableRecallOnly() public {
    vm.expectEmit(address(manager));
    emit ILiquidityManager.AdapterStatusSet(adapterId, true, false);
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, false, true);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RecallDisabled.selector, adapterId));
    _recall(1e18);
    _fund(1e18);
  }

  function test_restrictAdapter_disableBoth() public {
    vm.expectEmit(address(manager));
    emit ILiquidityManager.AdapterStatusSet(adapterId, false, false);
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, true, true);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.FundingDisabled.selector, adapterId));
    _fund(1e18);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RecallDisabled.selector, adapterId));
    _recall(1e18);
  }

  function test_restrictAdapter_falseFlagsNeverReEnable() public {
    vm.prank(address(timelock));
    manager.setAdapterStatus(adapterId, false, false);

    vm.expectEmit(address(manager));
    emit ILiquidityManager.AdapterStatusSet(adapterId, false, false);
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, false, false);

    ILiquidityManager.Adapter memory entry = manager.getAdapter(adapterId);
    assertFalse(entry.fundingEnabled);
    assertFalse(entry.recallEnabled);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.FundingDisabled.selector, adapterId));
    _fund(1e18);
  }

  function testFuzz_restrictAdapter_onlyDisables(
    bool fundingBefore,
    bool recallBefore,
    bool disableFunding,
    bool disableRecall
  ) public {
    vm.prank(address(timelock));
    manager.setAdapterStatus(adapterId, fundingBefore, recallBefore);

    bool expectedFunding = fundingBefore && !disableFunding;
    bool expectedRecall = recallBefore && !disableRecall;
    vm.expectEmit(address(manager));
    emit ILiquidityManager.AdapterStatusSet(adapterId, expectedFunding, expectedRecall);
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, disableFunding, disableRecall);

    ILiquidityManager.Adapter memory entry = manager.getAdapter(adapterId);
    assertEq(entry.fundingEnabled, expectedFunding);
    assertEq(entry.recallEnabled, expectedRecall);
    // The registry binding is never touched.
    assertEq(entry.adapter, address(adapter));
    assertEq(entry.pool, address(pool));
  }

  function test_restrictAdapter_revertsForUnknownAdapter() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 0));
    vm.prank(guardian);
    manager.restrictAdapter(0, true, true);

    uint256 next = manager.adapterCount() + 1;
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, next));
    vm.prank(guardian);
    manager.restrictAdapter(next, true, true);
  }

  // ================================================================
  // │                  revokePoolMigrationApproval                 │
  // ================================================================

  function test_revokePoolMigrationApproval_blocksMigrationFundingImmediately() public {
    // The approval is bound to the source pool the registry still maps the token to.
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), otherPool);
    registry.setPool(address(token), otherPool);
    // With the approval the pool can be funded although the registry maps the token to the source pool.
    _fund(1e18);

    vm.expectEmit(address(manager));
    emit ILiquidityManager.GuardianAction(guardian, LiquidityManager.revokePoolMigrationApproval.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(address(pool), address(0));
    vm.prank(guardian);
    manager.revokePoolMigrationApproval(address(pool));
    assertEq(manager.getPoolMigrationSource(address(pool)), address(0));

    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), otherPool)
    );
    _fund(1e18);
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), otherPool)
    );
    manager.verifyAdapter(adapterId);

    // Recall only returns funds to the Manager and stays available.
    _recall(1e18);
  }

  function testFuzz_revokePoolMigrationApproval_neverApproves(address anyPool, address sourceBefore) public {
    vm.assume(anyPool != address(0) && sourceBefore != anyPool);
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(anyPool, sourceBefore);
    assertEq(manager.getPoolMigrationSource(anyPool), sourceBefore);

    vm.expectEmit(address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(anyPool, address(0));
    vm.prank(guardian);
    manager.revokePoolMigrationApproval(anyPool);
    assertEq(manager.getPoolMigrationSource(anyPool), address(0));
    // Revoking again is a no-op that never sets a source.
    vm.prank(guardian);
    manager.revokePoolMigrationApproval(anyPool);
    assertEq(manager.getPoolMigrationSource(anyPool), address(0));
  }

  // ================================================================
  // │                    reduceMaxFundingPerCall                   │
  // ================================================================

  function test_reduceMaxFundingPerCall_appliesImmediately() public {
    uint256 newMax = 1_000_000e18;
    vm.expectEmit(address(manager));
    emit ILiquidityManager.MaxFundingPerCallSet(newMax);
    vm.prank(guardian);
    manager.reduceMaxFundingPerCall(newMax);
    assertEq(manager.maxFundingPerCall(), newMax);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.ExceedsPerCallLimit.selector, newMax + 1, newMax));
    _fund(newMax + 1);
    _fund(newMax);
  }

  function test_reduceMaxFundingPerCall_toZeroBlocksFunding() public {
    vm.prank(guardian);
    manager.reduceMaxFundingPerCall(0);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.ExceedsPerCallLimit.selector, 1, 0));
    _fund(1);
  }

  function test_reduceMaxFundingPerCall_revertsWhenRaising() public {
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    vm.prank(guardian);
    manager.reduceMaxFundingPerCall(MAX_FUNDING_PER_CALL + 1);
    assertEq(manager.maxFundingPerCall(), MAX_FUNDING_PER_CALL);
  }

  function testFuzz_reduceMaxFundingPerCall_onlyTightens(uint256 current, uint256 proposed) public {
    vm.prank(address(timelock));
    manager.setMaxFundingPerCall(current);

    if (proposed > current) {
      vm.expectRevert(ILiquidityManager.NotARestriction.selector);
      vm.prank(guardian);
      manager.reduceMaxFundingPerCall(proposed);
      assertEq(manager.maxFundingPerCall(), current);
    } else {
      vm.expectEmit(address(manager));
      emit ILiquidityManager.MaxFundingPerCallSet(proposed);
      vm.prank(guardian);
      manager.reduceMaxFundingPerCall(proposed);
      assertEq(manager.maxFundingPerCall(), proposed);
    }
  }

  // ================================================================
  // │                 reduceAggregateFundingBudget                 │
  // ================================================================

  function test_reduceAggregateFundingBudget_toZeroBlocksFunding() public {
    vm.expectEmit(address(manager));
    emit ILiquidityManager.AggregateFundingBudgetSet(0, 0);
    vm.prank(guardian);
    manager.reduceAggregateFundingBudget(0, 0);

    ILiquidityManager.BudgetState memory state = manager.getAggregateFundingBudget();
    assertEq(state.capacity, 0);
    assertEq(state.rate, 0);
    assertEq(state.available, 0);

    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1, 0));
    _fund(1);

    // A zero rate means no refill, ever.
    vm.warp(block.timestamp + 365 days);
    assertEq(manager.getAggregateFundingBudget().available, 0);
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1, 0));
    _fund(1);
  }

  function test_reduceAggregateFundingBudget_revertsWhenRaisingCapacityOrRate() public {
    vm.startPrank(guardian);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reduceAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY + 1, AGGREGATE_FUNDING_RATE);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reduceAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE + 1);
    // Lowering one while raising the other is still a loosening.
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reduceAggregateFundingBudget(0, AGGREGATE_FUNDING_RATE + 1);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reduceAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY + 1, 0);
    vm.stopPrank();
  }

  function testFuzz_reduceAggregateFundingBudget_onlyTightens(
    uint256 capacity0,
    uint256 rate0,
    uint256 capacity1,
    uint256 rate1
  ) public {
    vm.prank(address(timelock));
    manager.setAggregateFundingBudget(capacity0, rate0);
    ILiquidityManager.BudgetState memory before = manager.getAggregateFundingBudget();

    if (capacity1 > capacity0 || rate1 > rate0) {
      vm.expectRevert(ILiquidityManager.NotARestriction.selector);
      vm.prank(guardian);
      manager.reduceAggregateFundingBudget(capacity1, rate1);
      assertEq(abi.encode(manager.getAggregateFundingBudget()), abi.encode(before));
    } else {
      vm.expectEmit(address(manager));
      emit ILiquidityManager.AggregateFundingBudgetSet(capacity1, rate1);
      vm.prank(guardian);
      manager.reduceAggregateFundingBudget(capacity1, rate1);
      ILiquidityManager.BudgetState memory afterState = manager.getAggregateFundingBudget();
      assertEq(afterState.capacity, capacity1);
      assertEq(afterState.rate, rate1);
      assertEq(afterState.available, _min(before.available, capacity1));
    }
  }

  function testFuzz_reduceAggregateFundingBudget_neverRestoresUsage(
    uint256 used,
    uint256 elapsedBefore,
    uint256 capacity1,
    uint256 rate1,
    uint256 elapsedAfter
  ) public {
    used = bound(used, 1, MAX_FUNDING_PER_CALL);
    elapsedBefore = bound(elapsedBefore, 0, 2 days);
    capacity1 = bound(capacity1, 0, AGGREGATE_FUNDING_CAPACITY);
    rate1 = bound(rate1, 0, AGGREGATE_FUNDING_RATE);
    elapsedAfter = bound(elapsedAfter, 0, 30 days);

    _fund(used);
    assertEq(manager.getAggregateFundingBudget().available, AGGREGATE_FUNDING_CAPACITY - used);
    vm.warp(block.timestamp + elapsedBefore);
    uint256 availableBefore = manager.getAggregateFundingBudget().available;

    vm.prank(guardian);
    manager.reduceAggregateFundingBudget(capacity1, rate1);
    uint256 availableAfter = manager.getAggregateFundingBudget().available;
    assertLe(availableAfter, availableBefore, "reduction increased the available budget");
    assertEq(availableAfter, _min(availableBefore, capacity1));

    vm.warp(block.timestamp + elapsedAfter);
    assertEq(
      manager.getAggregateFundingBudget().available,
      _min(capacity1, availableAfter + elapsedAfter * rate1),
      "refill does not continue from the reduced amount at the reduced rate"
    );
  }

  // ================================================================
  // │                   reducePoolFundingBudget                    │
  // ================================================================

  function test_reducePoolFundingBudget_toZeroBlocksFunding() public {
    vm.expectEmit(address(manager));
    emit ILiquidityManager.PoolFundingBudgetSet(address(pool), 0, 0);
    vm.prank(guardian);
    manager.reducePoolFundingBudget(address(pool), 0, 0);

    ILiquidityManager.BudgetState memory state = manager.getPoolFundingBudget(address(pool));
    assertEq(state.capacity, 0);
    assertEq(state.rate, 0);
    assertEq(state.available, 0);

    // The aggregate budget passes; the per-pool budget stops it.
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1, 0));
    _fund(1);
  }

  function test_reducePoolFundingBudget_revertsWhenRaisingCapacityOrRate() public {
    vm.startPrank(guardian);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reducePoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY + 1, POOL_FUNDING_RATE);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reducePoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE + 1);
    // An unconfigured pool has a zero budget, so anything above zero is a loosening.
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reducePoolFundingBudget(otherPool, 1, 0);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reducePoolFundingBudget(otherPool, 0, 1);
    vm.stopPrank();
  }

  /// @dev Behaviour change: the Guardian's (0, 0) call on a never-configured pool is a no-op that leaves the bucket
  /// uninitialized (it already allows nothing), so the owner's later first configuration still starts FULL.
  function test_regression_reducePoolFundingBudget_unconfiguredPool_ownerConfigStartsFull() public {
    vm.expectEmit(address(manager));
    emit ILiquidityManager.GuardianAction(guardian, LiquidityManager.reducePoolFundingBudget.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.PoolFundingBudgetSet(otherPool, 0, 0);
    vm.prank(guardian);
    manager.reducePoolFundingBudget(otherPool, 0, 0);
    _assertBudget(manager.getPoolFundingBudget(otherPool), 0, 0, 0);

    // Time passing in between does not matter: an uninitialized bucket has no refill clock.
    vm.warp(block.timestamp + 7 days);
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(otherPool, POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    _assertBudget(
      manager.getPoolFundingBudget(otherPool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE, POOL_FUNDING_CAPACITY
    );

    // From here on it behaves as an initialized bucket: a later Guardian reduction caps, never resets.
    vm.prank(guardian);
    manager.reducePoolFundingBudget(otherPool, POOL_FUNDING_CAPACITY / 2, POOL_FUNDING_RATE);
    _assertBudget(
      manager.getPoolFundingBudget(otherPool), POOL_FUNDING_CAPACITY / 2, POOL_FUNDING_RATE, POOL_FUNDING_CAPACITY / 2
    );
  }

  function testFuzz_reducePoolFundingBudget_onlyTightens(
    uint256 capacity0,
    uint256 rate0,
    uint256 capacity1,
    uint256 rate1
  ) public {
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(pool), capacity0, rate0);
    ILiquidityManager.BudgetState memory before = manager.getPoolFundingBudget(address(pool));

    if (capacity1 > capacity0 || rate1 > rate0) {
      vm.expectRevert(ILiquidityManager.NotARestriction.selector);
      vm.prank(guardian);
      manager.reducePoolFundingBudget(address(pool), capacity1, rate1);
      assertEq(abi.encode(manager.getPoolFundingBudget(address(pool))), abi.encode(before));
    } else {
      vm.expectEmit(address(manager));
      emit ILiquidityManager.PoolFundingBudgetSet(address(pool), capacity1, rate1);
      vm.prank(guardian);
      manager.reducePoolFundingBudget(address(pool), capacity1, rate1);
      ILiquidityManager.BudgetState memory afterState = manager.getPoolFundingBudget(address(pool));
      assertEq(afterState.capacity, capacity1);
      assertEq(afterState.rate, rate1);
      assertEq(afterState.available, _min(before.available, capacity1));
    }
    // The aggregate budget is a separate bucket.
    assertEq(manager.getAggregateFundingBudget().capacity, AGGREGATE_FUNDING_CAPACITY);
  }

  function testFuzz_reducePoolFundingBudget_neverRestoresUsage(
    uint256 used,
    uint256 elapsedBefore,
    uint256 capacity1,
    uint256 rate1,
    uint256 elapsedAfter
  ) public {
    used = bound(used, 1, MAX_FUNDING_PER_CALL);
    elapsedBefore = bound(elapsedBefore, 0, 2 days);
    capacity1 = bound(capacity1, 0, POOL_FUNDING_CAPACITY);
    rate1 = bound(rate1, 0, POOL_FUNDING_RATE);
    elapsedAfter = bound(elapsedAfter, 0, 30 days);

    _fund(used);
    assertEq(manager.getPoolFundingBudget(address(pool)).available, POOL_FUNDING_CAPACITY - used);
    vm.warp(block.timestamp + elapsedBefore);
    uint256 availableBefore = manager.getPoolFundingBudget(address(pool)).available;

    vm.prank(guardian);
    manager.reducePoolFundingBudget(address(pool), capacity1, rate1);
    uint256 availableAfter = manager.getPoolFundingBudget(address(pool)).available;
    assertLe(availableAfter, availableBefore, "reduction increased the available budget");
    assertEq(availableAfter, _min(availableBefore, capacity1));

    vm.warp(block.timestamp + elapsedAfter);
    assertEq(
      manager.getPoolFundingBudget(address(pool)).available,
      _min(capacity1, availableAfter + elapsedAfter * rate1),
      "refill does not continue from the reduced amount at the reduced rate"
    );
  }

  // ================================================================
  // │                      reduceRecallLimits                      │
  // ================================================================

  function test_reduceRecallLimits_perCallAppliesImmediately() public {
    uint256 newMax = 1_000_000e18;
    vm.expectEmit(address(manager));
    emit ILiquidityManager.RecallLimitsSet(newMax, RECALL_CAPACITY, RECALL_RATE);
    vm.prank(guardian);
    manager.reduceRecallLimits(newMax, RECALL_CAPACITY, RECALL_RATE);
    assertEq(manager.maxRecallPerCall(), newMax);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.ExceedsPerCallLimit.selector, newMax + 1, newMax));
    _recall(newMax + 1);
    _recall(newMax);
  }

  function test_reduceRecallLimits_zeroBudgetBlocksRecall() public {
    vm.prank(guardian);
    manager.reduceRecallLimits(MAX_RECALL_PER_CALL, 0, 0);
    ILiquidityManager.BudgetState memory state = manager.getRecallBudget();
    assertEq(state.capacity, 0);
    assertEq(state.rate, 0);
    assertEq(state.available, 0);

    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1, 0));
    _recall(1);
  }

  function test_reduceRecallLimits_zeroPerCallBlocksRecall() public {
    vm.prank(guardian);
    manager.reduceRecallLimits(0, RECALL_CAPACITY, RECALL_RATE);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.ExceedsPerCallLimit.selector, 1, 0));
    _recall(1);
  }

  function test_reduceRecallLimits_revertsWhenRaisingAnyLimit() public {
    vm.startPrank(guardian);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reduceRecallLimits(MAX_RECALL_PER_CALL + 1, RECALL_CAPACITY, RECALL_RATE);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reduceRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY + 1, RECALL_RATE);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reduceRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE + 1);
    // Lowering the per-call limit does not license raising the budget.
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reduceRecallLimits(0, RECALL_CAPACITY + 1, 0);
    vm.stopPrank();
  }

  function testFuzz_reduceRecallLimits_onlyTightens(
    uint256 perCall0,
    uint256 capacity0,
    uint256 rate0,
    uint256 perCall1,
    uint256 capacity1,
    uint256 rate1
  ) public {
    vm.prank(address(timelock));
    manager.setRecallLimits(perCall0, capacity0, rate0);
    ILiquidityManager.BudgetState memory before = manager.getRecallBudget();

    if (perCall1 > perCall0 || capacity1 > capacity0 || rate1 > rate0) {
      vm.expectRevert(ILiquidityManager.NotARestriction.selector);
      vm.prank(guardian);
      manager.reduceRecallLimits(perCall1, capacity1, rate1);
      assertEq(manager.maxRecallPerCall(), perCall0);
      assertEq(abi.encode(manager.getRecallBudget()), abi.encode(before));
    } else {
      vm.expectEmit(address(manager));
      emit ILiquidityManager.RecallLimitsSet(perCall1, capacity1, rate1);
      vm.prank(guardian);
      manager.reduceRecallLimits(perCall1, capacity1, rate1);
      ILiquidityManager.BudgetState memory afterState = manager.getRecallBudget();
      assertEq(manager.maxRecallPerCall(), perCall1);
      assertEq(afterState.capacity, capacity1);
      assertEq(afterState.rate, rate1);
      assertEq(afterState.available, _min(before.available, capacity1));
    }
  }

  function testFuzz_reduceRecallLimits_neverRestoresUsage(
    uint256 used,
    uint256 elapsedBefore,
    uint256 capacity1,
    uint256 rate1,
    uint256 elapsedAfter
  ) public {
    used = bound(used, 1, MAX_RECALL_PER_CALL);
    elapsedBefore = bound(elapsedBefore, 0, 2 days);
    capacity1 = bound(capacity1, 0, RECALL_CAPACITY);
    rate1 = bound(rate1, 0, RECALL_RATE);
    elapsedAfter = bound(elapsedAfter, 0, 30 days);

    _recall(used);
    assertEq(manager.getRecallBudget().available, RECALL_CAPACITY - used);
    vm.warp(block.timestamp + elapsedBefore);
    uint256 availableBefore = manager.getRecallBudget().available;

    vm.prank(guardian);
    manager.reduceRecallLimits(MAX_RECALL_PER_CALL, capacity1, rate1);
    uint256 availableAfter = manager.getRecallBudget().available;
    assertLe(availableAfter, availableBefore, "reduction increased the available budget");
    assertEq(availableAfter, _min(availableBefore, capacity1));

    vm.warp(block.timestamp + elapsedAfter);
    assertEq(
      manager.getRecallBudget().available,
      _min(capacity1, availableAfter + elapsedAfter * rate1),
      "refill does not continue from the reduced amount at the reduced rate"
    );
  }

  // ================================================================
  // │                       raisePoolMinimum                       │
  // ================================================================

  function test_raisePoolMinimum_appliesImmediately() public {
    uint256 poolBalance = _balance(address(pool));
    vm.expectEmit(address(manager));
    emit ILiquidityManager.PoolThresholdsSet(address(pool), poolBalance, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET);
    vm.prank(guardian);
    manager.raisePoolMinimum(address(pool), poolBalance);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, poolBalance, 1, poolBalance));
    _recall(1);
  }

  function test_raisePoolMinimum_toMaxBlocksAllRecalls() public {
    vm.prank(guardian);
    manager.raisePoolMinimum(address(pool), type(uint256).max);
    uint256 poolBalance = _balance(address(pool));
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, poolBalance, 1, type(uint256).max)
    );
    _recall(1);
    // Funding does not depend on the minimum.
    _fund(1e18);
  }

  /// @dev Design decision 7: the Guardian may raise the minimum above the published refill trigger and target.
  function test_raisePoolMinimum_mayExceedRefillTrigger() public {
    uint256 newMinimum = POOL_REFILL_TARGET + 1;
    vm.prank(guardian);
    manager.raisePoolMinimum(address(pool), newMinimum);
    ILiquidityManager.PoolThresholds memory thresholds = _thresholds(address(pool));
    assertEq(thresholds.minimum, newMinimum);
    assertEq(thresholds.refillTrigger, POOL_REFILL_TRIGGER);
    assertEq(thresholds.refillTarget, POOL_REFILL_TARGET);
  }

  function test_raisePoolMinimum_revertsWhenLowering() public {
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    vm.prank(guardian);
    manager.raisePoolMinimum(address(pool), POOL_MINIMUM - 1);
    assertEq(_thresholds(address(pool)).minimum, POOL_MINIMUM);
  }

  function testFuzz_raisePoolMinimum_onlyTightens(uint256 current, uint256 proposed) public {
    vm.prank(address(timelock));
    manager.setPoolThresholds(address(pool), current, current, current);

    if (proposed < current) {
      vm.expectRevert(ILiquidityManager.NotARestriction.selector);
      vm.prank(guardian);
      manager.raisePoolMinimum(address(pool), proposed);
      assertEq(_thresholds(address(pool)).minimum, current);
    } else {
      vm.expectEmit(address(manager));
      emit ILiquidityManager.PoolThresholdsSet(address(pool), proposed, current, current);
      vm.prank(guardian);
      manager.raisePoolMinimum(address(pool), proposed);
      ILiquidityManager.PoolThresholds memory thresholds = _thresholds(address(pool));
      assertEq(thresholds.minimum, proposed);
      assertEq(thresholds.refillTrigger, current);
      assertEq(thresholds.refillTarget, current);
    }
  }

  /// @dev Re-applying the current values is not a loosening: accepted, and nothing changes.
  function test_guardianReductions_equalValuesAreNoOps() public {
    _fund(MAX_FUNDING_PER_CALL);
    _recall(MAX_RECALL_PER_CALL);
    vm.warp(block.timestamp + 1 hours);
    bytes memory before = abi.encode(_snapshot());

    vm.startPrank(guardian);
    manager.reduceMaxFundingPerCall(MAX_FUNDING_PER_CALL);
    manager.reduceAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    manager.reducePoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    manager.reduceRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE);
    manager.raisePoolMinimum(address(pool), POOL_MINIMUM);
    vm.stopPrank();
    assertEq(abi.encode(_snapshot()), before);

    // Re-checkpointing a bucket does not change its refill path.
    vm.warp(block.timestamp + 3 hours);
    assertEq(
      manager.getAggregateFundingBudget().available,
      _min(
        AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_CAPACITY - MAX_FUNDING_PER_CALL + 4 hours * AGGREGATE_FUNDING_RATE
      )
    );
    assertEq(
      manager.getRecallBudget().available,
      _min(RECALL_CAPACITY, RECALL_CAPACITY - MAX_RECALL_PER_CALL + 4 hours * RECALL_RATE)
    );
  }

  /// @dev Repeated Guardian checkpoints cannot accelerate refill: available after N calls equals the uninterrupted
  /// refill.
  function testFuzz_repeatedEqualReductions_doNotAccelerateRefill(uint8 calls, uint256 interval) public {
    calls = uint8(bound(calls, 1, 50));
    interval = bound(interval, 0, 1 hours);
    _fund(MAX_FUNDING_PER_CALL);
    uint256 start = manager.getPoolFundingBudget(address(pool)).available;

    for (uint256 i = 0; i < calls; ++i) {
      vm.warp(block.timestamp + interval);
      vm.prank(guardian);
      manager.reducePoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    }
    assertEq(
      manager.getPoolFundingBudget(address(pool)).available,
      _min(POOL_FUNDING_CAPACITY, start + uint256(calls) * interval * POOL_FUNDING_RATE)
    );
  }

  // ================================================================
  // │                 Only the owner can restore                   │
  // ================================================================

  function test_guardianCannotCallAnyOwnerFunction() public {
    bytes[] memory calls = _ownerCalls();
    bytes memory before = abi.encode(_snapshot());
    for (uint256 i = 0; i < calls.length; ++i) {
      _assertReverts(
        guardian,
        address(manager),
        calls[i],
        abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
      );
    }
    assertEq(abi.encode(_snapshot()), before);
  }

  function test_guardianCannotCallAnyOwnerFunction_evenWhileRestricted() public {
    _restrictEverything(guardian);
    bytes[] memory calls = _ownerCalls();
    bytes memory before = abi.encode(_snapshot());
    for (uint256 i = 0; i < calls.length; ++i) {
      _assertReverts(
        guardian,
        address(manager),
        calls[i],
        abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
      );
    }
    assertEq(abi.encode(_snapshot()), before);
  }

  function test_guardianCannotTakeOrDropOwnership() public {
    // No pending owner: acceptOwnership rejects the Guardian.
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeWithSignature("acceptOwnership()"),
      abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
    );
    // Pending owner set by the owner: still only that account can accept.
    vm.prank(address(timelock));
    manager.transferOwnership(newGuardian);
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeWithSignature("acceptOwnership()"),
      abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
    );
    // Renouncing is disabled for everyone.
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeWithSignature("renounceOwnership()"),
      abi.encodeWithSelector(ILiquidityManager.OwnershipCannotBeRenounced.selector)
    );
    assertEq(manager.owner(), address(timelock));
  }

  function test_restore_fundingPause_onlyOwner() public {
    vm.prank(guardian);
    manager.pauseFunding();

    _assertOwnerOnly(abi.encodeCall(LiquidityManager.setFundingPaused, (false)));
    vm.expectEmit(address(manager));
    emit ILiquidityManager.FundingPausedSet(false);
    vm.prank(address(timelock));
    manager.setFundingPaused(false);
    _fund(1e18);
  }

  function test_restore_recallPause_onlyOwner() public {
    vm.prank(guardian);
    manager.pauseRecall();

    _assertOwnerOnly(abi.encodeCall(LiquidityManager.setRecallPaused, (false)));
    vm.prank(address(timelock));
    manager.setRecallPaused(false);
    _recall(1e18);
  }

  function test_restore_operators_onlyOwner() public {
    vm.startPrank(guardian);
    manager.suspendFundingOperator(fundingOperator);
    manager.suspendRecallOperator(recallOperator);
    vm.stopPrank();

    _assertOwnerOnly(abi.encodeCall(LiquidityManager.setFundingOperator, (fundingOperator, true)));
    _assertOwnerOnly(abi.encodeCall(LiquidityManager.setRecallOperator, (recallOperator, true)));

    vm.startPrank(address(timelock));
    manager.setFundingOperator(fundingOperator, true);
    manager.setRecallOperator(recallOperator, true);
    vm.stopPrank();
    _fund(1e18);
    _recall(1e18);
  }

  function test_restore_adapterStatus_onlyOwner() public {
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, true, true);

    _assertOwnerOnly(abi.encodeCall(LiquidityManager.setAdapterStatus, (adapterId, true, true)));
    vm.prank(address(timelock));
    manager.setAdapterStatus(adapterId, true, true);
    _fund(1e18);
    _recall(1e18);
  }

  function test_restore_limits_onlyOwner() public {
    vm.startPrank(guardian);
    manager.reduceMaxFundingPerCall(0);
    manager.reduceAggregateFundingBudget(0, 0);
    manager.reducePoolFundingBudget(address(pool), 0, 0);
    manager.reduceRecallLimits(0, 0, 0);
    manager.raisePoolMinimum(address(pool), type(uint256).max);

    // The Guardian's own functions cannot undo anything.
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reduceMaxFundingPerCall(MAX_FUNDING_PER_CALL);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reduceAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reducePoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.reduceRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    manager.raisePoolMinimum(address(pool), POOL_MINIMUM);
    vm.stopPrank();

    _assertOwnerOnly(abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (MAX_FUNDING_PER_CALL)));
    _assertOwnerOnly(
      abi.encodeCall(LiquidityManager.setAggregateFundingBudget, (AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE))
    );
    _assertOwnerOnly(
      abi.encodeCall(LiquidityManager.setPoolFundingBudget, (address(pool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE))
    );
    _assertOwnerOnly(
      abi.encodeCall(LiquidityManager.setRecallLimits, (MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE))
    );
    _assertOwnerOnly(
      abi.encodeCall(
        LiquidityManager.setPoolThresholds, (address(pool), POOL_MINIMUM, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET)
      )
    );

    _restoreLimitsAsOwner();
    // Restoring the configuration does not restore the zeroed budgets: they refill from zero.
    assertEq(manager.getAggregateFundingBudget().available, 0);
    assertEq(manager.getPoolFundingBudget(address(pool)).available, 0);
    assertEq(manager.getRecallBudget().available, 0);
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1e18, 0));
    _fund(1e18);

    vm.warp(block.timestamp + 1 hours);
    _fund(1e18);
    _recall(1e18);
  }

  function test_restore_migrationApproval_onlyOwner() public {
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), otherPool);
    vm.prank(guardian);
    manager.revokePoolMigrationApproval(address(pool));
    assertEq(manager.getPoolMigrationSource(address(pool)), address(0));

    _assertOwnerOnly(abi.encodeCall(LiquidityManager.setPoolMigrationApproval, (address(pool), otherPool)));
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), otherPool);
    assertEq(manager.getPoolMigrationSource(address(pool)), otherPool);
  }

  /// @dev Reduce -> owner raises the configuration back: usage stays consumed (the available amount is not reset).
  function test_reduceThenOwnerRestore_doesNotLaunderUsage() public {
    _fund(MAX_FUNDING_PER_CALL);
    _recall(MAX_RECALL_PER_CALL);
    uint256 aggregateAvailable = manager.getAggregateFundingBudget().available;
    uint256 poolAvailable = manager.getPoolFundingBudget(address(pool)).available;
    uint256 recallAvailable = manager.getRecallBudget().available;

    vm.startPrank(guardian);
    manager.reduceAggregateFundingBudget(10_000_000e18, AGGREGATE_FUNDING_RATE);
    manager.reducePoolFundingBudget(address(pool), 10_000_000e18, POOL_FUNDING_RATE);
    manager.reduceRecallLimits(MAX_RECALL_PER_CALL, 10_000_000e18, RECALL_RATE);
    vm.stopPrank();

    vm.startPrank(address(timelock));
    manager.setAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    manager.setPoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    manager.setRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE);
    vm.stopPrank();

    assertEq(manager.getAggregateFundingBudget().available, _min(aggregateAvailable, 10_000_000e18));
    assertEq(manager.getPoolFundingBudget(address(pool)).available, _min(poolAvailable, 10_000_000e18));
    assertEq(manager.getRecallBudget().available, _min(recallAvailable, 10_000_000e18));
  }

  // ================================================================
  // │                 The Guardian cannot move funds               │
  // ================================================================

  function test_guardianCannotMoveFunds() public {
    MockSahara stray = new MockSahara(address(manager));
    Snapshot memory before = _snapshot();
    uint256 strayBefore = stray.balanceOf(address(manager));

    // Manager: operations and owner-only transfers.
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.fund, (adapterId, 1e18)),
      abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, guardian)
    );
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.recall, (adapterId, 1e18)),
      abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, guardian)
    );
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.migrateReserves, (guardian, MANAGER_RESERVES)),
      abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
    );
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.recoverToken, (address(stray), guardian, 1e18)),
      abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
    );
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.recoverToken, (address(token), guardian, 1e18)),
      abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
    );

    // Adapter: only the Manager.
    _assertReverts(
      guardian,
      address(adapter),
      abi.encodeCall(CCIPPoolAdapter.fund, (1e18)),
      abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, guardian)
    );
    _assertReverts(
      guardian,
      address(adapter),
      abi.encodeCall(CCIPPoolAdapter.recall, (1e18)),
      abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, guardian)
    );

    // Pool: rebalancer and owner functions.
    _assertReverts(
      guardian,
      address(pool),
      abi.encodeCall(MockLockReleaseTokenPool.withdrawLiquidity, (1e18)),
      abi.encodeWithSelector(MockLockReleaseTokenPool.Unauthorized.selector, guardian)
    );
    _assertReverts(
      guardian,
      address(pool),
      abi.encodeCall(MockLockReleaseTokenPool.provideLiquidity, (1e18)),
      abi.encodeWithSelector(MockLockReleaseTokenPool.Unauthorized.selector, guardian)
    );
    _assertReverts(
      guardian,
      address(pool),
      abi.encodeCall(MockLockReleaseTokenPool.setRebalancer, (guardian)),
      abi.encodeWithSelector(MockLockReleaseTokenPool.Unauthorized.selector, guardian)
    );
    // The Guardian is not the pool's rateLimitAdmin; only the controller is, and it only zeroes.
    _assertReverts(
      guardian,
      address(pool),
      abi.encodeCall(
        MockLockReleaseTokenPool.setChainRateLimiterConfig,
        (REMOTE_CHAIN_SELECTOR, _ccipBucket(type(uint128).max, 1), _ccipBucket(type(uint128).max, 1))
      ),
      abi.encodeWithSelector(MockLockReleaseTokenPool.Unauthorized.selector, guardian)
    );

    // Token: no pause authority, and the Manager never grants allowances.
    _assertReverts(
      guardian,
      address(token),
      abi.encodeCall(MockSahara.pause, ()),
      abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
    );
    assertEq(token.allowance(address(manager), guardian), 0);
    assertEq(token.allowance(address(adapter), guardian), 0);
    _assertReverts(
      guardian,
      address(token),
      abi.encodeWithSignature("transferFrom(address,address,uint256)", address(manager), guardian, 1),
      abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, guardian, 0, 1)
    );

    assertEq(abi.encode(_snapshot()), abi.encode(before));
    assertEq(stray.balanceOf(address(manager)), strayBefore);
    assertEq(_balance(guardian), 0);
    assertEq(_balance(address(controller)), 0);
  }

  function test_guardianCannotUseTimelockDirectly() public {
    bytes memory data = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (1));
    bytes32 id = _schedule(address(manager), data, bytes32(0), bytes32("direct"));

    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, timelock.CANCELLER_ROLE()
      )
    );
    vm.prank(guardian);
    timelock.cancel(id);

    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, timelock.PROPOSER_ROLE()
      )
    );
    vm.prank(guardian);
    timelock.schedule(address(manager), 0, data, bytes32(0), bytes32("guardian"), TIMELOCK_DELAY);

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, timelock.EXECUTOR_ROLE()
      )
    );
    vm.prank(guardian);
    timelock.execute(address(manager), 0, data, bytes32(0), bytes32("direct"));

    assertTrue(timelock.isOperationReady(id));
  }

  /// @dev Structured fuzz over every mutating Manager function called by the Guardian: whatever succeeds, no principal
  /// moves, no authority changes and no limit is loosened.
  function testFuzz_guardianArbitraryManagerCall_neverMovesFundsOrLoosens(
    uint256 selectorIndex,
    address addr,
    uint256 u1,
    uint256 u2,
    uint256 u3,
    bool b1,
    bool b2,
    bool boundValues
  ) public {
    if (boundValues) {
      u1 = bound(u1, 0, 200_000_000e18);
      u2 = bound(u2, 0, 200_000_000e18);
      u3 = bound(u3, 0, 200_000_000e18);
    }
    _callAsGuardianAndCheck(_encodeManagerCall(selectorIndex, addr, u1, u2, u3, b1, b2), addr);
  }

  function _callAsGuardianAndCheck(bytes memory data, address addr) internal {
    Snapshot memory before = _snapshot();
    (ILiquidityManager.PoolSpec memory specBefore,) = manager.getPoolSpec(address(pool));
    bytes32 specHashBefore = keccak256(abi.encode(specBefore));
    uint256 adapterCountBefore = manager.adapterCount();

    vm.prank(guardian);
    (bool ok,) = address(manager).call(data);
    ok; // Success or failure are both acceptable; only the effects are checked.

    _assertNoEscalation(before, specHashBefore, adapterCountBefore, addr);
  }

  function _assertNoEscalation(Snapshot memory before, bytes32 specHashBefore, uint256 adapterCountBefore, address addr)
    internal
    view
  {
    Snapshot memory afterState = _snapshot();
    // Principal and authority.
    assertEq(afterState.managerBalance, before.managerBalance, "manager balance moved");
    assertEq(afterState.poolBalance, before.poolBalance, "pool balance moved");
    assertEq(afterState.adapterBalance, before.adapterBalance, "adapter balance moved");
    assertEq(_balance(guardian), 0);
    assertEq(afterState.owner, before.owner);
    assertEq(afterState.pendingOwner, before.pendingOwner);
    assertEq(afterState.guardian, before.guardian);
    assertFalse(manager.isFundingOperator(guardian));
    assertFalse(manager.isRecallOperator(guardian));
    assertFalse(manager.isFundingOperator(addr) && addr != fundingOperator, "funding role granted");
    assertFalse(manager.isRecallOperator(addr) && addr != recallOperator, "recall role granted");
    // Registry and spec.
    assertEq(manager.adapterCount(), adapterCountBefore);
    assertEq(afterState.adapterEntry.adapter, before.adapterEntry.adapter);
    assertEq(afterState.adapterEntry.pool, before.adapterEntry.pool);
    (ILiquidityManager.PoolSpec memory specAfter,) = manager.getPoolSpec(address(pool));
    assertEq(keccak256(abi.encode(specAfter)), specHashBefore);
    // Restrict only.
    assertTrue(afterState.fundingPaused || !before.fundingPaused);
    assertTrue(afterState.recallPaused || !before.recallPaused);
    assertTrue(!afterState.fundingOperatorEnabled || before.fundingOperatorEnabled);
    assertTrue(!afterState.recallOperatorEnabled || before.recallOperatorEnabled);
    assertTrue(!afterState.adapterEntry.fundingEnabled || before.adapterEntry.fundingEnabled);
    assertTrue(!afterState.adapterEntry.recallEnabled || before.adapterEntry.recallEnabled);
    assertTrue(
      afterState.migrationSource == address(0) || afterState.migrationSource == before.migrationSource,
      "migration approval granted or rebound"
    );
    assertLe(afterState.maxFundingPerCall, before.maxFundingPerCall);
    assertLe(afterState.maxRecallPerCall, before.maxRecallPerCall);
    assertGe(afterState.thresholds.minimum, before.thresholds.minimum);
    assertEq(afterState.thresholds.refillTrigger, before.thresholds.refillTrigger);
    assertEq(afterState.thresholds.refillTarget, before.thresholds.refillTarget);
    _assertBucketNotLoosened(afterState.aggregate, before.aggregate);
    _assertBucketNotLoosened(afterState.poolBudget, before.poolBudget);
    _assertBucketNotLoosened(afterState.recallBudget, before.recallBudget);
    if (addr != address(pool)) {
      ILiquidityManager.BudgetState memory other = manager.getPoolFundingBudget(addr);
      assertEq(other.capacity, 0);
      assertEq(other.rate, 0);
      assertEq(other.available, 0);
      assertEq(manager.getPoolMigrationSource(addr), address(0));
    }
    // Authorities outside the Manager and the adapter history.
    assertEq(afterState.poolOwner, before.poolOwner);
    assertEq(afterState.poolRebalancer, before.poolRebalancer);
    assertEq(afterState.poolRateLimitAdmin, before.poolRateLimitAdmin);
    assertEq(afterState.tokenOwner, before.tokenOwner);
    assertEq(afterState.registryAdministrator, before.registryAdministrator);
    assertEq(afterState.registryPendingAdministrator, before.registryPendingAdministrator);
    assertEq(afterState.registryPool, before.registryPool);
    assertEq(afterState.adapterHistoryLength, before.adapterHistoryLength);
    assertFalse(manager.isRegisteredAdapter(addr) && addr != address(adapter), "adapter recorded");
  }

  // ================================================================
  // │                 Guardian removal and replacement             │
  // ================================================================

  function test_setGuardianZero_revokesAllManagerPowers() public {
    vm.expectEmit(address(manager));
    emit ILiquidityManager.GuardianSet(guardian, address(0));
    vm.prank(address(timelock));
    manager.setGuardian(address(0));
    assertEq(manager.guardian(), address(0));

    bytes[] memory calls = _guardianCalls();
    bytes memory before = abi.encode(_snapshot());
    for (uint256 i = 0; i < calls.length; ++i) {
      _assertReverts(
        guardian,
        address(manager),
        calls[i],
        abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, guardian)
      );
    }
    assertEq(abi.encode(_snapshot()), before);
  }

  function test_setGuardianZero_revokesAllControllerPowers() public {
    (bytes32 id, bytes memory data, bytes32 salt) = _scheduleCancellable("single");
    (bytes32 batchId, address[] memory targets, uint256[] memory values, bytes[] memory payloads, bytes32 batchSalt) =
      _scheduleCancellableBatch("batch");

    vm.prank(address(timelock));
    manager.setGuardian(address(0));

    _assertControllerPowersRevoked(guardian, id, data, salt, batchId, targets, values, payloads, batchSalt);
  }

  function test_guardianZero_nobodyCanCallGuardianFunctions() public {
    vm.prank(address(timelock));
    manager.setGuardian(address(0));

    (bytes32 id, bytes memory data, bytes32 salt) = _scheduleCancellable("single");
    (bytes32 batchId, address[] memory targets, uint256[] memory values, bytes[] memory payloads, bytes32 batchSalt) =
      _scheduleCancellableBatch("batch");

    bytes[] memory calls = _guardianCalls();
    address[] memory callers = _nonGuardianCallers();
    bytes memory before = abi.encode(_snapshot());
    for (uint256 c = 0; c < callers.length + 1; ++c) {
      address caller = c == callers.length ? guardian : callers[c];
      for (uint256 i = 0; i < calls.length; ++i) {
        _assertReverts(
          caller,
          address(manager),
          calls[i],
          abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, caller)
        );
      }
      _assertControllerPowersRevoked(caller, id, data, salt, batchId, targets, values, payloads, batchSalt);
    }
    assertEq(abi.encode(_snapshot()), before);
  }

  function testFuzz_guardianZero_noCallerPassesGuardianCheck(address caller, uint256 index) public {
    vm.assume(caller != address(0));
    assumeNotForgeAddress(caller);
    vm.prank(address(timelock));
    manager.setGuardian(address(0));

    bytes[] memory calls = _guardianCalls();
    _assertReverts(
      caller,
      address(manager),
      calls[index % calls.length],
      abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, caller)
    );
    _assertReverts(
      caller,
      address(controller),
      abi.encodeCall(GuardianController.lockdown, (address(pool))),
      abi.encodeWithSelector(GuardianController.CallerNotGuardian.selector, caller)
    );
  }

  function test_setGuardianNew_transfersAllPowers() public {
    (bytes32 id, bytes memory data, bytes32 salt) = _scheduleCancellable("single");
    (bytes32 batchId, address[] memory targets, uint256[] memory values, bytes[] memory payloads, bytes32 batchSalt) =
      _scheduleCancellableBatch("batch");

    vm.expectEmit(address(manager));
    emit ILiquidityManager.GuardianSet(guardian, newGuardian);
    vm.prank(address(timelock));
    manager.setGuardian(newGuardian);

    // The old Guardian lost everything.
    bytes[] memory calls = _guardianCalls();
    for (uint256 i = 0; i < calls.length; ++i) {
      _assertReverts(
        guardian,
        address(manager),
        calls[i],
        abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, guardian)
      );
    }
    _assertControllerPowersRevoked(guardian, id, data, salt, batchId, targets, values, payloads, batchSalt);

    // The new Guardian has everything.
    for (uint256 i = 0; i < calls.length; ++i) {
      vm.prank(newGuardian);
      (bool ok,) = address(manager).call(calls[i]);
      assertTrue(ok, string(abi.encodePacked("new guardian call failed: ", vm.toString(i))));
    }

    vm.expectEmit(address(controller));
    emit GuardianController.ProposalCancelled(id, newGuardian);
    vm.prank(newGuardian);
    controller.cancel(address(manager), 0, data, bytes32(0), salt);
    assertFalse(timelock.isOperation(id));

    vm.expectEmit(address(controller));
    emit GuardianController.ProposalCancelled(batchId, newGuardian);
    vm.prank(newGuardian);
    controller.cancelBatch(targets, values, payloads, bytes32(0), batchSalt);
    assertFalse(timelock.isOperation(batchId));

    vm.expectEmit(address(controller));
    emit GuardianController.PoolLockedDown(address(pool), REMOTE_CHAIN_SELECTOR, newGuardian);
    vm.prank(newGuardian);
    controller.lockdown(address(pool));
    _assertPoolLockedDown();
  }

  /// @dev Removal revokes powers; it does not undo restrictions already applied. Those need separate restoration.
  function test_setGuardian_keepsExistingRestrictions() public {
    _restrictEverything(guardian);
    Snapshot memory before = _snapshot();

    vm.prank(address(timelock));
    manager.setGuardian(newGuardian);

    Snapshot memory afterState = _snapshot();
    assertEq(afterState.guardian, newGuardian);
    before.guardian = newGuardian;
    assertEq(abi.encode(afterState), abi.encode(before));
    _assertPoolLockedDown();
  }

  function test_setGuardian_viaTimelock_whileEverythingRestricted() public {
    _restrictEverything(guardian);

    bytes memory data = abi.encodeCall(LiquidityManager.setGuardian, (newGuardian));
    bytes32 salt = bytes32("remove-guardian");
    bytes32 id = _schedule(address(manager), data, bytes32(0), salt);

    // The Guardian cannot cancel its own replacement.
    vm.expectRevert(abi.encodeWithSelector(GuardianController.ProtectedOperation.selector, id));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, bytes32(0), salt);

    // Restricting further while it is queued does not block it.
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.prank(guardian);
    manager.raisePoolMinimum(address(pool), type(uint256).max);

    vm.expectEmit(address(manager));
    emit ILiquidityManager.GuardianSet(guardian, newGuardian);
    vm.prank(governanceSafe);
    timelock.execute(address(manager), 0, data, bytes32(0), salt);
    assertEq(manager.guardian(), newGuardian);
    assertTrue(timelock.isOperationDone(id));

    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.pauseFunding, ()),
      abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, guardian)
    );
    _assertReverts(
      guardian,
      address(controller),
      abi.encodeCall(GuardianController.lockdown, (address(pool))),
      abi.encodeWithSelector(GuardianController.CallerNotGuardian.selector, guardian)
    );
  }

  function test_setGuardian_viaTimelockBatchOfOne_whileEverythingRestricted() public {
    _restrictEverything(guardian);

    address[] memory targets = new address[](1);
    uint256[] memory values = new uint256[](1);
    bytes[] memory payloads = new bytes[](1);
    targets[0] = address(manager);
    payloads[0] = abi.encodeCall(LiquidityManager.setGuardian, (address(0)));
    bytes32 salt = bytes32("remove-guardian-batch");
    vm.prank(governanceSafe);
    timelock.scheduleBatch(targets, values, payloads, bytes32(0), salt, TIMELOCK_DELAY);
    bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), salt);

    vm.expectRevert(abi.encodeWithSelector(GuardianController.ProtectedOperation.selector, id));
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, bytes32(0), salt);

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.prank(governanceSafe);
    timelock.executeBatch(targets, values, payloads, bytes32(0), salt);
    assertEq(manager.guardian(), address(0));

    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.pauseRecall, ()),
      abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, guardian)
    );
  }

  // ================================================================
  // │                   Compromised Guardian scenario              │
  // ================================================================

  function test_scenario_compromisedGuardian_noPrincipalMoves_timelockRestores() public {
    // Normal operation first, so the budgets carry usage.
    _fund(10_000_000e18);
    _recall(5_000_000e18);
    uint256 total = _balance(address(manager)) + _balance(address(pool)) + _balance(address(adapter));
    assertEq(total, MANAGER_RESERVES + POOL_INVENTORY);

    _scenarioCompromise();
    _scenarioReplaceGuardian();
    _scenarioRestore();
    _assertFullyRestored();

    // Consumed budget is not restored: zeroed buckets restart empty and refill.
    assertEq(manager.getAggregateFundingBudget().available, 0);
    assertEq(manager.getPoolFundingBudget(address(pool)).available, 0);
    assertEq(manager.getRecallBudget().available, 0);
    vm.warp(block.timestamp + 1 days);
    _fund(10_000_000e18);
    _recall(10_000_000e18);

    // Conservation across the whole incident.
    assertEq(_balance(address(manager)) + _balance(address(pool)) + _balance(address(adapter)), total);
    assertEq(_balance(address(adapter)), 0);
    assertEq(token.allowance(address(adapter), address(pool)), 0);
  }

  /// @dev The compromised Guardian cancels a routine proposal, applies every restriction, locks the pool down and
  /// tries every way to move funds. No principal moves.
  function _scenarioCompromise() internal {
    Snapshot memory start = _snapshot();

    (bytes32 routineId, bytes memory routineData, bytes32 routineSalt) = _scheduleCancellable("routine");
    vm.prank(guardian);
    controller.cancel(address(manager), 0, routineData, bytes32(0), routineSalt);
    assertFalse(timelock.isOperation(routineId));

    _restrictEverything(guardian);

    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.migrateReserves, (guardian, 1)),
      abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
    );
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.recoverToken, (address(token), guardian, 1)),
      abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
    );
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.fund, (adapterId, 1)),
      abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, guardian)
    );
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.recall, (adapterId, 1)),
      abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, guardian)
    );
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.setGuardian, (attacker)),
      abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
    );

    assertEq(_balance(address(manager)), start.managerBalance);
    assertEq(_balance(address(pool)), start.poolBalance);
    assertEq(_balance(address(adapter)), start.adapterBalance);
    assertEq(_balance(guardian), 0);
    assertEq(_balance(address(controller)), 0);
    assertEq(_balance(address(timelock)), 0);
    _assertPoolLockedDown();

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, fundingOperator));
    _fund(1);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, recallOperator));
    _recall(1);
  }

  /// @dev A restoration queued while the Guardian is in office gets cancelled; its standalone replacement cannot be.
  function _scenarioReplaceGuardian() internal {
    (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _restorationBatch();
    bytes32 earlySalt = bytes32("restore-early");
    vm.prank(governanceSafe);
    timelock.scheduleBatch(targets, values, payloads, bytes32(0), earlySalt, TIMELOCK_DELAY);
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, bytes32(0), earlySalt);
    assertFalse(timelock.isOperation(timelock.hashOperationBatch(targets, values, payloads, bytes32(0), earlySalt)));

    bytes memory removal = abi.encodeCall(LiquidityManager.setGuardian, (newGuardian));
    bytes32 removalSalt = bytes32("replace-guardian");
    bytes32 removalId = _schedule(address(manager), removal, bytes32(0), removalSalt);
    vm.expectRevert(abi.encodeWithSelector(GuardianController.ProtectedOperation.selector, removalId));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, removal, bytes32(0), removalSalt);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.prank(governanceSafe);
    timelock.execute(address(manager), 0, removal, bytes32(0), removalSalt);
    assertEq(manager.guardian(), newGuardian);
  }

  /// @dev Restoration after the replacement is beyond the old Guardian's reach.
  function _scenarioRestore() internal {
    (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _restorationBatch();
    bytes32 restoreSalt = bytes32("restore");
    bytes32 restoreId = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), restoreSalt);
    vm.prank(governanceSafe);
    timelock.scheduleBatch(targets, values, payloads, bytes32(0), restoreSalt, TIMELOCK_DELAY);

    vm.expectRevert(abi.encodeWithSelector(GuardianController.CallerNotGuardian.selector, guardian));
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, bytes32(0), restoreSalt);
    _assertReverts(
      guardian,
      address(manager),
      abi.encodeCall(LiquidityManager.pauseFunding, ()),
      abi.encodeWithSelector(ILiquidityManager.CallerNotGuardian.selector, guardian)
    );

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.prank(governanceSafe);
    timelock.executeBatch(targets, values, payloads, bytes32(0), restoreSalt);
    assertTrue(timelock.isOperationDone(restoreId));
  }

  function _assertFullyRestored() internal view {
    assertFalse(manager.fundingPaused());
    assertFalse(manager.recallPaused());
    assertTrue(manager.isFundingOperator(fundingOperator));
    assertTrue(manager.isRecallOperator(recallOperator));
    ILiquidityManager.Adapter memory entry = manager.getAdapter(adapterId);
    assertTrue(entry.fundingEnabled);
    assertTrue(entry.recallEnabled);
    assertEq(manager.maxFundingPerCall(), MAX_FUNDING_PER_CALL);
    assertEq(manager.maxRecallPerCall(), MAX_RECALL_PER_CALL);
    assertEq(manager.getAggregateFundingBudget().capacity, AGGREGATE_FUNDING_CAPACITY);
    assertEq(manager.getAggregateFundingBudget().rate, AGGREGATE_FUNDING_RATE);
    assertEq(manager.getPoolFundingBudget(address(pool)).capacity, POOL_FUNDING_CAPACITY);
    assertEq(manager.getPoolFundingBudget(address(pool)).rate, POOL_FUNDING_RATE);
    assertEq(manager.getRecallBudget().capacity, RECALL_CAPACITY);
    assertEq(manager.getRecallBudget().rate, RECALL_RATE);
    (ILiquidityManager.PoolThresholds memory thresholds, bool thresholdsSet) = manager.getPoolThresholds(address(pool));
    assertTrue(thresholdsSet);
    assertEq(thresholds.minimum, POOL_MINIMUM);
    assertEq(thresholds.refillTrigger, POOL_REFILL_TRIGGER);
    assertEq(thresholds.refillTarget, POOL_REFILL_TARGET);
    _assertPoolRateLimits(CCIP_CAPACITY, CCIP_RATE);
  }

  // ================================================================
  // │            Regression: GuardianAction audit event            │
  // ================================================================

  /// @dev Every Guardian function emits `GuardianAction(guardian, selector)` and then its configuration event, in that
  /// order (two ordered `expectEmit`s per call).
  function test_regression_guardianAction_emittedBeforeConfigEvent_everyFunction() public {
    _expectGuardianAction(guardian, LiquidityManager.pauseFunding.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.FundingPausedSet(true);
    vm.prank(guardian);
    manager.pauseFunding();

    _expectGuardianAction(guardian, LiquidityManager.pauseRecall.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.RecallPausedSet(true);
    vm.prank(guardian);
    manager.pauseRecall();

    _expectGuardianAction(guardian, LiquidityManager.suspendFundingOperator.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.FundingOperatorSet(fundingOperator, false);
    vm.prank(guardian);
    manager.suspendFundingOperator(fundingOperator);

    _expectGuardianAction(guardian, LiquidityManager.suspendRecallOperator.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.RecallOperatorSet(recallOperator, false);
    vm.prank(guardian);
    manager.suspendRecallOperator(recallOperator);

    _expectGuardianAction(guardian, LiquidityManager.restrictAdapter.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.AdapterStatusSet(adapterId, false, false);
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, true, true);

    _expectGuardianAction(guardian, LiquidityManager.revokePoolMigrationApproval.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(address(pool), address(0));
    vm.prank(guardian);
    manager.revokePoolMigrationApproval(address(pool));

    _expectGuardianAction(guardian, LiquidityManager.reduceMaxFundingPerCall.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.MaxFundingPerCallSet(MAX_FUNDING_PER_CALL - 1);
    vm.prank(guardian);
    manager.reduceMaxFundingPerCall(MAX_FUNDING_PER_CALL - 1);

    _expectGuardianAction(guardian, LiquidityManager.reduceAggregateFundingBudget.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.AggregateFundingBudgetSet(AGGREGATE_FUNDING_CAPACITY - 1, AGGREGATE_FUNDING_RATE - 1);
    vm.prank(guardian);
    manager.reduceAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY - 1, AGGREGATE_FUNDING_RATE - 1);

    _expectGuardianAction(guardian, LiquidityManager.reducePoolFundingBudget.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.PoolFundingBudgetSet(address(pool), POOL_FUNDING_CAPACITY - 1, POOL_FUNDING_RATE - 1);
    vm.prank(guardian);
    manager.reducePoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY - 1, POOL_FUNDING_RATE - 1);

    _expectGuardianAction(guardian, LiquidityManager.reduceRecallLimits.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.RecallLimitsSet(MAX_RECALL_PER_CALL - 1, RECALL_CAPACITY - 1, RECALL_RATE - 1);
    vm.prank(guardian);
    manager.reduceRecallLimits(MAX_RECALL_PER_CALL - 1, RECALL_CAPACITY - 1, RECALL_RATE - 1);

    _expectGuardianAction(guardian, LiquidityManager.raisePoolMinimum.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.PoolThresholdsSet(address(pool), POOL_MINIMUM + 1, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET);
    vm.prank(guardian);
    manager.raisePoolMinimum(address(pool), POOL_MINIMUM + 1);
  }

  /// @dev Exact log sequence of every Guardian function: exactly [GuardianAction(guardian, selector), config event],
  /// both from the Manager.
  function test_regression_guardianAction_exactLogSequence_everyFunction() public {
    bytes[] memory calls = _guardianCalls();
    bytes32[] memory configTopics = _guardianConfigEventTopics();
    for (uint256 i = 0; i < calls.length; ++i) {
      _assertGuardianActionLogs(guardian, calls[i], configTopics[i]);
    }
  }

  function testFuzz_regression_guardianAction_selectorMatchesCall(uint256 index) public {
    bytes[] memory calls = _guardianCalls();
    index = index % calls.length;
    _assertGuardianActionLogs(guardian, calls[index], _guardianConfigEventTopics()[index]);
  }

  /// @dev The audit event is emitted for no-op restrictions too, and it names the Guardian in office.
  function test_regression_guardianAction_emittedForNoOpsAndByReplacementGuardian() public {
    // No-op restrictions still leave an audit trail.
    _assertGuardianActionLogs(
      guardian,
      abi.encodeCall(LiquidityManager.restrictAdapter, (adapterId, false, false)),
      ILiquidityManager.AdapterStatusSet.selector
    );
    _assertGuardianActionLogs(
      guardian,
      abi.encodeCall(LiquidityManager.revokePoolMigrationApproval, (otherPool)),
      ILiquidityManager.PoolMigrationApprovalSet.selector
    );
    _assertGuardianActionLogs(
      guardian,
      abi.encodeCall(LiquidityManager.reducePoolFundingBudget, (otherPool, 0, 0)),
      ILiquidityManager.PoolFundingBudgetSet.selector
    );

    // The event follows the caller check: a rejected caller reaches no emit. (`vm.recordLogs` would also keep logs of
    // a reverted frame, so this observes that nothing is emitted before the check.)
    vm.recordLogs();
    vm.prank(attacker);
    (bool ok,) = address(manager).call(abi.encodeCall(LiquidityManager.pauseFunding, ()));
    assertFalse(ok);
    assertEq(vm.getRecordedLogs().length, 0, "rejected caller emitted a log");

    // After replacement the event names the new Guardian.
    vm.prank(address(timelock));
    manager.setGuardian(newGuardian);
    _assertGuardianActionLogs(
      newGuardian, abi.encodeCall(LiquidityManager.pauseFunding, ()), ILiquidityManager.FundingPausedSet.selector
    );
  }

  // ================================================================
  // │       Regression: reductions of never-configured buckets     │
  // ================================================================

  /// @dev A fresh Manager has never-configured aggregate and recall buckets (and pool buckets). The Guardian may only
  /// "reduce" them to 0/0, which is a no-op that still emits the events; the owner's first configuration starts full.
  function test_regression_reduceBudgets_freshManager_onlyZeroZero_ownerFirstConfigStartsFull() public {
    LiquidityManager fresh = new LiquidityManager(address(token), registry, address(timelock), guardian);

    vm.startPrank(guardian);
    // Anything above the (zero) current values is a loosening.
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    fresh.reduceAggregateFundingBudget(1, 0);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    fresh.reduceAggregateFundingBudget(0, 1);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    fresh.reduceRecallLimits(1, 0, 0);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    fresh.reduceRecallLimits(0, 1, 0);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    fresh.reduceRecallLimits(0, 0, 1);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    fresh.reducePoolFundingBudget(address(pool), 1, 0);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    fresh.reducePoolFundingBudget(address(pool), 0, 1);

    // 0/0 succeeds and still emits the audit and configuration events.
    _expectGuardianAction(fresh, guardian, LiquidityManager.reduceAggregateFundingBudget.selector);
    vm.expectEmit(address(fresh));
    emit ILiquidityManager.AggregateFundingBudgetSet(0, 0);
    fresh.reduceAggregateFundingBudget(0, 0);

    _expectGuardianAction(fresh, guardian, LiquidityManager.reduceRecallLimits.selector);
    vm.expectEmit(address(fresh));
    emit ILiquidityManager.RecallLimitsSet(0, 0, 0);
    fresh.reduceRecallLimits(0, 0, 0);

    _expectGuardianAction(fresh, guardian, LiquidityManager.reducePoolFundingBudget.selector);
    vm.expectEmit(address(fresh));
    emit ILiquidityManager.PoolFundingBudgetSet(address(pool), 0, 0);
    fresh.reducePoolFundingBudget(address(pool), 0, 0);
    vm.stopPrank();

    _assertBudget(fresh.getAggregateFundingBudget(), 0, 0, 0);
    _assertBudget(fresh.getRecallBudget(), 0, 0, 0);
    _assertBudget(fresh.getPoolFundingBudget(address(pool)), 0, 0, 0);
    assertEq(fresh.maxRecallPerCall(), 0);

    // The buckets stayed uninitialized: the owner's first configuration starts them full, however late it comes.
    vm.warp(block.timestamp + 30 days);
    vm.startPrank(address(timelock));
    fresh.setAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    fresh.setRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE);
    fresh.setPoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    vm.stopPrank();

    _assertBudget(
      fresh.getAggregateFundingBudget(), AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE, AGGREGATE_FUNDING_CAPACITY
    );
    _assertBudget(fresh.getRecallBudget(), RECALL_CAPACITY, RECALL_RATE, RECALL_CAPACITY);
    _assertBudget(
      fresh.getPoolFundingBudget(address(pool)), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE, POOL_FUNDING_CAPACITY
    );
    assertEq(fresh.maxRecallPerCall(), MAX_RECALL_PER_CALL);

    // Once initialized, a Guardian reduction to zero is sticky again: the owner's reconfiguration refills from zero.
    vm.prank(guardian);
    fresh.reduceAggregateFundingBudget(0, 0);
    vm.prank(address(timelock));
    fresh.setAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    _assertBudget(fresh.getAggregateFundingBudget(), AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE, 0);
  }

  /// @dev Any number of Guardian 0/0 calls on never-configured buckets, at any times, leaves the owner's first
  /// configuration starting full; any non-zero value is rejected.
  function testFuzz_regression_reduceNeverConfiguredBuckets_ownerFirstConfigStartsFull(
    uint256 capacity,
    uint256 rate,
    uint256 perCall,
    uint8 repeats,
    uint256 interval,
    uint256 loosen
  ) public {
    repeats = uint8(bound(repeats, 1, 10));
    interval = bound(interval, 0, 10 days);
    loosen = bound(loosen, 1, type(uint256).max);
    LiquidityManager fresh = new LiquidityManager(address(token), registry, address(timelock), guardian);

    vm.startPrank(guardian);
    for (uint256 i = 0; i < repeats; ++i) {
      vm.warp(block.timestamp + interval);
      fresh.reduceAggregateFundingBudget(0, 0);
      fresh.reduceRecallLimits(0, 0, 0);
      fresh.reducePoolFundingBudget(otherPool, 0, 0);
    }
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    fresh.reduceAggregateFundingBudget(loosen, 0);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    fresh.reduceRecallLimits(0, 0, loosen);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    fresh.reducePoolFundingBudget(otherPool, 0, loosen);
    vm.stopPrank();

    vm.warp(block.timestamp + interval);
    vm.startPrank(address(timelock));
    fresh.setAggregateFundingBudget(capacity, rate);
    fresh.setRecallLimits(perCall, capacity, rate);
    fresh.setPoolFundingBudget(otherPool, capacity, rate);
    vm.stopPrank();

    _assertBudget(fresh.getAggregateFundingBudget(), capacity, rate, capacity);
    _assertBudget(fresh.getRecallBudget(), capacity, rate, capacity);
    _assertBudget(fresh.getPoolFundingBudget(otherPool), capacity, rate, capacity);
  }

  /// @dev The fixture's never-configured pools behave the same as a fresh Manager's buckets.
  function testFuzz_regression_reducePoolFundingBudget_neverConfiguredPool_onlyZeroZero(
    address anyPool,
    uint256 capacity,
    uint256 rate
  ) public {
    vm.assume(anyPool != address(0) && anyPool != address(pool));
    if (capacity != 0 || rate != 0) {
      vm.expectRevert(ILiquidityManager.NotARestriction.selector);
      vm.prank(guardian);
      manager.reducePoolFundingBudget(anyPool, capacity, rate);
      return;
    }
    vm.prank(guardian);
    manager.reducePoolFundingBudget(anyPool, 0, 0);
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(anyPool, POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    _assertBudget(
      manager.getPoolFundingBudget(anyPool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE, POOL_FUNDING_CAPACITY
    );
  }

  // ================================================================
  // │      Regression: revoking a source-bound migration approval  │
  // ================================================================

  /// @dev A replacement pool pre-funded under a migration approval bound to the current registry pool: the Guardian's
  /// revocation sets the source to address(0) and blocks further funding of it immediately.
  function test_regression_revokePoolMigrationApproval_replacementPool_setsSourceToZeroAndBlocksFunding() public {
    (MockLockReleaseTokenPool newPool, CCIPPoolAdapter newAdapter) = _deployReplacementPool();
    uint256 newId = _registerReplacementPool(newPool, newAdapter);
    assertEq(manager.getPoolMigrationSource(address(newPool)), address(pool));
    assertEq(registry.getPool(address(token)), address(pool), "registry still maps the source pool");

    // Pre-funding the replacement works while approved.
    vm.prank(fundingOperator);
    manager.fund(newId, 1e18);
    assertEq(_balance(address(newPool)), 1e18);

    _expectGuardianAction(guardian, LiquidityManager.revokePoolMigrationApproval.selector);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(address(newPool), address(0));
    vm.prank(guardian);
    manager.revokePoolMigrationApproval(address(newPool));
    assertEq(manager.getPoolMigrationSource(address(newPool)), address(0));

    bytes memory notActive =
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(newPool), address(pool));
    vm.expectRevert(notActive);
    vm.prank(fundingOperator);
    manager.fund(newId, 1e18);
    vm.expectRevert(notActive);
    manager.verifyAdapter(newId);
    assertEq(_balance(address(newPool)), 1e18);

    // The routine pool is unaffected, and recall from the replacement (which only returns funds) still works.
    _fund(1e18);
    vm.prank(recallOperator);
    manager.recall(newId, 1e18);
    assertEq(_balance(address(newPool)), 0);

    // The Guardian has no way to re-approve; only the owner can.
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(newPool), address(pool));
    vm.prank(fundingOperator);
    manager.fund(newId, 1e18);
  }

  /// @dev Revocation is a restriction for every approval state; it never touches another pool's approval.
  function testFuzz_regression_revokePoolMigrationApproval_onlyClearsThatPool(address source, bool revokeOther) public {
    vm.assume(source != address(0) && source != address(pool) && source != otherPool);
    vm.startPrank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), source);
    manager.setPoolMigrationApproval(otherPool, source);
    vm.stopPrank();

    vm.prank(guardian);
    manager.revokePoolMigrationApproval(revokeOther ? otherPool : address(pool));
    assertEq(manager.getPoolMigrationSource(address(pool)), revokeOther ? source : address(0));
    assertEq(manager.getPoolMigrationSource(otherPool), revokeOther ? address(0) : source);
  }

  // ================================================================
  // │         Regression: the Guardian is never an operator        │
  // ================================================================

  function test_regression_guardianCannotBeGrantedOperatorRole() public {
    vm.startPrank(address(timelock));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, guardian));
    manager.setFundingOperator(guardian, true);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, guardian));
    manager.setRecallOperator(guardian, true);

    // Revoking is always allowed.
    vm.expectEmit(address(manager));
    emit ILiquidityManager.FundingOperatorSet(guardian, false);
    manager.setFundingOperator(guardian, false);
    vm.expectEmit(address(manager));
    emit ILiquidityManager.RecallOperatorSet(guardian, false);
    manager.setRecallOperator(guardian, false);
    vm.stopPrank();
    assertFalse(manager.isFundingOperator(guardian));
    assertFalse(manager.isRecallOperator(guardian));

    // End to end through the Timelock: the scheduled grant fails at execution with the same error.
    bytes memory data = abi.encodeCall(LiquidityManager.setRecallOperator, (guardian, true));
    bytes32 salt = bytes32("grant-guardian-recall");
    bytes32 id = _schedule(address(manager), data, bytes32(0), salt);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, guardian));
    vm.prank(governanceSafe);
    timelock.execute(address(manager), 0, data, bytes32(0), salt);
    assertTrue(timelock.isOperationReady(id));
    assertFalse(manager.isRecallOperator(guardian));

    // Once replaced, the former Guardian is an ordinary account and the new one is excluded instead.
    vm.startPrank(address(timelock));
    manager.setGuardian(newGuardian);
    manager.setFundingOperator(guardian, true);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, newGuardian));
    manager.setFundingOperator(newGuardian, true);
    vm.stopPrank();
    assertTrue(manager.isFundingOperator(guardian));
  }

  /// @dev `setGuardian` never reverts; it revokes the operator role of the new Guardian, and the role cannot be granted
  /// back while it is the Guardian.
  function test_regression_setGuardian_revokesOperatorRole() public {
    vm.startPrank(address(timelock));
    manager.setGuardian(recallOperator);
    assertEq(manager.guardian(), recallOperator);
    assertFalse(manager.isRecallOperator(recallOperator));

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, recallOperator));
    manager.setFundingOperator(recallOperator, true);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, recallOperator));
    manager.setRecallOperator(recallOperator, true);
    vm.stopPrank();
  }

  function testFuzz_regression_setGuardianNeverLeavesOverlap(address anyGuardian, bool funding, bool recall_) public {
    // The current Guardian cannot be granted an operator role in the first place (OperatorCannotBeGuardian).
    vm.assume(anyGuardian != address(0) && anyGuardian != manager.guardian());
    vm.assume(anyGuardian != fundingOperator && anyGuardian != recallOperator);
    vm.startPrank(address(timelock));
    if (funding) manager.setFundingOperator(anyGuardian, true);
    else if (recall_) manager.setRecallOperator(anyGuardian, true);
    manager.setGuardian(anyGuardian);
    vm.stopPrank();
    assertEq(manager.guardian(), anyGuardian);
    assertFalse(manager.isFundingOperator(anyGuardian));
    assertFalse(manager.isRecallOperator(anyGuardian));
  }

  function testFuzz_regression_guardianNeverGrantedOperatorRole(address anyGuardian) public {
    vm.assume(anyGuardian != address(0) && anyGuardian != fundingOperator && anyGuardian != recallOperator);
    vm.startPrank(address(timelock));
    manager.setGuardian(anyGuardian);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, anyGuardian));
    manager.setFundingOperator(anyGuardian, true);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, anyGuardian));
    manager.setRecallOperator(anyGuardian, true);
    vm.stopPrank();
    assertFalse(manager.isFundingOperator(anyGuardian));
    assertFalse(manager.isRecallOperator(anyGuardian));
  }

  // ================================================================
  // │              Regression: lockdown of address(0)              │
  // ================================================================

  /// @dev Even when the registry maps the token to no pool, address(0) is never a recognized pool.
  function test_regression_lockdown_zeroAddress_revertsPoolNotRecognized() public {
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, address(0)));
    vm.prank(guardian);
    controller.lockdown(address(0));

    registry.setPool(address(token), address(0));
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, address(0)));
    vm.prank(guardian);
    controller.lockdown(address(0));
  }

  // ================================================================
  // │                           Helpers                            │
  // ================================================================

  /// @dev All 11 Guardian functions with arguments under which the Guardian's call succeeds.
  function _guardianCalls() internal view returns (bytes[] memory calls) {
    calls = new bytes[](GUARDIAN_FUNCTION_COUNT);
    calls[0] = abi.encodeCall(LiquidityManager.pauseFunding, ());
    calls[1] = abi.encodeCall(LiquidityManager.pauseRecall, ());
    calls[2] = abi.encodeCall(LiquidityManager.suspendFundingOperator, (fundingOperator));
    calls[3] = abi.encodeCall(LiquidityManager.suspendRecallOperator, (recallOperator));
    calls[4] = abi.encodeCall(LiquidityManager.restrictAdapter, (adapterId, true, true));
    calls[5] = abi.encodeCall(LiquidityManager.revokePoolMigrationApproval, (address(pool)));
    calls[6] = abi.encodeCall(LiquidityManager.reduceMaxFundingPerCall, (MAX_FUNDING_PER_CALL - 1));
    calls[7] = abi.encodeCall(
      LiquidityManager.reduceAggregateFundingBudget, (AGGREGATE_FUNDING_CAPACITY - 1, AGGREGATE_FUNDING_RATE - 1)
    );
    calls[8] = abi.encodeCall(
      LiquidityManager.reducePoolFundingBudget, (address(pool), POOL_FUNDING_CAPACITY - 1, POOL_FUNDING_RATE - 1)
    );
    calls[9] = abi.encodeCall(
      LiquidityManager.reduceRecallLimits, (MAX_RECALL_PER_CALL - 1, RECALL_CAPACITY - 1, RECALL_RATE - 1)
    );
    calls[10] = abi.encodeCall(LiquidityManager.raisePoolMinimum, (address(pool), POOL_MINIMUM + 1));
  }

  /// @dev Every `onlyOwner` function of the Manager (including the inherited `transferOwnership`), with arguments that
  /// would benefit the Guardian.
  function _ownerCalls() internal view returns (bytes[] memory calls) {
    calls = new bytes[](18);
    calls[0] = abi.encodeCall(LiquidityManager.setGuardian, (attacker));
    calls[1] = abi.encodeCall(LiquidityManager.setFundingOperator, (guardian, true));
    calls[2] = abi.encodeCall(LiquidityManager.setRecallOperator, (guardian, true));
    calls[3] = abi.encodeCall(LiquidityManager.setFundingPaused, (false));
    calls[4] = abi.encodeCall(LiquidityManager.setRecallPaused, (false));
    calls[5] = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (type(uint256).max));
    calls[6] = abi.encodeCall(LiquidityManager.setAggregateFundingBudget, (type(uint256).max, type(uint256).max));
    calls[7] =
      abi.encodeCall(LiquidityManager.setPoolFundingBudget, (address(pool), type(uint256).max, type(uint256).max));
    calls[8] =
      abi.encodeCall(LiquidityManager.setRecallLimits, (type(uint256).max, type(uint256).max, type(uint256).max));
    calls[9] = abi.encodeCall(LiquidityManager.setPoolSpec, (address(pool), _poolSpec()));
    calls[10] = abi.encodeCall(LiquidityManager.setPoolThresholds, (address(pool), 0, 0, 0));
    calls[11] = abi.encodeCall(LiquidityManager.setPoolMigrationApproval, (address(pool), otherPool));
    calls[12] = abi.encodeCall(LiquidityManager.registerAdapter, (attacker, otherPool));
    calls[13] = abi.encodeCall(LiquidityManager.replaceAdapter, (adapterId, attacker));
    calls[14] = abi.encodeCall(LiquidityManager.setAdapterStatus, (adapterId, true, true));
    calls[15] = abi.encodeCall(LiquidityManager.migrateReserves, (guardian, MANAGER_RESERVES));
    calls[16] = abi.encodeCall(LiquidityManager.recoverToken, (otherPool, guardian, 1));
    calls[17] = abi.encodeWithSignature("transferOwnership(address)", guardian);
  }

  function _nonGuardianCallers() internal view returns (address[] memory callers) {
    callers = new address[](10);
    callers[0] = attacker;
    callers[1] = address(timelock);
    callers[2] = governanceSafe;
    callers[3] = fundingOperator;
    callers[4] = recallOperator;
    callers[5] = address(controller);
    callers[6] = address(adapter);
    callers[7] = address(pool);
    callers[8] = treasury;
    callers[9] = newGuardian;
  }

  /// @dev Encodes a call to one of the 33 mutating Manager functions from fuzzed arguments.
  function _encodeManagerCall(uint256 index, address addr, uint256 u1, uint256 u2, uint256 u3, bool b1, bool b2)
    internal
    view
    returns (bytes memory)
  {
    index = index % MANAGER_MUTATING_FUNCTION_COUNT;
    address poolArg = b2 ? address(pool) : addr;
    uint256 idArg = b2 ? adapterId : u1;
    if (index == 0) return abi.encodeCall(LiquidityManager.fund, (idArg, u2));
    if (index == 1) return abi.encodeCall(LiquidityManager.recall, (idArg, u2));
    if (index == 2) return abi.encodeCall(LiquidityManager.pauseFunding, ());
    if (index == 3) return abi.encodeCall(LiquidityManager.pauseRecall, ());
    if (index == 4) return abi.encodeCall(LiquidityManager.suspendFundingOperator, (addr));
    if (index == 5) return abi.encodeCall(LiquidityManager.suspendRecallOperator, (addr));
    if (index == 6) return abi.encodeCall(LiquidityManager.restrictAdapter, (idArg, b1, b2));
    if (index == 7) return abi.encodeCall(LiquidityManager.revokePoolMigrationApproval, (poolArg));
    if (index == 8) return abi.encodeCall(LiquidityManager.reduceMaxFundingPerCall, (u1));
    if (index == 9) return abi.encodeCall(LiquidityManager.reduceAggregateFundingBudget, (u1, u2));
    if (index == 10) return abi.encodeCall(LiquidityManager.reducePoolFundingBudget, (poolArg, u1, u2));
    if (index == 11) return abi.encodeCall(LiquidityManager.reduceRecallLimits, (u1, u2, u3));
    if (index == 12) return abi.encodeCall(LiquidityManager.raisePoolMinimum, (poolArg, u1));
    if (index == 13) return abi.encodeCall(LiquidityManager.setGuardian, (addr));
    if (index == 14) return abi.encodeCall(LiquidityManager.setFundingOperator, (addr, b1));
    if (index == 15) return abi.encodeCall(LiquidityManager.setRecallOperator, (addr, b1));
    if (index == 16) return abi.encodeCall(LiquidityManager.setFundingPaused, (b1));
    if (index == 17) return abi.encodeCall(LiquidityManager.setRecallPaused, (b1));
    if (index == 18) return abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (u1));
    if (index == 19) return abi.encodeCall(LiquidityManager.setAggregateFundingBudget, (u1, u2));
    if (index == 20) return abi.encodeCall(LiquidityManager.setPoolFundingBudget, (poolArg, u1, u2));
    if (index == 21) return abi.encodeCall(LiquidityManager.setRecallLimits, (u1, u2, u3));
    if (index == 22) return abi.encodeCall(LiquidityManager.setPoolSpec, (poolArg, _poolSpec()));
    if (index == 23) return abi.encodeCall(LiquidityManager.setPoolThresholds, (poolArg, u1, u2, u3));
    if (index == 24) {
      return abi.encodeCall(LiquidityManager.setPoolMigrationApproval, (poolArg, b1 ? addr : otherPool));
    }
    if (index == 25) return abi.encodeCall(LiquidityManager.registerAdapter, (addr, poolArg));
    if (index == 26) return abi.encodeCall(LiquidityManager.replaceAdapter, (idArg, addr));
    if (index == 27) return abi.encodeCall(LiquidityManager.setAdapterStatus, (idArg, b1, b2));
    if (index == 28) return abi.encodeCall(LiquidityManager.migrateReserves, (addr, u1));
    if (index == 29) return abi.encodeCall(LiquidityManager.recoverToken, (b1 ? address(token) : addr, addr, u1));
    if (index == 30) return abi.encodeWithSignature("transferOwnership(address)", addr);
    if (index == 31) return abi.encodeWithSignature("renounceOwnership()");
    return abi.encodeWithSignature("acceptOwnership()");
  }

  /// @dev Everything a compromised Guardian can do at once.
  function _restrictEverything(address actor) internal {
    vm.startPrank(actor);
    manager.pauseFunding();
    manager.pauseRecall();
    manager.suspendFundingOperator(fundingOperator);
    manager.suspendRecallOperator(recallOperator);
    manager.restrictAdapter(adapterId, true, true);
    manager.revokePoolMigrationApproval(address(pool));
    manager.reduceMaxFundingPerCall(0);
    manager.reduceAggregateFundingBudget(0, 0);
    manager.reducePoolFundingBudget(address(pool), 0, 0);
    manager.reduceRecallLimits(0, 0, 0);
    manager.raisePoolMinimum(address(pool), type(uint256).max);
    controller.lockdown(address(pool));
    vm.stopPrank();
  }

  /// @dev topic0 of the configuration event each entry of `_guardianCalls()` emits after `GuardianAction`.
  function _guardianConfigEventTopics() internal pure returns (bytes32[] memory topics) {
    topics = new bytes32[](GUARDIAN_FUNCTION_COUNT);
    topics[0] = ILiquidityManager.FundingPausedSet.selector;
    topics[1] = ILiquidityManager.RecallPausedSet.selector;
    topics[2] = ILiquidityManager.FundingOperatorSet.selector;
    topics[3] = ILiquidityManager.RecallOperatorSet.selector;
    topics[4] = ILiquidityManager.AdapterStatusSet.selector;
    topics[5] = ILiquidityManager.PoolMigrationApprovalSet.selector;
    topics[6] = ILiquidityManager.MaxFundingPerCallSet.selector;
    topics[7] = ILiquidityManager.AggregateFundingBudgetSet.selector;
    topics[8] = ILiquidityManager.PoolFundingBudgetSet.selector;
    topics[9] = ILiquidityManager.RecallLimitsSet.selector;
    topics[10] = ILiquidityManager.PoolThresholdsSet.selector;
  }

  function _expectGuardianAction(address actor, bytes4 selector) internal {
    _expectGuardianAction(manager, actor, selector);
  }

  function _expectGuardianAction(LiquidityManager target, address actor, bytes4 selector) internal {
    vm.expectEmit(address(target));
    emit ILiquidityManager.GuardianAction(actor, selector);
  }

  /// @dev Calls the Manager as `actor` and asserts the logs are exactly
  /// [GuardianAction(actor, selector), configuration event].
  function _assertGuardianActionLogs(address actor, bytes memory data, bytes32 configTopic) internal {
    vm.recordLogs();
    vm.prank(actor);
    (bool ok, bytes memory ret) = address(manager).call(data);
    assertTrue(ok, string(abi.encodePacked("guardian call failed: ", vm.toString(ret))));
    Vm.Log[] memory logs = vm.getRecordedLogs();
    assertEq(logs.length, 2, "expected exactly GuardianAction then one configuration event");

    assertEq(logs[0].emitter, address(manager));
    assertEq(logs[0].topics.length, 3);
    assertEq(logs[0].topics[0], ILiquidityManager.GuardianAction.selector, "first log is not GuardianAction");
    assertEq(logs[0].topics[1], bytes32(uint256(uint160(actor))), "GuardianAction guardian");
    assertEq(logs[0].topics[2], bytes32(bytes4(data)), "GuardianAction selector");
    assertEq(logs[0].data.length, 0);

    assertEq(logs[1].emitter, address(manager));
    assertEq(logs[1].topics[0], configTopic, "second log is not the configuration event");
  }

  function _assertBudget(ILiquidityManager.BudgetState memory state, uint256 capacity, uint256 rate, uint256 available)
    internal
    pure
  {
    assertEq(state.capacity, capacity, "capacity");
    assertEq(state.rate, rate, "rate");
    assertEq(state.available, available, "available");
  }

  /// @dev A second pool replica wired like the fixture pool (owned by the Timelock, adapter as rebalancer, controller
  /// as rate limit admin), but not mapped in the TokenAdminRegistry.
  function _deployReplacementPool() internal returns (MockLockReleaseTokenPool newPool, CCIPPoolAdapter newAdapter) {
    newPool = new MockLockReleaseTokenPool(address(token), router);
    newPool.addChain(
      REMOTE_CHAIN_SELECTOR,
      abi.encode(REMOTE_TOKEN),
      abi.encode(REMOTE_POOL),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
    newAdapter = new CCIPPoolAdapter(address(manager), address(token), address(newPool));
    newPool.setRebalancer(address(newAdapter));
    newPool.setRateLimitAdmin(address(controller));
    newPool.transferOwnership(address(timelock));
  }

  /// @dev Registers the replacement pool under a migration approval bound to the fixture pool (the registry pool).
  function _registerReplacementPool(MockLockReleaseTokenPool newPool, CCIPPoolAdapter newAdapter)
    internal
    returns (uint256 newId)
  {
    vm.startPrank(address(timelock));
    manager.setPoolSpec(address(newPool), _poolSpec());
    manager.setPoolThresholds(address(newPool), 0, 0, 0);
    manager.setPoolFundingBudget(address(newPool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    // Without the approval the replacement cannot be registered while the registry maps the token to the old pool.
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(newPool), address(pool))
    );
    manager.registerAdapter(address(newAdapter), address(newPool));
    manager.setPoolMigrationApproval(address(newPool), address(pool));
    newId = manager.registerAdapter(address(newAdapter), address(newPool));
    vm.stopPrank();
  }

  function _restoreLimitsAsOwner() internal {
    vm.startPrank(address(timelock));
    manager.setMaxFundingPerCall(MAX_FUNDING_PER_CALL);
    manager.setAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    manager.setPoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    manager.setRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE);
    manager.setPoolThresholds(address(pool), POOL_MINIMUM, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET);
    vm.stopPrank();
  }

  /// @dev Timelock batch undoing `_restrictEverything`, including the pool lockdown (as pool owner).
  function _restorationBatch()
    internal
    view
    returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
  {
    targets = new address[](11);
    values = new uint256[](11);
    payloads = new bytes[](11);
    for (uint256 i = 0; i < 10; ++i) {
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
    payloads[10] = abi.encodeCall(
      MockLockReleaseTokenPool.setChainRateLimiterConfig,
      (REMOTE_CHAIN_SELECTOR, _ccipBucket(CCIP_CAPACITY, CCIP_RATE), _ccipBucket(CCIP_CAPACITY, CCIP_RATE))
    );
  }

  function _scheduleCancellable(string memory label) internal returns (bytes32 id, bytes memory data, bytes32 salt) {
    data = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (MAX_FUNDING_PER_CALL * 2));
    salt = keccak256(bytes(label));
    id = _schedule(address(manager), data, bytes32(0), salt);
    assertTrue(timelock.isOperationPending(id));
  }

  function _scheduleCancellableBatch(string memory label)
    internal
    returns (bytes32 id, address[] memory targets, uint256[] memory values, bytes[] memory payloads, bytes32 salt)
  {
    targets = new address[](2);
    values = new uint256[](2);
    payloads = new bytes[](2);
    targets[0] = address(manager);
    targets[1] = address(manager);
    payloads[0] = abi.encodeCall(LiquidityManager.setFundingOperator, (attacker, true));
    payloads[1] = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (type(uint256).max));
    salt = keccak256(bytes(label));
    vm.prank(governanceSafe);
    timelock.scheduleBatch(targets, values, payloads, bytes32(0), salt, TIMELOCK_DELAY);
    id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), salt);
    assertTrue(timelock.isOperationPending(id));
  }

  function _assertControllerPowersRevoked(
    address caller,
    bytes32 id,
    bytes memory data,
    bytes32 salt,
    bytes32 batchId,
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory payloads,
    bytes32 batchSalt
  ) internal {
    bytes memory notGuardian = abi.encodeWithSelector(GuardianController.CallerNotGuardian.selector, caller);
    _assertReverts(
      caller,
      address(controller),
      abi.encodeCall(GuardianController.cancel, (address(manager), 0, data, bytes32(0), salt)),
      notGuardian
    );
    _assertReverts(
      caller,
      address(controller),
      abi.encodeCall(GuardianController.cancelBatch, (targets, values, payloads, bytes32(0), batchSalt)),
      notGuardian
    );
    _assertReverts(
      caller, address(controller), abi.encodeCall(GuardianController.lockdown, (address(pool))), notGuardian
    );
    assertTrue(timelock.isOperationPending(id), "single op cancelled");
    assertTrue(timelock.isOperationPending(batchId), "batch op cancelled");
    (bool enabled, uint128 capacity, uint128 rate) = pool.outboundConfig(REMOTE_CHAIN_SELECTOR);
    assertTrue(enabled);
    assertEq(capacity, CCIP_CAPACITY, "pool locked down");
    assertEq(rate, CCIP_RATE);
  }

  function _assertPoolLockedDown() internal view {
    _assertPoolRateLimits(0, 0);
  }

  function _assertPoolRateLimits(uint128 capacity, uint128 rate) internal view {
    (bool outEnabled, uint128 outCapacity, uint128 outRate) = pool.outboundConfig(REMOTE_CHAIN_SELECTOR);
    assertTrue(outEnabled);
    assertEq(outCapacity, capacity);
    assertEq(outRate, rate);
    (bool inEnabled, uint128 inCapacity, uint128 inRate) = pool.inboundConfig(REMOTE_CHAIN_SELECTOR);
    assertTrue(inEnabled);
    assertEq(inCapacity, capacity);
    assertEq(inRate, rate);
  }

  /// @dev Owner-only: rejects the Guardian, an operator and an outsider with `OwnableUnauthorizedAccount`.
  function _assertOwnerOnly(bytes memory data) internal {
    address[3] memory callers = [guardian, fundingOperator, attacker];
    for (uint256 i = 0; i < callers.length; ++i) {
      _assertReverts(
        callers[i],
        address(manager),
        data,
        abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i])
      );
    }
  }

  function _assertReverts(address caller, address target, bytes memory data, bytes memory expected) internal {
    vm.prank(caller);
    (bool ok, bytes memory ret) = target.call(data);
    assertFalse(ok, "call unexpectedly succeeded");
    assertEq(ret, expected, "unexpected revert data");
  }

  function _assertBucketNotLoosened(
    ILiquidityManager.BudgetState memory afterState,
    ILiquidityManager.BudgetState memory before
  ) internal pure {
    assertLe(afterState.capacity, before.capacity, "capacity raised");
    assertLe(afterState.rate, before.rate, "rate raised");
    assertLe(afterState.available, before.available, "available raised");
  }

  function _snapshot() internal view returns (Snapshot memory s) {
    s.owner = manager.owner();
    s.pendingOwner = manager.pendingOwner();
    s.guardian = manager.guardian();
    s.fundingPaused = manager.fundingPaused();
    s.recallPaused = manager.recallPaused();
    s.fundingOperatorEnabled = manager.isFundingOperator(fundingOperator);
    s.recallOperatorEnabled = manager.isRecallOperator(recallOperator);
    s.adapterEntry = manager.getAdapter(adapterId);
    s.migrationSource = manager.getPoolMigrationSource(address(pool));
    s.maxFundingPerCall = manager.maxFundingPerCall();
    s.maxRecallPerCall = manager.maxRecallPerCall();
    s.thresholds = _thresholds(address(pool));
    s.aggregate = manager.getAggregateFundingBudget();
    s.poolBudget = manager.getPoolFundingBudget(address(pool));
    s.recallBudget = manager.getRecallBudget();
    s.managerBalance = _balance(address(manager));
    s.poolBalance = _balance(address(pool));
    s.adapterBalance = _balance(address(adapter));
    s.poolOwner = pool.owner();
    s.poolRebalancer = pool.getRebalancer();
    s.poolRateLimitAdmin = pool.getRateLimitAdmin();
    s.tokenOwner = token.owner();
    s.registryAdministrator = registry.getTokenConfig(address(token)).administrator;
    s.registryPendingAdministrator = registry.getTokenConfig(address(token)).pendingAdministrator;
    s.registryPool = registry.getPool(address(token));
    s.adapterHistoryLength = manager.getAdapterHistory().length;
  }

  /// @dev `getPoolThresholds` returns `(thresholds, isSet)`; most assertions only need the thresholds.
  function _thresholds(address anyPool) internal view returns (ILiquidityManager.PoolThresholds memory thresholds) {
    (thresholds,) = manager.getPoolThresholds(anyPool);
  }

  function _min(uint256 a, uint256 b) internal pure returns (uint256) {
    return a < b ? a : b;
  }
}
