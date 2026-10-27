// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ILiquidityAdapter} from "./interfaces/ILiquidityAdapter.sol";
import {ILiquidityManager} from "./interfaces/ILiquidityManager.sol";
import {ILockReleaseTokenPool} from "./interfaces/ILockReleaseTokenPool.sol";
import {IOwnable} from "./interfaces/IOwnable.sol";
import {ITokenAdminRegistry} from "./interfaces/ITokenAdminRegistry.sol";
import {TokenBucket} from "./libraries/TokenBucket.sol";

/// @title LiquidityManager
/// @notice Holds the unallocated SAHARA reserves of one chain and moves them to and from approved CCIP pools through
/// their adapters, within on-chain limits.
/// - Funding Operators fund registered pools within the per-call limit and the aggregate and per-pool budgets.
/// - Recall Operators recall pool inventory to this contract within the recall limits and above the pool minimum.
/// - The Guardian can only restrict: pause, suspend operators, disable adapters, lower limits and budgets, raise pool
///   minimums and revoke migration approvals.
/// - The owner (the Timelock) configures everything else, including restoring what the Guardian restricted, replacing
///   the Guardian and migrating reserves.
/// @dev Non-upgradeable. Every successful `fund`/`recall` moves exactly `amount` between this contract and the pool,
/// leaves the adapter balance unchanged and leaves zero adapter-to-pool allowance; otherwise it reverts.
contract LiquidityManager is ILiquidityManager, Ownable2Step, ReentrancyGuard {
  using SafeERC20 for IERC20;
  using TokenBucket for TokenBucket.Bucket;

  struct PoolState {
    bool specSet;
    bool thresholdsSet;
    /// @dev Non-zero while a migration is approved: the pool may be funded while the TokenAdminRegistry still maps
    /// the token to this source pool.
    address migrationSourcePool;
    PoolSpec spec;
    PoolThresholds thresholds;
    TokenBucket.Bucket fundingBudget;
  }

  /// @notice The reserve token (SAHARA).
  address public immutable TOKEN;
  /// @notice CCIP TokenAdminRegistry; routine funding requires it to map `TOKEN` to the funded pool.
  ITokenAdminRegistry public immutable TOKEN_ADMIN_REGISTRY;

  address public guardian;
  mapping(address operator => bool) public isFundingOperator;
  mapping(address operator => bool) public isRecallOperator;

  bool public fundingPaused;
  bool public recallPaused;

  uint256 public maxFundingPerCall;
  uint256 public maxRecallPerCall;
  TokenBucket.Bucket internal s_aggregateFundingBudget;
  TokenBucket.Bucket internal s_recallBudget;

  /// @notice Number of registered adapters; ids run from 1 to `adapterCount` and are never reused.
  uint256 public adapterCount;
  mapping(uint256 adapterId => Adapter) internal s_adapters;
  /// @notice Adapter id registered for a pool, or 0. A pool has at most one id, so aliases cannot multiply budgets.
  mapping(address pool => uint256 adapterId) public adapterIdByPool;
  mapping(address pool => PoolState) internal s_pools;
  /// @notice Whether an address has ever been registered as an adapter, including replaced adapters.
  mapping(address adapter => bool) public isRegisteredAdapter;
  /// @dev Every adapter ever registered, in registration order; replaced adapters stay listed for reconciliation.
  address[] internal s_adapterHistory;

  modifier onlyGuardian() {
    if (msg.sender != guardian) revert CallerNotGuardian(msg.sender);
    emit GuardianAction(msg.sender, msg.sig);
    _;
  }

  /// @param token The reserve token (SAHARA).
  /// @param tokenAdminRegistry The CCIP TokenAdminRegistry of this chain.
  /// @param initialOwner The Timelock.
  /// @param initialGuardian The Guardian Safe, or address(0) for none.
  /// @dev All limits and budgets start at zero, so nothing can be funded or recalled until the owner configures them.
  constructor(address token, ITokenAdminRegistry tokenAdminRegistry, address initialOwner, address initialGuardian)
    Ownable(initialOwner)
  {
    if (token == address(0) || address(tokenAdminRegistry) == address(0)) revert ZeroAddress();
    TOKEN = token;
    TOKEN_ADMIN_REGISTRY = tokenAdminRegistry;
    guardian = initialGuardian;
    emit GuardianSet(address(0), initialGuardian);
  }

  // ================================================================
  // │                         Operations                           │
  // ================================================================

  /// @notice Moves `amount` reserves into the pool of `adapterId`: Manager -> adapter -> `provideLiquidity`.
  function fund(uint256 adapterId, uint256 amount) external nonReentrant {
    if (!isFundingOperator[msg.sender]) revert CallerNotFundingOperator(msg.sender);
    if (fundingPaused) revert FundingIsPaused();
    Adapter memory entry = _getAdapter(adapterId);
    if (!entry.fundingEnabled) revert FundingDisabled(adapterId);
    if (amount == 0) revert ZeroAmount();
    if (amount > maxFundingPerCall) revert ExceedsPerCallLimit(amount, maxFundingPerCall);

    _verifyPool(entry.adapter, entry.pool);

    s_aggregateFundingBudget.consume(amount);
    s_pools[entry.pool].fundingBudget.consume(amount);

    IERC20 token = IERC20(TOKEN);
    uint256 allowance = token.allowance(entry.adapter, entry.pool);
    if (allowance != 0) revert NonZeroAllowance(allowance);

    uint256 managerBefore = token.balanceOf(address(this));
    uint256 adapterBefore = token.balanceOf(entry.adapter);
    uint256 poolBefore = token.balanceOf(entry.pool);

    token.safeTransfer(entry.adapter, amount);
    ILiquidityAdapter(entry.adapter).fund(amount);

    if (
      token.balanceOf(address(this)) != managerBefore - amount || token.balanceOf(entry.adapter) != adapterBefore
        || token.balanceOf(entry.pool) != poolBefore + amount
    ) revert BalanceCheckFailed();
    allowance = token.allowance(entry.adapter, entry.pool);
    if (allowance != 0) revert NonZeroAllowance(allowance);

    emit Funded(adapterId, entry.pool, msg.sender, entry.adapter, amount);
  }

  /// @notice Returns `amount` of pool inventory to this contract: `withdrawLiquidity` -> adapter -> Manager.
  function recall(uint256 adapterId, uint256 amount) external nonReentrant {
    if (!isRecallOperator[msg.sender]) revert CallerNotRecallOperator(msg.sender);
    if (recallPaused) revert RecallIsPaused();
    Adapter memory entry = _getAdapter(adapterId);
    if (!entry.recallEnabled) revert RecallDisabled(adapterId);
    if (amount == 0) revert ZeroAmount();
    if (amount > maxRecallPerCall) revert ExceedsPerCallLimit(amount, maxRecallPerCall);

    s_recallBudget.consume(amount);

    IERC20 token = IERC20(TOKEN);
    uint256 poolBefore = token.balanceOf(entry.pool);
    uint256 minimum = s_pools[entry.pool].thresholds.minimum;
    if (amount > poolBefore || poolBefore - amount < minimum) {
      revert PoolMinimumBreached(poolBefore, amount, minimum);
    }
    uint256 managerBefore = token.balanceOf(address(this));
    uint256 adapterBefore = token.balanceOf(entry.adapter);

    ILiquidityAdapter(entry.adapter).recall(amount);

    if (
      token.balanceOf(address(this)) != managerBefore + amount || token.balanceOf(entry.adapter) != adapterBefore
        || token.balanceOf(entry.pool) != poolBefore - amount
    ) revert BalanceCheckFailed();

    emit Recalled(adapterId, entry.pool, msg.sender, entry.adapter, amount);
  }

  // ================================================================
  // │                   Guardian (restrict only)                   │
  // ================================================================

  function pauseFunding() external onlyGuardian {
    fundingPaused = true;
    emit FundingPausedSet(true);
  }

  function pauseRecall() external onlyGuardian {
    recallPaused = true;
    emit RecallPausedSet(true);
  }

  function suspendFundingOperator(address operator) external onlyGuardian {
    isFundingOperator[operator] = false;
    emit FundingOperatorSet(operator, false);
  }

  function suspendRecallOperator(address operator) external onlyGuardian {
    isRecallOperator[operator] = false;
    emit RecallOperatorSet(operator, false);
  }

  /// @notice Disables funding and/or recall for an adapter. Re-enabling requires the owner.
  function restrictAdapter(uint256 adapterId, bool disableFunding, bool disableRecall) external onlyGuardian {
    Adapter storage entry = _getAdapter(adapterId);
    if (disableFunding) entry.fundingEnabled = false;
    if (disableRecall) entry.recallEnabled = false;
    emit AdapterStatusSet(adapterId, entry.fundingEnabled, entry.recallEnabled);
  }

  function revokePoolMigrationApproval(address pool) external onlyGuardian {
    s_pools[pool].migrationSourcePool = address(0);
    emit PoolMigrationApprovalSet(pool, address(0));
  }

  function reduceMaxFundingPerCall(uint256 newMaxFundingPerCall) external onlyGuardian {
    if (newMaxFundingPerCall > maxFundingPerCall) revert NotARestriction();
    maxFundingPerCall = newMaxFundingPerCall;
    emit MaxFundingPerCallSet(newMaxFundingPerCall);
  }

  /// @notice Lowers the aggregate funding budget. Consumed budget is not restored.
  function reduceAggregateFundingBudget(uint256 capacity, uint256 rate) external onlyGuardian {
    _reduceBucket(s_aggregateFundingBudget, capacity, rate);
    emit AggregateFundingBudgetSet(capacity, rate);
  }

  /// @notice Lowers the funding budget of `pool`. Consumed budget is not restored.
  function reducePoolFundingBudget(address pool, uint256 capacity, uint256 rate) external onlyGuardian {
    _reduceBucket(s_pools[pool].fundingBudget, capacity, rate);
    emit PoolFundingBudgetSet(pool, capacity, rate);
  }

  /// @notice Lowers the recall limits. Consumed budget is not restored.
  function reduceRecallLimits(uint256 newMaxRecallPerCall, uint256 capacity, uint256 rate) external onlyGuardian {
    if (newMaxRecallPerCall > maxRecallPerCall) revert NotARestriction();
    _reduceBucket(s_recallBudget, capacity, rate);
    maxRecallPerCall = newMaxRecallPerCall;
    emit RecallLimitsSet(newMaxRecallPerCall, capacity, rate);
  }

  /// @notice Raises the inventory `pool` must keep after a recall.
  function raisePoolMinimum(address pool, uint256 minimum) external onlyGuardian {
    PoolThresholds storage thresholds = s_pools[pool].thresholds;
    if (minimum < thresholds.minimum) revert NotARestriction();
    thresholds.minimum = minimum;
    emit PoolThresholdsSet(pool, minimum, thresholds.refillTrigger, thresholds.refillTarget);
  }

  // ================================================================
  // │                     Owner (the Timelock)                     │
  // ================================================================

  /// @inheritdoc ILiquidityManager
  /// @dev Deliberately free of pause and guardian-controlled checks so recovery always executes.
  function setGuardian(address newGuardian) external onlyOwner {
    emit GuardianSet(guardian, newGuardian);
    guardian = newGuardian;
  }

  /// @notice Grants or revokes the Funding Operator role. Operator roles are mutually exclusive and cannot be granted
  /// to the Guardian.
  function setFundingOperator(address operator, bool enabled) external onlyOwner {
    if (operator == address(0)) revert ZeroAddress();
    if (enabled) {
      if (isRecallOperator[operator]) revert OperatorRolesMustBeSeparate(operator);
      if (operator == guardian) revert OperatorCannotBeGuardian(operator);
    }
    isFundingOperator[operator] = enabled;
    emit FundingOperatorSet(operator, enabled);
  }

  /// @notice Grants or revokes the Recall Operator role. Operator roles are mutually exclusive and cannot be granted
  /// to the Guardian.
  function setRecallOperator(address operator, bool enabled) external onlyOwner {
    if (operator == address(0)) revert ZeroAddress();
    if (enabled) {
      if (isFundingOperator[operator]) revert OperatorRolesMustBeSeparate(operator);
      if (operator == guardian) revert OperatorCannotBeGuardian(operator);
    }
    isRecallOperator[operator] = enabled;
    emit RecallOperatorSet(operator, enabled);
  }

  function setFundingPaused(bool paused) external onlyOwner {
    fundingPaused = paused;
    emit FundingPausedSet(paused);
  }

  function setRecallPaused(bool paused) external onlyOwner {
    recallPaused = paused;
    emit RecallPausedSet(paused);
  }

  function setMaxFundingPerCall(uint256 newMaxFundingPerCall) external onlyOwner {
    maxFundingPerCall = newMaxFundingPerCall;
    emit MaxFundingPerCallSet(newMaxFundingPerCall);
  }

  /// @notice Sets the aggregate funding budget across all pools. Raising it does not restore consumed budget.
  function setAggregateFundingBudget(uint256 capacity, uint256 rate) external onlyOwner {
    s_aggregateFundingBudget.setConfig(capacity, rate);
    emit AggregateFundingBudgetSet(capacity, rate);
  }

  /// @notice Sets the funding budget of `pool`. Raising it does not restore consumed budget.
  function setPoolFundingBudget(address pool, uint256 capacity, uint256 rate) external onlyOwner {
    if (pool == address(0)) revert ZeroAddress();
    s_pools[pool].fundingBudget.setConfig(capacity, rate);
    emit PoolFundingBudgetSet(pool, capacity, rate);
  }

  /// @notice Sets the per-call recall limit and the recall budget. Raising it does not restore consumed budget.
  function setRecallLimits(uint256 newMaxRecallPerCall, uint256 capacity, uint256 rate) external onlyOwner {
    s_recallBudget.setConfig(capacity, rate);
    maxRecallPerCall = newMaxRecallPerCall;
    emit RecallLimitsSet(newMaxRecallPerCall, capacity, rate);
  }

  /// @notice Sets the configuration `pool` must match before an adapter is registered for it or it is funded.
  function setPoolSpec(address pool, PoolSpec calldata spec) external onlyOwner {
    if (pool == address(0)) revert ZeroAddress();
    _validatePoolSpec(spec);
    PoolState storage state = s_pools[pool];
    state.spec = spec;
    state.specSet = true;
    emit PoolSpecSet(pool, spec);
  }

  /// @notice Sets the inventory thresholds of `pool`. Required before an adapter can be registered for it.
  function setPoolThresholds(address pool, uint256 minimum, uint256 refillTrigger, uint256 refillTarget)
    external
    onlyOwner
  {
    if (pool == address(0)) revert ZeroAddress();
    if (minimum > refillTrigger || refillTrigger > refillTarget) {
      revert InvalidThresholds(minimum, refillTrigger, refillTarget);
    }
    PoolState storage state = s_pools[pool];
    state.thresholds = PoolThresholds(minimum, refillTrigger, refillTarget);
    state.thresholdsSet = true;
    emit PoolThresholdsSet(pool, minimum, refillTrigger, refillTarget);
  }

  /// @notice Approves funding `pool` while the TokenAdminRegistry still maps the token to `sourcePool`, the pool it
  /// replaces. This is the migration path for pre-funding a replacement pool; routine funding requires the registry
  /// mapping. The approval has no effect once the registry maps the token to any third pool. address(0) revokes it.
  function setPoolMigrationApproval(address pool, address sourcePool) external onlyOwner {
    if (pool == address(0)) revert ZeroAddress();
    if (sourcePool == pool) revert InvalidEndpoint(sourcePool);
    s_pools[pool].migrationSourcePool = sourcePool;
    emit PoolMigrationApprovalSet(pool, sourcePool);
  }

  /// @notice Registers `adapter` for `pool` and enables it. The pool must already have a spec and thresholds, match
  /// the spec, and the token and registry authorities must already be with the owner.
  function registerAdapter(address adapter, address pool) external onlyOwner returns (uint256 adapterId) {
    _validateEndpoints(adapter, pool);
    uint256 existingId = adapterIdByPool[pool];
    if (existingId != 0) revert PoolAlreadyRegistered(pool, existingId);
    if (!s_pools[pool].thresholdsSet) revert PoolThresholdsNotSet(pool);

    _verifyHandover();
    _verifyPool(adapter, pool);

    adapterId = ++adapterCount;
    s_adapters[adapterId] = Adapter({adapter: adapter, pool: pool, fundingEnabled: true, recallEnabled: true});
    adapterIdByPool[pool] = adapterId;
    _recordAdapter(adapter);

    emit AdapterRegistered(adapterId, adapter, pool);
    emit AdapterStatusSet(adapterId, true, true);
  }

  /// @notice Replaces the adapter of `adapterId`. The pool is unchanged; the adapter's funding and recall status and
  /// the pool's budgets carry over.
  /// @dev Runs the pool checks but not the launch-time handover check, so an emergency replacement does not depend
  /// on token ownership or registry administration.
  function replaceAdapter(uint256 adapterId, address newAdapter) external onlyOwner {
    Adapter storage entry = _getAdapter(adapterId);
    address previousAdapter = entry.adapter;
    if (newAdapter == previousAdapter) revert AdapterUnchanged(newAdapter);
    _validateEndpoints(newAdapter, entry.pool);

    _verifyPool(newAdapter, entry.pool);

    entry.adapter = newAdapter;
    _recordAdapter(newAdapter);
    emit AdapterReplaced(adapterId, previousAdapter, newAdapter);
  }

  /// @notice Sets the funding and recall status of `adapterId`, e.g. to reactivate or retire it.
  function setAdapterStatus(uint256 adapterId, bool fundingEnabled, bool recallEnabled) external onlyOwner {
    Adapter storage entry = _getAdapter(adapterId);
    entry.fundingEnabled = fundingEnabled;
    entry.recallEnabled = recallEnabled;
    emit AdapterStatusSet(adapterId, fundingEnabled, recallEnabled);
  }

  /// @notice Moves reserves out of this contract, e.g. to a replacement Manager. `type(uint256).max` moves the whole
  /// balance at execution time.
  /// @dev Rejects destinations that cannot return tokens (adapters and other contracts bound to this Manager, such as
  /// the GuardianController) and pools known to this Manager or the TokenAdminRegistry (which would bypass the
  /// funding budgets).
  function migrateReserves(address to, uint256 amount) external onlyOwner nonReentrant {
    if (to == address(0)) revert ZeroAddress();
    if (to == address(this) || to == TOKEN || isRegisteredAdapter[to] || _isKnownPool(to) || _isBoundToThisManager(to))
    {
      revert InvalidMigrationDestination(to);
    }
    if (amount == type(uint256).max) amount = IERC20(TOKEN).balanceOf(address(this));
    if (amount == 0) revert ZeroAmount();
    IERC20(TOKEN).safeTransfer(to, amount);
    emit ReservesMigrated(to, amount);
  }

  /// @notice Recovers a token other than the reserve token sent to this contract by mistake.
  function recoverToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
    if (token == TOKEN) revert CannotRecoverReserveToken();
    if (to == address(0)) revert ZeroAddress();
    IERC20(token).safeTransfer(to, amount);
    emit TokenRecovered(token, to, amount);
  }

  /// @notice Disabled: the Manager must always have an owner.
  function renounceOwnership() public pure override {
    revert OwnershipCannotBeRenounced();
  }

  // ================================================================
  // │                           Views                              │
  // ================================================================

  function getAdapter(uint256 adapterId) external view returns (Adapter memory) {
    return _getAdapter(adapterId);
  }

  /// @notice Every adapter ever registered, including replaced ones, which remain reserve endpoints.
  function getAdapterHistory() external view returns (address[] memory) {
    return s_adapterHistory;
  }

  function getPoolSpec(address pool) external view returns (PoolSpec memory spec, bool isSet) {
    PoolState storage state = s_pools[pool];
    return (state.spec, state.specSet);
  }

  function getPoolThresholds(address pool) external view returns (PoolThresholds memory thresholds, bool isSet) {
    PoolState storage state = s_pools[pool];
    return (state.thresholds, state.thresholdsSet);
  }

  /// @notice The registry pool under which funding `pool` is approved for migration, or address(0) if none.
  function getPoolMigrationSource(address pool) external view returns (address) {
    return s_pools[pool].migrationSourcePool;
  }

  function getAggregateFundingBudget() external view returns (BudgetState memory) {
    return _budgetState(s_aggregateFundingBudget);
  }

  function getPoolFundingBudget(address pool) external view returns (BudgetState memory) {
    return _budgetState(s_pools[pool].fundingBudget);
  }

  function getRecallBudget() external view returns (BudgetState memory) {
    return _budgetState(s_recallBudget);
  }

  /// @notice Reverts with the first mismatch if `adapterId` would fail the pre-funding pool checks.
  function verifyAdapter(uint256 adapterId) external view {
    Adapter storage entry = _getAdapter(adapterId);
    _verifyPool(entry.adapter, entry.pool);
  }

  /// @notice Reverts unless the token's TokenAdminRegistry administration and the token ownership are held by this
  /// contract's owner (the Timelock), with no registry administration transfer pending.
  function verifyHandover() external view {
    _verifyHandover();
  }

  // ================================================================
  // │                          Internal                            │
  // ================================================================

  function _getAdapter(uint256 adapterId) internal view returns (Adapter storage entry) {
    if (adapterId == 0 || adapterId > adapterCount) revert UnknownAdapter(adapterId);
    return s_adapters[adapterId];
  }

  function _isKnownPool(address account) internal view returns (bool) {
    PoolState storage state = s_pools[account];
    return adapterIdByPool[account] != 0 || state.specSet || state.migrationSourcePool != address(0)
      || TOKEN_ADMIN_REGISTRY.getPool(TOKEN) == account;
  }

  /// @dev Whether `account` is a contract reporting this Manager as its `MANAGER()` (adapters, the controller).
  function _isBoundToThisManager(address account) internal view returns (bool) {
    if (account.code.length == 0) return false;
    (bool success, bytes memory data) = account.staticcall(abi.encodeWithSelector(ILiquidityAdapter.MANAGER.selector));
    return success && data.length >= 32 && abi.decode(data, (uint256)) == uint256(uint160(address(this)));
  }

  function _recordAdapter(address adapter) internal {
    if (isRegisteredAdapter[adapter]) return;
    isRegisteredAdapter[adapter] = true;
    s_adapterHistory.push(adapter);
  }

  /// @dev Rejects degenerate endpoints: zero addresses, an adapter equal to its pool, and either one being this
  /// contract or the token.
  function _validateEndpoints(address adapter, address pool) internal view {
    if (adapter == address(0) || pool == address(0)) revert ZeroAddress();
    if (adapter == pool || adapter == address(this) || adapter == TOKEN) revert InvalidEndpoint(adapter);
    if (pool == address(this) || pool == TOKEN) revert InvalidEndpoint(pool);
  }

  /// @dev Guardian-side bucket update: capacity and rate may only decrease, and the available amount is capped rather
  /// than reset, so usage is never restored. An unconfigured bucket already allows nothing and is left untouched, so
  /// the owner's first configuration still starts it full.
  function _reduceBucket(TokenBucket.Bucket storage bucket, uint256 capacity, uint256 rate) internal {
    if (capacity > bucket.capacity || rate > bucket.rate) revert NotARestriction();
    if (!bucket.initialized) return;
    bucket.setConfig(capacity, rate);
  }

  function _budgetState(TokenBucket.Bucket storage bucket) internal view returns (BudgetState memory) {
    return BudgetState({capacity: bucket.capacity, rate: bucket.rate, available: bucket.available()});
  }

  function _validatePoolSpec(PoolSpec calldata spec) internal pure {
    if (
      bytes(spec.typeAndVersion).length == 0 || spec.router == address(0) || spec.remoteChainSelector == 0
        || spec.remoteToken.length == 0 || spec.remotePools.length == 0 || spec.rateLimitAdmin == address(0)
    ) revert InvalidPoolSpec();
    for (uint256 i = 0; i < spec.remotePools.length; ++i) {
      if (spec.remotePools[i].length == 0) revert InvalidPoolSpec();
      bytes32 poolHash = keccak256(spec.remotePools[i]);
      for (uint256 j = 0; j < i; ++j) {
        if (keccak256(spec.remotePools[j]) == poolHash) revert InvalidPoolSpec();
      }
    }
  }

  /// @dev Authorities outside the pool that the design requires to be with the Timelock before production: the
  /// token's TokenAdminRegistry administration (which can reassign the pool) and the token ownership (pause).
  function _verifyHandover() internal view {
    address governance = owner();
    ITokenAdminRegistry.TokenConfig memory config = TOKEN_ADMIN_REGISTRY.getTokenConfig(TOKEN);
    if (config.administrator != governance) revert RegistryAdminMismatch(config.administrator);
    if (config.pendingAdministrator != address(0)) revert RegistryAdminTransferPending(config.pendingAdministrator);
    address tokenOwner = IOwnable(TOKEN).owner();
    if (tokenOwner != governance) revert TokenOwnerMismatch(tokenOwner);
  }

  /// @dev Checks performed at registration and before every funding. The pool address comes from the Manager's
  /// registry; the adapter's reported bindings are only cross-checked against it.
  function _verifyPool(address adapter, address pool) internal view {
    PoolState storage state = s_pools[pool];
    if (!state.specSet) revert PoolSpecNotSet(pool);
    PoolSpec storage spec = state.spec;

    if (adapter.code.length == 0) revert NotAContract(adapter);
    if (pool.code.length == 0) revert NotAContract(pool);

    ILiquidityAdapter liquidityAdapter = ILiquidityAdapter(adapter);
    if (
      liquidityAdapter.MANAGER() != address(this) || liquidityAdapter.TOKEN() != TOKEN
        || liquidityAdapter.POOL() != pool
    ) revert AdapterBindingMismatch(adapter);

    ILockReleaseTokenPool tokenPool = ILockReleaseTokenPool(pool);

    address poolToken = tokenPool.getToken();
    if (poolToken != TOKEN) revert PoolTokenMismatch(pool, poolToken);

    string memory typeAndVersion = tokenPool.typeAndVersion();
    if (keccak256(bytes(typeAndVersion)) != keccak256(bytes(spec.typeAndVersion))) {
      revert PoolVersionMismatch(pool, typeAndVersion);
    }

    address registryPool = TOKEN_ADMIN_REGISTRY.getPool(TOKEN);
    if (registryPool != pool) {
      address sourcePool = state.migrationSourcePool;
      if (sourcePool == address(0) || registryPool != sourcePool) revert PoolNotActiveInRegistry(pool, registryPool);
    }

    address rebalancer = tokenPool.getRebalancer();
    if (rebalancer != adapter) revert PoolRebalancerMismatch(pool, rebalancer);

    address router = tokenPool.getRouter();
    if (router != spec.router) revert PoolRouterMismatch(pool, router);

    uint64 remoteChainSelector = spec.remoteChainSelector;
    uint64[] memory chains = tokenPool.getSupportedChains();
    if (chains.length != 1 || chains[0] != remoteChainSelector) revert PoolChainsMismatch(pool);

    if (keccak256(tokenPool.getRemoteToken(remoteChainSelector)) != keccak256(spec.remoteToken)) {
      revert PoolRemoteTokenMismatch(pool);
    }

    // Set equality: the expected set has no duplicates (validated in `setPoolSpec`), the pool's set has none by
    // construction, the sizes match and every expected element is present.
    uint256 remotePoolCount = spec.remotePools.length;
    if (tokenPool.getRemotePools(remoteChainSelector).length != remotePoolCount) revert PoolRemotePoolsMismatch(pool);
    for (uint256 i = 0; i < remotePoolCount; ++i) {
      if (!tokenPool.isRemotePool(remoteChainSelector, spec.remotePools[i])) revert PoolRemotePoolsMismatch(pool);
    }

    // The pool owner can redirect pool liquidity (e.g. via setRebalancer), so it must be the Manager's own owner.
    address poolOwner = tokenPool.owner();
    if (poolOwner != owner()) revert PoolOwnerMismatch(pool, poolOwner);

    address rateLimitAdmin = tokenPool.getRateLimitAdmin();
    if (rateLimitAdmin != spec.rateLimitAdmin) revert PoolRateLimitAdminMismatch(pool, rateLimitAdmin);
  }
}
