// Fakes for the daemon, health and CLI tests: a settable clock, manual timers, a capture sink, spy rules, a chain
// client with a settable head, an order-recording store, and a deployment client that answers address resolution,
// every state read and the reconciliation reads from the state-deployment model.
import type {Address, Hex, Log, PublicClient, RpcLog} from "viem";

import {readScan, writeScan} from "../../src/ccip/store.ts";
import {configSchema, type Config} from "../../src/config.ts";
import {Daemon, type DaemonOptions, type Timers} from "../../src/daemon.ts";
import {silentLogger, type Logger} from "../../src/log.ts";
import {createStore, type Store} from "../../src/store.ts";
import {DeliveryError} from "../../src/types.ts";
import type {
  Alert,
  Alerter,
  AlertSink,
  BlockRange,
  ChainContext,
  EventRule,
  LogFilter,
  OutgoingMessage,
  ResolvedAddresses,
  StateRule,
} from "../../src/types.ts";
import {addr} from "./chain-fakes.ts";
import {A, stateClient, tokens, type Deployment} from "./state-deployment.ts";

/** 2026-10-28 00:30 UTC. */
export const T0 = Date.UTC(2026, 9, 28, 0, 30, 0);

export interface Clock {
  now: number;
}

/**
 * Two chains (ethereum, bsc) with small ranges and intervals; `chains` entries are merged into each chain. Failures
 * raise their warning at once (`alerts.transientFailureGraceSec: 0`) unless `alerts` sets a grace: most tests check the
 * escalation stages, not the grace.
 */
export function daemonConfig(
  input: {chains?: Record<string, Record<string, unknown>>; [key: string]: unknown} = {},
): Config {
  const {chains = {ethereum: {}, bsc: {}}, alerts = {}, ...rest} = input;
  return configSchema.parse({
    reconciliation: {enabled: false},
    ...rest,
    alerts: {transientFailureGraceSec: 0, ...(alerts as Record<string, unknown>)},
    chains: Object.fromEntries(
      Object.entries(chains).map(([name, extra], i) => [
        name,
        {
          chainId: i + 1,
          chainSelector: String(1000 + i),
          rpcUrls: [`https://rpc${i}.example.com/v2/secret-api-key-${name}`],
          explorerUrl: "https://explorer.example.com",
          confirmations: 0,
          pollIntervalSec: 10,
          maxLogRange: 10,
          staleAfterSec: 60,
          contracts: {token: addr(0x10), registry: addr(0x11), pool: addr(0x20)},
          ...extra,
        },
      ]),
    ),
  });
}

/** Timers that only fire when told to. */
export class ManualTimers implements Timers {
  readonly pending = new Map<number, {callback: () => void; ms: number}>();
  #next = 1;

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.pending.set(id, {callback, ms});
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.ms);
  }

  /** Fires the pending timers scheduled with `ms` (all when omitted). */
  fire(ms?: number): number {
    const due = [...this.pending].filter(([, entry]) => ms === undefined || entry.ms === ms);
    for (const [id, entry] of due) {
      this.pending.delete(id);
      entry.callback();
    }
    return due.length;
  }
}

/** Timers on a test clock: `advance` moves the clock, firing every timer that falls due on the way, in due order. */
export class ClockTimers implements Timers {
  readonly pending = new Map<number, {callback: () => void; at: number; ms: number}>();
  readonly #clock: Clock;
  #next = 1;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.pending.set(id, {callback, at: this.#clock.now + ms, ms});
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Waits (pending delays, ms) of the timers not fired yet. */
  get delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.ms);
  }

  /** Advances the clock by `ms`, firing due timers in order; `settle` runs after each (e.g. to let sends finish). */
  async advance(ms: number, settle: () => Promise<unknown> = flushPromises): Promise<void> {
    const end = this.#clock.now + ms;
    for (;;) {
      await settle();
      const due = [...this.pending].filter(([, entry]) => entry.at <= end).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      const [id, entry] = due;
      this.pending.delete(id);
      this.#clock.now = Math.max(this.#clock.now, entry.at);
      entry.callback();
    }
    // A sink's own (fake) sleeps may have moved the clock past the end already.
    this.#clock.now = Math.max(this.#clock.now, end);
    await settle();
  }
}

