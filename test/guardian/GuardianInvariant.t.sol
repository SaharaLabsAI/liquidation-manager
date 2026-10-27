// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Vm} from "forge-std/Vm.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";
import {MockSahara} from "test/mocks/MockSahara.sol";
import {BaseTest} from "test/utils/BaseTest.sol";

/// @notice Drives random sequences of Guardian actions (valid restrictions and attempted loosenings), operator funding
/// and recall, and time. The owner never acts, so every limit must be monotone in the restrictive direction.
contract GuardianHandler is Test {
  LiquidityManager internal immutable i_manager;
  GuardianController internal immutable i_controller;
  MockSahara internal immutable i_token;
  MockLockReleaseTokenPool internal immutable i_pool;
  address internal immutable i_adapter;
  address internal immutable i_guardian;
  address internal immutable i_fundingOperator;
  address internal immutable i_recallOperator;
  uint256 internal immutable i_adapterId;
  /// @dev A second pool with a migration approval, so revocations of an unregistered pool are exercised too.
  address internal immutable i_otherPool;

  uint256 public currentTime;

  // Ghost accounting.
  uint256 public ghostFunded;
  uint256 public ghostRecalled;
  uint256 public ghostFundCount;
  uint256 public ghostRecallCount;
  uint256 public ghostGuardianCalls;

  // Violation counters; all must stay zero.
  uint256 public loosenings;
  uint256 public availabilityIncreases;
  uint256 public unexpectedReverts;
  uint256 public minimumBreaches;
  uint256 public monotonicityViolations;
  uint256 public guardianActionViolations;

  // Last observed values, for monotonicity.
  bool internal s_fundingPaused;
  bool internal s_recallPaused;
  bool internal s_fundingOperatorSuspended;
  bool internal s_recallOperatorSuspended;
  bool internal s_adapterFundingDisabled;
  bool internal s_adapterRecallDisabled;
  bool internal s_lockedDown;
  uint256 internal s_maxFundingPerCall;
  uint256 internal s_maxRecallPerCall;
  uint256 internal s_minimum;
  address internal s_poolMigrationSource;
  address internal s_otherPoolMigrationSource;
  ILiquidityManager.BudgetState internal s_aggregate;
  ILiquidityManager.BudgetState internal s_poolBudget;
  ILiquidityManager.BudgetState internal s_recallBudget;

  constructor(
    LiquidityManager manager,
    GuardianController controller,
    MockSahara token,
    MockLockReleaseTokenPool pool,
    address adapter,
    address guardian,
    address fundingOperator,
    address recallOperator,
    uint256 adapterId,
    address otherPool
  ) {
    i_manager = manager;
    i_controller = controller;
    i_token = token;
    i_pool = pool;
    i_adapter = adapter;
    i_guardian = guardian;
    i_fundingOperator = fundingOperator;
    i_recallOperator = recallOperator;
    i_adapterId = adapterId;
    i_otherPool = otherPool;
    currentTime = block.timestamp;
    _record();
  }

  modifier step() {
    vm.warp(currentTime);
    _;
    _checkMonotone();
    _record();
  }

  // ---------------------------------------------------------------- Guardian: switches

  /// @dev Terminal restrictions fire rarely so that operator flows keep consuming budgets between Guardian actions.
  function guardianPause(bool funding, uint256 seed) external step {
    if (seed % 16 != 0) return;
    ++ghostGuardianCalls;
    _guardianMustSucceed(
      funding ? abi.encodeCall(LiquidityManager.pauseFunding, ()) : abi.encodeCall(LiquidityManager.pauseRecall, ())
    );
  }

  function guardianSuspend(bool funding, uint256 seed) external step {
    if (seed % 16 != 0) return;
    ++ghostGuardianCalls;
    _guardianMustSucceed(
      funding
        ? abi.encodeCall(LiquidityManager.suspendFundingOperator, (i_fundingOperator))
        : abi.encodeCall(LiquidityManager.suspendRecallOperator, (i_recallOperator))
    );
  }

  function guardianRestrictAdapter(bool disableFunding, bool disableRecall, uint256 seed) external step {
    // (false, false) is a no-op and is exercised every time; real disabling is rare.
    if (seed % 16 != 0) disableFunding = disableRecall = false;
    ++ghostGuardianCalls;
    _guardianMustSucceed(abi.encodeCall(LiquidityManager.restrictAdapter, (i_adapterId, disableFunding, disableRecall)));
  }

  /// @dev Revoking a migration approval does not affect routine funding (the registry maps the token to the pool), so
  /// it may fire often.
  function guardianRevokeMigration(bool otherPool) external step {
    ++ghostGuardianCalls;
    _guardianMustSucceed(
      abi.encodeCall(LiquidityManager.revokePoolMigrationApproval, (otherPool ? i_otherPool : address(i_pool)))
    );
  }

  function guardianLockdown(uint256 seed) external step {
    if (seed % 8 != 0) return;
    ++ghostGuardianCalls;
    vm.prank(i_guardian);
    try i_controller.lockdown(address(i_pool)) {}
    catch {
      ++unexpectedReverts;
    }
  }

  // ---------------------------------------------------------------- Guardian: per-call limits and minimum

  function guardianReduceMaxFunding(uint256 value, bool attemptLoosen) external step {
    ++ghostGuardianCalls;
    uint256 current = i_manager.maxFundingPerCall();
    if (attemptLoosen) {
      if (current == type(uint256).max) return;
      value = bound(value, current + 1, type(uint256).max);
      _guardianMustRejectAsLoosening(abi.encodeCall(LiquidityManager.reduceMaxFundingPerCall, (value)));
    } else {
      value = _tighten(value, current);
      _guardianMustSucceed(abi.encodeCall(LiquidityManager.reduceMaxFundingPerCall, (value)));
    }
  }

  function guardianRaiseMinimum(uint256 value, bool attemptLower) external step {
    ++ghostGuardianCalls;
    uint256 current = _minimum();
    if (attemptLower) {
      if (current == 0) return;
      value = bound(value, 0, current - 1);
      _guardianMustRejectAsLoosening(abi.encodeCall(LiquidityManager.raisePoolMinimum, (address(i_pool), value)));
    } else {
      // Mostly small raises so recalls stay possible; sometimes the extreme.
      if (value % 16 == 0 || current > type(uint256).max - 5_000_000e18) value = type(uint256).max;
      else value = current + bound(value, 0, 5_000_000e18);
      _guardianMustSucceed(abi.encodeCall(LiquidityManager.raisePoolMinimum, (address(i_pool), value)));
    }
  }

  // ---------------------------------------------------------------- Guardian: budgets

  /// @param which 0 aggregate, 1 pool, 2 recall.
  /// @param mode 0 tighten, 1 loosen capacity, 2 loosen rate, 3 loosen recall per-call (recall only).
  function guardianReduceBudget(uint8 which, uint8 mode, uint256 capacity, uint256 rate) external step {
    ++ghostGuardianCalls;
    which = which % 3;
    mode = mode % 4;
    ILiquidityManager.BudgetState memory before = _bucket(which);
    uint256 perCall = i_manager.maxRecallPerCall();

    if (mode == 0) {
      capacity = _tighten(capacity, before.capacity);
      rate = _tighten(rate, before.rate);
      if (which == 2) perCall = _tighten(uint256(keccak256(abi.encode(capacity, rate))), perCall);
    } else if (mode == 1) {
      if (before.capacity == type(uint256).max) return;
      capacity = bound(capacity, before.capacity + 1, type(uint256).max);
      rate = bound(rate, 0, before.rate);
    } else if (mode == 2) {
      if (before.rate == type(uint256).max) return;
      capacity = bound(capacity, 0, before.capacity);
      rate = bound(rate, before.rate + 1, type(uint256).max);
    } else {
      if (which != 2 || perCall == type(uint256).max) return;
      capacity = bound(capacity, 0, before.capacity);
      rate = bound(rate, 0, before.rate);
      perCall = bound(uint256(keccak256(abi.encode(capacity, rate))), perCall + 1, type(uint256).max);
    }

    bytes memory data = _reduceCall(which, perCall, capacity, rate);
    if (mode != 0) {
      _guardianMustRejectAsLoosening(data);
      return;
    }
    if (!_guardianMustSucceed(data)) return;
    ILiquidityManager.BudgetState memory afterState = _bucket(which);
    if (afterState.available > before.available) ++availabilityIncreases;
    if (afterState.available != (before.available < capacity ? before.available : capacity)) {
      ++availabilityIncreases;
    }
  }

  // ---------------------------------------------------------------- Operators and time

  /// @dev Usually an amount the limits allow (so budgets get consumed), sometimes anything up to 30M.
  function fund(uint256 amount) external step {
    if (amount % 4 == 0) {
      amount = bound(amount, 1, 30_000_000e18);
    } else {
      uint256 cap = _min3(
        i_manager.maxFundingPerCall(),
        i_manager.getAggregateFundingBudget().available,
        i_manager.getPoolFundingBudget(address(i_pool)).available
      );
      amount = bound(amount, 1, cap == 0 ? 1 : cap);
    }
    vm.prank(i_fundingOperator);
    try i_manager.fund(i_adapterId, amount) {
      ghostFunded += amount;
      ++ghostFundCount;
    } catch {}
  }

  function recall(uint256 amount) external step {
    if (amount % 4 == 0) {
      amount = bound(amount, 1, 30_000_000e18);
    } else {
      uint256 poolBalance = i_token.balanceOf(address(i_pool));
      uint256 minimum = _minimum();
      uint256 cap = _min3(
        i_manager.maxRecallPerCall(),
        i_manager.getRecallBudget().available,
        poolBalance > minimum ? poolBalance - minimum : 0
      );
      amount = bound(amount, 1, cap == 0 ? 1 : cap);
    }
    vm.prank(i_recallOperator);
    try i_manager.recall(i_adapterId, amount) {
      ghostRecalled += amount;
      ++ghostRecallCount;
      if (i_token.balanceOf(address(i_pool)) < _minimum()) {
        ++minimumBreaches;
      }
    } catch {}
  }

  function warp(uint256 seconds_) external {
    currentTime += bound(seconds_, 0, 2 days);
    vm.warp(currentTime);
  }

  // ---------------------------------------------------------------- internal

  /// @dev Calls the Manager as the Guardian and checks its logs: a successful call emits exactly
  /// [GuardianAction(guardian, selector), configuration event] (the Manager emits one configuration event per Guardian
  /// function). Logs of a reverted call are not checked: `vm.recordLogs` keeps logs emitted inside a frame that later
  /// reverts (e.g. GuardianAction before `NotARestriction`), whereas on-chain they are discarded with the revert.
  function _guardianCall(bytes memory data) internal returns (bool ok, bytes memory ret) {
    vm.recordLogs();
    vm.prank(i_guardian);
    (ok, ret) = address(i_manager).call(data);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    if (!ok) return (ok, ret);
    if (
      logs.length != 2 || logs[0].emitter != address(i_manager) || logs[1].emitter != address(i_manager)
        || logs[0].topics.length != 3 || logs[0].topics[0] != ILiquidityManager.GuardianAction.selector
        || logs[0].topics[1] != bytes32(uint256(uint160(i_guardian))) || logs[0].topics[2] != bytes32(bytes4(data))
        || logs[1].topics[0] == ILiquidityManager.GuardianAction.selector
    ) ++guardianActionViolations;
  }

  function _guardianMustSucceed(bytes memory data) internal returns (bool ok) {
    (ok,) = _guardianCall(data);
    if (!ok) ++unexpectedReverts;
  }

  function _guardianMustRejectAsLoosening(bytes memory data) internal {
    (bool ok, bytes memory err) = _guardianCall(data);
    if (ok) ++loosenings;
    else _expectNotARestriction(err);
  }

  function _minimum() internal view returns (uint256) {
    (ILiquidityManager.PoolThresholds memory thresholds,) = i_manager.getPoolThresholds(address(i_pool));
    return thresholds.minimum;
  }

  function _min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256 m) {
    m = a < b ? a : b;
    if (c < m) m = c;
  }

  /// @dev New value <= current: usually a small step down (up to 10%), sometimes anything down to zero.
  function _tighten(uint256 seed, uint256 current) internal pure returns (uint256) {
    if (seed % 8 == 0) return bound(seed, 0, current);
    return current - bound(seed, 0, current / 10);
  }

  function _reduceCall(uint8 which, uint256 perCall, uint256 capacity, uint256 rate)
    internal
    view
    returns (bytes memory)
  {
    if (which == 0) return abi.encodeCall(LiquidityManager.reduceAggregateFundingBudget, (capacity, rate));
    if (which == 1) {
      return abi.encodeCall(LiquidityManager.reducePoolFundingBudget, (address(i_pool), capacity, rate));
    }
    return abi.encodeCall(LiquidityManager.reduceRecallLimits, (perCall, capacity, rate));
  }

  function _bucket(uint8 which) internal view returns (ILiquidityManager.BudgetState memory) {
    if (which == 0) return i_manager.getAggregateFundingBudget();
    if (which == 1) return i_manager.getPoolFundingBudget(address(i_pool));
    return i_manager.getRecallBudget();
  }

  function _expectNotARestriction(bytes memory err) internal {
    if (keccak256(err) != keccak256(abi.encodeWithSelector(ILiquidityManager.NotARestriction.selector))) {
      ++unexpectedReverts;
    }
  }

  function _checkMonotone() internal {
    if (s_fundingPaused && !i_manager.fundingPaused()) ++monotonicityViolations;
    if (s_recallPaused && !i_manager.recallPaused()) ++monotonicityViolations;
    if (s_fundingOperatorSuspended && i_manager.isFundingOperator(i_fundingOperator)) ++monotonicityViolations;
    if (s_recallOperatorSuspended && i_manager.isRecallOperator(i_recallOperator)) ++monotonicityViolations;
    ILiquidityManager.Adapter memory entry = i_manager.getAdapter(i_adapterId);
    if (s_adapterFundingDisabled && entry.fundingEnabled) ++monotonicityViolations;
    if (s_adapterRecallDisabled && entry.recallEnabled) ++monotonicityViolations;
    if (i_manager.maxFundingPerCall() > s_maxFundingPerCall) ++monotonicityViolations;
    if (i_manager.maxRecallPerCall() > s_maxRecallPerCall) ++monotonicityViolations;
    if (_minimum() < s_minimum) ++monotonicityViolations;
    _checkMigrationSource(s_poolMigrationSource, i_manager.getPoolMigrationSource(address(i_pool)));
    _checkMigrationSource(s_otherPoolMigrationSource, i_manager.getPoolMigrationSource(i_otherPool));
    _checkBucket(s_aggregate, i_manager.getAggregateFundingBudget());
    _checkBucket(s_poolBudget, i_manager.getPoolFundingBudget(address(i_pool)));
    _checkBucket(s_recallBudget, i_manager.getRecallBudget());
    if (s_lockedDown) {
      (, uint128 outCapacity, uint128 outRate) = i_pool.outboundConfig(_remoteChain());
      (, uint128 inCapacity, uint128 inRate) = i_pool.inboundConfig(_remoteChain());
      if (outCapacity != 0 || outRate != 0 || inCapacity != 0 || inRate != 0) ++monotonicityViolations;
    }
  }

  /// @dev A migration approval can only be revoked (set to address(0)), never granted or rebound to another source.
  function _checkMigrationSource(address previous, address current) internal {
    if (current != previous && current != address(0)) ++monotonicityViolations;
  }

  function _checkBucket(ILiquidityManager.BudgetState memory previous, ILiquidityManager.BudgetState memory current)
    internal
  {
    if (current.capacity > previous.capacity || current.rate > previous.rate) ++monotonicityViolations;
    if (current.available > current.capacity) ++monotonicityViolations;
  }

  function _record() internal {
    s_fundingPaused = i_manager.fundingPaused();
    s_recallPaused = i_manager.recallPaused();
    s_fundingOperatorSuspended = !i_manager.isFundingOperator(i_fundingOperator);
    s_recallOperatorSuspended = !i_manager.isRecallOperator(i_recallOperator);
    ILiquidityManager.Adapter memory entry = i_manager.getAdapter(i_adapterId);
    s_adapterFundingDisabled = !entry.fundingEnabled;
    s_adapterRecallDisabled = !entry.recallEnabled;
    s_maxFundingPerCall = i_manager.maxFundingPerCall();
    s_maxRecallPerCall = i_manager.maxRecallPerCall();
    s_minimum = _minimum();
    s_poolMigrationSource = i_manager.getPoolMigrationSource(address(i_pool));
    s_otherPoolMigrationSource = i_manager.getPoolMigrationSource(i_otherPool);
    s_aggregate = i_manager.getAggregateFundingBudget();
    s_poolBudget = i_manager.getPoolFundingBudget(address(i_pool));
    s_recallBudget = i_manager.getRecallBudget();
    (, uint128 outCapacity,) = i_pool.outboundConfig(_remoteChain());
    s_lockedDown = s_lockedDown || outCapacity == 0;
  }

  function _remoteChain() internal pure returns (uint64) {
    return 11344663589394136015;
  }
}

