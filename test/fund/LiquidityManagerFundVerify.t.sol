// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";

import {FundBase} from "test/fund/FundBase.sol";
import {ConfigurableAdapter} from "test/fund/mocks/ConfigurableAdapter.sol";

/// @notice The pool and adapter checks `fund` runs before every funding (`_verifyPool`). Every mismatch must make both
/// `fund` and `verifyAdapter` revert with the same exact error and leave balances and budgets untouched.
contract LiquidityManagerFundVerifyTest is FundBase {
  uint256 internal constant AMOUNT = 1_000_000e18;

  /// @dev Asserts `fund` and `verifyAdapter` both revert with `err` and that the failed `fund` changed nothing.
  function _expectVerifyAndFundRevert(bytes memory err) internal {
    address currentAdapter = manager.getAdapter(adapterId).adapter;
    Snapshot memory before = _snapshot(currentAdapter, address(pool));

    vm.expectRevert(err);
    manager.verifyAdapter(adapterId);
    _expectFundRevert(fundingOperator, adapterId, AMOUNT, err);

    _assertUnchanged(before, currentAdapter, address(pool));
  }

  function _installConfigurableAdapter() internal returns (ConfigurableAdapter fake) {
    fake = new ConfigurableAdapter(address(manager), address(token), address(pool));
    vm.startPrank(address(timelock));
    pool.setRebalancer(address(fake));
    manager.replaceAdapter(adapterId, address(fake));
    vm.stopPrank();
    // Baseline: the fake adapter with correct bindings funds normally.
    _fund(AMOUNT);
  }

  function _specWithRemotePools(bytes memory first, bytes memory second)
    internal
    view
    returns (ILiquidityManager.PoolSpec memory spec)
  {
    spec = _poolSpec();
    spec.remotePools = new bytes[](2);
    spec.remotePools[0] = first;
    spec.remotePools[1] = second;
  }

  function test_fund_baselinePassesVerification() public {
    manager.verifyAdapter(adapterId);
    _fund(AMOUNT);
  }

  // ================================================================
  // │                      Adapter bindings                        │
  // ================================================================

  function test_fund_revertsWhen_adapterReportsWrongManager() public {
    ConfigurableAdapter fake = _installConfigurableAdapter();
    fake.setBindings(attacker, address(token), address(pool));
    _expectVerifyAndFundRevert(abi.encodeWithSelector(ILiquidityManager.AdapterBindingMismatch.selector, address(fake)));
  }

  function test_fund_revertsWhen_adapterReportsWrongToken() public {
    ConfigurableAdapter fake = _installConfigurableAdapter();
    fake.setBindings(address(manager), makeAddr("otherToken"), address(pool));
    _expectVerifyAndFundRevert(abi.encodeWithSelector(ILiquidityManager.AdapterBindingMismatch.selector, address(fake)));
  }

  function test_fund_revertsWhen_adapterReportsWrongPool() public {
    ConfigurableAdapter fake = _installConfigurableAdapter();
    fake.setBindings(address(manager), address(token), makeAddr("otherPool"));
    _expectVerifyAndFundRevert(abi.encodeWithSelector(ILiquidityManager.AdapterBindingMismatch.selector, address(fake)));
  }

  function test_fund_succeedsAgainAfterAdapterBindingsRestored() public {
    ConfigurableAdapter fake = _installConfigurableAdapter();
    fake.setBindings(attacker, address(token), address(pool));
    _expectFundRevert(
      fundingOperator,
      adapterId,
      AMOUNT,
      abi.encodeWithSelector(ILiquidityManager.AdapterBindingMismatch.selector, address(fake))
    );
    fake.setBindings(address(manager), address(token), address(pool));
    _fund(AMOUNT);
  }

  // ================================================================
  // │                    Pool token and version                    │
  // ================================================================

  function test_fund_revertsWhen_poolTokenChanged() public {
    address otherToken = makeAddr("otherToken");
    vm.mockCall(address(pool), abi.encodeWithSelector(ILockReleaseTokenPool.getToken.selector), abi.encode(otherToken));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolTokenMismatch.selector, address(pool), otherToken)
    );
  }

  function test_fund_revertsWhen_poolVersionChanged() public {
    string memory newVersion = "LockReleaseTokenPool 1.6.4";
    vm.prank(address(timelock));
    pool.setTypeAndVersion(newVersion);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolVersionMismatch.selector, address(pool), newVersion)
    );
  }

  function test_fund_revertsWhen_poolVersionDiffersOnlyByTrailingSpace() public {
    string memory newVersion = "LockReleaseTokenPool 1.6.3-dev ";
    vm.prank(address(timelock));
    pool.setTypeAndVersion(newVersion);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolVersionMismatch.selector, address(pool), newVersion)
    );
  }

  function test_fund_revertsWhen_ownerPinsDifferentVersion() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.typeAndVersion = "LockReleaseTokenPool 1.6.4";
    vm.prank(address(timelock));
    manager.setPoolSpec(address(pool), spec);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolVersionMismatch.selector, address(pool), POOL_VERSION)
    );
  }

  // ================================================================
  // │              TokenAdminRegistry and migration approval       │
  // ================================================================

  function test_fund_revertsWhen_registryMapsTokenElsewhere() public {
    address replacementPool = makeAddr("replacementPool");
    registry.setPool(address(token), replacementPool);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), replacementPool)
    );
  }

  function test_fund_revertsWhen_registryMappingCleared() public {
    registry.setPool(address(token), address(0));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), address(0))
    );
  }

  /// @dev An approval bound to the pool the registry currently maps SAHARA to lets a non-registry pool be funded.
  function test_fund_succeedsWhen_registryMapsElsewhereButMigrationApproved() public {
    address replacementPool = makeAddr("replacementPool");
    registry.setPool(address(token), replacementPool);
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), replacementPool);
    assertEq(manager.getPoolMigrationSource(address(pool)), replacementPool);
    manager.verifyAdapter(adapterId);
    _fund(AMOUNT);
  }

  function test_fund_revertsAgainAfterGuardianRevokesMigrationApproval() public {
    address replacementPool = makeAddr("replacementPool");
    registry.setPool(address(token), replacementPool);
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), replacementPool);
    _fund(AMOUNT);

    vm.prank(guardian);
    manager.revokePoolMigrationApproval(address(pool));
    assertEq(manager.getPoolMigrationSource(address(pool)), address(0));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), replacementPool)
    );
  }

  function test_fund_revertsAgainAfterOwnerRevokesMigrationApproval() public {
    address replacementPool = makeAddr("replacementPool");
    registry.setPool(address(token), replacementPool);
    vm.startPrank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), replacementPool);
    manager.setPoolMigrationApproval(address(pool), address(0));
    vm.stopPrank();
    assertEq(manager.getPoolMigrationSource(address(pool)), address(0));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), replacementPool)
    );
  }

  /// @dev An approval granted to a different pool does not help the fixture pool.
  function test_fund_migrationApprovalOfAnotherPoolDoesNotHelp() public {
    address replacementPool = makeAddr("replacementPool");
    registry.setPool(address(token), replacementPool);
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(makeAddr("otherPool"), replacementPool);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), replacementPool)
    );
  }

  /// @dev An approval of the fixture pool bound to a source other than the current registry pool does not help.
  function test_fund_migrationApprovalBoundToAnotherSourceDoesNotHelp() public {
    address replacementPool = makeAddr("replacementPool");
    registry.setPool(address(token), replacementPool);
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), makeAddr("wrongSource"));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), replacementPool)
    );
  }

  /// @dev A registry mapping cleared to address(0) never matches an approval (address(0) means "no approval").
  function test_fund_migrationApprovalDoesNotCoverClearedRegistryMapping() public {
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), makeAddr("replacementPool"));
    registry.setPool(address(token), address(0));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), address(0))
    );
  }

  /// @dev Migration approval only skips the registry check; every other check still runs.
  function test_fund_migrationApprovalDoesNotBypassOtherChecks() public {
    address replacementPool = makeAddr("replacementPool");
    registry.setPool(address(token), replacementPool);
    vm.startPrank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), replacementPool);
    pool.setRebalancer(attacker);
    vm.stopPrank();
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, address(pool), attacker)
    );
  }

  function test_fund_succeedsWhen_registryMapsBackToPool() public {
    registry.setPool(address(token), makeAddr("replacementPool"));
    _expectFundRevert(
      fundingOperator,
      adapterId,
      AMOUNT,
      abi.encodeWithSelector(
        ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), makeAddr("replacementPool")
      )
    );
    registry.setPool(address(token), address(pool));
    _fund(AMOUNT);
  }

  // ================================================================
  // │                     Rebalancer and router                    │
  // ================================================================

  function test_fund_revertsWhen_rebalancerChanged() public {
    vm.prank(address(timelock));
    pool.setRebalancer(attacker);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, address(pool), attacker)
    );
  }

  function test_fund_revertsWhen_rebalancerCleared() public {
    vm.prank(address(timelock));
    pool.setRebalancer(address(0));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, address(pool), address(0))
    );
  }

  function test_fund_revertsWhen_routerChanged() public {
    address newRouter = makeAddr("newRouter");
    vm.prank(address(timelock));
    pool.setRouter(newRouter);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, address(pool), newRouter)
    );
  }

  function test_fund_revertsWhen_ownerApprovesDifferentRouter() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.router = makeAddr("newRouter");
    vm.prank(address(timelock));
    manager.setPoolSpec(address(pool), spec);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, address(pool), router)
    );
  }

  function test_fund_succeedsAgainAfterRouterRestored() public {
    vm.prank(address(timelock));
    pool.setRouter(attacker);
    _expectFundRevert(
      fundingOperator,
      adapterId,
      AMOUNT,
      abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, address(pool), attacker)
    );
    vm.prank(address(timelock));
    pool.setRouter(router);
    _fund(AMOUNT);
  }

  // ================================================================
  // │                       Supported chains                       │
  // ================================================================

  function test_fund_revertsWhen_poolHasNoChains() public {
    vm.prank(address(timelock));
    pool.removeChain(REMOTE_CHAIN_SELECTOR);
    assertEq(pool.getSupportedChains().length, 0);
    _expectVerifyAndFundRevert(abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, address(pool)));
  }

  function test_fund_revertsWhen_poolHasTwoChains() public {
    vm.prank(address(timelock));
    pool.addChain(
      OTHER_CHAIN_SELECTOR,
      abi.encode(REMOTE_TOKEN),
      abi.encode(REMOTE_POOL),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
    assertEq(pool.getSupportedChains().length, 2);
    _expectVerifyAndFundRevert(abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, address(pool)));
  }

  function test_fund_revertsWhen_poolSupportsDifferentChain() public {
    vm.startPrank(address(timelock));
    pool.removeChain(REMOTE_CHAIN_SELECTOR);
    pool.addChain(
      OTHER_CHAIN_SELECTOR,
      abi.encode(REMOTE_TOKEN),
      abi.encode(REMOTE_POOL),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
    vm.stopPrank();
    assertEq(pool.getSupportedChains().length, 1);
    _expectVerifyAndFundRevert(abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, address(pool)));
  }

  function test_fund_revertsWhen_ownerApprovesDifferentCounterpartChain() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.remoteChainSelector = OTHER_CHAIN_SELECTOR;
    vm.prank(address(timelock));
    manager.setPoolSpec(address(pool), spec);
    _expectVerifyAndFundRevert(abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, address(pool)));
  }

  // ================================================================
  // │                         Remote token                         │
  // ================================================================

  function test_fund_revertsWhen_remoteTokenChanged() public {
    vm.prank(address(timelock));
    pool.setRemoteToken(REMOTE_CHAIN_SELECTOR, abi.encode(makeAddr("otherRemoteToken")));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRemoteTokenMismatch.selector, address(pool))
    );
  }

  /// @dev Same address, different encoding (20-byte packed vs 32-byte abi.encode) is a mismatch.
  function test_fund_revertsWhen_remoteTokenEncodingDiffers() public {
    vm.prank(address(timelock));
    pool.setRemoteToken(REMOTE_CHAIN_SELECTOR, abi.encodePacked(REMOTE_TOKEN));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRemoteTokenMismatch.selector, address(pool))
    );
  }

  function test_fund_revertsWhen_remoteTokenCleared() public {
    vm.prank(address(timelock));
    pool.setRemoteToken(REMOTE_CHAIN_SELECTOR, "");
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRemoteTokenMismatch.selector, address(pool))
    );
  }

  // ================================================================
  // │                         Remote pools                         │
  // ================================================================

  function test_fund_revertsWhen_remotePoolsHaveExtraPool() public {
    vm.prank(address(timelock));
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool))
    );
  }

  function test_fund_revertsWhen_remotePoolsMissingPool() public {
    vm.prank(address(timelock));
    pool.removeRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(REMOTE_POOL));
    assertEq(pool.getRemotePools(REMOTE_CHAIN_SELECTOR).length, 0);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool))
    );
  }

  function test_fund_revertsWhen_remotePoolsHaveDifferentPool() public {
    vm.startPrank(address(timelock));
    pool.removeRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(REMOTE_POOL));
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    vm.stopPrank();
    assertEq(pool.getRemotePools(REMOTE_CHAIN_SELECTOR).length, 1);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool))
    );
  }

  function test_fund_revertsWhen_remotePoolEncodingDiffers() public {
    vm.startPrank(address(timelock));
    pool.removeRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(REMOTE_POOL));
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encodePacked(REMOTE_POOL));
    vm.stopPrank();
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool))
    );
  }

  function test_fund_succeedsWhen_remotePoolSetMatchesInDifferentOrder() public {
    vm.startPrank(address(timelock));
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    manager.setPoolSpec(address(pool), _specWithRemotePools(abi.encode(OTHER_REMOTE_POOL), abi.encode(REMOTE_POOL)));
    vm.stopPrank();

    bytes[] memory onPool = pool.getRemotePools(REMOTE_CHAIN_SELECTOR);
    assertEq(onPool.length, 2);
    assertEq(onPool[0], abi.encode(REMOTE_POOL), "pool order differs from spec order");
    assertEq(onPool[1], abi.encode(OTHER_REMOTE_POOL), "pool order differs from spec order");

    manager.verifyAdapter(adapterId);
    _fund(AMOUNT);
  }

  function test_fund_succeedsWhen_remotePoolSetMatchesInSameOrder() public {
    vm.startPrank(address(timelock));
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    manager.setPoolSpec(address(pool), _specWithRemotePools(abi.encode(REMOTE_POOL), abi.encode(OTHER_REMOTE_POOL)));
    vm.stopPrank();
    _fund(AMOUNT);
  }

  function test_fund_revertsWhen_twoPoolSpecButPoolHasOne() public {
    vm.prank(address(timelock));
    manager.setPoolSpec(address(pool), _specWithRemotePools(abi.encode(REMOTE_POOL), abi.encode(OTHER_REMOTE_POOL)));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool))
    );
  }

  function test_fund_revertsWhen_twoPoolSpecButPoolHasDifferentSecond() public {
    vm.startPrank(address(timelock));
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(makeAddr("thirdRemotePool")));
    manager.setPoolSpec(address(pool), _specWithRemotePools(abi.encode(REMOTE_POOL), abi.encode(OTHER_REMOTE_POOL)));
    vm.stopPrank();
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool))
    );
  }

  function test_fund_revertsWhen_twoPoolSpecButPoolHasThree() public {
    vm.startPrank(address(timelock));
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(makeAddr("thirdRemotePool")));
    manager.setPoolSpec(address(pool), _specWithRemotePools(abi.encode(OTHER_REMOTE_POOL), abi.encode(REMOTE_POOL)));
    vm.stopPrank();
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool))
    );
  }

  // ================================================================
  // │                   Pool owner and rate limit admin            │
  // ================================================================

  function test_fund_revertsWhen_poolOwnerChanged() public {
    vm.prank(address(timelock));
    pool.transferOwnership(attacker);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, address(pool), attacker)
    );
  }

  function test_fund_revertsWhen_rateLimitAdminChanged() public {
    vm.prank(address(timelock));
    pool.setRateLimitAdmin(attacker);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRateLimitAdminMismatch.selector, address(pool), attacker)
    );
  }

  function test_fund_revertsWhen_rateLimitAdminCleared() public {
    vm.prank(address(timelock));
    pool.setRateLimitAdmin(address(0));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRateLimitAdminMismatch.selector, address(pool), address(0))
    );
  }

  function test_fund_revertsWhen_ownerExpectsDifferentRateLimitAdmin() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.rateLimitAdmin = makeAddr("newController");
    vm.prank(address(timelock));
    manager.setPoolSpec(address(pool), spec);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRateLimitAdminMismatch.selector, address(pool), address(controller))
    );
  }

  // ================================================================
  // │                         Check order                          │
  // ================================================================

  /// @dev With several mismatches the first in check order is reported (router before owner and rate limit admin).
  function test_fund_reportsFirstMismatchInCheckOrder() public {
    address newRouter = makeAddr("newRouter");
    vm.startPrank(address(timelock));
    pool.setRateLimitAdmin(attacker);
    pool.setRouter(newRouter);
    pool.transferOwnership(attacker);
    vm.stopPrank();
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, address(pool), newRouter)
    );
  }

  /// @dev The pool owner check runs after the remote pool checks and before the rate limit admin check.
  function test_fund_poolOwnerCheckFollowsRemotePoolsAndPrecedesRateLimitAdmin() public {
    vm.startPrank(address(timelock));
    pool.setRateLimitAdmin(attacker);
    pool.addRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    pool.transferOwnership(attacker);
    vm.stopPrank();
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, address(pool))
    );

    vm.prank(attacker);
    pool.removeRemotePool(REMOTE_CHAIN_SELECTOR, abi.encode(OTHER_REMOTE_POOL));
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, address(pool), attacker)
    );
  }

  /// @dev The code checks run before any call to the adapter or pool, so they win over every later mismatch.
  function test_fund_codeChecksPrecedeEveryExternalCheck() public {
    address replacementPool = makeAddr("replacementPool");
    vm.startPrank(address(timelock));
    pool.setRouter(attacker);
    pool.transferOwnership(attacker);
    vm.stopPrank();
    registry.setPool(address(token), replacementPool);
    vm.etch(address(pool), "");
    _expectVerifyAndFundRevert(abi.encodeWithSelector(ILiquidityManager.NotAContract.selector, address(pool)));
  }

  /// @dev The registry check comes before the rebalancer check.
  function test_fund_registryCheckPrecedesRebalancerCheck() public {
    address replacementPool = makeAddr("replacementPool");
    registry.setPool(address(token), replacementPool);
    vm.prank(address(timelock));
    pool.setRebalancer(attacker);
    _expectVerifyAndFundRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(pool), replacementPool)
    );
  }

  /// @dev Budgets are only consumed after verification, so a mismatch reports the mismatch even with no budget left.
  function test_fund_verificationPrecedesBudgetConsumption() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);
    vm.prank(address(timelock));
    pool.setRouter(attacker);
    _expectFundRevert(
      fundingOperator,
      adapterId,
      1,
      abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, address(pool), attacker)
    );
  }

  /// @dev Pool rate limits are not part of the pre-funding checks: a locked-down pool can still be funded.
  function test_fund_notBlockedByPoolLockdown() public {
    vm.prank(guardian);
    controller.lockdown(address(pool));
    manager.verifyAdapter(adapterId);
    _fund(AMOUNT);
  }
}