/** Lets pending promise callbacks (and their follow-ups a few levels deep) run. */
export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

export class CaptureSink implements AlertSink {
  readonly name: string;
  readonly messages: OutgoingMessage[] = [];
  readonly #order: string[] | undefined;
  /** While set, every send throws it (`fail = true`: a transient DeliveryError, as in a network outage). */
  failWith: Error | undefined;
  /** Alert key -> promise its delivery waits for (a message in flight). */
  readonly holds = new Map<string, Promise<void>>();

  constructor(name = "capture", order?: string[]) {
    this.name = name;
    this.#order = order;
  }

  async send(message: OutgoingMessage): Promise<void> {
    this.#order?.push(`send:${message.alert.key}`);
    const hold = this.holds.get(message.alert.key);
    if (hold) await hold;
    if (this.failWith) throw this.failWith;
    this.messages.push(structuredClone(message));
  }

  set fail(down: boolean) {
    this.failWith = down ? new DeliveryError("sink down", "transient") : undefined;
  }

  /** "status:severity:key" per message. */
  get summary(): string[] {
    return this.messages.map((m) => `${m.status}:${m.alert.severity}:${m.alert.key}`);
  }
}

/** A store that records every save in `order`. */
export function recordingStore(order: string[], path?: string): Store {
  const base = createStore(path);
  return {
    get: base.get,
    set: base.set,
    save() {
      order.push("save");
      base.save();
    },
  };
}

export interface FakeChain {
  client: PublicClient;
  /** Latest block (confirmations are 0 in daemonConfig), or an Error to throw. */
  head: bigint | Error;
  /** While set, getBlockNumber waits for it (an in-flight cycle). */
  gate?: Promise<void>;
  headCalls: number;
}

export function fakeChain(head: bigint): FakeChain {
  const fake: FakeChain = {client: undefined as unknown as PublicClient, head, headCalls: 0};
  fake.client = {
    async getBlockNumber() {
      fake.headCalls++;
      if (fake.gate) await fake.gate;
      if (fake.head instanceof Error) throw fake.head;
      return fake.head;
    },
    async getBlock({blockNumber}: {blockNumber?: bigint}) {
      return {number: blockNumber ?? 0n, timestamp: 1_700_000_000n + (blockNumber ?? 0n) * 12n};
    },
  } as unknown as PublicClient;
  return fake;
}

/** Addresses a resolver would return for a daemonConfig chain. */
export function fakeAddresses(overrides: Partial<ResolvedAddresses> = {}): ResolvedAddresses {
  return {
    token: addr(0x10),
    registry: addr(0x11),
    registryPool: addr(0x20),
    adapters: [],
    adapterHistory: [],
    pools: [addr(0x20)],
    legacyWallets: [],
    endpoints: [addr(0x20)],
    labels: {[addr(0x20).toLowerCase()]: "Pool"},
    ...overrides,
  };
}

export interface RuleCall {
  chain: string;
  range: BlockRange;
  logs: number;
  alerter: Alerter;
}

export interface SpyEventRule extends EventRule {
  calls: RuleCall[];
}

/** An event rule recording every onLogs call (and "rule:<id>:<from>-<to>" in `order`). */
export function spyEventRule(
  id: string,
  options: {
    order?: string[];
    filters?: LogFilter[];
    onLogs?: (ctx: ChainContext, logs: Log[], range: BlockRange) => void | Promise<void>;
  } = {},
): SpyEventRule {
  const rule: SpyEventRule = {
    id,
    calls: [],
    filters: () => options.filters ?? [{address: addr(0x20)}],
    async onLogs(ctx, logs, range) {
      rule.calls.push({chain: ctx.name, range, logs: logs.length, alerter: ctx.alerter});
      options.order?.push(`rule:${id}:${range.from}-${range.to}`);
      await options.onLogs?.(ctx, logs, range);
    },
  };
  return rule;
}

