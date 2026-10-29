import {isAddressEqual, numberToHex, type Hex, type Log} from "viem";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {CCIP_TOPICS, decodeExecutionState} from "../src/abi/ccip.ts";
import {computeInFlight} from "../src/ccip/inflight.ts";
import {
  ccipGaps,
  executionStatus,
  readExec,
  readScan,
  readSent,
  RETENTION_SEC,
  type ExecRecord,
} from "../src/ccip/store.ts";
import {ccipEventsRule, tokenHandlingTarget} from "../src/ccip/tracker.ts";
import {fetchLogs} from "../src/chain/scanner.ts";
import {configSchema} from "../src/config.ts";
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
  execLogV2,
  fakeClient,
  insufficientBalanceError,
  lockLog,
  OFFRAMP_V12,
  OFFRAMP_V15,
  OFFRAMP_V2,
  ONRAMP_V2,
  POOL,
  receiverError,
  SAHARA,
  T0,
  txHash,
  type ChainName,
  type ReadCall,
} from "./helpers/ccip-fakes.ts";

const MSG = {
  /** ETH -> BSC, OnRamp 2.0.0 (eth-send-v2.json), executed by bsc-exec-v2.json. */
  ethToBsc: "0x464c1cd159afdc6ef58d0797e92c5332fa25c6630015cfffdc1e64edf4612a64",
  /** BSC -> ETH, OnRamp 2.0.0 (bsc-send-v2.json), executed by eth-exec-v2.json. */
  bscToEth: "0xe70919efc1c62d574d9067333f31573db8863e61f6c9e9cba1bca49046591db8",
  /** ETH -> BSC, EVM2EVMOnRamp 1.5.0 (eth-send-v15.json), executed in bsc-exec-v15-batch.json. */
  ethToBscV15: "0x2a4b9cf533a631fea76d2f9f9f9a5cf3111c9913f43e6a0d31ce9c250895cc3f",
  /** BSC -> ETH, EVM2EVMOnRamp 1.5.0 (bsc-send-v15.json), executed by eth-exec-v15.json. */
  bscToEthV15: "0xfb5a22f89a399301267f1738c530e86f3a4e58b7a82bc7230269333edb5714c2",
} as const;

const BSC_TO_ETH_AMOUNT = 3975300385764232335217n;

const isPool = (log: Log) => isAddressEqual(log.address, POOL);

