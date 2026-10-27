// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {GuardianController} from "src/GuardianController.sol";
import {ILiquidityAdapter} from "src/interfaces/ILiquidityAdapter.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";
import {BaseTest} from "test/utils/BaseTest.sol";

import {LiquidityHandler} from "test/adapter-invariant/invariant/LiquidityHandler.sol";

/// @notice Stateful invariants of the Manager / adapter / pool system under random funding, recall, time, bridge
/// flows, unsolicited transfers, Guardian restrictions (including reductions of never-configured budgets), owner
/// restorations, invalid owner calls, handover drift, registry cutovers (including to an unregistered third pool),
/// adapter replacement, reserve migration towards random destinations and unauthorized calls. Two registered pools:
/// A (registry-active) and B (replacement approved for migration funding under A).
contract LiquidityInvariantTest is BaseTest {
  uint256 internal constant POOL_B_INVENTORY = 15_000_000e18;
  uint256 internal constant POOL_B_MINIMUM = 5_000_000e18;
  uint256 internal constant POOL_B_FUNDING_CAPACITY = 30_000_000e18;

  LiquidityHandler internal handler;
  MockLockReleaseTokenPool internal poolB;
  MockLockReleaseTokenPool internal foreignPool;
  CCIPPoolAdapter internal adapterB;
  uint256 internal adapterIdB;

  address internal guardianB = makeAddr("guardianB");
  address internal bridgeUser = makeAddr("bridgeUser");
  address internal migrationRecipient = makeAddr("migrationRecipient");
  address internal legacyMultisig = makeAddr("legacyMultisig");

  function setUp() public virtual override {
    super.setUp();

    poolB = _newPool();
    adapterB = new CCIPPoolAdapter(address(manager), address(token), address(poolB));
    poolB.setRebalancer(address(adapterB));
    poolB.setRateLimitAdmin(address(controller));
    poolB.transferOwnership(address(timelock));

    // Third pool: never registered in the Manager; the registry may be cut over to it.
    foreignPool = _newPool();
    foreignPool.setRateLimitAdmin(address(controller));
    foreignPool.transferOwnership(address(timelock));

    // Registration of a second pool requires its spec and thresholds, and the handover authorities (registry
    // administration, token ownership) with the owner, which BaseTest has done.
    manager.verifyHandover();
    vm.startPrank(address(timelock));
    manager.setPoolSpec(address(poolB), _poolSpec());
    manager.setPoolMigrationApproval(address(poolB), address(pool));
    manager.setPoolThresholds(address(poolB), POOL_B_MINIMUM, 10_000_000e18, 20_000_000e18);
    manager.setPoolFundingBudget(address(poolB), POOL_B_FUNDING_CAPACITY, POOL_B_FUNDING_CAPACITY / 1 days);
    adapterIdB = manager.registerAdapter(address(adapterB), address(poolB));
    vm.stopPrank();

    vm.prank(treasury);
    token.transfer(address(poolB), POOL_B_INVENTORY);

    handler = new LiquidityHandler(
      LiquidityHandler.Deployment({
        token: token,
        registry: registry,
        manager: manager,
        controller: controller,
        timelock: address(timelock),
        poolA: pool,
        poolB: poolB,
        foreignPool: foreignPool,
        fundingOperator: fundingOperator,
        recallOperator: recallOperator,
        guardianA: guardian,
        guardianB: guardianB,
        treasury: treasury,
        bridgeUser: bridgeUser,
        migrationRecipient: migrationRecipient,
        legacyMultisig: legacyMultisig,
        attacker: attacker
      })
    );
    vm.label(address(handler), "Handler");
    vm.label(address(poolB), "PoolB");
    vm.label(address(foreignPool), "ForeignPool");
    vm.label(address(adapterB), "AdapterB");

    bytes4[] memory selectors = new bytes4[](18);
    selectors[0] = LiquidityHandler.fund.selector;
    selectors[1] = LiquidityHandler.recall.selector;
    selectors[2] = LiquidityHandler.warp.selector;
    selectors[3] = LiquidityHandler.bridgeFlow.selector;
    selectors[4] = LiquidityHandler.sendUnsolicited.selector;
    selectors[5] = LiquidityHandler.guardianAct.selector;
    selectors[6] = LiquidityHandler.guardianLockdown.selector;
    selectors[7] = LiquidityHandler.staleGuardianAct.selector;
    selectors[8] = LiquidityHandler.ownerAct.selector;
    selectors[9] = LiquidityHandler.ownerMigrateReserves.selector;
    selectors[10] = LiquidityHandler.ownerReplaceAdapter.selector;
    selectors[11] = LiquidityHandler.attackerAct.selector;
    selectors[12] = LiquidityHandler.ownerRegistryCutover.selector;
    selectors[13] = LiquidityHandler.guardianReduceProbe.selector;
    selectors[14] = LiquidityHandler.ownerConfigureProbe.selector;
    selectors[15] = LiquidityHandler.ownerInvalidAct.selector;
    selectors[16] = LiquidityHandler.handoverDrift.selector;
    // Weighted: reserve migration towards random destinations is the main new surface.
    selectors[17] = LiquidityHandler.ownerMigrateReserves.selector;
    targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    targetContract(address(handler));
  }

  // ================================================================
  // │                          Invariants                          │
  // ================================================================

  /// @notice Supply is constant, every token sits at a tracked address, and each balance equals its ghost ledger:
  /// Manager = start + recalls + unsolicited + returned - funding - migrations; pool = start + funding + inflows -
  /// recalls - outflows; adapter = cumulative unsolicited dust sent to it; migration recipients = migrated - returned.
  /// Since adapter and pool balances match their ledgers, no reserve migration ever reached an adapter or a
  /// registered pool.
  function invariant_tokenConservation() public view {
    _assertTokenConservation();
  }

  /// @notice Adapter-to-pool allowance is always zero; adapter bindings, the Manager's registry and its adapter
  /// history stay consistent with the handler; rejected replacement adapters are never registered; migration
  /// approvals match the independently tracked sources.
  function invariant_adapterAllowancesAndRegistry() public view {
    _assertAdapters();
  }

  /// @notice Budgets never exceed capacity, match the independent reference model, and every limit is at least as
  /// tight as the last owner (Timelock) setting, so Guardian actions never loosen anything. Probe budgets the owner
  /// never configured stay at zero whatever the Guardian did.
  function invariant_budgetsAndLimits() public view {
    _assertBudgetsAndLimits();
  }

  /// @notice Properties checked inside the handler at call time: exact balance and budget deltas of every fund and
  /// recall, the pool minimum at recall time, the funding/recall windows (capacity + rate * elapsed), expected
  /// success/failure (with exact revert data where relevant) of every operation, Guardian non-loosening and event
  /// order, lockdown shape, the owner's first budget configuration starting full, migration destinations, and no
  /// privileged call by others.
  function invariant_noHandlerViolations() public view {
    assertEq(handler.violations(), 0, handler.firstViolation());
  }

  // ================================================================
  // │                Deterministic handler smoke test              │
  // ================================================================

  /// @notice Drives every handler path once with fixed inputs, so a vacuous handler (everything reverting) is caught.
  function test_handlerExercisesEveryPath() public {
    handler.fund(0, 10_000_000e18, 0);
    handler.fund(1, 5_000_000e18, 0);
    assertEq(handler.fundOk(), 2, "funds");
    handler.recall(0, 10_000_000e18, 0);
    handler.recall(1, 1_000_000e18, 0);
    assertEq(handler.recallOk(), 2, "recalls");

    handler.warp(12 hours);
    handler.bridgeFlow(true, 0, 3_000_000e18);
    handler.bridgeFlow(false, 1, 1_000_000e18);
    handler.sendUnsolicited(false, 0, 4); // 4 % 4 == 0 -> larger bound
    handler.sendUnsolicited(true, 0, 7);

    // Guardian: pause funding, then the owner unpauses.
    handler.guardianAct(0, 0, 0, 0);
    assertTrue(manager.fundingPaused());
    handler.ownerAct(0, 1, 0, 0);
    assertFalse(manager.fundingPaused());
    // Guardian: reduce the aggregate budget to half capacity and zero rate; owner restores it.
    handler.guardianAct(7, 1, 3, 0);
    assertEq(manager.getAggregateFundingBudget().capacity, AGGREGATE_FUNDING_CAPACITY / 2);
    handler.ownerAct(6, 0, 0, 0);
    assertEq(manager.getAggregateFundingBudget().capacity, AGGREGATE_FUNDING_CAPACITY);
    // Guardian tries an owner-only call (must be rejected).
    handler.guardianAct(11, 0, 0, 0);
    assertGt(handler.guardianOk(), 0);
    assertGt(handler.guardianRejected(), 0);

    // Guardian reduces a never-configured probe budget (0, 0); the owner's first configuration starts full.
    handler.guardianReduceProbe(0, 0, 0);
    handler.ownerConfigureProbe(0, 7_000_000e18, 1e18);
    assertEq(manager.getPoolFundingBudget(handler.probeAt(0)).available, 7_000_000e18);
    assertEq(handler.probeFirstConfigsAfterGuardian(), 1);

    handler.guardianLockdown(1);
    assertEq(handler.lockdowns(), 1);
    handler.guardianLockdown(2); // foreign pool, not active in the registry
    assertEq(handler.lockdownsRejected(), 1);
    handler.ownerAct(11, 0, 0, 0); // rotate guardian
    assertEq(manager.guardian(), guardianB);
    handler.staleGuardianAct(1);
    for (uint256 kind = 0; kind < 6; ++kind) {
      handler.ownerInvalidAct(kind, 3);
    }
    assertEq(handler.ownerRejected(), 6);

    handler.ownerReplaceAdapter(0);
    assertEq(handler.replacements(), 1);
    assertEq(handler.adapterCount(), 3);
    handler.warp(1 days);
    handler.fund(0, 1_000_000e18, 0);
    handler.recall(0, 1_000_000e18, 0);
    assertEq(handler.fundOk(), 3);
    assertEq(handler.recallOk(), 3);

    handler.ownerMigrateReserves(8, address(0), 5_000_000e18 + 3); // recipient, partial amount
    assertEq(handler.migrations(), 1);
    handler.ownerMigrateReserves(2, address(0), 3); // the replaced adapter A
    assertEq(handler.forbiddenMigrationsRejected(), 1);
    handler.handoverDrift(5); // registry administration transfer pending
    handler.handoverDrift(0); // restored
    assertEq(handler.handoverChecks(), 2);
    for (uint256 i = 0; i < 9; ++i) {
      handler.attackerAct(i, 1e18 + i);
    }

    assertEq(handler.violations(), 0, handler.firstViolation());
    _assertTokenConservation();
    _assertAdapters();
    _assertBudgetsAndLimits();
  }

  /// @notice The window envelope is reachable: exhausting the pool budget and retrying immediately is rejected.
  function test_handlerBudgetExhaustionIsRejected() public {
    for (uint256 i = 0; i < 4; ++i) {
      handler.fund(1, 0, 6); // mode 6: exactly the maximum allowed
    }
    assertEq(manager.getPoolFundingBudget(address(poolB)).available, 0);
    uint256 rejectedBefore = handler.fundRejected();
    handler.fund(1, 1, 0);
    assertEq(handler.fundRejected(), rejectedBefore + 1);
    assertEq(handler.violations(), 0, handler.firstViolation());
  }

  /// @notice Registry cutover: the previously active pool needs a migration approval bound to the new registry pool,
  /// which the Guardian can revoke.
  function test_handlerRegistryCutover() public {
    handler.ownerRegistryCutover(1);
    assertEq(registry.getPool(address(token)), address(poolB));
    assertEq(handler.cutovers(), 1);

    handler.fund(0, 1_000_000e18, 0); // pool A is no longer active and not approved
    assertEq(handler.fundRejected(), 1);
    handler.fund(1, 1_000_000e18, 0);
    assertEq(handler.fundOk(), 1);

    handler.ownerAct(10, 1, 0, 0); // approve pool A for migration funding under pool B
    assertEq(manager.getPoolMigrationSource(address(pool)), address(poolB));
    handler.fund(0, 1_000_000e18, 0);
    assertEq(handler.fundOk(), 2);

    handler.guardianAct(5, 0, 0, 0); // Guardian revokes pool A's approval
    assertEq(manager.getPoolMigrationSource(address(pool)), address(0));
    handler.fund(0, 1_000_000e18, 0);
    assertEq(handler.fundRejected(), 2);
    handler.recall(0, 1_000_000e18, 0); // recall does not depend on the registry
    assertEq(handler.recallOk(), 1);

    assertEq(handler.violations(), 0, handler.firstViolation());
    _assertTokenConservation();
    _assertAdapters();
    _assertBudgetsAndLimits();
  }

  // ================================================================
  // │                       Regression tests                       │
  // ================================================================

  /// @notice Reserve migration as the Timelock towards every adapter ever registered (including a replaced one), every
  /// registered pool, the Manager and the token is rejected with `InvalidMigrationDestination`; an unregistered pool
  /// and the recipient are accepted; `type(uint256).max` moves exactly the whole balance.
  function test_regression_migrateReservesRejectsAdaptersAndRegisteredPools() public {
    address replacedAdapter = address(adapter);
    handler.ownerReplaceAdapter(0);
    assertEq(handler.replacements(), 1);
    address currentAdapter = manager.getAdapter(adapterId).adapter;
    assertTrue(currentAdapter != replacedAdapter);
    assertTrue(manager.isRegisteredAdapter(replacedAdapter), "replaced adapter stays in the history");

    address[6] memory forbidden =
      [replacedAdapter, currentAdapter, address(adapterB), address(pool), address(poolB), address(manager)];
    for (uint256 i = 0; i < forbidden.length; ++i) {
      assertTrue(handler.isForbiddenMigrationDestination(forbidden[i]));
      vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidMigrationDestination.selector, forbidden[i]));
      vm.prank(address(timelock));
      manager.migrateReserves(forbidden[i], 1);
      vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidMigrationDestination.selector, forbidden[i]));
      vm.prank(address(timelock));
      manager.migrateReserves(forbidden[i], type(uint256).max);
    }
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidMigrationDestination.selector, address(token)));
    vm.prank(address(timelock));
    manager.migrateReserves(address(token), 1);

    // Same destinations through the handler, plus the fuzzer-style raw destination path (kind 7).
    for (uint256 i = 0; i < forbidden.length; ++i) {
      handler.ownerMigrateReserves(7, forbidden[i], 3 + i);
    }
    handler.ownerMigrateReserves(1, address(0), 3); // token
    handler.ownerMigrateReserves(4, address(0), 0); // pool A with type(uint256).max
    handler.ownerMigrateReserves(14, address(0), 0); // pool B with type(uint256).max
    assertEq(handler.forbiddenMigrationsRejected(), forbidden.length + 3);
    assertEq(handler.migrations(), 0);

    // Unregistered pool and the recipient are valid destinations; max migrates the whole balance (then returned).
    handler.ownerMigrateReserves(6, address(0), 3_000_000e18 + 3);
    handler.ownerMigrateReserves(8, address(0), 0);
    assertEq(handler.migrations(), 2);
    assertEq(handler.fullBalanceMigrations(), 1);
    assertEq(_balance(address(foreignPool)), 3_000_000e18 + 3);
    // A zero-amount probe of an arbitrary untracked destination reaches the amount check.
    handler.ownerMigrateReserves(7, makeAddr("someone"), 3);

    assertEq(handler.violations(), 0, handler.firstViolation());
    _assertTokenConservation();
    _assertAdapters();
    _assertBudgetsAndLimits();
  }

  /// @notice Guardian (0, 0) reductions of a never-configured budget succeed but never initialize it: the owner's first
  /// configuration starts full. Non-zero reductions of it are rejected.
  function test_regression_guardianReduceOnUnconfiguredBucketNeverInitializes() public {
    address probe = handler.probeAt(3);
    handler.guardianReduceProbe(3, 0, 0);
    handler.warp(2 days);
    handler.guardianReduceProbe(3, 0, 0);
    handler.guardianReduceProbe(3, 1, 0); // capacity > 0
    handler.guardianReduceProbe(3, 0, 1); // rate > 0
    assertEq(handler.probeReductions(), 2);
    assertEq(handler.probeReductionsRejected(), 2);
    ILiquidityManager.BudgetState memory state = manager.getPoolFundingBudget(probe);
    assertEq(state.capacity + state.rate + state.available, 0);

    handler.ownerConfigureProbe(3, 9_000_000e18, 100e18);
    assertEq(manager.getPoolFundingBudget(probe).available, 9_000_000e18, "first owner configuration starts full");
    assertEq(handler.probeFirstConfigsAfterGuardian(), 1);

    // Once configured, Guardian reductions are ordinary reductions and never restore usage.
    handler.guardianReduceProbe(3, 1, 0); // capacity / 2
    assertEq(manager.getPoolFundingBudget(probe).capacity, 4_500_000e18);
    handler.ownerConfigureProbe(3, 9_000_000e18, 100e18);
    assertEq(manager.getPoolFundingBudget(probe).available, 4_500_000e18, "reconfiguration does not refill");

    assertEq(handler.violations(), 0, handler.firstViolation());
    _assertBudgetsAndLimits();
  }

  /// @notice A migration approval is bound to the registry pool it was granted under: once the registry moves to a
  /// third (unregistered) pool, neither registered pool can be funded until an approval names that pool.
  function test_regression_migrationApprovalLapsesOnThirdPoolCutover() public {
    handler.ownerRegistryCutover(2);
    assertEq(registry.getPool(address(token)), address(foreignPool));
    assertEq(manager.getPoolMigrationSource(address(poolB)), address(pool));

    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(poolB), address(foreignPool))
    );
    manager.verifyAdapter(adapterIdB);
    handler.fund(0, 1_000_000e18, 0);
    handler.fund(1, 1_000_000e18, 0);
    assertEq(handler.fundRejected(), 2);

    handler.ownerAct(10, 2, 0, 1); // approve pool B under the foreign pool
    assertEq(manager.getPoolMigrationSource(address(poolB)), address(foreignPool));
    handler.fund(1, 1_000_000e18, 0);
    assertEq(handler.fundOk(), 1);

    // The foreign pool is now the registry pool, so the Guardian can lock it down; replacement of pool A's adapter
    // fails the registry check.
    handler.guardianLockdown(2);
    assertEq(handler.lockdowns(), 1);
    handler.ownerReplaceAdapter(0);
    assertEq(handler.replacementsRejected(), 1);
    assertFalse(manager.isRegisteredAdapter(handler.rejectedAdapterAt(0)));

    assertEq(handler.violations(), 0, handler.firstViolation());
    _assertTokenConservation();
    _assertAdapters();
  }

  /// @notice Handover drift (pending registry transfer, registry administrator or token owner away from the Timelock)
  /// fails `verifyHandover` with the exact error but blocks neither adapter replacement nor funding.
  function test_regression_handoverDriftBlocksNeitherReplacementNorFunding() public {
    handler.handoverDrift(5);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminTransferPending.selector, legacyMultisig));
    manager.verifyHandover();
    handler.ownerReplaceAdapter(1);
    handler.fund(1, 1_000_000e18, 0);

    handler.handoverDrift(0);
    handler.handoverDrift(6);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, legacyMultisig));
    manager.verifyHandover();
    handler.ownerReplaceAdapter(0);

    handler.handoverDrift(0);
    handler.handoverDrift(7);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.TokenOwnerMismatch.selector, legacyMultisig));
    manager.verifyHandover();
    handler.ownerReplaceAdapter(1);
    handler.fund(0, 1_000_000e18, 0);

    assertEq(handler.replacementsRejected(), 0, "replacement does not check the handover");
    assertEq(handler.replacements(), 3);
    assertEq(handler.fundOk(), 2, "funding does not check the handover");

    handler.handoverDrift(0);
    manager.verifyHandover();
    assertEq(handler.handoverDrifts(), 3);

    assertEq(handler.violations(), 0, handler.firstViolation());
    _assertTokenConservation();
    _assertAdapters();
  }

  /// @notice Lockdown of address(0) and of an unregistered pool that is not the registry pool are rejected with
  /// `PoolNotRecognized`.
  function test_regression_lockdownRejectsUnrecognizedPools() public {
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, address(0)));
    vm.prank(guardian);
    controller.lockdown(address(0));
    handler.guardianLockdown(3); // address(0)
    handler.guardianLockdown(2); // foreign pool while the registry maps pool A
    assertEq(handler.lockdownsRejected(), 2);
    assertEq(handler.violations(), 0, handler.firstViolation());
  }

  // ================================================================
  // │                           Helpers                            │
  // ================================================================

  function _newPool() internal returns (MockLockReleaseTokenPool newPool) {
    newPool = new MockLockReleaseTokenPool(address(token), router);
    newPool.addChain(
      REMOTE_CHAIN_SELECTOR,
      abi.encode(REMOTE_TOKEN),
      abi.encode(REMOTE_POOL),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
  }

  function _assertTokenConservation() internal view {
    uint256 supply = token.totalSupply();
    assertEq(supply, token.SUPPLY(), "total supply constant");

    uint256 sum = _balance(address(manager)) + _balance(address(pool)) + _balance(address(poolB))
      + _balance(address(foreignPool)) + _balance(treasury) + _balance(bridgeUser) + _balance(migrationRecipient);
    uint256 count = handler.adapterCount();
    for (uint256 i = 0; i < count; ++i) {
      sum += _balance(handler.adapterAt(i));
    }
    assertEq(sum, supply, "every token accounted for");

    assertEq(
      _balance(address(manager)),
      handler.ghostManagerStart() + handler.ghostRecalled() + handler.ghostDustToManager() + handler.ghostReturned()
        - handler.ghostFunded() - handler.ghostMigrated(),
      "Manager ledger"
    );
    for (uint256 p = 0; p < 2; ++p) {
      assertEq(
        _balance(address(handler.poolAt(p))),
        handler.poolStart(p) + handler.fundedTo(p) + handler.inflow(p) - handler.recalledFrom(p) - handler.outflow(p),
        "pool ledger"
      );
    }
    assertEq(
      _balance(migrationRecipient),
      handler.migratedTo(migrationRecipient) - handler.returnedFrom(migrationRecipient),
      "recipient ledger"
    );
    assertEq(
      _balance(address(foreignPool)),
      handler.migratedTo(address(foreignPool)) - handler.returnedFrom(address(foreignPool)),
      "foreign pool ledger"
    );
    uint256 dustTotal;
    for (uint256 i = 0; i < count; ++i) {
      address adapter_ = handler.adapterAt(i);
      assertEq(_balance(adapter_), handler.ghostDust(adapter_), "adapter balance == unsolicited dust");
      dustTotal += _balance(adapter_);
    }
    assertEq(dustTotal, handler.ghostDustToAdapters(), "total adapter dust");
    assertEq(_balance(attacker), 0, "attacker holds nothing");
    assertEq(_balance(address(handler)), 0, "handler holds nothing");
  }

  function _assertAdapters() internal view {
    uint256 count = handler.adapterCount();
    address[] memory history = manager.getAdapterHistory();
    assertEq(history.length, count, "adapter history length");
    for (uint256 i = 0; i < count; ++i) {
      address adapter_ = handler.adapterAt(i);
      assertEq(history[i], adapter_, "adapter history order");
      assertTrue(manager.isRegisteredAdapter(adapter_), "every adapter ever registered stays registered");
      assertEq(token.allowance(adapter_, address(pool)), 0, "allowance to pool A");
      assertEq(token.allowance(adapter_, address(poolB)), 0, "allowance to pool B");
      assertEq(ILiquidityAdapter(adapter_).MANAGER(), address(manager));
      assertEq(ILiquidityAdapter(adapter_).TOKEN(), address(token));
    }
    uint256 rejected = handler.rejectedAdapterCount();
    for (uint256 i = 0; i < rejected; ++i) {
      assertFalse(manager.isRegisteredAdapter(handler.rejectedAdapterAt(i)), "rejected adapter never registered");
    }

    assertEq(manager.adapterCount(), 2, "adapter ids are never added by the handler");
    for (uint256 p = 0; p < 2; ++p) {
      MockLockReleaseTokenPool pool_ = handler.poolAt(p);
      uint256 id = handler.adapterId(p);
      assertEq(manager.adapterIdByPool(address(pool_)), id, "one id per pool");
      ILiquidityManager.Adapter memory entry = manager.getAdapter(id);
      assertEq(entry.pool, address(pool_), "registry pool fixed");
      assertEq(entry.adapter, pool_.getRebalancer(), "registered adapter is the pool rebalancer");
      assertEq(ILiquidityAdapter(entry.adapter).POOL(), address(pool_), "adapter bound to its pool");
      assertEq(
        manager.getPoolMigrationSource(address(pool_)), handler.ghostMigrationSource(p), "migration source ghost"
      );
    }
    assertEq(manager.adapterIdByPool(address(foreignPool)), 0, "foreign pool never registered");

    assertFalse(manager.isFundingOperator(attacker));
    assertFalse(manager.isRecallOperator(attacker));
    assertFalse(manager.isRecallOperator(fundingOperator), "role separation");
    assertFalse(manager.isFundingOperator(recallOperator), "role separation");
    address currentGuardian = manager.guardian();
    assertFalse(manager.isFundingOperator(currentGuardian), "guardian is never an operator");
    assertFalse(manager.isRecallOperator(currentGuardian), "guardian is never an operator");
    assertEq(manager.owner(), address(timelock));
    assertTrue(currentGuardian == guardian || currentGuardian == guardianB, "guardian only set by the owner");
  }

  function _assertBudgetsAndLimits() internal view {
    for (uint256 b = 0; b < 4; ++b) {
      ILiquidityManager.BudgetState memory state = handler.budget(b);
      assertLe(state.available, state.capacity, "available <= capacity");
      assertEq(state.available, handler.modelAvailable(b), "budget matches the reference model");
      assertLe(state.capacity, handler.baselineCapacity(b), "capacity <= last owner setting");
      assertLe(state.rate, handler.baselineRate(b), "rate <= last owner setting");
    }
    assertLe(manager.maxFundingPerCall(), handler.baselineMaxFunding(), "max funding <= last owner setting");
    assertLe(manager.maxRecallPerCall(), handler.baselineMaxRecall(), "max recall <= last owner setting");
    for (uint256 p = 0; p < 2; ++p) {
      MockLockReleaseTokenPool pool_ = handler.poolAt(p);
      (ILiquidityManager.PoolThresholds memory thresholds, bool isSet) = manager.getPoolThresholds(address(pool_));
      assertTrue(isSet, "registered pools have thresholds");
      assertGe(thresholds.minimum, handler.baselineMinimum(p), "minimum >= last owner setting");
    }
    uint256 probes = handler.PROBES();
    for (uint256 i = 0; i < probes; ++i) {
      address probe = handler.probeAt(i);
      if (handler.probeConfigured(probe)) continue;
      ILiquidityManager.BudgetState memory state = manager.getPoolFundingBudget(probe);
      assertEq(state.capacity + state.rate + state.available, 0, "unconfigured probe budget stays empty");
    }
  }
}
