import {zeroAddress, type Address} from "viem";
import {describe, expect, it} from "vitest";

import {labelFor, makeLabeler, resolveAddresses} from "../src/chain/addresses.ts";
import type {Logger} from "../src/log.ts";
import {silentLogger} from "../src/log.ts";
import {addr, chainConfig, createContractClient, type FakeResult} from "./helpers/chain-fakes.ts";

const BLOCK = 1234n;

const TOKEN = addr(0x10);
const REGISTRY = addr(0x11);
const MANAGER = addr(0x12);
const TIMELOCK = addr(0x13);
const CONTROLLER = addr(0x14);
const ROUTER = addr(0x15);
const POOL_A = addr(0x20);
const POOL_B = addr(0x21);
const OLD_POOL = addr(0x22);
const ADAPTER_1 = addr(0x30);
const ADAPTER_2 = addr(0x31);
const OLD_ADAPTER = addr(0x32);
const GUARDIAN = addr(0x40);
const SAFE = addr(0x41);
const FUND_OP = addr(0x42);
const RECALL_OP = addr(0x43);
const LEGACY_1 = addr(0x50);
const LEGACY_2 = addr(0x51);
const EXTRA = addr(0x52);

const spec = (rateLimitAdmin: Address) => ({
  typeAndVersion: "LockReleaseTokenPool 1.6.3-dev",
  router: ROUTER,
  remoteChainSelector: 1n,
  remoteToken: "0x",
  remotePools: [],
  rateLimitAdmin,
});

function registryFake(pool: Address): Record<string, FakeResult> {
  return {getPool: ([token]) => (token === TOKEN ? pool : zeroAddress)};
}

/** Manager with adapters #1 (POOL_A, replaced once) and #2 (POOL_B, funding disabled). */
function managerFake(overrides: Record<string, FakeResult> = {}): Record<string, FakeResult> {
  const adapters = new Map([
    [1n, {adapter: ADAPTER_1, pool: POOL_A, fundingEnabled: true, recallEnabled: true}],
    [2n, {adapter: ADAPTER_2, pool: POOL_B, fundingEnabled: false, recallEnabled: true}],
  ]);
  return {
    owner: TIMELOCK,
    TOKEN,
    TOKEN_ADMIN_REGISTRY: REGISTRY,
    adapterCount: 2n,
    getAdapterHistory: [OLD_ADAPTER, ADAPTER_2, ADAPTER_1],
    guardian: GUARDIAN,
    getAdapter: ([id]) => adapters.get(id as bigint) ?? new Error("UnknownAdapter"),
    getPoolSpec: ([pool]) =>
      pool === POOL_A || pool === POOL_B ? [spec(CONTROLLER), true] : [spec(zeroAddress), false],
    ...overrides,
  };
}

const roles = {
  guardian: GUARDIAN,
  governanceSafe: SAFE,
  fundingOperators: [FUND_OP],
  recallOperators: [RECALL_OP],
};

function capturingLogger(): Logger & {warnings: string[]} {
  const warnings: string[] = [];
  return {...silentLogger, warn: (message: string) => void warnings.push(message), warnings};
}

