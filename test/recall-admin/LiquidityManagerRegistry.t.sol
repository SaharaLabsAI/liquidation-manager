// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {TokenBucket} from "src/libraries/TokenBucket.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";
import {MockSahara} from "test/mocks/MockSahara.sol";

import {RecallAdminBase} from "test/recall-admin/RecallAdminBase.sol";
import {StubAdapter} from "test/recall-admin/mocks/StubAdapter.sol";

/// @notice Owner-side registry and configuration: pool specs, thresholds, migration approvals, adapter registration,
/// replacement and status, and the related views.
contract LiquidityManagerRegistryTest is RecallAdminBase {
  uint256 internal constant AMOUNT = 10_000_000e18;
  address internal constant REMOTE_POOL_B = 0x000000000000000000000000000000000000bEEF;

  address internal otherRouter = makeAddr("otherRouter");

  // ================================================================
  // │                         setPoolSpec                          │
  // ================================================================

  function _specWithPools(address[] memory remotePools) internal view returns (ILiquidityManager.PoolSpec memory spec) {
    spec = _poolSpec();
    spec.remotePools = new bytes[](remotePools.length);
    for (uint256 i = 0; i < remotePools.length; ++i) {
      spec.remotePools[i] = abi.encode(remotePools[i]);
    }
  }

  function _setSpec(address target, ILiquidityManager.PoolSpec memory spec) internal {
    vm.prank(address(timelock));
    manager.setPoolSpec(target, spec);
  }

  function _expectInvalidSpec(ILiquidityManager.PoolSpec memory spec) internal {
    vm.expectRevert(ILiquidityManager.InvalidPoolSpec.selector);
    vm.prank(address(timelock));
    manager.setPoolSpec(makeAddr("specTarget"), spec);
  }

  function test_setPoolSpec_storesAndEmits() public {
    address target = makeAddr("futurePool");
    ILiquidityManager.PoolSpec memory spec = _poolSpec();

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.PoolSpecSet(target, spec);
    _setSpec(target, spec);

    (ILiquidityManager.PoolSpec memory stored, bool isSet) = manager.getPoolSpec(target);
    assertTrue(isSet);
    _assertSpecEq(stored, spec);
  }

  function test_getPoolSpec_unsetPool() public {
    (ILiquidityManager.PoolSpec memory stored, bool isSet) = manager.getPoolSpec(makeAddr("unknown"));
    assertFalse(isSet);
    assertEq(bytes(stored.typeAndVersion).length, 0);
    assertEq(stored.router, address(0));
    assertEq(stored.remoteChainSelector, 0);
    assertEq(stored.remoteToken.length, 0);
    assertEq(stored.remotePools.length, 0);
    assertEq(stored.rateLimitAdmin, address(0));
  }

  function test_getPoolSpec_fixturePool() public view {
    (ILiquidityManager.PoolSpec memory stored, bool isSet) = manager.getPoolSpec(address(pool));
    assertTrue(isSet);
    _assertSpecEq(stored, _poolSpec());
  }

  function test_setPoolSpec_revertsOnZeroPool() public {
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    _setSpec(address(0), _poolSpec());
  }

  function test_setPoolSpec_revertsOnEmptyVersion() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.typeAndVersion = "";
    _expectInvalidSpec(spec);
  }

  function test_setPoolSpec_revertsOnZeroRouter() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.router = address(0);
    _expectInvalidSpec(spec);
  }

  function test_setPoolSpec_revertsOnZeroSelector() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.remoteChainSelector = 0;
    _expectInvalidSpec(spec);
  }

  function test_setPoolSpec_revertsOnEmptyRemoteToken() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.remoteToken = "";
    _expectInvalidSpec(spec);
  }

  function test_setPoolSpec_revertsOnNoRemotePools() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.remotePools = new bytes[](0);
    _expectInvalidSpec(spec);
  }

  function test_setPoolSpec_revertsOnEmptyRemotePoolEntry() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.remotePools[0] = "";
    _expectInvalidSpec(spec);
  }

  function test_setPoolSpec_revertsOnLaterEmptyRemotePoolEntry() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.remotePools = new bytes[](3);
    spec.remotePools[0] = abi.encode(REMOTE_POOL);
    spec.remotePools[1] = abi.encode(REMOTE_POOL_B);
    spec.remotePools[2] = "";
    _expectInvalidSpec(spec);
  }

  function test_setPoolSpec_revertsOnDuplicateRemotePools() public {
    address[] memory pools = new address[](2);
    pools[0] = REMOTE_POOL;
    pools[1] = REMOTE_POOL;
    _expectInvalidSpec(_specWithPools(pools));
  }

  function test_setPoolSpec_revertsOnNonAdjacentDuplicateRemotePools() public {
    address[] memory pools = new address[](3);
    pools[0] = REMOTE_POOL;
    pools[1] = REMOTE_POOL_B;
    pools[2] = REMOTE_POOL;
    _expectInvalidSpec(_specWithPools(pools));
  }

  /// @dev The pool owner is no longer part of the spec (so it cannot be mis-set to a zero or foreign owner): it is
  /// compared with the Manager's own owner at every check, so it follows a Manager ownership transfer.
  function test_poolOwner_isComparedWithManagerOwner() public {
    address newOwner = makeAddr("newOwner");
    vm.prank(address(timelock));
    manager.transferOwnership(newOwner);
    // Pending transfer: the Timelock is still the owner, so the pool still matches.
    manager.verifyAdapter(adapterId);

    vm.prank(newOwner);
    manager.acceptOwnership();
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, address(pool), address(timelock))
    );
    manager.verifyAdapter(adapterId);
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, address(pool), address(timelock))
    );
    _fund(AMOUNT);

    vm.prank(address(timelock));
    pool.transferOwnership(newOwner);
    manager.verifyAdapter(adapterId);
    _fund(AMOUNT);
  }

  function test_setPoolSpec_revertsOnZeroRateLimitAdmin() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.rateLimitAdmin = address(0);
    _expectInvalidSpec(spec);
  }

  function test_setPoolSpec_failedUpdateKeepsPreviousSpec() public {
    ILiquidityManager.PoolSpec memory bad = _poolSpec();
    bad.router = address(0);
    vm.expectRevert(ILiquidityManager.InvalidPoolSpec.selector);
    _setSpec(address(pool), bad);
    (ILiquidityManager.PoolSpec memory stored,) = manager.getPoolSpec(address(pool));
    _assertSpecEq(stored, _poolSpec());
  }

  function test_setPoolSpec_replaceWithFewerRemotePoolsReplacesArray() public {
    address[] memory three = new address[](3);
    three[0] = REMOTE_POOL_B;
    three[1] = OTHER_REMOTE_POOL;
    three[2] = REMOTE_POOL;
    _setSpec(address(pool), _specWithPools(three));
    (ILiquidityManager.PoolSpec memory stored,) = manager.getPoolSpec(address(pool));
    assertEq(stored.remotePools.length, 3);

    _setSpec(address(pool), _poolSpec());
    (stored,) = manager.getPoolSpec(address(pool));
    assertEq(stored.remotePools.length, 1, "stale entries left behind");
    _assertSpecEq(stored, _poolSpec());

    // The shrunk spec is what the pool is checked against: the fixture pool has exactly [REMOTE_POOL].
    manager.verifyAdapter(adapterId);
    _fund(AMOUNT);
  }

  function test_setPoolSpec_replaceWithLongerRemotePoolEntries() public {
    // Replacing a long byte string with a short one (and vice versa) must not leave stale bytes.
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.remotePools[0] = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
    spec.remoteToken = abi.encodePacked(bytes32(uint256(4)), bytes32(uint256(5)));
    _setSpec(address(pool), spec);
    _setSpec(address(pool), _poolSpec());
    (ILiquidityManager.PoolSpec memory stored,) = manager.getPoolSpec(address(pool));
    _assertSpecEq(stored, _poolSpec());
    manager.verifyAdapter(adapterId);
  }

  function test_setPoolSpec_replaceWithMoreRemotePoolsRequiresPoolToMatch() public {
    address[] memory two = new address[](2);
    two[0] = REMOTE_POOL;
    two[1] = REMOTE_POOL_B;
    _setSpec(address(pool), _specWithPools(two));
    (ILiquidityManager.PoolSpec memory stored,) = manager.getPoolSpec(address(pool));
    assertEq(stored.remotePools.length, 2);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool)));
    manager.verifyAdapter(adapterId);

    vm.prank(address(timelock));
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(REMOTE_POOL_B));
    manager.verifyAdapter(adapterId);
    _fund(AMOUNT);
  }

  function test_setPoolSpec_remotePoolOrderIrrelevant() public {
    vm.prank(address(timelock));
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(REMOTE_POOL_B));
    address[] memory reversed = new address[](2);
    reversed[0] = REMOTE_POOL_B;
    reversed[1] = REMOTE_POOL;
    _setSpec(address(pool), _specWithPools(reversed));
    manager.verifyAdapter(adapterId);
  }

  function test_setPoolSpec_sameSizeDifferentSetMismatch() public {
    address[] memory other = new address[](1);
    other[0] = REMOTE_POOL_B;
    _setSpec(address(pool), _specWithPools(other));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool)));
    manager.verifyAdapter(adapterId);
  }

  function test_setPoolSpec_remoteTokenEncodingMustMatchExactly() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.remoteToken = abi.encodePacked(REMOTE_TOKEN); // 20 bytes instead of 32
    _setSpec(address(pool), spec);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolRemoteTokenMismatch.selector, address(pool)));
    manager.verifyAdapter(adapterId);
  }

  function test_setPoolSpec_changeBlocksFundingButNotRecall() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.router = otherRouter;
    _setSpec(address(pool), spec);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, address(pool), router));
    _fund(AMOUNT);
    _recall(AMOUNT);
  }

  // ================================================================
  // │                      setPoolThresholds                       │
  // ================================================================

  function test_setPoolThresholds_storesAndEmits() public {
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.PoolThresholdsSet(address(pool), 1, 2, 3);
    vm.prank(address(timelock));
    manager.setPoolThresholds(address(pool), 1, 2, 3);
    (ILiquidityManager.PoolThresholds memory t, bool isSet) = manager.getPoolThresholds(address(pool));
    assertTrue(isSet);
    assertEq(t.minimum, 1);
    assertEq(t.refillTrigger, 2);
    assertEq(t.refillTarget, 3);
  }

  function test_getPoolThresholds_fixtureAndDefault() public {
    (ILiquidityManager.PoolThresholds memory t, bool isSet) = manager.getPoolThresholds(address(pool));
    assertTrue(isSet);
    assertEq(t.minimum, POOL_MINIMUM);
    assertEq(t.refillTrigger, POOL_REFILL_TRIGGER);
    assertEq(t.refillTarget, POOL_REFILL_TARGET);
    (t, isSet) = manager.getPoolThresholds(makeAddr("unknown"));
    assertFalse(isSet);
    assertEq(t.minimum, 0);
    assertEq(t.refillTrigger, 0);
    assertEq(t.refillTarget, 0);
  }

  function test_setPoolThresholds_revertsOnZeroPool() public {
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    vm.prank(address(timelock));
    manager.setPoolThresholds(address(0), 1, 2, 3);
  }

  function test_setPoolThresholds_revertsWhenMinimumAboveTrigger() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidThresholds.selector, 3, 2, 5));
    vm.prank(address(timelock));
    manager.setPoolThresholds(address(pool), 3, 2, 5);
  }

  function test_setPoolThresholds_revertsWhenTriggerAboveTarget() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidThresholds.selector, 1, 5, 4));
    vm.prank(address(timelock));
    manager.setPoolThresholds(address(pool), 1, 5, 4);
  }

  function test_setPoolThresholds_allowsEqualAndZeroValues() public {
    vm.startPrank(address(timelock));
    manager.setPoolThresholds(address(pool), 7, 7, 7);
    manager.setPoolThresholds(address(pool), 0, 0, 0);
    manager.setPoolThresholds(address(pool), 0, 0, type(uint256).max);
    vm.stopPrank();
    assertEq(_thresholds(address(pool)).refillTarget, type(uint256).max);
  }

  function testFuzz_setPoolThresholds_ordering(uint256 minimum, uint256 trigger, uint256 target) public {
    bool valid = minimum <= trigger && trigger <= target;
    if (!valid) {
      vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidThresholds.selector, minimum, trigger, target));
    }
    vm.prank(address(timelock));
    manager.setPoolThresholds(address(pool), minimum, trigger, target);
    (ILiquidityManager.PoolThresholds memory t, bool isSet) = manager.getPoolThresholds(address(pool));
    assertTrue(isSet, "fixture thresholds stay set");
    if (valid) {
      assertEq(t.minimum, minimum);
      assertEq(t.refillTrigger, trigger);
      assertEq(t.refillTarget, target);
    } else {
      assertEq(t.minimum, POOL_MINIMUM);
    }
  }

  function test_setPoolThresholds_ownerLowersMinimumAfterGuardianRaise() public {
    vm.prank(guardian);
    manager.raisePoolMinimum(address(pool), POOL_INVENTORY);
    // The Guardian may push the minimum above the trigger; the owner must restore a valid ordering.
    assertGt(_thresholds(address(pool)).minimum, POOL_REFILL_TRIGGER);

    vm.expectRevert(
      abi.encodeWithSelector(
        ILiquidityManager.InvalidThresholds.selector, POOL_INVENTORY, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET
      )
    );
    vm.prank(address(timelock));
    manager.setPoolThresholds(address(pool), POOL_INVENTORY, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET);

    vm.prank(address(timelock));
    manager.setPoolThresholds(address(pool), POOL_MINIMUM, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET);
    assertEq(_thresholds(address(pool)).minimum, POOL_MINIMUM);
    _recall(AMOUNT);
  }

  function test_setPoolThresholds_refillValuesAreNotEnforcedOnFund() public {
    vm.prank(address(timelock));
    manager.setPoolThresholds(address(pool), 0, 1, 1);
    // Pool is far above trigger and target; funding is still allowed (published config only).
    _fund(AMOUNT);
    assertEq(_balance(address(pool)), POOL_INVENTORY + AMOUNT);
  }

  // ================================================================
  // │                   setPoolMigrationApproval                   │
  // ================================================================

  function test_setPoolMigrationApproval_revertsOnZeroPool() public {
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(0), address(pool));
  }

  function test_setPoolMigrationApproval_setsAndEmits() public {
    address target = makeAddr("replacementPool");
    assertEq(manager.getPoolMigrationSource(target), address(0));

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(target, address(pool));
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(target, address(pool));
    assertEq(manager.getPoolMigrationSource(target), address(pool));

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(target, address(0));
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(target, address(0));
    assertEq(manager.getPoolMigrationSource(target), address(0));
  }

  function test_setPoolMigrationApproval_gatesRegistrationOfNonRegistryPool() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    CCIPPoolAdapter adapter2 = _preparePool(pool2, false);

    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool2), address(pool))
    );
    vm.prank(address(timelock));
    manager.registerAdapter(address(adapter2), address(pool2));

    vm.startPrank(address(timelock));
    manager.setPoolMigrationApproval(address(pool2), address(pool));
    uint256 id2 = manager.registerAdapter(address(adapter2), address(pool2));
    vm.stopPrank();
    assertEq(id2, 2);
  }

  function test_setPoolMigrationApproval_gatesFundingAndGuardianRevokes() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    (, uint256 id2) = _registerPool(pool2);

    _fundAs(fundingOperator, id2, AMOUNT);

    vm.prank(guardian);
    manager.revokePoolMigrationApproval(address(pool2));
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool2), address(pool))
    );
    _fundAs(fundingOperator, id2, AMOUNT);

    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool2), address(pool));
    _fundAs(fundingOperator, id2, AMOUNT);
  }

  function test_setPoolMigrationApproval_notNeededForRegistryPool() public view {
    // Approval only bypasses the registry check; it is not needed (and not set) for the active pool.
    assertEq(manager.getPoolMigrationSource(address(pool)), address(0));
    manager.verifyAdapter(adapterId);
  }

  // ================================================================
  // │                       registerAdapter                        │
  // ================================================================

  function _register(address adapter_, address pool_) internal returns (uint256) {
    vm.prank(address(timelock));
    return manager.registerAdapter(adapter_, pool_);
  }

  function _expectRegisterRevert(address adapter_, address pool_, bytes memory err) internal {
    uint256 historyLength = manager.getAdapterHistory().length;
    bool wasRegistered = manager.isRegisteredAdapter(adapter_);
    vm.expectRevert(err);
    vm.prank(address(timelock));
    manager.registerAdapter(adapter_, pool_);
    assertEq(manager.adapterCount(), 1, "id consumed by failed registration");
    assertEq(manager.adapterIdByPool(pool_), pool_ == address(pool) ? adapterId : 0);
    assertEq(manager.getAdapterHistory().length, historyLength, "history changed by failed registration");
    assertEq(manager.isRegisteredAdapter(adapter_), wasRegistered, "adapter recorded by failed registration");
  }

  /// @dev Sets the thresholds registration requires, so a test reaches the later checks.
  function _setThresholds(address pool_) internal {
    vm.prank(address(timelock));
    manager.setPoolThresholds(pool_, POOL_MINIMUM, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET);
  }

  function test_registerAdapter_revertsOnZeroAdapter() public {
    _expectRegisterRevert(address(0), address(pool), abi.encodeWithSelector(ILiquidityManager.ZeroAddress.selector));
  }

  function test_registerAdapter_revertsOnZeroPool() public {
    _expectRegisterRevert(address(adapter), address(0), abi.encodeWithSelector(ILiquidityManager.ZeroAddress.selector));
  }

  function test_registerAdapter_revertsWhenPoolAlreadyRegistered() public {
    CCIPPoolAdapter another = new CCIPPoolAdapter(address(manager), address(token), address(pool));
    _expectRegisterRevert(
      address(another),
      address(pool),
      abi.encodeWithSelector(ILiquidityManager.PoolAlreadyRegistered.selector, address(pool), adapterId)
    );
    _expectRegisterRevert(
      address(adapter),
      address(pool),
      abi.encodeWithSelector(ILiquidityManager.PoolAlreadyRegistered.selector, address(pool), adapterId)
    );
  }

  function test_registerAdapter_poolStaysRegisteredAfterRetirement() public {
    vm.prank(address(timelock));
    manager.setAdapterStatus(adapterId, false, false);
    registry.setPool(address(token), makeAddr("replacementPool"));
    _expectRegisterRevert(
      address(adapter),
      address(pool),
      abi.encodeWithSelector(ILiquidityManager.PoolAlreadyRegistered.selector, address(pool), adapterId)
    );
  }

  function test_registerAdapter_revertsWhenSpecNotSet() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    CCIPPoolAdapter adapter2 = new CCIPPoolAdapter(address(manager), address(token), address(pool2));
    _handover(pool2, address(adapter2));
    registry.setPool(address(token), address(pool2));
    // Thresholds are checked before the pool checks, so they must be set to reach PoolSpecNotSet.
    _setThresholds(address(pool2));
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolSpecNotSet.selector, address(pool2))
    );
  }

  function test_registerAdapter_revertsOnAdapterBoundToOtherManager() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    CCIPPoolAdapter foreign = new CCIPPoolAdapter(makeAddr("otherManager"), address(token), address(pool2));
    _handover(pool2, address(foreign));
    _setSpec(address(pool2), _poolSpec());
    _setThresholds(address(pool2));
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool2), address(pool));
    _expectRegisterRevert(
      address(foreign),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.AdapterBindingMismatch.selector, address(foreign))
    );
  }

  function test_registerAdapter_revertsOnAdapterBoundToOtherToken() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    StubAdapter stub = new StubAdapter(address(manager), makeAddr("otherToken"), address(pool2));
    _handover(pool2, address(stub));
    _setSpec(address(pool2), _poolSpec());
    _setThresholds(address(pool2));
    _expectRegisterRevert(
      address(stub),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.AdapterBindingMismatch.selector, address(stub))
    );
  }

  function test_registerAdapter_revertsOnAdapterBoundToOtherPool() public {
    // pool2 is a real, handed-over pool; the fixture adapter is bound to the fixture pool.
    (MockLockReleaseTokenPool pool2,) = _validPool2();
    _expectRegisterRevert(
      address(adapter),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.AdapterBindingMismatch.selector, address(adapter))
    );
  }

  function test_registerAdapter_revertsForPoolWithoutCode() public {
    // A spec'd pool address without code is rejected before the adapter binding is read.
    address pool2 = makeAddr("pool2");
    _setSpec(pool2, _poolSpec());
    _setThresholds(pool2);
    _expectRegisterRevert(
      address(adapter), pool2, abi.encodeWithSelector(ILiquidityManager.NotAContract.selector, pool2)
    );
  }

  function test_registerAdapter_revertsOnPoolTokenMismatch() public {
    MockSahara otherToken = new MockSahara(treasury);
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(otherToken), router);
    StubAdapter stub = new StubAdapter(address(manager), address(token), address(pool2));
    _handover(pool2, address(stub));
    _setSpec(address(pool2), _poolSpec());
    _setThresholds(address(pool2));
    _expectRegisterRevert(
      address(stub),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolTokenMismatch.selector, address(pool2), address(otherToken))
    );
  }

  function test_registerAdapter_revertsForAdapterWithoutCode() public {
    // Previously the binding staticcall to an EOA reverted without data; now the Manager names the account.
    address eoa = makeAddr("eoaAdapter");
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    _setSpec(address(pool2), _poolSpec());
    _setThresholds(address(pool2));
    _expectRegisterRevert(eoa, address(pool2), abi.encodeWithSelector(ILiquidityManager.NotAContract.selector, eoa));
  }

  /// @dev pool2 is a fully valid, handed-over, spec'd and migration-approved pool; each test breaks one property.
  function _validPool2() internal returns (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) {
    pool2 = new MockLockReleaseTokenPool(address(token), router);
    adapter2 = _preparePool(pool2, true);
  }

  function test_registerAdapter_revertsOnVersionMismatch() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.prank(address(timelock));
    pool2.setTypeAndVersion("LockReleaseTokenPool 1.5.1");
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(
        ILiquidityManager.PoolVersionMismatch.selector, address(pool2), "LockReleaseTokenPool 1.5.1"
      )
    );
  }

  function test_registerAdapter_revertsWhenNotActiveInRegistry() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    CCIPPoolAdapter adapter2 = _preparePool(pool2, false);
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool2), address(pool))
    );
  }

  function test_registerAdapter_succeedsForRegistryPoolWithoutApproval() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    CCIPPoolAdapter adapter2 = _preparePool(pool2, false);
    registry.setPool(address(token), address(pool2));
    assertEq(_register(address(adapter2), address(pool2)), 2);
  }

  function test_registerAdapter_revertsOnRebalancerMismatch() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.prank(address(timelock));
    pool2.setRebalancer(attacker);
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, address(pool2), attacker)
    );
  }

  function test_registerAdapter_revertsOnRouterMismatch() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.prank(address(timelock));
    pool2.setRouter(otherRouter);
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, address(pool2), otherRouter)
    );
  }

  function test_registerAdapter_revertsWhenPoolHasNoChains() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.prank(address(timelock));
    pool2.removeChain(REMOTE_CHAIN_SELECTOR);
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, address(pool2))
    );
  }

  function test_registerAdapter_revertsWhenPoolHasTwoChains() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.prank(address(timelock));
    pool2.addChain(
      OTHER_CHAIN_SELECTOR,
      abi.encode(REMOTE_TOKEN),
      abi.encode(OTHER_REMOTE_POOL),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, address(pool2))
    );
  }

  function test_registerAdapter_revertsWhenPoolHasWrongChain() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.startPrank(address(timelock));
    pool2.removeChain(REMOTE_CHAIN_SELECTOR);
    pool2.addChain(
      OTHER_CHAIN_SELECTOR,
      abi.encode(REMOTE_TOKEN),
      abi.encode(REMOTE_POOL),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
    vm.stopPrank();
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, address(pool2))
    );
  }

  function test_registerAdapter_revertsOnRemoteTokenMismatch() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.prank(address(timelock));
    pool2.setRemoteToken(REMOTE_CHAIN_SELECTOR, abi.encode(attacker));
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolRemoteTokenMismatch.selector, address(pool2))
    );
  }

  function test_registerAdapter_revertsOnExtraRemotePool() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.prank(address(timelock));
    pool2.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool2))
    );
  }

  function test_registerAdapter_revertsOnDifferentRemotePool() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.startPrank(address(timelock));
    pool2.removeRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(REMOTE_POOL));
    pool2.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    vm.stopPrank();
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool2))
    );
  }

  function test_registerAdapter_revertsWhenPoolHasNoRemotePools() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.prank(address(timelock));
    pool2.removeRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(REMOTE_POOL));
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool2))
    );
  }

  function test_registerAdapter_revertsOnOwnerMismatch() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.prank(address(timelock));
    pool2.transferOwnership(attacker);
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, address(pool2), attacker)
    );
  }

  function test_registerAdapter_revertsOnRateLimitAdminMismatch() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.prank(address(timelock));
    pool2.setRateLimitAdmin(attacker);
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolRateLimitAdminMismatch.selector, address(pool2), attacker)
    );
  }

  function test_registerAdapter_assignsSequentialIdsAndEmits() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    (MockLockReleaseTokenPool pool3, CCIPPoolAdapter adapter3) = _validPool2();

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.AdapterRegistered(2, address(adapter2), address(pool2));
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.AdapterStatusSet(2, true, true);
    assertEq(_register(address(adapter2), address(pool2)), 2);

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.AdapterRegistered(3, address(adapter3), address(pool3));
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.AdapterStatusSet(3, true, true);
    assertEq(_register(address(adapter3), address(pool3)), 3);

    assertEq(manager.adapterCount(), 3);
    assertEq(manager.adapterIdByPool(address(pool2)), 2);
    assertEq(manager.adapterIdByPool(address(pool3)), 3);
    _assertAdapter(2, address(adapter2), address(pool2), true, true);
    _assertAdapter(3, address(adapter3), address(pool3), true, true);
    _assertAdapter(adapterId, address(adapter), address(pool), true, true);
  }

  function test_registerAdapter_failedRegistrationDoesNotConsumeId() public {
    (MockLockReleaseTokenPool pool2, CCIPPoolAdapter adapter2) = _validPool2();
    vm.prank(address(timelock));
    pool2.setRouter(otherRouter);
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, address(pool2), otherRouter)
    );
    vm.prank(address(timelock));
    pool2.setRouter(router);
    assertEq(_register(address(adapter2), address(pool2)), 2);
  }

  function test_registerAdapter_sameAdapterCannotServeTwoPools() public {
    (MockLockReleaseTokenPool pool2,) = _validPool2();
    vm.prank(address(timelock));
    pool2.setRebalancer(address(adapter));
    _expectRegisterRevert(
      address(adapter),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.AdapterBindingMismatch.selector, address(adapter))
    );
  }

  function test_registerAdapter_newAdapterIsUsable() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    (CCIPPoolAdapter adapter2, uint256 id2) = _registerPool(pool2);
    _fundAs(fundingOperator, id2, AMOUNT);
    _recallAs(recallOperator, id2, AMOUNT);
    assertEq(_balance(address(pool2)), POOL_INVENTORY);
    assertEq(_balance(address(adapter2)), 0);
  }

  function test_registerAdapter_throughTimelock() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    CCIPPoolAdapter adapter2 = _preparePool(pool2, true);
    _scheduleAndExecute(
      address(manager),
      abi.encodeCall(LiquidityManager.registerAdapter, (address(adapter2), address(pool2))),
      bytes32("register")
    );
    assertEq(manager.adapterIdByPool(address(pool2)), 2);
  }

  // ================================================================
  // │                        replaceAdapter                        │
  // ================================================================

  function _newAdapter() internal returns (CCIPPoolAdapter) {
    return new CCIPPoolAdapter(address(manager), address(token), address(pool));
  }

  function _replace(uint256 id, address newAdapter) internal {
    vm.prank(address(timelock));
    manager.replaceAdapter(id, newAdapter);
  }

  function test_replaceAdapter_revertsOnUnknownId() public {
    CCIPPoolAdapter next = _newAdapter();
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 0));
    _replace(0, address(next));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 2));
    _replace(2, address(next));
  }

  function test_replaceAdapter_revertsWhenUnchanged() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.AdapterUnchanged.selector, address(adapter)));
    _replace(adapterId, address(adapter));
  }

  function test_replaceAdapter_revertsWhenNewAdapterBoundToOtherPool() public {
    // adapter2 is bound to (and the rebalancer of) pool2.
    (, CCIPPoolAdapter adapter2) = _validPool2();
    vm.prank(address(timelock));
    pool.setRebalancer(address(adapter2));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.AdapterBindingMismatch.selector, address(adapter2)));
    _replace(adapterId, address(adapter2));
    _assertAdapter(adapterId, address(adapter), address(pool), true, true);
  }

  function test_replaceAdapter_revertsWhenNewAdapterBoundToOtherManager() public {
    CCIPPoolAdapter foreign = new CCIPPoolAdapter(makeAddr("otherManager"), address(token), address(pool));
    vm.prank(address(timelock));
    pool.setRebalancer(address(foreign));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.AdapterBindingMismatch.selector, address(foreign)));
    _replace(adapterId, address(foreign));
  }

  function test_replaceAdapter_revertsWhenRebalancerNotYetMoved() public {
    CCIPPoolAdapter next = _newAdapter();
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, address(pool), address(adapter))
    );
    _replace(adapterId, address(next));
    _assertAdapter(adapterId, address(adapter), address(pool), true, true);
  }

  function test_replaceAdapter_revertsOnZeroAddress() public {
    // Explicit endpoint validation now rejects address(0) with ZeroAddress (previously a data-less decode revert).
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    _replace(adapterId, address(0));
    _assertAdapter(adapterId, address(adapter), address(pool), true, true);
  }

  function test_replaceAdapter_revertsForAdapterWithoutCode() public {
    address eoa = makeAddr("eoaAdapter");
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.NotAContract.selector, eoa));
    _replace(adapterId, eoa);
    _assertAdapter(adapterId, address(adapter), address(pool), true, true);
  }

  function test_replaceAdapter_revertsWhenPoolDrifted() public {
    CCIPPoolAdapter next = _newAdapter();
    vm.startPrank(address(timelock));
    pool.setRebalancer(address(next));
    pool.setTypeAndVersion("LockReleaseTokenPool 1.7.0");
    vm.expectRevert(
      abi.encodeWithSelector(
        ILiquidityManager.PoolVersionMismatch.selector, address(pool), "LockReleaseTokenPool 1.7.0"
      )
    );
    manager.replaceAdapter(adapterId, address(next));
    vm.stopPrank();
  }

  function test_replaceAdapter_retiredPoolRequiresMigrationApproval() public {
    address successorPool = makeAddr("successorPool");
    registry.setPool(address(token), successorPool);
    CCIPPoolAdapter next = _newAdapter();
    vm.prank(address(timelock));
    pool.setRebalancer(address(next));

    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), successorPool)
    );
    _replace(adapterId, address(next));

    vm.startPrank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), successorPool);
    manager.replaceAdapter(adapterId, address(next));
    vm.stopPrank();
    assertEq(manager.getAdapter(adapterId).adapter, address(next));
  }

  function test_replaceAdapter_succeedsAndEmits() public {
    CCIPPoolAdapter next = _newAdapter();
    vm.prank(address(timelock));
    pool.setRebalancer(address(next));

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.AdapterReplaced(adapterId, address(adapter), address(next));
    _replace(adapterId, address(next));

    _assertAdapter(adapterId, address(next), address(pool), true, true);
    assertEq(manager.adapterIdByPool(address(pool)), adapterId);
    assertEq(manager.adapterCount(), 1, "no new id");
    manager.verifyAdapter(adapterId);
  }

  function test_replaceAdapter_keepsStatusFlags() public {
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, true, false);
    CCIPPoolAdapter next = _newAdapter();
    _installAdapter(address(next));

    _assertAdapter(adapterId, address(next), address(pool), false, true);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.FundingDisabled.selector, adapterId));
    _fund(AMOUNT);
    _recall(AMOUNT);
  }

  function test_replaceAdapter_keepsRecallDisabled() public {
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, false, true);
    _installAdapter(address(_newAdapter()));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RecallDisabled.selector, adapterId));
    _recall(AMOUNT);
  }

  function test_replaceAdapter_keepsBudgets() public {
    _fund(MAX_FUNDING_PER_CALL);
    _recall(AMOUNT);
    ILiquidityManager.BudgetState memory aggregate = manager.getAggregateFundingBudget();
    ILiquidityManager.BudgetState memory poolBudget = manager.getPoolFundingBudget(address(pool));
    ILiquidityManager.BudgetState memory recallBudget = manager.getRecallBudget();

    _installAdapter(address(_newAdapter()));

    assertEq(manager.getAggregateFundingBudget().available, aggregate.available);
    assertEq(manager.getPoolFundingBudget(address(pool)).available, poolBudget.available);
    assertEq(manager.getRecallBudget().available, recallBudget.available);
    assertEq(poolBudget.available, POOL_FUNDING_CAPACITY - MAX_FUNDING_PER_CALL);

    // The remaining pool budget still binds the new adapter.
    _fund(MAX_FUNDING_PER_CALL);
    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1, 0));
    _fund(1);
  }

  function test_replaceAdapter_oldAdapterIsInert() public {
    CCIPPoolAdapter next = _newAdapter();
    _installAdapter(address(next));

    // Operations route through the new adapter only.
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Recalled(adapterId, address(pool), recallOperator, address(next), AMOUNT);
    _recall(AMOUNT);
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Funded(adapterId, address(pool), fundingOperator, address(next), AMOUNT);
    _fund(AMOUNT);

    // The old adapter accepts calls only from the Manager, and the pool no longer accepts it as rebalancer.
    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, attacker));
    vm.prank(attacker);
    adapter.recall(AMOUNT);
    vm.expectRevert(abi.encodeWithSelector(MockLockReleaseTokenPool.Unauthorized.selector, address(adapter)));
    vm.prank(address(manager));
    adapter.recall(AMOUNT);
    vm.expectRevert(abi.encodeWithSelector(MockLockReleaseTokenPool.Unauthorized.selector, address(adapter)));
    vm.prank(address(adapter));
    pool.withdrawLiquidity(AMOUNT);
  }

  function test_replaceAdapter_canSwitchBack() public {
    CCIPPoolAdapter next = _newAdapter();
    _installAdapter(address(next));
    _installAdapter(address(adapter));
    _assertAdapter(adapterId, address(adapter), address(pool), true, true);
    _recall(AMOUNT);
  }

  /// @dev Documents a limitation: once a retired pool no longer supports any chain, no valid spec can match it
  /// (`setPoolSpec` requires a non-zero selector and `_verifyPool` exactly one supported chain), so its adapter can
  /// never be replaced. Recall through the existing adapter keeps working, and the pool owner retains
  /// `setRebalancer`/`transferLiquidity` as a fallback.
  function test_replaceAdapter_impossibleForPoolWithoutChains_recallStillWorks() public {
    address successorPool = makeAddr("successorPool");
    registry.setPool(address(token), successorPool);
    vm.startPrank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), successorPool);
    pool.removeChain(REMOTE_CHAIN_SELECTOR);
    vm.stopPrank();

    CCIPPoolAdapter next = _newAdapter();
    vm.prank(address(timelock));
    pool.setRebalancer(address(next));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, address(pool)));
    _replace(adapterId, address(next));

    // Restore the rebalancer: recall through the registered adapter still drains the retired pool to its minimum.
    vm.prank(address(timelock));
    pool.setRebalancer(address(adapter));
    _recall(AMOUNT);
    assertEq(_balance(address(pool)), POOL_INVENTORY - AMOUNT);
  }

  /// @dev Registration now requires thresholds set by the owner (previously a pool registered without them silently
  /// had minimum 0). A zero minimum is still possible, but only as an explicit owner choice, and then the pool can be
  /// recalled to zero (bounded only by the recall limits).
  function test_registerAdapter_withoutThresholdsReverts_explicitZeroMinimumAllowed() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    CCIPPoolAdapter adapter2 = new CCIPPoolAdapter(address(manager), address(token), address(pool2));
    _handover(pool2, address(adapter2));
    vm.startPrank(address(timelock));
    manager.setPoolSpec(address(pool2), _poolSpec());
    manager.setPoolMigrationApproval(address(pool2), address(pool));
    vm.stopPrank();

    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolThresholdsNotSet.selector, address(pool2))
    );

    vm.prank(address(timelock));
    manager.setPoolThresholds(address(pool2), 0, 0, 0);
    (ILiquidityManager.PoolThresholds memory t, bool isSet) = manager.getPoolThresholds(address(pool2));
    assertTrue(isSet);
    assertEq(t.minimum, 0);
    uint256 id2 = _register(address(adapter2), address(pool2));
    _seed(address(pool2), AMOUNT);
    _recallAs(recallOperator, id2, AMOUNT);
    assertEq(_balance(address(pool2)), 0);
  }

  // ================================================================
  // │                       setAdapterStatus                       │
  // ================================================================

  function test_setAdapterStatus_revertsOnUnknownId() public {
    vm.startPrank(address(timelock));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 0));
    manager.setAdapterStatus(0, true, true);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 2));
    manager.setAdapterStatus(2, true, true);
    vm.stopPrank();
  }

  function test_setAdapterStatus_setsAllCombinationsAndEmits() public {
    for (uint256 i = 0; i < 4; ++i) {
      bool fundingEnabled = i & 1 == 1;
      bool recallEnabled = i & 2 == 2;
      vm.expectEmit(true, true, true, true, address(manager));
      emit ILiquidityManager.AdapterStatusSet(adapterId, fundingEnabled, recallEnabled);
      vm.prank(address(timelock));
      manager.setAdapterStatus(adapterId, fundingEnabled, recallEnabled);
      _assertAdapter(adapterId, address(adapter), address(pool), fundingEnabled, recallEnabled);
    }
  }

  function test_setAdapterStatus_reactivatesAfterGuardianRestriction() public {
    vm.prank(guardian);
    manager.restrictAdapter(adapterId, true, true);
    vm.prank(address(timelock));
    manager.setAdapterStatus(adapterId, true, true);
    _fund(AMOUNT);
    _recall(AMOUNT);
  }

  function test_setAdapterStatus_disablingFundingBlocksFund() public {
    vm.prank(address(timelock));
    manager.setAdapterStatus(adapterId, false, true);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.FundingDisabled.selector, adapterId));
    _fund(AMOUNT);
  }

  // ================================================================
  // │                            Views                             │
  // ================================================================

  function test_getAdapter_returnsEntry() public view {
    _assertAdapter(adapterId, address(adapter), address(pool), true, true);
    assertEq(adapterId, 1);
    assertEq(manager.adapterIdByPool(address(pool)), 1);
  }

  function test_getAdapter_revertsOnUnknownId() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 0));
    manager.getAdapter(0);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 2));
    manager.getAdapter(2);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, type(uint256).max));
    manager.getAdapter(type(uint256).max);
  }

  function test_adapterIdByPool_unknownIsZero() public {
    assertEq(manager.adapterIdByPool(makeAddr("unknown")), 0);
    assertEq(manager.adapterIdByPool(address(0)), 0);
  }

  function test_budgetGetters_reflectConfigAndUsage() public {
    _fund(AMOUNT);
    _recall(2 * AMOUNT);
    ILiquidityManager.BudgetState memory aggregate = manager.getAggregateFundingBudget();
    assertEq(aggregate.capacity, AGGREGATE_FUNDING_CAPACITY);
    assertEq(aggregate.rate, AGGREGATE_FUNDING_RATE);
    assertEq(aggregate.available, AGGREGATE_FUNDING_CAPACITY - AMOUNT);
    ILiquidityManager.BudgetState memory poolBudget = manager.getPoolFundingBudget(address(pool));
    assertEq(poolBudget.capacity, POOL_FUNDING_CAPACITY);
    assertEq(poolBudget.rate, POOL_FUNDING_RATE);
    assertEq(poolBudget.available, POOL_FUNDING_CAPACITY - AMOUNT);
    ILiquidityManager.BudgetState memory recallBudget = manager.getRecallBudget();
    assertEq(recallBudget.capacity, RECALL_CAPACITY);
    assertEq(recallBudget.rate, RECALL_RATE);
    assertEq(recallBudget.available, RECALL_CAPACITY - 2 * AMOUNT);

    vm.warp(block.timestamp + 60);
    assertEq(
      manager.getAggregateFundingBudget().available, AGGREGATE_FUNDING_CAPACITY - AMOUNT + 60 * AGGREGATE_FUNDING_RATE
    );
    assertEq(
      manager.getPoolFundingBudget(address(pool)).available, POOL_FUNDING_CAPACITY - AMOUNT + 60 * POOL_FUNDING_RATE
    );
    assertEq(manager.getRecallBudget().available, RECALL_CAPACITY - 2 * AMOUNT + 60 * RECALL_RATE);
  }

  function test_budgetGetters_unconfiguredPoolIsZero() public {
    ILiquidityManager.BudgetState memory state = manager.getPoolFundingBudget(makeAddr("unknown"));
    assertEq(state.capacity, 0);
    assertEq(state.rate, 0);
    assertEq(state.available, 0);
  }

  function test_verifyAdapter_passesForFixture() public view {
    manager.verifyAdapter(adapterId);
  }

  function test_verifyAdapter_revertsOnUnknownId() public {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 0));
    manager.verifyAdapter(0);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 2));
    manager.verifyAdapter(2);
  }

  function test_verifyAdapter_reportsFirstMismatch() public {
    vm.startPrank(address(timelock));
    pool.setRateLimitAdmin(attacker);
    pool.transferOwnership(attacker);
    vm.stopPrank();
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, address(pool), attacker));
    manager.verifyAdapter(adapterId);

    vm.prank(attacker);
    pool.setTypeAndVersion("LockReleaseTokenPool 9.9.9");
    vm.expectRevert(
      abi.encodeWithSelector(
        ILiquidityManager.PoolVersionMismatch.selector, address(pool), "LockReleaseTokenPool 9.9.9"
      )
    );
    manager.verifyAdapter(adapterId);
  }

  function test_verifyAdapter_callableByAnyone() public {
    vm.prank(attacker);
    manager.verifyAdapter(adapterId);
  }

  // ================================================================
  // │                           Helpers                            │
  // ================================================================

  function _assertAdapter(
    uint256 id,
    address expectedAdapter,
    address expectedPool,
    bool fundingEnabled,
    bool recallEnabled
  ) internal view {
    ILiquidityManager.Adapter memory entry = manager.getAdapter(id);
    assertEq(entry.adapter, expectedAdapter, "adapter");
    assertEq(entry.pool, expectedPool, "pool");
    assertEq(entry.fundingEnabled, fundingEnabled, "fundingEnabled");
    assertEq(entry.recallEnabled, recallEnabled, "recallEnabled");
  }

  function _assertSpecEq(ILiquidityManager.PoolSpec memory a, ILiquidityManager.PoolSpec memory b) internal pure {
    assertEq(a.typeAndVersion, b.typeAndVersion, "typeAndVersion");
    assertEq(a.router, b.router, "router");
    assertEq(a.remoteChainSelector, b.remoteChainSelector, "remoteChainSelector");
    assertEq(a.remoteToken, b.remoteToken, "remoteToken");
    assertEq(a.remotePools.length, b.remotePools.length, "remotePools.length");
    for (uint256 i = 0; i < a.remotePools.length; ++i) {
      assertEq(a.remotePools[i], b.remotePools[i], "remotePools[i]");
    }
    assertEq(a.rateLimitAdmin, b.rateLimitAdmin, "rateLimitAdmin");
  }
}
