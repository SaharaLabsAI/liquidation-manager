import {createServer} from "node:http";
import type {AddressInfo} from "node:net";

import {createPublicClient, custom, type PublicClient} from "viem";
import {describe, expect, it, vi} from "vitest";

import {
  confirmedHead,
  createChainClient,
  createChainContext,
  createExplorer,
  routeReceipts,
  stickyFallback,
} from "../src/chain/client.ts";
import {silentLogger} from "../src/log.ts";
import {createStore} from "../src/store.ts";
import type {Alerter, ResolvedAddresses} from "../src/types.ts";
import {addr, chainConfig, globalConfig} from "./helpers/chain-fakes.ts";

const alerter: Alerter = {emit: () => {}, sync: () => {}, resolve: () => {}};

function addresses(labels: Record<string, string>): ResolvedAddresses {
  return {
    token: addr(1),
    registry: addr(2),
    registryPool: addr(3),
    adapters: [],
    adapterHistory: [],
    pools: [addr(3)],
    legacyWallets: [],
    endpoints: [addr(3)],
    labels,
  };
}

describe("createExplorer", () => {
  it("builds tx and address links without duplicate slashes", () => {
    const explorer = createExplorer("https://etherscan.io//");
    expect(explorer.tx("0xabc")).toBe("https://etherscan.io/tx/0xabc");
    expect(explorer.address(addr(5))).toBe(`https://etherscan.io/address/${addr(5)}`);
    expect(createExplorer("https://bscscan.com").tx("0x1")).toBe("https://bscscan.com/tx/0x1");
  });
});

describe("confirmedHead", () => {
  it("subtracts confirmations, floored at zero, bypassing the block-number cache", async () => {
    const getBlockNumber = vi.fn(async () => 100n);
    const client = {getBlockNumber} as unknown as PublicClient;
    expect(await confirmedHead(client, 3)).toBe(97n);
    expect(await confirmedHead(client, 0)).toBe(100n);
    expect(await confirmedHead(client, 150)).toBe(0n);
    expect(getBlockNumber).toHaveBeenCalledWith({cacheTime: 0});
  });
});

describe("createChainClient", () => {
  it("builds a fallback client over every RPC URL with the configured chain id", () => {
    const chain = {...chainConfig({contracts: {token: addr(1), registry: addr(2)}}), chainId: 56};
    chain.rpcUrls = ["https://a.example.com/key", "https://b.example.com"];
    const client = createChainClient(chain, {name: "bsc"});
    expect(client.chain?.id).toBe(56);
    expect(client.chain?.name).toBe("bsc");
    expect(client.transport.type).toBe("fallback");
    expect((client.transport as unknown as {transports: unknown[]}).transports).toHaveLength(2);
  });
});

describe("routeReceipts", () => {
  it("sends eth_getBlockReceipts through its own transport and everything else through the main one", async () => {
    const calls: string[] = [];
    const node = (name: string) =>
      custom({
        async request({method}: {method: string}) {
          calls.push(`${name} ${method}`);
          return method === "eth_getBlockReceipts" ? [] : "0x64";
        },
      });
    const client = createPublicClient({transport: routeReceipts(node("main"), node("receipts"))});
    expect(await client.getBlockNumber({cacheTime: 0})).toBe(100n);
    expect(await client.request({method: "eth_getBlockReceipts", params: ["0x5"]})).toEqual([]);
    expect(calls).toEqual(["main eth_blockNumber", "receipts eth_getBlockReceipts"]);
  });
});

