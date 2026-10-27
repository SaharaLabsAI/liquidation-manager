// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {CCIPPoolAdapter} from "src/CCIPPoolAdapter.sol";
import {GuardianController} from "src/GuardianController.sol";
import {LiquidityManager} from "src/LiquidityManager.sol";
import {ILiquidityAdapter} from "src/interfaces/ILiquidityAdapter.sol";
import {ILiquidityManager} from "src/interfaces/ILiquidityManager.sol";
import {ITokenAdminRegistry} from "src/interfaces/ITokenAdminRegistry.sol";

import {MockLockReleaseTokenPool} from "test/mocks/MockLockReleaseTokenPool.sol";
import {MockSahara} from "test/mocks/MockSahara.sol";
import {MockTokenAdminRegistry} from "test/mocks/MockTokenAdminRegistry.sol";

/// @notice Stateful fuzzing handler for the Manager / adapter / pool system with two registered pools (A: initially
/// registry-active; B: a replacement approved for migration funding while the registry maps the token to A) and one
/// unregistered "foreign" pool the registry can be cut over to.
/// @dev The invariant config uses `fail_on_revert = false`, so a revert inside a handler is silently discarded. The
/// handler therefore never asserts: it wraps protocol calls in try/catch or low-level calls and records any property
/// violation in `violations`/`firstViolation`, which the invariant test checks.
contract LiquidityHandler is CommonBase, StdCheats, StdUtils {
  // Budget indices.
  uint256 public constant AGG = 0;
  uint256 public constant BUDGET_A = 1;
  uint256 public constant BUDGET_B = 2;
  uint256 public constant RECALL = 3;
  uint256 public constant BUCKETS = 4;
  uint256 internal constant NO_BUCKET = type(uint256).max;
  uint256 internal constant MAX_ADAPTERS = 8;
  uint256 internal constant MAX_REJECTED_ADAPTERS = 16;
  /// @dev Number of never-registered pool addresses whose funding budget starts unconfigured.
  uint256 public constant PROBES = 8;

  struct Deployment {
    MockSahara token;
    MockTokenAdminRegistry registry;
    LiquidityManager manager;
    GuardianController controller;
    address timelock;
    MockLockReleaseTokenPool poolA;
    MockLockReleaseTokenPool poolB;
    MockLockReleaseTokenPool foreignPool;
    address fundingOperator;
    address recallOperator;
    address guardianA;
    address guardianB;
    address treasury;
    address bridgeUser;
    address migrationRecipient;
    address legacyMultisig;
    address attacker;
  }

  struct Snapshot {
    uint256 manager;
    uint256[2] pools;
    uint256[4] available;
  }

  struct Limits {
    bool fundingPaused;
    bool recallPaused;
    bool fundingRole;
    bool recallRole;
    bool[2] fundingEnabled;
    bool[2] recallEnabled;
    address[2] migrationSource;
    address[2] adapter;
    address[2] adapterPool;
    uint256 maxFunding;
    uint256 maxRecall;
    uint256[4] capacity;
    uint256[4] rate;
    uint256[4] available;
    uint256[2] minimum;
    uint256[2] refillTrigger;
    uint256[2] refillTarget;
    address guardian;
    address owner;
  }

  /// @dev Reference bucket maintained from the specification, independent of the library.
  struct ModelBucket {
    uint256 capacity;
    uint256 rate;
    uint256 tokens;
    uint256 lastUpdated;
  }

  /// @dev Period with one constant configuration, opened at every (re)configuration.
  struct Window {
    uint256 start;
    uint256 tokensAtStart;
    uint256 capacity;
    uint256 rate;
    uint256 consumed;
    uint256 firstEntry;
  }

  struct Consumption {
    uint256 time;
    uint256 amount;
  }

  MockSahara public immutable token;
  MockTokenAdminRegistry public immutable registry;
  LiquidityManager public immutable manager;
  GuardianController public immutable controller;
  address public immutable timelock;
  MockLockReleaseTokenPool public immutable foreignPool;
  address public immutable fundingOperator;
  address public immutable recallOperator;
  address public immutable guardianA;
  address public immutable guardianB;
  address public immutable treasury;
  address public immutable bridgeUser;
  address public immutable migrationRecipient;
  address public immutable legacyMultisig;
  address public immutable attacker;

  MockLockReleaseTokenPool[2] internal s_pools;
  uint256[2] internal s_adapterIds;
  /// @dev Every adapter ever registered, in registration order (initial adapters, then successful replacements).
  address[] internal s_adapters;
  /// @dev Adapters deployed for a replacement that the Manager rejected; they must never count as registered.
  address[] internal s_rejectedAdapters;

  // ---------------------------------------------------------------- ghost ledger
  uint256 public ghostManagerStart;
  uint256[2] public poolStart;
  uint256 public ghostFunded;
  uint256 public ghostRecalled;
  uint256 public ghostMigrated;
  uint256 public ghostReturned;
  uint256 public ghostDustToManager;
  uint256 public ghostDustToAdapters;
  uint256[2] public fundedTo;
  uint256[2] public recalledFrom;
  uint256[2] public inflow;
  uint256[2] public outflow;
  mapping(address adapter => uint256) public ghostDust;
  mapping(address recipient => uint256) public migratedTo;
  mapping(address recipient => uint256) public returnedFrom;

  // ---------------------------------------------------------------- migration approval ghost
  /// @dev Registry pool under which each pool may be funded for migration (address(0): none), tracked independently.
  address[2] public ghostMigrationSource;

  // ---------------------------------------------------------------- unconfigured budget probes
  mapping(address probe => bool) public probeConfigured;
  mapping(address probe => bool) public probeGuardianReduced;

  // ---------------------------------------------------------------- budget ghosts
  ModelBucket[4] internal s_model;
  Window[4] internal s_window;
  Consumption[][4] internal s_log;
  uint256[4] public maxCapacityEver;
  uint256[4] public maxRateEver;
  uint256[4] internal s_initialCapacity;
  uint256[4] internal s_initialRate;
  uint256 internal s_initialMaxFunding;
  uint256 internal s_initialMaxRecall;

  // ---------------------------------------------------------------- owner baselines (Guardian may only tighten)
  uint256[4] public baselineCapacity;
  uint256[4] public baselineRate;
  uint256 public baselineMaxFunding;
  uint256 public baselineMaxRecall;
  uint256[2] public baselineMinimum;

  // ---------------------------------------------------------------- violations and coverage counters
  uint256 public violations;
  string public firstViolation;

  uint256 public fundOk;
  uint256 public fundRejected;
  uint256 public recallOk;
  uint256 public recallRejected;
  uint256 public guardianOk;
  uint256 public guardianRejected;
  uint256 public ownerOk;
  uint256 public ownerRejected;
  uint256 public replacements;
  uint256 public replacementsRejected;
  uint256 public migrations;
  uint256 public fullBalanceMigrations;
  uint256 public migrationsRejected;
  uint256 public forbiddenMigrationsRejected;
  uint256 public lockdowns;
  uint256 public lockdownsRejected;
  uint256 public guardianRotations;
  uint256 public cutovers;
  uint256 public handoverChecks;
  uint256 public handoverDrifts;
  uint256 public probeReductions;
  uint256 public probeReductionsRejected;
  uint256 public probeFirstConfigs;
  uint256 public probeFirstConfigsAfterGuardian;

  modifier managerNeverDecreases(string memory action) {
    uint256 before = token.balanceOf(address(manager));
    _;
    if (token.balanceOf(address(manager)) < before) _violate(string.concat(action, ": Manager balance decreased"));
  }

  constructor(Deployment memory d) {
    token = d.token;
    registry = d.registry;
    manager = d.manager;
    controller = d.controller;
    timelock = d.timelock;
    foreignPool = d.foreignPool;
    fundingOperator = d.fundingOperator;
    recallOperator = d.recallOperator;
    guardianA = d.guardianA;
    guardianB = d.guardianB;
    treasury = d.treasury;
    bridgeUser = d.bridgeUser;
    migrationRecipient = d.migrationRecipient;
    legacyMultisig = d.legacyMultisig;
    attacker = d.attacker;

    s_pools[0] = d.poolA;
    s_pools[1] = d.poolB;
    for (uint256 p = 0; p < 2; ++p) {
      address pool = address(s_pools[p]);
      s_adapterIds[p] = manager.adapterIdByPool(pool);
      address adapter = manager.getAdapter(s_adapterIds[p]).adapter;
      s_adapters.push(adapter);
      ghostDust[adapter] = token.balanceOf(adapter);
      poolStart[p] = token.balanceOf(pool);
      baselineMinimum[p] = _minimum(pool);
      ghostMigrationSource[p] = manager.getPoolMigrationSource(pool);
    }
    ghostManagerStart = token.balanceOf(address(manager));

    for (uint256 b = 0; b < BUCKETS; ++b) {
      ILiquidityManager.BudgetState memory state = budget(b);
      s_model[b] = ModelBucket(state.capacity, state.rate, state.available, block.timestamp);
      s_window[b] = Window(block.timestamp, state.available, state.capacity, state.rate, 0, 0);
      maxCapacityEver[b] = state.capacity;
      maxRateEver[b] = state.rate;
      s_initialCapacity[b] = state.capacity;
      s_initialRate[b] = state.rate;
      baselineCapacity[b] = state.capacity;
      baselineRate[b] = state.rate;
    }
    s_initialMaxFunding = manager.maxFundingPerCall();
    s_initialMaxRecall = manager.maxRecallPerCall();
    baselineMaxFunding = s_initialMaxFunding;
    baselineMaxRecall = s_initialMaxRecall;
  }

  // ================================================================
  // │                       Operator actions                       │
  // ================================================================

  /// @dev Funding does not depend on the handover state (registry administration and token ownership), so it is
  /// expected to succeed while `handoverDrift` has moved an authority away from the owner.
  function fund(uint256 poolSeed, uint256 amountSeed, uint256 modeSeed) external {
    uint256 p = poolSeed % 2;
    ILiquidityManager.Adapter memory entry = manager.getAdapter(s_adapterIds[p]);
    Snapshot memory before = _snapshot();

    bool permitted =
      manager.isFundingOperator(fundingOperator) && !manager.fundingPaused() && entry.fundingEnabled && _fundable(p);
    uint256 maxAllowed = Math.min(
      Math.min(manager.maxFundingPerCall(), before.available[AGG]), Math.min(before.available[1 + p], before.manager)
    );
    uint256 amount = _pickAmount(maxAllowed, amountSeed, modeSeed);
    bool expectOk = permitted && amount != 0 && amount <= maxAllowed;

    vm.prank(fundingOperator);
    try manager.fund(s_adapterIds[p], amount) {
      ++fundOk;
      if (!expectOk) _violate("fund: succeeded although a precondition failed");
      _checkFund(p, entry.adapter, amount, before);
    } catch {
      ++fundRejected;
      if (expectOk) _violate("fund: reverted although every precondition held");
    }
  }

  function recall(uint256 poolSeed, uint256 amountSeed, uint256 modeSeed) external managerNeverDecreases("recall") {
    uint256 p = poolSeed % 2;
    address pool = address(s_pools[p]);
    ILiquidityManager.Adapter memory entry = manager.getAdapter(s_adapterIds[p]);
    Snapshot memory before = _snapshot();
    uint256 minimum = _minimum(pool);

    bool permitted = manager.isRecallOperator(recallOperator) && !manager.recallPaused() && entry.recallEnabled;
    uint256 headroom = before.pools[p] > minimum ? before.pools[p] - minimum : 0;
    uint256 maxAllowed = Math.min(Math.min(manager.maxRecallPerCall(), before.available[RECALL]), headroom);
    uint256 amount = _pickAmount(maxAllowed, amountSeed, modeSeed);
    bool expectOk = permitted && amount != 0 && amount <= maxAllowed;

    vm.prank(recallOperator);
    try manager.recall(s_adapterIds[p], amount) {
      ++recallOk;
      if (!expectOk) _violate("recall: succeeded although a precondition failed");
      _checkRecall(p, entry.adapter, amount, minimum, before);
    } catch {
      ++recallRejected;
      if (expectOk) _violate("recall: reverted although every precondition held");
    }
  }

  // ================================================================
  // │                     Environment actions                      │
  // ================================================================

  function warp(uint256 seed) external managerNeverDecreases("warp") {
    uint256 dt = seed % 10 == 0 ? bound(seed, 0, 30 days) : bound(seed, 0, 1 days);
    vm.warp(block.timestamp + dt);
  }

  /// @notice Bridge settlement: inflow = user locks (direct transfer, no LiquidityAdded), outflow = release to a user.
  function bridgeFlow(bool isInflow, uint256 poolSeed, uint256 amountSeed) external managerNeverDecreases("bridge") {
    uint256 p = poolSeed % 2;
    MockLockReleaseTokenPool pool = s_pools[p];
    if (isInflow) {
      uint256 amount = bound(amountSeed, 0, Math.min(50_000_000e18, token.balanceOf(treasury)));
      vm.prank(treasury);
      token.transfer(address(pool), amount);
      inflow[p] += amount;
    } else {
      uint256 amount = bound(amountSeed, 0, token.balanceOf(address(pool)));
      pool.simulateRelease(bridgeUser, amount);
      outflow[p] += amount;
    }
  }

  /// @notice Unsolicited SAHARA sent directly to an adapter (any ever registered) or to the Manager.
  function sendUnsolicited(bool toManager, uint256 targetSeed, uint256 amountSeed)
    external
    managerNeverDecreases("unsolicited")
  {
    uint256 amount = amountSeed % 4 == 0 ? bound(amountSeed, 0, 20_000_000e18) : bound(amountSeed, 0, 1_000e18);
    if (toManager) {
      vm.prank(treasury);
      token.transfer(address(manager), amount);
      ghostDustToManager += amount;
    } else {
      address adapter = s_adapters[targetSeed % s_adapters.length];
      vm.prank(treasury);
      token.transfer(adapter, amount);
      ghostDust[adapter] += amount;
      ghostDustToAdapters += amount;
    }
  }

  /// @notice Moves (or restores) the authorities outside the pool that registration and replacement require to be
  /// with the owner: the registry administration (current and pending) and the token ownership. `verifyHandover` must
  /// report exactly the first deviation, in the Manager's check order.
  function handoverDrift(uint256 seed) external managerNeverDecreases("handover") {
    uint256 kind = seed % 8;
    if (kind < 5) {
      registry.setAdministrator(address(token), timelock);
      registry.setPendingAdministrator(address(token), address(0));
      address tokenOwner = token.owner();
      if (tokenOwner != timelock) {
        vm.prank(tokenOwner);
        token.transferOwnership(timelock);
      }
    } else if (kind == 5) {
      registry.setPendingAdministrator(address(token), legacyMultisig);
      ++handoverDrifts;
    } else if (kind == 6) {
      registry.setAdministrator(address(token), legacyMultisig);
      ++handoverDrifts;
    } else if (token.owner() == timelock) {
      vm.prank(timelock);
      token.transferOwnership(legacyMultisig);
      ++handoverDrifts;
    }

    ++handoverChecks;
    bytes memory expected = handoverError();
    try manager.verifyHandover() {
      if (expected.length != 0) _violate("verifyHandover: passed although an authority is not with the owner");
    } catch (bytes memory reason) {
      if (expected.length == 0 || keccak256(reason) != keccak256(expected)) {
        _violate("verifyHandover: unexpected revert");
      }
    }
  }

  // ================================================================
  // │                       Guardian actions                       │
  // ================================================================

  /// @notice A random Guardian call with random parameters, including loosening attempts and owner-only calls. Any
  /// successful call must leave every limit at least as tight as before and emit `GuardianAction` first.
  function guardianAct(uint256 actionSeed, uint256 a, uint256 b, uint256 c) external managerNeverDecreases("guardian") {
    address currentGuardian = manager.guardian();
    uint256 action = actionSeed % 12;
    (bytes memory data, uint256 bucket, uint256 capacity, uint256 rate) = _guardianCall(action, a, b, c);
    uint256 availableBefore = bucket == NO_BUCKET ? 0 : budget(bucket).available;
    Limits memory before = _limits();

    vm.recordLogs();
    vm.prank(currentGuardian);
    (bool ok,) = address(manager).call(data);
    Vm.Log[] memory logs = _managerLogs();
    if (!ok) {
      ++guardianRejected;
      return;
    }
    ++guardianOk;
    if (action == 11) {
      _violate("guardian: executed an owner-only function");
      return;
    }
    _checkGuardianActionFirst(logs, currentGuardian, bytes4(data));
    _checkNotLooser(before, _limits());
    if (bucket != NO_BUCKET) _onConfigured(bucket, capacity, rate, availableBefore);
    if (action == 5) ghostMigrationSource[c % 2] = address(0);
  }

  /// @notice Guardian reduction of the funding budget of a never-registered pool. While the owner has never
  /// configured that budget only (0, 0) is accepted, and it must leave the bucket uninitialized (checked by
  /// `ownerConfigureProbe`: the owner's first configuration still starts full). Once configured it is an ordinary
  /// reduction that may never loosen the budget.
  function guardianReduceProbe(uint256 probeSeed, uint256 capacitySeed, uint256 rateSeed)
    external
    managerNeverDecreases("guardianProbe")
  {
    address probe = probeAt(probeSeed % PROBES);
    address currentGuardian = manager.guardian();
    bool configured = probeConfigured[probe];
    ILiquidityManager.BudgetState memory before = manager.getPoolFundingBudget(probe);

    uint256 capacity;
    uint256 rate;
    if (configured) {
      (capacity, rate) = (_near(before.capacity, capacitySeed), _near(before.rate, rateSeed));
    } else {
      capacity = capacitySeed % 4 == 1 ? 1 + (capacitySeed / 4) % 1e24 : 0;
      rate = rateSeed % 4 == 1 ? 1 + (rateSeed / 4) % 1e20 : 0;
    }
    bool expectOk = capacity <= before.capacity && rate <= before.rate;

    vm.recordLogs();
    vm.prank(currentGuardian);
    (bool ok, bytes memory reason) =
      address(manager).call(abi.encodeCall(LiquidityManager.reducePoolFundingBudget, (probe, capacity, rate)));
    Vm.Log[] memory logs = _managerLogs();

    ILiquidityManager.BudgetState memory current = manager.getPoolFundingBudget(probe);
    if (!ok) {
      ++probeReductionsRejected;
      if (expectOk) _violate("guardian probe: valid reduction reverted");
      if (keccak256(reason) != keccak256(abi.encodeWithSelector(ILiquidityManager.NotARestriction.selector))) {
        _violate("guardian probe: unexpected revert data");
      }
      return;
    }
    ++probeReductions;
    if (!expectOk) _violate("guardian probe: loosening reduction succeeded");
    _checkGuardianActionFirst(logs, currentGuardian, LiquidityManager.reducePoolFundingBudget.selector);
    if (
      logs.length < 2 || logs[1].topics.length != 2
        || logs[1].topics[0] != ILiquidityManager.PoolFundingBudgetSet.selector
        || logs[1].topics[1] != bytes32(uint256(uint160(probe)))
        || keccak256(logs[1].data) != keccak256(abi.encode(capacity, rate))
    ) _violate("guardian probe: PoolFundingBudgetSet not emitted after GuardianAction");

    if (configured) {
      if (current.capacity != capacity || current.rate != rate) _violate("guardian probe: parameters not applied");
      if (current.available != Math.min(before.available, capacity)) _violate("guardian probe: usage restored");
    } else {
      probeGuardianReduced[probe] = true;
      if (current.capacity != 0 || current.rate != 0 || current.available != 0) {
        _violate("guardian probe: reduction changed an unconfigured budget");
      }
    }
  }

  function guardianLockdown(uint256 poolSeed) external managerNeverDecreases("lockdown") {
    uint256 kind = poolSeed % 4;
    address target;
    if (kind < 2) target = address(s_pools[kind]);
    else if (kind == 2) target = address(foreignPool);
    // kind 3: address(0), which is never recognized.
    bool recognized = kind < 2 || (kind == 2 && registry.getPool(address(token)) == target);
    Snapshot memory before = _snapshot();
    uint256 foreignBefore = token.balanceOf(address(foreignPool));

    vm.prank(manager.guardian());
    (bool ok, bytes memory reason) = address(controller).call(abi.encodeCall(GuardianController.lockdown, (target)));
    if (!ok) {
      ++lockdownsRejected;
      if (recognized) {
        _violate("lockdown: reverted for a recognized pool");
      } else if (
        keccak256(reason) != keccak256(abi.encodeWithSelector(GuardianController.PoolNotRecognized.selector, target))
      ) {
        _violate("lockdown: unexpected revert data");
      }
      return;
    }
    ++lockdowns;
    if (!recognized) _violate("lockdown: succeeded for an unrecognized pool");
    MockLockReleaseTokenPool pool = MockLockReleaseTokenPool(target);
    uint64 chain = pool.getSupportedChains()[0];
    (bool outEnabled, uint128 outCapacity, uint128 outRate) = pool.outboundConfig(chain);
    (bool inEnabled, uint128 inCapacity, uint128 inRate) = pool.inboundConfig(chain);
    if (!outEnabled || !inEnabled || outCapacity != 0 || outRate != 0 || inCapacity != 0 || inRate != 0) {
      _violate("lockdown: buckets not enabled with zero capacity and rate");
    }
    Snapshot memory afterLockdown = _snapshot();
    if (
      afterLockdown.pools[0] != before.pools[0] || afterLockdown.pools[1] != before.pools[1]
        || token.balanceOf(address(foreignPool)) != foreignBefore
    ) _violate("lockdown: moved pool funds");
  }

  /// @notice The previous Guardian (after a rotation) and an outsider must have no Guardian power left.
  function staleGuardianAct(uint256 seed) external managerNeverDecreases("staleGuardian") {
    address current = manager.guardian();
    address caller = seed % 4 == 0 ? attacker : (current == guardianA ? guardianB : guardianA);
    address pool = address(s_pools[seed % 2]);
    uint256 action = (seed / 4) % 5;
    bool ok;
    vm.prank(caller);
    if (action == 0) {
      (ok,) = address(manager).call(abi.encodeCall(LiquidityManager.pauseFunding, ()));
    } else if (action == 1) {
      (ok,) = address(controller).call(abi.encodeCall(GuardianController.lockdown, (pool)));
    } else if (action == 2) {
      (ok,) = address(manager).call(abi.encodeCall(LiquidityManager.reduceMaxFundingPerCall, (0)));
    } else if (action == 3) {
      (ok,) = address(manager).call(abi.encodeCall(LiquidityManager.raisePoolMinimum, (pool, type(uint256).max)));
    } else {
      (ok,) = address(manager).call(abi.encodeCall(LiquidityManager.revokePoolMigrationApproval, (pool)));
    }
    if (ok) _violate("stale guardian: Guardian call succeeded");
  }

  // ================================================================
  // │                   Owner (Timelock) actions                   │
  // ================================================================

  /// @notice Valid owner configuration calls (restorations, tightenings, migration approvals, Guardian rotation). They
  /// must all succeed.
  function ownerAct(uint256 actionSeed, uint256 a, uint256 b, uint256 c) external managerNeverDecreases("owner") {
    uint256 action = actionSeed % 12;
    uint256 p = c % 2;
    (bytes memory data, uint256 bucket, uint256 capacity, uint256 rate, uint256 value) = _ownerCall(action, a, b, c);

    uint256 availableBefore = bucket == NO_BUCKET ? 0 : budget(bucket).available;
    vm.prank(timelock);
    (bool ok,) = address(manager).call(data);
    if (!ok) {
      _violate("owner: valid configuration call reverted");
      return;
    }
    ++ownerOk;

    if (bucket != NO_BUCKET) {
      _onConfigured(bucket, capacity, rate, availableBefore);
      baselineCapacity[bucket] = capacity;
      baselineRate[bucket] = rate;
    }
    if (action == 5) baselineMaxFunding = value;
    if (action == 8) baselineMaxRecall = value;
    if (action == 9) baselineMinimum[p] = value;
    if (action == 10) ghostMigrationSource[p] = _migrationSourceChoice(p, a);
    if (action == 11) ++guardianRotations;
  }

  /// @notice Invalid owner calls; each must revert with exactly the expected error.
  function ownerInvalidAct(uint256 kindSeed, uint256 seed) external managerNeverDecreases("ownerInvalid") {
    uint256 kind = kindSeed % 6;
    uint256 p = seed % 2;
    address pool = address(s_pools[p]);
    bytes memory data;
    bytes memory expected;

    if (kind == 0) {
      address currentGuardian = manager.guardian();
      data = abi.encodeCall(LiquidityManager.setFundingOperator, (currentGuardian, true));
      expected = abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, currentGuardian);
    } else if (kind == 1) {
      address currentGuardian = manager.guardian();
      data = abi.encodeCall(LiquidityManager.setRecallOperator, (currentGuardian, true));
      expected = abi.encodeWithSelector(ILiquidityManager.OperatorCannotBeGuardian.selector, currentGuardian);
    } else if (kind == 2) {
      data = abi.encodeCall(LiquidityManager.setPoolMigrationApproval, (pool, pool));
      expected = abi.encodeWithSelector(ILiquidityManager.InvalidEndpoint.selector, pool);
    } else if (kind == 3) {
      address current = manager.getAdapter(s_adapterIds[p]).adapter;
      data = abi.encodeCall(LiquidityManager.replaceAdapter, (s_adapterIds[p], current));
      expected = abi.encodeWithSelector(ILiquidityManager.AdapterUnchanged.selector, current);
    } else if (kind == 4) {
      address anyAdapter = s_adapters[(seed / 2) % s_adapters.length];
      data = abi.encodeCall(LiquidityManager.registerAdapter, (anyAdapter, pool));
      expected = abi.encodeWithSelector(ILiquidityManager.PoolAlreadyRegistered.selector, pool, s_adapterIds[p]);
    } else {
      address probe = probeAt(seed % PROBES);
      data = abi.encodeCall(LiquidityManager.registerAdapter, (s_adapters[0], probe));
      expected = abi.encodeWithSelector(ILiquidityManager.PoolThresholdsNotSet.selector, probe);
    }

    vm.prank(timelock);
    (bool ok, bytes memory reason) = address(manager).call(data);
    if (ok) {
      _violate("owner: invalid call succeeded");
    } else {
      ++ownerRejected;
      if (keccak256(reason) != keccak256(expected)) _violate("owner: invalid call reverted with unexpected data");
    }
  }

  /// @notice First (or later) owner configuration of a probe pool's funding budget. The first one must start full,
  /// whatever the Guardian reduced before; later ones must not restore usage.
  function ownerConfigureProbe(uint256 probeSeed, uint256 capacitySeed, uint256 rateSeed)
    external
    managerNeverDecreases("ownerProbe")
  {
    address probe = probeAt(probeSeed % PROBES);
    uint256 capacity = bound(capacitySeed, 0, 50_000_000e18);
    uint256 rate = bound(rateSeed, 0, 1_000e18);
    uint256 availableBefore = manager.getPoolFundingBudget(probe).available;

    vm.prank(timelock);
    try manager.setPoolFundingBudget(probe, capacity, rate) {
      ++ownerOk;
    } catch {
      _violate("owner probe: valid budget configuration reverted");
      return;
    }
    ILiquidityManager.BudgetState memory state = manager.getPoolFundingBudget(probe);
    if (state.capacity != capacity || state.rate != rate) _violate("owner probe: parameters not applied");
    if (probeConfigured[probe]) {
      if (state.available != Math.min(availableBefore, capacity)) {
        _violate("owner probe: reconfiguration restored usage");
      }
      return;
    }
    probeConfigured[probe] = true;
    ++probeFirstConfigs;
    if (probeGuardianReduced[probe]) ++probeFirstConfigsAfterGuardian;
    if (state.available != capacity) {
      _violate(
        probeGuardianReduced[probe]
          ? "owner probe: first configuration did not start full after a Guardian reduction"
          : "owner probe: first configuration did not start full"
      );
    }
  }

  /// @notice TokenAdminRegistry cutover (the Timelock is the registry administrator): CCIP switches to pool A, pool B
  /// or the unregistered foreign pool. Afterwards a pool that is not active can only be funded with a migration
  /// approval bound to the new registry pool.
  function ownerRegistryCutover(uint256 poolSeed) external managerNeverDecreases("cutover") {
    uint256 kind = poolSeed % 3;
    address next = kind < 2 ? address(s_pools[kind]) : address(foreignPool);
    if (registry.getPool(address(token)) == next) return;
    vm.prank(timelock);
    registry.setPool(address(token), next);
    ++cutovers;
  }

  /// @notice `migrateReserves` towards a random destination: the Manager, the token, any adapter ever registered
  /// (including replaced ones), a registered pool, address(0), the unregistered foreign pool, an arbitrary address from
  /// the fuzzer's dictionary or the migration recipient. Adapters, registered pools, the Manager and the token must
  /// always be rejected with `InvalidMigrationDestination`; `type(uint256).max` must move exactly the whole balance.
  /// @dev Untracked arbitrary destinations are only probed with a zero amount (expecting `ZeroAmount`), so every token
  /// stays at an address the conservation invariant sums. After a whole-balance migration the recipient sends the
  /// reserves back so the run keeps operating.
  function ownerMigrateReserves(uint256 kindSeed, address raw, uint256 amountSeed) external {
    address to = _migrationDestination(kindSeed, raw);
    bool forbidden = isForbiddenMigrationDestination(to);
    bool tracked = to == migrationRecipient || to == address(foreignPool);
    uint256 balance = token.balanceOf(address(manager));
    uint256 amount = _migrationAmount(amountSeed, balance);
    if (to != address(0) && !forbidden && !tracked) amount = 0;
    (bytes memory expected, uint256 effective) = _migrationOutcome(to, amount, balance);
    uint256 toBefore = token.balanceOf(to);

    vm.prank(timelock);
    (bool ok, bytes memory reason) =
      address(manager).call(abi.encodeCall(LiquidityManager.migrateReserves, (to, amount)));
    if (!ok) {
      ++migrationsRejected;
      if (forbidden) ++forbiddenMigrationsRejected;
      if (expected.length == 0 || keccak256(reason) != keccak256(expected)) {
        _violate("migrateReserves: unexpected revert");
      }
      if (token.balanceOf(address(manager)) != balance) _violate("migrateReserves: reverted call moved reserves");
      return;
    }

    ++migrations;
    if (forbidden) _violate("migrateReserves: succeeded towards a forbidden destination");
    if (expected.length != 0) _violate("migrateReserves: succeeded although expected to revert");
    if (token.balanceOf(address(manager)) != balance - effective) {
      _violate("migrateReserves: Manager not debited exactly the amount");
    }
    if (token.balanceOf(to) != toBefore + effective) _violate("migrateReserves: recipient not credited exactly");
    ghostMigrated += effective;
    migratedTo[to] += effective;

    if (amount == type(uint256).max) {
      ++fullBalanceMigrations;
      if (token.balanceOf(address(manager)) != 0) _violate("migrateReserves: max did not move the whole balance");
      vm.prank(to);
      token.transfer(address(manager), effective);
      ghostReturned += effective;
      returnedFrom[to] += effective;
    }
  }

  /// @notice Timelocked adapter replacement: the pool owner moves the rebalancer role, then the Manager swaps the
  /// adapter. It requires the pool to pass verification (not the handover check); the pool, status flags and budgets
  /// must carry over.
  function ownerReplaceAdapter(uint256 poolSeed) external managerNeverDecreases("replaceAdapter") {
    if (s_adapters.length >= MAX_ADAPTERS) return;
    uint256 p = poolSeed % 2;
    MockLockReleaseTokenPool pool = s_pools[p];
    uint256 id = s_adapterIds[p];
    ILiquidityManager.Adapter memory before = manager.getAdapter(id);
    Snapshot memory snapshotBefore = _snapshot();
    bytes memory expected = _replacementError(p);

    CCIPPoolAdapter fresh = new CCIPPoolAdapter(address(manager), address(token), address(pool));
    vm.prank(timelock);
    pool.setRebalancer(address(fresh));
    vm.prank(timelock);
    (bool ok, bytes memory reason) =
      address(manager).call(abi.encodeCall(LiquidityManager.replaceAdapter, (id, address(fresh))));
    if (ok) {
      if (expected.length != 0) _violate("replaceAdapter: succeeded although pool verification fails");
      s_adapters.push(address(fresh));
      ++replacements;
      _checkReplacement(p, id, address(fresh), before, snapshotBefore);
    } else {
      ++replacementsRejected;
      if (expected.length == 0 || keccak256(reason) != keccak256(expected)) {
        _violate("replaceAdapter: unexpected revert");
      }
      if (s_rejectedAdapters.length < MAX_REJECTED_ADAPTERS) s_rejectedAdapters.push(address(fresh));
      vm.prank(timelock);
      pool.setRebalancer(before.adapter);
    }
  }

  // ================================================================
  // │                       Attacker actions                       │
  // ================================================================

  function attackerAct(uint256 actionSeed, uint256 amountSeed) external managerNeverDecreases("attacker") {
    uint256 action = actionSeed % 9;
    uint256 p = amountSeed % 2;
    uint256 amount = bound(amountSeed, 1, 25_000_000e18);
    address caller = attacker;
    address target;
    bytes memory data;

    if (action == 0) {
      target = s_adapters[amountSeed % s_adapters.length];
      data = abi.encodeCall(ILiquidityAdapter.fund, (amount));
    } else if (action == 1) {
      target = s_adapters[amountSeed % s_adapters.length];
      data = abi.encodeCall(ILiquidityAdapter.recall, (amount));
    } else if (action == 2) {
      target = address(manager);
      data = abi.encodeCall(LiquidityManager.fund, (s_adapterIds[p], amount));
    } else if (action == 3) {
      target = address(manager);
      data = abi.encodeCall(LiquidityManager.recall, (s_adapterIds[p], amount));
    } else if (action == 4) {
      target = address(s_pools[p]);
      data = abi.encodeCall(MockLockReleaseTokenPool.withdrawLiquidity, (amount));
    } else if (action == 5) {
      caller = fundingOperator;
      target = address(manager);
      data = abi.encodeCall(LiquidityManager.recall, (s_adapterIds[p], amount));
    } else if (action == 6) {
      caller = recallOperator;
      target = address(manager);
      data = abi.encodeCall(LiquidityManager.fund, (s_adapterIds[p], amount));
    } else if (action == 7) {
      target = address(manager);
      data = abi.encodeCall(LiquidityManager.migrateReserves, (attacker, amount));
    } else {
      caller = fundingOperator;
      target = address(manager);
      data = abi.encodeCall(LiquidityManager.setFundingOperator, (attacker, true));
    }

    vm.prank(caller);
    (bool ok,) = target.call(data);
    if (ok) _violate("attacker: privileged call succeeded");
  }

  // ================================================================
  // │                     Views for invariants                     │
  // ================================================================

  function budget(uint256 b) public view returns (ILiquidityManager.BudgetState memory) {
    if (b == AGG) return manager.getAggregateFundingBudget();
    if (b == RECALL) return manager.getRecallBudget();
    return manager.getPoolFundingBudget(address(s_pools[b - 1]));
  }

  function modelAvailable(uint256 b) public view returns (uint256) {
    ModelBucket storage m = s_model[b];
    return _refillRef(m.capacity, m.tokens, block.timestamp - m.lastUpdated, m.rate);
  }

  function poolAt(uint256 p) external view returns (MockLockReleaseTokenPool) {
    return s_pools[p];
  }

  function adapterId(uint256 p) external view returns (uint256) {
    return s_adapterIds[p];
  }

  function adapterCount() external view returns (uint256) {
    return s_adapters.length;
  }

  function adapterAt(uint256 i) external view returns (address) {
    return s_adapters[i];
  }

  function rejectedAdapterCount() external view returns (uint256) {
    return s_rejectedAdapters.length;
  }

  function rejectedAdapterAt(uint256 i) external view returns (address) {
    return s_rejectedAdapters[i];
  }

  /// @notice Never-registered pool address `i`, used for unconfigured-budget probes.
  function probeAt(uint256 i) public pure returns (address) {
    return address(uint160(uint256(keccak256(abi.encode("LiquidityHandler.probe", i)))));
  }

  /// @notice Independent prediction of the Manager's migration destination check.
  /// @notice Destinations `migrateReserves` must reject: the Manager, the token, every adapter ever registered, every
  /// pool the Manager knows (registered, with a spec or a migration approval) or the TokenAdminRegistry maps the token
  /// to, and any contract reporting the Manager as its `MANAGER()` (e.g. adapters that failed replacement).
  function isForbiddenMigrationDestination(address to) public view returns (bool) {
    if (to == address(manager) || to == address(token) || to == address(s_pools[0]) || to == address(s_pools[1])) {
      return true;
    }
    for (uint256 i = 0; i < s_adapters.length; ++i) {
      if (to == s_adapters[i]) return true;
    }
    if (to == registry.getPool(address(token))) return true;
    (, bool specSet) = manager.getPoolSpec(to);
    if (specSet || manager.getPoolMigrationSource(to) != address(0)) return true;
    if (to.code.length != 0) {
      (bool ok, bytes memory data) = to.staticcall(abi.encodeWithSignature("MANAGER()"));
      if (ok && data.length >= 32 && abi.decode(data, (uint256)) == uint256(uint160(address(manager)))) return true;
    }
    return false;
  }

  /// @notice Expected `verifyHandover` revert data from the registry and token state, or empty if it must pass.
  function handoverError() public view returns (bytes memory) {
    ITokenAdminRegistry.TokenConfig memory config = registry.getTokenConfig(address(token));
    if (config.administrator != timelock) {
      return abi.encodeWithSelector(ILiquidityManager.RegistryAdminMismatch.selector, config.administrator);
    }
    if (config.pendingAdministrator != address(0)) {
      return
        abi.encodeWithSelector(ILiquidityManager.RegistryAdminTransferPending.selector, config.pendingAdministrator);
    }
    address tokenOwner = token.owner();
    if (tokenOwner != timelock) {
      return abi.encodeWithSelector(ILiquidityManager.TokenOwnerMismatch.selector, tokenOwner);
    }
    return "";
  }

  // ================================================================
  // │                          Internal                            │
  // ================================================================

  /// @dev Registry check of `_verifyPool`: the registry maps the token to the pool, or to the source pool the
  /// migration approval was granted under.
  function _fundable(uint256 p) internal view returns (bool) {
    address registryPool = registry.getPool(address(token));
    address source = ghostMigrationSource[p];
    return registryPool == address(s_pools[p]) || (source != address(0) && registryPool == source);
  }

  /// @dev Expected `replaceAdapter` revert data: handover first, then the registry check (every other pool check
  /// passes by construction), or empty if it must succeed.
  /// @dev `replaceAdapter` runs the pool checks only (no handover check), so only an inactive pool rejects it.
  function _replacementError(uint256 p) internal view returns (bytes memory expected) {
    if (!_fundable(p)) {
      expected = abi.encodeWithSelector(
        ILiquidityManager.PoolNotActiveInRegistry.selector, address(s_pools[p]), registry.getPool(address(token))
      );
    }
  }

  function _checkReplacement(
    uint256 p,
    uint256 id,
    address fresh,
    ILiquidityManager.Adapter memory before,
    Snapshot memory snapshotBefore
  ) internal {
    address pool = address(s_pools[p]);
    ILiquidityManager.Adapter memory entry = manager.getAdapter(id);
    if (
      entry.adapter != fresh || entry.pool != pool || entry.fundingEnabled != before.fundingEnabled
        || entry.recallEnabled != before.recallEnabled
    ) _violate("replaceAdapter: registry entry not carried over");
    if (manager.adapterIdByPool(pool) != id) _violate("replaceAdapter: pool id changed");
    if (!manager.isRegisteredAdapter(before.adapter) || !manager.isRegisteredAdapter(fresh)) {
      _violate("replaceAdapter: adapter history lost an adapter");
    }
    Snapshot memory snapshotAfter = _snapshot();
    for (uint256 b = 0; b < BUCKETS; ++b) {
      if (snapshotAfter.available[b] != snapshotBefore.available[b]) _violate("replaceAdapter: budget changed");
    }
  }

  function _migrationSourceChoice(uint256 p, uint256 seed) internal view returns (address) {
    uint256 kind = seed % 4;
    if (kind == 0) return address(0);
    if (kind == 2) return address(foreignPool);
    return address(s_pools[1 - p]);
  }

  function _migrationDestination(uint256 seed, address raw) internal view returns (address) {
    uint256 kind = seed % 10;
    uint256 sub = seed / 10;
    if (kind == 0) return address(manager);
    if (kind == 1) return address(token);
    if (kind == 2) return s_adapters[sub % s_adapters.length];
    if (kind == 3) return manager.getAdapter(s_adapterIds[sub % 2]).adapter;
    if (kind == 4) return address(s_pools[sub % 2]);
    if (kind == 5) return address(0);
    if (kind == 6) return address(foreignPool);
    if (kind == 7) return raw;
    return migrationRecipient;
  }

  function _migrationAmount(uint256 seed, uint256 balance) internal pure returns (uint256) {
    uint256 mode = seed % 8;
    if (mode == 0) return type(uint256).max;
    if (mode == 1) return 0;
    if (mode == 2) return balance + 1 + (seed / 8) % 1e24;
    return balance == 0 ? 1 : bound(seed, 1, Math.min(balance, 20_000_000e18));
  }

  /// @dev Expected `migrateReserves` revert data (empty if it must succeed) and the amount it moves.
  function _migrationOutcome(address to, uint256 amount, uint256 balance)
    internal
    view
    returns (bytes memory expected, uint256 effective)
  {
    if (to == address(0)) return (abi.encodeWithSelector(ILiquidityManager.ZeroAddress.selector), 0);
    if (isForbiddenMigrationDestination(to)) {
      return (abi.encodeWithSelector(ILiquidityManager.InvalidMigrationDestination.selector, to), 0);
    }
    effective = amount == type(uint256).max ? balance : amount;
    if (effective == 0) return (abi.encodeWithSelector(ILiquidityManager.ZeroAmount.selector), 0);
    if (effective > balance) {
      expected =
        abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(manager), balance, effective);
    }
  }

  /// @dev Consumes the recorded logs and returns those emitted by the Manager, in order.
  function _managerLogs() internal view returns (Vm.Log[] memory managerLogs) {
    Vm.Log[] memory logs = vm.getRecordedLogs();
    uint256 count;
    for (uint256 i = 0; i < logs.length; ++i) {
      if (logs[i].emitter == address(manager)) ++count;
    }
    managerLogs = new Vm.Log[](count);
    count = 0;
    for (uint256 i = 0; i < logs.length; ++i) {
      if (logs[i].emitter == address(manager)) managerLogs[count++] = logs[i];
    }
  }

  /// @dev A successful Guardian call emits exactly one `GuardianAction(guardian, selector)`, first, followed by at
  /// least one configuration event.
  function _checkGuardianActionFirst(Vm.Log[] memory logs, address guardian_, bytes4 selector) internal {
    if (
      logs.length < 2 || logs[0].topics.length != 3 || logs[0].topics[0] != ILiquidityManager.GuardianAction.selector
        || logs[0].topics[1] != bytes32(uint256(uint160(guardian_))) || logs[0].topics[2] != bytes32(selector)
    ) {
      _violate("guardian: GuardianAction not emitted first, before a configuration event");
      return;
    }
    for (uint256 i = 1; i < logs.length; ++i) {
      if (logs[i].topics.length != 0 && logs[i].topics[0] == ILiquidityManager.GuardianAction.selector) {
        _violate("guardian: GuardianAction emitted more than once");
      }
    }
  }

  function _checkFund(uint256 p, address adapter, uint256 amount, Snapshot memory before) internal {
    Snapshot memory current = _snapshot();
    if (current.manager != before.manager - amount) _violate("fund: Manager not debited exactly amount");
    if (current.pools[p] != before.pools[p] + amount) _violate("fund: pool not credited exactly amount");
    if (current.pools[1 - p] != before.pools[1 - p]) _violate("fund: other pool balance changed");
    if (token.balanceOf(adapter) != ghostDust[adapter]) _violate("fund: adapter balance changed");
    if (token.allowance(adapter, address(s_pools[p])) != 0) _violate("fund: adapter allowance left non-zero");
    if (current.available[AGG] != before.available[AGG] - amount) _violate("fund: aggregate budget not debited");
    if (current.available[1 + p] != before.available[1 + p] - amount) _violate("fund: pool budget not debited");
    if (current.available[2 - p] != before.available[2 - p]) _violate("fund: other pool budget changed");
    if (current.available[RECALL] != before.available[RECALL]) _violate("fund: recall budget changed");

    ghostFunded += amount;
    fundedTo[p] += amount;
    _recordConsumption(AGG, amount);
    _recordConsumption(1 + p, amount);
  }

  function _checkRecall(uint256 p, address adapter, uint256 amount, uint256 minimum, Snapshot memory before) internal {
    Snapshot memory current = _snapshot();
    if (current.pools[p] < minimum) _violate("recall: left the pool below its minimum");
    if (current.manager != before.manager + amount) _violate("recall: Manager not credited exactly amount");
    if (current.pools[p] != before.pools[p] - amount) _violate("recall: pool not debited exactly amount");
    if (current.pools[1 - p] != before.pools[1 - p]) _violate("recall: other pool balance changed");
    if (token.balanceOf(adapter) != ghostDust[adapter]) _violate("recall: adapter balance changed");
    if (
      current.available[AGG] != before.available[AGG] || current.available[BUDGET_A] != before.available[BUDGET_A]
        || current.available[BUDGET_B] != before.available[BUDGET_B]
    ) _violate("recall: changed a funding budget");
    if (current.available[RECALL] != before.available[RECALL] - amount) _violate("recall: recall budget not debited");

    ghostRecalled += amount;
    recalledFrom[p] += amount;
    _recordConsumption(RECALL, amount);
  }

  function _snapshot() internal view returns (Snapshot memory s) {
    s.manager = token.balanceOf(address(manager));
    s.pools[0] = token.balanceOf(address(s_pools[0]));
    s.pools[1] = token.balanceOf(address(s_pools[1]));
    for (uint256 b = 0; b < BUCKETS; ++b) {
      s.available[b] = budget(b).available;
    }
  }

  function _minimum(address pool) internal view returns (uint256) {
    (ILiquidityManager.PoolThresholds memory thresholds,) = manager.getPoolThresholds(pool);
    return thresholds.minimum;
  }

  function _limits() internal view returns (Limits memory l) {
    l.fundingPaused = manager.fundingPaused();
    l.recallPaused = manager.recallPaused();
    l.fundingRole = manager.isFundingOperator(fundingOperator);
    l.recallRole = manager.isRecallOperator(recallOperator);
    for (uint256 p = 0; p < 2; ++p) {
      address pool_ = address(s_pools[p]);
      ILiquidityManager.Adapter memory entry = manager.getAdapter(s_adapterIds[p]);
      l.fundingEnabled[p] = entry.fundingEnabled;
      l.recallEnabled[p] = entry.recallEnabled;
      l.adapter[p] = entry.adapter;
      l.adapterPool[p] = entry.pool;
      l.migrationSource[p] = manager.getPoolMigrationSource(pool_);
      (ILiquidityManager.PoolThresholds memory thresholds,) = manager.getPoolThresholds(pool_);
      l.minimum[p] = thresholds.minimum;
      l.refillTrigger[p] = thresholds.refillTrigger;
      l.refillTarget[p] = thresholds.refillTarget;
    }
    l.maxFunding = manager.maxFundingPerCall();
    l.maxRecall = manager.maxRecallPerCall();
    for (uint256 b = 0; b < BUCKETS; ++b) {
      ILiquidityManager.BudgetState memory state = budget(b);
      l.capacity[b] = state.capacity;
      l.rate[b] = state.rate;
      l.available[b] = state.available;
    }
    l.guardian = manager.guardian();
    l.owner = manager.owner();
  }

  function _checkNotLooser(Limits memory b, Limits memory a) internal {
    if (b.fundingPaused && !a.fundingPaused) _violate("guardian: unpaused funding");
    if (b.recallPaused && !a.recallPaused) _violate("guardian: unpaused recall");
    if (!b.fundingRole && a.fundingRole) _violate("guardian: granted the funding role");
    if (!b.recallRole && a.recallRole) _violate("guardian: granted the recall role");
    for (uint256 p = 0; p < 2; ++p) {
      if (!b.fundingEnabled[p] && a.fundingEnabled[p]) _violate("guardian: re-enabled adapter funding");
      if (!b.recallEnabled[p] && a.recallEnabled[p]) _violate("guardian: re-enabled adapter recall");
      if (a.migrationSource[p] != b.migrationSource[p] && a.migrationSource[p] != address(0)) {
        _violate("guardian: approved or rebound a migration");
      }
      if (a.adapter[p] != b.adapter[p] || a.adapterPool[p] != b.adapterPool[p]) {
        _violate("guardian: changed the adapter registry");
      }
      if (a.minimum[p] < b.minimum[p]) _violate("guardian: lowered a pool minimum");
      if (a.refillTrigger[p] != b.refillTrigger[p] || a.refillTarget[p] != b.refillTarget[p]) {
        _violate("guardian: changed refill trigger or target");
      }
    }
    if (a.maxFunding > b.maxFunding) _violate("guardian: raised max funding per call");
    if (a.maxRecall > b.maxRecall) _violate("guardian: raised max recall per call");
    for (uint256 i = 0; i < BUCKETS; ++i) {
      if (a.capacity[i] > b.capacity[i]) _violate("guardian: raised a budget capacity");
      if (a.rate[i] > b.rate[i]) _violate("guardian: raised a budget rate");
      if (a.available[i] > b.available[i]) _violate("guardian: restored budget usage");
    }
    if (a.guardian != b.guardian) _violate("guardian: changed the guardian");
    if (a.owner != b.owner) _violate("guardian: changed the owner");
  }

  function _guardianCall(uint256 action, uint256 a, uint256 b, uint256 c)
    internal
    view
    returns (bytes memory data, uint256 bucket, uint256 capacity, uint256 rate)
  {
    bucket = NO_BUCKET;
    uint256 p = c % 2;
    address pool_ = address(s_pools[p]);
    if (action == 0) {
      data = abi.encodeCall(LiquidityManager.pauseFunding, ());
    } else if (action == 1) {
      data = abi.encodeCall(LiquidityManager.pauseRecall, ());
    } else if (action == 2) {
      data = abi.encodeCall(LiquidityManager.suspendFundingOperator, (a % 3 == 0 ? attacker : fundingOperator));
    } else if (action == 3) {
      data = abi.encodeCall(LiquidityManager.suspendRecallOperator, (a % 3 == 0 ? attacker : recallOperator));
    } else if (action == 4) {
      uint256 id = a % 5 == 0 ? 3 + (a % 7) : s_adapterIds[p];
      data = abi.encodeCall(LiquidityManager.restrictAdapter, (id, b % 2 == 0, (b / 2) % 2 == 0));
    } else if (action == 5) {
      data = abi.encodeCall(LiquidityManager.revokePoolMigrationApproval, (pool_));
    } else if (action == 6) {
      data = abi.encodeCall(LiquidityManager.reduceMaxFundingPerCall, (_near(manager.maxFundingPerCall(), a)));
    } else if (action == 7) {
      ILiquidityManager.BudgetState memory state = budget(AGG);
      (bucket, capacity, rate) = (AGG, _near(state.capacity, a), _near(state.rate, b));
      data = abi.encodeCall(LiquidityManager.reduceAggregateFundingBudget, (capacity, rate));
    } else if (action == 8) {
      bucket = 1 + p;
      ILiquidityManager.BudgetState memory state = budget(bucket);
      (capacity, rate) = (_near(state.capacity, a), _near(state.rate, b));
      data = abi.encodeCall(LiquidityManager.reducePoolFundingBudget, (pool_, capacity, rate));
    } else if (action == 9) {
      ILiquidityManager.BudgetState memory state = budget(RECALL);
      (bucket, capacity, rate) = (RECALL, _near(state.capacity, b), _near(state.rate, c));
      data = abi.encodeCall(LiquidityManager.reduceRecallLimits, (_near(manager.maxRecallPerCall(), a), capacity, rate));
    } else if (action == 10) {
      data = abi.encodeCall(LiquidityManager.raisePoolMinimum, (pool_, _near(_minimum(pool_), a)));
    } else {
      data = _ownerOnlyCall(a, p);
    }
  }

  function _ownerCall(uint256 action, uint256 a, uint256 b, uint256 c)
    internal
    view
    returns (bytes memory data, uint256 bucket, uint256 capacity, uint256 rate, uint256 value)
  {
    bucket = NO_BUCKET;
    uint256 p = c % 2;
    address pool = address(s_pools[p]);
    if (action == 0) {
      data = abi.encodeCall(LiquidityManager.setFundingPaused, (a % 4 == 0));
    } else if (action == 1) {
      data = abi.encodeCall(LiquidityManager.setRecallPaused, (a % 4 == 0));
    } else if (action == 2) {
      data = abi.encodeCall(LiquidityManager.setFundingOperator, (fundingOperator, a % 4 != 0));
    } else if (action == 3) {
      data = abi.encodeCall(LiquidityManager.setRecallOperator, (recallOperator, a % 4 != 0));
    } else if (action == 4) {
      data = abi.encodeCall(LiquidityManager.setAdapterStatus, (s_adapterIds[p], a % 4 != 0, b % 4 != 0));
    } else if (action == 5) {
      value = _ownerValue(s_initialMaxFunding, a);
      data = abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (value));
    } else if (action == 6) {
      (bucket, capacity, rate) = (AGG, _ownerValue(s_initialCapacity[AGG], a), _ownerValue(s_initialRate[AGG], b));
      data = abi.encodeCall(LiquidityManager.setAggregateFundingBudget, (capacity, rate));
    } else if (action == 7) {
      bucket = 1 + p;
      (capacity, rate) = (_ownerValue(s_initialCapacity[bucket], a), _ownerValue(s_initialRate[bucket], b));
      data = abi.encodeCall(LiquidityManager.setPoolFundingBudget, (pool, capacity, rate));
    } else if (action == 8) {
      value = _ownerValue(s_initialMaxRecall, a);
      (bucket, capacity, rate) =
        (RECALL, _ownerValue(s_initialCapacity[RECALL], b), _ownerValue(s_initialRate[RECALL], c));
      data = abi.encodeCall(LiquidityManager.setRecallLimits, (value, capacity, rate));
    } else if (action == 9) {
      value = bound(a, 0, 60_000_000e18);
      uint256 trigger = value + bound(b, 0, 50_000_000e18);
      uint256 target = trigger + bound(c, 0, 50_000_000e18);
      data = abi.encodeCall(LiquidityManager.setPoolThresholds, (pool, value, trigger, target));
    } else if (action == 10) {
      data = abi.encodeCall(LiquidityManager.setPoolMigrationApproval, (pool, _migrationSourceChoice(p, a)));
    } else {
      address next = manager.guardian() == guardianA ? guardianB : guardianA;
      data = abi.encodeCall(LiquidityManager.setGuardian, (next));
    }
  }

  function _ownerOnlyCall(uint256 seed, uint256 p) internal view returns (bytes memory) {
    uint256 kind = seed % 10;
    if (kind == 0) return abi.encodeCall(LiquidityManager.setFundingPaused, (false));
    if (kind == 1) return abi.encodeCall(LiquidityManager.setRecallPaused, (false));
    if (kind == 2) return abi.encodeCall(LiquidityManager.setMaxFundingPerCall, (type(uint256).max));
    if (kind == 3) {
      return abi.encodeCall(LiquidityManager.setAggregateFundingBudget, (type(uint256).max, type(uint256).max));
    }
    if (kind == 4) return abi.encodeCall(LiquidityManager.setGuardian, (attacker));
    if (kind == 5) return abi.encodeCall(LiquidityManager.setAdapterStatus, (s_adapterIds[p], true, true));
    if (kind == 6) return abi.encodeCall(LiquidityManager.migrateReserves, (attacker, 1));
    if (kind == 7) {
      return abi.encodeCall(LiquidityManager.setPoolMigrationApproval, (address(s_pools[p]), address(s_pools[1 - p])));
    }
    if (kind == 8) return abi.encodeCall(LiquidityManager.setFundingOperator, (attacker, true));
    return abi.encodeCall(LiquidityManager.setPoolThresholds, (address(s_pools[p]), 0, 0, 0));
  }

  /// @dev After a successful (re)configuration of bucket `b`: check usage was not reset, update the reference model
  /// and open a new constant-configuration window.
  function _onConfigured(uint256 b, uint256 capacity, uint256 rate, uint256 availableBefore) internal {
    ILiquidityManager.BudgetState memory state = budget(b);
    if (state.capacity != capacity || state.rate != rate) _violate("config: budget parameters not applied");
    if (state.available != Math.min(availableBefore, capacity)) {
      _violate("config: reconfiguration changed usage (expected min(available, capacity))");
    }

    ModelBucket storage m = s_model[b];
    m.tokens = Math.min(modelAvailable(b), capacity);
    m.capacity = capacity;
    m.rate = rate;
    m.lastUpdated = block.timestamp;

    s_window[b] = Window(block.timestamp, state.available, capacity, rate, 0, s_log[b].length);
    if (capacity > maxCapacityEver[b]) maxCapacityEver[b] = capacity;
    if (rate > maxRateEver[b]) maxRateEver[b] = rate;
  }

  /// @dev Records a successful consumption of bucket `b` and checks the capacity/refill envelopes:
  /// - reference model: the amount was available;
  /// - current window: consumed <= tokensAtStart + rate * (now - start);
  /// - every sub-window [t_i, now] of the current window: consumed <= capacity + rate * (now - t_i);
  /// - every sub-window [t_i, now] over the whole run: consumed <= max capacity + max rate * (now - t_i).
  function _recordConsumption(uint256 b, uint256 amount) internal {
    uint256 modelTokens = modelAvailable(b);
    if (amount > modelTokens) _violate("budget: consumed more than the reference model allows");
    ModelBucket storage m = s_model[b];
    m.tokens = amount > modelTokens ? 0 : modelTokens - amount;
    m.lastUpdated = block.timestamp;

    Window storage w = s_window[b];
    w.consumed += amount;
    if (w.consumed > _envelope(w.tokensAtStart, w.rate, block.timestamp - w.start)) {
      _violate("budget: window consumption exceeds tokensAtStart + rate * elapsed");
    }

    Consumption[] storage log = s_log[b];
    log.push(Consumption(block.timestamp, amount));
    uint256 sum;
    for (uint256 i = log.length; i > 0; --i) {
      Consumption storage entry = log[i - 1];
      sum += entry.amount;
      uint256 elapsed = block.timestamp - entry.time;
      if (i - 1 >= w.firstEntry && sum > _envelope(w.capacity, w.rate, elapsed)) {
        _violate("budget: sub-window consumption exceeds capacity + rate * elapsed");
      }
      if (sum > _envelope(maxCapacityEver[b], maxRateEver[b], elapsed)) {
        _violate("budget: consumption exceeds max capacity + max rate * elapsed");
      }
    }
  }

  function _envelope(uint256 base, uint256 rate, uint256 elapsed) internal pure returns (uint256) {
    return Math.saturatingAdd(base, Math.saturatingMul(rate, elapsed));
  }

  function _refillRef(uint256 capacity, uint256 tokens, uint256 elapsed, uint256 rate) internal pure returns (uint256) {
    (bool mulOk, uint256 added) = Math.tryMul(elapsed, rate);
    if (!mulOk) return capacity;
    (bool addOk, uint256 total) = Math.tryAdd(tokens, added);
    if (!addOk || total > capacity) return capacity;
    return total;
  }

  function _pickAmount(uint256 maxAllowed, uint256 seed, uint256 mode) internal pure returns (uint256) {
    mode %= 10;
    if (mode < 6) return maxAllowed == 0 ? bound(seed, 1, 1_000_000e18) : bound(seed, 1, maxAllowed);
    if (mode == 6) return maxAllowed;
    if (mode == 7) return maxAllowed == type(uint256).max ? maxAllowed : maxAllowed + 1;
    if (mode == 8) return bound(seed, 1, 100_000_000e18);
    return seed;
  }

  /// @dev Guardian parameter around the current value: equal, lower, zero, slightly higher (a loosening attempt) or
  /// arbitrary.
  function _near(uint256 current, uint256 seed) internal pure returns (uint256) {
    uint256 kind = seed % 6;
    if (kind == 0) return current;
    if (kind == 1) return current / 2;
    if (kind == 2) return current == 0 ? 0 : (seed / 6) % current;
    if (kind == 3) return 0;
    if (kind == 4) return Math.saturatingAdd(current, 1 + ((seed / 6) % 1e24));
    return seed;
  }

  /// @dev Owner parameter: the initial value (a restoration) or anything up to twice it.
  function _ownerValue(uint256 initial, uint256 seed) internal pure returns (uint256) {
    if (seed % 3 == 0) return initial;
    return bound(seed, 0, initial * 2);
  }

  function _violate(string memory reason) internal {
    if (violations == 0) firstViolation = reason;
    ++violations;
  }
}