describe("resolveAddresses with a Manager", () => {
  const chain = chainConfig({
    contracts: {token: TOKEN, registry: REGISTRY, manager: MANAGER, pool: POOL_A},
    reserves: {legacyWallets: [LEGACY_1, LEGACY_2], extraPools: [OLD_POOL, POOL_B], extraEndpoints: [EXTRA]},
    expected: roles,
  });

  it("discovers adapters, pools, timelock, controller and router at the block", async () => {
    const fake = createContractClient(
      {[REGISTRY]: registryFake(POOL_A), [MANAGER]: managerFake(), [POOL_A]: {getRouter: ROUTER}},
      BLOCK,
    );
    const resolved = await resolveAddresses(fake.client, chain, BLOCK);

    expect(fake.calls.every((call) => call.blockNumber === BLOCK)).toBe(true);
    expect(resolved).toMatchObject({
      token: TOKEN,
      registry: REGISTRY,
      manager: MANAGER,
      timelock: TIMELOCK,
      controller: CONTROLLER,
      router: ROUTER,
      registryPool: POOL_A,
    });
    expect(resolved.adapters).toEqual([
      {id: 1n, adapter: ADAPTER_1, pool: POOL_A, fundingEnabled: true, recallEnabled: true},
      {id: 2n, adapter: ADAPTER_2, pool: POOL_B, fundingEnabled: false, recallEnabled: true},
    ]);
    expect(resolved.adapterHistory).toEqual([OLD_ADAPTER, ADAPTER_2, ADAPTER_1]);
    expect(resolved.pools).toEqual([POOL_A, POOL_B, OLD_POOL]);
    expect(resolved.legacyWallets).toEqual([LEGACY_1, LEGACY_2]);
    expect(resolved.endpoints).toEqual([
      MANAGER,
      OLD_ADAPTER,
      ADAPTER_2,
      ADAPTER_1,
      POOL_A,
      POOL_B,
      OLD_POOL,
      LEGACY_1,
      LEGACY_2,
      EXTRA,
    ]);
  });

  it("labels every known address", async () => {
    const fake = createContractClient(
      {[REGISTRY]: registryFake(POOL_A), [MANAGER]: managerFake(), [POOL_A]: {getRouter: ROUTER}},
      BLOCK,
    );
    const resolved = await resolveAddresses(fake.client, chain, BLOCK);
    const label = makeLabeler(resolved);
    expect(
      Object.fromEntries(
        [MANAGER, TIMELOCK, CONTROLLER, TOKEN, REGISTRY, ROUTER, POOL_A, POOL_B, OLD_POOL].map((a) => [a, label(a)]),
      ),
    ).toEqual({
      [MANAGER]: "Manager",
      [TIMELOCK]: "Timelock",
      [CONTROLLER]: "GuardianController",
      [TOKEN]: "Token",
      [REGISTRY]: "Registry",
      [ROUTER]: "Router",
      [POOL_A]: "Pool",
      [POOL_B]: "Pool (adapter #2)",
      [OLD_POOL]: "Retired pool",
    });
    expect(label(ADAPTER_1)).toBe("Adapter #1");
    expect(label(ADAPTER_2)).toBe("Adapter #2");
    expect(label(OLD_ADAPTER)).toBe("Replaced adapter");
    expect(label(GUARDIAN)).toBe("Guardian");
    expect(label(SAFE)).toBe("Governance Safe");
    expect(label(FUND_OP)).toBe("Funding operator");
    expect(label(RECALL_OP)).toBe("Recall operator");
    expect(label(LEGACY_1)).toBe("Legacy wallet 1");
    expect(label(LEGACY_2)).toBe("Legacy wallet 2");
    expect(label(EXTRA)).toBe("Reserve endpoint 1");
    expect(Object.keys(resolved.labels).every((key) => key === key.toLowerCase())).toBe(true);
  });

  it("handles a Manager before the handover: no adapters and no registry pool", async () => {
    const preHandover = chainConfig({
      contracts: {token: TOKEN, registry: REGISTRY, manager: MANAGER, pool: POOL_A},
      expected: {guardian: SAFE},
    });
    const fake = createContractClient(
      {
        [REGISTRY]: registryFake(zeroAddress),
        [MANAGER]: managerFake({adapterCount: 0n, getAdapterHistory: [], guardian: zeroAddress}),
        [POOL_A]: {getRouter: ROUTER},
      },
      BLOCK,
    );
    const resolved = await resolveAddresses(fake.client, preHandover, BLOCK);
    expect(resolved.registryPool).toBe(zeroAddress);
    expect(resolved.adapters).toEqual([]);
    expect(resolved.adapterHistory).toEqual([]);
    expect(resolved.pools).toEqual([POOL_A]);
    expect(resolved.endpoints).toEqual([MANAGER, POOL_A]);
    expect(resolved.timelock).toBe(TIMELOCK);
    // POOL_A has a spec set: its rateLimitAdmin is the controller even before an adapter is registered.
    expect(resolved.controller).toBe(CONTROLLER);
    expect(resolved.router).toBe(ROUTER);
    expect(fake.calls.some((call) => call.functionName === "getAdapter")).toBe(false);
    expect(labelFor(resolved, POOL_A)).toBe("Pool");
    // No live Guardian (address(0)): nothing is labeled "Guardian", the configured one is only expected.
    expect(resolved.labels[zeroAddress]).toBeUndefined();
    expect(labelFor(resolved, SAFE)).toBe("Expected Guardian");
  });

  it("leaves the controller unset when no pool spec names one", async () => {
    const fake = createContractClient(
      {
        [REGISTRY]: registryFake(zeroAddress),
        [MANAGER]: managerFake({adapterCount: 0n, getAdapterHistory: [], getPoolSpec: [spec(zeroAddress), false]}),
      },
      BLOCK,
    );
    const resolved = await resolveAddresses(
      fake.client,
      chainConfig({contracts: {token: TOKEN, registry: REGISTRY, manager: MANAGER, pool: POOL_A}}),
      BLOCK,
    );
    expect(resolved.controller).toBeUndefined();
    expect(resolved.router).toBeUndefined();
  });

  it("prefers configured timelock, controller and router", async () => {
    const configured = chainConfig({
      contracts: {
        token: TOKEN,
        registry: REGISTRY,
        manager: MANAGER,
        timelock: addr(0x90),
        controller: addr(0x91),
        router: addr(0x92),
      },
    });
    const fake = createContractClient({[REGISTRY]: registryFake(POOL_A), [MANAGER]: managerFake()}, BLOCK);
    const resolved = await resolveAddresses(fake.client, configured, BLOCK);
    expect(resolved).toMatchObject({timelock: addr(0x90), controller: addr(0x91), router: addr(0x92)});
    expect(fake.calls.map((call) => call.functionName)).not.toContain("getPoolSpec");
    expect(fake.calls.map((call) => call.functionName)).not.toContain("getRouter");
    expect(labelFor(resolved, TIMELOCK)).toBe(TIMELOCK);
    expect(labelFor(resolved, addr(0x90))).toBe("Timelock");
  });

  it("throws when the Manager's token or registry differs from the configuration", async () => {
    const wrongToken = createContractClient(
      {[REGISTRY]: registryFake(POOL_A), [MANAGER]: managerFake({TOKEN: addr(0x99)})},
      BLOCK,
    );
    await expect(resolveAddresses(wrongToken.client, chain, BLOCK)).rejects.toThrow(/TOKEN\(\) is 0x0+99/);
    const wrongRegistry = createContractClient(
      {[REGISTRY]: registryFake(POOL_A), [MANAGER]: managerFake({TOKEN_ADMIN_REGISTRY: addr(0x99)})},
      BLOCK,
    );
    await expect(resolveAddresses(wrongRegistry.client, chain, BLOCK)).rejects.toThrow(/TOKEN_ADMIN_REGISTRY/);
  });

  it("propagates failed Manager reads", async () => {
    const fake = createContractClient(
      {[REGISTRY]: registryFake(POOL_A), [MANAGER]: managerFake({adapterCount: new Error("rpc down")})},
      BLOCK,
    );
    await expect(resolveAddresses(fake.client, chain, BLOCK)).rejects.toThrow(/rpc down/);
  });

  it("falls back to the next pool when getRouter() fails, and warns", async () => {
    const log = capturingLogger();
    const fake = createContractClient(
      {
        [REGISTRY]: registryFake(POOL_A),
        [MANAGER]: managerFake(),
        [POOL_A]: {getRouter: new Error("reverted")},
        [POOL_B]: {getRouter: ROUTER},
      },
      BLOCK,
    );
    const resolved = await resolveAddresses(fake.client, chain, BLOCK, {log});
    expect(resolved.router).toBe(ROUTER);
    expect(log.warnings).toHaveLength(1);
    const routerReads = fake.calls.filter((call) => call.functionName === "getRouter").map((call) => call.address);
    expect(routerReads).toEqual([POOL_A, POOL_B]);
  });
});