contract GuardianInvariantTest is BaseTest {
  GuardianHandler internal handler;
  uint256 internal startTime;
  address internal previousPool = makeAddr("previousPool");
  address internal otherPool = makeAddr("otherPool");

  function setUp() public override {
    super.setUp();
    startTime = block.timestamp;

    // Owner-granted migration approvals for the Guardian to revoke. The registry maps the token to `pool`, so the
    // approval of `pool` does not affect routine funding.
    vm.startPrank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), previousPool);
    manager.setPoolMigrationApproval(otherPool, address(pool));
    vm.stopPrank();

    handler = new GuardianHandler(
      manager,
      controller,
      token,
      pool,
      address(adapter),
      guardian,
      fundingOperator,
      recallOperator,
      adapterId,
      otherPool
    );

    bytes4[] memory selectors = new bytes4[](13);
    selectors[0] = GuardianHandler.guardianPause.selector;
    selectors[1] = GuardianHandler.guardianSuspend.selector;
    selectors[2] = GuardianHandler.guardianRestrictAdapter.selector;
    selectors[3] = GuardianHandler.guardianLockdown.selector;
    selectors[4] = GuardianHandler.guardianReduceMaxFunding.selector;
    selectors[5] = GuardianHandler.guardianRaiseMinimum.selector;
    selectors[6] = GuardianHandler.guardianReduceBudget.selector;
    selectors[7] = GuardianHandler.guardianRevokeMigration.selector;
    selectors[8] = GuardianHandler.fund.selector;
    selectors[9] = GuardianHandler.recall.selector;
    selectors[10] = GuardianHandler.warp.selector;
    // Weight operator activity so that budgets are consumed between Guardian actions.
    selectors[11] = GuardianHandler.fund.selector;
    selectors[12] = GuardianHandler.recall.selector;
    targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    targetContract(address(handler));
  }

  /// @dev Principal is conserved across the Manager, adapter and pool (no bridge flows in this harness).
  function invariant_principalConserved() public view {
    assertEq(
      _balance(address(manager)) + _balance(address(pool)) + _balance(address(adapter)),
      MANAGER_RESERVES + POOL_INVENTORY
    );
    assertEq(_balance(address(adapter)), 0);
    assertEq(_balance(guardian), 0);
    assertEq(_balance(address(controller)), 0);
    assertEq(token.allowance(address(adapter), address(pool)), 0);
    assertEq(_balance(address(manager)) + handler.ghostFunded(), MANAGER_RESERVES + handler.ghostRecalled());
  }

  function invariant_guardianOnlyRestricts() public view {
    assertEq(handler.loosenings(), 0, "guardian loosened a limit");
    assertEq(handler.availabilityIncreases(), 0, "guardian reduction increased or mis-capped availability");
    assertEq(handler.unexpectedReverts(), 0, "valid guardian restriction reverted or wrong error");
    assertEq(handler.monotonicityViolations(), 0, "restriction undone without the owner");
  }

  /// @dev Every successful Guardian call on the Manager emitted GuardianAction(guardian, selector) first, followed by
  /// exactly one configuration event.
  function invariant_guardianActionAuditTrail() public view {
    assertEq(handler.guardianActionViolations(), 0, "GuardianAction missing, misordered or mislabelled");
  }

  function invariant_limitsNeverAboveInitial() public view {
    assertLe(manager.maxFundingPerCall(), MAX_FUNDING_PER_CALL);
    assertLe(manager.maxRecallPerCall(), MAX_RECALL_PER_CALL);
    assertLe(manager.getAggregateFundingBudget().capacity, AGGREGATE_FUNDING_CAPACITY);
    assertLe(manager.getAggregateFundingBudget().rate, AGGREGATE_FUNDING_RATE);
    assertLe(manager.getPoolFundingBudget(address(pool)).capacity, POOL_FUNDING_CAPACITY);
    assertLe(manager.getPoolFundingBudget(address(pool)).rate, POOL_FUNDING_RATE);
    assertLe(manager.getRecallBudget().capacity, RECALL_CAPACITY);
    assertLe(manager.getRecallBudget().rate, RECALL_RATE);
    (ILiquidityManager.PoolThresholds memory thresholds, bool thresholdsSet) = manager.getPoolThresholds(address(pool));
    assertTrue(thresholdsSet);
    assertGe(thresholds.minimum, POOL_MINIMUM);
    assertEq(thresholds.refillTrigger, POOL_REFILL_TRIGGER);
    assertEq(thresholds.refillTarget, POOL_REFILL_TARGET);
  }

  /// @dev Migration approvals are either as the owner set them or revoked; the Guardian never grants or rebinds one.
  function invariant_migrationApprovalsOnlyRevoked() public view {
    address poolSource = manager.getPoolMigrationSource(address(pool));
    address otherSource = manager.getPoolMigrationSource(otherPool);
    assertTrue(poolSource == previousPool || poolSource == address(0), "pool approval granted or rebound");
    assertTrue(otherSource == address(pool) || otherSource == address(0), "other approval granted or rebound");
  }

  /// @dev Cumulative flows never exceed what the initial (largest) budgets could have released since deployment.
  function invariant_cumulativeFlowsBoundedByInitialBudgets() public view {
    uint256 elapsed = handler.currentTime() - startTime;
    assertLe(handler.ghostFunded(), AGGREGATE_FUNDING_CAPACITY + AGGREGATE_FUNDING_RATE * elapsed);
    assertLe(handler.ghostFunded(), POOL_FUNDING_CAPACITY + POOL_FUNDING_RATE * elapsed);
    assertLe(handler.ghostRecalled(), RECALL_CAPACITY + RECALL_RATE * elapsed);
    assertEq(handler.minimumBreaches(), 0);
  }

  function invariant_authorityUnchanged() public view {
    assertEq(manager.owner(), address(timelock));
    assertEq(manager.pendingOwner(), address(0));
    assertEq(manager.guardian(), guardian);
    assertEq(pool.owner(), address(timelock));
    assertEq(pool.getRebalancer(), address(adapter));
    assertEq(pool.getRateLimitAdmin(), address(controller));
    ILiquidityManager.Adapter memory entry = manager.getAdapter(adapterId);
    assertEq(entry.adapter, address(adapter));
    assertEq(entry.pool, address(pool));
    // Token ownership and registry administration stay with the Timelock; the adapter history is untouched.
    manager.verifyHandover();
    assertEq(token.owner(), address(timelock));
    assertEq(registry.getPool(address(token)), address(pool));
    assertEq(manager.getAdapterHistory().length, 1);
    assertFalse(manager.isFundingOperator(guardian));
    assertFalse(manager.isRecallOperator(guardian));
  }
}
