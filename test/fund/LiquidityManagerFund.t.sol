// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Vm} from "forge-std/Vm.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";

import {FundBase} from "test/fund/FundBase.sol";

/// @notice Unit tests for `LiquidityManager.fund`: access control, pause, adapter lookup and status, amount and
/// per-call checks, the funding budgets, token-level failures, events and balance conservation.
contract LiquidityManagerFundTest is FundBase {
  uint256 internal constant AMOUNT = 10_000_000e18;

  // ================================================================
  // │                          Happy path                          │
  // ================================================================

  function test_fund_movesExactAmountFromManagerToPool() public {
    uint256 managerBefore = _balance(address(manager));
    uint256 poolBefore = _balance(address(pool));
    uint256 recallBudgetBefore = manager.getRecallBudget().available;

    _fund(AMOUNT);

    assertEq(_balance(address(manager)), managerBefore - AMOUNT, "manager");
    assertEq(_balance(address(pool)), poolBefore + AMOUNT, "pool");
    assertEq(_balance(address(adapter)), 0, "adapter");
    assertEq(token.allowance(address(adapter), address(pool)), 0, "allowance");
    assertEq(_aggregateAvailable(), AGGREGATE_FUNDING_CAPACITY - AMOUNT, "aggregate budget");
    assertEq(_poolAvailable(address(pool)), POOL_FUNDING_CAPACITY - AMOUNT, "pool budget");
    assertEq(manager.getRecallBudget().available, recallBudgetBefore, "recall budget untouched");
  }

  function test_fund_emitsLiquidityAddedThenFunded() public {
    vm.expectEmit(true, true, false, true, address(pool));
    emit MockLockReleaseTokenPool.LiquidityAdded(address(adapter), AMOUNT);
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Funded(adapterId, address(pool), fundingOperator, address(adapter), AMOUNT);
    _fund(AMOUNT);
  }

  function test_fund_fundedEventCarriesOperatorAndAdapterOfTheCall() public {
    address secondOperator = makeAddr("secondOperator");
    vm.prank(address(timelock));
    manager.setFundingOperator(secondOperator, true);

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Funded(adapterId, address(pool), secondOperator, address(adapter), 1);
    _fundAs(secondOperator, adapterId, 1);
  }

  /// @dev The only SAHARA transfers are Manager -> adapter and adapter -> pool, both of exactly `amount`; the adapter
  /// approves exactly `amount` and resets it to zero; `Funded` is the last log.
  function test_fund_tokenFlowIsManagerToAdapterToPoolOnly() public {
    vm.recordLogs();
    _fund(AMOUNT);
    Vm.Log[] memory logs = vm.getRecordedLogs();

    uint256 transfers;
    uint256 approvals;
    for (uint256 i = 0; i < logs.length; ++i) {
      if (logs[i].emitter != address(token)) continue;
      if (logs[i].topics[0] == keccak256("Transfer(address,address,uint256)")) {
        (address from, address to, uint256 value) = _decodeTransferLike(logs[i]);
        assertEq(from, transfers == 0 ? address(manager) : address(adapter), "transfer from");
        assertEq(to, transfers == 0 ? address(adapter) : address(pool), "transfer to");
        assertEq(value, AMOUNT, "transfer value");
        ++transfers;
      } else if (logs[i].topics[0] == keccak256("Approval(address,address,uint256)")) {
        (address owner, address spender, uint256 value) = _decodeTransferLike(logs[i]);
        assertEq(owner, address(adapter), "approval owner");
        assertEq(spender, address(pool), "approval spender");
        assertEq(value, approvals == 0 ? AMOUNT : 0, "approval value");
        ++approvals;
      }
    }
    assertEq(transfers, 2, "transfer count");
    assertEq(approvals, 2, "approval count");

    Vm.Log memory last = logs[logs.length - 1];
    assertEq(last.emitter, address(manager), "last emitter");
    assertEq(last.topics[0], ILiquidityManager.Funded.selector, "last event");
  }

  function test_fund_canSpendTheEntireManagerBalance() public {
    vm.prank(address(timelock));
    manager.migrateReserves(treasury, MANAGER_RESERVES - AMOUNT);
    assertEq(_balance(address(manager)), AMOUNT);

    _fund(AMOUNT);
    assertEq(_balance(address(manager)), 0);
  }

  // ================================================================
  // │                        Access control                        │
  // ================================================================

  function test_fund_revertsWhen_callerIsNotAnOperator() public {
    _expectFundRevert(
      attacker, adapterId, AMOUNT, abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, attacker)
    );
  }

  function test_fund_revertsWhen_callerIsRecallOperator() public {
    _expectFundRevert(
      recallOperator,
      adapterId,
      AMOUNT,
      abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, recallOperator)
    );
  }

  function test_fund_revertsWhen_callerIsGuardian() public {
    _expectFundRevert(
      guardian, adapterId, AMOUNT, abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, guardian)
    );
  }

  function test_fund_revertsWhen_callerIsOwner() public {
    _expectFundRevert(
      address(timelock),
      adapterId,
      AMOUNT,
      abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, address(timelock))
    );
  }

  function test_fund_revertsWhen_callerIsGovernanceSafe() public {
    _expectFundRevert(
      governanceSafe,
      adapterId,
      AMOUNT,
      abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, governanceSafe)
    );
  }

  function test_fund_revertsWhen_callerIsControllerAdapterOrPool() public {
    address[3] memory callers = [address(controller), address(adapter), address(pool)];
    for (uint256 i = 0; i < callers.length; ++i) {
      _expectFundRevert(
        callers[i],
        adapterId,
        AMOUNT,
        abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, callers[i])
      );
    }
  }

  function test_fund_revertsWhen_operatorSuspendedByGuardian() public {
    vm.prank(guardian);
    manager.suspendFundingOperator(fundingOperator);
    _expectFundRevert(
      fundingOperator,
      adapterId,
      AMOUNT,
      abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, fundingOperator)
    );
  }

  function test_fund_revertsWhen_operatorRevokedByOwner() public {
    vm.prank(address(timelock));
    manager.setFundingOperator(fundingOperator, false);
    _expectFundRevert(
      fundingOperator,
      adapterId,
      AMOUNT,
      abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, fundingOperator)
    );
  }

  function test_fund_succeedsAfterOwnerReinstatesSuspendedOperator() public {
    vm.prank(guardian);
    manager.suspendFundingOperator(fundingOperator);
    vm.prank(address(timelock));
    manager.setFundingOperator(fundingOperator, true);
    _fund(AMOUNT);
  }

  /// @dev The role check comes first: an outsider learns nothing about pause, adapter or amount state.
  function test_fund_roleCheckPrecedesEveryOtherCheck() public {
    vm.prank(guardian);
    manager.pauseFunding();
    _expectFundRevert(
      attacker, 0, 0, abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, attacker)
    );
  }

  function testFuzz_fund_revertsForAnyNonOperator(address caller, uint256 amount) public {
    vm.assume(caller != fundingOperator);
    _expectFundRevert(
      caller, adapterId, amount, abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, caller)
    );
  }

  // ================================================================
  // │                            Pause                             │
  // ================================================================

  function test_fund_revertsWhen_pausedByGuardian() public {
    vm.prank(guardian);
    manager.pauseFunding();
    _expectFundRevert(
      fundingOperator, adapterId, AMOUNT, abi.encodeWithSelector(ILiquidityManager.FundingIsPaused.selector)
    );
  }

  function test_fund_revertsWhen_pausedByOwner() public {
    vm.prank(address(timelock));
    manager.setFundingPaused(true);
    _expectFundRevert(
      fundingOperator, adapterId, AMOUNT, abi.encodeWithSelector(ILiquidityManager.FundingIsPaused.selector)
    );
  }

  function test_fund_succeedsAfterOwnerUnpauses() public {
    vm.prank(guardian);
    manager.pauseFunding();
    vm.prank(address(timelock));
    manager.setFundingPaused(false);
    _fund(AMOUNT);
  }

  function test_fund_pauseCheckPrecedesAdapterLookup() public {
    vm.prank(guardian);
    manager.pauseFunding();
    _expectFundRevert(fundingOperator, 0, 0, abi.encodeWithSelector(ILiquidityManager.FundingIsPaused.selector));
  }

  function test_fund_notBlockedByRecallPause() public {
    vm.prank(guardian);
    manager.pauseRecall();
    _fund(AMOUNT);
  }

  // ================================================================
  // │                   Adapter lookup and status                  │
  // ================================================================

  function test_fund_revertsWhen_adapterIdIsZero() public {
    _expectFundRevert(fundingOperator, 0, AMOUNT, abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 0));
  }

  function test_fund_revertsWhen_adapterIdIsBeyondCount() public {
    uint256 next = manager.adapterCount() + 1;
    _expectFundRevert(
      fundingOperator, next, AMOUNT, abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, next)
    );
  }

  function test_fund_revertsWhen_adapterIdIsMax() public {
    _expectFundRevert(
      fundingOperator,
      type(uint256).max,
      AMOUNT,
      abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, type(uint256).max)
    );
  }

  function testFuzz_fund_revertsForUnknownAdapterId(uint256 id) public {
    if (id != 0) id = bound(id, manager.adapterCount() + 1, type(uint256).max);
    _expectFundRevert(
      fundingOperator, id, AMOUNT, abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, id)
    );
  }

  function test_fund_revertsWhen_fundingDisabledByGuardian() public {
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, true, false);
    _expectFundRevert(
      fundingOperator, adapterId, AMOUNT, abi.encodeWithSelector(ILiquidityManager.FundingDisabled.selector, adapterId)
    );
  }

  function test_fund_revertsWhen_fundingDisabledByOwner() public {
    vm.prank(address(timelock));
    manager.setAdapterStatus(adapterId, false, true);
    _expectFundRevert(
      fundingOperator, adapterId, AMOUNT, abi.encodeWithSelector(ILiquidityManager.FundingDisabled.selector, adapterId)
    );
  }

  function test_fund_notBlockedByRecallDisabled() public {
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, false, true);
    _fund(AMOUNT);
  }

  function test_fund_succeedsAfterOwnerReenablesAdapter() public {
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, true, true);
    vm.prank(address(timelock));
    manager.setAdapterStatus(adapterId, true, true);
    _fund(AMOUNT);
  }

  function test_fund_disabledCheckPrecedesAmountChecks() public {
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, true, false);
    _expectFundRevert(
      fundingOperator, adapterId, 0, abi.encodeWithSelector(ILiquidityManager.FundingDisabled.selector, adapterId)
    );
  }

  /// @dev Disabling one adapter does not affect another pool's adapter.
  function test_fund_disablingOneAdapterLeavesOthersFundable() public {
    (,, uint256 secondId) = _deployHonestPool(true);
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, true, false);
    _fundAs(fundingOperator, secondId, AMOUNT);
  }

  // ================================================================
  // │                    Amount and per-call limit                 │
  // ================================================================

  function test_fund_revertsWhen_amountIsZero() public {
    _expectFundRevert(fundingOperator, adapterId, 0, abi.encodeWithSelector(ILiquidityManager.ZeroAmount.selector));
  }

  function test_fund_zeroAmountCheckPrecedesPerCallLimit() public {
    vm.prank(address(timelock));
    manager.setMaxFundingPerCall(0);
    _expectFundRevert(fundingOperator, adapterId, 0, abi.encodeWithSelector(ILiquidityManager.ZeroAmount.selector));
  }

  function test_fund_atPerCallLimit_succeeds() public {
    _fund(MAX_FUNDING_PER_CALL);
    assertEq(_poolAvailable(address(pool)), POOL_FUNDING_CAPACITY - MAX_FUNDING_PER_CALL);
  }

  function test_fund_revertsWhen_oneAbovePerCallLimit() public {
    _expectFundRevert(
      fundingOperator,
      adapterId,
      MAX_FUNDING_PER_CALL + 1,
      abi.encodeWithSelector(
        ILiquidityManager.ExceedsPerCallLimit.selector, MAX_FUNDING_PER_CALL + 1, MAX_FUNDING_PER_CALL
      )
    );
  }

  function test_fund_revertsWhen_perCallLimitIsZero() public {
    vm.prank(address(timelock));
    manager.setMaxFundingPerCall(0);
    _expectFundRevert(
      fundingOperator, adapterId, 1, abi.encodeWithSelector(ILiquidityManager.ExceedsPerCallLimit.selector, 1, 0)
    );
  }

  function test_fund_respectsGuardianReducedPerCallLimit() public {
    uint256 reduced = 1_000_000e18;
    vm.prank(guardian);
    manager.reduceMaxFundingPerCall(reduced);
    _expectFundRevert(
      fundingOperator,
      adapterId,
      reduced + 1,
      abi.encodeWithSelector(ILiquidityManager.ExceedsPerCallLimit.selector, reduced + 1, reduced)
    );
    _fund(reduced);
  }

  function test_fund_respectsOwnerRaisedPerCallLimit() public {
    uint256 raised = 40_000_000e18;
    vm.prank(address(timelock));
    manager.setMaxFundingPerCall(raised);
    _fund(raised);
    assertEq(_poolAvailable(address(pool)), POOL_FUNDING_CAPACITY - raised);
  }

  /// @dev The per-call limit is checked before the external pool verification.
  function test_fund_perCallLimitPrecedesPoolVerification() public {
    vm.prank(address(timelock));
    pool.setRouter(attacker);
    _expectFundRevert(
      fundingOperator,
      adapterId,
      MAX_FUNDING_PER_CALL + 1,
      abi.encodeWithSelector(
        ILiquidityManager.ExceedsPerCallLimit.selector, MAX_FUNDING_PER_CALL + 1, MAX_FUNDING_PER_CALL
      )
    );
  }

  function testFuzz_fund_revertsAbovePerCallLimit(uint256 amount) public {
    amount = bound(amount, MAX_FUNDING_PER_CALL + 1, type(uint256).max);
    _expectFundRevert(
      fundingOperator,
      adapterId,
      amount,
      abi.encodeWithSelector(ILiquidityManager.ExceedsPerCallLimit.selector, amount, MAX_FUNDING_PER_CALL)
    );
  }

  // ================================================================
  // │                      Per-pool budget                         │
  // ================================================================

  function test_fund_poolBudget_exhaustion() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);
    assertEq(_poolAvailable(address(pool)), 0);
    // The aggregate still has 50M, so the per-pool bucket is the one that fails.
    assertEq(_aggregateAvailable(), AGGREGATE_FUNDING_CAPACITY - 2 * MAX_FUNDING_PER_CALL);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_poolBudget_refillsLinearlyOverTime() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);

    vm.warp(block.timestamp + 1 hours);
    uint256 refilled = 1 hours * POOL_FUNDING_RATE;
    assertEq(_poolAvailable(address(pool)), refilled);

    _expectFundRevert(fundingOperator, adapterId, MAX_FUNDING_PER_CALL, _budgetExceeded(MAX_FUNDING_PER_CALL, refilled));
    _expectFundRevert(fundingOperator, adapterId, refilled + 1, _budgetExceeded(refilled + 1, refilled));
    _fund(refilled);
    assertEq(_poolAvailable(address(pool)), 0);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_poolBudget_refillPerSecond() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);

    vm.warp(block.timestamp + 1);
    assertEq(_poolAvailable(address(pool)), POOL_FUNDING_RATE);
    _expectFundRevert(
      fundingOperator, adapterId, POOL_FUNDING_RATE + 1, _budgetExceeded(POOL_FUNDING_RATE + 1, POOL_FUNDING_RATE)
    );
    _fund(POOL_FUNDING_RATE);
  }

  /// @dev `rate = capacity / 1 days` is floored, so the bucket is just short of capacity after exactly one day and
  /// capped at capacity one second later.
  function test_fund_poolBudget_refillReachesCapacityOnlyWhenDeficitCovered() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);

    vm.warp(block.timestamp + 1 days);
    assertEq(_poolAvailable(address(pool)), 1 days * POOL_FUNDING_RATE);
    assertLt(_poolAvailable(address(pool)), POOL_FUNDING_CAPACITY);

    vm.warp(block.timestamp + 1);
    assertEq(_poolAvailable(address(pool)), POOL_FUNDING_CAPACITY);
  }

  function test_fund_poolBudget_refillCappedAtCapacity() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);

    vm.warp(block.timestamp + 30 days);
    assertEq(_poolAvailable(address(pool)), POOL_FUNDING_CAPACITY);
    // Only one capacity's worth can be funded however long the pause was.
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_poolBudget_unconfiguredBlocksFunding() public {
    (MockLockReleaseTokenPool second,, uint256 secondId) = _deployHonestPool(false);
    ILiquidityManager.BudgetState memory budget = manager.getPoolFundingBudget(address(second));
    assertEq(budget.capacity, 0);
    assertEq(budget.available, 0);
    _expectFundRevert(fundingOperator, secondId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_poolBudget_firstConfigurationStartsFull() public {
    (MockLockReleaseTokenPool second,, uint256 secondId) = _deployHonestPool(false);
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(second), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    assertEq(_poolAvailable(address(second)), POOL_FUNDING_CAPACITY);

    _fundAs(fundingOperator, secondId, MAX_FUNDING_PER_CALL);
    _fundAs(fundingOperator, secondId, MAX_FUNDING_PER_CALL);
    _expectFundRevert(fundingOperator, secondId, 1, _budgetExceeded(1, 0));
  }

  /// @dev Design decision 3: only the first configuration starts full. A bucket first configured at zero stays empty
  /// when raised later and then refills at the new rate.
  function test_fund_poolBudget_firstConfiguredAtZeroStaysEmptyWhenRaised() public {
    (MockLockReleaseTokenPool second,, uint256 secondId) = _deployHonestPool(false);
    vm.startPrank(address(timelock));
    manager.setPoolFundingBudget(address(second), 0, 0);
    manager.setPoolFundingBudget(address(second), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    vm.stopPrank();

    assertEq(_poolAvailable(address(second)), 0);
    _expectFundRevert(fundingOperator, secondId, 1, _budgetExceeded(1, 0));

    vm.warp(block.timestamp + 1 hours);
    assertEq(_poolAvailable(address(second)), 1 hours * POOL_FUNDING_RATE);
    _fundAs(fundingOperator, secondId, 1 hours * POOL_FUNDING_RATE);
  }

  /// @dev The Guardian's restriction-only `reducePoolFundingBudget(p, 0, 0)` on a never-configured bucket is accepted
  /// (0/0 is not above the current 0/0) and still emits `GuardianAction` and the configuration event, but leaves the
  /// bucket uninitialized: funding stays blocked, and the owner's later first configuration still starts full.
  function test_regression_fund_poolBudget_guardianReductionOfUnconfiguredBucketKeepsFirstConfigurationFull() public {
    (MockLockReleaseTokenPool second,, uint256 secondId) = _deployHonestPool(false);

    vm.expectEmit(true, true, false, true, address(manager));
    emit ILiquidityManager.GuardianAction(guardian, manager.reducePoolFundingBudget.selector);
    vm.expectEmit(true, false, false, true, address(manager));
    emit ILiquidityManager.PoolFundingBudgetSet(address(second), 0, 0);
    vm.prank(guardian);
    manager.reducePoolFundingBudget(address(second), 0, 0);

    ILiquidityManager.BudgetState memory budget = manager.getPoolFundingBudget(address(second));
    assertEq(budget.capacity, 0, "capacity");
    assertEq(budget.rate, 0, "rate");
    assertEq(budget.available, 0, "available");
    _expectFundRevert(fundingOperator, secondId, 1, _budgetExceeded(1, 0));
    vm.warp(block.timestamp + 365 days);
    _expectFundRevert(fundingOperator, secondId, 1, _budgetExceeded(1, 0));

    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(second), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    assertEq(_poolAvailable(address(second)), POOL_FUNDING_CAPACITY, "first configuration starts full");

    _fundAs(fundingOperator, secondId, MAX_FUNDING_PER_CALL);
    _fundAs(fundingOperator, secondId, MAX_FUNDING_PER_CALL);
    _expectFundRevert(fundingOperator, secondId, 1, _budgetExceeded(1, 0));
  }

  /// @dev On a never-configured bucket the Guardian can still only "reduce" to 0/0.
  function test_fund_poolBudget_guardianCannotRaiseUnconfiguredBucket() public {
    (MockLockReleaseTokenPool second,,) = _deployHonestPool(false);
    vm.startPrank(guardian);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.NotARestriction.selector));
    manager.reducePoolFundingBudget(address(second), 1, 0);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.NotARestriction.selector));
    manager.reducePoolFundingBudget(address(second), 0, 1);
    vm.stopPrank();
  }

  /// @dev Once configured, a Guardian reduction does apply, and the owner's later reconfiguration does not restore it.
  function test_fund_poolBudget_guardianReductionAfterFirstConfigurationIsNotUndoneByOwner() public {
    (MockLockReleaseTokenPool second,, uint256 secondId) = _deployHonestPool(true);
    vm.prank(guardian);
    manager.reducePoolFundingBudget(address(second), 0, 0);
    assertEq(_poolAvailable(address(second)), 0);

    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(second), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    assertEq(_poolAvailable(address(second)), 0, "reconfiguration does not refill");
    _expectFundRevert(fundingOperator, secondId, 1, _budgetExceeded(1, 0));

    vm.warp(block.timestamp + 1 hours);
    assertEq(_poolAvailable(address(second)), 1 hours * POOL_FUNDING_RATE);
    _fundAs(fundingOperator, secondId, 1 hours * POOL_FUNDING_RATE);
  }

  function test_fund_poolBudget_ownerRaisingCapacityDoesNotAddTokens() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(5_000_000e18);
    uint256 remaining = POOL_FUNDING_CAPACITY - MAX_FUNDING_PER_CALL - 5_000_000e18;
    assertEq(_poolAvailable(address(pool)), remaining);

    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(pool), 10 * POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);

    ILiquidityManager.BudgetState memory budget = manager.getPoolFundingBudget(address(pool));
    assertEq(budget.capacity, 10 * POOL_FUNDING_CAPACITY);
    assertEq(budget.available, remaining);
    _expectFundRevert(fundingOperator, adapterId, remaining + 1, _budgetExceeded(remaining + 1, remaining));
    _fund(remaining);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_poolBudget_ownerRaisingCapacityWhenExhaustedDoesNotAddTokens() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(pool), 10 * POOL_FUNDING_CAPACITY, 10 * POOL_FUNDING_RATE);
    assertEq(_poolAvailable(address(pool)), 0);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_poolBudget_ownerLoweringCapacityCapsAvailable() public {
    _fund(AMOUNT); // 40M left
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(pool), 15_000_000e18, POOL_FUNDING_RATE);
    assertEq(_poolAvailable(address(pool)), 15_000_000e18);
    _expectFundRevert(fundingOperator, adapterId, 15_000_000e18 + 1, _budgetExceeded(15_000_000e18 + 1, 15_000_000e18));
  }

  /// @dev Time elapsed before a reconfiguration refills at the old rate; the new rate applies only afterwards.
  function test_fund_poolBudget_rateChangeAppliesFromReconfiguration() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);

    vm.warp(block.timestamp + 100);
    uint256 newRate = 10 * POOL_FUNDING_RATE;
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY, newRate);
    assertEq(_poolAvailable(address(pool)), 100 * POOL_FUNDING_RATE);

    vm.warp(block.timestamp + 10);
    uint256 expected = 100 * POOL_FUNDING_RATE + 10 * newRate;
    assertEq(_poolAvailable(address(pool)), expected);
    _expectFundRevert(fundingOperator, adapterId, expected + 1, _budgetExceeded(expected + 1, expected));
    _fund(expected);
  }

  function test_fund_poolBudget_zeroRateNeverRefills() public {
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY, 0);
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);
    vm.warp(block.timestamp + 365 days);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_poolBudget_guardianReductionAppliesImmediately() public {
    uint256 reduced = 10_000_000e18;
    vm.prank(guardian);
    manager.reducePoolFundingBudget(address(pool), reduced, POOL_FUNDING_RATE);
    _expectFundRevert(fundingOperator, adapterId, reduced + 1, _budgetExceeded(reduced + 1, reduced));
    _fund(reduced);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_poolBudgets_areIndependentPerPool() public {
    (MockLockReleaseTokenPool second,, uint256 secondId) = _deployHonestPool(true);
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);
    assertEq(_poolAvailable(address(second)), POOL_FUNDING_CAPACITY, "second pool budget untouched");

    _fundAs(fundingOperator, secondId, MAX_FUNDING_PER_CALL);
    assertEq(_poolAvailable(address(second)), POOL_FUNDING_CAPACITY - MAX_FUNDING_PER_CALL);
    assertEq(_poolAvailable(address(pool)), 0);
  }

  // ================================================================
  // │                      Aggregate budget                        │
  // ================================================================

  function test_fund_aggregateBudget_exhaustion() public {
    uint256 aggregate = 30_000_000e18;
    vm.prank(address(timelock));
    manager.setAggregateFundingBudget(aggregate, AGGREGATE_FUNDING_RATE);
    assertEq(_aggregateAvailable(), aggregate);

    _fund(MAX_FUNDING_PER_CALL);
    uint256 left = aggregate - MAX_FUNDING_PER_CALL;
    // The pool bucket still has 25M, so the aggregate bucket is the one that fails.
    _expectFundRevert(fundingOperator, adapterId, MAX_FUNDING_PER_CALL, _budgetExceeded(MAX_FUNDING_PER_CALL, left));
    _expectFundRevert(fundingOperator, adapterId, left + 1, _budgetExceeded(left + 1, left));
    _fund(left);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_aggregateBudget_sharedAcrossPools() public {
    vm.prank(address(timelock));
    manager.setAggregateFundingBudget(60_000_000e18, AGGREGATE_FUNDING_RATE);
    (MockLockReleaseTokenPool second,, uint256 secondId) = _deployHonestPool(true);

    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);
    _fundAs(fundingOperator, secondId, 10_000_000e18);
    assertEq(_aggregateAvailable(), 0);
    assertEq(_poolAvailable(address(second)), POOL_FUNDING_CAPACITY - 10_000_000e18);

    _expectFundRevert(fundingOperator, secondId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_aggregateBudget_refillsOverTime() public {
    vm.prank(address(timelock));
    manager.setAggregateFundingBudget(MAX_FUNDING_PER_CALL, AGGREGATE_FUNDING_RATE);
    _fund(MAX_FUNDING_PER_CALL);

    vm.warp(block.timestamp + 1 hours);
    uint256 refilled = 1 hours * AGGREGATE_FUNDING_RATE;
    assertEq(_aggregateAvailable(), refilled);
    _expectFundRevert(fundingOperator, adapterId, refilled + 1, _budgetExceeded(refilled + 1, refilled));
    _fund(refilled);

    vm.warp(block.timestamp + 30 days);
    assertEq(_aggregateAvailable(), MAX_FUNDING_PER_CALL, "capped at capacity");
  }

  /// @dev The aggregate bucket is consumed before the per-pool bucket; whichever is short fails with its own numbers.
  function test_fund_aggregateCheckedBeforePoolBudget() public {
    vm.prank(address(timelock));
    manager.setAggregateFundingBudget(60_000_000e18, AGGREGATE_FUNDING_RATE);
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);
    // aggregate 10M, pool 0
    _expectFundRevert(fundingOperator, adapterId, 20_000_000e18, _budgetExceeded(20_000_000e18, 10_000_000e18));
    _expectFundRevert(fundingOperator, adapterId, 5_000_000e18, _budgetExceeded(5_000_000e18, 0));
  }

  function test_fund_aggregateBudget_ownerRaisingCapacityDoesNotAddTokens() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);
    uint256 left = AGGREGATE_FUNDING_CAPACITY - 2 * MAX_FUNDING_PER_CALL;

    vm.prank(address(timelock));
    manager.setAggregateFundingBudget(10 * AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    ILiquidityManager.BudgetState memory budget = manager.getAggregateFundingBudget();
    assertEq(budget.capacity, 10 * AGGREGATE_FUNDING_CAPACITY);
    assertEq(budget.available, left);

    // A fresh pool with a large first-configured (full) budget is still bounded by what is left in the aggregate.
    (MockLockReleaseTokenPool second,, uint256 secondId) = _deployHonestPool(false);
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(second), 10 * POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    _fundAs(fundingOperator, secondId, MAX_FUNDING_PER_CALL);
    _fundAs(fundingOperator, secondId, left - MAX_FUNDING_PER_CALL);
    _expectFundRevert(fundingOperator, secondId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_aggregateBudget_guardianReductionAppliesImmediately() public {
    uint256 reduced = 10_000_000e18;
    vm.prank(guardian);
    manager.reduceAggregateFundingBudget(reduced, AGGREGATE_FUNDING_RATE);
    _expectFundRevert(fundingOperator, adapterId, reduced + 1, _budgetExceeded(reduced + 1, reduced));
    _fund(reduced);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_aggregateBudget_zeroCapacityBlocksFunding() public {
    vm.prank(guardian);
    manager.reduceAggregateFundingBudget(0, 0);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
    vm.warp(block.timestamp + 365 days);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
  }

  // ================================================================
  // │                Budgets are never reset or restored           │
  // ================================================================

  function test_fund_recallDoesNotRestoreFundingBudgets() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);
    uint256 aggregateLeft = _aggregateAvailable();

    _recall(MAX_FUNDING_PER_CALL);
    _recall(MAX_FUNDING_PER_CALL);

    assertEq(_poolAvailable(address(pool)), 0, "pool budget");
    assertEq(_aggregateAvailable(), aggregateLeft, "aggregate budget");
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_replaceAdapterDoesNotResetPoolBudget() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);

    CCIPPoolAdapter replacement = new CCIPPoolAdapter(address(manager), address(token), address(pool));
    vm.startPrank(address(timelock));
    pool.setRebalancer(address(replacement));
    manager.replaceAdapter(adapterId, address(replacement));
    vm.stopPrank();

    assertEq(_poolAvailable(address(pool)), 0);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));

    vm.warp(block.timestamp + 1 hours);
    uint256 refilled = 1 hours * POOL_FUNDING_RATE;
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Funded(adapterId, address(pool), fundingOperator, address(replacement), refilled);
    _fund(refilled);
    assertEq(_balance(address(replacement)), 0);
  }

  function test_fund_guardianRestrictAndOwnerRestoreDoNotResetUsage() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);

    vm.prank(guardian);
    manager.restrictAdapter(adapterId, true, true);
    vm.prank(address(timelock));
    manager.setAdapterStatus(adapterId, true, true);
    vm.prank(guardian);
    manager.pauseFunding();
    vm.prank(address(timelock));
    manager.setFundingPaused(false);

    assertEq(_poolAvailable(address(pool)), 0);
    _expectFundRevert(fundingOperator, adapterId, 1, _budgetExceeded(1, 0));
  }

  function test_fund_failedFundDoesNotConsumeBudget() public {
    Snapshot memory before = _snapshot(address(adapter), address(pool));
    vm.prank(address(timelock));
    pool.setRouter(attacker);
    _expectFundRevert(
      fundingOperator,
      adapterId,
      AMOUNT,
      abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, address(pool), attacker)
    );
    _assertUnchanged(before, address(adapter), address(pool));
  }

  // ================================================================
  // │                Token-level failures and dust                 │
  // ================================================================

  /// @dev The token owner (the Timelock after handover) can pause SAHARA, which blocks funding at the first transfer.
  function test_fund_revertsWhen_tokenPaused() public {
    assertEq(token.owner(), address(timelock), "token owned by the Timelock");
    vm.prank(address(timelock));
    token.pause();
    Snapshot memory before = _snapshot(address(adapter), address(pool));
    _expectFundRevert(fundingOperator, adapterId, AMOUNT, abi.encodeWithSelector(Pausable.EnforcedPause.selector));
    _assertUnchanged(before, address(adapter), address(pool));
  }

  function test_fund_succeedsAfterTokenUnpaused() public {
    vm.prank(address(timelock));
    token.pause();
    _expectFundRevert(fundingOperator, adapterId, AMOUNT, abi.encodeWithSelector(Pausable.EnforcedPause.selector));
    vm.prank(address(timelock));
    token.unpause();
    _fund(AMOUNT);
  }

  function test_fund_revertsWhen_managerReservesInsufficient() public {
    vm.prank(address(timelock));
    manager.migrateReserves(treasury, MANAGER_RESERVES - 1e18);
    _expectFundRevert(
      fundingOperator,
      adapterId,
      2e18,
      abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(manager), 1e18, 2e18)
    );
  }

  function test_fund_revertsWhen_adapterAllowanceNonZeroAtEntry() public {
    vm.prank(address(adapter));
    token.approve(address(pool), 7);
    Snapshot memory before = _snapshot(address(adapter), address(pool));
    _expectFundRevert(
      fundingOperator, adapterId, AMOUNT, abi.encodeWithSelector(ILiquidityManager.NonZeroAllowance.selector, 7)
    );
    _assertUnchanged(before, address(adapter), address(pool));
  }

  function test_fund_unsolicitedAdapterBalanceDoesNotBlockAndIsUntouched() public {
    uint256 dust = 1_234_567e18;
    _seed(address(adapter), dust);
    uint256 managerBefore = _balance(address(manager));
    uint256 poolBefore = _balance(address(pool));

    _fund(AMOUNT);
    _fund(AMOUNT);

    assertEq(_balance(address(adapter)), dust, "adapter dust untouched");
    assertEq(_balance(address(manager)), managerBefore - 2 * AMOUNT);
    assertEq(_balance(address(pool)), poolBefore + 2 * AMOUNT);
    assertEq(token.allowance(address(adapter), address(pool)), 0);
  }

  function test_fund_unsolicitedPoolBalanceDoesNotAffectFunding() public {
    _seed(address(pool), 777e18);
    uint256 poolBefore = _balance(address(pool));
    _fund(AMOUNT);
    assertEq(_balance(address(pool)), poolBefore + AMOUNT);
  }

  // ================================================================
  // │                            Fuzz                              │
  // ================================================================

  function testFuzz_fund_conservesBalancesAndLeavesAdapterUntouched(uint256 amount, uint256 dust) public {
    amount = bound(amount, 1, MAX_FUNDING_PER_CALL);
    dust = bound(dust, 0, 1_000_000_000e18);
    _seed(address(adapter), dust);

    uint256 managerBefore = _balance(address(manager));
    uint256 poolBefore = _balance(address(pool));
    uint256 aggregateBefore = _aggregateAvailable();
    uint256 poolBudgetBefore = _poolAvailable(address(pool));

    _fund(amount);

    assertEq(_balance(address(manager)), managerBefore - amount, "manager");
    assertEq(_balance(address(pool)), poolBefore + amount, "pool");
    assertEq(_balance(address(manager)) + _balance(address(pool)), managerBefore + poolBefore, "conservation");
    assertEq(_balance(address(adapter)), dust, "adapter");
    assertEq(token.allowance(address(adapter), address(pool)), 0, "allowance");
    assertEq(_aggregateAvailable(), aggregateBefore - amount, "aggregate budget");
    assertEq(_poolAvailable(address(pool)), poolBudgetBefore - amount, "pool budget");
  }

  function testFuzz_fund_twoFundsWithinBudgetConserve(uint256 a, uint256 b, uint256 dt) public {
    a = bound(a, 1, MAX_FUNDING_PER_CALL);
    b = bound(b, 1, MAX_FUNDING_PER_CALL);
    dt = bound(dt, 0, 7 days);
    uint256 total = _balance(address(manager)) + _balance(address(pool));

    _fund(a);
    vm.warp(block.timestamp + dt);
    _fund(b); // 25M + 25M <= 50M pool capacity, so the second always fits

    assertEq(_balance(address(manager)) + _balance(address(pool)), total);
    assertEq(_balance(address(adapter)), 0);
    assertEq(token.allowance(address(adapter), address(pool)), 0);
  }

  struct ModelBucket {
    uint256 capacity;
    uint256 rate;
    uint256 tokens;
    uint256 lastUpdated;
  }

  /// @dev Drives a random sequence of time steps and fund amounts against randomly configured budgets and checks every
  /// outcome (and every revert's numbers) against an independent capacity/refill model. The aggregate bucket was first
  /// configured full in setUp, so its reconfiguration keeps min(current, new capacity); the fresh pool's first
  /// configuration starts full.
  function testFuzz_fund_budgetsMatchReferenceModel(
    uint256 aggregateCapacity,
    uint256 aggregateRate,
    uint256 poolCapacity,
    uint256 poolRate,
    uint256 seed
  ) public {
    aggregateCapacity = bound(aggregateCapacity, 0, 200_000_000e18);
    aggregateRate = bound(aggregateRate, 0, 10_000e18);
    poolCapacity = bound(poolCapacity, 0, 200_000_000e18);
    poolRate = bound(poolRate, 0, 10_000e18);

    (MockLockReleaseTokenPool second,, uint256 secondId) = _deployHonestPool(false);
    vm.startPrank(address(timelock));
    manager.setAggregateFundingBudget(aggregateCapacity, aggregateRate);
    manager.setPoolFundingBudget(address(second), poolCapacity, poolRate);
    vm.stopPrank();

    ModelBucket memory agg = ModelBucket(
      aggregateCapacity, aggregateRate, _min(AGGREGATE_FUNDING_CAPACITY, aggregateCapacity), block.timestamp
    );
    ModelBucket memory pl = ModelBucket(poolCapacity, poolRate, poolCapacity, block.timestamp);

    for (uint256 i = 0; i < 16; ++i) {
      uint256 r = uint256(keccak256(abi.encode(seed, i)));
      vm.warp(block.timestamp + (r % 4 == 0 ? 0 : (r >> 8) % 2 days));
      uint256 amount = 1 + ((r >> 128) % MAX_FUNDING_PER_CALL);
      _stepModel(agg, pl, address(second), secondId, amount);
    }
  }

  function _stepModel(ModelBucket memory agg, ModelBucket memory pl, address p, uint256 id, uint256 amount) internal {
    uint256 aggAvailable = _modelAvailable(agg);
    uint256 poolAvailable = _modelAvailable(pl);
    assertEq(_aggregateAvailable(), aggAvailable, "aggregate available");
    assertEq(_poolAvailable(p), poolAvailable, "pool available");

    if (amount > aggAvailable) {
      _expectFundRevert(fundingOperator, id, amount, _budgetExceeded(amount, aggAvailable));
    } else if (amount > poolAvailable) {
      _expectFundRevert(fundingOperator, id, amount, _budgetExceeded(amount, poolAvailable));
    } else {
      uint256 poolBalanceBefore = _balance(p);
      _fundAs(fundingOperator, id, amount);
      assertEq(_balance(p), poolBalanceBefore + amount, "pool balance");
      agg.tokens = aggAvailable - amount;
      agg.lastUpdated = block.timestamp;
      pl.tokens = poolAvailable - amount;
      pl.lastUpdated = block.timestamp;
    }
  }

  function _modelAvailable(ModelBucket memory b) internal view returns (uint256) {
    return _min(b.capacity, b.tokens + (block.timestamp - b.lastUpdated) * b.rate);
  }

  function _decodeTransferLike(Vm.Log memory log) internal pure returns (address a, address b, uint256 value) {
    a = address(uint160(uint256(log.topics[1])));
    b = address(uint160(uint256(log.topics[2])));
    value = abi.decode(log.data, (uint256));
  }
}
