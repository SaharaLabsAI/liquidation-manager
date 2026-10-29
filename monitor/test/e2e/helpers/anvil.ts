// Local anvil node for the end-to-end suites: one process per suite on a free port, plus the cheat RPCs the scenarios
// use to move the chain forward (mine blocks, warp time, snapshot/revert).
import {spawn, spawnSync} from "node:child_process";
import {createServer} from "node:net";

import {createPublicClient, defineChain, http, numberToHex, type Chain, type Hex, type PublicClient} from "viem";

/** anvil binary; override with ANVIL_BIN (e.g. a pinned foundry install). */
const ANVIL_BIN = process.env.ANVIL_BIN ?? "anvil";
/** anvil's default chain id. */
export const ANVIL_CHAIN_ID = 31337;
const READY_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
/** Tail of anvil's output kept for error messages. */
const OUTPUT_TAIL = 16_384;

/** Whether the anvil binary can run. Synchronous so suites can use it in `describe.skipIf` at collection time. */
export function anvilAvailable(): boolean {
  const result = spawnSync(ANVIL_BIN, ["--version"], {stdio: "ignore", timeout: 10_000});
  return result.error === undefined && result.status === 0;
}

/** A TCP port that was free a moment ago (bound to 127.0.0.1:0, then released). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("could not allocate a port"))));
    });
  });
}

export interface AnvilOptions {
  /**
   * Fixed port (e.g. to restart a stopped node behind the same RPC URL); default: a free port. A restarted node starts
   * from genesis unless its state was saved, e.g. `args: ["--state", path]` (loads on start, dumps on exit).
   */
  port?: number;
  chainId?: number;
  /** Seconds between blocks; default: automine (one block per transaction). */
  blockTime?: number;
  /** Extra anvil arguments. */
  args?: string[];
}

export interface Anvil {
  port: number;
  rpcUrl: string;
  chainId: number;
  /** viem chain object for this node (wallet clients need it). */
  chain: Chain;
  /** Public client with a short polling interval (receipts on an automining node are immediate). */
  client: PublicClient;
  /** Raw JSON-RPC call. */
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Mines `blocks` empty blocks (anvil_mine), `intervalSec` apart when given. */
  mine(blocks?: number, intervalSec?: number): Promise<void>;
  /** Moves block time forward by `seconds` and mines a block carrying the new timestamp. */
  warp(seconds: number | bigint): Promise<void>;
  /** Mines a block at exactly `timestamp` (must be after the latest block); later blocks continue from there. */
  warpTo(timestamp: number | bigint): Promise<void>;
  /** Latest block number. */
  blockNumber(): Promise<bigint>;
  /** Latest block timestamp (unix seconds). */
  timestamp(): Promise<bigint>;
  /** evm_snapshot; pass the id to `revert` to return to this state (each id can be reverted to once). */
  snapshot(): Promise<Hex>;
  revert(id: Hex): Promise<void>;
  /** Recent anvil output, for diagnostics. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * Starts anvil on a free port and waits until it answers eth_chainId. The node uses anvil's default mnemonic, so its
 * ten dev accounts are the ones `deploy.ts` derives. A port taken between `freePort` and anvil's bind is retried.
 */
export async function startAnvil(options: AnvilOptions = {}): Promise<Anvil> {
  if (options.port !== undefined) return launch(options.port, options);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await launch(await freePort(), options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function launch(port: number, options: AnvilOptions): Promise<Anvil> {
  const chainId = options.chainId ?? ANVIL_CHAIN_ID;
  const args = ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId)];
  if (options.blockTime !== undefined) args.push("--block-time", String(options.blockTime));
  args.push(...(options.args ?? []));

  const child = spawn(ANVIL_BIN, args, {stdio: ["ignore", "pipe", "pipe"]});
  let tail = "";
  const capture = (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  // Set when the binary could not be started at all (e.g. ENOENT); "exit" never fires then.
  let spawnError: Error | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", (error) => {
      spawnError = error;
      resolve();
    });
  });
  const dead = () => spawnError !== undefined || child.exitCode !== null || child.signalCode !== null;
  // A crashed test run must not leave the node behind.
  const killOnExit = () => child.kill("SIGKILL");
  process.once("exit", killOnExit);

  const rpcUrl = `http://127.0.0.1:${port}`;
  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
    });
    const body = (await response.json()) as {result?: T; error?: {message?: string}};
    if (body.error) throw new Error(`${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result as T;
  };

  const stop = async () => {
    process.removeListener("exit", killOnExit);
    if (dead()) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  };

  try {
    const failure = () => (dead() ? `anvil exited before it was ready: ${spawnError?.message ?? tail}` : undefined);
    await waitReady(rpc, failure);
  } catch (error) {
    await stop();
    throw error;
  }

  const chain = defineChain({
    id: chainId,
    name: "anvil",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: [rpcUrl]}},
  });
  const client = createPublicClient({chain, transport: http(rpcUrl), pollingInterval: 50}) as PublicClient;

  return {
    port,
    rpcUrl,
    chainId,
    chain,
    client,
    rpc,
    mine: async (blocks = 1, intervalSec) => {
      const params: unknown[] = [numberToHex(blocks)];
      if (intervalSec !== undefined) params.push(numberToHex(intervalSec));
      await rpc("anvil_mine", params);
    },
    warp: async (seconds) => {
      await rpc("evm_increaseTime", [numberToHex(BigInt(seconds))]);
      await rpc("evm_mine");
    },
    warpTo: async (timestamp) => {
      await rpc("evm_setNextBlockTimestamp", [numberToHex(BigInt(timestamp))]);
      await rpc("evm_mine");
    },
    blockNumber: () => client.getBlockNumber({cacheTime: 0}),
    timestamp: async () => (await client.getBlock({blockTag: "latest"})).timestamp,
    snapshot: () => rpc<Hex>("evm_snapshot"),
    revert: async (id) => {
      const ok = await rpc<boolean>("evm_revert", [id]);
      if (!ok) throw new Error(`evm_revert(${id}) failed`);
    },
    output: () => tail,
    stop,
  };
}

/** Polls eth_chainId until anvil answers; `failure` returns the reason once the process is gone. */
async function waitReady(rpc: (method: string) => Promise<unknown>, failure: () => string | undefined): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const reason = failure();
    if (reason !== undefined) throw new Error(reason);
    try {
      await rpc("eth_chainId");
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`anvil did not answer eth_chainId within ${READY_TIMEOUT_MS} ms`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
