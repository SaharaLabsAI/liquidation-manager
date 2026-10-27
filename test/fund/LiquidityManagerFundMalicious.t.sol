// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Vm} from "forge-std/Vm.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";

import {FundBase} from "test/fund/FundBase.sol";
import {ConfigurableAdapter} from "test/fund/mocks/ConfigurableAdapter.sol";
import {MaliciousPool} from "test/fund/mocks/MaliciousPool.sol";

/// @notice `fund` against misbehaving pools and adapters that pass every pre-funding check. Each deviation from
/// "Manager -amount, pool +amount, adapter unchanged, zero allowance" must revert and leave nothing changed.
contract LiquidityManagerFundMaliciousTest is FundBase {
  uint256 internal constant AMOUNT = 10_000_000e18;
  uint256 internal constant DELTA = 1_000e18;

  address internal sink = makeAddr("sink");

  MaliciousPool internal badPool;
  CCIPPoolAdapter internal badPoolAdapter;
  uint256 internal badPoolId;

  MockLockReleaseTokenPool internal honestPool;
  ConfigurableAdapter internal badAdapter;
  uint256 internal badAdapterId;

  function setUp() public override {
    super.setUp();

    // A malicious pool served by the real CCIPPoolAdapter.
    badPool = new MaliciousPool(address(token), router);
    badPoolAdapter = new CCIPPoolAdapter(address(manager), address(token), address(badPool));
    badPoolId = _wireAndRegister(badPool, address(badPoolAdapter), true);

    // An honest pool whose rebalancer is a misbehaving adapter.
    honestPool = new MockLockReleaseTokenPool(address(token), router);
    badAdapter = new ConfigurableAdapter(address(manager), address(token), address(honestPool));
    badAdapterId = _wireAndRegister(honestPool, address(badAdapter), true);

    vm.label(address(badPool), "MaliciousPool");
    vm.label(address(badPoolAdapter), "MaliciousPoolAdapter");
    vm.label(address(honestPool), "HonestPool");
    vm.label(address(badAdapter), "ConfigurableAdapter");
  }

  function _expectBadPoolRevert(uint256 amount, bytes memory err) internal {
    Snapshot memory before = _snapshot(address(badPoolAdapter), address(badPool));
    uint256 sinkBefore = _balance(sink);
    _expectFundRevert(fundingOperator, badPoolId, amount, err);
    _assertUnchanged(before, address(badPoolAdapter), address(badPool));
    assertEq(_balance(sink), sinkBefore, "sink balance changed");
  }

  function _expectBadAdapterRevert(uint256 amount, bytes memory err) internal {
    Snapshot memory before = _snapshot(address(badAdapter), address(honestPool));
    uint256 sinkBefore = _balance(sink);
    _expectFundRevert(fundingOperator, badAdapterId, amount, err);
    _assertUnchanged(before, address(badAdapter), address(honestPool));
    assertEq(_balance(sink), sinkBefore, "sink balance changed");
  }

  function _balanceCheckFailed() internal pure returns (bytes memory) {
    return abi.encodeWithSelector(ILiquidityManager.BalanceCheckFailed.selector);
  }

  // ================================================================
  // │                          Baselines                           │
  // ================================================================

  function test_fund_maliciousPoolInHonestModeFunds() public {
    uint256 poolBefore = _balance(address(badPool));
    _fundAs(fundingOperator, badPoolId, AMOUNT);
    assertEq(_balance(address(badPool)), poolBefore + AMOUNT);
    assertEq(_balance(address(badPoolAdapter)), 0);
  }

  function test_fund_configurableAdapterInHonestModeFunds() public {
    uint256 poolBefore = _balance(address(honestPool));
    _fundAs(fundingOperator, badAdapterId, AMOUNT);
    assertEq(_balance(address(honestPool)), poolBefore + AMOUNT);
    assertEq(_balance(address(badAdapter)), 0);
    assertEq(token.allowance(address(badAdapter), address(honestPool)), 0);
  }

  // ================================================================
  // │                        Malicious pools                       │
  // ================================================================

  function test_fund_revertsWhen_poolPullsLess() public {
    badPool.setMode(MaliciousPool.Mode.PullLess, 1, address(0));
    _expectBadPoolRevert(AMOUNT, _balanceCheckFailed());
  }

  /// @dev The adapter approves exactly `amount`, so a pool pulling more fails in the token itself.
  function test_fund_revertsWhen_poolPullsMore() public {
    badPool.setMode(MaliciousPool.Mode.PullMore, 1, address(0));
    _expectBadPoolRevert(
      AMOUNT,
      abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(badPool), AMOUNT, AMOUNT + 1)
    );
  }

  /// @dev Unsolicited adapter balance cannot be pulled by the pool either: the allowance is exactly `amount`.
  function test_fund_revertsWhen_poolPullsMoreThanAmountFromAdapterDust() public {
    _seed(address(badPoolAdapter), DELTA);
    badPool.setMode(MaliciousPool.Mode.PullMore, DELTA, address(0));
    _expectBadPoolRevert(
      AMOUNT,
      abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(badPool), AMOUNT, AMOUNT + DELTA)
    );
    assertEq(_balance(address(badPoolAdapter)), DELTA);
  }

  function test_fund_revertsWhen_poolPullsNothing() public {
    badPool.setMode(MaliciousPool.Mode.PullNothing, 0, address(0));
    _expectBadPoolRevert(AMOUNT, _balanceCheckFailed());
  }

  function test_fund_revertsWhen_poolPullsAndDivertsPart() public {
    badPool.setMode(MaliciousPool.Mode.PullAndDivert, DELTA, sink);
    _expectBadPoolRevert(AMOUNT, _balanceCheckFailed());
  }

  function test_fund_revertsWhen_poolPullsAndDivertsOneWei() public {
    badPool.setMode(MaliciousPool.Mode.PullAndDivert, 1, sink);
    _expectBadPoolRevert(AMOUNT, _balanceCheckFailed());
  }

  function test_fund_revertsWhen_poolPullsStraightToAnotherAddress() public {
    badPool.setMode(MaliciousPool.Mode.PullToSink, 0, sink);
    _expectBadPoolRevert(AMOUNT, _balanceCheckFailed());
  }

  /// @dev Sending part back to the adapter leaves the adapter balance changed.
  function test_fund_revertsWhen_poolRefundsPartToAdapter() public {
    badPool.setMode(MaliciousPool.Mode.PullAndDivert, DELTA, address(badPoolAdapter));
    _expectBadPoolRevert(AMOUNT, _balanceCheckFailed());
  }

  /// @dev Sending part back to the Manager leaves the Manager delta short of `amount`.
  function test_fund_revertsWhen_poolRefundsPartToManager() public {
    badPool.setMode(MaliciousPool.Mode.PullAndDivert, DELTA, address(manager));
    _expectBadPoolRevert(AMOUNT, _balanceCheckFailed());
  }

  /// @dev The pool ending with more than `amount` (extra inflow during the call) also fails the exact check.
  function test_fund_revertsWhen_poolBalanceRisesByMoreThanAmount() public {
    _seed(sink, DELTA);
    vm.prank(sink);
    token.approve(address(badPool), DELTA);
    badPool.setMode(MaliciousPool.Mode.PullPlusSidecar, DELTA, sink);
    _expectBadPoolRevert(AMOUNT, _balanceCheckFailed());
  }

  function test_fund_revertsWhen_poolReentersFund() public {
    vm.prank(address(timelock));
    manager.setFundingOperator(address(badPool), true);
    badPool.setReentry(manager, badPoolId);
    badPool.setMode(MaliciousPool.Mode.ReenterFund, 0, address(0));
    _expectBadPoolRevert(AMOUNT, abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
  }

  function test_fund_revertsWhen_poolReentersRecall() public {
    vm.prank(address(timelock));
    manager.setRecallOperator(address(badPool), true);
    badPool.setReentry(manager, adapterId);
    badPool.setMode(MaliciousPool.Mode.ReenterRecall, 0, address(0));
    _expectBadPoolRevert(AMOUNT, abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
  }

  function testFuzz_fund_revertsWhen_poolPullsLess(uint256 amount, uint256 shortfall) public {
    amount = bound(amount, 1, MAX_FUNDING_PER_CALL);
    shortfall = bound(shortfall, 1, amount);
    badPool.setMode(MaliciousPool.Mode.PullLess, shortfall, address(0));
    _expectBadPoolRevert(amount, _balanceCheckFailed());
  }

  function testFuzz_fund_revertsWhen_poolDiverts(uint256 amount, uint256 diverted, uint256 inventory) public {
    amount = bound(amount, 1, MAX_FUNDING_PER_CALL);
    inventory = bound(inventory, 0, 100_000_000e18);
    diverted = bound(diverted, 1, amount + inventory);
    _seed(address(badPool), inventory);
    badPool.setMode(MaliciousPool.Mode.PullAndDivert, diverted, sink);
    _expectBadPoolRevert(amount, _balanceCheckFailed());
  }

  // ================================================================
  // │                      Malicious adapters                      │
  // ================================================================

  function test_fund_revertsWhen_adapterKeepsPart() public {
    badAdapter.setMode(ConfigurableAdapter.Mode.KeepPart, DELTA, address(0));
    _expectBadAdapterRevert(AMOUNT, _balanceCheckFailed());
  }

  function test_fund_revertsWhen_adapterKeepsEverything() public {
    badAdapter.setMode(ConfigurableAdapter.Mode.NoOp, 0, address(0));
    _expectBadAdapterRevert(AMOUNT, _balanceCheckFailed());
  }

  /// @dev Balances are exact, but the adapter leaves `DELTA` of allowance to the pool.
  function test_fund_revertsWhen_adapterLeavesAllowance() public {
    badAdapter.setMode(ConfigurableAdapter.Mode.LeaveAllowance, DELTA, address(0));
    _expectBadAdapterRevert(AMOUNT, abi.encodeWithSelector(ILiquidityManager.NonZeroAllowance.selector, DELTA));
  }

  function test_fund_revertsWhen_adapterLeavesOneWeiAllowance() public {
    badAdapter.setMode(ConfigurableAdapter.Mode.LeaveAllowance, 1, address(0));
    _expectBadAdapterRevert(AMOUNT, abi.encodeWithSelector(ILiquidityManager.NonZeroAllowance.selector, 1));
  }

  /// @dev The adapter's own balance ends unchanged, but the pool receives less than `amount`.
  function test_fund_revertsWhen_adapterDivertsPartElsewhere() public {
    badAdapter.setMode(ConfigurableAdapter.Mode.Divert, DELTA, sink);
    _expectBadAdapterRevert(AMOUNT, _balanceCheckFailed());
  }

  /// @dev An adapter spending its unsolicited balance on top of `amount` changes its own and the pool's balance.
  function test_fund_revertsWhen_adapterSpendsUnsolicitedBalance() public {
    _seed(address(badAdapter), DELTA);
    badAdapter.setMode(ConfigurableAdapter.Mode.OverPull, DELTA, address(0));
    _expectBadAdapterRevert(AMOUNT, _balanceCheckFailed());
    assertEq(_balance(address(badAdapter)), DELTA);
  }

  /// @dev The Manager checks the adapter-to-pool allowance before calling the adapter, so a stale allowance is
  /// rejected even for an adapter that would overwrite it.
  function test_fund_revertsWhen_adapterAllowanceNonZeroAtEntry_managerSideCheck() public {
    vm.prank(address(badAdapter));
    token.approve(address(honestPool), 5);
    _expectBadAdapterRevert(AMOUNT, abi.encodeWithSelector(ILiquidityManager.NonZeroAllowance.selector, 5));
  }

  /// @dev Unsolicited adapter balance is not touched by an honest flow through the configurable adapter either.
  function test_fund_configurableAdapterPreservesUnsolicitedBalance() public {
    _seed(address(badAdapter), DELTA);
    _fundAs(fundingOperator, badAdapterId, AMOUNT);
    assertEq(_balance(address(badAdapter)), DELTA);
  }

  /// @dev Documents the limit of the Manager's guarantee: it is balance-based. An adapter that bypasses
  /// `provideLiquidity` with a direct transfer satisfies every Manager check (principal still lands in the registered
  /// pool) but the pool emits no `LiquidityAdded`. Adapter code is fixed and timelock-approved, so this is a
  /// monitoring concern, not a principal-safety one.
  function test_fund_directTransferAdapterPassesBalanceChecksWithoutLiquidityAdded() public {
    badAdapter.setMode(ConfigurableAdapter.Mode.DirectTransfer, 0, address(0));
    uint256 poolBefore = _balance(address(honestPool));

    vm.recordLogs();
    _fundAs(fundingOperator, badAdapterId, AMOUNT);
    Vm.Log[] memory logs = vm.getRecordedLogs();

    assertEq(_balance(address(honestPool)), poolBefore + AMOUNT);
    for (uint256 i = 0; i < logs.length; ++i) {
      if (logs[i].emitter == address(honestPool)) {
        assertTrue(logs[i].topics[0] != MockLockReleaseTokenPool.LiquidityAdded.selector, "unexpected LiquidityAdded");
      }
    }
  }

  function testFuzz_fund_revertsWhen_adapterLeavesAllowance(uint256 amount, uint256 leftover) public {
    amount = bound(amount, 1, MAX_FUNDING_PER_CALL);
    leftover = bound(leftover, 1, type(uint128).max);
    badAdapter.setMode(ConfigurableAdapter.Mode.LeaveAllowance, leftover, address(0));
    _expectBadAdapterRevert(amount, abi.encodeWithSelector(ILiquidityManager.NonZeroAllowance.selector, leftover));
  }

  function testFuzz_fund_revertsWhen_adapterKeepsPart(uint256 amount, uint256 kept) public {
    amount = bound(amount, 1, MAX_FUNDING_PER_CALL);
    kept = bound(kept, 1, amount);
    badAdapter.setMode(ConfigurableAdapter.Mode.KeepPart, kept, address(0));
    _expectBadAdapterRevert(amount, _balanceCheckFailed());
  }
}
