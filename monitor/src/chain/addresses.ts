// Address resolution: every contract and role address the monitor watches on one chain, read from the live deployment
// at a block (adapters, pools and the Guardian can change between cycles) and labeled for alerts.
// Plain readContract calls, no multicall: Multicall3 is not deployed on every network the monitor runs against (anvil).
import {getAddress, isAddress, zeroAddress, type Address, type PublicClient} from "viem";

import {tokenAdminRegistryAbi, tokenPoolAbi} from "../abi/external.ts";
import {liquidityManagerAbi} from "../abi/generated.ts";
import type {ChainConfig} from "../config.ts";
import type {Logger} from "../log.ts";
import {sameAddress} from "../rules/common.ts";
import type {ResolvedAddresses} from "../types.ts";

export interface ResolveOptions {
  /** Receives warnings for optional lookups that failed (router default). */
  log?: Logger;
}

type Adapter = ResolvedAddresses["adapters"][number];

/**
 * Resolves the chain's addresses at `blockNumber`.
 *
 * With a Manager: timelock = `owner()` (unless configured), adapters 1..`adapterCount()`, `getAdapterHistory()`, the
 * live `guardian()` (labels only), controller = the `rateLimitAdmin` of a registered pool's spec, else of the registry
 * or configured pool's spec before any adapter is registered (unless configured).
 * `TOKEN()` and `TOKEN_ADMIN_REGISTRY()` must match the configured token and registry, otherwise this throws: the
 * monitor would be watching contracts the Manager does not use. Without a Manager only configured addresses are used.
 * Either way the registry's pool for the token is read, and the router defaults to a watched pool's `getRouter()`.
 * Failed Manager or registry reads throw (the cycle cannot be verified); a failed router lookup leaves `router` unset.
 */
export async function resolveAddresses(
  client: PublicClient,
  chain: ChainConfig,
  blockNumber: bigint,
  opts: ResolveOptions = {},
): Promise<ResolvedAddresses> {
  const contracts = chain.contracts;
  const {token, registry, manager} = contracts;

  const [registryPoolRaw, managerState] = await Promise.all([
    client.readContract({
      address: registry,
      abi: tokenAdminRegistryAbi,
      functionName: "getPool",
      args: [token],
      blockNumber,
    }),
    manager ? readManager(client, manager, chain, blockNumber) : undefined,
  ]);
  const registryPool = getAddress(registryPoolRaw);
  const adapters = managerState?.adapters ?? [];

  const pools = uniqueAddresses([
    ...adapters.map((entry) => entry.pool),
    registryPool,
    contracts.pool,
    ...chain.reserves.extraPools,
  ]);
  const registeredPools = uniqueAddresses([
    ...adapters.filter((entry) => sameAddress(entry.pool, registryPool)).map((entry) => entry.pool),
    ...adapters.map((entry) => entry.pool),
  ]);

  const specPools = [...registeredPools, registryPool, contracts.pool];
  const [controller, router] = await Promise.all([
    contracts.controller ?? (manager ? controllerFromPoolSpecs(client, manager, specPools, blockNumber) : undefined),
    contracts.router ?? routerFromPools(client, uniqueAddresses([registryPool, ...pools]), blockNumber, opts.log),
  ]);

  const timelock = contracts.timelock ?? managerState?.owner;
  const adapterHistory = uniqueAddresses([...(managerState?.history ?? []), ...adapters.map((entry) => entry.adapter)]);
  const legacyWallets = uniqueAddresses(chain.reserves.legacyWallets);
  const endpoints = uniqueAddresses([
    manager,
    ...adapterHistory,
    ...pools,
    ...legacyWallets,
    ...chain.reserves.extraEndpoints,
  ]);

  const resolved: ResolvedAddresses = {
    token,
    registry,
    router,
    manager,
    timelock,
    controller,
    guardian: managerState?.guardian,
    registryPool,
    adapters,
    adapterHistory,
    pools,
    legacyWallets,
    endpoints,
    labels: {},
  };
  resolved.labels = buildLabels(resolved, chain, managerState?.guardian);
  return resolved;
}

/** Label for an address: the resolved label, else the checksummed address (what `addressField` compares against). */
export function labelFor(addresses: Pick<ResolvedAddresses, "labels">, address: string): string {
  const known = addresses.labels[address.toLowerCase()];
  if (known) return known;
  return isAddress(address, {strict: false}) ? getAddress(address) : address;
}

export function makeLabeler(addresses: Pick<ResolvedAddresses, "labels">): (address: Address) => string {
  return (address) => labelFor(addresses, address);
}

interface ManagerState {
  owner: Address;
  /** Undefined when the Manager has no Guardian (address(0)). */
  guardian: Address | undefined;
  adapters: Adapter[];
  history: readonly Address[];
}

async function readManager(
  client: PublicClient,
  manager: Address,
  chain: ChainConfig,
  blockNumber: bigint,
): Promise<ManagerState> {
  const call = {address: manager, abi: liquidityManagerAbi, blockNumber} as const;
  const [owner, managerToken, managerRegistry, count, history, guardian] = await Promise.all([
    client.readContract({...call, functionName: "owner"}),
    client.readContract({...call, functionName: "TOKEN"}),
    client.readContract({...call, functionName: "TOKEN_ADMIN_REGISTRY"}),
    client.readContract({...call, functionName: "adapterCount"}),
    client.readContract({...call, functionName: "getAdapterHistory"}),
    client.readContract({...call, functionName: "guardian"}),
  ]);
  const {token, registry} = chain.contracts;
  if (!sameAddress(managerToken, token)) {
    throw new Error(`Manager ${manager} TOKEN() is ${managerToken}, but contracts.token is ${token}`);
  }
  if (!sameAddress(managerRegistry, registry)) {
    throw new Error(
      `Manager ${manager} TOKEN_ADMIN_REGISTRY() is ${managerRegistry}, but contracts.registry is ${registry}`,
    );
  }

  // Ids run from 1 to adapterCount and are never reused; 0 adapters before the handover.
  const ids = Array.from({length: Number(count)}, (_, i) => BigInt(i + 1));
  const adapters = await Promise.all(
    ids.map(async (id): Promise<Adapter> => {
      const entry = await client.readContract({...call, functionName: "getAdapter", args: [id]});
      return {
        id,
        adapter: getAddress(entry.adapter),
        pool: getAddress(entry.pool),
        fundingEnabled: entry.fundingEnabled,
        recallEnabled: entry.recallEnabled,
      };
    }),
  );
  return {
    owner: getAddress(owner),
    guardian: isZero(guardian) ? undefined : getAddress(guardian),
    adapters,
    history: history.map((address) => getAddress(address)),
  };
}

