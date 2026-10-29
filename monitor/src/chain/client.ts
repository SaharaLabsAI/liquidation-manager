// RPC client, block-explorer links and the per-chain rule context. Read-only: only a public client is ever built.
import {
  createPublicClient,
  createTransport,
  http,
  shouldThrow,
  type Address,
  type Chain,
  type EIP1193RequestFn,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";

import type {ChainConfig, Config} from "../config.ts";
import type {Logger} from "../log.ts";
import type {Store} from "../store.ts";
import type {Alerter, ChainContext, Explorer, ResolvedAddresses} from "../types.ts";
import {labelFor} from "./addresses.ts";

export interface ChainClientOptions {
  /** Chain name for viem's chain object (only used in viem error messages). */
  name?: string;
  /** Per-request HTTP timeout. eth_getLogs over a full `maxLogRange` can be slow on public RPCs. */
  timeoutMs?: number;
  /** Retries per RPC URL before falling back to the next one. */
  retryCount?: number;
}

/**
 * Public client over every configured RPC URL (see `stickyFallback`). JSON-RPC batching is on, so the concurrent reads
 * of one cycle share HTTP requests.
 */
export function createChainClient(chain: ChainConfig, options: ChainClientOptions = {}): PublicClient {
  const {name = `chain-${chain.chainId}`, timeoutMs = 20_000, retryCount = 2} = options;
  const viemChain: Chain = {
    id: chain.chainId,
    name,
    // Never used: the monitor reads no native balances and sends no transactions.
    nativeCurrency: {name: "Native", symbol: "NATIVE", decimals: 18},
    // The transports below carry the URLs.
    rpcUrls: {default: {http: []}},
  };
  const transports = chain.rpcUrls.map((url) =>
    // Small batches: several providers reject or throttle large JSON-RPC batches of eth_getLogs.
    http(url, {timeout: timeoutMs, retryCount, batch: {batchSize: 10}}),
  );
  return createPublicClient({chain: viemChain, transport: stickyFallback(transports)}) as PublicClient;
}

/**
 * viem's `fallback` (an error moves on to the next URL), but sticky: a request starts at the URL that answered last,
 * not always at the first one, so a primary that hangs costs (retryCount + 1) × timeout once instead of on every
 * request of every cycle. An earlier URL is used again once the current one fails. Errors that are the call's own
 * result (reverts) are thrown at once, as viem's `shouldThrow` decides.
 */
export function stickyFallback(transports: readonly Transport[]): Transport<"fallback"> {
  let current = 0;
  return ({chain, timeout, ...rest}) => {
    const instance = (i: number) => transports[i]!({...rest, chain, retryCount: 0, timeout});
    const request = async ({method, params}: {method: string; params?: unknown}, options?: unknown) => {
      const start = current;
      for (let n = 0; ; n++) {
        const i = (start + n) % transports.length;
        try {
          const response: unknown = await instance(i).request({method, params} as never, options as never);
          current = i;
          return response;
        } catch (error) {
          if (shouldThrow(error as Error) || n === transports.length - 1) throw error;
        }
      }
    };
    return createTransport(
      {
        key: "fallback",
        name: "Fallback",
        type: "fallback",
        request: request as EIP1193RequestFn,
        // 0 on the wrapper: each URL already retried, and range-limit errors (-32005) must reach the scanner's range
        // splitting quickly instead of being retried len(urls) × 4 times.
        retryCount: 0,
      },
      {transports: transports.map((_, i) => instance(i))},
    );
  };
}

/** Explorer links: `${base}/tx/${hash}` and `${base}/address/${address}`. */
export function createExplorer(explorerUrl: string): Explorer {
  const base = explorerUrl.replace(/\/+$/, "");
  return {
    tx: (hash: Hex) => `${base}/tx/${hash}`,
    address: (address: Address) => `${base}/address/${address}`,
  };
}

/** Latest block minus `confirmations`, floored at 0. Bypasses viem's block-number cache. */
export async function confirmedHead(client: PublicClient, confirmations: number): Promise<bigint> {
  const head = await client.getBlockNumber({cacheTime: 0});
  const depth = BigInt(confirmations);
  return head > depth ? head - depth : 0n;
}

export interface ChainContextInit {
  name: string;
  chain: ChainConfig;
  global: Config;
  client: PublicClient;
  alerter: Alerter;
  store: Store;
  log: Logger;
  addresses: ResolvedAddresses;
}

/**
 * Builds the context handed to every rule. `label` reads `ctx.addresses` at call time, so the daemon can assign the
 * re-resolved addresses to `ctx.addresses` each cycle and labels follow.
 */
export function createChainContext(init: ChainContextInit): ChainContext {
  const ctx: ChainContext = {
    name: init.name,
    config: init.chain,
    global: init.global,
    client: init.client,
    explorer: createExplorer(init.chain.explorerUrl),
    alerter: init.alerter,
    store: init.store,
    log: init.log,
    addresses: init.addresses,
    label: (address: Address) => labelFor(ctx.addresses, address),
  };
  return ctx;
}
