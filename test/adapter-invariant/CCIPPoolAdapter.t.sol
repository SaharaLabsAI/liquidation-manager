// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {ILiquidityAdapter} from "src/interfaces/ILiquidityAdapter.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";
import {MockSahara} from "test/mocks/MockSahara.sol";
import {BaseTest} from "test/utils/BaseTest.sol";

import {ConfigurablePool} from "test/adapter-invariant/mocks/ConfigurablePool.sol";
import {StickyAllowanceToken} from "test/adapter-invariant/mocks/StickyAllowanceToken.sol";

/// @notice Unit tests of `CCIPPoolAdapter` in isolation. The Manager is a plain account so every adapter branch can be
/// reached directly (through the real Manager its own checks fire first).
contract CCIPPoolAdapterTest is Test {
  event LiquidityAdded(address indexed provider, uint256 indexed amount);
  event LiquidityRemoved(address indexed provider, uint256 indexed amount);

  uint256 internal constant MANAGER_BALANCE = 1_000_000_000e18;
  uint256 internal constant POOL_BALANCE = 100_000_000e18;

  address internal manager = makeAddr("manager");
  address internal treasury = makeAddr("treasury");
  address internal router = makeAddr("router");
  address internal stranger = makeAddr("stranger");

  MockSahara internal token;
  ConfigurablePool internal pool;
  CCIPPoolAdapter internal adapter;

  function setUp() public {
    token = new MockSahara(treasury);
    pool = new ConfigurablePool(address(token), router);
    adapter = new CCIPPoolAdapter(manager, address(token), address(pool));
    pool.setRebalancer(address(adapter));

    vm.startPrank(treasury);
    token.transfer(manager, MANAGER_BALANCE);
    token.transfer(address(pool), POOL_BALANCE);
    vm.stopPrank();
  }

  // ================================================================
  // │                         Constructor                          │
  // ================================================================

  function test_constructor_setsImmutableBindings() public view {
    assertEq(adapter.MANAGER(), manager);
    assertEq(adapter.TOKEN(), address(token));
    assertEq(adapter.POOL(), address(pool));
  }

  function test_constructor_revertsOnZeroManager() public {
    vm.expectRevert(CCIPPoolAdapter.ZeroAddress.selector);
    new CCIPPoolAdapter(address(0), address(token), address(pool));
  }

  function test_constructor_revertsOnZeroToken() public {
    vm.expectRevert(CCIPPoolAdapter.ZeroAddress.selector);
    new CCIPPoolAdapter(manager, address(0), address(pool));
  }

  function test_constructor_revertsOnZeroPool() public {
    vm.expectRevert(CCIPPoolAdapter.ZeroAddress.selector);
    new CCIPPoolAdapter(manager, address(token), address(0));
  }

  function testFuzz_constructor_revertsOnPoolTokenMismatch(address wrongToken) public {
    vm.assume(wrongToken != address(0) && wrongToken != address(token));
    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.PoolTokenMismatch.selector, address(token), wrongToken));
    new CCIPPoolAdapter(manager, wrongToken, address(pool));
  }

  function test_constructor_revertsWhenPoolReportsZeroToken() public {
    MockLockReleaseTokenPool tokenlessPool = new MockLockReleaseTokenPool(address(0), router);
    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.PoolTokenMismatch.selector, address(0), address(token)));
    new CCIPPoolAdapter(manager, address(token), address(tokenlessPool));
  }

  function test_constructor_revertsWhenPoolIsNotAContract() public {
    vm.expectRevert();
    new CCIPPoolAdapter(manager, address(token), makeAddr("eoaPool"));
  }

  // ================================================================
  // │                        Access control                        │
  // ================================================================

  function testFuzz_fund_revertsForNonManager(address caller, uint256 amount) public {
    vm.assume(caller != manager);
    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, caller));
    vm.prank(caller);
    adapter.fund(amount);
  }

  function testFuzz_recall_revertsForNonManager(address caller, uint256 amount) public {
    vm.assume(caller != manager);
    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, caller));
    vm.prank(caller);
    adapter.recall(amount);
  }

  function test_fund_revertsForPoolAndTokenCallers() public {
    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, address(pool)));
    vm.prank(address(pool));
    adapter.fund(1);

    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, address(token)));
    vm.prank(address(token));
    adapter.fund(1);
  }

  function test_recall_revertsForPoolAndTokenCallers() public {
    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, address(pool)));
    vm.prank(address(pool));
    adapter.recall(1);

    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, address(token)));
    vm.prank(address(token));
    adapter.recall(1);
  }

  // ================================================================
  // │                             fund                             │
  // ================================================================

  function testFuzz_fund_approvesExactlyAmountAndResetsAllowance(uint256 amount) public {
    amount = bound(amount, 1, MANAGER_BALANCE);
    _managerFund(amount);

    assertEq(pool.provideCalls(), 1, "provideLiquidity calls");
    assertEq(pool.recordedAllowance(), amount, "allowance seen by the pool");
    assertEq(pool.recordedRebalancerBalance(), amount, "adapter balance seen by the pool");
    assertEq(token.allowance(address(adapter), address(pool)), 0, "allowance after");
    assertEq(token.balanceOf(address(adapter)), 0, "adapter balance after");
    assertEq(token.balanceOf(address(pool)), POOL_BALANCE + amount, "pool balance after");
    assertEq(token.balanceOf(manager), MANAGER_BALANCE - amount, "manager balance after");
  }

  function test_fund_emitsApproveTransferLiquidityAddedReset() public {
    uint256 amount = 7_000_000e18;
    vm.prank(manager);
    token.transfer(address(adapter), amount);

    vm.expectEmit(true, true, false, true, address(token));
    emit IERC20.Approval(address(adapter), address(pool), amount);
    vm.expectEmit(true, true, false, true, address(token));
    emit IERC20.Transfer(address(adapter), address(pool), amount);
    vm.expectEmit(true, true, false, true, address(pool));
    emit LiquidityAdded(address(adapter), amount);
    vm.expectEmit(true, true, false, true, address(token));
    emit IERC20.Approval(address(adapter), address(pool), 0);

    vm.prank(manager);
    adapter.fund(amount);
  }

  function testFuzz_fund_revertsOnNonZeroAllowanceAtEntry(uint256 allowance, uint256 amount) public {
    allowance = bound(allowance, 1, type(uint256).max);
    amount = bound(amount, 0, MANAGER_BALANCE);
    vm.prank(address(adapter));
    token.approve(address(pool), allowance);
    vm.prank(manager);
    token.transfer(address(adapter), amount);

    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.NonZeroAllowance.selector, allowance));
    vm.prank(manager);
    adapter.fund(amount);

    assertEq(pool.provideCalls(), 0, "pool must not be reached");
    assertEq(token.allowance(address(adapter), address(pool)), allowance, "allowance untouched by the revert");
  }

  function test_fund_revertsOnNonZeroAllowanceAtExit_whenPoolPullsLessAndResetIsIgnored() public {
    (StickyAllowanceToken sticky, ConfigurablePool stickyPool, CCIPPoolAdapter stickyAdapter) = _stickySetup();
    uint256 amount = 1_000e18;
    uint256 skimmed = 3e18;
    stickyPool.setMode(ConfigurablePool.Mode.PullLess, skimmed);
    vm.prank(manager);
    sticky.transfer(address(stickyAdapter), amount);

    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.NonZeroAllowance.selector, skimmed));
    vm.prank(manager);
    stickyAdapter.fund(amount);
  }

  function test_fund_revertsOnNonZeroAllowanceAtExit_whenPoolPullsNothingAndResetIsIgnored() public {
    (StickyAllowanceToken sticky, ConfigurablePool stickyPool, CCIPPoolAdapter stickyAdapter) = _stickySetup();
    uint256 amount = 1_000e18;
    stickyPool.setMode(ConfigurablePool.Mode.PullNone, 0);
    vm.prank(manager);
    sticky.transfer(address(stickyAdapter), amount);

    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.NonZeroAllowance.selector, amount));
    vm.prank(manager);
    stickyAdapter.fund(amount);
  }

  function test_fund_exitCheckPassesWhenPoolConsumesTheWholeAllowance() public {
    // With an ignored reset, the exit check only passes because transferFrom consumed the exact approval.
    (StickyAllowanceToken sticky, ConfigurablePool stickyPool, CCIPPoolAdapter stickyAdapter) = _stickySetup();
    uint256 amount = 1_000e18;
    vm.startPrank(manager);
    sticky.transfer(address(stickyAdapter), amount);
    stickyAdapter.fund(amount);
    vm.stopPrank();
    assertEq(sticky.allowance(address(stickyAdapter), address(stickyPool)), 0);
    assertEq(sticky.balanceOf(address(stickyPool)), amount);
  }

  function test_fund_resetsAllowanceWhenPoolPullsLess() public {
    uint256 amount = 5_000_000e18;
    uint256 skimmed = 1e18;
    pool.setMode(ConfigurablePool.Mode.PullLess, skimmed);
    _managerFund(amount);

    assertEq(pool.recordedAllowance(), amount);
    assertEq(token.allowance(address(adapter), address(pool)), 0, "allowance reset");
    // The adapter itself does not check balances; the Manager rejects this (see the integration tests).
    assertEq(token.balanceOf(address(adapter)), skimmed);
  }

  function test_fund_resetsAllowanceWhenPoolPullsNothing() public {
    uint256 amount = 5_000_000e18;
    pool.setMode(ConfigurablePool.Mode.PullNone, 0);
    _managerFund(amount);
    assertEq(token.allowance(address(adapter), address(pool)), 0, "allowance reset");
    assertEq(token.balanceOf(address(adapter)), amount);
  }

  function testFuzz_fund_leavesPreExistingDustUntouched(uint256 dust, uint256 amount) public {
    dust = bound(dust, 1, 1_000_000_000e18);
    amount = bound(amount, 1, MANAGER_BALANCE);
    vm.prank(treasury);
    token.transfer(address(adapter), dust);

    _managerFund(amount);

    assertEq(pool.recordedAllowance(), amount, "approval is amount, not balance");
    assertEq(pool.recordedRebalancerBalance(), dust + amount);
    assertEq(token.balanceOf(address(adapter)), dust, "dust untouched");
    assertEq(token.balanceOf(address(pool)), POOL_BALANCE + amount);
    assertEq(token.allowance(address(adapter), address(pool)), 0);
  }

  function testFuzz_fund_revertsWhenAdapterLacksTokens(uint256 held, uint256 amount) public {
    held = bound(held, 0, MANAGER_BALANCE - 1);
    amount = bound(amount, held + 1, MANAGER_BALANCE);
    vm.prank(manager);
    token.transfer(address(adapter), held);

    vm.expectRevert(
      abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(adapter), held, amount)
    );
    vm.prank(manager);
    adapter.fund(amount);
  }

  function test_fund_revertsWhenAdapterIsNotRebalancer() public {
    pool.setRebalancer(stranger);
    vm.prank(manager);
    token.transfer(address(adapter), 1e18);

    vm.expectRevert(abi.encodeWithSelector(MockLockReleaseTokenPool.Unauthorized.selector, address(adapter)));
    vm.prank(manager);
    adapter.fund(1e18);
  }

  function test_fund_rejectsReentryFromPool() public {
    pool.setMode(ConfigurablePool.Mode.ReenterFund, 0);
    vm.prank(manager);
    token.transfer(address(adapter), 1e18);

    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, address(pool)));
    vm.prank(manager);
    adapter.fund(1e18);
  }

  function test_fund_revertsWhileTokenIsPaused() public {
    vm.prank(manager);
    token.transfer(address(adapter), 1e18);
    token.pause();

    vm.expectRevert(Pausable.EnforcedPause.selector);
    vm.prank(manager);
    adapter.fund(1e18);
  }

  function test_fund_zeroAmountIsANoOp() public {
    // The Manager rejects zero amounts itself; the adapter tolerates them without side effects.
    vm.prank(manager);
    adapter.fund(0);
    assertEq(pool.recordedAllowance(), 0);
    assertEq(token.allowance(address(adapter), address(pool)), 0);
    assertEq(token.balanceOf(address(pool)), POOL_BALANCE);
  }

  // ================================================================
  // │                            recall                            │
  // ================================================================

  function testFuzz_recall_forwardsExactAmountToManager(uint256 amount, uint256 dust) public {
    amount = bound(amount, 1, POOL_BALANCE);
    dust = bound(dust, 0, 1_000_000_000e18);
    if (dust != 0) {
      vm.prank(treasury);
      token.transfer(address(adapter), dust);
    }

    vm.prank(manager);
    adapter.recall(amount);

    assertEq(pool.withdrawCalls(), 1);
    assertEq(token.balanceOf(manager), MANAGER_BALANCE + amount, "manager credited exactly amount");
    assertEq(token.balanceOf(address(pool)), POOL_BALANCE - amount, "pool debited exactly amount");
    assertEq(token.balanceOf(address(adapter)), dust, "dust untouched");
    assertEq(token.allowance(address(adapter), address(pool)), 0);
  }

  function test_recall_emitsTransfersInOrder() public {
    uint256 amount = 3_000_000e18;
    vm.expectEmit(true, true, false, true, address(token));
    emit IERC20.Transfer(address(pool), address(adapter), amount);
    vm.expectEmit(true, true, false, true, address(pool));
    emit LiquidityRemoved(address(adapter), amount);
    vm.expectEmit(true, true, false, true, address(token));
    emit IERC20.Transfer(address(adapter), manager, amount);

    vm.prank(manager);
    adapter.recall(amount);
  }

  function testFuzz_recall_revertsWhenPoolHasInsufficientLiquidity(uint256 amount) public {
    amount = bound(amount, POOL_BALANCE + 1, type(uint256).max);
    vm.expectRevert(MockLockReleaseTokenPool.InsufficientLiquidity.selector);
    vm.prank(manager);
    adapter.recall(amount);
  }

  function test_recall_revertsWhenAdapterIsNotRebalancer() public {
    pool.setRebalancer(stranger);
    vm.expectRevert(abi.encodeWithSelector(MockLockReleaseTokenPool.Unauthorized.selector, address(adapter)));
    vm.prank(manager);
    adapter.recall(1e18);
  }

  function test_recall_rejectsReentryFromPool() public {
    pool.setMode(ConfigurablePool.Mode.ReenterRecall, 0);
    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, address(pool)));
    vm.prank(manager);
    adapter.recall(1e18);
  }

  function test_recall_revertsWhenPoolPaysLessAndAdapterHasNoDust() public {
    uint256 amount = 1_000e18;
    pool.setMode(ConfigurablePool.Mode.PayLess, 1);
    vm.expectRevert(
      abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(adapter), amount - 1, amount)
    );
    vm.prank(manager);
    adapter.recall(amount);
  }

  function test_recall_revertsWhenPoolPaysNothingAndAdapterHasNoDust() public {
    uint256 amount = 1_000e18;
    pool.setMode(ConfigurablePool.Mode.PayNone, 0);
    vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(adapter), 0, amount));
    vm.prank(manager);
    adapter.recall(amount);
  }

  function test_recall_poolPayingLessIsCoveredFromDust_documentsManagerReliance() public {
    // The adapter forwards `amount` regardless of what it received. With dust present a short-paying pool is masked at
    // the adapter level; only the Manager's adapter-balance check catches it (see the integration tests).
    uint256 amount = 1_000e18;
    uint256 dust = 10e18;
    vm.prank(treasury);
    token.transfer(address(adapter), dust);
    pool.setMode(ConfigurablePool.Mode.PayLess, 4e18);

    vm.prank(manager);
    adapter.recall(amount);
    assertEq(token.balanceOf(manager), MANAGER_BALANCE + amount);
    assertEq(token.balanceOf(address(adapter)), dust - 4e18);
  }

  function test_recall_poolPayingMoreLeavesSurplusInAdapter() public {
    uint256 amount = 1_000e18;
    pool.setMode(ConfigurablePool.Mode.PayMore, 2e18);
    vm.prank(manager);
    adapter.recall(amount);
    assertEq(token.balanceOf(manager), MANAGER_BALANCE + amount, "manager receives exactly amount");
    assertEq(token.balanceOf(address(adapter)), 2e18, "surplus stays in the adapter");
  }

  function test_recall_revertsWhileTokenIsPaused() public {
    token.pause();
    vm.expectRevert(Pausable.EnforcedPause.selector);
    vm.prank(manager);
    adapter.recall(1e18);
  }

  function test_recall_neverTouchesAllowance() public {
    vm.prank(manager);
    adapter.recall(1e18);
    assertEq(token.allowance(address(adapter), address(pool)), 0);
    assertEq(token.allowance(address(adapter), manager), 0);
  }

  // ================================================================
  // │                       External surface                       │
  // ================================================================

  function testFuzz_unknownSelectorReverts(bytes4 selector, bytes memory args, bool asManager) public {
    vm.assume(!_isKnownSelector(selector));
    vm.prank(treasury);
    token.transfer(address(adapter), 1e18);
    address caller = asManager ? manager : stranger;

    vm.prank(caller);
    (bool ok,) = address(adapter).call(abi.encodePacked(selector, args));
    assertFalse(ok, "unknown selector must revert");
    assertEq(token.balanceOf(address(adapter)), 1e18);
    assertEq(token.allowance(address(adapter), address(pool)), 0);
  }

  function test_emptyCalldataReverts() public {
    vm.prank(manager);
    (bool ok,) = address(adapter).call("");
    assertFalse(ok);
  }

  function testFuzz_rejectsEther(uint256 value, bool asManager) public {
    value = bound(value, 1, 1_000 ether);
    address caller = asManager ? manager : stranger;
    vm.deal(caller, value * 4);

    vm.startPrank(caller);
    (bool ok,) = address(adapter).call{value: value}("");
    assertFalse(ok, "receive");
    (ok,) = address(adapter).call{value: value}(hex"deadbeef");
    assertFalse(ok, "fallback");
    (ok,) = address(adapter).call{value: value}(abi.encodeCall(ILiquidityAdapter.fund, (0)));
    assertFalse(ok, "payable fund");
    (ok,) = address(adapter).call{value: value}(abi.encodeCall(ILiquidityAdapter.recall, (0)));
    assertFalse(ok, "payable recall");
    vm.stopPrank();
    assertEq(address(adapter).balance, 0);
  }

  /// @notice Scans the deployed runtime code for every PUSH3/PUSH4 operand (the dispatcher compares the calldata
  /// selector against such constants). Any operand that is not one of the five interface selectors must not dispatch
  /// to a callable function, even for the Manager and with plausible arguments.
  function test_runtimeCodeExposesOnlyInterfaceSelectors() public {
    bytes memory code = address(adapter).code;
    (bytes4[] memory operands, uint256 count) = _pushOperands(code);

    bool[5] memory seen;
    bytes4[5] memory known = _knownSelectors();
    bytes memory args = abi.encode(manager, uint256(1), uint256(1), uint256(1));
    vm.prank(treasury);
    token.transfer(address(adapter), 10e18);

    for (uint256 i = 0; i < count; ++i) {
      bytes4 candidate = operands[i];
      bool isKnown;
      for (uint256 k = 0; k < 5; ++k) {
        if (candidate == known[k]) {
          seen[k] = true;
          isKnown = true;
        }
      }
      if (isKnown) continue;
      vm.prank(manager);
      (bool ok,) = address(adapter).call(abi.encodePacked(candidate, args));
      assertFalse(ok, "non-interface constant dispatched to a function");
    }
    for (uint256 k = 0; k < 5; ++k) {
      assertTrue(seen[k], "scan must find every interface selector");
    }
    assertEq(token.balanceOf(address(adapter)), 10e18);
  }

  function test_keepsNoMutableStorage() public {
    vm.prank(treasury);
    token.transfer(address(adapter), 1e18);
    _managerFund(2e18);
    vm.prank(manager);
    adapter.recall(1e18);
    for (uint256 slot = 0; slot < 32; ++slot) {
      assertEq(vm.load(address(adapter), bytes32(slot)), bytes32(0), "adapter must not write storage");
    }
  }

  // ================================================================
  // │                           Helpers                            │
  // ================================================================

  function _managerFund(uint256 amount) internal {
    vm.startPrank(manager);
    token.transfer(address(adapter), amount);
    adapter.fund(amount);
    vm.stopPrank();
  }

  function _stickySetup()
    internal
    returns (StickyAllowanceToken sticky, ConfigurablePool stickyPool, CCIPPoolAdapter stickyAdapter)
  {
    sticky = new StickyAllowanceToken(manager, 1_000_000e18);
    stickyPool = new ConfigurablePool(address(sticky), router);
    stickyAdapter = new CCIPPoolAdapter(manager, address(sticky), address(stickyPool));
    stickyPool.setRebalancer(address(stickyAdapter));
  }

  function _knownSelectors() internal pure returns (bytes4[5] memory) {
    return [
      ILiquidityAdapter.MANAGER.selector,
      ILiquidityAdapter.TOKEN.selector,
      ILiquidityAdapter.POOL.selector,
      ILiquidityAdapter.fund.selector,
      ILiquidityAdapter.recall.selector
    ];
  }

  function _isKnownSelector(bytes4 selector) internal pure returns (bool) {
    bytes4[5] memory known = _knownSelectors();
    for (uint256 k = 0; k < 5; ++k) {
      if (selector == known[k]) return true;
    }
    return false;
  }

  function _pushOperands(bytes memory code) internal pure returns (bytes4[] memory operands, uint256 count) {
    operands = new bytes4[](code.length);
    uint256 i = 0;
    while (i < code.length) {
      uint8 op = uint8(code[i]);
      if (op >= 0x60 && op <= 0x7f) {
        uint256 size = uint256(op) - 0x5f;
        if (op == 0x62 || op == 0x63) {
          uint32 value;
          for (uint256 k = 0; k < size && i + 1 + k < code.length; ++k) {
            value = (value << 8) | uint32(uint8(code[i + 1 + k]));
          }
          operands[count++] = bytes4(value);
        }
        i += 1 + size;
      } else {
        i += 1;
      }
    }
  }
}

