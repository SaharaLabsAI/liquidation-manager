// CCIP ramps the Router no longer lists: executions of the ranges they were watched for must still be recorded (ramp
// log backfills retried after the Router dropped their OffRamp, an OffRamp retired between two forward ranges, a gap
// filled without archive state) and sends of a retired OnRamp still linked.
import {isAddressEqual, type Address, type Log} from "viem";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {
  emptyScanState,
  executionStatus,
  readExec,
  readScan,
  readSent,
  scanNamespace,
  sentNamespace,
  writeExec,
  writeScan,
  writeSent,
} from "../src/ccip/store.ts";
import {ccipEventsRule} from "../src/ccip/tracker.ts";
import {fetchLogs} from "../src/chain/scanner.ts";
import {configSchema, type Config} from "../src/config.ts";
import {createStore} from "../src/store.ts";
import type {BlockRange, ChainContext} from "../src/types.ts";
import {loadReceipt} from "./helpers/abi-fixtures.ts";
import {
  BSC,
  ccAddr,
  ccipConfig,
  ccipContext,
  ccipPair,
  ETH,
  failedExecution,
  fakeClient,
  insufficientBalanceError,
  insufficientBalanceErrorV15,
  OFFRAMP_V15,
  OFFRAMP_V2,
  ONRAMP_V2,
  POOL,
  receiverError,
  routerOffRamps,
  SAHARA,
  T0,
  txHash,
  type ChainName,
  type ReadCall,
  type RecordingAlerter,
} from "./helpers/ccip-fakes.ts";

const MSG = {
  /** BSC -> ETH, OnRamp 2.0.0 (bsc-send-v2.json), executed by eth-exec-v2.json. */
  bscToEth: "0xe70919efc1c62d574d9067333f31573db8863e61f6c9e9cba1bca49046591db8",
  /** ETH -> BSC, OnRamp 2.0.0 (eth-send-v2.json). */
  ethToBsc: "0x464c1cd159afdc6ef58d0797e92c5332fa25c6630015cfffdc1e64edf4612a64",
  /** ETH -> BSC, EVM2EVMOnRamp 1.5.0 (eth-send-v15.json), executed in bsc-exec-v15-batch.json. */
  ethToBscV15: "0x2a4b9cf533a631fea76d2f9f9f9a5cf3111c9913f43e6a0d31ce9c250895cc3f",
  /** BSC -> ETH, EVM2EVMOnRamp 1.5.0 (bsc-send-v15.json), executed by eth-exec-v15.json. */
  bscToEthV15: "0xfb5a22f89a399301267f1738c530e86f3a4e58b7a82bc7230269333edb5714c2",
} as const;

/** A third configured chain: ETH then has two counterpart lanes, so an EVM2EVM execution's lane must be known. */
const BASE = 15971525489660198786n;

const isPool = (log: Log) => isAddressEqual(log.address, POOL);

function fixture(name: string) {
  const {fixture, logs} = loadReceipt(name);
  const block = BigInt(fixture.blockNumber);
  return {logs, tx: fixture.transactionHash, block, range: {from: block, to: block} as BlockRange};
}

/** The fixture's ExecutionStateChanged (the last log of the OffRamp that executed it). */
function executionLog(name: string, offRamp: Address): Log {
  return fixture(name).logs.findLast((log) => isAddressEqual(log.address, offRamp) && log.topics.length > 2)!;
}

const at = (ctx: ChainContext, logs: Log[], range: BlockRange) => ccipEventsRule.onLogs(ctx, logs, range);

/** What the daemon's scanner hands the rule: the logs of its current filters over the range. */
async function scan(ctx: ChainContext, range: BlockRange) {
  const logs = await fetchLogs(ctx.client, ccipEventsRule.filters(ctx), range, {
    maxRange: ctx.config.maxLogRange,
    log: ctx.log,
  });
  await at(ctx, logs, range);
}

