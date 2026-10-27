// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";
import {RecallAdminBase} from "test/recall-admin/RecallAdminBase.sol";
import {StubAdapter} from "test/recall-admin/mocks/StubAdapter.sol";

/// @notice Regression tests for the second review round: registration prerequisites and check order, endpoint
/// validation, the token/registry handover checks, migration approvals bound to a source pool, adapter history,
/// reserve-migration destinations and `type(uint256).max`, and the Guardian/operator separation.
contract RecallAdminRegressionTest is RecallAdminBase {
  uint256 internal constant AMOUNT = 10_000_000e18;

  address internal pendingAdmin = makeAddr("pendingAdmin");
  address internal successor = makeAddr("successorManager");
  address internal newOwner = makeAddr("newOwner");

  /// @dev A pool ready for registration and a replacement adapter for the fixture pool that already holds the pool's
  /// rebalancer role, so registration and replacement can only fail on the handover checks.
  struct HandoverTargets {
    MockLockReleaseTokenPool pool2;
    CCIPPoolAdapter adapter2;
    CCIPPoolAdapter next;
  }

  // ================================================================
  // │                           Helpers                            │
  // ================================================================

  function _register(address adapter_, address pool_) internal returns (uint256) {
    vm.prank(address(timelock));
    return manager.registerAdapter(adapter_, pool_);
  }

  function _replace(uint256 id, address newAdapter) internal {
    vm.prank(address(timelock));
    manager.replaceAdapter(id, newAdapter);
  }

  /// @dev Expects `registerAdapter` to revert with exactly `err` and leave the registry untouched.
  function _expectRegisterRevert(address adapter_, address pool_, bytes memory err) internal {
    uint256 count = manager.adapterCount();
    uint256 historyLength = manager.getAdapterHistory().length;
    uint256 existingId = manager.adapterIdByPool(pool_);
    vm.expectRevert(err);
    vm.prank(address(timelock));
    manager.registerAdapter(adapter_, pool_);
    assertEq(manager.adapterCount(), count, "adapterCount");
    assertEq(manager.getAdapterHistory().length, historyLength, "history");
    assertEq(manager.adapterIdByPool(pool_), existingId, "adapterIdByPool");
  }

  /// @dev Expects `replaceAdapter` to revert with exactly `err` and leave the entry and history untouched.
  function _expectReplaceRevert(uint256 id, address newAdapter, bytes memory err) internal {
    uint256 historyLength = manager.getAdapterHistory().length;
    vm.expectRevert(err);
    _replace(id, newAdapter);
    assertEq(manager.getAdapter(adapterId).adapter, address(adapter), "fixture adapter replaced");
    assertEq(manager.getAdapterHistory().length, historyLength, "history");
  }

  function _setThresholds(address pool_) internal {
    vm.prank(address(timelock));
    manager.setPoolThresholds(pool_, POOL_MINIMUM, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET);
  }

  function _setSpec(address pool_) internal {
    vm.prank(address(timelock));
    manager.setPoolSpec(pool_, _poolSpec());
  }

  function _migrate(address to, uint256 amount) internal {
    vm.prank(address(timelock));
    manager.migrateReserves(to, amount);
  }

  function _expectInvalidDestination(address to) internal {
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidMigrationDestination.selector, to));
    _migrate(to, AMOUNT);
  }

  function _handoverTargets() internal returns (HandoverTargets memory t) {
    t.pool2 = new MockLockReleaseTokenPool(address(token), router);
    t.adapter2 = _preparePool(t.pool2, true);
    t.next = new CCIPPoolAdapter(address(manager), address(token), address(pool));
    vm.prank(address(timelock));
    pool.setRebalancer(address(t.next));
  }

  /// @dev `verifyHandover` and `registerAdapter` revert with exactly `err`; `replaceAdapter` deliberately does not
  /// depend on the handover state, so an emergency replacement still succeeds (checked on a state snapshot).
  function _assertHandoverBlocks(HandoverTargets memory t, bytes memory err) internal {
    vm.expectRevert(err);
    manager.verifyHandover();
    _expectRegisterRevert(address(t.adapter2), address(t.pool2), err);

    uint256 snapshot = vm.snapshotState();
    _replace(adapterId, address(t.next));
    assertEq(manager.getAdapter(adapterId).adapter, address(t.next), "replaceAdapter ignores handover state");
    vm.revertToState(snapshot);
  }

  function _assertHandoverPasses(HandoverTargets memory t) internal {
    manager.verifyHandover();
    assertEq(_register(address(t.adapter2), address(t.pool2)), 2);
    _replace(adapterId, address(t.next));
    assertEq(manager.getAdapter(adapterId).adapter, address(t.next));
  }

  /// @dev Breaks all three handover conditions at once.
  function _breakHandover() internal {
    registry.setAdministrator(address(token), attacker);
    registry.setPendingAdministrator(address(token), pendingAdmin);
    vm.prank(address(timelock));
    token.transferOwnership(attacker);
  }

  function _assertBudget(ILiquidityManager.BudgetState memory actual, uint256 capacity, uint256 rate, uint256 available)
    internal
    pure
  {
    assertEq(actual.capacity, capacity, "capacity");
    assertEq(actual.rate, rate, "rate");
    assertEq(actual.available, available, "available");
  }

  // ================================================================
  // │           registerAdapter: thresholds and check order        │
  // ================================================================

  function test_regression_registerAdapter_requiresThresholds() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    CCIPPoolAdapter adapter2 = new CCIPPoolAdapter(address(manager), address(token), address(pool2));
    _handover(pool2, address(adapter2));
    vm.startPrank(address(timelock));
    manager.setPoolSpec(address(pool2), _poolSpec());
    manager.setPoolMigrationApproval(address(pool2), address(pool));
    vm.stopPrank();

    (, bool isSet) = manager.getPoolThresholds(address(pool2));
    assertFalse(isSet);
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolThresholdsNotSet.selector, address(pool2))
    );

    _setThresholds(address(pool2));
    assertEq(_register(address(adapter2), address(pool2)), 2);
  }

  /// @dev A Guardian-raised minimum writes the thresholds struct but does not mark it set: only the owner can satisfy
  /// the registration prerequisite.
  function test_regression_registerAdapter_guardianRaisedMinimumDoesNotSatisfyThresholds() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    CCIPPoolAdapter adapter2 = new CCIPPoolAdapter(address(manager), address(token), address(pool2));
    _handover(pool2, address(adapter2));
    _setSpec(address(pool2));
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool2), address(pool));

    vm.prank(guardian);
    manager.raisePoolMinimum(address(pool2), POOL_MINIMUM);
    (ILiquidityManager.PoolThresholds memory t, bool isSet) = manager.getPoolThresholds(address(pool2));
    assertFalse(isSet);
    assertEq(t.minimum, POOL_MINIMUM);
    assertEq(t.refillTrigger, 0);
    assertEq(t.refillTarget, 0);

    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolThresholdsNotSet.selector, address(pool2))
    );
  }

  /// @dev registerAdapter: endpoints -> PoolAlreadyRegistered -> PoolThresholdsNotSet -> handover (registry admin,
  /// pending admin, token owner) -> pool checks (spec, code, bindings, ..., remote pools, owner, rate limit admin).
  /// Every condition starts broken and is fixed one at a time.
  function test_regression_registerAdapter_checkOrder() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    CCIPPoolAdapter adapter2 = new CCIPPoolAdapter(address(manager), address(token), address(pool2));
    _breakHandover();

    // Endpoint validation precedes the duplicate-pool check.
    _expectRegisterRevert(address(0), address(pool), abi.encodeWithSelector(ILiquidityManager.ZeroAddress.selector));
    _expectRegisterRevert(
      address(pool), address(pool), abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, address(pool))
    );
    // The duplicate-pool check precedes the handover and pool checks (adapter2 is also bound to another pool).
    _expectRegisterRevert(
      address(adapter2),
      address(pool),
      abi.encodeWithSelector(ILiquidityManager.PoolAlreadyRegistered.selector, address(pool), adapterId)
    );
    // Thresholds precede the handover and the spec.
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolThresholdsNotSet.selector, address(pool2))
    );
    _setThresholds(address(pool2));

    // Handover precedes the pool checks (spec still unset), in the order registry admin, pending admin, token owner.
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, attacker)
    );
    registry.setAdministrator(address(token), address(timelock));
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.RegistryAdminTransferPending.selector, pendingAdmin)
    );
    registry.setPendingAdministrator(address(token), address(0));
    _expectRegisterRevert(
      address(adapter2), address(pool2), abi.encodeWithSelector(ILiquidityManager.TokenOwnerMismatch.selector, attacker)
    );
    vm.prank(attacker);
    token.transferOwnership(address(timelock));

    // Pool checks.
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolSpecNotSet.selector, address(pool2))
    );
    _setSpec(address(pool2));
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool2), address(pool))
    );
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool2), address(pool));
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, address(pool2), address(0))
    );
    pool2.setRebalancer(address(adapter2));
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, address(pool2))
    );
    pool2.addChain(
      REMOTE_CHAIN_SELECTOR,
      abi.encode(REMOTE_TOKEN),
      abi.encode(REMOTE_POOL),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
    pool2.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    // Owner and rate limit admin are both wrong as well: the remote pools come first.
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool2))
    );
    pool2.removeRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    // The pool owner is compared with the Manager's owner, before the rate limit admin.
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, address(pool2), address(this))
    );
    pool2.transferOwnership(address(timelock));
    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolRateLimitAdminMismatch.selector, address(pool2), address(0))
    );
    vm.prank(address(timelock));
    pool2.setRateLimitAdmin(address(controller));

    assertEq(_register(address(adapter2), address(pool2)), 2);
  }

  /// @dev Inside the pool checks: PoolSpecNotSet -> NotAContract(adapter) -> NotAContract(pool) -> bindings.
  function test_regression_registerAdapter_codeChecksOrder() public {
    address eoaAdapter = makeAddr("eoaAdapter");
    address eoaPool = makeAddr("eoaPool");
    _setThresholds(eoaPool);

    _expectRegisterRevert(
      eoaAdapter, eoaPool, abi.encodeWithSelector(ILiquidityManager.PoolSpecNotSet.selector, eoaPool)
    );
    _setSpec(eoaPool);
    _expectRegisterRevert(
      eoaAdapter, eoaPool, abi.encodeWithSelector(ILiquidityManager.NotAContract.selector, eoaAdapter)
    );
    StubAdapter stub = new StubAdapter(address(manager), address(token), eoaPool);
    _expectRegisterRevert(
      address(stub), eoaPool, abi.encodeWithSelector(ILiquidityManager.NotAContract.selector, eoaPool)
    );
  }

  // ================================================================
  // │                    Endpoint validation                       │
  // ================================================================

  function test_regression_registerAdapter_validateEndpoints() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    CCIPPoolAdapter adapter2 = _preparePool(pool2, true);
    address self = address(manager);
    address tkn = address(token);
    bytes memory zero = abi.encodeWithSelector(ILiquidityManager.ZeroAddress.selector);

    // adapter == pool, adapter == manager, adapter == token.
    _expectRegisterRevert(
      address(pool2), address(pool2), abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, address(pool2))
    );
    _expectRegisterRevert(
      self, address(pool2), abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, self)
    );
    _expectRegisterRevert(tkn, address(pool2), abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, tkn));
    // pool == manager, pool == token.
    _expectRegisterRevert(
      address(adapter2), self, abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, self)
    );
    _expectRegisterRevert(
      address(adapter2), tkn, abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, tkn)
    );
    // Zero addresses.
    _expectRegisterRevert(address(0), address(pool2), zero);
    _expectRegisterRevert(address(adapter2), address(0), zero);
    _expectRegisterRevert(address(0), address(0), zero);

    // Precedence: zero first, then the adapter, then the pool.
    _expectRegisterRevert(address(0), self, zero);
    _expectRegisterRevert(self, address(0), zero);
    _expectRegisterRevert(tkn, self, abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, tkn));
    _expectRegisterRevert(self, self, abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, self));
    _expectRegisterRevert(tkn, tkn, abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, tkn));

    // pool2 is otherwise valid.
    assertEq(_register(address(adapter2), address(pool2)), 2);
  }

  function test_regression_replaceAdapter_validateEndpoints() public {
    _expectReplaceRevert(adapterId, address(0), abi.encodeWithSelector(ILiquidityManager.ZeroAddress.selector));
    _expectReplaceRevert(
      adapterId, address(pool), abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, address(pool))
    );
    _expectReplaceRevert(
      adapterId, address(manager), abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, address(manager))
    );
    _expectReplaceRevert(
      adapterId, address(token), abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, address(token))
    );

    CCIPPoolAdapter next = new CCIPPoolAdapter(address(manager), address(token), address(pool));
    _installAdapter(address(next));
    assertEq(manager.getAdapter(adapterId).adapter, address(next));
  }

  /// @dev replaceAdapter: UnknownAdapter -> AdapterUnchanged -> endpoints -> pool checks. The launch-time handover
  /// check is deliberately not part of it, so broken handover state does not block an emergency replacement.
  function test_regression_replaceAdapter_checkOrder() public {
    CCIPPoolAdapter next = new CCIPPoolAdapter(address(manager), address(token), address(pool));
    _breakHandover();

    _expectReplaceRevert(99, address(0), abi.encodeWithSelector(ILiquidityManager.UnknownAdapter.selector, 99));
    _expectReplaceRevert(
      adapterId, address(adapter), abi.encodeWithSelector(ILiquidityManager.AdapterUnchanged.selector, address(adapter))
    );
    _expectReplaceRevert(adapterId, address(0), abi.encodeWithSelector(ILiquidityManager.ZeroAddress.selector));
    _expectReplaceRevert(
      adapterId, address(pool), abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, address(pool))
    );
    // The rebalancer has not moved to `next` yet: the pool checks reject it, regardless of the handover state.
    _expectReplaceRevert(
      adapterId,
      address(next),
      abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, address(pool), address(adapter))
    );

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, attacker));
    manager.verifyHandover();
    _installAdapter(address(next));
    assertEq(manager.getAdapter(adapterId).adapter, address(next));
  }

  // ================================================================
  // │                        Handover checks                       │
  // ================================================================

  function test_regression_verifyHandover_passesForFixtureAndIsPublic() public {
    manager.verifyHandover();
    vm.prank(attacker);
    manager.verifyHandover();
  }

  function test_regression_handover_registryAdminMismatch() public {
    HandoverTargets memory t = _handoverTargets();
    registry.setAdministrator(address(token), attacker);
    _assertHandoverBlocks(t, abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, attacker));
    registry.setAdministrator(address(token), address(0));
    _assertHandoverBlocks(t, abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, address(0)));

    registry.setAdministrator(address(token), address(timelock));
    _assertHandoverPasses(t);
  }

  function test_regression_handover_registryAdminTransferPending() public {
    HandoverTargets memory t = _handoverTargets();
    // E.g. the Timelock has called transferAdminRole, or the legacy multisig's transfer was never accepted.
    registry.setPendingAdministrator(address(token), pendingAdmin);
    _assertHandoverBlocks(
      t, abi.encodeWithSelector(ILiquidityManager.RegistryAdminTransferPending.selector, pendingAdmin)
    );
    // A pending transfer to the Timelock itself still counts as pending.
    registry.setPendingAdministrator(address(token), address(timelock));
    _assertHandoverBlocks(
      t, abi.encodeWithSelector(ILiquidityManager.RegistryAdminTransferPending.selector, address(timelock))
    );

    registry.setPendingAdministrator(address(token), address(0));
    _assertHandoverPasses(t);
  }

  function test_regression_handover_tokenOwnerMismatch() public {
    HandoverTargets memory t = _handoverTargets();
    vm.prank(address(timelock));
    token.transferOwnership(attacker);
    _assertHandoverBlocks(t, abi.encodeWithSelector(ILiquidityManager.TokenOwnerMismatch.selector, attacker));

    vm.prank(attacker);
    token.transferOwnership(address(timelock));
    _assertHandoverPasses(t);
  }

  function test_regression_handover_renouncedTokenOwnership() public {
    HandoverTargets memory t = _handoverTargets();
    vm.prank(address(timelock));
    token.renounceOwnership();
    _assertHandoverBlocks(t, abi.encodeWithSelector(ILiquidityManager.TokenOwnerMismatch.selector, address(0)));
  }

  /// @dev The legacy state before handover: the legacy multisig administers the registry entry and owns the token.
  function test_regression_handover_legacyStateBlocksRegistration() public {
    address legacy = makeAddr("legacyMultisig");
    HandoverTargets memory t = _handoverTargets();
    registry.setAdministrator(address(token), legacy);
    registry.setPendingAdministrator(address(token), address(timelock));
    vm.prank(address(timelock));
    token.transferOwnership(legacy);
    _assertHandoverBlocks(t, abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, legacy));

    // registry.acceptAdminRole(token) by the Timelock.
    registry.setAdministrator(address(token), address(timelock));
    registry.setPendingAdministrator(address(token), address(0));
    _assertHandoverBlocks(t, abi.encodeWithSelector(ILiquidityManager.TokenOwnerMismatch.selector, legacy));

    // token.transferOwnership(timelock) by the legacy multisig (single-step).
    vm.prank(legacy);
    token.transferOwnership(address(timelock));
    _assertHandoverPasses(t);
  }

  /// @dev The handover authorities are compared with the Manager's current owner.
  function test_regression_handover_followsManagerOwner() public {
    vm.prank(address(timelock));
    manager.transferOwnership(newOwner);
    manager.verifyHandover(); // pending: the Timelock is still the owner
    vm.prank(newOwner);
    manager.acceptOwnership();

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, address(timelock)));
    manager.verifyHandover();
    registry.setAdministrator(address(token), newOwner);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.TokenOwnerMismatch.selector, address(timelock)));
    manager.verifyHandover();
    vm.prank(address(timelock));
    token.transferOwnership(newOwner);
    manager.verifyHandover();
  }

  /// @dev By design the handover is checked on (re)registration only: routine fund and recall keep working.
  function test_regression_handover_notCheckedOnFundOrRecall() public {
    _breakHandover();
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, attacker));
    manager.verifyHandover();
    manager.verifyAdapter(adapterId);
    _fund(AMOUNT);
    _recall(AMOUNT);
    assertEq(_balance(address(pool)), POOL_INVENTORY);
  }

  // ================================================================
  // │                       getPoolThresholds                      │
  // ================================================================

  function test_regression_getPoolThresholds_returnsIsSet() public {
    address pool2 = makeAddr("pool2");
    (ILiquidityManager.PoolThresholds memory t, bool isSet) = manager.getPoolThresholds(pool2);
    assertFalse(isSet);
    assertEq(t.minimum, 0);
    assertEq(t.refillTrigger, 0);
    assertEq(t.refillTarget, 0);

    // All-zero thresholds set by the owner are distinguishable from unset ones.
    vm.prank(address(timelock));
    manager.setPoolThresholds(pool2, 0, 0, 0);
    (t, isSet) = manager.getPoolThresholds(pool2);
    assertTrue(isSet);
    assertEq(t.minimum, 0);
    assertEq(t.refillTrigger, 0);
    assertEq(t.refillTarget, 0);

    // A later Guardian raise keeps them set.
    vm.prank(guardian);
    manager.raisePoolMinimum(pool2, 5);
    (t, isSet) = manager.getPoolThresholds(pool2);
    assertTrue(isSet);
    assertEq(t.minimum, 5);

    (t, isSet) = manager.getPoolThresholds(address(pool));
    assertTrue(isSet);
    assertEq(t.minimum, POOL_MINIMUM);
    assertEq(t.refillTrigger, POOL_REFILL_TRIGGER);
    assertEq(t.refillTarget, POOL_REFILL_TARGET);
  }

  // ================================================================
  // │                Migration approval (source pool)              │
  // ================================================================

  function test_regression_setPoolMigrationApproval_revertsWhenSourceIsPool() public {
    address pool2 = makeAddr("pool2");
    vm.startPrank(address(timelock));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, pool2));
    manager.setPoolMigrationApproval(pool2, pool2);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, address(pool)));
    manager.setPoolMigrationApproval(address(pool), address(pool));
    vm.stopPrank();
    assertEq(manager.getPoolMigrationSource(pool2), address(0));
    assertEq(manager.getPoolMigrationSource(address(pool)), address(0));
  }

  function test_regression_setPoolMigrationApproval_revertsOnZeroPool() public {
    vm.startPrank(address(timelock));
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    manager.setPoolMigrationApproval(address(0), address(pool));
    // The zero-pool check precedes the source == pool check.
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    manager.setPoolMigrationApproval(address(0), address(0));
    vm.stopPrank();
    assertEq(manager.getPoolMigrationSource(address(0)), address(0));
  }

  function test_regression_getPoolMigrationSource_lifecycle() public {
    address pool2 = makeAddr("pool2");
    address pool3 = makeAddr("pool3");
    assertEq(manager.getPoolMigrationSource(pool2), address(0));

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(pool2, address(pool));
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(pool2, address(pool));
    assertEq(manager.getPoolMigrationSource(pool2), address(pool));

    // Overwritten by a later approval.
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(pool2, pool3);
    assertEq(manager.getPoolMigrationSource(pool2), pool3);

    // Revoked by the owner with address(0).
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(pool2, address(0));
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(pool2, address(0));
    assertEq(manager.getPoolMigrationSource(pool2), address(0));

    // Revoked by the Guardian: GuardianAction first, then the configuration event.
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(pool2, address(pool));
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.GuardianAction(guardian, LiquidityManager.revokePoolMigrationApproval.selector);
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(pool2, address(0));
    vm.prank(guardian);
    manager.revokePoolMigrationApproval(pool2);
    assertEq(manager.getPoolMigrationSource(pool2), address(0));
  }

  /// @dev The approval only applies while the registry maps the token to the pool or to the approved source pool; it
  /// lapses (without being cleared) when the registry moves to any third pool.
  function test_regression_migrationApproval_lapsesWhenRegistryMovesToThirdPool() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    (, uint256 id2) = _registerPool(pool2);
    address pool3 = makeAddr("pool3");

    _fundAs(fundingOperator, id2, AMOUNT); // registry = source pool

    registry.setPool(address(token), pool3);
    bytes memory notActive =
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool2), pool3);
    vm.expectRevert(notActive);
    manager.verifyAdapter(id2);
    vm.expectRevert(notActive);
    _fundAs(fundingOperator, id2, AMOUNT);
    assertEq(manager.getPoolMigrationSource(address(pool2)), address(pool), "approval kept, but inert");

    registry.setPool(address(token), address(pool2));
    _fundAs(fundingOperator, id2, AMOUNT); // registry = the pool itself

    registry.setPool(address(token), address(pool));
    _fundAs(fundingOperator, id2, AMOUNT); // back to the source pool

    registry.setPool(address(token), address(0));
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool2), address(0))
    );
    _fundAs(fundingOperator, id2, AMOUNT);
    assertEq(_balance(address(pool2)), POOL_INVENTORY + 3 * AMOUNT);
  }

  /// @dev An approval granted under one source pool does not help while the registry maps another pool.
  function test_regression_migrationApproval_boundToSourcePool() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    CCIPPoolAdapter adapter2 = _preparePool(pool2, false);
    address pool3 = makeAddr("pool3");
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool2), pool3);

    _expectRegisterRevert(
      address(adapter2),
      address(pool2),
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool2), address(pool))
    );

    registry.setPool(address(token), pool3);
    assertEq(_register(address(adapter2), address(pool2)), 2);
  }

  // ================================================================
  // │                        Adapter history                       │
  // ================================================================

  function test_regression_adapterHistory_registerReplaceSwitchBack() public {
    address[] memory history = manager.getAdapterHistory();
    assertEq(history.length, 1);
    assertEq(history[0], address(adapter));
    assertTrue(manager.isRegisteredAdapter(address(adapter)));
    assertFalse(manager.isRegisteredAdapter(attacker));
    assertFalse(manager.isRegisteredAdapter(address(pool)));

    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    (CCIPPoolAdapter adapter2,) = _registerPool(pool2);
    CCIPPoolAdapter next = new CCIPPoolAdapter(address(manager), address(token), address(pool));
    assertFalse(manager.isRegisteredAdapter(address(next)));

    // A failed replacement (rebalancer not moved) records nothing.
    _expectReplaceRevert(
      adapterId,
      address(next),
      abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, address(pool), address(adapter))
    );
    assertFalse(manager.isRegisteredAdapter(address(next)));

    _installAdapter(address(next));
    assertTrue(manager.isRegisteredAdapter(address(adapter)), "replaced adapter stays registered");
    assertTrue(manager.isRegisteredAdapter(address(next)));

    // Switching back and forth adds no duplicates.
    _installAdapter(address(adapter));
    _installAdapter(address(next));
    _installAdapter(address(adapter));

    history = manager.getAdapterHistory();
    assertEq(history.length, 3, "unique entries only");
    assertEq(history[0], address(adapter));
    assertEq(history[1], address(adapter2));
    assertEq(history[2], address(next));
    assertTrue(manager.isRegisteredAdapter(address(adapter2)));
    assertEq(manager.getAdapter(adapterId).adapter, address(adapter));
  }

  // ================================================================
  // │                        migrateReserves                       │
  // ================================================================

  function test_regression_migrateReserves_rejectsReserveEndpoints() public {
    MockLockReleaseTokenPool pool2 = new MockLockReleaseTokenPool(address(token), router);
    (CCIPPoolAdapter adapter2, uint256 id2) = _registerPool(pool2);
    CCIPPoolAdapter next = new CCIPPoolAdapter(address(manager), address(token), address(pool));
    _installAdapter(address(next));

    _expectInvalidDestination(address(manager));
    _expectInvalidDestination(address(token));
    _expectInvalidDestination(address(next)); // current adapter
    _expectInvalidDestination(address(adapter)); // replaced adapter
    _expectInvalidDestination(address(adapter2));
    _expectInvalidDestination(address(pool)); // registered pools
    _expectInvalidDestination(address(pool2));

    // A retired pool (both directions disabled) is still registered.
    vm.prank(address(timelock));
    manager.setAdapterStatus(id2, false, false);
    _expectInvalidDestination(address(pool2));
    _expectInvalidDestination(address(adapter2));
    assertEq(_balance(address(manager)), MANAGER_RESERVES);

    // Pools known to the Manager without a registration are excluded too: a pool with a spec or a migration
    // approval, and the pool the TokenAdminRegistry currently maps the token to.
    address specOnly = makeAddr("specOnlyPool");
    _setSpec(specOnly);
    _expectInvalidDestination(specOnly);
    address approvedOnly = makeAddr("approvedOnlyPool");
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(approvedOnly, address(pool));
    _expectInvalidDestination(approvedOnly);
    address registryOnly = makeAddr("registryOnlyPool");
    registry.setPool(address(token), registryOnly);
    _expectInvalidDestination(registryOnly);
    registry.setPool(address(token), address(pool));

    // Contracts bound to this Manager cannot return tokens: an adapter deployed but never registered, and the
    // GuardianController.
    CCIPPoolAdapter unregisteredAdapter = new CCIPPoolAdapter(address(manager), address(token), address(pool2));
    _expectInvalidDestination(address(unregisteredAdapter));
    _expectInvalidDestination(address(controller));
    assertEq(_balance(address(manager)), MANAGER_RESERVES);

    // An adapter bound to another Manager, and an unrelated address, are valid destinations.
    CCIPPoolAdapter foreignAdapter = new CCIPPoolAdapter(makeAddr("otherManager"), address(token), address(pool2));
    _migrate(address(foreignAdapter), AMOUNT);
    assertEq(_balance(address(foreignAdapter)), AMOUNT);
    address unrelated = makeAddr("unrelated");
    _migrate(unrelated, AMOUNT);
    assertEq(_balance(unrelated), AMOUNT);
  }

  function test_regression_migrateReserves_checkOrder() public {
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    _migrate(address(0), 0);
    vm.expectRevert(ILiquidityManager.ZeroAddress.selector);
    _migrate(address(0), type(uint256).max);
    // The destination is checked before the amount.
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidMigrationDestination.selector, address(manager)));
    _migrate(address(manager), 0);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidMigrationDestination.selector, address(pool)));
    _migrate(address(pool), type(uint256).max);
    vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
    _migrate(successor, 0);
  }

  function test_regression_migrateReserves_maxMovesWholeBalance() public {
    _seed(address(manager), 1); // unsolicited dust is included
    uint256 balance = MANAGER_RESERVES + 1;
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.ReservesMigrated(successor, balance);
    _migrate(successor, type(uint256).max);
    assertEq(_balance(successor), balance);
    assertEq(_balance(address(manager)), 0);
  }

  /// @dev A scheduled `type(uint256).max` migration moves the balance at execution, so operations during the delay
  /// cannot make it fail; a fixed amount scheduled at the same time can.
  function test_regression_migrateReserves_maxThroughTimelockAfterInterveningFund() public {
    bytes memory maxData = abi.encodeCall(LiquidityManager.migrateReserves, (successor, type(uint256).max));
    bytes memory fixedData = abi.encodeCall(LiquidityManager.migrateReserves, (successor, MANAGER_RESERVES));
    _schedule(address(manager), maxData, bytes32(0), bytes32("migrate-max"));
    _schedule(address(manager), fixedData, bytes32(0), bytes32("migrate-fixed"));

    _fund(AMOUNT);
    uint256 remaining = MANAGER_RESERVES - AMOUNT;
    assertEq(_balance(address(manager)), remaining);
    vm.warp(block.timestamp + TIMELOCK_DELAY);

    vm.expectRevert(
      abi.encodeWithSelector(
        IERC20Errors.ERC20InsufficientBalance.selector, address(manager), remaining, MANAGER_RESERVES
      )
    );
    vm.prank(governanceSafe);
    timelock.execute(address(manager), 0, fixedData, bytes32(0), bytes32("migrate-fixed"));

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.ReservesMigrated(successor, remaining);
    vm.prank(governanceSafe);
    timelock.execute(address(manager), 0, maxData, bytes32(0), bytes32("migrate-max"));
    assertEq(_balance(successor), remaining);
    assertEq(_balance(address(manager)), 0);
    assertEq(_balance(address(pool)), POOL_INVENTORY + AMOUNT);
  }

  function test_regression_migrateReserves_maxOnEmptyBalanceReverts() public {
    _migrate(successor, type(uint256).max);
    vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
    _migrate(successor, type(uint256).max);

    LiquidityManager fresh = new LiquidityManager(address(token), registry, address(timelock), guardian);
    vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
    vm.prank(address(timelock));
    fresh.migrateReserves(successor, type(uint256).max);
  }

  // ================================================================
  // │                   Guardian / operator separation             │
  // ================================================================

  function test_regression_operatorSetters_rejectGuardian() public {
    bytes memory err = abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, guardian);
    vm.startPrank(address(timelock));
    vm.expectRevert(err);
    manager.setFundingOperator(guardian, true);
    vm.expectRevert(err);
    manager.setRecallOperator(guardian, true);

    // Revoking is always allowed.
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.FundingOperatorSet(guardian, false);
    manager.setFundingOperator(guardian, false);
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.RecallOperatorSet(guardian, false);
    manager.setRecallOperator(guardian, false);
    vm.stopPrank();
    assertFalse(manager.isFundingOperator(guardian));
    assertFalse(manager.isRecallOperator(guardian));
  }

  function test_regression_operatorSetters_followGuardianRotation() public {
    address oldGuardian = guardian;
    address next = makeAddr("nextGuardian");
    vm.startPrank(address(timelock));
    manager.setGuardian(next);
    // The former Guardian may now be granted a role; the new one may not.
    manager.setFundingOperator(oldGuardian, true);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, next));
    manager.setRecallOperator(next, true);
    // With no Guardian, nothing is excluded except address(0).
    manager.setGuardian(address(0));
    manager.setRecallOperator(next, true);
    vm.stopPrank();
    assertTrue(manager.isFundingOperator(oldGuardian));
    assertTrue(manager.isRecallOperator(next));
  }

  /// @dev `setGuardian` never reverts (so the recovery path cannot be blocked), but it revokes any operator role the
  /// new Guardian holds, emitting the role events, so the Guardian and operator roles never overlap.
  function test_regression_setGuardian_revokesOperatorRolesOfNewGuardian() public {
    // Such a rotation is still the protected path the Guardian cannot cancel.
    bytes memory rotate = abi.encodeCall(LiquidityManager.setGuardian, (fundingOperator));
    assertTrue(controller.isProtectedCall(address(manager), 0, rotate), "protected path");

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.GuardianSet(guardian, fundingOperator);
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.FundingOperatorSet(fundingOperator, false);
    vm.prank(address(timelock));
    manager.setGuardian(fundingOperator);
    assertEq(manager.guardian(), fundingOperator);
    assertFalse(manager.isFundingOperator(fundingOperator), "funding role revoked");

    // The new Guardian can restrict but no longer fund.
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotFundingOperator.selector, fundingOperator));
    _fund(AMOUNT);
    vm.prank(fundingOperator);
    manager.pauseFunding();
    assertTrue(manager.fundingPaused());

    // The role cannot be granted back while it is the Guardian.
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, fundingOperator));
    vm.prank(address(timelock));
    manager.setFundingOperator(fundingOperator, true);

    // Same for a Recall Operator.
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.RecallOperatorSet(recallOperator, false);
    vm.prank(address(timelock));
    manager.setGuardian(recallOperator);
    assertFalse(manager.isRecallOperator(recallOperator), "recall role revoked");
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.CallerNotRecallOperator.selector, recallOperator));
    _recall(AMOUNT);
  }

  /// @dev Removing the Guardian (address(0)) or appointing a non-operator touches no operator role.
  function test_regression_setGuardian_leavesOtherOperatorsUntouched() public {
    vm.recordLogs();
    vm.prank(address(timelock));
    manager.setGuardian(address(0));
    assertEq(vm.getRecordedLogs().length, 1, "only GuardianSet");
    assertTrue(manager.isFundingOperator(fundingOperator));
    assertTrue(manager.isRecallOperator(recallOperator));
  }

  /// @dev Appointing an operator as Guardian revokes its role, so the operator setters only ever see the
  /// Guardian check for it.
  function test_regression_operatorSetters_guardianNeverRegainsOperatorRole() public {
    vm.startPrank(address(timelock));
    manager.setGuardian(recallOperator);
    assertFalse(manager.isRecallOperator(recallOperator));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, recallOperator));
    manager.setFundingOperator(recallOperator, true);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, recallOperator));
    manager.setRecallOperator(recallOperator, true);
    // Revoking stays possible.
    manager.setRecallOperator(recallOperator, false);
    vm.stopPrank();
    assertFalse(manager.isRecallOperator(recallOperator));
  }

  // ================================================================
  // │              Budgets: Guardian before first config           │
  // ================================================================

  /// @dev A Guardian reduction of a never-configured bucket is a no-op, so the owner's first configuration still
  /// starts full.
  function test_regression_guardianReduceBeforeFirstConfig_ownerConfigStartsFull() public {
    address futurePool = makeAddr("futurePool");
    vm.prank(guardian);
    manager.reducePoolFundingBudget(futurePool, 0, 0);
    vm.prank(address(timelock));
    manager.setPoolFundingBudget(futurePool, AMOUNT, 7);
    _assertBudget(manager.getPoolFundingBudget(futurePool), AMOUNT, 7, AMOUNT);

    LiquidityManager fresh = new LiquidityManager(address(token), registry, address(timelock), guardian);
    vm.startPrank(guardian);
    fresh.reduceAggregateFundingBudget(0, 0);
    fresh.reduceRecallLimits(0, 0, 0);
    vm.stopPrank();
    vm.startPrank(address(timelock));
    fresh.setAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    fresh.setRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE);
    vm.stopPrank();
    _assertBudget(
      fresh.getAggregateFundingBudget(), AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE, AGGREGATE_FUNDING_CAPACITY
    );
    _assertBudget(fresh.getRecallBudget(), RECALL_CAPACITY, RECALL_RATE, RECALL_CAPACITY);
  }
}
