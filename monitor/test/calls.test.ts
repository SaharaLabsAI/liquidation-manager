import {concat, encodeAbiParameters, encodeFunctionData, maxUint256, parseUnits, type Hex} from "viem";
import {describe, expect, it} from "vitest";

import {saharaTokenAbi, tokenAdminRegistryAbi, tokenPoolAbi} from "../src/abi/external.ts";
import {liquidityManagerAbi, saharaTimelockAbi} from "../src/abi/generated.ts";
import {
  classifyCall,
  decodeCall,
  isProtectedSetGuardian,
  roleName,
  TIMELOCK_ROLES,
  unprotectedSetGuardianReason,
} from "../src/rules/calls.ts";
import {BSC_SELECTOR, TL, tlAddresses} from "./helpers/timelock-fixtures.ts";

const addresses = tlAddresses();
const units = (whole: string) => parseUnits(whole, 18);
const setGuardian = encodeFunctionData({abi: liquidityManagerAbi, functionName: "setGuardian", args: [TL.newGuardian]});
/** setGuardian with non-zero upper bits in the address word. */
const dirtySetGuardian = `${setGuardian.slice(0, 10)}ff${setGuardian.slice(12)}` as Hex;

describe("isProtectedSetGuardian", () => {
  it("accepts exactly the canonical standalone call", () => {
    expect(isProtectedSetGuardian(TL.manager, 0n, setGuardian, TL.manager)).toBe(true);
    // Address comparison is case-insensitive.
    expect(isProtectedSetGuardian(TL.manager.toLowerCase() as Hex, 0n, setGuardian, TL.manager)).toBe(true);
  });

  it("rejects everything GuardianController.isProtectedCall rejects", () => {
    expect(isProtectedSetGuardian(TL.manager, 0n, concat([setGuardian, "0x00"]), TL.manager)).toBe(false); // 37 bytes
    expect(isProtectedSetGuardian(TL.manager, 0n, setGuardian.slice(0, -2) as Hex, TL.manager)).toBe(false); // 35
    expect(isProtectedSetGuardian(TL.manager, 1n, setGuardian, TL.manager)).toBe(false);
    expect(isProtectedSetGuardian(TL.manager, 0n, dirtySetGuardian, TL.manager)).toBe(false);
    expect(isProtectedSetGuardian(TL.pool, 0n, setGuardian, TL.manager)).toBe(false);
    expect(isProtectedSetGuardian(TL.manager, 0n, setGuardian, undefined)).toBe(false);
    const other = encodeFunctionData({
      abi: liquidityManagerAbi,
      functionName: "transferOwnership",
      args: [TL.stranger],
    });
    expect(isProtectedSetGuardian(TL.manager, 0n, other, TL.manager)).toBe(false);
  });

  it("explains why a setGuardian is not protected", () => {
    expect(unprotectedSetGuardianReason(TL.manager, 0n, setGuardian, TL.manager)).toBeNull();
    expect(unprotectedSetGuardianReason(TL.manager, 0n, concat([setGuardian, "0x00"]), TL.manager)).toMatch(
      /37 bytes, not 36/,
    );
    expect(unprotectedSetGuardianReason(TL.manager, 5n, setGuardian, TL.manager)).toMatch(/carries value/);
    expect(unprotectedSetGuardianReason(TL.manager, 0n, dirtySetGuardian, TL.manager)).toMatch(/upper bits/);
    expect(unprotectedSetGuardianReason(TL.pool, 0n, setGuardian, TL.manager)).toMatch(/not the Manager/);
    expect(unprotectedSetGuardianReason(TL.manager, 0n, "0x12345678", TL.manager)).toBeNull();
  });
});