/** A ccip rule stand-in that, like the real one, extends its cursor and removes each range it scanned from its gaps. */
export function fillingCcipRule(): SpyEventRule {
  return spyEventRule("ccip", {
    onLogs: (ctx, _logs, range) => {
      const scan = readScan(ctx.store, ctx.name);
      if (scan.cursor && range.to > scan.cursor.to) scan.cursor = {...scan.cursor, to: range.to};
      scan.gaps = scan.gaps.flatMap((gap) => {
        if (gap.to < range.from || gap.from > range.to) return [gap];
        return gap.to > range.to ? [{...gap, from: range.to + 1n}] : [];
      });
      writeScan(ctx.store, ctx.name, scan);
    },
  });
}

export interface SpyStateRule extends StateRule {
  calls: Array<{chain: string; block: bigint}>;
}

export function spyStateRule(
  id: string,
  check: (ctx: ChainContext, block: bigint) => Alert[] | Promise<Alert[]> = () => [],
  order?: string[],
): SpyStateRule {
  const rule: SpyStateRule = {
    id,
    calls: [],
    async check(ctx, block) {
      rule.calls.push({chain: ctx.name, block});
      order?.push(`state:${id}:${block}`);
      return {conditions: await check(ctx, block), snapshot: {[`${id} value`]: `at ${block}`}};
    },
  };
  return rule;
}

export function condition(chain: string, rule: string, subject: string, extra: Partial<Alert> = {}): Alert {
  return {
    key: `${chain}:${rule}:${subject}`,
    kind: "condition",
    severity: "high",
    rule,
    chain,
    title: `${rule} ${subject}`,
    ...extra,
  };
}

export interface FetchCall {
  chain: string;
  range: BlockRange;
  filters: number;
}

export interface TestDaemonOptions extends Partial<Omit<DaemonOptions, "now">> {
  heads?: Record<string, bigint>;
  clock?: Clock;
  order?: string[];
  /** fetchLogs fails for these chunk starts (once each unless `failAlways`). */
  failChunks?: bigint[];
  failAlways?: boolean;
}

/**
 * A Daemon over fake chains with spy-friendly defaults: no rules, manual timers, a capture sink, an in-memory store,
 * a resolver returning `fakeAddresses()`, and a fetchLogs returning no logs.
 */
export function testDaemon(options: TestDaemonOptions = {}) {
  const config = options.config ?? daemonConfig();
  const clock = options.clock ?? {now: T0};
  const order = options.order ?? [];
  const sink = new CaptureSink("capture", order);
  const timers = (options.timers as ManualTimers | undefined) ?? new ManualTimers();
  const chains: Record<string, FakeChain> = {};
  for (const name of Object.keys(config.chains)) chains[name] = fakeChain(options.heads?.[name] ?? 100n);
  const fetches: FetchCall[] = [];
  const failing = new Set(options.failChunks ?? []);
  const resolves: Array<{chain: string; block: bigint}> = [];
  const store = options.store ?? createStore();
  const daemon = new Daemon({
    log: silentLogger,
    eventRules: [],
    stateRules: [],
    backfillRules: [],
    sinks: [sink],
    resolve: async (_client, chain, block) => {
      const name = Object.entries(config.chains).find(([, entry]) => entry === chain)?.[0] ?? "?";
      resolves.push({chain: name, block});
      order.push(`resolve:${block}`);
      return fakeAddresses();
    },
    fetchLogs: async (client, filters, range) => {
      const name = Object.entries(chains).find(([, fake]) => fake.client === client)?.[0] ?? "?";
      fetches.push({chain: name, range, filters: filters.length});
      order.push(`fetch:${range.from}-${range.to}`);
      if (failing.has(range.from)) {
        if (!options.failAlways) failing.delete(range.from);
        throw new Error(`eth_getLogs failed at https://rpc0.example.com/v2/secret-api-key-${name}`);
      }
      return [];
    },
    ...options,
    config,
    store,
    timers,
    now: () => clock.now,
    createClient: options.createClient ?? ((name) => chains[name]!.client),
  });
  // Delivery runs in the background: waits until no send is in progress (bounded; ManualTimers never fire it).
  const delivered = () => daemon.alerter.drain(60_000);
  return {daemon, config, clock, order, sink, timers, chains, fetches, resolves, store, delivered};
}

