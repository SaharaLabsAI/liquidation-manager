// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {SaharaTimelock} from "src/SaharaTimelock.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";
import {MockSahara} from "test/mocks/MockSahara.sol";
import {MockTokenAdminRegistry} from "test/mocks/MockTokenAdminRegistry.sol";

/// @notice Full local deployment: token, CCIP pool replica and registry, SaharaTimelock, LiquidityManager,
/// GuardianController and CCIPPoolAdapter, wired the way production is meant to be after handover.
/// Owner-only Manager calls can be made with `vm.prank(address(timelock))` in unit tests, or through
/// `_scheduleAndExecute` for end-to-end governance tests.
abstract contract BaseTest is Test {
  // Counterpart (remote) chain: BSC as seen from Ethereum.
  uint64 internal constant REMOTE_CHAIN_SELECTOR = 11344663589394136015;
  address internal constant REMOTE_TOKEN = 0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111;
  address internal constant REMOTE_POOL = 0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4;
  string internal constant POOL_VERSION = "LockReleaseTokenPool 1.6.3-dev";

  uint256 internal constant TIMELOCK_DELAY = 72 hours;
  uint256 internal constant TIMELOCK_MINIMUM_DELAY = 24 hours;
  uint256 internal constant TIMELOCK_MAXIMUM_DELAY = 30 days;

  // Operating parameters used by the fixture.
  uint256 internal constant POOL_MINIMUM = 20_000_000e18;
  uint256 internal constant POOL_REFILL_TRIGGER = 50_000_000e18;
  uint256 internal constant POOL_REFILL_TARGET = 100_000_000e18;
  uint256 internal constant MAX_FUNDING_PER_CALL = 25_000_000e18;
  uint256 internal constant AGGREGATE_FUNDING_CAPACITY = 100_000_000e18;
  uint256 internal constant AGGREGATE_FUNDING_RATE = AGGREGATE_FUNDING_CAPACITY / 1 days;
  uint256 internal constant POOL_FUNDING_CAPACITY = 50_000_000e18;
  uint256 internal constant POOL_FUNDING_RATE = POOL_FUNDING_CAPACITY / 1 days;
  uint256 internal constant MAX_RECALL_PER_CALL = 25_000_000e18;
  uint256 internal constant RECALL_CAPACITY = 50_000_000e18;
  uint256 internal constant RECALL_RATE = RECALL_CAPACITY / 1 days;

  uint256 internal constant MANAGER_RESERVES = 1_000_000_000e18;
  uint256 internal constant POOL_INVENTORY = 80_000_000e18;

  uint128 internal constant CCIP_CAPACITY = 300_000_000e18;
  uint128 internal constant CCIP_RATE = 3_500e18;

  address internal governanceSafe = makeAddr("governanceSafe");
  address internal guardian = makeAddr("guardian");
  address internal fundingOperator = makeAddr("fundingOperator");
  address internal recallOperator = makeAddr("recallOperator");
  address internal router = makeAddr("router");
  address internal treasury = makeAddr("treasury");
  address internal attacker = makeAddr("attacker");

  MockSahara internal token;
  MockTokenAdminRegistry internal registry;
  MockLockReleaseTokenPool internal pool;
  SaharaTimelock internal timelock;
  LiquidityManager internal manager;
  GuardianController internal controller;
  CCIPPoolAdapter internal adapter;
  uint256 internal adapterId;

  function setUp() public virtual {
    vm.warp(1_700_000_000);

    token = new MockSahara(treasury);
    registry = new MockTokenAdminRegistry();
    pool = new MockLockReleaseTokenPool(address(token), router);
    pool.addChain(
      REMOTE_CHAIN_SELECTOR,
      abi.encode(REMOTE_TOKEN),
      abi.encode(REMOTE_POOL),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
    registry.setPool(address(token), address(pool));

    // The controller needs the Timelock and the Timelock grants CANCELLER_ROLE to the controller at construction, so
    // the controller address is predicted: timelock (nonce n), manager (n + 1), controller (n + 2).
    uint64 nonce = vm.getNonce(address(this));
    address predictedController = vm.computeCreateAddress(address(this), nonce + 2);

    timelock = new SaharaTimelock(
      TIMELOCK_DELAY,
      TIMELOCK_MINIMUM_DELAY,
      TIMELOCK_MAXIMUM_DELAY,
      _single(governanceSafe),
      _single(governanceSafe),
      _single(predictedController)
    );
    manager = new LiquidityManager(address(token), registry, address(timelock), guardian);
    controller = new GuardianController(manager, timelock);
    assertEq(address(controller), predictedController, "controller address prediction");

    adapter = new CCIPPoolAdapter(address(manager), address(token), address(pool));

    // Handover: adapter is the pool's sole rebalancer, controller its rate limit admin, and the Timelock owns the pool
    // and the token and administers the token in the TokenAdminRegistry.
    pool.setRebalancer(address(adapter));
    pool.setRateLimitAdmin(address(controller));
    pool.transferOwnership(address(timelock));
    registry.setAdministrator(address(token), address(timelock));
    token.transferOwnership(address(timelock));

    vm.startPrank(address(timelock));
    manager.setPoolSpec(address(pool), _poolSpec());
    manager.setPoolThresholds(address(pool), POOL_MINIMUM, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET);
    manager.setPoolFundingBudget(address(pool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    manager.setAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    manager.setMaxFundingPerCall(MAX_FUNDING_PER_CALL);
    manager.setRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE);
    manager.setFundingOperator(fundingOperator, true);
    manager.setRecallOperator(recallOperator, true);
    adapterId = manager.registerAdapter(address(adapter), address(pool));
    vm.stopPrank();

    vm.startPrank(treasury);
    token.transfer(address(manager), MANAGER_RESERVES);
    token.transfer(address(pool), POOL_INVENTORY);
    vm.stopPrank();

    vm.label(address(token), "SAHARA");
    vm.label(address(registry), "TokenAdminRegistry");
    vm.label(address(pool), "LockReleaseTokenPool");
    vm.label(address(timelock), "Timelock");
    vm.label(address(manager), "LiquidityManager");
    vm.label(address(controller), "GuardianController");
    vm.label(address(adapter), "CCIPPoolAdapter");
  }

  // ---------------------------------------------------------------- helpers

  function _poolSpec() internal view returns (ILiquidityManager.PoolSpec memory spec) {
    spec.typeAndVersion = POOL_VERSION;
    spec.router = router;
    spec.remoteChainSelector = REMOTE_CHAIN_SELECTOR;
    spec.remoteToken = abi.encode(REMOTE_TOKEN);
    spec.remotePools = new bytes[](1);
    spec.remotePools[0] = abi.encode(REMOTE_POOL);
    spec.rateLimitAdmin = address(controller);
  }

  function _fund(uint256 amount) internal {
    vm.prank(fundingOperator);
    manager.fund(adapterId, amount);
  }

  function _recall(uint256 amount) internal {
    vm.prank(recallOperator);
    manager.recall(adapterId, amount);
  }

  function _balance(address account) internal view returns (uint256) {
    return token.balanceOf(account);
  }

  /// @dev Schedules a single call from the Governance Safe, waits the delay and executes it.
  function _scheduleAndExecute(address target, bytes memory data, bytes32 salt) internal {
    vm.prank(governanceSafe);
    timelock.schedule(target, 0, data, bytes32(0), salt, TIMELOCK_DELAY);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.prank(governanceSafe);
    timelock.execute(target, 0, data, bytes32(0), salt);
  }

  function _schedule(address target, bytes memory data, bytes32 predecessor, bytes32 salt) internal returns (bytes32) {
    vm.prank(governanceSafe);
    timelock.schedule(target, 0, data, predecessor, salt, TIMELOCK_DELAY);
    return timelock.hashOperation(target, 0, data, predecessor, salt);
  }

  function _ccipBucket(uint128 capacity, uint128 rate)
    internal
    pure
    returns (ILockReleaseTokenPool.RateLimiterConfig memory)
  {
    return ILockReleaseTokenPool.RateLimiterConfig({isEnabled: true, capacity: capacity, rate: rate});
  }

  function _single(address account) internal pure returns (address[] memory accounts) {
    accounts = new address[](1);
    accounts[0] = account;
  }
}