describe("resolveAddresses without a Manager", () => {
  it("uses the configuration, the registry pool and the pool's router", async () => {
    const chain = chainConfig({
      contracts: {token: TOKEN, registry: REGISTRY, pool: POOL_A},
      reserves: {legacyWallets: [LEGACY_1]},
      expected: roles,
    });
    const fake = createContractClient({[REGISTRY]: registryFake(POOL_A), [POOL_A]: {getRouter: ROUTER}}, BLOCK);
    const resolved = await resolveAddresses(fake.client, chain, BLOCK);

    expect(fake.calls.map((call) => call.functionName).sort()).toEqual(["getPool", "getRouter"]);
    expect(resolved).toEqual({
      token: TOKEN,
      registry: REGISTRY,
      router: ROUTER,
      manager: undefined,
      timelock: undefined,
      controller: undefined,
      registryPool: POOL_A,
      adapters: [],
      adapterHistory: [],
      pools: [POOL_A],
      legacyWallets: [LEGACY_1],
      endpoints: [POOL_A, LEGACY_1],
      labels: expect.any(Object),
    });
    const label = makeLabeler(resolved);
    expect([TOKEN, REGISTRY, ROUTER, POOL_A, GUARDIAN, SAFE, FUND_OP, RECALL_OP, LEGACY_1].map(label)).toEqual([
      "Token",
      "Registry",
      "Router",
      "Pool",
      "Guardian",
      "Governance Safe",
      "Funding operator",
      "Recall operator",
      "Legacy wallet 1",
    ]);
  });

  it("watches both the configured pool and a different registry pool", async () => {
    const chain = chainConfig({contracts: {token: TOKEN, registry: REGISTRY, pool: OLD_POOL}});
    const fake = createContractClient({[REGISTRY]: registryFake(POOL_A), [POOL_A]: {getRouter: ROUTER}}, BLOCK);
    const resolved = await resolveAddresses(fake.client, chain, BLOCK);
    expect(resolved.pools).toEqual([POOL_A, OLD_POOL]);
    expect(labelFor(resolved, POOL_A)).toBe("Pool");
    expect(labelFor(resolved, OLD_POOL)).toBe("Retired pool");
  });
});