export function logger(): Logger & {lines: Array<{level: string; message: string; fields?: Record<string, unknown>}>} {
  const lines: Array<{level: string; message: string; fields?: Record<string, unknown>}> = [];
  const log = {
    lines,
    debug: (message: string, fields?: Record<string, unknown>) => lines.push({level: "debug", message, fields}),
    info: (message: string, fields?: Record<string, unknown>) => lines.push({level: "info", message, fields}),
    warn: (message: string, fields?: Record<string, unknown>) => lines.push({level: "warn", message, fields}),
    error: (message: string, fields?: Record<string, unknown>) => lines.push({level: "error", message, fields}),
    child: () => log,
  };
  return log;
}

interface ReadParams {
  address: Address;
  functionName: string;
  args?: readonly unknown[];
  blockNumber?: bigint;
}

/**
 * readContract over the state-deployment model at `block` (the confirmed head), plus what address resolution and
 * reconciliation read: Manager TOKEN/TOKEN_ADMIN_REGISTRY/adapterCount/getAdapter/getAdapterHistory, registry getPool,
 * token totalSupply, block numbers and headers.
 */
export function deploymentClient(model: Deployment, block: bigint, logs: RpcLog[] = []): PublicClient {
  const state = stateClient(model, block).client as unknown as {readContract(params: ReadParams): unknown};
  const lower = (address: string) => address.toLowerCase();
  return {
    async request({method, params}: {method: string; params: unknown[]}) {
      if (method !== "eth_getLogs") throw new Error(`unexpected method ${method}`);
      const filter = params[0] as {address: Address | Address[]; fromBlock: Hex; toBlock: Hex};
      const addresses = (Array.isArray(filter.address) ? filter.address : [filter.address]).map(lower);
      return logs.filter((log) => {
        const at = BigInt(log.blockNumber ?? "0x0");
        return addresses.includes(lower(log.address)) && at >= BigInt(filter.fromBlock) && at <= BigInt(filter.toBlock);
      });
    },
    async getBlockNumber() {
      return block;
    },
    async getBlock(params: {blockNumber?: bigint; blockTag?: string}) {
      if (params.blockTag === "finalized") return {number: block, timestamp: 1_760_000_000n};
      return {number: params.blockNumber ?? block, timestamp: 1_760_000_000n};
    },
    async readContract(params: ReadParams) {
      const address = lower(params.address);
      if (address === lower(A.manager)) {
        const m = model.manager;
        switch (params.functionName) {
          case "TOKEN":
            return A.token;
          case "TOKEN_ADMIN_REGISTRY":
            return A.registry;
          case "adapterCount":
            return BigInt(m.adapters.length);
          case "getAdapter": {
            const entry = m.adapters[Number(params.args?.[0]) - 1];
            if (!entry) throw new Error("execution reverted: UnknownAdapter");
            return {...entry};
          }
          case "getAdapterHistory":
            return [...m.history];
        }
      }
      if (address === lower(A.registry) && params.functionName === "getPool") return model.registry.tokenPool;
      if (address === lower(A.token) && params.functionName === "totalSupply") return tokens(10_000_000_000);
      return state.readContract(params);
    },
  } as unknown as PublicClient;
}
