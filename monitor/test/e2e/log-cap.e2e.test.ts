// End-to-end check of the scanner's receipts fallback (README "RPC requirements"): the real daemon reads anvil through
// a JSON-RPC proxy that rejects any eth_getLogs answer over 1,000 logs, like Infura's 10,000-result cap. An outsider
// moves 1 wei to the pool 1,200 times in one contract call, so that block alone is over the cap, then a critical pool
// outflow follows in the next block. Without the fallback the scan fails on the flood block forever and the outflow is
// never seen; with it the flood block is read from eth_getBlockReceipts and the scan goes on.
import {rmSync} from "node:fs";
import {createServer, type Server} from "node:http";
import type {AddressInfo} from "node:net";

import type {Hex, TransactionReceipt} from "viem";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {anvilAvailable, startAnvil, type Anvil} from "./helpers/anvil.ts";
import {CHAIN, writeE2EConfig, type E2EConfig} from "./helpers/config.ts";
import {deploySystem, type E2EDeployment} from "./helpers/deploy.ts";
import {startMonitor, waitForSavedCursor, type MonitorProcess} from "./helpers/monitor-process.ts";
import {startTelegramMock, type TelegramMessage, type TelegramMock} from "./helpers/telegram-mock.ts";

/** At MIN_RESULT_CAP, the fewest matching logs the scanner reads from receipts. */
const CAP = 1_000;
const FLOOD = 1_200;
const WAIT_MS = 90_000;

/**
 * `Stuffer.stuff(token, to, n)` calls `token.transfer(to, 1)` n times: n Transfer logs in one transaction. solc 0.8.24,
 * default settings, from:
 *
 *   interface IERC20 { function transfer(address to, uint256 amount) external returns (bool); }
 *   contract Stuffer {
 *     function stuff(IERC20 token, address to, uint256 n) external { for (uint256 i; i < n; ++i) token.transfer(to, 1); }
 *   }
 */
const STUFFER_BYTECODE = (
    "0x608060405234801561000f575f80fd5b5061030b8061001d5f395ff3fe608060405234801561000f575f80fd5b50600436" +
    "10610029575f3560e01c8063d75c4d261461002d575b5f80fd5b610047600480360381019061004291906101ad565b610049" +
    "565b005b5f5b818110156100db578373ffffffffffffffffffffffffffffffffffffffff1663a9059cbb8460016040518363" +
    "ffffffff1660e01b815260040161008f92919061024e565b6020604051808303815f875af11580156100ab573d5f803e3d5f" +
    "fd5b505050506040513d601f19601f820116820180604052508101906100cf91906102aa565b5080600101905061004b565b" +
    "50505050565b5f80fd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f61010e826100e556" +
    "5b9050919050565b5f61011f82610104565b9050919050565b61012f81610115565b8114610139575f80fd5b50565b5f8135" +
    "905061014a81610126565b92915050565b61015981610104565b8114610163575f80fd5b50565b5f81359050610174816101" +
    "50565b92915050565b5f819050919050565b61018c8161017a565b8114610196575f80fd5b50565b5f813590506101a78161" +
    "0183565b92915050565b5f805f606084860312156101c4576101c36100e1565b5b5f6101d18682870161013c565b93505060" +
    "206101e286828701610166565b92505060406101f386828701610199565b9150509250925092565b61020681610104565b82" +
    "525050565b5f819050919050565b5f819050919050565b5f61023861023361022e8461020c565b610215565b61017a565b90" +
    "50919050565b6102488161021e565b82525050565b5f6040820190506102615f8301856101fd565b61026e60208301846102" +
    "3f565b9392505050565b5f8115159050919050565b61028981610275565b8114610293575f80fd5b50565b5f815190506102" +
    "a481610280565b92915050565b5f602082840312156102bf576102be6100e1565b5b5f6102cc84828501610296565b915050" +
    "9291505056fea26469706673582212204ee9c0f508575130bdd870bacaf59507c7a6f9724adf3eb76b41ea2dfe1ba94f6473" +
    "6f6c63430008180033"
) as Hex;
const stufferAbi = [
  {
    type: "function",
    name: "stuff",
    stateMutability: "nonpayable",
    inputs: [
      {name: "token", type: "address"},
      {name: "to", type: "address"},
      {name: "n", type: "uint256"},
    ],
    outputs: [],
  },
] as const;

interface CappingProxy {
  url: string;
  /** eth_getLogs answers rejected for being over the cap. */
  rejected: number;
  close(): Promise<void>;
}

