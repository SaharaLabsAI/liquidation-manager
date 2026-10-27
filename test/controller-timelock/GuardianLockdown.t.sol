// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";

import {ControllerTimelockBase} from "test/controller-timelock/utils/ControllerTimelockBase.sol";

/// @notice GuardianController.lockdown: zero-only rate limits on recognized pools, and timelocked restoration.
contract GuardianLockdownTest is ControllerTimelockBase {
  uint64 internal constant ETH_CHAIN_SELECTOR = 5009297550715157269;
  bytes32 internal constant SALT = keccak256("restore");

  function _zero() internal pure returns (ILockReleaseTokenPool.RateLimiterConfig memory) {
    return ILockReleaseTokenPool.RateLimiterConfig({isEnabled: true, capacity: 0, rate: 0});
  }

  function _defaultBucket() internal pure returns (ILockReleaseTokenPool.RateLimiterConfig memory) {
    return _ccipBucket(CCIP_CAPACITY, CCIP_RATE);
  }

  /// @dev A second pool replica owned by this test contract with the controller as rate limit admin.
  function _newPool(uint64[] memory chains) internal returns (MockLockReleaseTokenPool newPool) {
    newPool = new MockLockReleaseTokenPool(address(token), router);
    for (uint256 i = 0; i < chains.length; ++i) {
      newPool.addChain(chains[i], abi.encode(REMOTE_TOKEN), abi.encode(REMOTE_POOL), _defaultBucket(), _defaultBucket());
    }
    newPool.setRateLimitAdmin(address(controller));
  }

  function _chains1(uint64 a) internal pure returns (uint64[] memory c) {
    c = new uint64[](1);
    c[0] = a;
  }

  // ================================================================
  // │                        Happy path                            │
  // ================================================================

  function test_lockdown_zeroesBothCounterpartBuckets() public {
    _assertBuckets(address(pool), REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket());

    vm.expectEmit(false, false, false, true, address(pool));
    emit MockLockReleaseTokenPool.ChainConfigured(REMOTE_CHAIN_SELECTOR, _zero(), _zero());
    vm.expectEmit(true, true, true, true, address(controller));
    emit GuardianController.PoolLockedDown(address(pool), REMOTE_CHAIN_SELECTOR, guardian);
    vm.prank(guardian);
    controller.lockdown(address(pool));

    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  function test_lockdown_repeatedLockdownSucceeds() public {
    vm.startPrank(guardian);
    controller.lockdown(address(pool));
    vm.expectEmit(true, true, true, true, address(controller));
    emit GuardianController.PoolLockedDown(address(pool), REMOTE_CHAIN_SELECTOR, guardian);
    controller.lockdown(address(pool));
    controller.lockdown(address(pool));
    vm.stopPrank();
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  function test_lockdown_disabledBucketBecomesEnabledZero() public {
    ILockReleaseTokenPool.RateLimiterConfig memory disabled =
      ILockReleaseTokenPool.RateLimiterConfig({isEnabled: false, capacity: 0, rate: 0});
    vm.prank(address(timelock));
    pool.setChainRateLimiterConfig(REMOTE_CHAIN_SELECTOR, disabled, disabled);

    vm.prank(guardian);
    controller.lockdown(address(pool));
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  function testFuzz_lockdown_anyPriorConfigEndsEnabledZero(
    bool outEnabled,
    uint128 outCapacity,
    uint128 outRate,
    bool inEnabled,
    uint128 inCapacity,
    uint128 inRate
  ) public {
    ILockReleaseTokenPool.RateLimiterConfig memory outbound = outEnabled
      ? _ccipBucket(outCapacity, uint128(bound(outRate, 0, outCapacity)))
      : ILockReleaseTokenPool.RateLimiterConfig(false, 0, 0);
    ILockReleaseTokenPool.RateLimiterConfig memory inbound = inEnabled
      ? _ccipBucket(inCapacity, uint128(bound(inRate, 0, inCapacity)))
      : ILockReleaseTokenPool.RateLimiterConfig(false, 0, 0);
    vm.prank(address(timelock));
    pool.setChainRateLimiterConfig(REMOTE_CHAIN_SELECTOR, outbound, inbound);

    vm.prank(guardian);
    controller.lockdown(address(pool));
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  function test_lockdown_doesNotTouchManagerOrBalances() public {
    uint256 managerBalance = _balance(address(manager));
    uint256 poolBalance = _balance(address(pool));

    vm.prank(guardian);
    controller.lockdown(address(pool));

    assertEq(_balance(address(manager)), managerBalance);
    assertEq(_balance(address(pool)), poolBalance);
    assertFalse(manager.fundingPaused());
    assertFalse(manager.recallPaused());
    assertEq(manager.guardian(), guardian);
    // Liquidity operations are unaffected by bridge lockdown.
    _fund(1e18);
    _recall(1e18);
  }

  function test_lockdown_poolWithTwoChainsZeroesBoth() public {
    vm.prank(address(timelock));
    pool.addChain(
      ETH_CHAIN_SELECTOR, abi.encode(REMOTE_TOKEN), abi.encode(REMOTE_POOL), _defaultBucket(), _defaultBucket()
    );

    vm.expectEmit(true, true, true, true, address(controller));
    emit GuardianController.PoolLockedDown(address(pool), REMOTE_CHAIN_SELECTOR, guardian);
    vm.expectEmit(true, true, true, true, address(controller));
    emit GuardianController.PoolLockedDown(address(pool), ETH_CHAIN_SELECTOR, guardian);
    vm.prank(guardian);
    controller.lockdown(address(pool));

    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
    _assertLockedDown(address(pool), ETH_CHAIN_SELECTOR);
  }

  // ================================================================
  // │                     Pool recognition                         │
  // ================================================================

  /// @dev The registry's current pool is recognized even when it has no adapter in the Manager.
  function test_lockdown_registryPoolNotRegisteredInManager() public {
    uint64[] memory chains = new uint64[](2);
    chains[0] = REMOTE_CHAIN_SELECTOR;
    chains[1] = ETH_CHAIN_SELECTOR;
    MockLockReleaseTokenPool replacement = _newPool(chains);
    registry.setPool(address(token), address(replacement));
    assertEq(manager.adapterIdByPool(address(replacement)), 0);

    vm.prank(guardian);
    controller.lockdown(address(replacement));
    _assertLockedDown(address(replacement), REMOTE_CHAIN_SELECTOR);
    _assertLockedDown(address(replacement), ETH_CHAIN_SELECTOR);
    // The registered (old) pool is untouched.
    _assertBuckets(address(pool), REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket());
  }

  /// @dev A pool registered in the Manager stays lockable after the registry moves to another pool (cutover).
  function test_lockdown_registeredPoolAfterRegistryMovedAway() public {
    registry.setPool(address(token), makeAddr("someOtherPool"));
    vm.prank(guardian);
    controller.lockdown(address(pool));
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  function test_lockdown_registeredPoolWhenRegistryUnset() public {
    registry.setPool(address(token), address(0));
    vm.prank(guardian);
    controller.lockdown(address(pool));
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  function test_lockdown_revertsForRandomAddress() public {
    address random = makeAddr("random");
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, random));
    vm.prank(guardian);
    controller.lockdown(random);
  }

  function test_lockdown_revertsForCoreContracts() public {
    address[4] memory targets = [address(manager), address(timelock), address(adapter), address(token)];
    for (uint256 i = 0; i < targets.length; ++i) {
      vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, targets[i]));
      vm.prank(guardian);
      controller.lockdown(targets[i]);
    }
  }

  /// @dev A real pool replica with the controller as rate limit admin is still refused when it is neither registered
  /// in the Manager nor mapped in the registry.
  function test_lockdown_revertsForUnregisteredPool() public {
    MockLockReleaseTokenPool stray = _newPool(_chains1(REMOTE_CHAIN_SELECTOR));
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, address(stray)));
    vm.prank(guardian);
    controller.lockdown(address(stray));
    _assertBuckets(address(stray), REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket());
  }

  function testFuzz_lockdown_revertsForUnrecognizedPool(address target) public {
    vm.assume(target != address(pool) && target != registry.getPool(address(token)));
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, target));
    vm.prank(guardian);
    controller.lockdown(target);
  }

  /// @dev Once the registry stops pointing at an unregistered pool, it is no longer lockable.
  function test_lockdown_registryPoolNoLongerRecognizedAfterRemap() public {
    MockLockReleaseTokenPool replacement = _newPool(_chains1(REMOTE_CHAIN_SELECTOR));
    registry.setPool(address(token), address(replacement));
    vm.prank(guardian);
    controller.lockdown(address(replacement));

    registry.setPool(address(token), address(pool));
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, address(replacement)));
    vm.prank(guardian);
    controller.lockdown(address(replacement));
  }

  function test_lockdown_revertsForPoolWithZeroChains() public {
    MockLockReleaseTokenPool empty = _newPool(new uint64[](0));
    registry.setPool(address(token), address(empty));
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolHasNoChains.selector, address(empty)));
    vm.prank(guardian);
    controller.lockdown(address(empty));
  }

  function test_lockdown_revertsForRegisteredPoolAfterChainRemoved() public {
    vm.prank(address(timelock));
    pool.removeChain(REMOTE_CHAIN_SELECTOR);
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolHasNoChains.selector, address(pool)));
    vm.prank(guardian);
    controller.lockdown(address(pool));
  }

  /// @dev The pool enforces its own rateLimitAdmin: lockdown fails if the controller no longer holds it.
  function test_lockdown_revertsWhenControllerNotRateLimitAdmin() public {
    vm.prank(address(timelock));
    pool.setRateLimitAdmin(makeAddr("otherAdmin"));
    vm.expectRevert(abi.encodeWithSelector(MockLockReleaseTokenPool.Unauthorized.selector, address(controller)));
    vm.prank(guardian);
    controller.lockdown(address(pool));
  }

  /// @dev address(0) is rejected explicitly, even when the registry has no mapping (getPool == address(0)) and
  /// would otherwise "recognize" it.
  function test_regression_lockdown_zeroAddressWithUnsetRegistryRevertsPoolNotRecognized() public {
    registry.setPool(address(token), address(0));
    assertEq(registry.getPool(address(token)), address(0));
    assertEq(manager.adapterIdByPool(address(0)), 0);

    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, address(0)));
    vm.prank(guardian);
    controller.lockdown(address(0));

    // The registered pool is untouched and remains lockable.
    _assertBuckets(address(pool), REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket());
    vm.prank(guardian);
    controller.lockdown(address(pool));
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  function test_regression_lockdown_zeroAddressWithMappedRegistryRevertsPoolNotRecognized() public {
    assertEq(registry.getPool(address(token)), address(pool));
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, address(0)));
    vm.prank(guardian);
    controller.lockdown(address(0));
  }

  /// @dev The guardian check still runs first for address(0).
  function test_regression_lockdown_zeroAddressNonGuardianRevertsCallerNotGuardian() public {
    registry.setPool(address(token), address(0));
    vm.expectRevert(_notGuardianRevert(attacker));
    vm.prank(attacker);
    controller.lockdown(address(0));
  }

  function testFuzz_regression_lockdown_zeroAddressNeverRecognized(address registryPool) public {
    registry.setPool(address(token), registryPool);
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, address(0)));
    vm.prank(guardian);
    controller.lockdown(address(0));
  }

  // ================================================================
  // │                        Access control                        │
  // ================================================================

  function testFuzz_lockdown_revertsForNonGuardian(address caller) public {
    vm.assume(caller != guardian);
    vm.expectRevert(_notGuardianRevert(caller));
    vm.prank(caller);
    controller.lockdown(address(pool));
    _assertBuckets(address(pool), REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket());
  }

  /// @dev The guardian check runs before recognition.
  function test_lockdown_nonGuardianOnUnrecognizedPool_revertsCallerNotGuardian() public {
    vm.expectRevert(_notGuardianRevert(attacker));
    vm.prank(attacker);
    controller.lockdown(makeAddr("random"));
  }

  function test_lockdown_revertsAfterGuardianRemoved() public {
    vm.prank(address(timelock));
    manager.setGuardian(address(0));
    vm.expectRevert(_notGuardianRevert(guardian));
    vm.prank(guardian);
    controller.lockdown(address(pool));
  }

  function test_lockdown_followsManagerGuardian() public {
    vm.prank(address(timelock));
    manager.setGuardian(newGuardian);

    vm.expectRevert(_notGuardianRevert(guardian));
    vm.prank(guardian);
    controller.lockdown(address(pool));

    vm.expectEmit(true, true, true, true, address(controller));
    emit GuardianController.PoolLockedDown(address(pool), REMOTE_CHAIN_SELECTOR, newGuardian);
    vm.prank(newGuardian);
    controller.lockdown(address(pool));
  }

  /// @dev The raw rateLimitAdmin role sits on the controller; the Guardian cannot set buckets on the pool directly.
  function test_guardian_cannotSetPoolRateLimitsDirectly() public {
    vm.expectRevert(abi.encodeWithSelector(MockLockReleaseTokenPool.Unauthorized.selector, guardian));
    vm.prank(guardian);
    pool.setChainRateLimiterConfig(REMOTE_CHAIN_SELECTOR, _ccipBucket(1, 1), _ccipBucket(1, 1));
  }

  /// @dev The controller has no entry point that forwards a caller-chosen rate limit config (non-zero or disabled).
  function test_controller_hasNoArbitraryRateLimitEntryPoint() public {
    ILockReleaseTokenPool.RateLimiterConfig memory high = _ccipBucket(type(uint128).max, type(uint128).max);
    ILockReleaseTokenPool.RateLimiterConfig memory disabled = ILockReleaseTokenPool.RateLimiterConfig(false, 0, 0);

    vm.startPrank(guardian);
    controller.lockdown(address(pool));

    (bool ok,) = address(controller).call(_restoreCall(REMOTE_CHAIN_SELECTOR, high, high));
    assertFalse(ok, "setChainRateLimiterConfig");
    (ok,) = address(controller).call(_restoreCall(REMOTE_CHAIN_SELECTOR, disabled, disabled));
    assertFalse(ok, "disabled");

    uint64[] memory selectors = _chains1(REMOTE_CHAIN_SELECTOR);
    ILockReleaseTokenPool.RateLimiterConfig[] memory configs = new ILockReleaseTokenPool.RateLimiterConfig[](1);
    configs[0] = high;
    (ok,) = address(controller).call(
      abi.encodeWithSignature(
        "setChainRateLimiterConfigs(uint64[],(bool,uint128,uint128)[],(bool,uint128,uint128)[])",
        selectors,
        configs,
        configs
      )
    );
    assertFalse(ok, "setChainRateLimiterConfigs");
    (ok,) = address(controller).call(abi.encodeWithSignature("setRateLimitAdmin(address)", guardian));
    assertFalse(ok, "setRateLimitAdmin");
    vm.stopPrank();

    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  // ================================================================
  // │                    Timelocked restoration                    │
  // ================================================================

  function test_restore_timelockRestoresAfterDelay() public {
    vm.prank(guardian);
    controller.lockdown(address(pool));

    bytes memory restore = _restoreCall(REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket());
    _scheduleOp(address(pool), 0, restore, 0, SALT);

    // Not executable before the delay.
    vm.warp(block.timestamp + TIMELOCK_DELAY - 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        TimelockController.TimelockUnexpectedOperationState.selector,
        timelock.hashOperation(address(pool), 0, restore, 0, SALT),
        _readyBitmap()
      )
    );
    _executeOp(address(pool), 0, restore, 0, SALT);
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);

    vm.warp(block.timestamp + 1);
    _executeOp(address(pool), 0, restore, 0, SALT);
    _assertBuckets(address(pool), REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket());

    // The Guardian can lock down again after restoration.
    vm.prank(guardian);
    controller.lockdown(address(pool));
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  function test_restore_cancellableByGuardian() public {
    vm.prank(guardian);
    controller.lockdown(address(pool));

    bytes memory restore = _restoreCall(REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket());
    bytes32 id = _scheduleOp(address(pool), 0, restore, 0, SALT);
    vm.prank(guardian);
    controller.cancel(address(pool), 0, restore, 0, SALT);
    assertFalse(timelock.isOperation(id));

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.expectRevert(
      abi.encodeWithSelector(TimelockController.TimelockUnexpectedOperationState.selector, id, _readyBitmap())
    );
    _executeOp(address(pool), 0, restore, 0, SALT);
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  /// @dev The delay runs from scheduling, not from lockdown: a restoration queued before an incident executes right
  /// after a late lockdown unless the Guardian cancels it (design Section 5).
  function test_restore_staleRestorationQueuedBeforeLockdown() public {
    bytes memory restore = _restoreCall(REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket());
    _scheduleOp(address(pool), 0, restore, 0, SALT);

    vm.warp(block.timestamp + TIMELOCK_DELAY - 1 hours);
    vm.prank(guardian);
    controller.lockdown(address(pool));

    vm.warp(block.timestamp + 1 hours);
    _executeOp(address(pool), 0, restore, 0, SALT);
    _assertBuckets(address(pool), REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket());
  }

  function test_restore_staleRestorationCancelledDuringIncident() public {
    bytes memory restore = _restoreCall(REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket());
    bytes32 id = _scheduleOp(address(pool), 0, restore, 0, SALT);

    vm.warp(block.timestamp + TIMELOCK_DELAY - 1 hours);
    vm.startPrank(guardian);
    controller.lockdown(address(pool));
    controller.cancel(address(pool), 0, restore, 0, SALT);
    vm.stopPrank();

    vm.warp(block.timestamp + 1 hours);
    vm.expectRevert(
      abi.encodeWithSelector(TimelockController.TimelockUnexpectedOperationState.selector, id, _readyBitmap())
    );
    _executeOp(address(pool), 0, restore, 0, SALT);
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  /// @dev Restoration of a registry-only pool goes through its owner; here the Timelock after an ownership handover.
  function test_restore_registryPoolRestoredByOwnerTimelock() public {
    MockLockReleaseTokenPool replacement = _newPool(_chains1(REMOTE_CHAIN_SELECTOR));
    replacement.transferOwnership(address(timelock));
    registry.setPool(address(token), address(replacement));

    vm.prank(guardian);
    controller.lockdown(address(replacement));
    _assertLockedDown(address(replacement), REMOTE_CHAIN_SELECTOR);

    _scheduleAndExecute(
      address(replacement), _restoreCall(REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket()), SALT
    );
    _assertBuckets(address(replacement), REMOTE_CHAIN_SELECTOR, _defaultBucket(), _defaultBucket());
  }
}