describe("decodeCall", () => {
  it("labels the protected setGuardian", () => {
    const call = decodeCall(TL.manager, 0n, setGuardian, addresses);
    expect(call.summary).toBe(`LiquidityManager.setGuardian(newGuardian=${TL.newGuardian})`);
    expect(call).toMatchObject({kind: "manager", contract: "LiquidityManager", fn: "setGuardian"});
    expect(call.severity).toBe("critical");
    expect(call.protected).toBe(true);
    expect(call.notes).toEqual([]);

    const labelled = decodeCall(
      TL.manager,
      0n,
      encodeFunctionData({abi: liquidityManagerAbi, functionName: "setGuardian", args: [TL.guardian]}),
      addresses,
    );
    expect(labelled.summary).toBe(`LiquidityManager.setGuardian(newGuardian=Guardian ${TL.guardian})`);
  });

  it("flags padded, dirty and short setGuardian calldata", () => {
    const padded = decodeCall(TL.manager, 0n, concat([setGuardian, "0x00"]), addresses);
    expect(padded.protected).toBe(false);
    expect(padded.severity).toBe("critical");
    expect(padded.notes.join(" ")).toMatch(/Non-canonical calldata: 37 bytes, canonical encoding is 36 bytes/);

    const dirty = decodeCall(TL.manager, 0n, dirtySetGuardian, addresses);
    expect(dirty.protected).toBe(false);
    expect(dirty.notes.join(" ")).toMatch(/Non-canonical calldata: 36 bytes/);

    const short = decodeCall(TL.manager, 0n, setGuardian.slice(0, -2) as Hex, addresses);
    expect(short.protected).toBe(false);
    expect(short.fn).toBe("setGuardian");
    expect(short.summary).toBe("LiquidityManager.setGuardian(<malformed arguments: 31 bytes>)");
    expect(short.notes.join(" ")).toMatch(/would revert at execution/);

    const withValue = decodeCall(TL.manager, 10n ** 18n, setGuardian, addresses);
    expect(withValue.protected).toBe(false);
    expect(withValue.summary).toContain("setGuardian{value: 1 native}(");
  });

  it("formats amounts, rates and labels", () => {
    const thresholds = decodeCall(
      TL.manager,
      0n,
      encodeFunctionData({
        abi: liquidityManagerAbi,
        functionName: "setPoolThresholds",
        args: [TL.pool, units("1000"), units("2500.5"), units("1000000")],
      }),
      addresses,
    );
    expect(thresholds.summary).toBe(
      `LiquidityManager.setPoolThresholds(pool=Pool ${TL.pool}, minimum=1,000 SAHARA, ` +
        "refillTrigger=2,500.5 SAHARA, refillTarget=1,000,000 SAHARA)",
    );
    expect(thresholds.severity).toBe("high");
    expect(thresholds.protected).toBeUndefined();

    const budget = decodeCall(
      TL.manager,
      0n,
      encodeFunctionData({
        abi: liquidityManagerAbi,
        functionName: "setAggregateFundingBudget",
        args: [units("5000000"), units("10")],
      }),
      addresses,
      {token: {symbol: "SAH", decimals: 18}},
    );
    expect(budget.summary).toBe("LiquidityManager.setAggregateFundingBudget(capacity=5,000,000 SAH, rate=10 SAH/s)");

    const migrate = decodeCall(
      TL.manager,
      0n,
      encodeFunctionData({abi: liquidityManagerAbi, functionName: "migrateReserves", args: [TL.stranger, maxUint256]}),
      addresses,
    );
    expect(migrate.summary).toBe(
      `LiquidityManager.migrateReserves(to=${TL.stranger}, amount=entire balance (type(uint256).max))`,
    );
    expect(migrate.severity).toBe("critical");

    // recoverToken moves a foreign token: base units, not SAHARA.
    const recover = decodeCall(
      TL.manager,
      0n,
      encodeFunctionData({abi: liquidityManagerAbi, functionName: "recoverToken", args: [TL.stranger, TL.safe, 1234n]}),
      addresses,
    );
    expect(recover.summary).toBe(
      `LiquidityManager.recoverToken(token=${TL.stranger}, to=Governance Safe ${TL.safe}, amount=1234)`,
    );
  });

  it("uses the caller's labeller and chain names", () => {
    const call = decodeCall(
      TL.pool,
      0n,
      encodeFunctionData({
        abi: tokenPoolAbi,
        functionName: "setChainRateLimiterConfig",
        args: [
          BSC_SELECTOR,
          {isEnabled: true, capacity: units("1000"), rate: units("1")},
          {isEnabled: false, capacity: 0n, rate: 0n},
        ],
      }),
      addresses,
      {chainName: (selector) => (selector === BSC_SELECTOR ? "bsc" : selector.toString())},
    );
    expect(call.summary).toBe(
      `Pool.setChainRateLimiterConfig(remoteChainSelector=bsc (${BSC_SELECTOR}), ` +
        "outboundConfig={isEnabled: true, capacity: 1,000 SAHARA, rate: 1 SAHARA/s}, " +
        "inboundConfig={isEnabled: false, capacity: 0 SAHARA, rate: 0 SAHARA/s})",
    );
    expect(call.severity).toBe("critical");
  });

  it("formats the pool spec struct and abi-encoded remote addresses", () => {
    const remote = encodeAbiParameters([{type: "address"}], [TL.stranger]);
    const call = decodeCall(
      TL.manager,
      0n,
      encodeFunctionData({
        abi: liquidityManagerAbi,
        functionName: "setPoolSpec",
        args: [
          TL.pool,
          {
            typeAndVersion: "LockReleaseTokenPool 1.6.3-dev",
            router: TL.router,
            remoteChainSelector: BSC_SELECTOR,
            remoteToken: remote,
            remotePools: [remote],
            rateLimitAdmin: TL.controller,
          },
        ],
      }),
      addresses,
    );
    expect(call.severity).toBe("critical");
    expect(call.summary).toContain('typeAndVersion: "LockReleaseTokenPool 1.6.3-dev"');
    expect(call.summary).toContain(`router: Router ${TL.router}`);
    expect(call.summary).toContain(`remoteToken: ${TL.stranger} (abi-encoded)`);
    expect(call.summary).toContain(`remotePools: [${TL.stranger} (abi-encoded)]`);
    expect(call.summary).toContain(`rateLimitAdmin: GuardianController ${TL.controller}`);
  });

  it("decodes pool, registry, token and Timelock calls as critical", () => {
    const pool = decodeCall(
      TL.pool,
      0n,
      encodeFunctionData({abi: tokenPoolAbi, functionName: "setRebalancer", args: [TL.adapter]}),
      addresses,
    );
    expect(pool.summary).toBe(`Pool.setRebalancer(rebalancer=Adapter #1 ${TL.adapter})`);
    expect(pool.severity).toBe("critical");

    const registry = decodeCall(
      TL.registry,
      0n,
      encodeFunctionData({abi: tokenAdminRegistryAbi, functionName: "acceptAdminRole", args: [TL.token]}),
      addresses,
    );
    expect(registry.summary).toBe(`TokenAdminRegistry.acceptAdminRole(localToken=Token ${TL.token})`);
    expect(registry.severity).toBe("critical");

    const token = decodeCall(TL.token, 0n, encodeFunctionData({abi: saharaTokenAbi, functionName: "pause"}), addresses);
    expect(token.summary).toBe("SAHARA.pause()");
    expect(token.severity).toBe("critical");

    const transfer = decodeCall(
      TL.token,
      0n,
      encodeFunctionData({abi: saharaTokenAbi, functionName: "transfer", args: [TL.stranger, units("42")]}),
      addresses,
    );
    expect(transfer.summary).toBe(`SAHARA.transfer(to=${TL.stranger}, value=42 SAHARA)`);

    const delay = decodeCall(
      TL.timelock,
      0n,
      encodeFunctionData({abi: saharaTimelockAbi, functionName: "updateDelay", args: [172800n]}),
      addresses,
      {currentDelay: 259200n},
    );
    expect(delay.summary).toBe("Timelock.updateDelay(newDelay=3d -> 2d (172800s))");
    expect(delay.severity).toBe("critical");

    const grant = decodeCall(
      TL.timelock,
      0n,
      encodeFunctionData({
        abi: saharaTimelockAbi,
        functionName: "grantRole",
        args: [TIMELOCK_ROLES.PROPOSER_ROLE as Hex, TL.stranger],
      }),
      addresses,
    );
    expect(grant.summary).toBe(`Timelock.grantRole(role=PROPOSER_ROLE, account=${TL.stranger})`);
  });

  it("raises a Manager call with value to critical", () => {
    const data = encodeFunctionData({abi: liquidityManagerAbi, functionName: "setFundingPaused", args: [true]});
    expect(decodeCall(TL.manager, 0n, data, addresses).severity).toBe("high");
    const paid = decodeCall(TL.manager, 1n, data, addresses);
    expect(paid.severity).toBe("critical");
    expect(paid.notes.join(" ")).toMatch(/native coin/);
  });

  it("reports unknown selectors and targets as unrecognised", () => {
    const selector = decodeCall(TL.manager, 0n, "0xdeadbeef00", addresses);
    expect(selector).toMatchObject({fn: "unrecognised", selector: "0xdeadbeef", severity: "critical"});
    expect(selector.summary).toBe("LiquidityManager: unrecognised call (selector 0xdeadbeef, 5 bytes)");

    const target = decodeCall(
      TL.stranger,
      0n,
      encodeFunctionData({abi: tokenPoolAbi, functionName: "acceptOwnership"}),
      addresses,
    );
    expect(target.kind).toBe("unknown");
    expect(target.severity).toBe("critical");
    expect(target.summary).toBe(`unrecognised call to ${TL.stranger}: acceptOwnership()`);

    const empty = decodeCall(TL.safe, 5n, "0x", addresses);
    expect(empty.summary).toBe(
      "Governance Safe{value: 0.000000000000000005 native}: unrecognised call (plain transfer, no calldata, 0 bytes)",
    );
    expect(empty.severity).toBe("critical");

    const junk = decodeCall(TL.stranger, 0n, "0xdeadbeef", addresses);
    expect(junk.summary).toBe(`${TL.stranger}: unrecognised call (selector 0xdeadbeef, 4 bytes)`);
  });

  it("treats a Manager call as unknown when no Manager is resolved", () => {
    const call = decodeCall(TL.manager, 0n, setGuardian, tlAddresses({manager: undefined}));
    expect(call.kind).toBe("unknown");
    expect(call.severity).toBe("critical");
    expect(call.protected).toBe(false);
  });
});

describe("classification", () => {
  it("matches the spec", () => {
    for (const fn of ["setGuardian", "migrateReserves", "registerAdapter", "setFundingOperator", "setRecallOperator"]) {
      expect(classifyCall("manager", fn)).toBe("critical");
    }
    expect(classifyCall("manager", "setPoolThresholds")).toBe("high");
    expect(classifyCall("manager", "setRecallLimits")).toBe("high");
    expect(classifyCall("pool", "setRouter")).toBe("critical");
    expect(classifyCall("registry", "setPool")).toBe("critical");
    expect(classifyCall("timelock", "updateDelay")).toBe("critical");
  });

  it("names roles", () => {
    expect(roleName("0x0000000000000000000000000000000000000000000000000000000000000000")).toBe("DEFAULT_ADMIN_ROLE");
    expect(roleName(TIMELOCK_ROLES.CANCELLER_ROLE as Hex)).toBe("CANCELLER_ROLE");
    expect(roleName(TIMELOCK_ROLES.EXECUTOR_ROLE as Hex)).toBe("EXECUTOR_ROLE");
    // keccak256("PROPOSER_ROLE")
    expect(TIMELOCK_ROLES.PROPOSER_ROLE).toBe("0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1");
  });
});
