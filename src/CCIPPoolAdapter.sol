// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILiquidityAdapter} from "./interfaces/ILiquidityAdapter.sol";
import {ILockReleaseTokenPool} from "./interfaces/ILockReleaseTokenPool.sol";

/// @title CCIPPoolAdapter
/// @notice Holds the rebalancer role of one CCIP `LockReleaseTokenPool` on behalf of one `LiquidityManager`.
/// @dev Non-upgradeable, no owner, no arbitrary calls and no rescue function. Recalled liquidity can only be paid to
/// the adapter (the pool pays its rebalancer) and is forwarded to the immutable Manager in the same call. SAHARA sent
/// to the adapter outside of `fund`/`recall` stays here; the Manager verifies the adapter balance is unchanged by every
/// operation.
contract CCIPPoolAdapter is ILiquidityAdapter {
  using SafeERC20 for IERC20;

  error ZeroAddress();
  error PoolTokenMismatch(address poolToken, address token);
  error CallerNotManager(address caller);
  error NonZeroAllowance(uint256 allowance);

  address public immutable MANAGER;
  address public immutable TOKEN;
  address public immutable POOL;

  modifier onlyManager() {
    if (msg.sender != MANAGER) revert CallerNotManager(msg.sender);
    _;
  }

  constructor(address manager, address token, address pool) {
    if (manager == address(0) || token == address(0) || pool == address(0)) revert ZeroAddress();
    address poolToken = ILockReleaseTokenPool(pool).getToken();
    if (poolToken != token) revert PoolTokenMismatch(poolToken, token);
    MANAGER = manager;
    TOKEN = token;
    POOL = pool;
  }

  /// @inheritdoc ILiquidityAdapter
  /// @dev Approves exactly `amount`, lets the pool pull it and resets the allowance to zero. Zero allowance is required
  /// on entry and on exit.
  function fund(uint256 amount) external onlyManager {
    IERC20 token = IERC20(TOKEN);
    _requireZeroAllowance(token);
    token.forceApprove(POOL, amount);
    ILockReleaseTokenPool(POOL).provideLiquidity(amount);
    token.forceApprove(POOL, 0);
    _requireZeroAllowance(token);
  }

  /// @inheritdoc ILiquidityAdapter
  function recall(uint256 amount) external onlyManager {
    ILockReleaseTokenPool(POOL).withdrawLiquidity(amount);
    IERC20(TOKEN).safeTransfer(MANAGER, amount);
  }

  function _requireZeroAllowance(IERC20 token) internal view {
    uint256 allowance = token.allowance(address(this), POOL);
    if (allowance != 0) revert NonZeroAllowance(allowance);
  }
}
