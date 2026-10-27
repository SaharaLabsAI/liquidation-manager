// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {LiquidityManager} from "src/LiquidityManager.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {TokenBucket} from "src/libraries/TokenBucket.sol";

import {BaseTest} from "test/utils/BaseTest.sol";

import {TokenBucketHarness} from "test/adapter-invariant/mocks/TokenBucketHarness.sol";

/// @notice Fuzz tests of the capacity/refill budget used for the aggregate, per-pool and recall budgets. Expected
/// values come from an independent reference that uses overflow-checked arithmetic instead of the library's
/// division-based saturation.
contract TokenBucketTest is Test {
  uint256 internal constant MAX = type(uint256).max;
  uint256 internal constant START = 1_700_000_000;
  /// @dev Upper bound for warps: far beyond any realistic horizon, small enough for the EVM timestamp.
  uint256 internal constant MAX_WARP = type(uint64).max;

  TokenBucketHarness internal bucket;

  function setUp() public {
    vm.warp(START);
    bucket = new TokenBucketHarness();
  }

  // ================================================================
  // │                        Uninitialized                         │
  // ================================================================

  function testFuzz_uninitialized_isEmptyForever(uint256 dt, uint256 amount) public {
    dt = bound(dt, 0, MAX_WARP);
    amount = bound(amount, 1, MAX);
    assertEq(bucket.available(), 0);
    vm.warp(block.timestamp + dt);
    assertEq(bucket.available(), 0);
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, amount, 0));
    bucket.consume(amount);
  }

  function testFuzz_uninitialized_consumeZeroDoesNotInitialize(uint256 capacity, uint256 rate) public {
    bucket.consume(0);
    assertFalse(bucket.raw().initialized);
    bucket.setConfig(capacity, rate);
    assertEq(bucket.available(), capacity, "first configuration still starts full");
  }

  // ================================================================
  // │                     First configuration                      │
  // ================================================================

  function testFuzz_firstSetConfigStartsFull(uint256 capacity, uint256 rate, uint256 start, uint256 dt) public {
    start = bound(start, 0, MAX_WARP);
    dt = bound(dt, 0, MAX_WARP);
    vm.warp(start);
    bucket.setConfig(capacity, rate);

    TokenBucket.Bucket memory state = bucket.raw();
    assertTrue(state.initialized);
    assertEq(state.capacity, capacity);
    assertEq(state.rate, rate);
    assertEq(state.tokens, capacity);
    assertEq(state.lastUpdated, start);
    assertEq(bucket.available(), capacity);

    vm.warp(start + dt);
    assertEq(bucket.available(), capacity, "a full bucket stays at capacity");
  }

  // ================================================================
  // │                            Refill                            │
  // ================================================================

  function testFuzz_availableMatchesReference(uint256 capacity, uint256 rate, uint256 consumed, uint256 dt) public {
    consumed = bound(consumed, 0, capacity);
    dt = bound(dt, 0, MAX_WARP);
    bucket.setConfig(capacity, rate);
    bucket.consume(consumed);
    vm.warp(block.timestamp + dt);

    uint256 available = bucket.available();
    assertEq(available, _refillRef(capacity, capacity - consumed, dt, rate));
    assertLe(available, capacity);
  }

  function testFuzz_refillIsLinearAndMonotonicUntilCapped(uint256 capacity, uint256 rate, uint256 dt1, uint256 dt2)
    public
  {
    capacity = bound(capacity, 1, MAX);
    rate = bound(rate, 1, type(uint128).max);
    dt1 = bound(dt1, 0, MAX_WARP);
    dt2 = bound(dt2, dt1, MAX_WARP);
    bucket.setConfig(capacity, rate);
    bucket.consume(capacity);
    uint256 t0 = block.timestamp;

    vm.warp(t0 + dt1);
    uint256 a1 = bucket.available();
    vm.warp(t0 + dt2);
    uint256 a2 = bucket.available();

    assertLe(a1, a2, "refill is monotonic");
    assertLe(a2, capacity);
    // rate <= 2^128 and dt <= 2^64, so the products below fit.
    if (a2 < capacity) {
      assertEq(a2, dt2 * rate, "linear refill");
      assertEq(a2 - a1, (dt2 - dt1) * rate, "linear increments");
    } else {
      assertGe(dt2 * rate, capacity, "capped only once the deficit is refilled");
    }
  }

  function testFuzz_refillReachesCapacityExactlyOnTime(uint256 capacity, uint256 rate, uint256 consumed) public {
    capacity = bound(capacity, 1, type(uint128).max);
    rate = bound(rate, 1, type(uint64).max);
    consumed = bound(consumed, 1, capacity);
    bucket.setConfig(capacity, rate);
    bucket.consume(consumed);
    uint256 t0 = block.timestamp;

    uint256 needed = (consumed + rate - 1) / rate; // ceil(deficit / rate)
    vm.warp(t0 + needed - 1);
    assertEq(bucket.available(), capacity - consumed + (needed - 1) * rate, "one second early");
    assertLt(bucket.available(), capacity);
    vm.warp(t0 + needed);
    assertEq(bucket.available(), capacity, "full on time");
  }

  function testFuzz_rateZeroNeverRefills(uint256 capacity, uint256 consumed, uint256 dt) public {
    consumed = bound(consumed, 0, capacity);
    dt = bound(dt, 0, MAX_WARP);
    bucket.setConfig(capacity, 0);
    bucket.consume(consumed);
    vm.warp(block.timestamp + dt);
    assertEq(bucket.available(), capacity - consumed);
  }

  function testFuzz_zeroCapacityIsAlwaysEmpty(uint256 rate, uint256 dt, uint256 amount) public {
    dt = bound(dt, 0, MAX_WARP);
    amount = bound(amount, 1, MAX);
    bucket.setConfig(0, rate);
    vm.warp(block.timestamp + dt);
    assertEq(bucket.available(), 0);
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, amount, 0));
    bucket.consume(amount);
    bucket.consume(0);
  }

  // ================================================================
  // │                           consume                            │
  // ================================================================

  function testFuzz_consumeRevertsExactlyWhenAboveAvailable(
    uint256 capacity,
    uint256 rate,
    uint256 consumed,
    uint256 dt,
    uint256 amount
  ) public {
    consumed = bound(consumed, 0, capacity);
    dt = bound(dt, 0, MAX_WARP);
    bucket.setConfig(capacity, rate);
    bucket.consume(consumed);
    vm.warp(block.timestamp + dt);
    uint256 available = bucket.available();

    if (amount > available) {
      TokenBucket.Bucket memory before = bucket.raw();
      vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, amount, available));
      bucket.consume(amount);
      TokenBucket.Bucket memory afterRevert = bucket.raw();
      assertEq(afterRevert.tokens, before.tokens);
      assertEq(afterRevert.lastUpdated, before.lastUpdated);
    } else {
      bucket.consume(amount);
      TokenBucket.Bucket memory state = bucket.raw();
      assertEq(state.tokens, available - amount);
      assertEq(state.lastUpdated, block.timestamp);
      assertEq(bucket.available(), available - amount);
    }
  }

  function testFuzz_consumeExactlyAvailableThenOneMoreReverts(uint256 capacity, uint256 rate) public {
    capacity = bound(capacity, 1, MAX);
    rate = bound(rate, 0, MAX);
    bucket.setConfig(capacity, rate);
    bucket.consume(capacity);
    assertEq(bucket.available(), 0);
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1, 0));
    bucket.consume(1);
  }

  function testFuzz_refillRestartsFromLastConsumption(
    uint256 capacity,
    uint256 rate,
    uint256 c1,
    uint256 dt1,
    uint256 c2,
    uint256 dt2
  ) public {
    dt1 = bound(dt1, 0, 30 days);
    dt2 = bound(dt2, 0, 30 days);
    bucket.setConfig(capacity, rate);
    c1 = bound(c1, 0, capacity);
    bucket.consume(c1);

    vm.warp(block.timestamp + dt1);
    uint256 mid = _refillRef(capacity, capacity - c1, dt1, rate);
    c2 = bound(c2, 0, mid);
    bucket.consume(c2);

    vm.warp(block.timestamp + dt2);
    assertEq(bucket.available(), _refillRef(capacity, mid - c2, dt2, rate));
  }

  // ================================================================
  // │                       Reconfiguration                        │
  // ================================================================

  function testFuzz_reconfigureNeverRestoresUsage(
    uint256 capacity,
    uint256 rate,
    uint256 consumed,
    uint256 dt,
    uint256 newCapacity,
    uint256 newRate
  ) public {
    consumed = bound(consumed, 0, capacity);
    dt = bound(dt, 0, MAX_WARP);
    bucket.setConfig(capacity, rate);
    bucket.consume(consumed);
    vm.warp(block.timestamp + dt);
    uint256 refilled = bucket.available();

    bucket.setConfig(newCapacity, newRate);

    TokenBucket.Bucket memory state = bucket.raw();
    uint256 expected = Math.min(refilled, newCapacity);
    assertTrue(state.initialized);
    assertEq(state.capacity, newCapacity);
    assertEq(state.rate, newRate);
    assertEq(state.tokens, expected, "tokens = min(refilled, new capacity)");
    assertEq(state.lastUpdated, block.timestamp);
    assertEq(bucket.available(), expected);
    assertLe(bucket.available(), refilled, "reconfiguration never adds tokens");
  }

  function testFuzz_raisingCapacityDoesNotRefill(uint256 capacity, uint256 extra, uint256 consumed, uint256 rate)
    public
  {
    capacity = bound(capacity, 0, MAX / 2);
    extra = bound(extra, 0, MAX / 2);
    consumed = bound(consumed, 0, capacity);
    bucket.setConfig(capacity, rate);
    bucket.consume(consumed);
    bucket.setConfig(capacity + extra, rate);
    assertEq(bucket.available(), capacity - consumed);
  }

  function testFuzz_reconfigureRefillsElapsedTimeUnderOldRate(
    uint256 capacity,
    uint256 oldRate,
    uint256 newRate,
    uint256 dt1,
    uint256 dt2
  ) public {
    dt1 = bound(dt1, 0, MAX_WARP);
    dt2 = bound(dt2, 0, MAX_WARP);
    bucket.setConfig(capacity, oldRate);
    bucket.consume(capacity);

    vm.warp(block.timestamp + dt1);
    bucket.setConfig(capacity, newRate);
    uint256 atSwitch = _refillRef(capacity, 0, dt1, oldRate);
    assertEq(bucket.available(), atSwitch, "time before the switch refills under the old rate");

    vm.warp(block.timestamp + dt2);
    assertEq(bucket.available(), _refillRef(capacity, atSwitch, dt2, newRate), "new rate applies afterwards");
  }

  function testFuzz_reconfigureInSameBlockAfterExhaustionStaysEmpty(uint256 capacity, uint256 rate, uint256 newCap)
    public
  {
    bucket.setConfig(capacity, rate);
    bucket.consume(capacity);
    bucket.setConfig(newCap, rate);
    assertEq(bucket.available(), 0);
  }

  // ================================================================
  // │                       Extreme values                         │
  // ================================================================

  function testFuzz_extremeValuesNeverRevert(uint256 consumed, uint256 dt, uint256 seedCap, uint256 seedRate) public {
    dt = bound(dt, 0, MAX_WARP);
    bucket.setConfig(MAX, MAX);
    bucket.consume(consumed);
    assertEq(bucket.available(), MAX - consumed);

    vm.warp(block.timestamp + dt);
    uint256 available = bucket.available();
    assertEq(available, dt == 0 ? MAX - consumed : MAX);
    bucket.consume(available);
    assertEq(bucket.available(), 0);

    vm.warp(block.timestamp + dt);
    bucket.setConfig(MAX, seedRate);
    bucket.setConfig(seedCap, MAX);
    assertLe(bucket.available(), seedCap);
    vm.warp(block.timestamp + 1);
    assertEq(bucket.available(), seedCap, "rate MAX refills any deficit within a second");
    bucket.setConfig(MAX, MAX);
    assertLe(bucket.available(), MAX);
  }

  function testFuzz_hugeRateSmallCapacityCapsImmediately(uint256 capacity, uint256 consumed, uint256 dt) public {
    consumed = bound(consumed, 0, capacity);
    dt = bound(dt, 1, MAX_WARP);
    bucket.setConfig(capacity, MAX);
    bucket.consume(consumed);
    vm.warp(block.timestamp + dt);
    assertEq(bucket.available(), capacity);
  }

  function testFuzz_maxCapacitySlowRateRefillsLinearly(uint256 dt, uint256 rate) public {
    dt = bound(dt, 0, MAX_WARP);
    rate = bound(rate, 1, type(uint128).max);
    bucket.setConfig(MAX, rate);
    bucket.consume(MAX);
    vm.warp(block.timestamp + dt);
    assertEq(bucket.available(), dt * rate);
  }

  function test_maxTimestampDoesNotOverflow() public {
    bucket.setConfig(MAX, MAX);
    bucket.consume(MAX);
    vm.warp(MAX);
    assertEq(bucket.available(), MAX);
    bucket.consume(MAX - 1);
    bucket.setConfig(MAX - 1, MAX - 1);
    assertEq(bucket.available(), 1);
  }

  // ================================================================
  // │                Envelope and model equivalence                │
  // ================================================================

  /// @notice Over any sub-window [t_i, t_j] of a fixed configuration, successful consumption is bounded by
  /// capacity + rate * (t_j - t_i).
  function testFuzz_consumptionWithinAnyWindowIsBounded(
    uint256 capacity,
    uint256 rate,
    uint256[16] memory dts,
    uint256[16] memory amounts
  ) public {
    capacity = bound(capacity, 0, 1e30);
    rate = bound(rate, 0, 1e26);
    bucket.setConfig(capacity, rate);

    uint256[16] memory times;
    uint256[16] memory consumed;
    for (uint256 i = 0; i < 16; ++i) {
      vm.warp(block.timestamp + bound(dts[i], 0, 2 days));
      uint256 amount = amounts[i] % 3 == 0 ? bucket.available() : bound(amounts[i], 0, capacity + 1);
      times[i] = block.timestamp;
      try bucket.consume(amount) {
        consumed[i] = amount;
      } catch {}
      assertLe(bucket.available(), capacity);
    }
    for (uint256 i = 0; i < 16; ++i) {
      uint256 sum;
      for (uint256 j = i; j < 16; ++j) {
        sum += consumed[j];
        assertLe(sum, Math.saturatingAdd(capacity, Math.saturatingMul(rate, times[j] - times[i])), "window bound");
      }
    }
  }

  struct Model {
    bool initialized;
    uint256 capacity;
    uint256 rate;
    uint256 tokens;
    uint256 lastUpdated;
  }

  /// @notice Differential test: random sequences of warps, consumptions and reconfigurations against a reference
  /// model written from the specification.
  function testFuzz_matchesReferenceModel(uint256[16] memory kinds, uint256[16] memory xs, uint256[16] memory ys)
    public
  {
    Model memory model;
    for (uint256 i = 0; i < 16; ++i) {
      uint256 kind = kinds[i] % 3;
      if (kind == 0) {
        vm.warp(block.timestamp + bound(xs[i], 0, 3 days));
      } else if (kind == 1) {
        uint256 modelAvailable = _modelAvailable(model);
        uint256 amount = ys[i] % 2 == 0 ? bound(xs[i], 0, modelAvailable) : _value(xs[i]);
        if (amount > modelAvailable) {
          vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, amount, modelAvailable));
          bucket.consume(amount);
        } else {
          bucket.consume(amount);
          model.tokens = modelAvailable - amount;
          model.lastUpdated = block.timestamp;
        }
      } else {
        uint256 capacity = _value(xs[i]);
        uint256 rate = _value(ys[i]);
        bucket.setConfig(capacity, rate);
        model.tokens = model.initialized ? Math.min(_modelAvailable(model), capacity) : capacity;
        model.initialized = true;
        model.capacity = capacity;
        model.rate = rate;
        model.lastUpdated = block.timestamp;
      }

      uint256 available = bucket.available();
      assertEq(available, _modelAvailable(model), "available");
      assertLe(available, model.capacity, "available <= capacity");
      TokenBucket.Bucket memory state = bucket.raw();
      assertEq(state.initialized, model.initialized);
      if (model.initialized) {
        assertEq(state.capacity, model.capacity);
        assertEq(state.rate, model.rate);
      }
    }
  }

  // ================================================================
  // │                           Helpers                            │
  // ================================================================

  /// @dev Independent reference: min(capacity, tokens + elapsed * rate) with overflow treated as "above capacity".
  function _refillRef(uint256 capacity, uint256 tokens, uint256 elapsed, uint256 rate) internal pure returns (uint256) {
    (bool mulOk, uint256 added) = Math.tryMul(elapsed, rate);
    if (!mulOk) return capacity;
    (bool addOk, uint256 total) = Math.tryAdd(tokens, added);
    if (!addOk || total > capacity) return capacity;
    return total;
  }

  function _modelAvailable(Model memory model) internal view returns (uint256) {
    if (!model.initialized) return 0;
    return _refillRef(model.capacity, model.tokens, block.timestamp - model.lastUpdated, model.rate);
  }

  /// @dev Mixes realistic magnitudes with extremes.
  function _value(uint256 seed) internal pure returns (uint256) {
    uint256 kind = seed % 5;
    if (kind == 0) return 0;
    if (kind == 1) return MAX - (seed % 1000);
    if (kind == 2) return seed;
    return bound(seed, 1, 1e30);
  }
}