/** The Router's OffRamps without `dropped` (every lane). */
function routerWithout(chain: ChainName, ...dropped: Address[]) {
  return (call: ReadCall) =>
    call.functionName === "getOffRamps"
      ? routerOffRamps(chain).filter((entry) => !dropped.some((address) => isAddressEqual(entry.offRamp, address)))
      : undefined;
}

function threeChainConfig(): Config {
  const chains = Object.fromEntries(
    Object.entries(ccipConfig.chains).map(([name, chain]) => [
      name,
      {
        chainId: chain.chainId,
        chainSelector: chain.chainSelector.toString(),
        rpcUrls: chain.rpcUrls,
        explorerUrl: chain.explorerUrl,
        contracts: chain.contracts,
      },
    ]),
  );
  return configSchema.parse({
    chains: {
      ...chains,
      base: {
        chainId: 8453,
        chainSelector: BASE.toString(),
        rpcUrls: ["http://localhost:8547"],
        explorerUrl: "https://basescan.org",
        contracts: {token: SAHARA, registry: ccAddr(0xba1), router: ccAddr(0xba2), pool: POOL},
      },
    },
  });
}

/** ETH and BSC over one store, with `config` (three chains when the lane matters). */
function pair(config: Config, ethLogs: Log[], bscLogs: Log[]) {
  const store = createStore();
  const ethFake = fakeClient({chain: "ethereum", logs: ethLogs});
  const bscFake = fakeClient({chain: "bsc", logs: bscLogs});
  return {
    store,
    ethFake,
    bscFake,
    eth: ccipContext("ethereum", {client: ethFake.client, store, config}),
    bsc: ccipContext("bsc", {client: bscFake.client, store, config}),
  };
}

const failureAlerts = (ctx: {alerter: RecordingAlerter}) =>
  ctx.alerter.emitted.filter((alert) => alert.rule === "ccip.message-failed").map((alert) => alert.key);