/** Forwards every JSON-RPC call (also in batches) to `upstream`; an eth_getLogs answer over CAP logs becomes -32005. */
async function startCappingProxy(upstream: string): Promise<CappingProxy> {
  let rejected = 0;
  const forward = async (item: unknown): Promise<unknown> => {
    const response = await fetch(upstream, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(item),
    });
    return response.json();
  };
  const handle = async (item: {id?: unknown; method?: string}): Promise<unknown> => {
    const answer = (await forward(item)) as {result?: unknown};
    if (item.method !== "eth_getLogs" || !Array.isArray(answer.result) || answer.result.length <= CAP) return answer;
    rejected++;
    return {jsonrpc: "2.0", id: item.id, error: {code: -32005, message: `query returned more than ${CAP} results`}};
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      const items = (Array.isArray(body) ? body : [body]) as Array<{id?: unknown; method?: string}>;
      Promise.all(items.map(handle)).then(
        (answers) => {
          res.writeHead(200, {"content-type": "application/json"});
          res.end(JSON.stringify(Array.isArray(body) ? answers : answers[0]));
        },
        () => res.writeHead(502).end(),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const {port} = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get rejected() {
      return rejected;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!anvilAvailable())("e2e log cap (node src/cli.ts run)", () => {
  let anvil: Anvil | undefined;
  let telegram: TelegramMock | undefined;
  let proxy: CappingProxy | undefined;
  let d: E2EDeployment;
  let e2e: E2EConfig | undefined;
  let monitor: MonitorProcess | undefined;

  beforeAll(async () => {
    anvil = await startAnvil();
    telegram = await startTelegramMock();
    proxy = await startCappingProxy(anvil.rpcUrl);
    d = await deploySystem(anvil);
    e2e = await writeE2EConfig({deployment: d, telegram, startBlock: d.readyBlock + 1n});
    // The monitor reads through the proxy; the deployment helpers keep talking to anvil directly.
    e2e.env.E2E_RPC_URL = proxy.url;
  });

  afterAll(async () => {
    await monitor?.stop("SIGKILL");
    await telegram?.close();
    await proxy?.close();
    await anvil?.stop();
    if (e2e) rmSync(e2e.dir, {recursive: true, force: true});
  });

  /** One attacker transaction moving 1 wei to the pool `FLOOD` times; returns its block. */
  async function dustFlood(node: Anvil): Promise<bigint> {
    const wallet = d.wallet(d.accounts.attacker);
    const deployed = await wallet.deployContract({abi: stufferAbi, bytecode: STUFFER_BYTECODE});
    const stuffer = (await node.client.waitForTransactionReceipt({hash: deployed})).contractAddress!;
    await d.transferToken(d.accounts.deployer, stuffer, BigInt(FLOOD));
    const hash = await wallet.writeContract({
      address: stuffer,
      abi: stufferAbi,
      functionName: "stuff",
      args: [d.addresses.token, d.addresses.pool, BigInt(FLOOD)],
    });
    const receipt = await node.client.waitForTransactionReceipt({hash});
    expect(receipt.logs).toHaveLength(FLOOD);
    return receipt.blockNumber;
  }

  it("reads a block over the cap from its receipts and alerts the critical outflow after it", async () => {
    if (!anvil || !telegram || !proxy || !e2e) throw new Error("no setup");
    monitor = startMonitor(e2e, ["run"]);
    await waitForSavedCursor(e2e.stateFile, CHAIN, await anvil.blockNumber());

    const floodBlock = await dustFlood(anvil);
    const outflow = await d.transferOutOfPool(10n);
    await telegram.waitFor(event("flows.pool-outflow", outflow), WAIT_MS);
    await waitForSavedCursor(e2e.stateFile, CHAIN, outflow.blockNumber);

    expect(proxy.rejected).toBeGreaterThan(0);
    const message = "eth_getLogs failed for a single block; read its logs from eth_getBlockReceipts";
    const fallback = monitor.logs().filter((line) => line.msg === message);
    expect(fallback.map((line) => String(line.block))).toContain(String(floodBlock));
    // The flood itself was read: its first transfer is alerted (the rest merge into a later summary).
    expect(telegram.messages.some((message) => ruleOf(message) === "flows.pool-inflow")).toBe(true);
  });
});

/** The rule id from a message's footer line (`<i>rule manager.funded</i>`). */
function ruleOf(message: TelegramMessage): string | undefined {
  return /<i>rule ([^<]+)<\/i>/.exec(message.text)?.[1];
}

/** The event alert of `rule` for a transaction. */
function event(rule: string, receipt: TransactionReceipt): (message: TelegramMessage) => boolean {
  return (message) => ruleOf(message) === rule && message.text.toLowerCase().includes(receipt.transactionHash);
}