/// @notice Bucket semantics as wired into the Manager.
contract ManagerBucketWiringTest is BaseTest {
  address internal newPool = makeAddr("newPool");

  function test_ownerFirstPoolBudgetStartsFull() public {
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(newPool, 10e18, 1e18);
    ILiquidityManager.BudgetState memory state = manager.getPoolFundingBudget(newPool);
    assertEq(state.available, 10e18);
  }

  /// @notice Regression: a Guardian (0, 0) reduction of a never-configured bucket is accepted (it restricts nothing)
  /// and still emits `GuardianAction` followed by the configuration event, but leaves the bucket uninitialized, so the
  /// owner's first configuration starts full rather than empty.
  function test_regression_guardianZeroReductionBeforeFirstOwnerConfig_ownerConfigStartsFull() public {
    vm.expectEmit(true, true, false, true, address(manager));
    emit ILiquidityManager.GuardianAction(guardian, LiquidityManager.reducePoolFundingBudget.selector);
    vm.expectEmit(true, false, false, true, address(manager));
    emit ILiquidityManager.PoolFundingBudgetSet(newPool, 0, 0);
    vm.prank(guardian);
    manager.reducePoolFundingBudget(newPool, 0, 0);
    _assertEmptyBudget(manager.getPoolFundingBudget(newPool));

    vm.warp(block.timestamp + 3 days);
    _assertEmptyBudget(manager.getPoolFundingBudget(newPool));

    vm.prank(address(timelock));
    manager.setPoolFundingBudget(newPool, 10e18, 1e18);
    assertEq(manager.getPoolFundingBudget(newPool).available, 10e18, "first owner configuration starts full");

    vm.warp(block.timestamp + 4);
    assertEq(manager.getPoolFundingBudget(newPool).available, 10e18, "stays at capacity");
  }

  /// @notice Regression: the same holds for the aggregate funding budget and the recall budget of a Manager whose
  /// owner has configured nothing yet.
  function test_regression_guardianZeroReductionOfUnconfiguredAggregateAndRecall_ownerConfigStartsFull() public {
    LiquidityManager fresh = new LiquidityManager(address(token), registry, address(timelock), guardian);

    vm.startPrank(guardian);
    vm.expectEmit(true, true, false, true, address(fresh));
    emit ILiquidityManager.GuardianAction(guardian, LiquidityManager.reduceAggregateFundingBudget.selector);
    vm.expectEmit(false, false, false, true, address(fresh));
    emit ILiquidityManager.AggregateFundingBudgetSet(0, 0);
    fresh.reduceAggregateFundingBudget(0, 0);
    vm.expectEmit(true, true, false, true, address(fresh));
    emit ILiquidityManager.GuardianAction(guardian, LiquidityManager.reduceRecallLimits.selector);
    vm.expectEmit(false, false, false, true, address(fresh));
    emit ILiquidityManager.RecallLimitsSet(0, 0, 0);
    fresh.reduceRecallLimits(0, 0, 0);
    vm.stopPrank();
    _assertEmptyBudget(fresh.getAggregateFundingBudget());
    _assertEmptyBudget(fresh.getRecallBudget());

    vm.warp(block.timestamp + 1 days);
    vm.startPrank(address(timelock));
    fresh.setAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    fresh.setRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE);
    vm.stopPrank();
    assertEq(fresh.getAggregateFundingBudget().available, AGGREGATE_FUNDING_CAPACITY);
    assertEq(fresh.getRecallBudget().available, RECALL_CAPACITY);
  }

  /// @notice Regression: any sequence of Guardian (0, 0) reductions of a never-configured bucket, at any times, leaves
  /// the owner's first configuration starting full.
  function testFuzz_regression_guardianReductionsNeverInitializeUnconfiguredBucket(
    uint8 reductions,
    uint256 dt,
    uint256 capacity,
    uint256 rate
  ) public {
    reductions = uint8(bound(reductions, 1, 8));
    dt = bound(dt, 0, 30 days);
    for (uint256 i = 0; i < reductions; ++i) {
      vm.prank(guardian);
      manager.reducePoolFundingBudget(newPool, 0, 0);
      vm.warp(block.timestamp + dt);
    }
    _assertEmptyBudget(manager.getPoolFundingBudget(newPool));

    vm.prank(address(timelock));
    manager.setPoolFundingBudget(newPool, capacity, rate);
    ILiquidityManager.BudgetState memory state = manager.getPoolFundingBudget(newPool);
    assertEq(state.capacity, capacity);
    assertEq(state.rate, rate);
    assertEq(state.available, capacity, "first owner configuration starts full");
  }

  function testFuzz_guardianCannotReduceUnconfiguredBucketToNonZero(uint256 capacity, uint256 rate) public {
    vm.assume(capacity != 0 || rate != 0);
    vm.expectRevert(ILiquidityManager.NotARestriction.selector);
    vm.prank(guardian);
    manager.reducePoolFundingBudget(newPool, capacity, rate);
  }

  function testFuzz_recallDoesNotCreditFundingBudgets(uint256 fundAmount, uint256 recallAmount) public {
    fundAmount = bound(fundAmount, 1, MAX_FUNDING_PER_CALL);
    recallAmount = bound(recallAmount, 1, POOL_INVENTORY + fundAmount - POOL_MINIMUM);
    recallAmount = bound(recallAmount, 1, MAX_RECALL_PER_CALL);
    _fund(fundAmount);
    uint256 aggregate = manager.getAggregateFundingBudget().available;
    uint256 poolBudget = manager.getPoolFundingBudget(address(pool)).available;
    uint256 recallBudget = manager.getRecallBudget().available;

    _recall(recallAmount);

    assertEq(manager.getAggregateFundingBudget().available, aggregate);
    assertEq(manager.getPoolFundingBudget(address(pool)).available, poolBudget);
    assertEq(manager.getRecallBudget().available, recallBudget - recallAmount);
  }

  function testFuzz_guardianReductionNeverRestoresUsage(uint256 fundAmount, uint256 dt, uint256 capacity, uint256 rate)
    public
  {
    fundAmount = bound(fundAmount, 1, MAX_FUNDING_PER_CALL);
    dt = bound(dt, 0, 2 days);
    capacity = bound(capacity, 0, AGGREGATE_FUNDING_CAPACITY);
    rate = bound(rate, 0, AGGREGATE_FUNDING_RATE);
    _fund(fundAmount);
    vm.warp(block.timestamp + dt);
    uint256 before = manager.getAggregateFundingBudget().available;

    vm.prank(guardian);
    manager.reduceAggregateFundingBudget(capacity, rate);

    ILiquidityManager.BudgetState memory state = manager.getAggregateFundingBudget();
    assertEq(state.available, Math.min(before, capacity));
    assertEq(state.capacity, capacity);
    assertEq(state.rate, rate);
  }

  function testFuzz_ownerRaiseNeverRestoresUsage(uint256 fundAmount, uint256 capacity, uint256 rate) public {
    fundAmount = bound(fundAmount, 1, MAX_FUNDING_PER_CALL);
    capacity = bound(capacity, 0, type(uint128).max);
    _fund(fundAmount);
    uint256 before = manager.getPoolFundingBudget(address(pool)).available;

    vm.prank(address(timelock));
    manager.setPoolFundingBudget(address(pool), capacity, rate);
    assertEq(manager.getPoolFundingBudget(address(pool)).available, Math.min(before, capacity));
  }

  function _assertEmptyBudget(ILiquidityManager.BudgetState memory state) internal pure {
    assertEq(state.capacity, 0, "capacity");
    assertEq(state.rate, 0, "rate");
    assertEq(state.available, 0, "available");
  }
}