beforeEach(() => {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime((T0 + 3600) * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ccip ramp log backfill of an OffRamp the Router dropped", () => {
  const cases = [
    {
      kind: "OffRamp 2.0.0",
      send: "bsc-send-v2.json",
      exec: "eth-exec-v2.json",
      offRamp: OFFRAMP_V2.ethereum,
      messageId: MSG.bscToEth,
      config: ccipConfig,
      returnData: insufficientBalanceError(SAHARA, POOL, 0n, 1n),
    },
    {
      // Three chains: the event has no source selector and the OffRamp's lane is no longer on the Router.
      kind: "EVM2EVMOffRamp 1.5.0",
      send: "bsc-send-v15.json",
      exec: "eth-exec-v15.json",
      offRamp: OFFRAMP_V15.ethereum,
      messageId: MSG.bscToEthV15,
      config: threeChainConfig(),
      returnData: insufficientBalanceErrorV15(POOL, 0n, 10n ** 18n),
    },
  ] as const;

  /** BSC sent the message; ETH's first backfill fails, the Router drops the OffRamp, then the fetch recovers. */
  async function droppedWhileFailing(scenario: (typeof cases)[number]) {
    const send = fixture(scenario.send);
    const failTx = txHash(`backfilled-${scenario.kind}`);
    const block = 26_400_000n;
    const failure = failedExecution(executionLog(scenario.exec, scenario.offRamp), scenario.returnData, {
      txHash: failTx,
      block,
      logIndex: 2,
    });
    const setup = pair(scenario.config, [failure], send.logs);
    const {eth, bsc, ethFake, store} = setup;
    await at(bsc, send.logs.filter(isPool), send.range);

    // First cycle: the Router's ramps are new, their logs for the range cannot be fetched.
    ethFake.options.getLogsError = new Error("upstream timeout");
    await at(eth, [], {from: block, to: block});
    // The Router drops the OffRamp while the backfill keeps failing.
    ethFake.options.read = routerWithout("ethereum", scenario.offRamp);
    await at(eth, [], {from: block + 1n, to: block + 1n});
    const scan = readScan(store, "ethereum");
    expect(scan.offRamps.map((entry) => entry.offRamp)).not.toContain(scenario.offRamp);
    expect(scan.backfills).toEqual([expect.objectContaining({from: block, attempts: 2})]);
    expect(readExec(store, "ethereum")).toEqual({});
    ethFake.options.getLogsError = undefined;
    return {...setup, failTx, block, entry: scan.backfills[0]!};
  }

  for (const scenario of cases) {
    it(`records a FAILURE of the ${scenario.kind} once the retry succeeds and alerts it`, async () => {
      const {eth, store, failTx, block, entry} = await droppedWhileFailing(scenario);
      // What a save during the call (an alert delivery) would write: the entry, none of its records yet.
      const atEmit: Array<{backfills: number; recorded: boolean}> = [];
      const emit = eth.alerter.emit;
      eth.alerter.emit = (alert) => {
        const recorded = scenario.messageId in readExec(store, "ethereum");
        atEmit.push({backfills: readScan(store, "ethereum").backfills.length, recorded});
        emit(alert);
      };

      await at(eth, [], {from: block + 2n, to: block + 2n});
      expect(readScan(store, "ethereum").backfills).toEqual([]);
      const record = readExec(store, "ethereum")[scenario.messageId];
      expect(record).toMatchObject({sourceChain: "bsc", sourceSelector: BSC, offRamp: scenario.offRamp});
      expect(record?.sahara).toBe("sent");
      expect(executionStatus(record)).toBe("failed");
      expect(failureAlerts(eth)).toEqual([`ethereum:ccip:${failTx}:2`]);
      expect(atEmit).toEqual([{backfills: 1, recorded: false}]);
      // The entry carried the OffRamp with its lane.
      expect(entry.offRamps).toContain(scenario.offRamp);
      expect(entry.offRampLanes).toContainEqual({offRamp: scenario.offRamp, sourceChainSelector: BSC});
    });
  }

  it("replays idempotently: from the state saved before the records, and with the entry saved after them", async () => {
    const {eth, store, failTx, block} = await droppedWhileFailing(cases[1]);
    const saved = () => ({
      scan: readScan(store, "ethereum"),
      exec: readExec(store, "ethereum"),
      sent: readSent(store, "ethereum"),
    });
    const restore = (state: ReturnType<typeof saved>) => {
      writeScan(store, "ethereum", state.scan);
      writeExec(store, "ethereum", state.exec);
      writeSent(store, "ethereum", state.sent);
    };
    const before = saved();
    const retry = {from: block + 2n, to: block + 2n};
    await at(eth, [], retry);
    const after = saved();
    expect(failureAlerts(eth)).toEqual([`ethereum:ccip:${failTx}:2`]);

    // A crash after a save that held the entry: the replay records the same, under the same (deduped) alert key.
    restore(before);
    await at(eth, [], retry);
    expect(saved()).toEqual(after);
    expect(failureAlerts(eth)).toEqual([`ethereum:ccip:${failTx}:2`, `ethereum:ccip:${failTx}:2`]);

    // The records with the entry still there: refetched, nothing new.
    restore({...after, scan: {...after.scan, backfills: before.scan.backfills}});
    await at(eth, [], retry);
    expect(saved()).toEqual(after);
    expect(failureAlerts(eth)).toHaveLength(2);
    expect(readExec(store, "ethereum")[MSG.bscToEthV15]?.attempts).toHaveLength(1);
  });

  it("keeps a backfill whose logs could not be recorded and records them next cycle", async () => {
    const {eth, store, failTx, block} = await droppedWhileFailing(cases[0]);
    // Unexpected: the join with BSC's sends throws once (decoders catch their own errors).
    const get = store.get.bind(store);
    let fail = true;
    store.get = <T>(namespace: string, fallback: T): T => {
      if (fail && namespace === sentNamespace("bsc")) {
        fail = false;
        throw new Error("state unreadable");
      }
      return get(namespace, fallback);
    };
    await at(eth, [], {from: block + 2n, to: block + 2n});
    expect(readExec(store, "ethereum")).toEqual({});
    expect(readScan(store, "ethereum")).toMatchObject({pendingTxs: {}, backfills: [{from: block, attempts: 3}]});

    await at(eth, [], {from: block + 3n, to: block + 3n});
    expect(readScan(store, "ethereum").backfills).toEqual([]);
    expect(executionStatus(readExec(store, "ethereum")[MSG.bscToEth])).toBe("failed");
    expect(failureAlerts(eth)).toEqual([`ethereum:ccip:${failTx}:2`]);
  });

  it("records each backfill on its own: one still failing stays, with its lanes, until it is fetched", async () => {
    // Three chains. Entry 1: the first cycle's ramps (OffRamp 2.0.0, dropped next); its range holds a SAHARA failure
    // and a real failure of another token's message. Entry 2: a gap's OffRamps not on the Router now: OLD (an EVM2EVM
    // 1.5.0 OffRamp, read at the gap's end), with a failure there, and OffRamp 2.0.0 (known at its start).
    const old = ccAddr(0x01d);
    const otherToken = fixture("eth-exec-v2-failure.json");
    const otherId = "0xd5864a73f173f9019614dc30be121547ea1dde653ad4645f7d9123a5680c649b";
    const v2Tx = txHash("entry-1");
    const v15Tx = txHash("entry-2");
    const v2Failure = failedExecution(
      executionLog("eth-exec-v2.json", OFFRAMP_V2.ethereum),
      insufficientBalanceError(SAHARA, POOL, 0n, 1n),
      {txHash: v2Tx, block: 26_049_600n, logIndex: 4},
    );
    const v15Failure = {
      ...failedExecution(
        executionLog("eth-exec-v15.json", OFFRAMP_V15.ethereum),
        insufficientBalanceErrorV15(POOL, 0n, 10n ** 18n),
        {txHash: v15Tx, block: 26_055_000n, logIndex: 9},
      ),
      address: old,
    };
    const sends = [...fixture("bsc-send-v2.json").logs, ...fixture("bsc-send-v15.json").logs];
    const {eth, bsc, ethFake, store} = pair(threeChainConfig(), [...otherToken.logs, v2Failure, v15Failure], sends);
    for (const name of ["bsc-send-v2.json", "bsc-send-v15.json"]) {
      const send = fixture(name);
      await at(bsc, send.logs.filter(isPool), send.range);
    }
    const now = routerOffRamps("ethereum").filter((entry) => !isAddressEqual(entry.offRamp, OFFRAMP_V2.ethereum));
    ethFake.options.read = (call) => {
      if (call.functionName !== "getOffRamps") return undefined;
      if (call.blockNumber! < 26_050_000n) return routerOffRamps("ethereum");
      return call.blockNumber! < 26_060_000n ? [...now, {sourceChainSelector: BSC, offRamp: old}] : now;
    };
    ethFake.options.getLogsError = new Error("upstream timeout");
    const gap = {from: 26_050_000n, to: 26_059_999n};
    await at(eth, [], {from: 26_049_000n, to: 26_049_999n});
    await at(eth, [], {from: 26_060_000n, to: 26_060_099n});
    expect(readScan(store, "ethereum").gaps).toEqual([expect.objectContaining(gap)]);
    await at(eth, [], gap);
    expect(readScan(store, "ethereum").backfills).toEqual([
      expect.objectContaining({from: 26_049_000n, attempts: 3}),
      expect.objectContaining({...gap, attempts: 1}),
    ]);

    // Only the gap's blocks still fail.
    const inGap = (range: BlockRange) => range.from >= gap.from && range.to <= gap.to;
    ethFake.options.getLogsError = (range) => (inGap(range) ? new Error("HTTP request failed: 429") : undefined);
    await at(eth, [], {from: 26_060_100n, to: 26_060_100n});
    expect(executionStatus(readExec(store, "ethereum")[MSG.bscToEth])).toBe("failed");
    expect(readExec(store, "ethereum")[otherId]).toMatchObject({sahara: null, attempts: [{state: 3}]});
    expect(readExec(store, "ethereum")[MSG.bscToEthV15]).toBeUndefined();
    expect(failureAlerts(eth)).toEqual([`ethereum:ccip:${v2Tx}:4`]);
    expect(readScan(store, "ethereum").backfills).toEqual([
      {
        ...gap,
        onRamps: [],
        offRamps: [old, OFFRAMP_V2.ethereum],
        offRampLanes: [
          {offRamp: old, sourceChainSelector: BSC},
          {offRamp: OFFRAMP_V2.ethereum, sourceChainSelector: BSC},
        ],
        firstSeenAt: T0 + 3600,
        attempts: 2,
      },
    ]);

    ethFake.options.getLogsError = undefined;
    await at(eth, [], {from: 26_060_101n, to: 26_060_101n});
    expect(readScan(store, "ethereum").backfills).toEqual([]);
    expect(readExec(store, "ethereum")[MSG.bscToEthV15]).toMatchObject({offRamp: old, sourceSelector: BSC});
    expect(executionStatus(readExec(store, "ethereum")[MSG.bscToEthV15])).toBe("failed");
    expect(failureAlerts(eth)).toEqual([`ethereum:ccip:${v2Tx}:4`, `ethereum:ccip:${v15Tx}:9`]);
  });

  it("records only the SAHARA SUCCESS of a backfilled EVM2EVM batch, before its receipt is fetched", async () => {
    const send = fixture("eth-send-v15.json");
    const batch = fixture("bsc-exec-v15-batch.json");
    const {eth, bsc, bscFake, store} = pair(threeChainConfig(), send.logs, batch.logs);
    await at(eth, send.logs.filter(isPool), send.range);
    const receipts: Record<string, Log[] | Error> = {[batch.tx]: new Error("HTTP request failed: 429")};
    bscFake.options.receipts = receipts;
    bscFake.options.getLogsError = new Error("upstream timeout");
    await at(bsc, batch.logs.filter(isPool), batch.range);
    expect(Object.keys(readScan(store, "bsc").pendingTxs)).toEqual([batch.tx.toLowerCase()]);
    bscFake.options.read = routerWithout("bsc", OFFRAMP_V15.bsc);
    await at(bsc, [], {from: batch.block + 1n, to: batch.block + 1n});

    // The batch's three executions arrive without the pool logs: the two other messages carry no SAHARA evidence.
    bscFake.options.getLogsError = undefined;
    await at(bsc, [], {from: batch.block + 2n, to: batch.block + 2n});
    expect(readScan(store, "bsc").backfills).toEqual([]);
    expect(Object.keys(readExec(store, "bsc"))).toEqual([MSG.ethToBscV15]);
    expect(readExec(store, "bsc")[MSG.ethToBscV15]).toMatchObject({sourceSelector: ETH, sahara: "sent"});
    expect(executionStatus(readExec(store, "bsc")[MSG.ethToBscV15])).toBe("executed");

    receipts[batch.tx] = batch.logs;
    await at(bsc, [], {from: batch.block + 3n, to: batch.block + 3n});
    const record = readExec(store, "bsc")[MSG.ethToBscV15];
    expect(record).toMatchObject({sahara: "release", attempts: [{state: 2, logIndex: 372}]});
    expect(readScan(store, "bsc").pendingTxs).toEqual({});
    expect(bsc.alerter.emitted).toEqual([]);
  });

  it("reads backfills saved with bare OffRamp addresses, recovering their lanes from the stored ramps", async () => {
    const send = fixture("bsc-send-v15.json");
    const sendV2 = fixture("bsc-send-v2.json");
    const v15Tx = txHash("legacy-v15");
    const v2Tx = txHash("legacy-v2");
    const failures = [
      failedExecution(
        executionLog("eth-exec-v15.json", OFFRAMP_V15.ethereum),
        insufficientBalanceErrorV15(POOL, 0n, 10n ** 18n),
        {txHash: v15Tx, block: 26_400_000n, logIndex: 1},
      ),
      failedExecution(executionLog("eth-exec-v2.json", OFFRAMP_V2.ethereum), receiverError(), {
        txHash: v2Tx,
        block: 26_400_000n,
        logIndex: 2,
      }),
    ];
    const {eth, bsc, ethFake, store} = pair(threeChainConfig(), failures, [...send.logs, ...sendV2.logs]);
    for (const sent of [send, sendV2]) await at(bsc, sent.logs.filter(isPool), sent.range);
    // As the previous version saved it: the stored ramps still list the 1.5.0 OffRamp (not 2.0.0), the entry has no
    // lanes. The Router no longer lists either.
    store.set(scanNamespace("ethereum"), {
      ...emptyScanState(),
      cursor: {from: 26_400_000n, to: 26_400_000n},
      onRamps: [ONRAMP_V2.ethereum],
      offRamps: [{offRamp: OFFRAMP_V15.ethereum, sourceChainSelector: BSC}],
      backfills: [
        {
          from: 26_400_000n,
          to: 26_400_000n,
          onRamps: [],
          offRamps: [OFFRAMP_V15.ethereum, OFFRAMP_V2.ethereum],
          firstSeenAt: T0,
          attempts: 4,
        },
      ],
    });
    const legacy = readScan(store, "ethereum").backfills[0];
    ethFake.options.read = routerWithout("ethereum", OFFRAMP_V15.ethereum, OFFRAMP_V2.ethereum);

    await at(eth, [], {from: 26_400_001n, to: 26_400_001n});
    expect(readScan(store, "ethereum").backfills).toEqual([]);
    // 1.5.0: the recovered lane; 2.0.0: the event's source selector.
    expect(readExec(store, "ethereum")[MSG.bscToEthV15]).toMatchObject({sourceSelector: BSC, sahara: "sent"});
    expect(readExec(store, "ethereum")[MSG.bscToEth]).toMatchObject({sourceSelector: BSC, sahara: "sent"});
    expect(failureAlerts(eth)).toEqual([`ethereum:ccip:${v15Tx}:1`, `ethereum:ccip:${v2Tx}:2`]);
    expect(legacy?.offRampLanes).toEqual([{offRamp: OFFRAMP_V15.ethereum, sourceChainSelector: BSC}]);
  });
});

describe("ccip OffRamp retired between two forward ranges", () => {
  it("records an EVM2EVM FAILURE of the range the Router dropped its OffRamp in", async () => {
    const send = fixture("bsc-send-v15.json");
    const failTx = txHash("retired-in-range");
    const failure = failedExecution(
      executionLog("eth-exec-v15.json", OFFRAMP_V15.ethereum),
      insufficientBalanceErrorV15(POOL, 0n, 10n ** 18n),
      {txHash: failTx, block: 250n, logIndex: 0},
    );
    const {eth, bsc, ethFake, store} = pair(threeChainConfig(), [failure], send.logs);
    await at(bsc, send.logs.filter(isPool), send.range);
    // The Router lists the 1.5.0 OffRamp up to block 260.
    ethFake.options.read = (call) =>
      call.blockNumber! > 260n ? routerWithout("ethereum", OFFRAMP_V15.ethereum)(call) : undefined;
    await scan(eth, {from: 100n, to: 199n});
    await scan(eth, {from: 200n, to: 299n});

    expect(readScan(store, "ethereum").offRamps.map((entry) => entry.offRamp)).not.toContain(OFFRAMP_V15.ethereum);
    expect(readExec(store, "ethereum")[MSG.bscToEthV15]).toMatchObject({sourceSelector: BSC, sahara: "sent"});
    expect(failureAlerts(eth)).toEqual([`ethereum:ccip:${failTx}:0`]);
  });
});

describe("ccip gap filled without archive state", () => {
  it("watches the OffRamps known when the gap was recorded, which the Router has dropped since", async () => {
    // A SAHARA failure in blocks skipped while tracking was off, on an OffRamp the Router only listed back then.
    const send = fixture("bsc-send-v15.json");
    const oldOffRamp = ccAddr(0x01d);
    const failTx = txHash("in-gap");
    const failure = {
      ...failedExecution(
        executionLog("eth-exec-v15.json", OFFRAMP_V15.ethereum),
        insufficientBalanceErrorV15(POOL, 0n, 10n ** 18n),
        {txHash: failTx, block: 450n, logIndex: 1},
      ),
      address: oldOffRamp,
    };
    const {eth, bsc, ethFake, store} = pair(threeChainConfig(), [failure], send.logs);
    await at(bsc, send.logs.filter(isPool), send.range);
    ethFake.options.read = (call) =>
      call.functionName === "getOffRamps" && call.blockNumber! <= 500n
        ? [{sourceChainSelector: BSC, offRamp: oldOffRamp}]
        : undefined;
    await scan(eth, {from: 100n, to: 399n});
    await scan(eth, {from: 501n, to: 600n});
    expect(readScan(store, "ethereum").offRamps.map((entry) => entry.offRamp)).not.toContain(oldOffRamp);

    // A full (non-archive) node serves old logs but not old state.
    ethFake.options.read = (call) =>
      call.functionName === "getOffRamps" && call.blockNumber! <= 500n ? new Error("missing trie node") : undefined;
    await scan(eth, {from: 400n, to: 500n});
    expect(readScan(store, "ethereum").gaps).toEqual([]);
    expect(readExec(store, "ethereum")[MSG.bscToEthV15]).toMatchObject({offRamp: oldOffRamp, sourceSelector: BSC});
    expect(executionStatus(readExec(store, "ethereum")[MSG.bscToEthV15])).toBe("failed");
    expect(failureAlerts(eth)).toEqual([`ethereum:ccip:${failTx}:1`]);
  });

  it("records the lanes known at both ends of a gap with it", async () => {
    const oldOffRamp = ccAddr(0x01d);
    const {eth, ethFake, store} = ccipPair();
    ethFake.options.read = (call) =>
      call.functionName === "getOffRamps" && call.blockNumber! <= 500n
        ? [{sourceChainSelector: BSC, offRamp: oldOffRamp}]
        : undefined;
    await at(eth, [], {from: 100n, to: 399n});
    await at(eth, [], {from: 501n, to: 600n});
    const lanes = readScan(store, "ethereum").gaps[0]?.offRampLanes;
    expect(lanes).toContainEqual({offRamp: oldOffRamp, sourceChainSelector: BSC});
    expect(lanes).toContainEqual({offRamp: OFFRAMP_V15.ethereum, sourceChainSelector: BSC});
    expect(lanes).toHaveLength(4);
  });
});

describe("ccip OnRamp the Router replaced", () => {
  it("links its lock from the receipt, whatever became of the ramp log backfill", async () => {
    const send = fixture("eth-send-v2.json");
    const receipts: Record<string, Log[] | Error> = {[send.tx]: new Error("missing trie node")};
    const {eth, ethFake, store} = ccipPair({ethereum: {logs: send.logs, receipts}});
    ethFake.options.getLogsError = new Error("upstream timeout");
    await at(eth, send.logs.filter(isPool), send.range);
    expect(readScan(store, "ethereum").backfills).toEqual([
      expect.objectContaining({onRamps: [ONRAMP_V2.ethereum]}),
    ]);
    expect(Object.keys(readScan(store, "ethereum").pendingTxs)).toEqual([send.tx.toLowerCase()]);

    // The Router's OnRamp for BSC is replaced; the backfill brings the send log without its lock, the receipt both.
    ethFake.options.read = (call) => (call.functionName === "getOnRamp" ? ccAddr(0x0e2) : undefined);
    ethFake.options.getLogsError = undefined;
    await at(eth, [], {from: send.block + 1n, to: send.block + 1n});
    expect(readScan(store, "ethereum").backfills).toEqual([]);
    expect(readSent(store, "ethereum")).toEqual({});

    receipts[send.tx] = send.logs;
    await at(eth, [], {from: send.block + 2n, to: send.block + 2n});
    const sent = readSent(store, "ethereum")[MSG.ethToBsc];
    expect(sent).toMatchObject({onRamp: ONRAMP_V2.ethereum, sentBlock: send.block});
    expect(readScan(store, "ethereum").pendingTxs).toEqual({});
  });
});
