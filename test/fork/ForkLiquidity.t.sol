// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {SaharaTimelock} from "src/SaharaTimelock.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";
import {ITokenAdminRegistry} from "src/interfaces/ITokenAdminRegistry.sol";
import {TokenBucket} from "src/libraries/TokenBucket.sol";

import {Deploy} from "script/Deploy.s.sol";
import {HandoverPlan} from "script/Handover.s.sol";

import {
  DecoyRegistryPool,
  IRealLockReleaseTokenPool,
  IRealRouter,
  IRealSahara,
  IRealTokenAdminRegistry
} from "test/fork/RealCcip.sol";

/// @notice Mainnet fork tests of the liquidity contracts against the REAL deployed CCIP contracts (SAHARA token,
/// `LockReleaseTokenPool 1.6.3-dev`, TokenAdminRegistry 1.5.0, Router 1.2.0 and its ramps) on one chain.
/// A fresh stack (SaharaTimelock, LiquidityManager, GuardianController, CCIPPoolAdapter) is deployed on the fork and
/// the production handover is replayed by impersonating the legacy multisig, which today owns the pool and the token
/// and administers the token in the TokenAdminRegistry. `test_regression_fork_scriptedDeployAndHandoverEndToEnd`
/// replays the whole production path with script/Deploy.s.sol and script/Handover.s.sol.
/// @dev Gated: runs only with RUN_FORK_TESTS=true, otherwise every test is skipped so offline `forge test` passes.
/// Forks the latest block (public RPCs serve no archive state). The live pre-handover state is asserted in `setUp`,
/// so drift of the deployed configuration fails loudly instead of producing misleading per-test failures.
abstract contract ForkLiquidityBase is Test {
  // ---------------------------------------------------------------- deployed addresses (same on both chains)

  address internal constant SAHARA = 0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111;
  address internal constant POOL = 0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4;
  /// @dev Current project multisig: pool owner, TokenAdminRegistry administrator and token owner.
  address internal constant POOL_OWNER = 0x6601ee913f8b431F300120Dc0FFDee670Ba4e109;
  /// @dev Current pool rebalancer and rateLimitAdmin.
  address internal constant PREVIOUS_REBALANCER = 0xd3B8d71d8Dd31288c7E60B1aF082846601020F22;
  string internal constant POOL_VERSION = "LockReleaseTokenPool 1.6.3-dev";

  uint64 internal constant ETH_CHAIN_SELECTOR = 5009297550715157269;
  uint64 internal constant BSC_CHAIN_SELECTOR = 11344663589394136015;

  uint128 internal constant CCIP_CAPACITY = 300_000_000e18;
  uint128 internal constant CCIP_RATE = 3_500e18;
  uint256 internal constant TOTAL_SUPPLY = 10_000_000_000e18;

  // ---------------------------------------------------------------- governance and operating parameters

  uint256 internal constant TIMELOCK_DELAY = 72 hours;
  uint256 internal constant TIMELOCK_MINIMUM_DELAY = 24 hours;
  uint256 internal constant TIMELOCK_MAXIMUM_DELAY = 30 days;
  /// @dev script/Deploy.s.sol default for TIMELOCK_MINIMUM_DELAY.
  uint256 internal constant SCRIPT_MINIMUM_DELAY = 48 hours;

  uint256 internal constant POOL_MINIMUM = 10_000_000e18;
  uint256 internal constant POOL_REFILL_TRIGGER = 40_000_000e18;
  uint256 internal constant POOL_REFILL_TARGET = 80_000_000e18;
  uint256 internal constant MAX_FUNDING_PER_CALL = 25_000_000e18;
  uint256 internal constant AGGREGATE_FUNDING_CAPACITY = 100_000_000e18;
  uint256 internal constant AGGREGATE_FUNDING_RATE = AGGREGATE_FUNDING_CAPACITY / 1 days;
  uint256 internal constant POOL_FUNDING_CAPACITY = 50_000_000e18;
  uint256 internal constant POOL_FUNDING_RATE = POOL_FUNDING_CAPACITY / 1 days;
  uint256 internal constant MAX_RECALL_PER_CALL = 25_000_000e18;
  uint256 internal constant RECALL_CAPACITY = 50_000_000e18;
  uint256 internal constant RECALL_RATE = RECALL_CAPACITY / 1 days;

  uint256 internal constant MANAGER_RESERVES = 1_000_000_000e18;

  struct ChainConfig {
    string rpcUrl;
    uint256 chainId;
    address registry;
    address router;
    uint64 localChainSelector;
    uint64 remoteChainSelector;
  }

  address internal governanceSafe = makeAddr("governanceSafe");
  address internal guardian = makeAddr("guardian");
  address internal fundingOperator = makeAddr("fundingOperator");
  address internal recallOperator = makeAddr("recallOperator");
  address internal attacker = makeAddr("attacker");

  IRealSahara internal token = IRealSahara(SAHARA);
  ILockReleaseTokenPool internal pool = ILockReleaseTokenPool(POOL);
  IRealLockReleaseTokenPool internal realPool = IRealLockReleaseTokenPool(POOL);
  IRealTokenAdminRegistry internal registry;
  IRealRouter internal router;
  uint64 internal localChainSelector;
  uint64 internal remoteChainSelector;

  SaharaTimelock internal timelock;
  LiquidityManager internal manager;
  GuardianController internal controller;
  CCIPPoolAdapter internal adapter;
  uint256 internal adapterId;

  /// @dev Live chain state, before anything is deployed. Reverting to it also resets this contract's storage, so the
  /// stack variables must be reassigned afterwards.
  uint256 internal liveSnapshot;
  /// @dev State after deploying the stack, before any handover step.
  uint256 internal preHandoverSnapshot;

  function _chainConfig() internal view virtual returns (ChainConfig memory);

  function setUp() public virtual {
    if (!vm.envOr("RUN_FORK_TESTS", false)) {
      vm.skip(true);
      return;
    }

    ChainConfig memory config = _chainConfig();
    vm.createSelectFork(config.rpcUrl);
    require(block.chainid == config.chainId, "fork: unexpected chain id");
    registry = IRealTokenAdminRegistry(config.registry);
    router = IRealRouter(config.router);
    localChainSelector = config.localChainSelector;
    remoteChainSelector = config.remoteChainSelector;

    _requireLivePreHandoverState();
    liveSnapshot = vm.snapshotState();

    _deployStack();
    preHandoverSnapshot = vm.snapshotState();

    _handover();
    _configureManager();
    vm.prank(address(timelock));
    adapterId = manager.registerAdapter(address(adapter), POOL);

    deal(SAHARA, address(manager), MANAGER_RESERVES);

    vm.label(SAHARA, "SAHARA");
    vm.label(POOL, "LockReleaseTokenPool");
    vm.label(POOL_OWNER, "ProjectMultisig");
    vm.label(PREVIOUS_REBALANCER, "PreviousRebalancer");
    vm.label(address(registry), "TokenAdminRegistry");
    vm.label(address(router), "Router");
    vm.label(address(timelock), "Timelock");
    vm.label(address(manager), "LiquidityManager");
    vm.label(address(controller), "GuardianController");
    vm.label(address(adapter), "CCIPPoolAdapter");
  }

  // ================================================================
  // │                     Handover and wiring                      │
  // ================================================================

  function test_fork_handover_assignsPoolRoles() public view {
    assertEq(pool.owner(), address(timelock), "pool owner");
    assertEq(pool.getRebalancer(), address(adapter), "rebalancer");
    assertEq(pool.getRateLimitAdmin(), address(controller), "rateLimitAdmin");

    assertEq(adapter.MANAGER(), address(manager));
    assertEq(adapter.TOKEN(), SAHARA);
    assertEq(adapter.POOL(), POOL);
    assertEq(address(controller.MANAGER()), address(manager));
    assertEq(address(controller.TIMELOCK()), address(timelock));
    assertEq(manager.TOKEN(), SAHARA);
    assertEq(address(manager.TOKEN_ADMIN_REGISTRY()), address(registry));
    assertEq(manager.owner(), address(timelock));
    assertEq(manager.guardian(), guardian);

    assertEq(adapterId, 1);
    assertEq(manager.adapterIdByPool(POOL), adapterId);
    ILiquidityManager.Adapter memory entry = manager.getAdapter(adapterId);
    assertEq(entry.adapter, address(adapter));
    assertEq(entry.pool, POOL);
    assertTrue(entry.fundingEnabled);
    assertTrue(entry.recallEnabled);

    assertTrue(manager.isRegisteredAdapter(address(adapter)), "adapter registered");
    address[] memory history = manager.getAdapterHistory();
    assertEq(history.length, 1);
    assertEq(history[0], address(adapter));

    // Authorities outside the pool: the Timelock administers the token in the real registry and owns the token.
    _assertTokenConfig(address(timelock), address(0), POOL);
    assertEq(token.owner(), address(timelock), "token owner");
    manager.verifyHandover();

    assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), address(controller)), "controller cancels");
    assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), governanceSafe), "proposer keeps canceller");
    assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), guardian), "guardian has no direct cancel");
    assertEq(timelock.MINIMUM_DELAY(), TIMELOCK_MINIMUM_DELAY, "minimum delay");
    assertEq(timelock.MAXIMUM_DELAY(), TIMELOCK_MAXIMUM_DELAY, "maximum delay");
  }

  /// @dev The handover plan of script/Handover.s.sol on the fixture stack: the legacy multisig's calls, then one
  /// timelocked batch. The batch is a mixed batch, not the protected Guardian removal, so the Guardian can cancel it;
  /// once it executes, the multisig keeps no pool, registry or token authority.
  function test_fork_handover_endToEndThroughTimelockBatch() public {
    vm.revertToState(preHandoverSnapshot);
    HandoverPlan.Params memory p = _handoverParams();
    _executeLegacyMultisigCalls(p);

    (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = HandoverPlan.timelockBatch(p);
    bytes32 salt = keccak256("handover");
    vm.prank(governanceSafe);
    timelock.scheduleBatch(targets, values, payloads, bytes32(0), salt, TIMELOCK_DELAY);
    bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), salt);

    // A mixed batch is not the protected Guardian removal: the Guardian can cancel it.
    vm.prank(guardian);
    controller.cancelBatch(targets, values, payloads, bytes32(0), salt);
    assertFalse(timelock.isOperation(id));

    vm.prank(governanceSafe);
    timelock.scheduleBatch(targets, values, payloads, bytes32(0), salt, TIMELOCK_DELAY);
    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.prank(governanceSafe);
    timelock.executeBatch(targets, values, payloads, bytes32(0), salt);
    assertTrue(timelock.isOperationDone(id));

    assertEq(pool.owner(), address(timelock));
    assertEq(pool.getRebalancer(), address(adapter));
    _assertTokenConfig(address(timelock), address(0), POOL);
    assertEq(token.owner(), address(timelock));
    assertEq(manager.adapterIdByPool(POOL), 1);
    manager.verifyHandover();
    manager.verifyAdapter(1);

    deal(SAHARA, address(manager), MANAGER_RESERVES);
    uint256 poolBefore = _balance(POOL);
    vm.prank(fundingOperator);
    manager.fund(1, 1_000_000e18);
    assertEq(_balance(POOL), poolBefore + 1_000_000e18);

    // The multisig keeps no pool, registry or token authority.
    vm.startPrank(POOL_OWNER);
    vm.expectRevert(IRealLockReleaseTokenPool.OnlyCallableByOwner.selector);
    realPool.setRebalancer(POOL_OWNER);
    vm.expectRevert(IRealLockReleaseTokenPool.OnlyCallableByOwner.selector);
    realPool.transferOwnership(POOL_OWNER);
    vm.expectRevert(abi.encodeWithSelector(IRealTokenAdminRegistry.OnlyAdministrator.selector, POOL_OWNER, SAHARA));
    registry.setPool(SAHARA, address(0));
    vm.expectRevert(abi.encodeWithSelector(IRealTokenAdminRegistry.OnlyAdministrator.selector, POOL_OWNER, SAHARA));
    registry.transferAdminRole(SAHARA, POOL_OWNER);
    vm.expectRevert(abi.encodeWithSelector(IRealSahara.OwnableUnauthorizedAccount.selector, POOL_OWNER));
    token.pause();
    vm.expectRevert(abi.encodeWithSelector(IRealSahara.OwnableUnauthorizedAccount.selector, POOL_OWNER));
    token.transferOwnership(POOL_OWNER);
    vm.stopPrank();
  }

  function test_fork_handover_multisigCanRedirectPendingOwnershipBeforeAcceptance() public {
    vm.revertToState(preHandoverSnapshot);
    vm.prank(POOL_OWNER);
    realPool.transferOwnership(address(timelock));

    // Until the Timelock accepts, the multisig is still owner and can re-point the pending transfer, which makes the
    // queued acceptance fail.
    address other = makeAddr("otherPendingOwner");
    vm.prank(POOL_OWNER);
    realPool.transferOwnership(other);
    vm.expectRevert(IRealLockReleaseTokenPool.MustBeProposedOwner.selector);
    vm.prank(address(timelock));
    realPool.acceptOwnership();
    assertEq(pool.owner(), POOL_OWNER);
  }

  function test_fork_verifyAdapter_passesAgainstRealPool() public view {
    manager.verifyAdapter(adapterId);
  }

  function test_fork_preHandover_registrationFailsUntilEveryRoleIsHandedOver() public {
    vm.revertToState(preHandoverSnapshot);
    _configureManager();

    // Live configuration: the multisig administers the token in the registry and owns the token and the pool, and
    // 0xd3B8 is rebalancer and rateLimitAdmin. The authorities outside the pool are checked first.
    _expectRegisterReverts(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, POOL_OWNER));

    // TokenAdminRegistry 1.5.0: the administrator role moves in two steps; a proposal alone changes nothing.
    vm.expectEmit(true, true, true, true, address(registry));
    emit IRealTokenAdminRegistry.AdministratorTransferRequested(SAHARA, POOL_OWNER, address(timelock));
    vm.prank(POOL_OWNER);
    registry.transferAdminRole(SAHARA, address(timelock));
    _assertTokenConfig(POOL_OWNER, address(timelock), POOL);
    _expectRegisterReverts(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, POOL_OWNER));

    vm.expectRevert(abi.encodeWithSelector(IRealTokenAdminRegistry.OnlyPendingAdministrator.selector, attacker, SAHARA));
    vm.prank(attacker);
    registry.acceptAdminRole(SAHARA);

    vm.expectEmit(true, true, true, true, address(registry));
    emit IRealTokenAdminRegistry.AdministratorTransferred(SAHARA, address(timelock));
    vm.prank(address(timelock));
    registry.acceptAdminRole(SAHARA);
    _assertTokenConfig(address(timelock), address(0), POOL);
    _expectRegisterReverts(abi.encodeWithSelector(ILiquidityManager.TokenOwnerMismatch.selector, POOL_OWNER));

    // The token uses OZ single-step Ownable.
    vm.prank(POOL_OWNER);
    token.transferOwnership(address(timelock));
    assertEq(token.owner(), address(timelock));
    manager.verifyHandover();
    _expectRegisterReverts(
      abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, POOL, PREVIOUS_REBALANCER)
    );

    vm.prank(POOL_OWNER);
    realPool.setRebalancer(address(adapter));
    _expectRegisterReverts(abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, POOL, POOL_OWNER));

    // Chainlink Ownable2Step: the transfer is only pending until the Timelock accepts it.
    vm.expectEmit(true, true, false, false, POOL);
    emit IRealLockReleaseTokenPool.OwnershipTransferRequested(POOL_OWNER, address(timelock));
    vm.prank(POOL_OWNER);
    realPool.transferOwnership(address(timelock));
    assertEq(pool.owner(), POOL_OWNER, "pending transfer does not change the owner");
    _expectRegisterReverts(abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, POOL, POOL_OWNER));

    vm.expectRevert(IRealLockReleaseTokenPool.MustBeProposedOwner.selector);
    vm.prank(attacker);
    realPool.acceptOwnership();

    vm.expectEmit(true, true, false, false, POOL);
    emit IRealLockReleaseTokenPool.OwnershipTransferred(POOL_OWNER, address(timelock));
    vm.prank(address(timelock));
    realPool.acceptOwnership();
    assertEq(pool.owner(), address(timelock));

    _expectRegisterReverts(
      abi.encodeWithSelector(ILiquidityManager.PoolRateLimitAdminMismatch.selector, POOL, PREVIOUS_REBALANCER)
    );

    // The Timelock (now pool owner) installs the controller as rateLimitAdmin; registration succeeds.
    vm.prank(address(timelock));
    realPool.setRateLimitAdmin(address(controller));

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.AdapterRegistered(1, address(adapter), POOL);
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.AdapterStatusSet(1, true, true);
    vm.prank(address(timelock));
    uint256 id = manager.registerAdapter(address(adapter), POOL);
    assertEq(id, 1);
    manager.verifyAdapter(id);
  }

  function test_fork_preHandover_previousRebalancerCanWithdrawUntilHandover() public {
    vm.revertToState(preHandoverSnapshot);

    // Before the handover the current rebalancer can pull pool inventory to itself...
    uint256 before = _balance(PREVIOUS_REBALANCER);
    vm.prank(PREVIOUS_REBALANCER);
    pool.withdrawLiquidity(1);
    assertEq(_balance(PREVIOUS_REBALANCER), before + 1);

    // ...and installing the adapter removes that power.
    _handover();
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, PREVIOUS_REBALANCER));
    vm.prank(PREVIOUS_REBALANCER);
    pool.withdrawLiquidity(1);
  }

  function test_fork_previousRebalancer_cannotWithdrawOrProvideAfterHandover() public {
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, PREVIOUS_REBALANCER));
    vm.prank(PREVIOUS_REBALANCER);
    pool.withdrawLiquidity(1e18);

    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, PREVIOUS_REBALANCER));
    vm.prank(PREVIOUS_REBALANCER);
    pool.provideLiquidity(1e18);
  }

  function test_fork_previousRateLimitAdmin_cannotSetRateLimits() public {
    ILockReleaseTokenPool.RateLimiterConfig memory open = _ccipBucket(CCIP_CAPACITY, CCIP_RATE);
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, PREVIOUS_REBALANCER));
    vm.prank(PREVIOUS_REBALANCER);
    pool.setChainRateLimiterConfig(remoteChainSelector, open, open);
  }

  function test_fork_previousOwner_cannotAdministerPool() public {
    vm.startPrank(POOL_OWNER);

    vm.expectRevert(IRealLockReleaseTokenPool.OnlyCallableByOwner.selector);
    realPool.setRebalancer(POOL_OWNER);

    vm.expectRevert(IRealLockReleaseTokenPool.OnlyCallableByOwner.selector);
    realPool.setRateLimitAdmin(POOL_OWNER);

    vm.expectRevert(IRealLockReleaseTokenPool.OnlyCallableByOwner.selector);
    realPool.transferOwnership(POOL_OWNER);

    vm.expectRevert(IRealLockReleaseTokenPool.OnlyCallableByOwner.selector);
    realPool.setRouter(POOL_OWNER);

    vm.expectRevert(IRealLockReleaseTokenPool.OnlyCallableByOwner.selector);
    realPool.transferLiquidity(POOL, 1);

    vm.expectRevert(IRealLockReleaseTokenPool.OnlyCallableByOwner.selector);
    realPool.addRemotePool(remoteChainSelector, abi.encode(POOL_OWNER));

    ILockReleaseTokenPool.RateLimiterConfig memory open = _ccipBucket(CCIP_CAPACITY, CCIP_RATE);
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, POOL_OWNER));
    pool.setChainRateLimiterConfig(remoteChainSelector, open, open);

    vm.stopPrank();
  }

  // ================================================================
  // │                 Interface conformance (real pool)            │
  // ================================================================

  function test_fork_interface_viewsMatchDeployment() public view {
    assertEq(pool.typeAndVersion(), POOL_VERSION);
    assertEq(pool.getToken(), SAHARA);
    assertEq(pool.getRouter(), address(router));
    assertEq(pool.owner(), address(timelock));
    assertEq(pool.getRateLimitAdmin(), address(controller));
    assertEq(pool.getRebalancer(), address(adapter));

    uint64[] memory chains = pool.getSupportedChains();
    assertEq(chains.length, 1);
    assertEq(chains[0], remoteChainSelector);
    assertTrue(pool.isSupportedChain(remoteChainSelector));
    assertFalse(pool.isSupportedChain(localChainSelector));

    // Remote token and remote pool are abi.encode(address): 32 bytes, not 20.
    bytes memory remoteToken = pool.getRemoteToken(remoteChainSelector);
    assertEq(remoteToken.length, 32);
    assertEq(remoteToken, abi.encode(SAHARA));
    assertEq(pool.getRemoteToken(localChainSelector).length, 0);

    bytes[] memory remotePools = pool.getRemotePools(remoteChainSelector);
    assertEq(remotePools.length, 1);
    assertEq(remotePools[0], abi.encode(POOL));
    assertEq(pool.getRemotePools(localChainSelector).length, 0);
    assertTrue(pool.isRemotePool(remoteChainSelector, abi.encode(POOL)));
    assertFalse(pool.isRemotePool(remoteChainSelector, abi.encodePacked(POOL)));
    assertFalse(pool.isRemotePool(localChainSelector, abi.encode(POOL)));

    assertEq(realPool.getTokenDecimals(), 18);
    assertEq(token.decimals(), 18);
    assertFalse(realPool.getAllowListEnabled());
    assertTrue(realPool.isSupportedToken(SAHARA));
  }

  function test_fork_interface_selectorsMatchRealPool() public view {
    bytes4[14] memory selectors = [
      ILockReleaseTokenPool.provideLiquidity.selector,
      ILockReleaseTokenPool.withdrawLiquidity.selector,
      ILockReleaseTokenPool.getRebalancer.selector,
      ILockReleaseTokenPool.typeAndVersion.selector,
      ILockReleaseTokenPool.getToken.selector,
      ILockReleaseTokenPool.getRouter.selector,
      ILockReleaseTokenPool.owner.selector,
      ILockReleaseTokenPool.getRateLimitAdmin.selector,
      ILockReleaseTokenPool.getSupportedChains.selector,
      ILockReleaseTokenPool.isSupportedChain.selector,
      ILockReleaseTokenPool.getRemoteToken.selector,
      ILockReleaseTokenPool.getRemotePools.selector,
      ILockReleaseTokenPool.isRemotePool.selector,
      ILockReleaseTokenPool.setChainRateLimiterConfig.selector
    ];
    string[14] memory signatures = [
      "provideLiquidity(uint256)",
      "withdrawLiquidity(uint256)",
      "getRebalancer()",
      "typeAndVersion()",
      "getToken()",
      "getRouter()",
      "owner()",
      "getRateLimitAdmin()",
      "getSupportedChains()",
      "isSupportedChain(uint64)",
      "getRemoteToken(uint64)",
      "getRemotePools(uint64)",
      "isRemotePool(uint64,bytes)",
      "setChainRateLimiterConfig(uint64,(bool,uint128,uint128),(bool,uint128,uint128))"
    ];
    for (uint256 i = 0; i < selectors.length; ++i) {
      assertEq(selectors[i], bytes4(keccak256(bytes(signatures[i]))), signatures[i]);
      assertTrue(_codeHasSelector(POOL, selectors[i]), signatures[i]);
    }
    assertEq(ITokenAdminRegistry.getPool.selector, bytes4(keccak256("getPool(address)")));
    assertTrue(_codeHasSelector(address(registry), ITokenAdminRegistry.getPool.selector), "registry getPool");
  }

  function test_fork_interface_mutatingCallsBehaveAsAssumed() public {
    // withdrawLiquidity pays msg.sender (the rebalancer) and emits LiquidityRemoved(provider, amount).
    uint256 poolBefore = _balance(POOL);
    vm.expectEmit(true, true, false, true, POOL);
    emit IRealLockReleaseTokenPool.LiquidityRemoved(address(adapter), 1e18);
    vm.prank(address(adapter));
    pool.withdrawLiquidity(1e18);
    assertEq(_balance(address(adapter)), 1e18);
    assertEq(_balance(POOL), poolBefore - 1e18);

    // provideLiquidity pulls from msg.sender with transferFrom and consumes the allowance exactly.
    vm.startPrank(address(adapter));
    IERC20(SAHARA).approve(POOL, 1e18);
    vm.expectEmit(true, true, false, true, POOL);
    emit IRealLockReleaseTokenPool.LiquidityAdded(address(adapter), 1e18);
    pool.provideLiquidity(1e18);
    vm.stopPrank();
    assertEq(_balance(address(adapter)), 0);
    assertEq(_balance(POOL), poolBefore);
    assertEq(token.allowance(address(adapter), POOL), 0);

    // Without an allowance the pull fails inside the token (error bubbled by the pool's SafeERC20).
    vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, POOL, 0, 1));
    vm.prank(address(adapter));
    pool.provideLiquidity(1);

    // withdrawLiquidity beyond the balance.
    uint256 tooMuch = poolBefore + 1;
    vm.expectRevert(IRealLockReleaseTokenPool.InsufficientLiquidity.selector);
    vm.prank(address(adapter));
    pool.withdrawLiquidity(tooMuch);

    // Liquidity functions are rebalancer-only.
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, attacker));
    vm.prank(attacker);
    pool.withdrawLiquidity(1);

    // setChainRateLimiterConfig: owner and rateLimitAdmin only; validated like RateLimiter 1.6.3-dev.
    ILockReleaseTokenPool.RateLimiterConfig memory open = _ccipBucket(CCIP_CAPACITY, CCIP_RATE);
    vm.expectEmit(false, false, false, true, POOL);
    emit IRealLockReleaseTokenPool.ChainConfigured(remoteChainSelector, open, open);
    vm.prank(address(timelock));
    pool.setChainRateLimiterConfig(remoteChainSelector, open, open);
    _assertBucket(_outbound(), true, CCIP_CAPACITY, CCIP_RATE);
    _assertBucket(_inbound(), true, CCIP_CAPACITY, CCIP_RATE);

    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.NonExistentChain.selector, localChainSelector));
    vm.prank(address(timelock));
    pool.setChainRateLimiterConfig(localChainSelector, open, open);

    ILockReleaseTokenPool.RateLimiterConfig memory rateAboveCapacity = _ccipBucket(1, 2);
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.InvalidRateLimitRate.selector, rateAboveCapacity));
    vm.prank(address(controller));
    pool.setChainRateLimiterConfig(remoteChainSelector, rateAboveCapacity, open);

    ILockReleaseTokenPool.RateLimiterConfig memory disabledNonZero =
      ILockReleaseTokenPool.RateLimiterConfig({isEnabled: false, capacity: 1, rate: 0});
    vm.expectRevert(
      abi.encodeWithSelector(IRealLockReleaseTokenPool.DisabledNonZeroRateLimit.selector, disabledNonZero)
    );
    vm.prank(address(controller));
    pool.setChainRateLimiterConfig(remoteChainSelector, open, disabledNonZero);
  }

  function test_fork_adapterConstructor_readsRealPoolToken() public {
    address otherToken = makeAddr("otherToken");
    vm.expectRevert(abi.encodeWithSelector(CCIPPoolAdapter.PoolTokenMismatch.selector, SAHARA, otherToken));
    new CCIPPoolAdapter(address(manager), otherToken, POOL);
  }

  // ================================================================
  // │                          Funding                             │
  // ================================================================

  function test_fork_fund_movesExactAmountIntoRealPool() public {
    uint256 amount = 10_000_000e18;
    uint256 managerBefore = _balance(address(manager));
    uint256 poolBefore = _balance(POOL);
    uint256 supplyBefore = token.totalSupply();

    vm.expectEmit(true, true, false, true, POOL);
    emit IRealLockReleaseTokenPool.LiquidityAdded(address(adapter), amount);
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Funded(adapterId, POOL, fundingOperator, address(adapter), amount);
    _fund(amount);

    assertEq(_balance(address(manager)), managerBefore - amount, "manager debited");
    assertEq(_balance(POOL), poolBefore + amount, "pool credited");
    assertEq(_balance(address(adapter)), 0, "adapter retains nothing");
    assertEq(token.allowance(address(adapter), POOL), 0, "no residual allowance");
    assertEq(token.totalSupply(), supplyBefore, "supply unchanged");

    assertEq(manager.getAggregateFundingBudget().available, AGGREGATE_FUNDING_CAPACITY - amount);
    assertEq(manager.getPoolFundingBudget(POOL).available, POOL_FUNDING_CAPACITY - amount);
    assertEq(manager.getRecallBudget().available, RECALL_CAPACITY, "funding does not touch the recall budget");
  }

  function test_fork_fund_maxPerCallSucceedsAndAboveReverts() public {
    uint256 poolBefore = _balance(POOL);
    _fund(MAX_FUNDING_PER_CALL);
    assertEq(_balance(POOL), poolBefore + MAX_FUNDING_PER_CALL);

    vm.expectRevert(
      abi.encodeWithSelector(
        ILiquidityManager.ExceedsPerCallLimit.selector, MAX_FUNDING_PER_CALL + 1, MAX_FUNDING_PER_CALL
      )
    );
    _fund(MAX_FUNDING_PER_CALL + 1);
  }

  function test_fork_fund_poolBudgetBoundsRepeatedFunding() public {
    _fund(MAX_FUNDING_PER_CALL);
    _fund(MAX_FUNDING_PER_CALL);
    assertEq(manager.getPoolFundingBudget(POOL).available, 0);

    vm.expectRevert(abi.encodeWithSelector(TokenBucket.BudgetExceeded.selector, 1e18, 0));
    _fund(1e18);

    // The pool budget refills at its rate.
    vm.warp(block.timestamp + 1 hours);
    _fund(POOL_FUNDING_RATE * 1 hours);
  }

  function test_fork_fund_unsolicitedAdapterBalanceIsUntouched() public {
    uint256 stray = 7e18;
    deal(SAHARA, address(adapter), stray);
    uint256 managerBefore = _balance(address(manager));
    uint256 poolBefore = _balance(POOL);

    _fund(5_000_000e18);
    assertEq(_balance(address(adapter)), stray);
    _recall(5_000_000e18);
    assertEq(_balance(address(adapter)), stray);

    assertEq(_balance(address(manager)), managerBefore);
    assertEq(_balance(POOL), poolBefore);
    assertEq(token.allowance(address(adapter), POOL), 0);
  }

  // ================================================================
  // │                           Recall                             │
  // ================================================================

  function test_fork_recall_returnsExactAmountFromRealPool() public {
    uint256 amount = 10_000_000e18;
    uint256 managerBefore = _balance(address(manager));
    uint256 poolBefore = _balance(POOL);

    vm.expectEmit(true, true, false, true, POOL);
    emit IRealLockReleaseTokenPool.LiquidityRemoved(address(adapter), amount);
    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.Recalled(adapterId, POOL, recallOperator, address(adapter), amount);
    _recall(amount);

    assertEq(_balance(address(manager)), managerBefore + amount, "manager credited");
    assertEq(_balance(POOL), poolBefore - amount, "pool debited");
    assertEq(_balance(address(adapter)), 0, "adapter forwards everything");
    assertEq(manager.getRecallBudget().available, RECALL_CAPACITY - amount);
  }

  function test_fork_recall_doesNotCreditFundingBudgets() public {
    uint256 amount = 20_000_000e18;
    _fund(amount);
    _recall(amount);
    assertEq(manager.getAggregateFundingBudget().available, AGGREGATE_FUNDING_CAPACITY - amount);
    assertEq(manager.getPoolFundingBudget(POOL).available, POOL_FUNDING_CAPACITY - amount);
    assertEq(manager.getRecallBudget().available, RECALL_CAPACITY - amount);
  }

  function test_fork_recall_revertsBelowPoolMinimum() public {
    uint256 poolBalance = _balance(POOL);
    uint256 headroom = 5_000_000e18;
    uint256 minimum = poolBalance - headroom;

    vm.prank(guardian);
    manager.raisePoolMinimum(POOL, minimum);

    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, poolBalance, headroom + 1, minimum)
    );
    _recall(headroom + 1);

    // Exactly down to the minimum is allowed.
    _recall(headroom);
    assertEq(_balance(POOL), minimum);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, minimum, 1, minimum));
    _recall(1);
  }

  function test_fork_recall_revertsAboveRealPoolBalanceAndCanDrainAtZeroMinimum() public {
    vm.startPrank(address(timelock));
    manager.setPoolThresholds(POOL, 0, 0, 0);
    manager.setRecallLimits(type(uint128).max, type(uint128).max, type(uint128).max);
    vm.stopPrank();
    vm.warp(block.timestamp + 1);

    uint256 poolBalance = _balance(POOL);
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, poolBalance, poolBalance + 1, 0)
    );
    _recall(poolBalance + 1);

    // With a zero minimum the minimum is the only inventory protection: everything can be recalled to the Manager.
    uint256 managerBefore = _balance(address(manager));
    _recall(poolBalance);
    assertEq(_balance(POOL), 0);
    assertEq(_balance(address(manager)), managerBefore + poolBalance);
  }

  function test_fork_recall_skipsPoolSpecChecks() public {
    address newRouter = makeAddr("newRouter");
    vm.prank(address(timelock));
    realPool.setRouter(newRouter);

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, POOL, newRouter));
    _fund(1e18);

    uint256 managerBefore = _balance(address(manager));
    _recall(1e18);
    assertEq(_balance(address(manager)), managerBefore + 1e18);
  }

  function test_fork_recall_revertsWhenAdapterLostRebalancerRole() public {
    address other = makeAddr("otherRebalancer");
    vm.prank(address(timelock));
    realPool.setRebalancer(other);

    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, address(adapter)));
    _recall(1e18);
  }

  // ================================================================
  // │                 TokenAdminRegistry mapping                   │
  // ================================================================

  function test_fork_registry_mockedMappingBlocksFund() public {
    address decoy = makeAddr("decoyPool");
    vm.mockCall(address(registry), abi.encodeCall(ITokenAdminRegistry.getPool, (SAHARA)), abi.encode(decoy));

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, POOL, decoy));
    manager.verifyAdapter(adapterId);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, POOL, decoy));
    _fund(1e18);
  }

  function test_fork_registry_realMappingRemovedBlocksFund() public {
    vm.prank(address(timelock));
    registry.setPool(SAHARA, address(0));
    assertEq(registry.getPool(SAHARA), address(0));

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, POOL, address(0)));
    _fund(1e18);
  }

  function test_fork_registry_realMappingMovedBlocksFundButNotRecall() public {
    DecoyRegistryPool decoy = new DecoyRegistryPool(SAHARA);
    vm.prank(address(timelock));
    registry.setPool(SAHARA, address(decoy));
    assertEq(registry.getPool(SAHARA), address(decoy));

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, POOL, address(decoy)));
    _fund(1e18);

    // Recall only returns funds to the Manager and does not depend on the mapping.
    uint256 managerBefore = _balance(address(manager));
    _recall(1e18);
    assertEq(_balance(address(manager)), managerBefore + 1e18);
  }

  function test_fork_registry_migrationApprovalBypassesMappingUntilGuardianRevokes() public {
    DecoyRegistryPool decoy = new DecoyRegistryPool(SAHARA);
    vm.prank(address(timelock));
    registry.setPool(SAHARA, address(decoy));

    // Approved while the real registry maps SAHARA to `decoy`, the pool the funded pool replaces.
    vm.expectEmit(true, true, false, false, address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(POOL, address(decoy));
    vm.prank(address(timelock));
    manager.setPoolMigrationApproval(POOL, address(decoy));
    assertEq(manager.getPoolMigrationSource(POOL), address(decoy));
    uint256 poolBefore = _balance(POOL);
    _fund(1e18);
    assertEq(_balance(POOL), poolBefore + 1e18);

    vm.expectEmit(true, true, false, false, address(manager));
    emit ILiquidityManager.GuardianAction(guardian, LiquidityManager.revokePoolMigrationApproval.selector);
    vm.expectEmit(true, true, false, false, address(manager));
    emit ILiquidityManager.PoolMigrationApprovalSet(POOL, address(0));
    vm.prank(guardian);
    manager.revokePoolMigrationApproval(POOL);
    assertEq(manager.getPoolMigrationSource(POOL), address(0));
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, POOL, address(decoy)));
  }

  /// @dev The approval is bound to the registry pool it was granted under: once the real registry maps SAHARA to any
  /// third pool (or to nothing), funding the approved pool is blocked again.
  function test_regression_fork_migrationApprovalLapsesWhenRegistryMovesToThirdPool() public {
    DecoyRegistryPool source = new DecoyRegistryPool(SAHARA);
    DecoyRegistryPool third = new DecoyRegistryPool(SAHARA);
    vm.startPrank(address(timelock));
    registry.setPool(SAHARA, address(source));
    manager.setPoolMigrationApproval(POOL, address(source));
    vm.stopPrank();
    _fund(1e18);

    vm.prank(address(timelock));
    registry.setPool(SAHARA, address(third));
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, POOL, address(third)));
    vm.prank(address(timelock));
    registry.setPool(SAHARA, address(0));
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, POOL, address(0)));

    // Back on the source pool, or once the registry maps the funded pool itself, funding resumes.
    vm.prank(address(timelock));
    registry.setPool(SAHARA, address(source));
    _fund(1e18);
    vm.prank(address(timelock));
    registry.setPool(SAHARA, POOL);
    _fund(1e18);

    // An approval naming the pool as its own source is rejected; address(0) revokes.
    vm.startPrank(address(timelock));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, POOL));
    manager.setPoolMigrationApproval(POOL, POOL);
    manager.setPoolMigrationApproval(POOL, address(0));
    vm.stopPrank();
    assertEq(manager.getPoolMigrationSource(POOL), address(0));
  }

  function test_fork_registry_lockdownAllowedForRegisteredPoolAfterMappingMoved() public {
    DecoyRegistryPool decoy = new DecoyRegistryPool(SAHARA);
    vm.prank(address(timelock));
    registry.setPool(SAHARA, address(decoy));

    vm.prank(guardian);
    controller.lockdown(POOL);
    _assertLockedDown();

    // A pool that is neither registered in the Manager nor mapped in the registry is not recognised.
    address unknown = makeAddr("unknownPool");
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, unknown));
    vm.prank(guardian);
    controller.lockdown(unknown);
  }

  function test_fork_registry_adminHandoverToTimelock() public {
    // The handover moved the administrator role to the Timelock (two-step, accepted in setUp).
    _assertTokenConfig(address(timelock), address(0), POOL);
    assertTrue(registry.isAdministrator(SAHARA, address(timelock)));
    assertFalse(registry.isAdministrator(SAHARA, POOL_OWNER));

    // The multisig and the Guardian no longer control pool reassignment or the administrator role.
    vm.startPrank(POOL_OWNER);
    vm.expectRevert(abi.encodeWithSelector(IRealTokenAdminRegistry.OnlyAdministrator.selector, POOL_OWNER, SAHARA));
    registry.setPool(SAHARA, address(0));
    vm.expectRevert(abi.encodeWithSelector(IRealTokenAdminRegistry.OnlyAdministrator.selector, POOL_OWNER, SAHARA));
    registry.transferAdminRole(SAHARA, POOL_OWNER);
    vm.stopPrank();
    vm.expectRevert(abi.encodeWithSelector(IRealTokenAdminRegistry.OnlyAdministrator.selector, guardian, SAHARA));
    vm.prank(guardian);
    registry.setPool(SAHARA, address(0));

    // The Timelock moves the mapping (blocking routine funding) and restores it.
    vm.prank(address(timelock));
    registry.setPool(SAHARA, address(0));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolNotActiveInRegistry.selector, POOL, address(0)));
    _fund(1e18);

    vm.prank(address(timelock));
    registry.setPool(SAHARA, POOL);
    _fund(1e18);
  }

  function test_fork_registry_chainlinkRegistryOwnerCannotReplaceAdministrator() public {
    address registryOwner = registry.owner();
    vm.expectRevert(abi.encodeWithSelector(IRealTokenAdminRegistry.AlreadyRegistered.selector, SAHARA));
    vm.prank(registryOwner);
    registry.proposeAdministrator(SAHARA, attacker);

    vm.expectRevert(abi.encodeWithSelector(IRealTokenAdminRegistry.OnlyAdministrator.selector, registryOwner, SAHARA));
    vm.prank(registryOwner);
    registry.setPool(SAHARA, address(0));
    assertEq(registry.getPool(SAHARA), POOL);
  }

  /// @dev `ITokenAdminRegistry.getTokenConfig` must decode the real registry's return data in field order
  /// (administrator, pendingAdministrator, tokenPool). Each state below is checked on the raw return data and through
  /// the Manager; the mid-transfer states have three distinct non-zero fields, so an order mistake cannot pass.
  function test_regression_fork_registry_getTokenConfigDecodingPinned() public {
    assertEq(registry.typeAndVersion(), "TokenAdminRegistry 1.5.0");
    assertEq(ITokenAdminRegistry.getTokenConfig.selector, bytes4(keccak256("getTokenConfig(address)")));
    assertTrue(
      _codeHasSelector(address(registry), ITokenAdminRegistry.getTokenConfig.selector), "registry getTokenConfig"
    );
    assertEq(IRealTokenAdminRegistry.getTokenConfig.selector, ITokenAdminRegistry.getTokenConfig.selector);

    // After the handover: the Timelock administers, nothing is pending.
    _assertTokenConfig(address(timelock), address(0), POOL);
    manager.verifyHandover();

    // A pending transfer is read from the second field.
    address successor = makeAddr("successorAdmin");
    vm.prank(address(timelock));
    registry.transferAdminRole(SAHARA, successor);
    _assertTokenConfig(address(timelock), successor, POOL);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminTransferPending.selector, successor));
    manager.verifyHandover();

    // Live state: the legacy multisig administers; then the Timelock is proposed.
    vm.revertToState(preHandoverSnapshot);
    _assertTokenConfig(POOL_OWNER, address(0), POOL);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, POOL_OWNER));
    manager.verifyHandover();
    vm.prank(POOL_OWNER);
    registry.transferAdminRole(SAHARA, address(timelock));
    _assertTokenConfig(POOL_OWNER, address(timelock), POOL);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, POOL_OWNER));
    manager.verifyHandover();
  }

  /// @dev A pending TokenAdminRegistry transfer fails the launch-time handover check (`verifyHandover`, which gates
  /// `registerAdapter`) but blocks neither routine funding nor an emergency `replaceAdapter`, which only runs the pool
  /// checks.
  function test_regression_fork_pendingRegistryTransferBlocksRegistrationOnly() public {
    address successor = makeAddr("successorAdmin");
    vm.prank(address(timelock));
    registry.transferAdminRole(SAHARA, successor);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminTransferPending.selector, successor));
    manager.verifyHandover();

    uint256 poolBefore = _balance(POOL);
    _fund(1e18);
    assertEq(_balance(POOL), poolBefore + 1e18);

    CCIPPoolAdapter newAdapter = new CCIPPoolAdapter(address(manager), SAHARA, POOL);
    vm.prank(address(timelock));
    realPool.setRebalancer(address(newAdapter));
    vm.prank(address(timelock));
    manager.replaceAdapter(adapterId, address(newAdapter));
    assertEq(manager.getAdapter(adapterId).adapter, address(newAdapter));

    // The real registry lets the administrator withdraw a proposal by proposing address(0).
    vm.prank(address(timelock));
    registry.transferAdminRole(SAHARA, address(0));
    _assertTokenConfig(address(timelock), address(0), POOL);
    manager.verifyHandover();

    // Once a successor accepts, the Timelock no longer administers the token: the handover check fails closed.
    vm.prank(address(timelock));
    registry.transferAdminRole(SAHARA, successor);
    vm.prank(successor);
    registry.acceptAdminRole(SAHARA);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, successor));
    manager.verifyHandover();
  }

  /// @dev Token ownership leaving the Timelock (OZ single-step) fails the handover check, while an emergency adapter
  /// replacement still works against the real pool.
  function test_regression_fork_tokenOwnershipMovedFailsHandoverCheckOnly() public {
    address other = makeAddr("otherTokenOwner");
    vm.prank(address(timelock));
    token.transferOwnership(other);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.TokenOwnerMismatch.selector, other));
    manager.verifyHandover();

    CCIPPoolAdapter newAdapter = new CCIPPoolAdapter(address(manager), SAHARA, POOL);
    vm.prank(address(timelock));
    realPool.setRebalancer(address(newAdapter));
    vm.prank(address(timelock));
    manager.replaceAdapter(adapterId, address(newAdapter));
    assertEq(manager.getAdapter(adapterId).adapter, address(newAdapter));
    manager.verifyAdapter(adapterId);
  }

  /// @dev With the registry mapping removed, `getPool` returns address(0); address(0) must still not be recognised as
  /// a lockdown target.
  function test_regression_fork_lockdownRejectsZeroPoolWhenRegistryMappingRemoved() public {
    vm.prank(address(timelock));
    registry.setPool(SAHARA, address(0));
    assertEq(registry.getPool(SAHARA), address(0));

    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, address(0)));
    vm.prank(guardian);
    controller.lockdown(address(0));

    // The pool registered in the Manager is still recognised.
    vm.prank(guardian);
    controller.lockdown(POOL);
    _assertLockedDown();
  }

  // ================================================================
  // │                     Guardian lockdown                        │
  // ================================================================

  function test_fork_lockdown_zeroesBothCounterpartBuckets() public {
    ILockReleaseTokenPool.RateLimiterConfig memory zero = _zeroBucket();
    vm.expectEmit(false, false, false, true, POOL);
    emit IRealLockReleaseTokenPool.ChainConfigured(remoteChainSelector, zero, zero);
    vm.expectEmit(true, true, true, true, address(controller));
    emit GuardianController.PoolLockedDown(POOL, remoteChainSelector, guardian);
    vm.prank(guardian);
    controller.lockdown(POOL);

    _assertLockedDown();

    // A zero-rate bucket never refills.
    vm.warp(block.timestamp + 365 days);
    _assertLockedDown();
  }

  function test_fork_lockdown_haltsRealBridgeTransfers() public {
    address onRamp = _onRamp();
    address offRamp = _offRamp();
    address receiver = makeAddr("bridgeReceiver");
    uint256 amount = 1_000e18;

    // Before lockdown the real ramps can move tokens through the pool.
    vm.prank(onRamp);
    realPool.lockOrBurn(_lockOrBurnIn(amount));
    vm.prank(offRamp);
    realPool.releaseOrMint(_releaseOrMintIn(receiver, amount));
    assertEq(_balance(receiver), amount);

    vm.prank(guardian);
    controller.lockdown(POOL);

    vm.expectRevert(
      abi.encodeWithSelector(IRealLockReleaseTokenPool.TokenMaxCapacityExceeded.selector, 0, amount, SAHARA)
    );
    vm.prank(onRamp);
    realPool.lockOrBurn(_lockOrBurnIn(amount));

    vm.expectRevert(
      abi.encodeWithSelector(IRealLockReleaseTokenPool.TokenMaxCapacityExceeded.selector, 0, amount, SAHARA)
    );
    vm.prank(offRamp);
    realPool.releaseOrMint(_releaseOrMintIn(receiver, amount));
    assertEq(_balance(receiver), amount);
  }

  function test_fork_lockdown_timelockRestoresAndBucketsRefillFromZero() public {
    address onRamp = _onRamp();
    address offRamp = _offRamp();
    address receiver = makeAddr("bridgeReceiver");

    vm.prank(guardian);
    controller.lockdown(POOL);

    ILockReleaseTokenPool.RateLimiterConfig memory open = _ccipBucket(CCIP_CAPACITY, CCIP_RATE);
    vm.expectEmit(false, false, false, true, POOL);
    emit IRealLockReleaseTokenPool.ChainConfigured(remoteChainSelector, open, open);
    vm.prank(address(timelock));
    pool.setChainRateLimiterConfig(remoteChainSelector, open, open);

    // Restoring an enabled zeroed bucket starts from zero.
    _assertBucketState(_outbound(), true, CCIP_CAPACITY, CCIP_RATE, 0);
    _assertBucketState(_inbound(), true, CCIP_CAPACITY, CCIP_RATE, 0);

    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.TokenRateLimitReached.selector, 1, 0, SAHARA));
    vm.prank(onRamp);
    realPool.lockOrBurn(_lockOrBurnIn(1e18));
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.TokenRateLimitReached.selector, 1, 0, SAHARA));
    vm.prank(offRamp);
    realPool.releaseOrMint(_releaseOrMintIn(receiver, 1e18));

    // ...and refills under the restored rate.
    vm.warp(block.timestamp + 1 hours);
    uint128 refilled = CCIP_RATE * 1 hours;
    _assertBucketState(_outbound(), true, CCIP_CAPACITY, CCIP_RATE, refilled);
    _assertBucketState(_inbound(), true, CCIP_CAPACITY, CCIP_RATE, refilled);
    vm.prank(onRamp);
    realPool.lockOrBurn(_lockOrBurnIn(1_000e18));
    vm.prank(offRamp);
    realPool.releaseOrMint(_releaseOrMintIn(receiver, 1_000e18));
    assertEq(_balance(receiver), 1_000e18);

    vm.warp(block.timestamp + 2 days);
    _assertBucketState(_outbound(), true, CCIP_CAPACITY, CCIP_RATE, CCIP_CAPACITY);
  }

  function test_fork_lockdown_queuedRestorationCancellableByGuardianThenExecutable() public {
    vm.prank(guardian);
    controller.lockdown(POOL);

    ILockReleaseTokenPool.RateLimiterConfig memory open = _ccipBucket(CCIP_CAPACITY, CCIP_RATE);
    bytes memory restore =
      abi.encodeCall(ILockReleaseTokenPool.setChainRateLimiterConfig, (remoteChainSelector, open, open));
    bytes32 salt = keccak256("restore");

    // A stale restoration queued before or during an incident can be cancelled through the controller.
    bytes32 id = _schedule(POOL, restore, salt);
    assertTrue(timelock.isOperationPending(id));
    vm.expectEmit(true, true, false, false, address(controller));
    emit GuardianController.ProposalCancelled(id, guardian);
    vm.prank(guardian);
    controller.cancel(POOL, 0, restore, bytes32(0), salt);
    assertFalse(timelock.isOperation(id));

    // Re-queued after the incident, it executes after the full delay and the buckets refill from zero.
    _schedule(POOL, restore, salt);
    vm.warp(block.timestamp + TIMELOCK_DELAY - 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        TimelockController.TimelockUnexpectedOperationState.selector,
        id,
        bytes32(1 << uint8(TimelockController.OperationState.Ready))
      )
    );
    vm.prank(governanceSafe);
    timelock.execute(POOL, 0, restore, bytes32(0), salt);

    vm.warp(block.timestamp + 1);
    vm.prank(governanceSafe);
    timelock.execute(POOL, 0, restore, bytes32(0), salt);
    assertTrue(timelock.isOperationDone(id));
    _assertBucketState(_outbound(), true, CCIP_CAPACITY, CCIP_RATE, 0);
    _assertBucketState(_inbound(), true, CCIP_CAPACITY, CCIP_RATE, 0);
  }

  function test_fork_lockdown_guardianCannotSetNonZeroOrDisabledLimits() public {
    ILockReleaseTokenPool.RateLimiterConfig memory open = _ccipBucket(CCIP_CAPACITY, CCIP_RATE);
    ILockReleaseTokenPool.RateLimiterConfig memory higher = _ccipBucket(CCIP_CAPACITY * 2, CCIP_RATE * 2);
    ILockReleaseTokenPool.RateLimiterConfig memory disabled =
      ILockReleaseTokenPool.RateLimiterConfig({isEnabled: false, capacity: 0, rate: 0});

    vm.prank(guardian);
    controller.lockdown(POOL);

    vm.startPrank(guardian);
    // The Guardian EOA/Safe holds no pool role itself.
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, guardian));
    pool.setChainRateLimiterConfig(remoteChainSelector, open, open);
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, guardian));
    pool.setChainRateLimiterConfig(remoteChainSelector, higher, higher);
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, guardian));
    pool.setChainRateLimiterConfig(remoteChainSelector, disabled, disabled);

    uint64[] memory selectors = new uint64[](1);
    selectors[0] = remoteChainSelector;
    ILockReleaseTokenPool.RateLimiterConfig[] memory configs = new ILockReleaseTokenPool.RateLimiterConfig[](1);
    configs[0] = open;
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, guardian));
    realPool.setChainRateLimiterConfigs(selectors, configs, configs);

    vm.expectRevert(IRealLockReleaseTokenPool.OnlyCallableByOwner.selector);
    realPool.setRateLimitAdmin(guardian);

    // The controller exposes no setter for non-zero or disabled limits (and has no fallback).
    (bool ok,) = address(controller).call(
      abi.encodeCall(ILockReleaseTokenPool.setChainRateLimiterConfig, (remoteChainSelector, open, open))
    );
    assertFalse(ok, "controller forwards setChainRateLimiterConfig");
    (ok,) = address(controller).call(
      abi.encodeCall(IRealLockReleaseTokenPool.setChainRateLimiterConfigs, (selectors, configs, configs))
    );
    assertFalse(ok, "controller forwards setChainRateLimiterConfigs");
    (ok,) = address(controller).call(abi.encodeWithSignature("setRateLimitAdmin(address)", guardian));
    assertFalse(ok, "controller forwards setRateLimitAdmin");
    vm.stopPrank();

    _assertLockedDown();
  }

  function test_fork_lockdown_recognisesRegistryPoolNotRegisteredInManager() public {
    // A Manager with no adapters: the pool is recognised only because the real registry maps SAHARA to it.
    address otherGuardian = makeAddr("otherGuardian");
    LiquidityManager emptyManager =
      new LiquidityManager(SAHARA, ITokenAdminRegistry(address(registry)), address(timelock), otherGuardian);
    GuardianController otherController = new GuardianController(emptyManager, timelock);
    assertEq(emptyManager.adapterIdByPool(POOL), 0);
    vm.prank(address(timelock));
    realPool.setRateLimitAdmin(address(otherController));

    vm.prank(otherGuardian);
    otherController.lockdown(POOL);
    _assertLockedDown();

    // Once the registry maps elsewhere, the unregistered pool is no longer recognised.
    vm.prank(address(timelock));
    registry.setPool(SAHARA, address(0));
    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, POOL));
    vm.prank(otherGuardian);
    otherController.lockdown(POOL);
  }

  function test_fork_lockdown_rawRateLimitAdminRoleCouldDisableOrRaise() public {
    // Documents why rateLimitAdmin must be held by the zero-only controller: the raw role on the real pool accepts
    // disabled buckets and arbitrary higher limits.
    ILockReleaseTokenPool.RateLimiterConfig memory disabled =
      ILockReleaseTokenPool.RateLimiterConfig({isEnabled: false, capacity: 0, rate: 0});
    vm.prank(address(controller));
    pool.setChainRateLimiterConfig(remoteChainSelector, disabled, disabled);
    _assertBucketState(_outbound(), false, 0, 0, 0);

    ILockReleaseTokenPool.RateLimiterConfig memory higher = _ccipBucket(type(uint128).max, type(uint128).max);
    vm.prank(address(controller));
    pool.setChainRateLimiterConfig(remoteChainSelector, higher, higher);
    _assertBucket(_inbound(), true, type(uint128).max, type(uint128).max);
  }

  function test_fork_lockdown_revertsForNonGuardian() public {
    vm.expectRevert(abi.encodeWithSelector(GuardianController.CallerNotGuardian.selector, attacker));
    vm.prank(attacker);
    controller.lockdown(POOL);

    vm.expectRevert(abi.encodeWithSelector(GuardianController.CallerNotGuardian.selector, governanceSafe));
    vm.prank(governanceSafe);
    controller.lockdown(POOL);

    vm.expectRevert(abi.encodeWithSelector(GuardianController.CallerNotGuardian.selector, address(timelock)));
    vm.prank(address(timelock));
    controller.lockdown(POOL);
  }

  function test_fork_lockdown_revertsWhenControllerLostRateLimitAdmin() public {
    vm.prank(address(timelock));
    realPool.setRateLimitAdmin(makeAddr("otherAdmin"));

    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, address(controller)));
    vm.prank(guardian);
    controller.lockdown(POOL);
  }

  function test_fork_lockdown_isIdempotentAndIndependentOfManagerOperations() public {
    vm.startPrank(guardian);
    controller.lockdown(POOL);
    controller.lockdown(POOL);
    vm.stopPrank();
    _assertLockedDown();

    // The bridge lockdown does not touch Manager funding/recall (separate controls).
    uint256 poolBefore = _balance(POOL);
    _fund(2e18);
    _recall(1e18);
    assertEq(_balance(POOL), poolBefore + 1e18);
    _assertLockedDown();
  }

  function test_fork_guardianRemoval_isProtectedAndRevokesLockdown() public {
    address newGuardian = makeAddr("newGuardian");
    bytes memory data = abi.encodeCall(ILiquidityManager.setGuardian, (newGuardian));
    bytes32 salt = keccak256("replace guardian");
    bytes32 id = _schedule(address(manager), data, salt);

    vm.expectRevert(abi.encodeWithSelector(GuardianController.ProtectedOperation.selector, id));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, data, bytes32(0), salt);

    // Guardian restrictions do not block the recovery path.
    vm.startPrank(guardian);
    manager.pauseFunding();
    manager.pauseRecall();
    controller.lockdown(POOL);
    vm.stopPrank();

    vm.warp(block.timestamp + TIMELOCK_DELAY);
    vm.prank(governanceSafe);
    timelock.execute(address(manager), 0, data, bytes32(0), salt);
    assertEq(manager.guardian(), newGuardian);

    vm.expectRevert(abi.encodeWithSelector(GuardianController.CallerNotGuardian.selector, guardian));
    vm.prank(guardian);
    controller.lockdown(POOL);

    vm.prank(newGuardian);
    controller.lockdown(POOL);
    _assertLockedDown();
  }

  // ================================================================
  // │                 Token pause (token owner = Timelock)         │
  // ================================================================

  function test_fork_tokenPause_blocksFundAndRecallButNotLockdown() public {
    // The handover made the Timelock the token owner (OZ Ownable, single-step); the multisig kept nothing.
    assertEq(token.owner(), address(timelock));
    vm.expectRevert(abi.encodeWithSelector(IRealSahara.OwnableUnauthorizedAccount.selector, POOL_OWNER));
    vm.prank(POOL_OWNER);
    token.transferOwnership(POOL_OWNER);

    vm.expectRevert(abi.encodeWithSelector(IRealSahara.OwnableUnauthorizedAccount.selector, POOL_OWNER));
    vm.prank(POOL_OWNER);
    token.pause();
    // The Guardian has no direct token pause authority.
    vm.expectRevert(abi.encodeWithSelector(IRealSahara.OwnableUnauthorizedAccount.selector, guardian));
    vm.prank(guardian);
    token.pause();

    vm.prank(address(timelock));
    token.pause();

    vm.expectRevert(IRealSahara.EnforcedPause.selector);
    _fund(1e18);
    vm.expectRevert(IRealSahara.EnforcedPause.selector);
    _recall(1e18);

    vm.prank(guardian);
    controller.lockdown(POOL);
    _assertLockedDown();

    vm.prank(address(timelock));
    token.unpause();
    uint256 poolBefore = _balance(POOL);
    _fund(1e18);
    assertEq(_balance(POOL), poolBefore + 1e18);
  }

  // ================================================================
  // │        Pool checks against real pool reconfiguration         │
  // ================================================================

  function test_fork_verify_routerChangedBlocksFund() public {
    address newRouter = makeAddr("newRouter");
    vm.prank(address(timelock));
    realPool.setRouter(newRouter);
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, POOL, newRouter));

    vm.expectRevert(IRealLockReleaseTokenPool.ZeroAddressInvalid.selector);
    vm.prank(address(timelock));
    realPool.setRouter(address(0));
  }

  function test_fork_verify_extraRemotePoolBlocksFund() public {
    vm.prank(address(timelock));
    realPool.addRemotePool(remoteChainSelector, abi.encode(makeAddr("rogueRemotePool")));
    assertEq(pool.getRemotePools(remoteChainSelector).length, 2);
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, POOL));
  }

  function test_fork_verify_remotePoolRemovedBlocksFund() public {
    vm.prank(address(timelock));
    realPool.removeRemotePool(remoteChainSelector, abi.encode(POOL));
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, POOL));
  }

  function test_fork_verify_remotePoolSwappedBlocksFund() public {
    vm.startPrank(address(timelock));
    realPool.removeRemotePool(remoteChainSelector, abi.encode(POOL));
    realPool.addRemotePool(remoteChainSelector, abi.encode(makeAddr("rogueRemotePool")));
    vm.stopPrank();
    assertEq(pool.getRemotePools(remoteChainSelector).length, 1, "same size, different element");
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, POOL));
  }

  function test_fork_verify_extraChainBlocksFund() public {
    uint64[] memory none = new uint64[](0);
    IRealLockReleaseTokenPool.ChainUpdate[] memory adds = new IRealLockReleaseTokenPool.ChainUpdate[](1);
    adds[0] = _chainUpdate(1234, abi.encode(makeAddr("rogueToken")), abi.encode(makeAddr("rogueRemotePool")));
    vm.prank(address(timelock));
    realPool.applyChainUpdates(none, adds);
    assertEq(pool.getSupportedChains().length, 2);
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, POOL));
  }

  function test_fork_verify_chainRemovedBlocksFundAndLockdown() public {
    uint64[] memory removes = new uint64[](1);
    removes[0] = remoteChainSelector;
    vm.prank(address(timelock));
    realPool.applyChainUpdates(removes, new IRealLockReleaseTokenPool.ChainUpdate[](0));
    assertEq(pool.getSupportedChains().length, 0);
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, POOL));

    vm.expectRevert(abi.encodeWithSelector(GuardianController.PoolHasNoChains.selector, POOL));
    vm.prank(guardian);
    controller.lockdown(POOL);
  }

  function test_fork_verify_remoteTokenChangedBlocksFund() public {
    uint64[] memory removes = new uint64[](1);
    removes[0] = remoteChainSelector;
    IRealLockReleaseTokenPool.ChainUpdate[] memory adds = new IRealLockReleaseTokenPool.ChainUpdate[](1);
    adds[0] = _chainUpdate(remoteChainSelector, abi.encode(makeAddr("rogueToken")), abi.encode(POOL));
    vm.prank(address(timelock));
    realPool.applyChainUpdates(removes, adds);
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolRemoteTokenMismatch.selector, POOL));
  }

  function test_fork_verify_rebalancerChangedBlocksFund() public {
    address other = makeAddr("otherRebalancer");
    vm.prank(address(timelock));
    realPool.setRebalancer(other);
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, POOL, other));
  }

  function test_fork_verify_rateLimitAdminChangedBlocksFund() public {
    address other = makeAddr("otherAdmin");
    vm.prank(address(timelock));
    realPool.setRateLimitAdmin(other);
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolRateLimitAdminMismatch.selector, POOL, other));
  }

  function test_fork_verify_ownerChangedBlocksFundOnlyOnceAccepted() public {
    address newOwner = makeAddr("newPoolOwner");
    vm.prank(address(timelock));
    realPool.transferOwnership(newOwner);
    // Pending transfer: the owner is still the Timelock and funding continues.
    manager.verifyAdapter(adapterId);
    _fund(1e18);

    vm.prank(newOwner);
    realPool.acceptOwnership();
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, POOL, newOwner));
  }

  function test_fork_spec_wrongVersionPinnedRejected() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.typeAndVersion = "LockReleaseTokenPool 1.5.1";
    _expectSpecRejected(
      spec, abi.encodeWithSelector(ILiquidityManager.PoolVersionMismatch.selector, POOL, POOL_VERSION)
    );
  }

  function test_fork_spec_packedRemoteTokenEncodingRejected() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.remoteToken = abi.encodePacked(SAHARA);
    _expectSpecRejected(spec, abi.encodeWithSelector(ILiquidityManager.PoolRemoteTokenMismatch.selector, POOL));
  }

  function test_fork_spec_packedRemotePoolEncodingRejected() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.remotePools[0] = abi.encodePacked(POOL);
    _expectSpecRejected(spec, abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, POOL));
  }

  function test_fork_spec_supersetOfRemotePoolsRejected() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    bytes[] memory remotePools = new bytes[](2);
    remotePools[0] = abi.encode(POOL);
    remotePools[1] = abi.encode(makeAddr("otherRemotePool"));
    spec.remotePools = remotePools;
    _expectSpecRejected(spec, abi.encodeWithSelector(ILiquidityManager.PoolRemotePoolsMismatch.selector, POOL));
  }

  function test_fork_spec_localSelectorRejected() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.remoteChainSelector = localChainSelector;
    _expectSpecRejected(spec, abi.encodeWithSelector(ILiquidityManager.PoolChainsMismatch.selector, POOL));
  }

  function test_fork_spec_otherRouterRejected() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.router = makeAddr("otherRouter");
    _expectSpecRejected(
      spec, abi.encodeWithSelector(ILiquidityManager.PoolRouterMismatch.selector, POOL, address(router))
    );
  }

  /// @dev The pool owner is not part of the spec: it must be the Manager's own owner, whoever that is.
  function test_fork_verify_poolOwnerMustFollowManagerOwner() public {
    address newGovernance = makeAddr("newGovernance");
    vm.prank(address(timelock));
    manager.transferOwnership(newGovernance);
    // OZ Ownable2Step: while the Manager transfer is pending nothing changes.
    manager.verifyAdapter(adapterId);

    vm.prank(newGovernance);
    manager.acceptOwnership();
    assertEq(manager.owner(), newGovernance);
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, POOL, address(timelock)));
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, address(timelock)));
    manager.verifyHandover();

    // Moving the real pool to the new Manager owner (Chainlink Ownable2Step) restores funding once accepted.
    vm.prank(address(timelock));
    realPool.transferOwnership(newGovernance);
    _expectFundBlocked(abi.encodeWithSelector(ILiquidityManager.PoolOwnerMismatch.selector, POOL, address(timelock)));
    vm.prank(newGovernance);
    realPool.acceptOwnership();
    manager.verifyAdapter(adapterId);
    uint256 poolBefore = _balance(POOL);
    _fund(1e18);
    assertEq(_balance(POOL), poolBefore + 1e18);
  }

  function test_fork_spec_otherRateLimitAdminRejected() public {
    ILiquidityManager.PoolSpec memory spec = _poolSpec();
    spec.rateLimitAdmin = PREVIOUS_REBALANCER;
    _expectSpecRejected(
      spec, abi.encodeWithSelector(ILiquidityManager.PoolRateLimitAdminMismatch.selector, POOL, address(controller))
    );
  }

  // ================================================================
  // │                     Adapter replacement                      │
  // ================================================================

  function test_fork_replaceAdapter_movesRebalancerRole() public {
    CCIPPoolAdapter newAdapter = new CCIPPoolAdapter(address(manager), SAHARA, POOL);

    // Replacement requires the new adapter to already be the pool's rebalancer.
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, POOL, address(adapter)));
    vm.prank(address(timelock));
    manager.replaceAdapter(adapterId, address(newAdapter));

    vm.prank(address(timelock));
    realPool.setRebalancer(address(newAdapter));
    vm.expectRevert(
      abi.encodeWithSelector(ILiquidityManager.PoolRebalancerMismatch.selector, POOL, address(newAdapter))
    );
    _fund(1e18);

    vm.expectEmit(true, true, true, true, address(manager));
    emit ILiquidityManager.AdapterReplaced(adapterId, address(adapter), address(newAdapter));
    vm.prank(address(timelock));
    manager.replaceAdapter(adapterId, address(newAdapter));

    // The replaced adapter stays in the history (it remains a reserve endpoint for reconciliation).
    assertTrue(manager.isRegisteredAdapter(address(adapter)), "replaced adapter stays registered");
    assertTrue(manager.isRegisteredAdapter(address(newAdapter)), "new adapter registered");
    address[] memory history = manager.getAdapterHistory();
    assertEq(history.length, 2);
    assertEq(history[0], address(adapter));
    assertEq(history[1], address(newAdapter));

    uint256 managerBefore = _balance(address(manager));
    uint256 poolBefore = _balance(POOL);
    vm.expectEmit(true, true, false, true, POOL);
    emit IRealLockReleaseTokenPool.LiquidityAdded(address(newAdapter), 3e18);
    _fund(3e18);
    vm.expectEmit(true, true, false, true, POOL);
    emit IRealLockReleaseTokenPool.LiquidityRemoved(address(newAdapter), 2e18);
    _recall(2e18);
    assertEq(_balance(address(manager)), managerBefore - 1e18);
    assertEq(_balance(POOL), poolBefore + 1e18);
    assertEq(_balance(address(newAdapter)), 0);
    assertEq(token.allowance(address(newAdapter), POOL), 0);

    // The old adapter lost its withdrawal power on the real pool.
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, address(adapter)));
    vm.prank(address(manager));
    adapter.recall(1e18);
  }

  function test_fork_replaceAdapter_rejectsAdapterBoundToAnotherManager() public {
    LiquidityManager otherManager =
      new LiquidityManager(SAHARA, ITokenAdminRegistry(address(registry)), address(timelock), guardian);
    CCIPPoolAdapter foreign = new CCIPPoolAdapter(address(otherManager), SAHARA, POOL);
    vm.prank(address(timelock));
    realPool.setRebalancer(address(foreign));

    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.AdapterBindingMismatch.selector, address(foreign)));
    vm.prank(address(timelock));
    manager.replaceAdapter(adapterId, address(foreign));
  }

  /// @dev Adapters (which cannot return tokens) and registered pools (which would bypass the funding budgets) are not
  /// migration destinations, including an adapter that has been replaced.
  function test_regression_fork_migrateReservesRejectsReserveEndpoints() public {
    CCIPPoolAdapter newAdapter = new CCIPPoolAdapter(address(manager), SAHARA, POOL);
    vm.startPrank(address(timelock));
    realPool.setRebalancer(address(newAdapter));
    manager.replaceAdapter(adapterId, address(newAdapter));

    address[5] memory rejected = [address(adapter), address(newAdapter), POOL, address(manager), SAHARA];
    for (uint256 i = 0; i < rejected.length; ++i) {
      vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.InvalidMigrationDestination.selector, rejected[i]));
      manager.migrateReserves(rejected[i], 1);
    }

    // type(uint256).max moves the whole balance at execution time.
    address successor = makeAddr("successorManager");
    uint256 reserves = _balance(address(manager));
    vm.expectEmit(true, false, false, true, address(manager));
    emit ILiquidityManager.ReservesMigrated(successor, reserves);
    manager.migrateReserves(successor, type(uint256).max);
    assertEq(_balance(successor), reserves);
    assertEq(_balance(address(manager)), 0);

    vm.expectRevert(ILiquidityManager.ZeroAmount.selector);
    manager.migrateReserves(successor, type(uint256).max);
    vm.stopPrank();
  }

  // ================================================================
  // │          End to end with the production scripts              │
  // ================================================================

  /// @dev The whole production path on the live pre-handover state: deploy with `Deploy.deploy`
  /// (script/Deploy.s.sol), the legacy multisig executes `HandoverPlan.legacyMultisigCalls`, and the Governance Safe
  /// schedules and executes `HandoverPlan.timelockBatch` (script/Handover.s.sol) through the Timelock.
  function test_regression_fork_scriptedDeployAndHandoverEndToEnd() public {
    vm.revertToState(liveSnapshot);
    Deploy.Deployment memory d = _deployWithScript();
    // Reverting restored this contract's storage too: point the fixture variables at the scripted deployment.
    timelock = d.timelock;
    manager = d.manager;
    controller = d.controller;
    adapter = d.adapter;
    adapterId = 0;

    assertEq(timelock.getMinDelay(), TIMELOCK_DELAY, "delay");
    assertEq(timelock.MINIMUM_DELAY(), SCRIPT_MINIMUM_DELAY, "minimum delay");
    assertEq(timelock.MAXIMUM_DELAY(), TIMELOCK_MAXIMUM_DELAY, "maximum delay");
    assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), governanceSafe), "Safe proposes");
    assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), governanceSafe), "Safe cancels");
    assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), address(controller)), "controller cancels");
    assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), guardian), "guardian has no direct cancel");
    assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), governanceSafe), "Safe executes");
    assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)), "no open execution");
    assertEq(manager.owner(), address(timelock));
    assertEq(manager.guardian(), guardian);
    assertEq(adapter.POOL(), POOL);

    // 1. The legacy multisig hands the rate limit admin to the controller and proposes the Timelock as pool owner and
    // registry administrator; the token (OZ single-step Ownable) moves at once.
    HandoverPlan.Params memory p = _handoverParams();
    HandoverPlan.preflight(p, POOL_OWNER, governanceSafe);
    // The full handover simulation passes and leaves no trace.
    HandoverPlan.simulate(p, POOL_OWNER, governanceSafe, keccak256("handover"));
    assertEq(pool.owner(), POOL_OWNER, "simulation reverted");
    assertEq(pool.getRebalancer(), PREVIOUS_REBALANCER, "simulation reverted");
    assertEq(token.owner(), POOL_OWNER, "simulation reverted");
    assertEq(manager.adapterCount(), 0, "simulation reverted");

    // The preflight rejects a controller that is not wired to this deployment (here: one from another deployment)
    // and a rate limit admin that is not the controller.
    HandoverPlan.Params memory wrong = _handoverParams();
    wrong.controller = address(
      new GuardianController(
        manager,
        new SaharaTimelock(
          TIMELOCK_DELAY,
          SCRIPT_MINIMUM_DELAY,
          TIMELOCK_MAXIMUM_DELAY,
          _one(governanceSafe),
          _one(governanceSafe),
          new address[](0)
        )
      )
    );
    wrong.spec.rateLimitAdmin = wrong.controller;
    vm.expectRevert(bytes("controller timelock"));
    this.externalPreflight(wrong);
    wrong = _handoverParams();
    wrong.spec.rateLimitAdmin = guardian;
    vm.expectRevert(bytes("rateLimitAdmin must be the controller"));
    this.externalPreflight(wrong);

    // A wrong cross-chain configuration is caught by the preflight, and independently by the simulation, before the
    // legacy multisig hands over the (single-step) token ownership.
    wrong = _handoverParams();
    wrong.spec.remoteToken = abi.encode(address(0xBAD));
    vm.expectRevert(bytes("pool remote token"));
    this.externalPreflight(wrong);
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.PoolRemoteTokenMismatch.selector, POOL));
    this.externalSimulate(wrong);
    wrong = _handoverParams();
    wrong.spec.remoteChainSelector = 1;
    vm.expectRevert(bytes("pool chains"));
    this.externalPreflight(wrong);
    wrong = _handoverParams();
    wrong.spec.remotePools[0] = abi.encode(address(0xBAD));
    vm.expectRevert(bytes("pool remote pools"));
    this.externalPreflight(wrong);
    assertEq(token.owner(), POOL_OWNER, "nothing moved");

    _executeLegacyMultisigCalls(p);

    // After the legacy calls the preflight no longer passes: it is meant to run before anything is signed.
    vm.expectRevert(bytes("registry admin"));
    this.externalPreflight(p);

    assertEq(pool.owner(), POOL_OWNER, "pool ownership is only pending");
    assertEq(pool.getRebalancer(), PREVIOUS_REBALANCER, "rebalancer unchanged");
    assertEq(pool.getRateLimitAdmin(), address(controller), "controller is rateLimitAdmin");
    _assertTokenConfig(POOL_OWNER, address(timelock), POOL);
    assertEq(token.owner(), address(timelock), "token owner");

    // 2. Until the Timelock batch executes, the previous rebalancer keeps operating the pool...
    uint256 poolBefore = _balance(POOL);
    uint256 rebalancerBefore = _balance(PREVIOUS_REBALANCER);
    vm.startPrank(PREVIOUS_REBALANCER);
    pool.withdrawLiquidity(1e18);
    assertEq(_balance(PREVIOUS_REBALANCER), rebalancerBefore + 1e18, "previous rebalancer withdraws");
    assertEq(_balance(POOL), poolBefore - 1e18);
    IERC20(SAHARA).approve(POOL, 1e18);
    pool.provideLiquidity(1e18);
    vm.stopPrank();
    assertEq(_balance(PREVIOUS_REBALANCER), rebalancerBefore, "previous rebalancer provides");
    assertEq(_balance(POOL), poolBefore);

    // ...the Guardian can already lock the pool down (recognised through the registry: nothing is registered)...
    assertEq(manager.adapterIdByPool(POOL), 0);
    vm.prank(guardian);
    controller.lockdown(POOL);
    _assertLockedDown();

    // ...and the Manager fails closed.
    vm.expectRevert(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, POOL_OWNER));
    manager.verifyHandover();
    _expectRegisterReverts(abi.encodeWithSelector(ILiquidityManager.PoolThresholdsNotSet.selector, POOL));
    uint256 unconfigured = vm.snapshotState();
    vm.startPrank(address(timelock));
    manager.setPoolSpec(POOL, p.spec);
    manager.setPoolThresholds(POOL, p.thresholds.minimum, p.thresholds.refillTrigger, p.thresholds.refillTarget);
    vm.stopPrank();
    _expectRegisterReverts(abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, POOL_OWNER));
    vm.revertToState(unconfigured);

    // 3. The Governance Safe schedules the Timelock batch; it executes only after the full delay.
    (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = HandoverPlan.timelockBatch(p);
    bytes32 salt = keccak256("handover");
    uint256 delay = timelock.getMinDelay();
    vm.prank(governanceSafe);
    timelock.scheduleBatch(targets, values, payloads, bytes32(0), salt, delay);
    bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), salt);

    vm.warp(block.timestamp + delay - 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        TimelockController.TimelockUnexpectedOperationState.selector,
        id,
        bytes32(1 << uint8(TimelockController.OperationState.Ready))
      )
    );
    vm.prank(governanceSafe);
    timelock.executeBatch(targets, values, payloads, bytes32(0), salt);

    vm.warp(block.timestamp + 1);
    vm.prank(governanceSafe);
    timelock.executeBatch(targets, values, payloads, bytes32(0), salt);
    assertTrue(timelock.isOperationDone(id));

    // 4. Every authority is with the new controls.
    assertEq(pool.owner(), address(timelock), "pool owner");
    assertEq(pool.getRebalancer(), address(adapter), "rebalancer");
    assertEq(pool.getRateLimitAdmin(), address(controller), "rateLimitAdmin");
    _assertTokenConfig(address(timelock), address(0), POOL);
    assertEq(token.owner(), address(timelock), "token owner");
    manager.verifyHandover();
    adapterId = manager.adapterIdByPool(POOL);
    assertEq(adapterId, 1);
    manager.verifyAdapter(adapterId);
    // The batch does not touch rate limits: the lockdown stays until governance restores them.
    _assertLockedDown();

    vm.startPrank(PREVIOUS_REBALANCER);
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, PREVIOUS_REBALANCER));
    pool.withdrawLiquidity(1);
    vm.expectRevert(abi.encodeWithSelector(IRealLockReleaseTokenPool.Unauthorized.selector, PREVIOUS_REBALANCER));
    pool.provideLiquidity(1);
    vm.stopPrank();

    // 5. fund and recall move exact amounts through the real pool.
    deal(SAHARA, address(manager), MANAGER_RESERVES);
    uint256 managerBefore = _balance(address(manager));
    poolBefore = _balance(POOL);
    _fund(10_000_000e18);
    assertEq(_balance(address(manager)), managerBefore - 10_000_000e18, "fund debits the Manager");
    assertEq(_balance(POOL), poolBefore + 10_000_000e18, "fund credits the pool");
    assertEq(_balance(address(adapter)), 0, "adapter retains nothing after fund");
    assertEq(token.allowance(address(adapter), POOL), 0, "no residual allowance");
    _recall(4_000_000e18);
    assertEq(_balance(address(manager)), managerBefore - 6_000_000e18, "recall credits the Manager");
    assertEq(_balance(POOL), poolBefore + 6_000_000e18, "recall debits the pool");
    assertEq(_balance(address(adapter)), 0, "adapter retains nothing after recall");

    // 6. The Guardian cancels an ordinary operation...
    bytes memory ordinary = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (2 * MAX_FUNDING_PER_CALL));
    bytes32 ordinarySalt = keccak256("raise per-call limit");
    bytes32 ordinaryId = _schedule(address(manager), ordinary, ordinarySalt);
    vm.expectEmit(true, true, false, false, address(controller));
    emit GuardianController.ProposalCancelled(ordinaryId, guardian);
    vm.prank(guardian);
    controller.cancel(address(manager), 0, ordinary, bytes32(0), ordinarySalt);
    assertFalse(timelock.isOperation(ordinaryId));

    // ...but not its own replacement, which the Governance Safe (proposer and canceller) can still withdraw.
    bytes memory replaceGuardian = abi.encodeCall(ILiquidityManager.setGuardian, (makeAddr("newGuardian")));
    bytes32 replaceSalt = keccak256("replace guardian");
    bytes32 replaceId = _schedule(address(manager), replaceGuardian, replaceSalt);
    vm.expectRevert(abi.encodeWithSelector(GuardianController.ProtectedOperation.selector, replaceId));
    vm.prank(guardian);
    controller.cancel(address(manager), 0, replaceGuardian, bytes32(0), replaceSalt);
    bytes32 cancellerRole = timelock.CANCELLER_ROLE();
    vm.expectRevert(
      abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, cancellerRole)
    );
    vm.prank(guardian);
    timelock.cancel(replaceId);
    assertTrue(timelock.isOperationPending(replaceId));

    vm.prank(governanceSafe);
    timelock.cancel(replaceId);
    assertFalse(timelock.isOperation(replaceId));
  }

  /// @dev `Deploy.deploy` predicts the controller address from `deployer`'s nonce. If `deployer` is not the account
  /// that performs the CREATEs (here an unrelated address while the Deploy instance deploys), the wiring check fails
  /// closed instead of leaving the Timelock without its controller canceller.
  function test_regression_fork_deployScriptFailsClosedOnMispredictedController() public {
    Deploy deployScript = new Deploy();
    Deploy.Config memory config = _deployConfig();
    vm.expectRevert(bytes("controller is not canceller"));
    deployScript.deploy(makeAddr("unrelatedDeployer"), config);
  }

  // ================================================================
  // │                            Fuzz                              │
  // ================================================================

  function testFuzz_fork_fundRecallRoundTripConservesBalances(uint256 amount) public {
    amount = bound(amount, 1, MAX_FUNDING_PER_CALL);
    uint256 managerBefore = _balance(address(manager));
    uint256 poolBefore = _balance(POOL);

    _fund(amount);
    assertEq(_balance(address(manager)), managerBefore - amount);
    assertEq(_balance(POOL), poolBefore + amount);
    assertEq(_balance(address(adapter)), 0);
    assertEq(token.allowance(address(adapter), POOL), 0);

    _recall(amount);
    assertEq(_balance(address(manager)), managerBefore);
    assertEq(_balance(POOL), poolBefore);
    assertEq(_balance(address(adapter)), 0);

    assertEq(manager.getAggregateFundingBudget().available, AGGREGATE_FUNDING_CAPACITY - amount);
    assertEq(manager.getPoolFundingBudget(POOL).available, POOL_FUNDING_CAPACITY - amount);
    assertEq(manager.getRecallBudget().available, RECALL_CAPACITY - amount);
  }

  function testFuzz_fork_recallRespectsPoolMinimum(uint256 minimum, uint256 amount) public {
    uint256 poolBalance = _balance(POOL);
    minimum = bound(minimum, POOL_MINIMUM, poolBalance + MAX_RECALL_PER_CALL);
    amount = bound(amount, 1, MAX_RECALL_PER_CALL);
    vm.prank(guardian);
    manager.raisePoolMinimum(POOL, minimum);

    if (amount > poolBalance || poolBalance - amount < minimum) {
      vm.expectRevert(
        abi.encodeWithSelector(ILiquidityManager.PoolMinimumBreached.selector, poolBalance, amount, minimum)
      );
      _recall(amount);
      assertEq(_balance(POOL), poolBalance);
    } else {
      uint256 managerBefore = _balance(address(manager));
      _recall(amount);
      assertEq(_balance(POOL), poolBalance - amount);
      assertGe(_balance(POOL), minimum);
      assertEq(_balance(address(manager)), managerBefore + amount);
    }
  }

  function testFuzz_fork_lockdownRejectsEveryTransfer(uint256 amount, uint256 elapsed) public {
    amount = bound(amount, 1, type(uint128).max);
    elapsed = bound(elapsed, 0, 3650 days);
    address onRamp = _onRamp();
    address offRamp = _offRamp();

    vm.prank(guardian);
    controller.lockdown(POOL);
    vm.warp(block.timestamp + elapsed);

    vm.expectRevert(
      abi.encodeWithSelector(IRealLockReleaseTokenPool.TokenMaxCapacityExceeded.selector, 0, amount, SAHARA)
    );
    vm.prank(onRamp);
    realPool.lockOrBurn(_lockOrBurnIn(amount));

    address receiver = makeAddr("bridgeReceiver");
    vm.expectRevert(
      abi.encodeWithSelector(IRealLockReleaseTokenPool.TokenMaxCapacityExceeded.selector, 0, amount, SAHARA)
    );
    vm.prank(offRamp);
    realPool.releaseOrMint(_releaseOrMintIn(receiver, amount));
  }

  function testFuzz_fork_restoredBucketRefillsLinearlyFromZero(uint128 capacity, uint128 rate, uint256 elapsed) public {
    capacity = uint128(bound(capacity, 1, type(uint128).max));
    rate = uint128(bound(rate, 0, capacity));
    elapsed = bound(elapsed, 0, 3650 days);

    vm.prank(guardian);
    controller.lockdown(POOL);

    ILockReleaseTokenPool.RateLimiterConfig memory restored = _ccipBucket(capacity, rate);
    vm.prank(address(timelock));
    pool.setChainRateLimiterConfig(remoteChainSelector, restored, restored);
    _assertBucketState(_outbound(), true, capacity, rate, 0);

    vm.warp(block.timestamp + elapsed);
    uint256 refilled = elapsed * uint256(rate);
    uint128 expected = refilled > capacity ? capacity : uint128(refilled);
    _assertBucketState(_outbound(), true, capacity, rate, expected);
    _assertBucketState(_inbound(), true, capacity, rate, expected);
  }

  // ================================================================
  // │                          Helpers                             │
  // ================================================================

  function _requireLivePreHandoverState() internal view {
    require(keccak256(bytes(pool.typeAndVersion())) == keccak256(bytes(POOL_VERSION)), "live: pool version");
    require(pool.getToken() == SAHARA, "live: pool token");
    require(pool.owner() == POOL_OWNER, "live: pool owner");
    require(pool.getRebalancer() == PREVIOUS_REBALANCER, "live: pool rebalancer");
    require(pool.getRateLimitAdmin() == PREVIOUS_REBALANCER, "live: pool rateLimitAdmin");
    require(pool.getRouter() == address(router), "live: pool router");
    uint64[] memory chains = pool.getSupportedChains();
    require(chains.length == 1 && chains[0] == remoteChainSelector, "live: pool chains");
    require(keccak256(pool.getRemoteToken(remoteChainSelector)) == keccak256(abi.encode(SAHARA)), "live: remote token");
    bytes[] memory remotePools = pool.getRemotePools(remoteChainSelector);
    require(remotePools.length == 1 && keccak256(remotePools[0]) == keccak256(abi.encode(POOL)), "live: remote pools");
    IRealLockReleaseTokenPool.TokenBucket memory outbound = _outbound();
    IRealLockReleaseTokenPool.TokenBucket memory inbound = _inbound();
    require(
      outbound.isEnabled && outbound.capacity == CCIP_CAPACITY && outbound.rate == CCIP_RATE, "live: outbound bucket"
    );
    require(inbound.isEnabled && inbound.capacity == CCIP_CAPACITY && inbound.rate == CCIP_RATE, "live: inbound bucket");
    require(registry.getPool(SAHARA) == POOL, "live: registry mapping");
    require(registry.getTokenConfig(SAHARA).administrator == POOL_OWNER, "live: registry administrator");
    require(registry.getTokenConfig(SAHARA).pendingAdministrator == address(0), "live: registry pending administrator");
    require(token.owner() == POOL_OWNER, "live: token owner");
    require(!token.paused(), "live: token paused");
    require(token.totalSupply() == TOTAL_SUPPLY, "live: token supply");
    require(token.balanceOf(POOL) >= POOL_MINIMUM + MAX_RECALL_PER_CALL, "live: pool inventory too low for tests");
  }

  function _deployStack() internal {
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
    manager = new LiquidityManager(SAHARA, ITokenAdminRegistry(address(registry)), address(timelock), guardian);
    controller = new GuardianController(manager, timelock);
    require(address(controller) == predictedController, "controller address prediction");
    adapter = new CCIPPoolAdapter(address(manager), SAHARA, POOL);
  }

  /// @dev Completed handover from the legacy multisig, in the order of script/Handover.s.sol: the multisig hands the
  /// rate limit admin to the controller and proposes the Timelock as pool owner (Chainlink Ownable2Step) and registry
  /// administrator (two-step) and transfers the token (OZ single-step); the Timelock accepts the pool, installs the
  /// adapter as sole rebalancer and accepts the registry administration.
  function _handover() internal {
    vm.startPrank(POOL_OWNER);
    realPool.setRateLimitAdmin(address(controller));
    realPool.transferOwnership(address(timelock));
    registry.transferAdminRole(SAHARA, address(timelock));
    token.transferOwnership(address(timelock));
    vm.stopPrank();

    vm.startPrank(address(timelock));
    realPool.acceptOwnership();
    realPool.setRebalancer(address(adapter));
    registry.acceptAdminRole(SAHARA);
    vm.stopPrank();
  }

  function _configureManager() internal {
    vm.startPrank(address(timelock));
    manager.setPoolSpec(POOL, _poolSpec());
    manager.setPoolThresholds(POOL, POOL_MINIMUM, POOL_REFILL_TRIGGER, POOL_REFILL_TARGET);
    manager.setPoolFundingBudget(POOL, POOL_FUNDING_CAPACITY, POOL_FUNDING_RATE);
    manager.setAggregateFundingBudget(AGGREGATE_FUNDING_CAPACITY, AGGREGATE_FUNDING_RATE);
    manager.setMaxFundingPerCall(MAX_FUNDING_PER_CALL);
    manager.setRecallLimits(MAX_RECALL_PER_CALL, RECALL_CAPACITY, RECALL_RATE);
    manager.setFundingOperator(fundingOperator, true);
    manager.setRecallOperator(recallOperator, true);
    vm.stopPrank();
  }

  /// @dev Handover parameters for the current stack variables, with the fixture's operating parameters.
  function externalPreflight(HandoverPlan.Params memory p) external view {
    HandoverPlan.preflight(p, POOL_OWNER, governanceSafe);
  }

  function externalSimulate(HandoverPlan.Params memory p) external {
    HandoverPlan.simulate(p, POOL_OWNER, governanceSafe, keccak256("handover"));
  }

  /// @dev The legacy multisig may stay on as the Governance Safe: roles are checked by duty, so the preflight and the
  /// simulation pass, and the real handover completes with it as proposer and executor.
  function test_regression_fork_legacyMultisigAsGovernanceSafe() public {
    vm.revertToState(liveSnapshot);
    governanceSafe = POOL_OWNER;
    Deploy.Deployment memory d = _deployWithScript();
    timelock = d.timelock;
    manager = d.manager;
    controller = d.controller;
    adapter = d.adapter;
    assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), POOL_OWNER));
    assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), POOL_OWNER));

    HandoverPlan.Params memory p = _handoverParams();
    HandoverPlan.preflight(p, POOL_OWNER, POOL_OWNER);
    HandoverPlan.simulate(p, POOL_OWNER, POOL_OWNER, keccak256("handover"));

    _executeLegacyMultisigCalls(p);
    (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = HandoverPlan.timelockBatch(p);
    uint256 delay = timelock.getMinDelay();
    vm.prank(POOL_OWNER);
    timelock.scheduleBatch(targets, values, payloads, bytes32(0), keccak256("handover"), delay);
    vm.warp(block.timestamp + delay);
    vm.prank(POOL_OWNER);
    timelock.executeBatch(targets, values, payloads, bytes32(0), keccak256("handover"));

    manager.verifyHandover();
    adapterId = manager.adapterIdByPool(POOL);
    manager.verifyAdapter(adapterId);
    deal(SAHARA, address(manager), 1e24);
    uint256 poolBefore = _balance(POOL);
    _fund(1e24);
    assertEq(_balance(POOL), poolBefore + 1e24);
  }

  function _one(address account) internal pure returns (address[] memory accounts) {
    accounts = new address[](1);
    accounts[0] = account;
  }

  function _handoverParams() internal view returns (HandoverPlan.Params memory p) {
    p.token = SAHARA;
    p.tokenAdminRegistry = address(registry);
    p.pool = POOL;
    p.timelock = address(timelock);
    p.manager = address(manager);
    p.controller = address(controller);
    p.adapter = address(adapter);
    p.fundingOperator = fundingOperator;
    p.recallOperator = recallOperator;
    p.spec = _poolSpec();
    p.thresholds = ILiquidityManager.PoolThresholds({
      minimum: POOL_MINIMUM,
      refillTrigger: POOL_REFILL_TRIGGER,
      refillTarget: POOL_REFILL_TARGET
    });
    p.maxFundingPerCall = MAX_FUNDING_PER_CALL;
    p.aggregateFundingCapacity = AGGREGATE_FUNDING_CAPACITY;
    p.aggregateFundingRate = AGGREGATE_FUNDING_RATE;
    p.poolFundingCapacity = POOL_FUNDING_CAPACITY;
    p.poolFundingRate = POOL_FUNDING_RATE;
    p.maxRecallPerCall = MAX_RECALL_PER_CALL;
    p.recallCapacity = RECALL_CAPACITY;
    p.recallRate = RECALL_RATE;
  }

  /// @dev Executes `HandoverPlan.legacyMultisigCalls` as the legacy multisig (a MultiSend makes each call with the
  /// Safe as msg.sender), bubbling up the revert data of a failing call.
  function _executeLegacyMultisigCalls(HandoverPlan.Params memory p) internal {
    HandoverPlan.Call[] memory calls = HandoverPlan.legacyMultisigCalls(p);
    assertEq(calls.length, 4, "legacy multisig calls");
    for (uint256 i = 0; i < calls.length; ++i) {
      vm.prank(POOL_OWNER);
      (bool ok, bytes memory returnData) = calls[i].target.call(calls[i].data);
      if (!ok) {
        assembly {
          revert(add(returnData, 32), mload(returnData))
        }
      }
    }
  }

  /// @dev Production Deploy configuration (script defaults: 72h delay within [48h, 30d], the Safe as executor).
  function _deployConfig() internal view returns (Deploy.Config memory) {
    return Deploy.Config({
      token: SAHARA,
      tokenAdminRegistry: address(registry),
      pool: POOL,
      governanceSafe: governanceSafe,
      guardianSafe: guardian,
      executor: governanceSafe,
      delay: TIMELOCK_DELAY,
      minimumDelay: SCRIPT_MINIMUM_DELAY,
      maximumDelay: TIMELOCK_MAXIMUM_DELAY
    });
  }

  /// @dev Runs `Deploy.deploy`, including its wiring checks. Called outside a broadcast, the Deploy instance itself
  /// performs the four CREATEs, so it is the deployer whose nonce the controller address is predicted from (a fresh
  /// deployer: a new contract starts at nonce 1).
  function _deployWithScript() internal returns (Deploy.Deployment memory d) {
    Deploy deployScript = new Deploy();
    address deployer = address(deployScript);
    assertEq(vm.getNonce(deployer), 1, "fresh deployer");
    d = deployScript.deploy(deployer, _deployConfig());
    assertEq(address(d.timelock), vm.computeCreateAddress(deployer, 1), "timelock address");
    assertEq(address(d.manager), vm.computeCreateAddress(deployer, 2), "manager address");
    assertEq(address(d.controller), vm.computeCreateAddress(deployer, 3), "controller address");
    assertEq(address(d.adapter), vm.computeCreateAddress(deployer, 4), "adapter address");
  }

  /// @dev `registerAdapter(adapter, POOL)` by the Timelock must fail with `revertData`.
  function _expectRegisterReverts(bytes memory revertData) internal {
    vm.expectRevert(revertData);
    vm.prank(address(timelock));
    manager.registerAdapter(address(adapter), POOL);
  }

  /// @dev Decodes the real registry's raw `getTokenConfig` return data and checks it, the interface view the Manager
  /// uses and `getPool` against the expected fields.
  function _assertTokenConfig(address administrator, address pendingAdministrator, address tokenPool) internal view {
    (bool ok, bytes memory raw) =
      address(registry).staticcall(abi.encodeWithSelector(ITokenAdminRegistry.getTokenConfig.selector, SAHARA));
    assertTrue(ok, "getTokenConfig");
    assertEq(raw.length, 96, "getTokenConfig returns a static (address, address, address) tuple");
    (address rawAdministrator, address rawPendingAdministrator, address rawTokenPool) =
      abi.decode(raw, (address, address, address));
    assertEq(rawAdministrator, administrator, "raw administrator");
    assertEq(rawPendingAdministrator, pendingAdministrator, "raw pendingAdministrator");
    assertEq(rawTokenPool, tokenPool, "raw tokenPool");

    ITokenAdminRegistry.TokenConfig memory config = ITokenAdminRegistry(address(registry)).getTokenConfig(SAHARA);
    assertEq(config.administrator, administrator, "administrator");
    assertEq(config.pendingAdministrator, pendingAdministrator, "pendingAdministrator");
    assertEq(config.tokenPool, tokenPool, "tokenPool");
    assertEq(ITokenAdminRegistry(address(registry)).getPool(SAHARA), tokenPool, "getPool");
  }

  function _poolSpec() internal view returns (ILiquidityManager.PoolSpec memory spec) {
    spec.typeAndVersion = POOL_VERSION;
    spec.router = address(router);
    spec.remoteChainSelector = remoteChainSelector;
    spec.remoteToken = abi.encode(SAHARA);
    spec.remotePools = new bytes[](1);
    spec.remotePools[0] = abi.encode(POOL);
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

  function _schedule(address target, bytes memory data, bytes32 salt) internal returns (bytes32) {
    vm.prank(governanceSafe);
    timelock.schedule(target, 0, data, bytes32(0), salt, TIMELOCK_DELAY);
    return timelock.hashOperation(target, 0, data, bytes32(0), salt);
  }

  /// @dev Both `verifyAdapter` and `fund` must fail with `revertData`.
  function _expectFundBlocked(bytes memory revertData) internal {
    vm.expectRevert(revertData);
    manager.verifyAdapter(adapterId);
    vm.expectRevert(revertData);
    _fund(1e18);
  }

  function _expectSpecRejected(ILiquidityManager.PoolSpec memory spec, bytes memory revertData) internal {
    vm.prank(address(timelock));
    manager.setPoolSpec(POOL, spec);
    _expectFundBlocked(revertData);
  }

  function _chainUpdate(uint64 selector, bytes memory remoteToken, bytes memory remotePool)
    internal
    pure
    returns (IRealLockReleaseTokenPool.ChainUpdate memory update)
  {
    update.remoteChainSelector = selector;
    update.remotePoolAddresses = new bytes[](1);
    update.remotePoolAddresses[0] = remotePool;
    update.remoteTokenAddress = remoteToken;
    update.outboundRateLimiterConfig = _ccipBucket(CCIP_CAPACITY, CCIP_RATE);
    update.inboundRateLimiterConfig = _ccipBucket(CCIP_CAPACITY, CCIP_RATE);
  }

  function _onRamp() internal view returns (address onRamp) {
    onRamp = router.getOnRamp(remoteChainSelector);
    require(onRamp != address(0), "no onRamp for the counterpart chain");
  }

  /// @dev Any offRamp the Router authorises for the counterpart chain (the latest registered one).
  function _offRamp() internal view returns (address offRamp) {
    IRealRouter.OffRamp[] memory offRamps = router.getOffRamps();
    for (uint256 i = offRamps.length; i > 0; --i) {
      if (offRamps[i - 1].sourceChainSelector == remoteChainSelector) {
        offRamp = offRamps[i - 1].offRamp;
        break;
      }
    }
    require(offRamp != address(0) && router.isOffRamp(remoteChainSelector, offRamp), "no offRamp");
  }

  function _lockOrBurnIn(uint256 amount) internal view returns (IRealLockReleaseTokenPool.LockOrBurnInV1 memory) {
    return IRealLockReleaseTokenPool.LockOrBurnInV1({
      receiver: abi.encode(attacker),
      remoteChainSelector: remoteChainSelector,
      originalSender: attacker,
      amount: amount,
      localToken: SAHARA
    });
  }

  function _releaseOrMintIn(address receiver, uint256 amount)
    internal
    view
    returns (IRealLockReleaseTokenPool.ReleaseOrMintInV1 memory)
  {
    return IRealLockReleaseTokenPool.ReleaseOrMintInV1({
      originalSender: abi.encode(attacker),
      remoteChainSelector: remoteChainSelector,
      receiver: receiver,
      sourceDenominatedAmount: amount,
      localToken: SAHARA,
      sourcePoolAddress: abi.encode(POOL),
      sourcePoolData: abi.encode(uint256(18)),
      offchainTokenData: ""
    });
  }

  function _outbound() internal view returns (IRealLockReleaseTokenPool.TokenBucket memory) {
    return realPool.getCurrentOutboundRateLimiterState(remoteChainSelector);
  }

  function _inbound() internal view returns (IRealLockReleaseTokenPool.TokenBucket memory) {
    return realPool.getCurrentInboundRateLimiterState(remoteChainSelector);
  }

  function _assertLockedDown() internal view {
    _assertBucketState(_outbound(), true, 0, 0, 0);
    _assertBucketState(_inbound(), true, 0, 0, 0);
  }

  function _assertBucket(
    IRealLockReleaseTokenPool.TokenBucket memory bucket,
    bool isEnabled,
    uint128 capacity,
    uint128 rate
  ) internal pure {
    assertEq(bucket.isEnabled, isEnabled, "bucket enabled");
    assertEq(bucket.capacity, capacity, "bucket capacity");
    assertEq(bucket.rate, rate, "bucket rate");
  }

  function _assertBucketState(
    IRealLockReleaseTokenPool.TokenBucket memory bucket,
    bool isEnabled,
    uint128 capacity,
    uint128 rate,
    uint128 tokens
  ) internal pure {
    _assertBucket(bucket, isEnabled, capacity, rate);
    assertEq(bucket.tokens, tokens, "bucket tokens");
  }

  function _zeroBucket() internal pure returns (ILockReleaseTokenPool.RateLimiterConfig memory) {
    return ILockReleaseTokenPool.RateLimiterConfig({isEnabled: true, capacity: 0, rate: 0});
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

  /// @dev Whether the runtime code contains `PUSH4 selector` (how the Solidity dispatcher matches selectors).
  function _codeHasSelector(address target, bytes4 selector) internal view returns (bool) {
    bytes memory code = target.code;
    for (uint256 i = 0; i + 4 < code.length; ++i) {
      if (
        code[i] == 0x63 && code[i + 1] == selector[0] && code[i + 2] == selector[1] && code[i + 3] == selector[2]
          && code[i + 4] == selector[3]
      ) return true;
    }
    return false;
  }
}

/// @notice Ethereum: the counterpart is BSC.
/// forge-config: default.fuzz.runs = 64
contract ForkLiquidityEthTest is ForkLiquidityBase {
  function _chainConfig() internal view override returns (ChainConfig memory) {
    return ChainConfig({
      rpcUrl: vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com")),
      chainId: 1,
      registry: 0xb22764f98dD05c789929716D677382Df22C05Cb6,
      router: 0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D,
      localChainSelector: ETH_CHAIN_SELECTOR,
      remoteChainSelector: BSC_CHAIN_SELECTOR
    });
  }
}

/// @notice BSC: the counterpart is Ethereum.
/// forge-config: default.fuzz.runs = 64
contract ForkLiquidityBscTest is ForkLiquidityBase {
  function _chainConfig() internal view override returns (ChainConfig memory) {
    return ChainConfig({
      rpcUrl: vm.envOr("BSC_RPC_URL", string("https://bsc-rpc.publicnode.com")),
      chainId: 56,
      registry: 0x736Fd8660c443547a85e4Eaf70A49C1b7Bb008fc,
      router: 0x34B03Cb9086d7D758AC55af71584F81A598759FE,
      localChainSelector: BSC_CHAIN_SELECTOR,
      remoteChainSelector: ETH_CHAIN_SELECTOR
    });
  }
}

/// @notice Both chains at once: the two pools are each other's sole counterpart and the token is identical.
contract ForkCrossChainTest is Test {
  address internal constant SAHARA = 0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111;
  address internal constant POOL = 0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4;
  uint64 internal constant ETH_CHAIN_SELECTOR = 5009297550715157269;
  uint64 internal constant BSC_CHAIN_SELECTOR = 11344663589394136015;
  uint256 internal constant TOTAL_SUPPLY = 10_000_000_000e18;

  uint256 internal ethFork;
  uint256 internal bscFork;

  function setUp() public {
    if (!vm.envOr("RUN_FORK_TESTS", false)) {
      vm.skip(true);
      return;
    }
    ethFork = vm.createFork(vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com")));
    bscFork = vm.createFork(vm.envOr("BSC_RPC_URL", string("https://bsc-rpc.publicnode.com")));
  }

  function test_fork_crossChain_poolsAreMutualSoleCounterparts() public {
    _assertCounterpart(ethFork, 1, BSC_CHAIN_SELECTOR);
    _assertCounterpart(bscFork, 56, ETH_CHAIN_SELECTOR);
  }

  function _assertCounterpart(uint256 forkId, uint256 chainId, uint64 remoteSelector) internal {
    vm.selectFork(forkId);
    assertEq(block.chainid, chainId);
    ILockReleaseTokenPool pool = ILockReleaseTokenPool(POOL);
    assertEq(pool.typeAndVersion(), "LockReleaseTokenPool 1.6.3-dev");
    assertEq(pool.getToken(), SAHARA);
    uint64[] memory chains = pool.getSupportedChains();
    assertEq(chains.length, 1);
    assertEq(chains[0], remoteSelector);
    assertEq(pool.getRemoteToken(remoteSelector), abi.encode(SAHARA));
    bytes[] memory remotePools = pool.getRemotePools(remoteSelector);
    assertEq(remotePools.length, 1);
    assertEq(remotePools[0], abi.encode(POOL));
    assertEq(IRealLockReleaseTokenPool(POOL).getTokenDecimals(), 18);
    IRealSahara token = IRealSahara(SAHARA);
    assertEq(token.totalSupply(), TOTAL_SUPPLY);
    assertEq(token.decimals(), 18);
    assertGt(POOL.code.length, 0);
    assertGt(SAHARA.code.length, 0);
  }
}
