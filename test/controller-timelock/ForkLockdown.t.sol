// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {SaharaTimelock} from "src/SaharaTimelock.sol";
import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";
import {ITokenAdminRegistry} from "src/interfaces/ITokenAdminRegistry.sol";

/// @notice Extra views/admin of the deployed `LockReleaseTokenPool 1.6.3-dev` used by the fork checks.
interface IDeployedPool {
  struct TokenBucket {
    uint128 tokens;
    uint32 lastUpdated;
    bool isEnabled;
    uint128 capacity;
    uint128 rate;
  }

  function getCurrentOutboundRateLimiterState(uint64 remoteChainSelector) external view returns (TokenBucket memory);

  function getCurrentInboundRateLimiterState(uint64 remoteChainSelector) external view returns (TokenBucket memory);

  function setRateLimitAdmin(address rateLimitAdmin) external;
}

/// @notice Fork checks of GuardianController.lockdown against the deployed SAHARA pools and TokenAdminRegistries:
/// the real RateLimiter accepts {enabled, 0, 0} from the rate limit admin, the registry path recognizes the pool, and
/// an owner restoration starts the bucket from zero.
/// @dev Gated: runs only with RUN_FORK_TESTS=true, otherwise every test is skipped before any RPC is contacted, so a
/// plain `forge test` never touches the network. Once enabled, an unreachable RPC fails the test instead of skipping it,
/// so CI cannot report a lockdown check that never ran as passing.
contract ForkLockdownTest is Test {
  address internal constant TOKEN = 0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111;
  address internal constant POOL = 0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4;
  address internal constant POOL_OWNER = 0x6601ee913f8b431F300120Dc0FFDee670Ba4e109;
  address internal constant ETH_REGISTRY = 0xb22764f98dD05c789929716D677382Df22C05Cb6;
  address internal constant BSC_REGISTRY = 0x736Fd8660c443547a85e4Eaf70A49C1b7Bb008fc;
  uint64 internal constant ETH_SELECTOR = 5009297550715157269;
  uint64 internal constant BSC_SELECTOR = 11344663589394136015;

  address internal guardian = makeAddr("guardian");
  address internal governanceSafe = makeAddr("governanceSafe");

  function setUp() public {
    if (!vm.envOr("RUN_FORK_TESTS", false)) {
      vm.skip(true);
      return;
    }
  }

  function _fork(string memory envKey, string memory fallbackUrl) internal {
    vm.createSelectFork(vm.envOr(envKey, fallbackUrl));
  }

  function _single(address account) internal pure returns (address[] memory accounts) {
    accounts = new address[](1);
    accounts[0] = account;
  }

  function _deployController(address registry) internal returns (LiquidityManager manager, GuardianController ctl) {
    SaharaTimelock timelock = new SaharaTimelock(
      72 hours, 24 hours, 30 days, _single(governanceSafe), _single(governanceSafe), new address[](0)
    );
    manager = new LiquidityManager(TOKEN, ITokenAdminRegistry(registry), address(timelock), guardian);
    ctl = new GuardianController(manager, timelock);
  }

  function _assertZeroBucket(IDeployedPool.TokenBucket memory bucket) internal pure {
    assertTrue(bucket.isEnabled, "enabled");
    assertEq(bucket.capacity, 0, "capacity");
    assertEq(bucket.rate, 0, "rate");
    assertEq(bucket.tokens, 0, "tokens");
  }

  function _checkLockdownAndRestore(address registry, uint64 counterpart) internal {
    assertEq(ITokenAdminRegistry(registry).getPool(TOKEN), POOL, "registry maps token to pool");
    uint64[] memory chains = ILockReleaseTokenPool(POOL).getSupportedChains();
    assertEq(chains.length, 1);
    assertEq(chains[0], counterpart);

    (LiquidityManager manager, GuardianController ctl) = _deployController(registry);
    assertEq(manager.adapterIdByPool(POOL), 0, "recognized only via the registry");

    // Before handover the controller is not the rate limit admin: the real pool rejects it.
    vm.expectRevert(abi.encodeWithSignature("Unauthorized(address)", address(ctl)));
    vm.prank(guardian);
    ctl.lockdown(POOL);

    vm.prank(POOL_OWNER);
    IDeployedPool(POOL).setRateLimitAdmin(address(ctl));

    vm.expectEmit(true, true, true, true, address(ctl));
    emit GuardianController.PoolLockedDown(POOL, counterpart, guardian);
    vm.prank(guardian);
    ctl.lockdown(POOL);

    _assertZeroBucket(IDeployedPool(POOL).getCurrentOutboundRateLimiterState(counterpart));
    _assertZeroBucket(IDeployedPool(POOL).getCurrentInboundRateLimiterState(counterpart));

    // Time does not refill a zero-capacity bucket.
    vm.warp(block.timestamp + 30 days);
    _assertZeroBucket(IDeployedPool(POOL).getCurrentOutboundRateLimiterState(counterpart));

    // Owner restoration starts from an empty bucket and refills at the restored rate.
    ILockReleaseTokenPool.RateLimiterConfig memory restored =
      ILockReleaseTokenPool.RateLimiterConfig({isEnabled: true, capacity: 300_000_000e18, rate: 3_500e18});
    vm.prank(POOL_OWNER);
    ILockReleaseTokenPool(POOL).setChainRateLimiterConfig(counterpart, restored, restored);
    assertEq(IDeployedPool(POOL).getCurrentOutboundRateLimiterState(counterpart).tokens, 0, "starts empty");
    vm.warp(block.timestamp + 10);
    assertEq(IDeployedPool(POOL).getCurrentOutboundRateLimiterState(counterpart).tokens, 35_000e18, "refills");
    assertEq(IDeployedPool(POOL).getCurrentInboundRateLimiterState(counterpart).tokens, 35_000e18, "refills");

    // A non-guardian cannot lock down the real pool through the controller.
    vm.expectRevert(abi.encodeWithSelector(GuardianController.CallerNotGuardian.selector, address(this)));
    ctl.lockdown(POOL);

    // address(0) is never a recognized pool, whatever the registry maps.
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, address(0)));
    vm.prank(guardian);
    ctl.lockdown(address(0));
  }

  function test_fork_ethereum_lockdownAndRestore() public {
    _fork("ETH_RPC_URL", "https://ethereum-rpc.publicnode.com");
    _checkLockdownAndRestore(ETH_REGISTRY, BSC_SELECTOR);
  }

  function test_fork_bsc_lockdownAndRestore() public {
    _fork("BSC_RPC_URL", "https://bsc-dataseed.bnbchain.org");
    _checkLockdownAndRestore(BSC_REGISTRY, ETH_SELECTOR);
  }
}