describe("createChainClient: eth_getBlockReceipts timeout", () => {
  it("waits rpcReceiptsTimeoutMs for receipts while other requests keep rpcTimeoutMs", async () => {
    // Every answer takes 300 ms: past the 100 ms request timeout, within the 2 s receipts timeout.
    const methods: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const parsed = JSON.parse(body) as {id: number; method: string} | Array<{id: number; method: string}>;
        const items = Array.isArray(parsed) ? parsed : [parsed];
        methods.push(...items.map((item) => item.method));
        const answers = items.map((item) => ({
          jsonrpc: "2.0",
          id: item.id,
          result: item.method === "eth_getBlockReceipts" ? [] : "0x64",
        }));
        setTimeout(() => res.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0])), 300);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const {port} = server.address() as AddressInfo;
      const chain = {
        ...chainConfig({contracts: {token: addr(1), registry: addr(2)}}),
        rpcUrls: [`http://127.0.0.1:${port}`],
      };
      const client = createChainClient(chain, {timeoutMs: 100, receiptsTimeoutMs: 2_000, retryCount: 0});
      await expect(client.getBlockNumber({cacheTime: 0})).rejects.toThrow(/took too long/);
      expect(await client.request({method: "eth_getBlockReceipts", params: ["0x5"]})).toEqual([]);
      expect(methods).toEqual(["eth_blockNumber", "eth_getBlockReceipts"]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("stickyFallback", () => {
  it("starts at the URL that answered last: a hung primary costs one timeout, not one per request", async () => {
    const calls: string[] = [];
    const down = new Set(["primary"]);
    const node = (name: string) =>
      custom({
        async request({method}: {method: string}) {
          calls.push(name);
          if (method === "eth_call") throw Object.assign(new Error("execution reverted: UnknownAdapter()"), {code: 3});
          if (down.has(name)) throw new Error(`${name}: The request took too long to respond.`);
          return "0x64";
        },
      });
    const client = createPublicClient({transport: stickyFallback([node("primary"), node("backup"), node("third")])});
    const head = () => client.getBlockNumber({cacheTime: 0});

    expect(await head()).toBe(100n);
    expect(await head()).toBe(100n);
    expect(await head()).toBe(100n);
    expect(calls).toEqual(["primary", "backup", "backup", "backup"]);

    // The backup fails: on to the next URL in order, wrapping around to the recovered primary later.
    calls.length = 0;
    down.delete("primary");
    down.add("backup").add("third");
    expect(await head()).toBe(100n);
    expect(await head()).toBe(100n);
    expect(calls).toEqual(["backup", "third", "primary", "primary"]);

    // A revert is the call's own result: thrown at once, without trying the other URLs.
    calls.length = 0;
    await expect(client.call({to: addr(1), data: "0x"})).rejects.toThrow(/reverted/);
    expect(calls).toEqual(["primary"]);

    // Every URL failing throws the last error.
    calls.length = 0;
    down.add("primary");
    await expect(head()).rejects.toThrow(/third: The request took too long/);
    expect(calls).toEqual(["primary", "backup", "third"]);
  });
});

describe("createChainContext", () => {
  it("wires the explorer and labels from the current addresses", () => {
    const global = globalConfig({
      ethereum: {contracts: {token: addr(1), registry: addr(2)}, explorerUrl: "https://etherscan.io/"},
    });
    const ctx = createChainContext({
      name: "ethereum",
      chain: global.chains.ethereum!,
      global,
      client: {} as PublicClient,
      alerter,
      store: createStore(),
      log: silentLogger,
      addresses: addresses({[addr(3).toLowerCase()]: "Pool"}),
    });
    expect(ctx.name).toBe("ethereum");
    expect(ctx.config).toBe(global.chains.ethereum);
    expect(ctx.explorer.tx("0x12")).toBe("https://etherscan.io/tx/0x12");
    expect(ctx.label(addr(3))).toBe("Pool");
    expect(ctx.label(addr(4))).toBe(addr(4));

    // The daemon swaps in re-resolved addresses each cycle; labels must follow.
    ctx.addresses = addresses({[addr(4).toLowerCase()]: "Adapter #1"});
    const {label} = ctx;
    expect(label(addr(4))).toBe("Adapter #1");
    expect(label(addr(3))).toBe(addr(3));
  });
});
