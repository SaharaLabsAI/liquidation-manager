// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "script/Deploy.s.sol";
import {Handover} from "script/Handover.s.sol";

import {ILockReleaseTokenPool} from "src/interfaces/ILockReleaseTokenPool.sol";

/// @notice Runs the scripts' `run()` entry points on an Ethereum fork, exactly as `forge script` would: environment
/// parsing, the deployer preflight (including the pending-nonce RPC check), the broadcast of the four deployments,
/// and the `Handover` preflight, full simulation and calldata printing.
/// @dev Gated on RUN_FORK_TESTS. Sets process environment variables that only the scripts read.
contract ScriptRunForkTest is Test {
  address internal constant SAHARA = 0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111;
  address internal constant POOL = 0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4;
  address internal constant REGISTRY = 0xb22764f98dD05c789929716D677382Df22C05Cb6;
  address internal constant ROUTER = 0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D;
  address internal constant LEGACY_MULTISIG = 0x6601ee913f8b431F300120Dc0FFDee670Ba4e109;
  uint64 internal constant BSC_SELECTOR = 11344663589394136015;

  address internal governanceSafe = makeAddr("governanceSafe");
  address internal guardianSafe = makeAddr("guardianSafe");

  function setUp() public {
    if (!vm.envOr("RUN_FORK_TESTS", false)) vm.skip(true);
    vm.createSelectFork(vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com")));
    // The Safes must be contracts.
    vm.etch(governanceSafe, hex"00");
    vm.etch(guardianSafe, hex"00");
  }

  function test_fork_deployAndHandoverScriptsRun() public {
    vm.setEnv("TOKEN", vm.toString(SAHARA));
    vm.setEnv("TOKEN_ADMIN_REGISTRY", vm.toString(REGISTRY));
    vm.setEnv("POOL", vm.toString(POOL));
    vm.setEnv("GOVERNANCE_SAFE", vm.toString(governanceSafe));
    vm.setEnv("GUARDIAN_SAFE", vm.toString(guardianSafe));

    Deploy.Deployment memory d = new Deploy().run();
    assertEq(d.manager.owner(), address(d.timelock));
    assertEq(d.manager.guardian(), guardianSafe);
    assertEq(address(d.controller.MANAGER()), address(d.manager));
    assertTrue(d.timelock.hasRole(d.timelock.CANCELLER_ROLE(), address(d.controller)));
    assertEq(d.timelock.getMinDelay(), 72 hours);

    vm.setEnv("LEGACY_MULTISIG", vm.toString(LEGACY_MULTISIG));
    vm.setEnv("TIMELOCK", vm.toString(address(d.timelock)));
    vm.setEnv("MANAGER", vm.toString(address(d.manager)));
    vm.setEnv("CONTROLLER", vm.toString(address(d.controller)));
    vm.setEnv("ADAPTER", vm.toString(address(d.adapter)));
    vm.setEnv("FUNDING_OPERATOR", vm.toString(makeAddr("fundingOperator")));
    vm.setEnv("RECALL_OPERATOR", vm.toString(makeAddr("recallOperator")));
    vm.setEnv("ROUTER", vm.toString(ROUTER));
    vm.setEnv("REMOTE_CHAIN_SELECTOR", vm.toString(uint256(BSC_SELECTOR)));
    vm.setEnv("REMOTE_TOKEN", vm.toString(SAHARA));
    vm.setEnv("REMOTE_POOL", vm.toString(POOL));
    vm.setEnv("POOL_MINIMUM", "20000000000000000000000000");
    vm.setEnv("REFILL_TRIGGER", "50000000000000000000000000");
    vm.setEnv("REFILL_TARGET", "100000000000000000000000000");
    vm.setEnv("MAX_FUNDING_PER_CALL", "25000000000000000000000000");
    vm.setEnv("AGGREGATE_FUNDING_CAPACITY", "100000000000000000000000000");
    vm.setEnv("AGGREGATE_FUNDING_RATE", "1157407407407407407407");
    vm.setEnv("POOL_FUNDING_CAPACITY", "50000000000000000000000000");
    vm.setEnv("POOL_FUNDING_RATE", "578703703703703703703");
    vm.setEnv("MAX_RECALL_PER_CALL", "25000000000000000000000000");
    vm.setEnv("RECALL_CAPACITY", "50000000000000000000000000");
    vm.setEnv("RECALL_RATE", "578703703703703703703");

    // Preflight + full simulation + calldata; the simulation leaves the live state untouched.
    new Handover().run();
    assertEq(ILockReleaseTokenPool(POOL).owner(), LEGACY_MULTISIG);
    assertEq(d.manager.adapterCount(), 0);

    // A wrong cross-chain input stops the script before anything is printed for signing.
    vm.setEnv("REMOTE_TOKEN", vm.toString(address(0xBAD)));
    Handover handover = new Handover();
    vm.expectRevert(bytes("pool remote token"));
    handover.run();
  }
}
