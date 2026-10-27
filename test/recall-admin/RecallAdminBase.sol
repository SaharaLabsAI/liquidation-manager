// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";
import {BaseTest} from "test/utils/BaseTest.sol";

/// @notice Shared helpers for the recall and admin suites.
abstract contract RecallAdminBase is BaseTest {
  uint64 internal constant OTHER_CHAIN_SELECTOR = 5009297550715157269;
  address internal constant OTHER_REMOTE_POOL = 0x000000000000000000000000000000000000dEaD;

  /// @dev Sends `amount` SAHARA from the treasury to `to` (unsolicited transfer).
  function _seed(address to, uint256 amount) internal {
    vm.prank(treasury);
    token.transfer(to, amount);
  }

  /// @dev Moves the SAHARA balance of a pool replica to exactly `target` (bridge outflow or unsolicited inflow).
  function _setPoolBalance(address target_, uint256 target) internal {
    uint256 balance = token.balanceOf(target_);
    if (balance > target) {
      MockLockReleaseTokenPool(target_).simulateRelease(attacker, balance - target);
    } else if (balance < target) {
      _seed(target_, target - balance);
    }
  }

  /// @dev Configures a freshly deployed pool replica (owned by this test contract) like the fixture pool and hands it
  /// over: `rebalancer` as rebalancer, the controller as rate limit admin and the Timelock as owner.
  function _handover(MockLockReleaseTokenPool newPool, address rebalancer) internal {
    newPool.addChain(
      REMOTE_CHAIN_SELECTOR,
      abi.encode(REMOTE_TOKEN),
      abi.encode(REMOTE_POOL),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
    newPool.setRebalancer(rebalancer);
    newPool.setRateLimitAdmin(address(controller));
    newPool.transferOwnership(address(timelock));
  }

  /// @dev Deploys an adapter for `newPool`, hands the pool over and sets its spec and thresholds (both required before
  /// registration), and optionally a migration approval under the fixture pool, which the registry keeps mapping the
  /// token to. Does not register.
  function _preparePool(MockLockReleaseTokenPool newPool, bool approveMigration)
    internal
    returns (CCIPPoolAdapter newAdapter)
  {
    newAdapter = new CCIPPoolAdapter(address(manager), address(token), address(newPool));
    _handover(newPool, address(newAdapter));
    vm.startPrank(address(timelock));
    manager.setPoolSpec(address(newPool), _poolSpec());
    manager.setPoolThresholds(address(newPool), POOL_MINIMUM, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET);
    if (approveMigration) manager.setPoolMigrationApproval(address(newPool), address(pool));
    vm.stopPrank();
  }

  /// @dev Prepares, configures and registers `newPool` (via migration approval) and seeds it with `POOL_INVENTORY`.
  function _registerPool(MockLockReleaseTokenPool newPool) internal returns (CCIPPoolAdapter newAdapter, uint256 id) {
    newAdapter = _preparePool(newPool, true);
    vm.startPrank(address(timelock));
    manager.setPoolFundingBudget(address(newPool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    id = manager.registerAdapter(address(newAdapter), address(newPool));
    vm.stopPrank();
    _seed(address(newPool), POOL_INVENTORY);
  }

  /// @dev Moves the fixture pool's rebalancer role to `newAdapter` and replaces the fixture adapter with it.
  function _installAdapter(address newAdapter) internal {
    vm.startPrank(address(timelock));
    pool.setRebalancer(newAdapter);
    manager.replaceAdapter(adapterId, newAdapter);
    vm.stopPrank();
  }

  function _recallAs(address caller, uint256 id, uint256 amount) internal {
    vm.prank(caller);
    manager.recall(id, amount);
  }

  function _fundAs(address caller, uint256 id, uint256 amount) internal {
    vm.prank(caller);
    manager.fund(id, amount);
  }

  function _min(uint256 a, uint256 b) internal pure returns (uint256) {
    return a < b ? a : b;
  }

  /// @dev The stored thresholds of `pool_`, ignoring whether they were set by the owner.
  function _thresholds(address pool_) internal view returns (ILiquidityManager.PoolThresholds memory thresholds) {
    (thresholds,) = manager.getPoolThresholds(pool_);
  }
}