describe("labels", () => {
  it("keeps the first label in precedence order and numbers repeated retired pools", async () => {
    const chain = chainConfig({
      contracts: {token: TOKEN, registry: REGISTRY, manager: MANAGER},
      reserves: {extraPools: [OLD_POOL, addr(0x23)]},
      // The Guardian also listed as an operator; one address as both operators; an alias guardian is not relabeled.
      expected: {governanceSafe: SAFE, fundingOperators: [GUARDIAN, FUND_OP], recallOperators: [FUND_OP, TIMELOCK]},
    });
    const fake = createContractClient(
      {[REGISTRY]: registryFake(POOL_A), [MANAGER]: managerFake(), [POOL_A]: {getRouter: ROUTER}},
      BLOCK,
    );
    const resolved = await resolveAddresses(fake.client, chain, BLOCK);
    const label = makeLabeler(resolved);
    expect(label(GUARDIAN)).toBe("Guardian");
    expect(label(FUND_OP)).toBe("Funding operator");
    expect(label(TIMELOCK)).toBe("Timelock");
    expect(label(OLD_POOL)).toBe("Retired pool 1");
    expect(label(addr(0x23))).toBe("Retired pool 2");
  });

  it("falls back to the checksummed address", () => {
    const label = makeLabeler({labels: {[MANAGER.toLowerCase()]: "Manager"}});
    expect(label(MANAGER.toLowerCase() as Address)).toBe("Manager");
    const unknown = "0x194e4c58ded42b35ed984c8e8f85e854bd1e62b4";
    expect(label(unknown)).toBe("0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4");
  });
});