function fixture(name: string) {
  const {fixture, logs} = loadReceipt(name);
  const block = BigInt(fixture.blockNumber);
  return {logs, tx: fixture.transactionHash, block, range: {from: block, to: block} as BlockRange};
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

beforeEach(() => {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime((T0 + 3600) * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ccip source side", () => {
  it("links an OnRamp 2.0.0 lock to its message, fetching the new OnRamp's logs for the range", async () => {
    const send = fixture("eth-send-v2.json");
    const {eth, ethFake, store} = ccipPair({ethereum: {logs: send.logs}});
    // First cycle: the filters only had the pool; the scanner passes the pool logs.
    await at(eth, send.logs.filter(isPool), send.range);

    const record = readSent(store, "ethereum")[MSG.ethToBsc];
    expect(record).toEqual({
      messageId: MSG.ethToBsc,
      sourceChain: "ethereum",
      destSelector: BSC,
      destChain: "bsc",
      amount: 37201291377450963840000n,
      receiver: "0xA00049b5f36c6fdF35bEbC9f204F60E6D567C45E",
      sender: "0x023fa838682C115c2cFBA96Ef3791CB5Bd931Fc7",
      pool: POOL,
      onRamp: ONRAMP_V2.ethereum,
      kind: "OnRamp 2.0.0",
      sequenceNumber: 2239n,
      sentBlock: send.block,
      sentAt: T0,
      txHash: send.tx,
      logIndex: 301,
    });
    expect(ethFake.receipts).toEqual([]);
    expect(eth.alerter.emitted).toEqual([]);

    // The Router's ramps were read at the range end and fetched for the whole range.
    expect(ethFake.reads.filter((read) => read.functionName === "getOnRamp")).toEqual([
      {address: expect.any(String), functionName: "getOnRamp", args: [BSC], blockNumber: send.block},
    ]);
    expect(ethFake.getLogs).toHaveLength(4);
    const scan = readScan(store, "ethereum");
    expect(scan.cursor).toEqual({from: send.block, to: send.block});
    expect(scan.onRamps).toEqual([ONRAMP_V2.ethereum]);
    expect(scan.offRamps.map((entry) => entry.offRamp)).toEqual([
      OFFRAMP_V12.ethereum,
      OFFRAMP_V15.ethereum,
      OFFRAMP_V2.ethereum,
    ]);
    expect(scan.offRamps.every((entry) => entry.sourceChainSelector === BSC)).toBe(true);
  });

  it("requests the known ramps in later cycles (lanes narrowed by selector) and does not refetch them", async () => {
    const send = fixture("eth-send-v2.json");
    const {eth, ethFake} = ccipPair({ethereum: {logs: send.logs}});
    const poolFilter = {address: [POOL], topics: [[expect.any(String), expect.any(String)]]};
    expect(ccipEventsRule.filters(eth)).toEqual([poolFilter]);
    await at(eth, send.logs.filter(isPool), send.range);

    const bscTopic = numberToHex(BSC, {size: 32});
    const offRamps = [OFFRAMP_V12.ethereum, OFFRAMP_V15.ethereum, OFFRAMP_V2.ethereum];
    expect(ccipEventsRule.filters(eth).slice(1)).toEqual([
      {address: [ONRAMP_V2.ethereum], topics: [[CCIP_TOPICS.messageSent], [bscTopic]]},
      {address: [ONRAMP_V2.ethereum], topics: [[CCIP_TOPICS.sendRequested]]},
      {address: offRamps, topics: [[CCIP_TOPICS.executionStateChangedV2], [bscTopic]]},
      {address: offRamps, topics: [[CCIP_TOPICS.executionStateChanged]]},
    ]);

    ethFake.getLogs.length = 0;
    await at(eth, [], {from: send.block + 1n, to: send.block + 5n});
    expect(ethFake.getLogs).toEqual([]);
  });

  it("links EVM2EVMOnRamp 1.5.0 locks through the receipt, taking the destination from the lock", async () => {
    for (const [name, chain, id, dest] of [
      ["eth-send-v15.json", "ethereum", MSG.ethToBscV15, "bsc"],
      ["bsc-send-v15.json", "bsc", MSG.bscToEthV15, "ethereum"],
    ] as const) {
      const send = fixture(name);
      const store = createStore();
      const fake = fakeClient({chain, logs: send.logs});
      const ctx = ccipContext(chain, {client: fake.client, store});
      await at(ctx, send.logs.filter(isPool), send.range);

      // The 1.5.0 OnRamp is no longer the Router's: its log comes from the receipt.
      expect(fake.receipts).toEqual([send.tx]);
      const record = readSent(store, chain)[id]!;
      expect(record).toMatchObject({
        kind: "EVM2EVMOnRamp",
        destChain: dest,
        amount: 10n ** 18n,
        logIndex: send.logs.at(-1)!.logIndex,
      });
      expect(record.destSelector).toBe(dest === "bsc" ? BSC : ETH);
      expect(record.receiver).toBe("0x9923c9e820F538E3C50970f97b8ceed4A9D1AFDc");
    }
  });

  it("keeps a lock whose receipt fails as pending (counted in I) and links it on a later cycle", async () => {
    const send = fixture("eth-send-v2.json");
    const {eth, ethFake, store} = ccipPair({
      ethereum: {logs: [], receipts: {[send.tx]: new Error("missing trie node")}},
    });
    await at(eth, send.logs.filter(isPool), send.range);

    expect(readSent(store, "ethereum")).toEqual({});
    const pending = readScan(store, "ethereum").pendingTxs[send.tx.toLowerCase() as Hex]!;
    expect(pending).toMatchObject({
      locked: 37201291377450963840000n,
      released: 0n,
      attempts: 1,
      error: "missing trie node",
    });
    const inFlight = computeInFlight({
      snapshots: {ethereum: send.block, bsc: 1n},
      sent: {ethereum: {}},
      exec: {},
      scan: {ethereum: readScan(store, "ethereum")},
    });
    expect(inFlight).toMatchObject({total: 37201291377450963840000n, uncertain: 37201291377450963840000n});
    expect(inFlight.entries[0]!.status).toBe("unlinked");

    ethFake.options.receipts = {[send.tx]: send.logs};
    await at(eth, [], {from: send.block + 1n, to: send.block + 1n});
    expect(readSent(store, "ethereum")[MSG.ethToBsc]?.amount).toBe(37201291377450963840000n);
    expect(readScan(store, "ethereum").pendingTxs).toEqual({});
  });

  it("records a lock whose send event does not carry this pool as unlinked", async () => {
    const send = fixture("eth-send-v2.json");
    const otherPool = send.logs.map((log) =>
      // Same message, but the lock comes from a second watched pool the message does not name.
      isPool(log) ? {...log, address: "0x0000000000000000000000000000000000000Bad"} : log,
    ) as Log[];
    const {eth, store} = ccipPair({ethereum: {logs: otherPool}});
    eth.addresses.pools = [POOL, "0x0000000000000000000000000000000000000Bad"];
    await at(eth, otherPool, send.range);

    expect(readSent(store, "ethereum")).toEqual({});
    expect(readScan(store, "ethereum").unlinked).toEqual([
      expect.objectContaining({txHash: send.tx, logIndex: 300, amount: 37201291377450963840000n, remoteSelector: BSC}),
    ]);
  });

  it("records skipped block ranges as gaps", async () => {
    const {eth, store} = ccipPair();
    await at(eth, [], {from: 100n, to: 110n});
    await at(eth, [], {from: 120n, to: 130n});
    const scan = readScan(store, "ethereum");
    expect(scan.cursor).toEqual({from: 100n, to: 130n});
    // With the OffRamps known then (the Router's at both ends), which a fill of the gap watches.
    const offRampLanes = [OFFRAMP_V12, OFFRAMP_V15, OFFRAMP_V2].map((offRamps) => ({
      offRamp: offRamps.ethereum,
      sourceChainSelector: BSC,
    }));
    expect(scan.gaps).toEqual([{from: 111n, to: 119n, detectedAt: T0 + 3600, offRampLanes}]);
  });
});

describe("ccip destination side", () => {
  it("records SAHARA executions attributed through the pool release (OffRamp 2.0.0)", async () => {
    const exec = fixture("bsc-exec-v2.json");
    const {bsc, store} = ccipPair({bsc: {logs: exec.logs}});
    await at(bsc, exec.logs.filter(isPool), exec.range);

    const record = readExec(store, "bsc")[MSG.ethToBsc]!;
    expect(record).toMatchObject({
      sourceChain: "ethereum",
      sourceSelector: ETH,
      sequenceNumber: 2239n,
      kind: "OffRamp 2.0.0",
      offRamp: OFFRAMP_V2.bsc,
      sahara: "release",
      release: {pool: POOL, recipient: "0xA00049b5f36c6fdF35bEbC9f204F60E6D567C45E", amount: 37201291377450963840000n},
      attempts: [{state: 2, block: exec.block, txHash: exec.tx, logIndex: 59, at: T0}],
    });
    expect(bsc.alerter.emitted).toEqual([]);
  });

  it("attributes an EVM2EVMOffRamp 1.5.0 batch's pool logs to the next execution, ignoring the others", async () => {
    const batch = fixture("bsc-exec-v15-batch.json");
    const {bsc, store} = ccipPair({bsc: {logs: batch.logs}});
    await at(bsc, batch.logs, batch.range);

    const exec = readExec(store, "bsc");
    expect(Object.keys(exec)).toEqual([MSG.ethToBscV15]);
    expect(exec[MSG.ethToBscV15]).toMatchObject({
      kind: "EVM2EVMOffRamp",
      sourceChain: "ethereum",
      sequenceNumber: 22379n,
      sahara: "release",
      attempts: [{state: 2, logIndex: 372}],
    });
  });

  it("alerts a failed SAHARA message and reports its manual re-execution", async () => {
    const send = fixture("bsc-send-v2.json");
    const success = fixture("eth-exec-v2.json");
    const failTx = txHash("failure");
    const failure = execLogV2(
      OFFRAMP_V2.ethereum,
      {
        sourceChainSelector: BSC,
        messageNumber: 700n,
        messageId: MSG.bscToEth,
        state: 3,
        returnData: insufficientBalanceError(SAHARA, POOL, 1n, BSC_TO_ETH_AMOUNT),
      },
      {txHash: failTx, block: 26_100_000n, logIndex: 7},
    );
    const {eth, bsc, store} = ccipPair({bsc: {logs: send.logs}, ethereum: {logs: [failure, ...success.logs]}});
    await at(bsc, send.logs.filter(isPool), send.range);
    // The failure is only on the OffRamp (no pool logs): found through the first cycle's ramp fetch.
    await at(eth, [], {from: 26_100_000n, to: 26_100_000n});

    expect(eth.alerter.emitted).toHaveLength(1);
    const alert = eth.alerter.emitted[0]!;
    expect(alert).toMatchObject({
      key: `ethereum:ccip:${failTx}:7`,
      kind: "event",
      severity: "critical",
      rule: "ccip.message-failed",
      chain: "ethereum",
      title: "CCIP message failed: 3,975.3 SAHARA to 0x7cD7…B570 stuck on ethereum; needs manual execution",
    });
    const field = (label: string) => alert.fields?.find((entry) => entry.label === label)?.value;
    expect(field("Message ID")).toBe(MSG.bscToEth);
    expect(field("Receiver")).toBe("0x7cD7b759E3E4A3FA3317c8d8c078A612d1B7B570");
    expect(field("Lane")).toBe("bsc → ethereum (OffRamp 2.0.0 #700)");
    expect(field("Failure")).toBe(
      `TokenHandlingError(target=${SAHARA}, err=ERC20InsufficientBalance(…truncated))`,
    );
    expect(alert.links?.map((link) => link.url)).toEqual([
      `https://etherscan.io/tx/${failTx}`,
      `https://bscscan.com/tx/${send.tx}`,
      `https://ccip.chain.link/msg/${MSG.bscToEth}`,
    ]);
    expect(readExec(store, "ethereum")[MSG.bscToEth]?.sahara).toBe("sent");
    expect(executionStatus(readExec(store, "ethereum")[MSG.bscToEth])).toBe("failed");

    // Manual execution after the pool was refilled: pool release, then SUCCESS with the same messageId.
    await at(eth, success.logs.filter(isPool), success.range);
    expect(eth.alerter.emitted).toHaveLength(2);
    expect(eth.alerter.emitted[1]).toMatchObject({
      key: `ethereum:ccip:${success.tx}:440`,
      severity: "info",
      rule: "ccip.message-executed",
      title: "Failed CCIP message executed: 3,975.3 SAHARA released to 0x7cD7…B570 on ethereum",
    });
    const record = readExec(store, "ethereum")[MSG.bscToEth]!;
    expect(record.sahara).toBe("release");
    expect(record.attempts.map((attempt) => [attempt.state, attempt.block])).toEqual([
      [3, 26_100_000n],
      [2, success.block],
    ]);
    expect(executionStatus(record)).toBe("executed");
    expect(executionStatus(record, success.block - 1n)).toBe("failed");
  });

  it("alerts from the source side when the destination recorded the failure first", async () => {
    const send = fixture("bsc-send-v2.json");
    const failTx = txHash("early-failure");
    const failure = execLogV2(
      OFFRAMP_V2.ethereum,
      {sourceChainSelector: BSC, messageNumber: 700n, messageId: MSG.bscToEth, state: 3, returnData: receiverError()},
      {txHash: failTx, block: 26_200_000n, logIndex: 3},
    );
    const {eth, bsc, store} = ccipPair({bsc: {logs: send.logs}, ethereum: {logs: [failure]}});
    await at(eth, [failure], {from: 26_200_000n, to: 26_200_000n});
    expect(eth.alerter.emitted).toEqual([]);
    expect(readExec(store, "ethereum")[MSG.bscToEth]).toMatchObject({sahara: null, attempts: [{state: 3}]});

    await at(bsc, send.logs.filter(isPool), send.range);
    expect(bsc.alerter.emitted).toEqual([
      expect.objectContaining({
        key: `ethereum:ccip:${failTx}:3`,
        chain: "ethereum",
        severity: "critical",
        title: "CCIP message failed: 3,975.3 SAHARA to 0x7cD7…B570 stuck on ethereum; needs manual execution",
      }),
    ]);
  });

  it("alerts a failure whose TokenHandlingError target is the token even when the send was never seen", async () => {
    const failTx = txHash("untracked");
    const messageId = `0x${"ab".repeat(32)}` as Hex;
    const failure = execLogV2(
      OFFRAMP_V2.ethereum,
      {
        sourceChainSelector: BSC,
        messageNumber: 12n,
        messageId,
        state: 3,
        returnData: insufficientBalanceError(SAHARA, POOL, 0n, 5n),
      },
      {txHash: failTx, block: 26_300_000n, logIndex: 1},
    );
    const {eth, store} = ccipPair({ethereum: {logs: [failure]}});
    await at(eth, [failure], {from: 26_300_000n, to: 26_300_000n});
    expect(eth.alerter.emitted).toEqual([
      expect.objectContaining({
        severity: "critical",
        title: "CCIP message failed on ethereum with a SAHARA token error; needs manual execution",
      }),
    ]);
    expect(readExec(store, "ethereum")[messageId]?.sahara).toBe("error-target");
  });

  it("keeps other tokens' failures for the join, follows their retry and prunes them once BSC is scanned", async () => {
    const failure = fixture("eth-exec-v2-failure.json");
    const retry = fixture("eth-exec-v2-retry.json");
    const id = "0xd5864a73f173f9019614dc30be121547ea1dde653ad4645f7d9123a5680c649b";
    const {eth, bsc, bscFake, store} = ccipPair({ethereum: {logs: [...failure.logs, ...retry.logs]}});
    await at(eth, failure.logs, failure.range);
    expect(readExec(store, "ethereum")[id]).toMatchObject({sahara: null, attempts: [{state: 3}]});
    expect(readExec(store, "ethereum")[id]?.attempts[0]?.reason).toBe(
      "TokenHandlingError(target=0x169E36F327cAA83d004f5c2668AC25A1424C940d, err=unrecognised error 0xa17e11d5)",
    );

    await at(eth, retry.logs, {from: failure.block + 1n, to: retry.block});
    expect(executionStatus(readExec(store, "ethereum")[id])).toBe("executed");
    expect(eth.alerter.emitted).toEqual([]);

    // However old: BSC (the source) has not been scanned, so the send may still turn up there.
    vi.setSystemTime((T0 + 10 * RETENTION_SEC) * 1000);
    await at(eth, [], {from: retry.block + 1n, to: retry.block + 1n});
    expect(Object.keys(readExec(store, "ethereum"))).toEqual([id]);

    // BSC's scan is past the failure by the retention (block time): a send not seen by then never will be.
    bscFake.options.timestamp = () => T0 + RETENTION_SEC + 1;
    await at(bsc, [], {from: 1n, to: 1n});
    await at(eth, [], {from: retry.block + 2n, to: retry.block + 2n});
    expect(readExec(store, "ethereum")).toEqual({});
  });

  it("ignores execution logs from contracts that are not OffRamps, even inside a bridge transaction", async () => {
    const send = fixture("bsc-send-v2.json");
    const lock = fixture("eth-send-v2.json");
    // A contract called in the same transaction as a SAHARA bridge send emits an OffRamp-shaped FAILURE.
    const spoofed = execLogV2(
      ccAddr(0xbad),
      {sourceChainSelector: BSC, messageNumber: 700n, messageId: MSG.bscToEth, state: 3, returnData: receiverError()},
      {txHash: lock.tx, block: lock.block, logIndex: 400},
    );
    const receipt = [...lock.logs, spoofed];
    const {eth, bsc, store} = ccipPair({
      bsc: {logs: send.logs},
      ethereum: {logs: [], receipts: {[lock.tx]: receipt}},
    });
    await at(bsc, send.logs.filter(isPool), send.range);
    await at(eth, lock.logs.filter(isPool), lock.range);

    expect(readSent(store, "ethereum")[MSG.ethToBsc]).toBeDefined();
    expect(readExec(store, "ethereum")).toEqual({});
    expect(eth.alerter.emitted).toEqual([]);
  });

  it("retries the first-cycle ramp fetch until it succeeds, so failures in that range are not lost", async () => {
    const send = fixture("bsc-send-v2.json");
    const failTx = txHash("backfilled");
    const failure = execLogV2(
      OFFRAMP_V2.ethereum,
      {
        sourceChainSelector: BSC,
        messageNumber: 700n,
        messageId: MSG.bscToEth,
        state: 3,
        returnData: insufficientBalanceError(SAHARA, POOL, 0n, BSC_TO_ETH_AMOUNT),
      },
      {txHash: failTx, block: 26_400_000n, logIndex: 2},
    );
    const {eth, bsc, ethFake, store} = ccipPair({
      bsc: {logs: send.logs},
      ethereum: {logs: [failure], getLogsError: new Error("upstream timeout")},
    });
    await at(bsc, send.logs.filter(isPool), send.range);
    await at(eth, [], {from: 26_400_000n, to: 26_400_000n});
    expect(readScan(store, "ethereum").backfills).toEqual([
      expect.objectContaining({from: 26_400_000n, to: 26_400_000n, attempts: 1}),
    ]);
    expect(readExec(store, "ethereum")).toEqual({});

    ethFake.options.getLogsError = undefined;
    await at(eth, [], {from: 26_400_001n, to: 26_400_001n});
    expect(readScan(store, "ethereum").backfills).toEqual([]);
    expect(executionStatus(readExec(store, "ethereum")[MSG.bscToEth])).toBe("failed");
    expect(eth.alerter.emitted.map((alert) => alert.key)).toEqual([`ethereum:ccip:${failTx}:2`]);
  });

  it("ignores executions from other source lanes", async () => {
    const failure = execLogV2(
      OFFRAMP_V2.ethereum,
      {sourceChainSelector: 777n, messageNumber: 1n, messageId: `0x${"cd".repeat(32)}`, state: 3},
      {txHash: txHash("other-lane"), block: 50n, logIndex: 0},
    );
    const {eth, store} = ccipPair({ethereum: {logs: [failure]}});
    await at(eth, [failure], {from: 50n, to: 50n});
    expect(readExec(store, "ethereum")).toEqual({});
  });

  it("raises a condition while the Router's ramps cannot be read and resolves it afterwards", async () => {
    const {eth, ethFake} = ccipPair();
    ethFake.options.read = (call) => (call.functionName === "getOffRamps" ? new Error("rpc down") : undefined);
    await at(eth, [], {from: 1n, to: 1n});
    expect(eth.alerter.emitted).toEqual([
      expect.objectContaining({key: "ethereum:ccip:ramps", kind: "condition", severity: "warning"}),
    ]);

    ethFake.options.read = undefined;
    await at(eth, [], {from: 2n, to: 2n});
    expect(eth.alerter.resolved).toContain("ethereum:ccip:ramps");
  });

  it("reads the TokenHandlingError target of a truncated OffRamp 2.0.0 failure", () => {
    const truncated = decodeExecutionState(fixture("eth-exec-v2-failure-truncated.json").logs[0]!)!;
    expect(tokenHandlingTarget(truncated.returnData)).toBe("0xDBB5Cf12408a3Ac17d668037Ce289f9eA75439D7");
    expect(tokenHandlingTarget(insufficientBalanceError(SAHARA, POOL, 0n, 1n))).toBe(SAHARA);
    expect(tokenHandlingTarget(receiverError())).toBeNull();
    expect(tokenHandlingTarget("0x")).toBeNull();
  });
});

describe("ccip pruning", () => {
  it("drops settled messages once both scans are 14 days past them: the sent record, then the execution", async () => {
    const send = fixture("bsc-send-v2.json");
    const success = fixture("eth-exec-v2.json");
    const unsettled = fixture("eth-send-v2.json");
    // Block time: T0 up to the fixtures, 14 days and a minute later after them. The wall clock does not matter.
    const after = (last: bigint) => (block: bigint) => (block > last ? T0 + RETENTION_SEC + 60 : T0);
    const {eth, bsc, store} = ccipPair({
      bsc: {logs: send.logs, timestamp: after(send.block)},
      ethereum: {logs: [...success.logs, ...unsettled.logs], timestamp: after(unsettled.block)},
    });
    vi.setSystemTime((T0 + 10 * RETENTION_SEC) * 1000);
    await at(bsc, send.logs.filter(isPool), send.range);
    await at(eth, success.logs.filter(isPool), success.range);
    await at(eth, unsettled.logs.filter(isPool), {from: success.block + 1n, to: unsettled.block});

    // BSC's scan is past the send, ETH's not yet past the execution.
    await at(bsc, [], {from: send.block + 1n, to: send.block + 1n});
    expect(Object.keys(readSent(store, "bsc"))).toEqual([MSG.bscToEth]);

    // The execution outlives the sent record: pruning it first would make the message look in flight again.
    await at(eth, [], {from: unsettled.block + 1n, to: unsettled.block + 1n});
    expect(readExec(store, "ethereum")[MSG.bscToEth]).toBeDefined();

    await at(bsc, [], {from: send.block + 2n, to: send.block + 2n});
    expect(readSent(store, "bsc")).toEqual({});

    await at(eth, [], {from: unsettled.block + 2n, to: unsettled.block + 2n});
    expect(readExec(store, "ethereum")).toEqual({});
    // Not executed: kept however old.
    expect(Object.keys(readSent(store, "ethereum"))).toEqual([MSG.ethToBsc]);
  });

  it("keeps attributed failures that were never executed", async () => {
    const failure = execLogV2(
      OFFRAMP_V2.ethereum,
      {
        sourceChainSelector: BSC,
        messageNumber: 9n,
        messageId: `0x${"ef".repeat(32)}`,
        state: 3,
        returnData: insufficientBalanceError(SAHARA, POOL, 0n, 1n),
      },
      {txHash: txHash("kept"), block: 10n, logIndex: 0},
    );
    const {eth, store} = ccipPair({ethereum: {logs: [failure]}});
    await at(eth, [failure], {from: 10n, to: 10n});
    vi.setSystemTime((T0 + 10 * RETENTION_SEC) * 1000);
    await at(eth, [], {from: 11n, to: 11n});
    const evidence = Object.values(readExec(store, "ethereum")).map((record: ExecRecord) => record.sahara);
    expect(evidence).toEqual(["error-target"]);
  });

  /**
   * ETH locks 0x464c… (eth-send-v2) an hour before BSC's block time T0; its OnRamp log is not among the scanned logs
   * (an OnRamp no longer on the Router), so only the receipt links it, and that fails until ETH's scan is 15 days past
   * T0. BSC records `bscLogs` at T0 and is 15 days past it after `bscRange` and one more block.
   */
  async function lockAwaitingReceipt(bscLogs: Log[], bscRange: BlockRange) {
    const send = fixture("eth-send-v2.json");
    const receipts: Record<string, Log[] | Error> = {[send.tx]: new Error("HTTP request failed: 429")};
    const pair = ccipPair({
      ethereum: {
        logs: send.logs.filter(isPool),
        receipts,
        timestamp: (block) => (block > send.block ? T0 + RETENTION_SEC + 86400 : T0 - 3600),
      },
      bsc: {logs: bscLogs, timestamp: (block) => (block > bscRange.to + 1n ? T0 + RETENTION_SEC + 86400 : T0)},
    });
    const {eth, bsc, store} = pair;
    await at(bsc, bscLogs.filter(isPool), bscRange);
    await at(eth, send.logs.filter(isPool), send.range);
    await at(eth, [], {from: send.block + 1n, to: send.block + 1n});
    expect(Object.values(readScan(store, "ethereum").pendingTxs).map((pending) => pending.txHash)).toEqual([send.tx]);
    expect(readSent(store, "ethereum")).toEqual({});

    // ETH's scan has no gap and is 15 days past the execution, but the lock awaiting its receipt may be its send.
    await at(bsc, [], {from: bscRange.to + 1n, to: bscRange.to + 1n});
    expect(Object.keys(readExec(store, "bsc"))).toEqual([MSG.ethToBsc]);

    receipts[send.tx] = send.logs;
    await at(eth, [], {from: send.block + 2n, to: send.block + 2n});
    expect(Object.keys(readSent(store, "ethereum"))).toEqual([MSG.ethToBsc]);
    const inFlight = computeInFlight({
      snapshots: {ethereum: send.block + 2n, bsc: bscRange.to + 1n},
      sent: {ethereum: readSent(store, "ethereum"), bsc: readSent(store, "bsc")},
      exec: {ethereum: readExec(store, "ethereum"), bsc: readExec(store, "bsc")},
      scan: {ethereum: readScan(store, "ethereum"), bsc: readScan(store, "bsc")},
    });
    return {...pair, send, inFlight};
  }

  it("keeps an execution while its source chain has a lock awaiting its receipt", async () => {
    const exec = fixture("bsc-exec-v2.json");
    const {eth, bsc, store, send, inFlight} = await lockAwaitingReceipt(exec.logs, exec.range);
    expect(inFlight).toMatchObject({total: 0n, entries: []});

    // Settled: pruned by coverage as usual, the sent record first.
    for (let i = 3n; i < 5n; i++) {
      await at(eth, [], {from: send.block + i, to: send.block + i});
      await at(bsc, [], {from: exec.block + i, to: exec.block + i});
    }
    expect(readSent(store, "ethereum")).toEqual({});
    expect(readExec(store, "bsc")).toEqual({});
  });

  it("keeps a failure it cannot attribute yet while its source chain has a lock awaiting its receipt", async () => {
    // ReceiverError: nothing on BSC alone says the message carries SAHARA.
    const failTx = txHash("receiver-error");
    const failure = execLogV2(
      OFFRAMP_V2.bsc,
      {sourceChainSelector: ETH, messageNumber: 1n, messageId: MSG.ethToBsc, state: 3, returnData: receiverError()},
      {txHash: failTx, block: 500n, logIndex: 0},
    );
    const {eth, bsc, inFlight} = await lockAwaitingReceipt([failure], {from: 500n, to: 500n});
    expect(bsc.alerter.emitted).toEqual([]);
    expect(inFlight.entries.map((entry) => [entry.messageId, entry.status])).toEqual([[MSG.ethToBsc, "failed"]]);
    // The join is made, and paged, from the source side once the receipt links the lock.
    expect(eth.alerter.emitted.map((alert) => [alert.rule, alert.key])).toEqual([
      ["ccip.message-failed", `bsc:ccip:${failTx}:0`],
    ]);
  });
});

describe("ccip retention", () => {
  it("keeps unlinked locks and transactions awaiting their receipt counted in I however old they get", async () => {
    const send = fixture("eth-send-v2.json");
    const bad = ccAddr(0xbad);
    // A lock from a second watched pool that the message does not name (never links), and a lock whose receipt fails.
    const otherPool = send.logs.map((log) => (isPool(log) ? {...log, address: bad} : log)) as Log[];
    const unreceipted = txHash("unreceipted");
    const lock = lockLog(
      {remoteChainSelector: BSC, onRamp: ONRAMP_V2.ethereum, amount: 100n},
      {txHash: unreceipted, block: send.block + 1n, logIndex: 0},
    );
    const {eth, store} = ccipPair({
      ethereum: {logs: [...otherPool, lock], receipts: {[unreceipted]: new Error("missing trie node")}},
    });
    eth.addresses.pools = [POOL, bad];
    await at(eth, [...otherPool, lock], {from: send.block, to: send.block + 1n});
    const inFlight = () =>
      computeInFlight({
        snapshots: {ethereum: send.block + 10n, bsc: 1n},
        sent: {ethereum: readSent(store, "ethereum")},
        exec: {},
        scan: {ethereum: readScan(store, "ethereum")},
      });
    const amount = 37201291377450963840000n + 100n;
    expect(inFlight()).toMatchObject({total: amount, uncertain: amount});

    vi.setSystemTime((T0 + 10 * RETENTION_SEC) * 1000);
    await at(eth, [], {from: send.block + 2n, to: send.block + 2n});
    expect(inFlight()).toMatchObject({total: amount, uncertain: amount});
    expect(readScan(store, "ethereum").pendingTxs[unreceipted.toLowerCase() as Hex]?.attempts).toBe(2);
  });

  it("retries every transaction awaiting its receipt in turn, fewest attempts first", async () => {
    const locks = Array.from({length: 12}, (_, i) =>
      lockLog(
        {remoteChainSelector: BSC, onRamp: ONRAMP_V2.ethereum, amount: 1n},
        {txHash: txHash(`unreceipted-${i}`), block: 10n + BigInt(i), logIndex: 0},
      ),
    );
    const receipts = Object.fromEntries(locks.map((log) => [log.transactionHash!, new Error("not found")]));
    const {eth, ethFake, store} = ccipPair({ethereum: {logs: locks, receipts}});
    await at(eth, locks, {from: 10n, to: 21n});
    ethFake.receipts.length = 0;

    // 10 lookups per cycle: the two left out of the first retry go first in the next one.
    await at(eth, [], {from: 22n, to: 22n});
    await at(eth, [], {from: 23n, to: 23n});
    expect(ethFake.receipts).toHaveLength(20);
    expect(new Set(ethFake.receipts).size).toBe(12);
    expect(Object.keys(readScan(store, "ethereum").pendingTxs)).toHaveLength(12);
  });

  it("retries a ramp log backfill however long it keeps failing", async () => {
    const {eth, store} = ccipPair({ethereum: {getLogsError: new Error("upstream timeout")}});
    await at(eth, [], {from: 26_400_000n, to: 26_400_000n});
    vi.setSystemTime((T0 + 10 * RETENTION_SEC) * 1000);
    await at(eth, [], {from: 26_400_001n, to: 26_400_001n});
    expect(readScan(store, "ethereum").backfills).toEqual([
      expect.objectContaining({from: 26_400_000n, to: 26_400_000n, attempts: 2}),
    ]);
  });
});

describe("ccip gaps", () => {
  it("fills a gap from a scan of its blocks, leaving the cursor and the Router's current ramps alone", async () => {
    // A SAHARA failure in blocks skipped while tracking was off, on an OffRamp the Router only listed back then.
    const oldOffRamp = ccAddr(0x01d);
    const failTx = txHash("in-gap");
    const failure = execLogV2(
      oldOffRamp,
      {
        sourceChainSelector: BSC,
        messageNumber: 5n,
        messageId: MSG.bscToEth,
        state: 3,
        returnData: insufficientBalanceError(SAHARA, POOL, 0n, 1n),
      },
      {txHash: failTx, block: 450n, logIndex: 1},
    );
    const {eth, ethFake, store} = ccipPair({ethereum: {logs: [failure]}});
    const thenRamps = [{sourceChainSelector: BSC, offRamp: oldOffRamp}];
    const routerThen = (call: ReadCall) =>
      call.functionName === "getOffRamps" && call.blockNumber! <= 500n ? thenRamps : undefined;
    ethFake.options.read = routerThen;
    await scan(eth, {from: 100n, to: 399n});
    await scan(eth, {from: 501n, to: 600n});
    expect(ccipGaps(store, "ethereum")).toEqual([{from: 400n, to: 500n}]);
    const before = readScan(store, "ethereum");
    expect(before).toMatchObject({cursor: {from: 100n, to: 600n}, rampsBlock: 600n, coveredAt: T0});
    expect(before.offRamps.map((entry) => entry.offRamp)).not.toContain(oldOffRamp);

    await scan(eth, {from: 400n, to: 450n});
    expect(ccipGaps(store, "ethereum")).toEqual([{from: 451n, to: 500n}]);
    expect(executionStatus(readExec(store, "ethereum")[MSG.bscToEth])).toBe("failed");
    expect(eth.alerter.emitted.map((alert) => alert.key)).toEqual([`ethereum:ccip:${failTx}:1`]);
    // Only the gap changed: same cursor, coverage time, ramps (and no ramps condition).
    expect({...readScan(store, "ethereum"), gaps: []}).toEqual({...before, gaps: []});

    await scan(eth, {from: 451n, to: 500n});
    expect(ccipGaps(store, "ethereum")).toEqual([]);
    expect(readScan(store, "ethereum").cursor).toEqual({from: 100n, to: 600n});

    // Blocks between an earlier range and the cursor are a gap too.
    await scan(eth, {from: 10n, to: 20n});
    expect(readScan(store, "ethereum").cursor).toEqual({from: 10n, to: 600n});
    expect(ccipGaps(store, "ethereum")).toEqual([{from: 21n, to: 99n}]);
  });

  it("fills a gap with the known ramps when the RPC no longer has the Router's state there", async () => {
    const failTx = txHash("in-pruned-gap");
    const failure = execLogV2(
      OFFRAMP_V2.ethereum,
      {
        sourceChainSelector: BSC,
        messageNumber: 5n,
        messageId: MSG.bscToEth,
        state: 3,
        returnData: insufficientBalanceError(SAHARA, POOL, 0n, 1n),
      },
      {txHash: failTx, block: 450n, logIndex: 1},
    );
    const {eth, ethFake, store} = ccipPair({ethereum: {logs: [failure]}});
    await scan(eth, {from: 100n, to: 399n});
    await scan(eth, {from: 501n, to: 600n});
    const before = readScan(store, "ethereum");
    eth.alerter.resolved.length = 0;

    // A full (non-archive) node serves old logs but not old state.
    ethFake.options.read = (call) =>
      call.functionName === "getOffRamps" && call.blockNumber! <= 500n ? new Error("missing trie node") : undefined;
    await scan(eth, {from: 400n, to: 500n});
    expect(ccipGaps(store, "ethereum")).toEqual([]);
    expect({...readScan(store, "ethereum"), gaps: []}).toEqual({...before, gaps: []});
    expect(executionStatus(readExec(store, "ethereum")[MSG.bscToEth])).toBe("failed");
    // The cursor's ramps condition is neither raised nor resolved by a gap's blocks.
    expect(eth.alerter.emitted.map((alert) => alert.key)).toEqual([`ethereum:ccip:${failTx}:1`]);
    expect(eth.alerter.resolved).toEqual([]);
  });

  it("keeps executions without a send while their source chain has a gap", async () => {
    const exec = fixture("bsc-exec-v2.json");
    const {eth, bsc, store} = ccipPair({
      bsc: {logs: exec.logs},
      ethereum: {timestamp: () => T0 + RETENTION_SEC + 1},
    });
    await at(bsc, exec.logs.filter(isPool), exec.range);
    await at(eth, [], {from: 100n, to: 199n});
    await at(eth, [], {from: 300n, to: 399n});
    // ETH's scan is past the execution, but its send may be in blocks 200–299.
    await at(bsc, [], {from: exec.block + 1n, to: exec.block + 1n});
    expect(Object.keys(readExec(store, "bsc"))).toEqual([MSG.ethToBsc]);

    await at(eth, [], {from: 200n, to: 299n});
    await at(bsc, [], {from: exec.block + 2n, to: exec.block + 2n});
    expect(readExec(store, "bsc")).toEqual({});
  });

  it("prunes on the counterpart's state at pruning time, not as it was when the chunk started", async () => {
    // The daemon runs each chain's loop concurrently over the one store: ETH's gap replay can record a send while a
    // BSC chunk waits on an RPC, after that chunk read ETH's sends (for another execution from the ETH lane).
    const send = fixture("eth-send-v2.json");
    const exec = fixture("bsc-exec-v2.json");
    const {eth, bsc, bscFake, store} = ccipPair({
      ethereum: {logs: send.logs, timestamp: (block) => (block >= 26_300_000n ? T0 + 30 * 86400 : T0 - 3600)},
      bsc: {logs: exec.logs},
    });
    // ETH's ccip rule skipped 26_100_001–26_299_999, which hold the send of 0x464c…; BSC keeps its execution meanwhile.
    await at(eth, [], {from: 26_000_000n, to: 26_100_000n});
    await at(eth, [], {from: 26_300_000n, to: 26_300_010n});
    await at(bsc, exec.logs.filter(isPool), exec.range);
    await at(bsc, [], {from: exec.block + 1n, to: exec.block + 1n});
    expect(Object.keys(readExec(store, "bsc"))).toEqual([MSG.ethToBsc]);

    const otherToken = execLogV2(
      OFFRAMP_V2.bsc,
      {sourceChainSelector: ETH, messageNumber: 99n, messageId: `0x${"ab".repeat(32)}`, state: 2},
      {txHash: txHash("other-token"), block: exec.block + 2n, logIndex: 0},
    );
    // BSC's chunk waits on the coverage timestamp of its last block until ETH's replay of the gap is done.
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const client = bscFake.client as unknown as {getBlock(params: {blockNumber?: bigint}): Promise<unknown>};
    const getBlock = client.getBlock.bind(client);
    client.getBlock = async (params) => {
      if (params.blockNumber === exec.block + 2n) {
        reached();
        await held;
      }
      return getBlock(params);
    };
    const chunk = at(bsc, [otherToken], {from: exec.block + 2n, to: exec.block + 2n});
    await waiting;
    await at(eth, send.logs, {from: 26_100_001n, to: 26_299_999n});
    expect(ccipGaps(store, "ethereum")).toEqual([]);
    expect(Object.keys(readSent(store, "ethereum"))).toEqual([MSG.ethToBsc]);
    release();
    await chunk;

    expect(Object.keys(readExec(store, "bsc"))).toEqual([MSG.ethToBsc]);
    const inFlight = computeInFlight({
      snapshots: {ethereum: 26_300_010n, bsc: exec.block + 2n},
      sent: {ethereum: readSent(store, "ethereum"), bsc: readSent(store, "bsc")},
      exec: {ethereum: readExec(store, "ethereum"), bsc: readExec(store, "bsc")},
      scan: {ethereum: readScan(store, "ethereum"), bsc: readScan(store, "bsc")},
    });
    expect(inFlight).toMatchObject({total: 0n, entries: []});
  });
});

describe("ccip history coverage", () => {
  // Plausible block times for the real fixtures, all long past the retention: BSC sends 0xe709… (bsc-send-v2) an hour
  // before ETH executes it (eth-exec-v2); ETH sends 0x464c… (eth-send-v2) ~14.7 days later, executed on BSC
  // (bsc-exec-v2) ~9.8 days after that.
  const A = T0 - 120 * 86400;
  const ethTime = (block: bigint) => A + Number(block - 26_114_582n) * 12;
  const bscTime = (block: bigint) => A - 3600 + Math.floor((Number(block - 125_558_398n) * 3) / 4);

  /**
   * ETH→BSC 0x464c… executed; BSC→ETH 0xe709… failed on ETH (ReceiverError: no SAHARA evidence on ETH alone) and
   * still owed. Each chain is backfilled in two chunks, one chain after the other, then both scan forward.
   */
  async function backfill(order: ChainName[]) {
    const ethSend = fixture("eth-send-v2.json");
    const bscSend = fixture("bsc-send-v2.json");
    const bscExec = fixture("bsc-exec-v2.json");
    const failTx = txHash("old-failure");
    const failure = execLogV2(
      OFFRAMP_V2.ethereum,
      {sourceChainSelector: BSC, messageNumber: 700n, messageId: MSG.bscToEth, state: 3, returnData: receiverError()},
      {txHash: failTx, block: 26_114_700n, logIndex: 3},
    );
    const pair = ccipPair({
      ethereum: {logs: [...ethSend.logs, failure], timestamp: ethTime},
      bsc: {logs: [...bscSend.logs, ...bscExec.logs], timestamp: bscTime},
    });
    const chunks: Record<ChainName, BlockRange[]> = {
      ethereum: [
        {from: 26_114_000n, to: 26_199_999n},
        {from: 26_200_000n, to: 26_220_500n},
      ],
      bsc: [
        {from: 125_558_000n, to: 126_999_999n},
        {from: 127_000_000n, to: 128_385_500n},
      ],
    };
    const ctx = {ethereum: pair.eth, bsc: pair.bsc};
    for (const chain of order) for (const range of chunks[chain]) await scan(ctx[chain], range);
    for (const chain of order) {
      const end = chunks[chain][1]!.to;
      await scan(ctx[chain], {from: end + 1n, to: end + 10n});
    }

    const {store} = pair;
    const sent = {ethereum: readSent(store, "ethereum"), bsc: readSent(store, "bsc")};
    const exec = {ethereum: readExec(store, "ethereum"), bsc: readExec(store, "bsc")};
    const scans = {ethereum: readScan(store, "ethereum"), bsc: readScan(store, "bsc")};
    const inFlight = computeInFlight({
      snapshots: {ethereum: scans.ethereum.cursor!.to, bsc: scans.bsc.cursor!.to},
      sent,
      exec,
      scan: scans,
    });
    const failed = Object.entries(exec).flatMap(([, records]) =>
      Object.values(records)
        .filter((record) => executionStatus(record) === "failed")
        .filter((record) => record.sahara !== null || record.messageId in sent[record.sourceChain as ChainName])
        .map((record) => record.messageId),
    );
    const alerts = [...pair.eth.alerter.emitted, ...pair.bsc.alerter.emitted]
      .filter((alert) => alert.rule === "ccip.message-failed")
      .map((alert) => alert.key);
    const records = [sent.ethereum, sent.bsc, exec.ethereum, exec.bsc].map((records) => Object.keys(records));
    return {total: inFlight.total, failed, alerts, records, failTx};
  }

  it("gives the same I and failed messages whichever chain is scanned first, also backfilling old blocks", async () => {
    const ethFirst = await backfill(["ethereum", "bsc"]);
    const bscFirst = await backfill(["bsc", "ethereum"]);
    for (const result of [ethFirst, bscFirst]) {
      expect(result.total).toBe(BSC_TO_ETH_AMOUNT);
      expect(result.failed).toEqual([MSG.bscToEth]);
      expect(result.alerts).toEqual([`ethereum:ccip:${result.failTx}:3`]);
    }
    // Neither scan is 14 days (block time) past the ETH→BSC execution yet: both orders keep the same records.
    expect(bscFirst.records).toEqual(ethFirst.records);
    expect(ethFirst.records).toEqual([[MSG.ethToBsc], [MSG.bscToEth], [MSG.bscToEth], [MSG.ethToBsc]]);
  });
});

describe("ccip disabled", () => {
  it("requests nothing and records nothing", async () => {
    const config = configSchema.parse({
      ...structuredClone(rawConfig()),
      chains: {...rawConfig().chains, ethereum: {...rawConfig().chains.ethereum, ccip: {enabled: false}}},
    });
    const store = createStore();
    const fake = fakeClient({chain: "ethereum"});
    const ctx = ccipContext("ethereum", {client: fake.client, store, config});
    expect(ccipEventsRule.filters(ctx)).toEqual([]);
    await at(ctx, fixture("eth-send-v2.json").logs, {from: 1n, to: 1n});
    expect(fake.reads).toEqual([]);
    expect(readScan(store, "ethereum").cursor).toBeUndefined();
  });
});

function rawConfig() {
  const chain = (name: "ethereum" | "bsc") => {
    const parsed = ccipConfig.chains[name]!;
    return {
      chainId: parsed.chainId,
      chainSelector: parsed.chainSelector.toString(),
      rpcUrls: parsed.rpcUrls,
      explorerUrl: parsed.explorerUrl,
      contracts: parsed.contracts,
    };
  };
  return {chains: {ethereum: chain("ethereum"), bsc: chain("bsc")}};
}
