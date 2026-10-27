// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {SaharaTimelock} from "src/SaharaTimelock.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";

import {ControllerTimelockBase} from "test/controller-timelock/utils/ControllerTimelockBase.sol";

/// @notice Drives the Guardian through the controller with arbitrary and near-miss cancellation requests while a
/// protected single op and a protected batch-of-one are pending.
contract ControllerHandler is Test {
  GuardianController internal immutable controller;
  SaharaTimelock internal immutable timelock;
  address internal immutable manager;
  address internal immutable guardian;
  address internal immutable governanceSafe;
  address internal immutable pool;
  bytes32 internal immutable protectedSingle;
  bytes32 internal immutable protectedBatch;

  bytes32[] internal scheduledSalts;
  uint256[] internal scheduledValues;

  uint256 public ghostCancelled;
  uint256 public ghostProtectedCancelled;
  uint256 public ghostOrdinaryScheduled;

  constructor(
    GuardianController controller_,
    SaharaTimelock timelock_,
    address manager_,
    address guardian_,
    address governanceSafe_,
    address pool_,
    bytes32 protectedSingle_,
    bytes32 protectedBatch_
  ) {
    controller = controller_;
    timelock = timelock_;
    manager = manager_;
    guardian = guardian_;
    governanceSafe = governanceSafe_;
    pool = pool_;
    protectedSingle = protectedSingle_;
    protectedBatch = protectedBatch_;
  }

  function _afterCancel(bytes32 id) internal {
    ++ghostCancelled;
    if (id == protectedSingle || id == protectedBatch) ++ghostProtectedCancelled;
  }

  function scheduleOrdinary(uint256 value, bytes32 salt) external {
    bytes memory data = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (value));
    if (timelock.isOperation(timelock.hashOperation(manager, 0, data, 0, salt))) return;
    uint256 delay = timelock.getMinDelay();
    vm.prank(governanceSafe);
    timelock.schedule(manager, 0, data, 0, salt, delay);
    scheduledSalts.push(salt);
    scheduledValues.push(value);
    ++ghostOrdinaryScheduled;
  }

  function cancelScheduled(uint256 index) external {
    if (scheduledSalts.length == 0) return;
    index = bound(index, 0, scheduledSalts.length - 1);
    bytes memory data = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (scheduledValues[index]));
    bytes32 id = timelock.hashOperation(manager, 0, data, 0, scheduledSalts[index]);
    if (!timelock.isOperationPending(id)) return;
    vm.prank(guardian);
    controller.cancel(manager, 0, data, 0, scheduledSalts[index]);
    _afterCancel(id);
  }

  function cancelRandom(
    bool toManager,
    address target,
    uint256 value,
    bytes calldata data,
    bytes32 predecessor,
    bytes32 salt
  ) external {
    if (toManager) target = manager;
    bytes32 id = timelock.hashOperation(target, value, data, predecessor, salt);
    vm.prank(guardian);
    try controller.cancel(target, value, data, predecessor, salt) {
      _afterCancel(id);
    } catch {}
  }

  function cancelBatchRandom(
    address[] calldata targets,
    uint256[] calldata values,
    bytes[] calldata payloads,
    bytes32 predecessor,
    bytes32 salt
  ) external {
    bytes32 id = timelock.hashOperationBatch(targets, values, payloads, predecessor, salt);
    vm.prank(guardian);
    try controller.cancelBatch(targets, values, payloads, predecessor, salt) {
      _afterCancel(id);
    } catch {}
  }

  /// @dev Near-miss and exact variants of the protected contents, with and without the scheduled predecessor/salt.
  function cancelProtectedVariant(
    uint8 variant,
    address account,
    bool useScheduledParams,
    bytes32 predecessor,
    bytes32 salt
  ) external {
    if (useScheduledParams) {
      account = address(0xBEEF);
      predecessor = 0;
      salt = 0;
    }
    bytes memory data = abi.encodeCall(ILiquidityManager.setGuardian, (account));
    variant = variant % 6;
    address[] memory targets = new address[](1);
    uint256[] memory values = new uint256[](1);
    bytes[] memory payloads = new bytes[](1);
    targets[0] = manager;
    payloads[0] = data;

    if (variant == 0) {
      _trySingle(manager, 0, data, predecessor, salt);
    } else if (variant == 1) {
      _tryBatch(targets, values, payloads, predecessor, salt);
    } else if (variant == 2) {
      _trySingle(manager, 0, bytes.concat(data, hex"00"), predecessor, salt);
    } else if (variant == 3) {
      _trySingle(manager, 1, data, predecessor, salt);
    } else if (variant == 4) {
      _trySingle(
        manager,
        0,
        bytes.concat(ILiquidityManager.setGuardian.selector, bytes32(uint256(uint160(account)) | (uint256(1) << 200))),
        predecessor,
        salt
      );
    } else {
      address[] memory two = new address[](2);
      two[0] = manager;
      two[1] = manager;
      bytes[] memory twoPayloads = new bytes[](2);
      twoPayloads[0] = data;
      twoPayloads[1] = data;
      _tryBatch(two, new uint256[](2), twoPayloads, predecessor, salt);
    }
  }

  function _trySingle(address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt) internal {
    bytes32 id = timelock.hashOperation(target, value, data, predecessor, salt);
    vm.prank(guardian);
    try controller.cancel(target, value, data, predecessor, salt) {
      _afterCancel(id);
    } catch {}
  }

  function _tryBatch(
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory payloads,
    bytes32 predecessor,
    bytes32 salt
  ) internal {
    bytes32 id = timelock.hashOperationBatch(targets, values, payloads, predecessor, salt);
    vm.prank(guardian);
    try controller.cancelBatch(targets, values, payloads, predecessor, salt) {
      _afterCancel(id);
    } catch {}
  }

  function lockdown() external {
    vm.prank(guardian);
    controller.lockdown(pool);
  }

  function warp(uint32 secs) external {
    vm.warp(block.timestamp + secs);
  }
}