/// @notice The adapter wired into the real Manager with a pool whose liquidity code misbehaves. Every deviation from
/// "exactly `amount` moves between Manager and pool, adapter balance unchanged" must revert the whole operation.
contract CCIPPoolAdapterManagerIntegrationTest is BaseTest {
  ConfigurablePool internal evilPool;
  CCIPPoolAdapter internal evilAdapter;
  uint256 internal evilId;

  uint256 internal constant EVIL_POOL_INVENTORY = 50_000_000e18;
  uint256 internal constant AMOUNT = 1_000_000e18;

  function setUp() public virtual override {
    super.setUp();
    evilPool = new ConfigurablePool(address(token), router);
    evilPool.addChain(
      REMOTE_CHAIN_SELECTOR,
      abi.encode(REMOTE_TOKEN),
      abi.encode(REMOTE_POOL),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE),
      _ccipBucket(CCIP_CAPACITY, CCIP_RATE)
    );
    evilAdapter = new CCIPPoolAdapter(address(manager), address(token), address(evilPool));
    evilPool.setRebalancer(address(evilAdapter));
    evilPool.setRateLimitAdmin(address(controller));
    evilPool.transferOwnership(address(timelock));

    // The registry keeps mapping the token to the fixture pool, so the evil pool is funded under a migration approval
    // bound to it. Thresholds are required before registration; a zero minimum keeps every recall within inventory.
    vm.startPrank(address(timelock));
    manager.setPoolSpec(address(evilPool), _poolSpec());
    manager.setPoolMigrationApproval(address(evilPool), address(pool));
    manager.setPoolThresholds(address(evilPool), 0, 0, 0);
    manager.setPoolFundingBudget(address(evilPool), POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    evilId = manager.registerAdapter(address(evilAdapter), address(evilPool));
    vm.stopPrank();

    vm.prank(treasury);
    token.transfer(address(evilPool), EVIL_POOL_INVENTORY);
  }

  function test_fixtureAdapterBindings() public view {
    assertEq(adapter.MANAGER(), address(manager));
    assertEq(adapter.TOKEN(), address(token));
    assertEq(adapter.POOL(), address(pool));
    assertEq(pool.getRebalancer(), address(adapter));
  }

  function testFuzz_fund_honestPoolKeepsDustAndEmits(uint256 amount, uint256 dust) public {
    amount = bound(amount, 1, MAX_FUNDING_PER_CALL);
    dust = bound(dust, 0, 1_000_000e18);
    _dust(address(evilAdapter), dust);
    uint256 managerBefore = _balance(address(manager));

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Funded(evilId, address(evilPool), fundingOperator, address(evilAdapter), amount);
    vm.prank(fundingOperator);
    manager.fund(evilId, amount);

    assertEq(evilPool.recordedAllowance(), amount);
    assertEq(_balance(address(evilAdapter)), dust);
    assertEq(_balance(address(manager)), managerBefore - amount);
    assertEq(_balance(address(evilPool)), EVIL_POOL_INVENTORY + amount);
    assertEq(token.allowance(address(evilAdapter), address(evilPool)), 0);
  }

  function test_fund_revertsWhenPoolPullsLess() public {
    evilPool.setMode(ConfigurablePool.Mode.PullLess, 1);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    vm.prank(fundingOperator);
    manager.fund(evilId, AMOUNT);
  }

  function test_fund_revertsWhenPoolPullsNothing() public {
    evilPool.setMode(ConfigurablePool.Mode.PullNone, 0);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    vm.prank(fundingOperator);
    manager.fund(evilId, AMOUNT);
  }

  function test_fund_revertsWhenPoolReenters() public {
    evilPool.setMode(ConfigurablePool.Mode.ReenterFund, 0);
    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, address(evilPool)));
    vm.prank(fundingOperator);
    manager.fund(evilId, AMOUNT);
  }

  function test_fund_managerRejectsPreExistingAllowanceBeforeCallingAdapter() public {
    vm.prank(address(evilAdapter));
    token.approve(address(evilPool), 5);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.NonZeroAllowance.selector, 5));
    vm.prank(fundingOperator);
    manager.fund(evilId, AMOUNT);
    assertEq(evilPool.provideCalls(), 0);
  }

  function testFuzz_recall_honestPoolKeepsDustAndEmits(uint256 amount, uint256 dust) public {
    amount = bound(amount, 1, MAX_RECALL_PER_CALL);
    dust = bound(dust, 0, 1_000_000e18);
    _dust(address(evilAdapter), dust);
    uint256 managerBefore = _balance(address(manager));

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Recalled(evilId, address(evilPool), recallOperator, address(evilAdapter), amount);
    vm.prank(recallOperator);
    manager.recall(evilId, amount);

    assertEq(_balance(address(evilAdapter)), dust);
    assertEq(_balance(address(manager)), managerBefore + amount);
    assertEq(_balance(address(evilPool)), EVIL_POOL_INVENTORY - amount);
  }

  function test_recall_revertsWhenPoolPaysLessAndDustCoversIt() public {
    _dust(address(evilAdapter), 10e18);
    evilPool.setMode(ConfigurablePool.Mode.PayLess, 1e18);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    vm.prank(recallOperator);
    manager.recall(evilId, AMOUNT);
  }

  function test_recall_revertsWhenPoolPaysLessWithoutDust() public {
    evilPool.setMode(ConfigurablePool.Mode.PayLess, 1);
    vm.expectRevert(
      abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(evilAdapter), AMOUNT - 1, AMOUNT)
    );
    vm.prank(recallOperator);
    manager.recall(evilId, AMOUNT);
  }

  function test_recall_revertsWhenPoolPaysMore() public {
    evilPool.setMode(ConfigurablePool.Mode.PayMore, 1);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    vm.prank(recallOperator);
    manager.recall(evilId, AMOUNT);
  }

  function test_recall_revertsWhenPoolPaysElsewhereAndDustCoversIt() public {
    _dust(address(evilAdapter), AMOUNT);
    evilPool.setPayee(attacker);
    evilPool.setMode(ConfigurablePool.Mode.PayElsewhere, 0);
    vm.expectRevert(ILiquidityManager.BalanceCheckFailed.selector);
    vm.prank(recallOperator);
    manager.recall(evilId, AMOUNT);
  }

  function test_recall_revertsWhenPoolReenters() public {
    evilPool.setMode(ConfigurablePool.Mode.ReenterRecall, 0);
    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.CallerNotManager.selector, address(evilPool)));
    vm.prank(recallOperator);
    manager.recall(evilId, AMOUNT);
  }

  // ================================================================
  // │                       Regression tests                       │
  // ================================================================

  function test_regression_fixtureEvilPoolIsApprovedUnderTheRegistryPool() public view {
    assertEq(manager.getPoolMigrationSource(address(evilPool)), address(pool));
    (ILiquidityManager.PoolThresholds memory thresholds, bool isSet) = manager.getPoolThresholds(address(evilPool));
    assertTrue(isSet);
    assertEq(thresholds.minimum, 0);
    manager.verifyAdapter(evilId);
  }

  /// @notice The evil pool's approval is bound to the fixture pool: once the registry moves to a third pool it lapses,
  /// and it applies again when the registry returns to the fixture pool. Recall never depends on the registry.
  function test_regression_migrationApprovalLapsesWhenRegistryMovesToThirdPool() public {
    address thirdPool = makeAddr("thirdPool");
    registry.setPool(address(token), thirdPool);

    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, address(evilPool), thirdPool)
    );
    vm.prank(fundingOperator);
    manager.fund(evilId, AMOUNT);

    vm.prank(recallOperator);
    manager.recall(evilId, AMOUNT);
    assertEq(_balance(address(evilPool)), EVIL_POOL_INVENTORY - AMOUNT);

    registry.setPool(address(token), address(pool));
    vm.prank(fundingOperator);
    manager.fund(evilId, AMOUNT);
    assertEq(_balance(address(evilPool)), EVIL_POOL_INVENTORY);
  }

  /// @notice Neither the evil adapter nor the evil pool can receive reserves through `migrateReserves`, and both stay
  /// rejected after the adapter is replaced.
  function test_regression_migrateReservesRejectsEvilAdapterAndPool() public {
    CCIPPoolAdapter replacement = new CCIPPoolAdapter(address(manager), address(token), address(evilPool));
    vm.prank(address(timelock));
    evilPool.setRebalancer(address(replacement));
    vm.prank(address(timelock));
    manager.replaceAdapter(evilId, address(replacement));

    address[3] memory destinations = [address(evilAdapter), address(replacement), address(evilPool)];
    for (uint256 i = 0; i < destinations.length; ++i) {
      vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidMigrationDestination.selector, destinations[i]));
      vm.prank(address(timelock));
      manager.migrateReserves(destinations[i], type(uint256).max);
    }
    assertTrue(manager.isRegisteredAdapter(address(evilAdapter)));
    address[] memory history = manager.getAdapterHistory();
    assertEq(history.length, 3);
    assertEq(history[0], address(adapter));
    assertEq(history[1], address(evilAdapter));
    assertEq(history[2], address(replacement));
  }

  function _dust(address to, uint256 amount) internal {
    if (amount == 0) return;
    vm.prank(treasury);
    token.transfer(to, amount);
  }
}
