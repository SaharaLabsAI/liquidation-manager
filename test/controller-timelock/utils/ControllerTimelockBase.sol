// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {GuardianController} from "src/GuardianController.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";

import {BaseTest} from "test/utils/BaseTest.sol";

/// @notice Shared helpers for the GuardianController / SaharaTimelock suites.
abstract contract ControllerTimelockBase is BaseTest {
  address internal newGuardian = makeAddr("newGuardian");

  // ---------------------------------------------------------------- Timelock state bitmaps

  function _bitmap(TimelockController.OperationState state) internal pure returns (bytes32) {
    return bytes32(uint256(1) << uint8(state));
  }

  /// @dev Expected state bitmap reported by `TimelockController.cancel` for a non-pending operation.
  function _pendingBitmap() internal pure returns (bytes32) {
    return _bitmap(TimelockController.OperationState.Waiting) | _bitmap(TimelockController.OperationState.Ready);
  }

  function _readyBitmap() internal pure returns (bytes32) {
    return _bitmap(TimelockController.OperationState.Ready);
  }

  function _unsetBitmap() internal pure returns (bytes32) {
    return _bitmap(TimelockController.OperationState.Unset);
  }

  function _notPendingRevert(bytes32 id) internal pure returns (bytes memory) {
    return abi.encodeWithSelector(TimelockController.TimelockUnexpectedOperationState.selector, id, _pendingBitmap());
  }

  // ---------------------------------------------------------------- calldata builders

  function _setGuardianCall(address account) internal pure returns (bytes memory) {
    return abi.encodeCall(ILiquidityManager.setGuardian, (account));
  }

  function _protectedRevert(bytes32 id) internal pure returns (bytes memory) {
    return abi.encodeWithSelector(GuardianController.ProtectedOperation.selector, id);
  }

  function _notGuardianRevert(address caller) internal pure returns (bytes memory) {
    return abi.encodeWithSelector(GuardianController.CallerNotGuardian.selector, caller);
  }

  // ---------------------------------------------------------------- scheduling

  function _scheduleOp(address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt)
    internal
    returns (bytes32 id)
  {
    vm.prank(governanceSafe);
    timelock.schedule(target, value, data, predecessor, salt, TIMELOCK_DELAY);
    id = timelock.hashOperation(target, value, data, predecessor, salt);
    assertTrue(timelock.isOperationPending(id), "scheduled op pending");
  }

  function _scheduleBatchOp(
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory payloads,
    bytes32 predecessor,
    bytes32 salt
  ) internal returns (bytes32 id) {
    vm.prank(governanceSafe);
    timelock.scheduleBatch(targets, values, payloads, predecessor, salt, TIMELOCK_DELAY);
    id = timelock.hashOperationBatch(targets, values, payloads, predecessor, salt);
    assertTrue(timelock.isOperationPending(id), "scheduled batch pending");
  }

  function _executeOp(address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt) internal {
    vm.prank(governanceSafe);
    timelock.execute(target, value, data, predecessor, salt);
  }

  function _executeBatchOp(
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory payloads,
    bytes32 predecessor,
    bytes32 salt
  ) internal {
    vm.prank(governanceSafe);
    timelock.executeBatch(targets, values, payloads, predecessor, salt);
  }

  // ---------------------------------------------------------------- array builders

  function _targets1(address a) internal pure returns (address[] memory t) {
    t = new address[](1);
    t[0] = a;
  }

  function _targets2(address a, address b) internal pure returns (address[] memory t) {
    t = new address[](2);
    t[0] = a;
    t[1] = b;
  }

  function _values1(uint256 a) internal pure returns (uint256[] memory v) {
    v = new uint256[](1);
    v[0] = a;
  }

  function _values2(uint256 a, uint256 b) internal pure returns (uint256[] memory v) {
    v = new uint256[](2);
    v[0] = a;
    v[1] = b;
  }

  function _payloads1(bytes memory a) internal pure returns (bytes[] memory p) {
    p = new bytes[](1);
    p[0] = a;
  }

  function _payloads2(bytes memory a, bytes memory b) internal pure returns (bytes[] memory p) {
    p = new bytes[](2);
    p[0] = a;
    p[1] = b;
  }

  // ---------------------------------------------------------------- pool helpers

  function _assertLockedDown(address target, uint64 chainSelector) internal view {
    (bool outEnabled, uint128 outCapacity, uint128 outRate) = _outbound(target, chainSelector);
    (bool inEnabled, uint128 inCapacity, uint128 inRate) = _inbound(target, chainSelector);
    assertTrue(outEnabled, "outbound enabled");
    assertEq(outCapacity, 0, "outbound capacity");
    assertEq(outRate, 0, "outbound rate");
    assertTrue(inEnabled, "inbound enabled");
    assertEq(inCapacity, 0, "inbound capacity");
    assertEq(inRate, 0, "inbound rate");
  }

  function _assertBuckets(
    address target,
    uint64 chainSelector,
    ILockReleaseTokenPool.RateLimiterConfig memory outbound,
    ILockReleaseTokenPool.RateLimiterConfig memory inbound
  ) internal view {
    (bool outEnabled, uint128 outCapacity, uint128 outRate) = _outbound(target, chainSelector);
    (bool inEnabled, uint128 inCapacity, uint128 inRate) = _inbound(target, chainSelector);
    assertEq(outEnabled, outbound.isEnabled, "outbound enabled");
    assertEq(outCapacity, outbound.capacity, "outbound capacity");
    assertEq(outRate, outbound.rate, "outbound rate");
    assertEq(inEnabled, inbound.isEnabled, "inbound enabled");
    assertEq(inCapacity, inbound.capacity, "inbound capacity");
    assertEq(inRate, inbound.rate, "inbound rate");
  }

  function _outbound(address target, uint64 chainSelector) internal view returns (bool, uint128, uint128) {
    (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("outboundConfig(uint64)", chainSelector));
    require(ok, "outboundConfig");
    return abi.decode(ret, (bool, uint128, uint128));
  }

  function _inbound(address target, uint64 chainSelector) internal view returns (bool, uint128, uint128) {
    (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("inboundConfig(uint64)", chainSelector));
    require(ok, "inboundConfig");
    return abi.decode(ret, (bool, uint128, uint128));
  }

  function _restoreCall(
    uint64 chainSelector,
    ILockReleaseTokenPool.RateLimiterConfig memory outbound,
    ILockReleaseTokenPool.RateLimiterConfig memory inbound
  ) internal pure returns (bytes memory) {
    return abi.encodeCall(ILockReleaseTokenPool.setChainRateLimiterConfig, (chainSelector, outbound, inbound));
  }
}
