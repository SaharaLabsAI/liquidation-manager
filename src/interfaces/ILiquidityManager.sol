// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITokenAdminRegistry} from "./ITokenAdminRegistry.sol";

interface ILiquidityManager {
  // ================================================================
  // │                           Types                              │
  // ================================================================

  /// @notice Registry entry. `pool` is stored independently of the value reported by the adapter.
  struct Adapter {
    address adapter;
    address pool;
    bool fundingEnabled;
    bool recallEnabled;
  }

  /// @notice Pool configuration the Manager requires before registering an adapter for, or funding, a pool. The pool
  /// owner is not part of the spec: it must always be the Manager's own owner (the Timelock).
  /// @param typeAndVersion Pinned `typeAndVersion()` string, e.g. "LockReleaseTokenPool 1.6.3-dev".
  /// @param router CCIP Router the pool must use.
  /// @param remoteChainSelector Counterpart chain; it must be the pool's only supported chain.
  /// @param remoteToken Expected `getRemoteToken(remoteChainSelector)`, e.g. abi.encode(remoteTokenAddress).
  /// @param remotePools Expected `getRemotePools(remoteChainSelector)` set, e.g. [abi.encode(remotePoolAddress)].
  /// @param rateLimitAdmin Expected pool rate limit admin (the GuardianController).
  struct PoolSpec {
    string typeAndVersion;
    address router;
    uint64 remoteChainSelector;
    bytes remoteToken;
    bytes[] remotePools;
    address rateLimitAdmin;
  }

  /// @notice Inventory thresholds of a pool. Recalls may not take the pool balance below `minimum`. `refillTrigger`
  /// and `refillTarget` are published for the funding keeper; `minimum <= refillTrigger <= refillTarget` holds when
  /// set by governance.
  struct PoolThresholds {
    uint256 minimum;
    uint256 refillTrigger;
    uint256 refillTarget;
  }

  /// @notice Point-in-time view of a capacity/refill budget.
  struct BudgetState {
    uint256 capacity;
    uint256 rate;
    uint256 available;
  }

  // ================================================================
  // │                           Events                             │
  // ================================================================

  event Funded(
    uint256 indexed adapterId, address indexed pool, address indexed operator, address adapter, uint256 amount
  );
  event Recalled(
    uint256 indexed adapterId, address indexed pool, address indexed operator, address adapter, uint256 amount
  );

  /// @notice Emitted for every Guardian call, before the configuration event(s) it causes.
  event GuardianAction(address indexed guardian, bytes4 indexed selector);

  event GuardianSet(address indexed previousGuardian, address indexed newGuardian);
  event FundingOperatorSet(address indexed operator, bool enabled);
  event RecallOperatorSet(address indexed operator, bool enabled);
  event FundingPausedSet(bool paused);
  event RecallPausedSet(bool paused);

  event MaxFundingPerCallSet(uint256 maxFundingPerCall);
  event AggregateFundingBudgetSet(uint256 capacity, uint256 rate);
  event PoolFundingBudgetSet(address indexed pool, uint256 capacity, uint256 rate);
  event RecallLimitsSet(uint256 maxRecallPerCall, uint256 capacity, uint256 rate);

  event PoolSpecSet(address indexed pool, PoolSpec spec);
  event PoolThresholdsSet(address indexed pool, uint256 minimum, uint256 refillTrigger, uint256 refillTarget);
  event PoolMigrationApprovalSet(address indexed pool, address indexed sourcePool);

  event AdapterRegistered(uint256 indexed adapterId, address indexed adapter, address indexed pool);
  event AdapterReplaced(uint256 indexed adapterId, address indexed previousAdapter, address indexed newAdapter);
  event AdapterStatusSet(uint256 indexed adapterId, bool fundingEnabled, bool recallEnabled);

  event ReservesMigrated(address indexed to, uint256 amount);
  event TokenRecovered(address indexed token, address indexed to, uint256 amount);

  // ================================================================
  // │                           Errors                             │
  // ================================================================

  error ZeroAddress();
  error ZeroAmount();
  error NotAContract(address account);
  error OwnershipCannotBeRenounced();
  error CallerNotFundingOperator(address caller);
  error CallerNotRecallOperator(address caller);
  error CallerNotGuardian(address caller);
  error OperatorRolesMustBeSeparate(address operator);
  error OperatorCannotBeGuardian(address operator);
  error FundingIsPaused();
  error RecallIsPaused();
  error FundingDisabled(uint256 adapterId);
  error RecallDisabled(uint256 adapterId);
  error UnknownAdapter(uint256 adapterId);
  error ExceedsPerCallLimit(uint256 amount, uint256 limit);
  error PoolMinimumBreached(uint256 poolBalance, uint256 amount, uint256 minimum);

  error NotARestriction();
  error InvalidThresholds(uint256 minimum, uint256 refillTrigger, uint256 refillTarget);
  error InvalidPoolSpec();
  error PoolSpecNotSet(address pool);
  error PoolThresholdsNotSet(address pool);
  error PoolAlreadyRegistered(address pool, uint256 adapterId);
  error InvalidEndpoint(address account);
  error InvalidMigrationDestination(address to);
  error CannotRecoverReserveToken();

  error RegistryAdminMismatch(address administrator);
  error RegistryAdminTransferPending(address pendingAdministrator);
  error TokenOwnerMismatch(address tokenOwner);

  error AdapterBindingMismatch(address adapter);
  error AdapterUnchanged(address adapter);
  error PoolTokenMismatch(address pool, address token);
  error PoolVersionMismatch(address pool, string typeAndVersion);
  error PoolNotActiveInRegistry(address pool, address registryPool);
  error PoolRebalancerMismatch(address pool, address rebalancer);
  error PoolRouterMismatch(address pool, address router);
  error PoolChainsMismatch(address pool);
  error PoolRemoteTokenMismatch(address pool);
  error PoolRemotePoolsMismatch(address pool);
  error PoolOwnerMismatch(address pool, address owner);
  error PoolRateLimitAdminMismatch(address pool, address rateLimitAdmin);

  error NonZeroAllowance(uint256 allowance);
  error BalanceCheckFailed();

  // ================================================================
  // │                         Operations                           │
  // ================================================================

  function fund(uint256 adapterId, uint256 amount) external;

  function recall(uint256 adapterId, uint256 amount) external;

  // ================================================================
  // │                           Views                              │
  // ================================================================

  function TOKEN() external view returns (address);

  function TOKEN_ADMIN_REGISTRY() external view returns (ITokenAdminRegistry);

  function guardian() external view returns (address);

  function adapterIdByPool(address pool) external view returns (uint256);

  // ================================================================
  // │                         Governance                           │
  // ================================================================

  /// @notice Removes (address(0)) or replaces the Guardian. Only callable by the owner (the Timelock).
  /// @dev Revokes the Guardian's Manager restrictions and, through `GuardianController`, its cancellation and pool
  /// lockdown authority. A standalone call to this function is the one Timelock operation the Guardian cannot cancel.
  function setGuardian(address newGuardian) external;
}
