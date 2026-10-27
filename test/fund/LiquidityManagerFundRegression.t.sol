// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";

import {FundBase} from "test/fund/FundBase.sol";

/// @notice Regression tests for the second review round, as seen from `fund`/`verifyAdapter`:
/// - migration approval is bound to the registry pool it was granted under (`setPoolMigrationApproval(pool, source)`);
/// - the pool owner must equal the Manager's own owner (the spec no longer carries an owner);
/// - an adapter or pool without code is rejected with `NotAContract` before any call is made to it.
contract LiquidityManagerFundRegressionTest is FundBase {
  uint256 internal constant AMOUNT = 1_000_000e18;

  /// @dev A replacement pool, registered with a `CCIPPoolAdapter` and approved for migration funding bound to the
  /// fixture pool (the pool the registry maps SAHARA to), see `FundBase._wireAndRegister`.
  MockLockReleaseTokenPool internal second;
  CCIPPoolAdapter internal secondAdapter;
  uint256 internal secondId;

  function setUp() public override {
    super.setUp();
    (second, secondAdapter, secondId) = _deployHonestPool(true);
    vm.label(address(second), "ReplacementPool");
    vm.label(address(secondAdapter), "ReplacementPoolAdapter");
  }

  // ---------------------------------------------------------------- helpers

  /// @dev Asserts `verifyAdapter(id)` and `fund(id, AMOUNT)` both revert with `err` and the failed `fund` changed
  /// nothing.
  function _expectVerifyAndFundRevert(uint256 id, bytes memory err) internal {
    ILiquidityManager.Adapter memory entry = manager.getAdapter(id);
    Snapshot memory before = _snapshot(entry.adapter, entry.pool);

    vm.expectRevert(err);
    manager.verifyAdapter(id);
    _expectFundRevert(fundingOperator, id, AMOUNT, err);

    _assertUnchanged(before, entry.adapter, entry.pool);
  }

  /// @dev Asserts `verifyAdapter(id)` passes and `fund(id, AMOUNT)` moves exactly `AMOUNT` into the adapter's pool.
  function _expectVerifyAndFund(uint256 id) internal {
    address p = manager.getAdapter(id).pool;
    manager.verifyAdapter(id);
    uint256 managerBefore = _balance(address(manager));
    uint256 poolBefore = _balance(p);
    _fundAs(fundingOperator, id, AMOUNT);
    assertEq(_balance(address(manager)), managerBefore - AMOUNT, "manager balance");
    assertEq(_balance(p), poolBefore + AMOUNT, "pool balance");
  }

  function _notActive(address p, address registryPool) internal pure returns (bytes memory) {
    return abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, p, registryPool);
  }

  function _ownerMismatch(address p, address poolOwner) internal pure returns (bytes memory) {
    return abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, p, poolOwner);
  }

  function _notAContract(address account) internal pure returns (bytes memory) {
    return abi.encodeWithSelector(ILiquidityManager.NotAContract.selector, account);
  }

  // ================================================================
  // │         Migration approval bound to the source pool          │
  // ================================================================

  function test_regression_migrationApproval_sourceEqualToRegistryPoolAllowsFundingNonRegistryPool() public {
    assertEq(registry.getPool(address(token)), address(pool), "registry maps the fixture pool");
    assertEq(manager.getPoolMigrationSource(address(second)), address(pool), "approval bound to the registry pool");

    _expectVerifyAndFund(secondId);
    // The registry pool itself needs no approval.
    assertEq(manager.getPoolMigrationSource(address(pool)), address(0));
    _expectVerifyAndFund(adapterId);
  }

  function test_regression_migrationApproval_withoutApprovalNonRegistryPoolReverts() public {
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(second), address(0));
    _expectVerifyAndFundRevert(secondId, _notActive(address(second), address(pool)));
  }

  /// @dev The approval is bound to the registry pool it was granted under: once the registry maps SAHARA to any third
  /// pool, it no longer applies. It is not consumed: it applies again if the registry returns to the source.
  function test_regression_migrationApproval_lapsesWhenRegistryMovesToThirdPool() public {
    _expectVerifyAndFund(secondId);

    address third = makeAddr("thirdPool");
    registry.setPool(address(token), third);
    assertEq(manager.getPoolMigrationSource(address(second)), address(pool), "approval still stored");
    _expectVerifyAndFundRevert(secondId, _notActive(address(second), third));
    _expectVerifyAndFundRevert(adapterId, _notActive(address(pool), third));

    registry.setPool(address(token), address(pool));
    _expectVerifyAndFund(secondId);
  }

  /// @dev Same as above with a real, fully wired third pool registered for SAHARA.
  function test_regression_migrationApproval_lapsesWhenRegistryMovesToRegisteredThirdPool() public {
    (MockLockReleaseTokenPool third,, uint256 thirdId) = _deployHonestPool(true);
    registry.setPool(address(token), address(third));

    _expectVerifyAndFundRevert(secondId, _notActive(address(second), address(third)));
    // The third pool is the registry pool now; its own approval (bound to the fixture pool) is irrelevant.
    _expectVerifyAndFund(thirdId);
  }

  /// @dev A pool the registry maps SAHARA to passes the registry check whatever its approval says.
  function test_regression_migrationApproval_registryEqualToPoolPassesRegardlessOfApproval() public {
    registry.setPool(address(token), address(second));

    // Approval bound to the previous registry pool (now stale).
    _expectVerifyAndFund(secondId);

    // No approval.
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(second), address(0));
    _expectVerifyAndFund(secondId);

    // Approval bound to an unrelated pool.
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(second), makeAddr("unrelatedPool"));
    _expectVerifyAndFund(secondId);

    // The former registry pool now needs an approval of its own.
    _expectVerifyAndFundRevert(adapterId, _notActive(address(pool), address(second)));
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(pool), address(second));
    _expectVerifyAndFund(adapterId);
  }

  function test_regression_migrationApproval_ownerRevokesWithZeroSource() public {
    _expectVerifyAndFund(secondId);

    vm.expectEmit(true, true, false, true, address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(address(second), address(0));
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(second), address(0));

    assertEq(manager.getPoolMigrationSource(address(second)), address(0));
    _expectVerifyAndFundRevert(secondId, _notActive(address(second), address(pool)));

    // The owner can grant it again.
    vm.expectEmit(true, true, false, true, address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(address(second), address(pool));
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(second), address(pool));
    _expectVerifyAndFund(secondId);
  }

  function test_regression_migrationApproval_guardianRevokes() public {
    _expectVerifyAndFund(secondId);

    vm.expectEmit(true, true, false, true, address(manager));
    emit ILiquidityManager.GuardianAction(guardian, manager.revokePoolMigrationApproval.selector);
    vm.expectEmit(true, true, false, true, address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(address(second), address(0));
    vm.prank(guardian);
    manager.revokePoolMigrationApproval(address(second));

    assertEq(manager.getPoolMigrationSource(address(second)), address(0));
    _expectVerifyAndFundRevert(secondId, _notActive(address(second), address(pool)));

    // The Guardian can only revoke, not (re-)approve.
    vm.prank(guardian);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
    manager.setPoolMigrationApproval(address(second), address(pool));
  }

  function test_regression_migrationApproval_sourceEqualToPoolReverts() public {
    vm.startPrank(address(timelock));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, address(second)));
    manager.setPoolMigrationApproval(address(second), address(second));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, address(pool)));
    manager.setPoolMigrationApproval(address(pool), address(pool));
    vm.stopPrank();

    // The failed calls left the existing approvals untouched.
    assertEq(manager.getPoolMigrationSource(address(second)), address(pool));
    assertEq(manager.getPoolMigrationSource(address(pool)), address(0));
    _expectVerifyAndFund(secondId);
  }

  /// @dev The registry check passes iff the registry maps SAHARA to the pool itself, or to the non-zero source the
  /// approval was bound to.
  function testFuzz_regression_migrationApproval_onlyCurrentSourceOrSelfPasses(
    address source,
    address other,
    uint8 choice
  ) public {
    vm.assume(source != address(second));
    address registryPool = choice % 3 == 0 ? address(second) : (choice % 3 == 1 ? source : other);
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(address(second), source);
    registry.setPool(address(token), registryPool);

    bool passes = registryPool == address(second) || (source != address(0) && registryPool == source);
    if (passes) {
      _expectVerifyAndFund(secondId);
    } else {
      _expectVerifyAndFundRevert(secondId, _notActive(address(second), registryPool));
    }
  }

  /// @dev Pre-fund the replacement under the old registry pool, switch the registry, then a later move away from the
  /// replacement pool is not covered by the stale approval.
  function test_regression_migrationApproval_fullMigrationLifecycle() public {
    // 1. Pre-fund the replacement while the registry still maps the fixture pool.
    _expectVerifyAndFund(secondId);
    _expectVerifyAndFund(adapterId);

    // 2. The registry administrator (the Timelock) switches SAHARA to the replacement pool.
    registry.setPool(address(token), address(second));
    _expectVerifyAndFund(secondId);
    _expectVerifyAndFundRevert(adapterId, _notActive(address(pool), address(second)));

    // 3. A later switch to a third pool is not covered by the replacement's approval bound to the fixture pool.
    address third = makeAddr("thirdPool");
    registry.setPool(address(token), third);
    _expectVerifyAndFundRevert(secondId, _notActive(address(second), third));
  }

  // ================================================================
  // │           Pool owner must equal the Manager's owner          │
  // ================================================================

  function test_regression_poolOwner_movedElsewhereReverts() public {
    address legacyMultisig = makeAddr("legacyMultisig");
    vm.prank(address(timelock));
    pool.transferOwnership(legacyMultisig);
    _expectVerifyAndFundRevert(adapterId, _ownerMismatch(address(pool), legacyMultisig));

    // The spec has no owner field, so re-pinning it cannot accept another owner.
    vm.prank(address(timelock));
    manager.setPoolSpec(address(pool), _poolSpec());
    _expectVerifyAndFundRevert(adapterId, _ownerMismatch(address(pool), legacyMultisig));

    // Other pools are unaffected.
    _expectVerifyAndFund(secondId);

    vm.prank(legacyMultisig);
    pool.transferOwnership(address(timelock));
    _expectVerifyAndFund(adapterId);
  }

  /// @dev Neither the Manager itself, the Guardian, the Governance Safe nor the controller is an acceptable pool owner.
  function test_regression_poolOwner_rejectsEveryAddressButTheManagerOwner() public {
    address[5] memory owners = [address(manager), guardian, governanceSafe, address(controller), address(0)];
    for (uint256 i = 0; i < owners.length; ++i) {
      vm.prank(address(timelock));
      pool.transferOwnership(owners[i]);
      _expectVerifyAndFundRevert(adapterId, _ownerMismatch(address(pool), owners[i]));
      vm.prank(owners[i]);
      pool.transferOwnership(address(timelock));
    }
    _expectVerifyAndFund(adapterId);
  }

  function testFuzz_regression_poolOwner_anyOtherOwnerReverts(address newOwner) public {
    vm.assume(newOwner != address(timelock));
    vm.prank(address(timelock));
    second.transferOwnership(newOwner);
    _expectVerifyAndFundRevert(secondId, _ownerMismatch(address(second), newOwner));
  }

  /// @dev The pool must follow the Manager's ownership: after a new owner accepts the Manager, every pool still owned
  /// by the old Timelock fails until its ownership is moved to the new owner. Handover is not part of `fund`.
  function test_regression_poolOwner_managerOwnershipTransferredWhilePoolStaysWithOldTimelock() public {
    address newTimelock = makeAddr("newTimelock");

    vm.prank(address(timelock));
    manager.transferOwnership(newTimelock);
    assertEq(manager.pendingOwner(), newTimelock);
    // Pending ownership does not change `owner()`, so the pools still match.
    _expectVerifyAndFund(adapterId);
    _expectVerifyAndFund(secondId);

    vm.prank(newTimelock);
    manager.acceptOwnership();
    assertEq(manager.owner(), newTimelock);

    _expectVerifyAndFundRevert(adapterId, _ownerMismatch(address(pool), address(timelock)));
    _expectVerifyAndFundRevert(secondId, _ownerMismatch(address(second), address(timelock)));

    vm.prank(address(timelock));
    pool.transferOwnership(newTimelock);
    _expectVerifyAndFund(adapterId);
    // The second pool still has the old owner.
    _expectVerifyAndFundRevert(secondId, _ownerMismatch(address(second), address(timelock)));

    vm.prank(address(timelock));
    second.transferOwnership(newTimelock);
    _expectVerifyAndFund(secondId);

    // The registry administration and the token are still with the old Timelock: `verifyHandover` fails, but it is
    // not part of the pre-funding checks.
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, address(timelock)));
    manager.verifyHandover();
    _expectVerifyAndFund(adapterId);
  }

  /// @dev Moving a pool to the pending Manager owner before it accepts breaks funding until it does.
  function test_regression_poolOwner_pendingManagerOwnerDoesNotCount() public {
    address newTimelock = makeAddr("newTimelock");
    vm.startPrank(address(timelock));
    manager.transferOwnership(newTimelock);
    pool.transferOwnership(newTimelock);
    vm.stopPrank();

    _expectVerifyAndFundRevert(adapterId, _ownerMismatch(address(pool), newTimelock));

    vm.prank(newTimelock);
    manager.acceptOwnership();
    _expectVerifyAndFund(adapterId);
  }

  // ================================================================
  // │               NotAContract for adapter and pool              │
  // ================================================================

  function test_regression_notAContract_adapterWithoutCode() public {
    bytes memory code = address(adapter).code;
    vm.etch(address(adapter), "");
    _expectVerifyAndFundRevert(adapterId, _notAContract(address(adapter)));

    // Other adapters are unaffected.
    _expectVerifyAndFund(secondId);

    vm.etch(address(adapter), code);
    _expectVerifyAndFund(adapterId);
  }

  function test_regression_notAContract_poolWithoutCode() public {
    bytes memory code = address(pool).code;
    vm.etch(address(pool), "");
    _expectVerifyAndFundRevert(adapterId, _notAContract(address(pool)));

    vm.etch(address(pool), code);
    _expectVerifyAndFund(adapterId);
  }

  function test_regression_notAContract_adapterReportedBeforePool() public {
    vm.etch(address(secondAdapter), "");
    vm.etch(address(second), "");
    _expectVerifyAndFundRevert(secondId, _notAContract(address(secondAdapter)));
  }

  /// @dev The code checks run after the funding gates that need no external call (role, pause, status, amount).
  function test_regression_notAContract_followsLocalFundingChecks() public {
    vm.etch(address(adapter), "");
    _expectFundRevert(fundingOperator, adapterId, 0, abi.encodeWithSelector(ILiquidityManager.ZeroAmount.selector));
    _expectFundRevert(
      fundingOperator,
      adapterId,
      MAX_FUNDING_PER_CALL + 1,
      abi.encodeWithSelector(
        ILiquidityManager.ExceedsPerCallLimit.selector, MAX_FUNDING_PER_CALL + 1, MAX_FUNDING_PER_CALL
      )
    );
    _expectFundRevert(fundingOperator, adapterId, AMOUNT, _notAContract(address(adapter)));
  }
}