/** The GuardianController is the `rateLimitAdmin` the Manager requires in a pool spec; first set spec wins. */
async function controllerFromPoolSpecs(
  client: PublicClient,
  manager: Address,
  candidates: Array<Address | undefined>,
  blockNumber: bigint,
): Promise<Address | undefined> {
  const pools = uniqueAddresses(candidates);
  const specs = await Promise.all(
    pools.map((pool) =>
      client.readContract({
        address: manager,
        abi: liquidityManagerAbi,
        functionName: "getPoolSpec",
        args: [pool],
        blockNumber,
      }),
    ),
  );
  for (const [spec, isSet] of specs) {
    if (isSet && !isZero(spec.rateLimitAdmin)) return getAddress(spec.rateLimitAdmin);
  }
  return undefined;
}

/** First watched pool answering `getRouter()` with a non-zero address, in order (registry pool first). */
async function routerFromPools(
  client: PublicClient,
  pools: Address[],
  blockNumber: bigint,
  log: Logger | undefined,
): Promise<Address | undefined> {
  for (const pool of pools) {
    try {
      const router = await client.readContract({
        address: pool,
        abi: tokenPoolAbi,
        functionName: "getRouter",
        blockNumber,
      });
      if (!isZero(router)) return getAddress(router);
    } catch (error) {
      log?.warn("pool getRouter() failed while resolving the router", {pool, error});
    }
  }
  return undefined;
}

/**
 * Labels, first write wins in this order: contracts, pools, adapters, then configured roles and reserve wallets.
 * The registry pool is "Pool"; other registered pools "Pool (adapter #N)"; unregistered pools "Retired pool".
 */
function buildLabels(
  resolved: ResolvedAddresses,
  chain: ChainConfig,
  liveGuardian: Address | undefined,
): Record<string, string> {
  const labels: Record<string, string> = {};
  const add = (address: string | undefined, label: string) => {
    if (!address || isZero(address)) return;
    const key = address.toLowerCase();
    if (!(key in labels)) labels[key] = label;
  };
  const addNumbered = (addresses: readonly string[], label: string, alwaysNumber: boolean) => {
    const numbered = alwaysNumber || addresses.length > 1;
    addresses.forEach((address, i) => add(address, numbered ? `${label} ${i + 1}` : label));
  };

  add(resolved.manager, "Manager");
  add(resolved.timelock, "Timelock");
  add(resolved.controller, "GuardianController");
  add(resolved.token, "Token");
  add(resolved.registry, "Registry");
  add(resolved.router, "Router");

  // Before the registry maps the token, the configured pool is the live one.
  const primaryPool = isZero(resolved.registryPool) ? chain.contracts.pool : resolved.registryPool;
  const retiredPools: Address[] = [];
  for (const pool of resolved.pools) {
    const adapter = resolved.adapters.find((entry) => sameAddress(entry.pool, pool));
    if (sameAddress(pool, primaryPool)) add(pool, "Pool");
    else if (adapter) add(pool, `Pool (adapter #${adapter.id})`);
    else retiredPools.push(pool);
  }
  addNumbered(retiredPools, "Retired pool", false);

  for (const entry of resolved.adapters) add(entry.adapter, `Adapter #${entry.id}`);
  const current = resolved.adapters.map((entry) => entry.adapter);
  const replaced = resolved.adapterHistory.filter((adapter) => !current.some((a) => sameAddress(a, adapter)));
  addNumbered(replaced, "Replaced adapter", false);

  add(liveGuardian, "Guardian");
  const expectedGuardian = chain.expected.guardian;
  // Aliases ("timelock", ...) already carry their own label; only a literal address needs one.
  if (expectedGuardian && isAddress(expectedGuardian)) {
    // With a Manager the live guardian() is "Guardian"; a different configured one is only expected.
    add(expectedGuardian, resolved.manager ? "Expected Guardian" : "Guardian");
  }
  add(chain.expected.governanceSafe, "Governance Safe");
  for (const operator of chain.expected.fundingOperators ?? []) add(operator, "Funding operator");
  for (const operator of chain.expected.recallOperators ?? []) add(operator, "Recall operator");
  addNumbered(resolved.legacyWallets, "Legacy wallet", true);
  addNumbered(uniqueAddresses(chain.reserves.extraEndpoints), "Reserve endpoint", true);
  return labels;
}

/** Checksummed, without address(0), undefined and case-insensitive duplicates; first occurrence keeps its position. */
function uniqueAddresses(list: ReadonlyArray<string | undefined>): Address[] {
  const seen = new Set<string>();
  const result: Address[] = [];
  for (const address of list) {
    if (!address || isZero(address)) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(getAddress(address));
  }
  return result;
}

function isZero(address: string): boolean {
  return address.toLowerCase() === zeroAddress;
}
