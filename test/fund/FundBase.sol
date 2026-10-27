// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {TokenBucket} from "src/libraries/TokenBucket.sol";

import {BaseTest} from "test/utils/BaseTest.sol";
import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";

/// @notice Shared helpers for the `LiquidityManager.fund` unit tests.
abstract contract FundBase is BaseTest {
  /// @dev A chain selector other than the spec's counterpart (Ethereum's selector, as seen from BSC).
  uint64 internal constant OTHER_CHAIN_SELECTOR = 5009297550715157269;
  address internal constant OTHER_REMOTE_POOL = 0x000000000000000000000000000000000000bEEF;

  /// @dev Balances and budgets touched by `fund`, captured to prove a reverted call changed nothing.
  struct Snapshot {
    uint256 manager;
    uint256 adapter;
    uint256 pool;
    uint256 allowance;
    uint256 aggregateBudget;
    uint256 poolBudget;
  }

  function _fundAs(address caller, uint256 id, uint256 amount) internal {
    vm.prank(caller);
    manager.fund(id, amount);
  }

  function _expectFundRevert(address caller, uint256 id, uint256 amount, bytes memory err) internal {
    vm.prank(caller);
    vm.expectRevert(err);
    manager.fund(id, amount);
  }

  function _budgetExceeded(uint256 requested, uint256 available) internal pure returns (bytes memory) {
    return abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, requested, available);
  }

  function _aggregateAvailable() internal view returns (uint256) {
    return manager.getAggregateFundingBudget().available;
  }

  function _poolAvailable(address p) internal view returns (uint256) {
    return manager.getPoolFundingBudget(p).available;
  }

  function _snapshot(address a, address p) internal view returns (Snapshot memory s) {
    s.manager = _balance(address(manager));
    s.adapter = _balance(a);
    s.pool = _balance(p);
    s.allowance = token.allowance(a, p);
    s.aggregateBudget = _aggregateAvailable();
    s.poolBudget = _poolAvailable(p);
  }

  function _assertUnchanged(Snapshot memory s, address a, address p) internal view {
    assertEq(_balance(address(manager)), s.manager, "manager balance changed");
    assertEq(_balance(a), s.adapter, "adapter balance changed");
    assertEq(_balance(p), s.pool, "pool balance changed");
    assertEq(token.allowance(a, p), s.allowance, "allowance changed");
    assertEq(_aggregateAvailable(), s.aggregateBudget, "aggregate budget changed");
    assertEq(_poolAvailable(p), s.poolBudget, "pool budget changed");
  }

  /// @dev Wires a freshly deployed pool (owned by this test) like the fixture pool: counterpart chain, `adapterAddr` as
  /// rebalancer, controller as rate limit admin, Timelock (the Manager owner) as owner. Then, as the Timelock, sets its
  /// spec and thresholds, optionally its funding budget, approves it for migration funding bound to the fixture pool
  /// (the pool the registry maps SAHARA to) and registers `adapterAddr` for it.
  function _wireAndRegister(MockLockReleaseTokenPool p, address adapterAddr, bool configureBudget)
    internal
    returns (uint256 id)
  {
    p.addChain(
      REMOTE_CHAIN_SELECTOR,
      abi.encode(REMOTE_TOKEN),
      abi.encode(REMOTE_POOL),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
    p.setRebalancer(adapterAddr);
    p.setRateLimitAdmin(address(controller));
    p.transferOwnership(address(timelock));

    vm.startPrank(address(timelock));
    manager.setPoolSpec(address(p), _poolSpec());
    manager.setPoolThresholds(address(p), POOL_MINIMUM, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET);
    if (configureBudget) manager.setPoolFundingBudget(address(p), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    manager.setPoolMigrationApproval(address(p), address(pool));
    id = manager.registerAdapter(adapterAddr, address(p));
    vm.stopPrank();
  }

  /// @dev Deploys and registers an honest second pool with a `CCIPPoolAdapter`.
  function _deployHonestPool(bool configureBudget)
    internal
    returns (MockLockReleaseTokenPool p, CCIPPoolAdapter a, uint256 id)
  {
    p = new MockLockReleaseTokenPool(address(token), router);
    a = new CCIPPoolAdapter(address(manager), address(token), address(p));
    id = _wireAndRegister(p, address(a), configureBudget);
  }

  function _seed(address account, uint256 amount) internal {
    if (amount == 0) return;
    vm.prank(treasury);
    token.transfer(account, amount);
  }

  function _min(uint256 a, uint256 b) internal pure returns (uint256) {
    return a < b ? a : b;
  }

  // Silences "unused import" for ILiquidityManager in derived contracts that only use it through this base.
  function _budget(address p) internal view returns (ILiquidityManager.BudgetState memory) {
    return manager.getPoolFundingBudget(p);
  }
}