contract GuardianControllerInvariantTest is ControllerTimelockBase {
  ControllerHandler internal handler;
  bytes32 internal protectedSingle;
  bytes32 internal protectedBatch;

  function setUp() public override {
    super.setUp();
    bytes memory data = _setGuardianCall(address(0xBEEF));
    protectedSingle = _scheduleOp(address(manager), 0, data, 0, 0);
    protectedBatch = _scheduleBatchOp(_targets1(address(manager)), _values1(0), _payloads1(data), 0, 0);

    handler = new ControllerHandler(
      controller, timelock, address(manager), guardian, governanceSafe, address(pool), protectedSingle, protectedBatch
    );
    targetContract(address(handler));
  }

  function invariant_protectedOpsStayPending() public view {
    assertTrue(timelock.isOperationPending(protectedSingle), "protected single");
    assertTrue(timelock.isOperationPending(protectedBatch), "protected batch");
    assertEq(handler.ghostProtectedCancelled(), 0);
  }

  function invariant_guardianAndRolesUnchanged() public view {
    assertEq(manager.guardian(), guardian);
    assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), address(controller)));
    assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), guardian));
    // The Governance Safe, as proposer, keeps its own CANCELLER_ROLE.
    assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), governanceSafe));
    assertEq(pool.getRateLimitAdmin(), address(controller));
  }

  /// @dev The controller can only ever leave the counterpart buckets at the fixture config or at {enabled, 0, 0}.
  function invariant_bucketsOriginalOrZero() public view {
    (bool outEnabled, uint128 outCapacity, uint128 outRate) = _outbound(address(pool), REMOTE_CHAIN_SELECTOR);
    (bool inEnabled, uint128 inCapacity, uint128 inRate) = _inbound(address(pool), REMOTE_CHAIN_SELECTOR);
    assertTrue(outEnabled && inEnabled, "always enabled");
    bool outOriginal = outCapacity == CCIP_CAPACITY && outRate == CCIP_RATE;
    bool outZero = outCapacity == 0 && outRate == 0;
    bool inOriginal = inCapacity == CCIP_CAPACITY && inRate == CCIP_RATE;
    bool inZero = inCapacity == 0 && inRate == 0;
    assertTrue((outOriginal && inOriginal) || (outZero && inZero), "original or zero");
  }

  /// @dev Non-vacuity: the handler's guardian paths really cancel ordinary ops and really hit the protection.
  function test_handler_pathsAreLive() public {
    handler.scheduleOrdinary(5, keccak256("s"));
    handler.cancelScheduled(0);
    assertEq(handler.ghostCancelled(), 1);

    handler.scheduleOrdinary(6, keccak256("t"));
    bytes memory data = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (6));
    handler.cancelRandom(true, address(0), 0, data, 0, keccak256("t"));
    assertEq(handler.ghostCancelled(), 2);

    for (uint8 v = 0; v < 6; ++v) {
      handler.cancelProtectedVariant(v, address(0), true, 0, 0);
    }
    assertEq(handler.ghostCancelled(), 2);
    assertTrue(timelock.isOperationPending(protectedSingle));
    assertTrue(timelock.isOperationPending(protectedBatch));

    handler.lockdown();
    _assertLockedDown(address(pool), REMOTE_CHAIN_SELECTOR);
  }

  function invariant_cancelsNeverExceedScheduled() public view {
    assertLe(handler.ghostCancelled(), handler.ghostOrdinaryScheduled());
  }
}
