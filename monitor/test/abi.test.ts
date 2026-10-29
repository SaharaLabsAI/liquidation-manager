import {
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeErrorResult,
  getAbiItem,
  isAddressEqual,
  keccak256,
  parseAbiParameters,
  parseEventLogs,
  size,
  slice,
  toEventSelector,
  type Abi,
  type Hex,
  type Log,
} from "viem";
import {describe, expect, it} from "vitest";

import {
  CCIP_EXECUTION_TOPICS,
  CCIP_SEND_TOPICS,
  CCIP_TOPICS,
  decodeExecutionState,
  decodeMessageV1,
  decodeSentMessage,
  describeExecutionError,
  evm2EvmOffRampAbi,
  evm2EvmOnRampAbi,
  evmAddressFromBytes,
  executionStateName,
  MESSAGE_EXECUTION_STATE,
  offRampAbi,
  onRampAbi,
  type ExecutionStateChange,
  type SentMessage,
} from "../src/abi/ccip.ts";
import {routerAbi, saharaTokenAbi, tokenAdminRegistryAbi, tokenPoolAbi} from "../src/abi/external.ts";
import {loadReceipt, readFixture} from "./helpers/abi-fixtures.ts";

const ETH = 5009297550715157269n;
const BSC = 11344663589394136015n;
const SAHARA = "0xFDFfB411C4A70AA7C95D5C981a6Fb4Da867e1111";
const POOL = "0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4";
const ONRAMP_V2 = {
  ethereum: "0xc3423F3FB30857D9C14717b119884b1B63d250b7",
  bsc: "0x84a0797B31Ac0d3E1D06157663dd4b18cFFdA188",
};
const OFFRAMP_V2 = {
  ethereum: "0x408428bca0e24A25ac8baAc1b70f64AF257717c3",
  bsc: "0x4914044f8d787bd5DC7528f00775D850dC54477e",
};
const ONRAMP_V15 = {
  ethereum: "0x948306C220Ac325fa9392A6E601042A3CD0b480d",
  bsc: "0x35C724666ba31632A56Bad4390eb69f206ab60C7",
};
const OFFRAMP_V15 = {
  ethereum: "0x66d84fedED0e51aeB47ceD1BB2fc0221Ae8D7C12",
  bsc: "0xF616733641D420207b8F30db9C4cE39684768991",
};

/** topic0 of an event in a parsed ABI. */
function topicOf(abi: Abi, name: string): Hex {
  const matches = abi.filter((item) => item.type === "event" && item.name === name);
  expect(matches, `${name} declared once`).toHaveLength(1);
  return toEventSelector(getAbiItem({abi, name})! as Parameters<typeof toEventSelector>[0]);
}

const isAddr = (a: string | null | undefined, b: string): boolean => !!a && isAddressEqual(a as Hex, b as Hex);

function poolEvents(logs: Log[]) {
  return parseEventLogs({abi: tokenPoolAbi, logs: logs.filter((log) => isAddr(log.address, POOL)), strict: true});
}

function tokenTransfers(logs: Log[]) {
  return parseEventLogs({
    abi: saharaTokenAbi,
    eventName: "Transfer",
    logs: logs.filter((log) => isAddr(log.address, SAHARA)),
    strict: true,
  });
}

function onlySend(logs: Log[], opts?: {destChainSelector?: bigint}): SentMessage & {log: Log} {
  const sent = logs.flatMap((log) => {
    const message = decodeSentMessage(log, opts);
    return message ? [{...message, log}] : [];
  });
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

function executions(logs: Log[]): Array<ExecutionStateChange & {log: Log}> {
  return logs.flatMap((log) => {
    const change = decodeExecutionState(log);
    return change ? [{...change, log}] : [];
  });
}

describe("topic0 of the verified events", () => {
  it("matches the CCIP ramp ABIs, the exported constants and the captured logs", () => {
    expect(topicOf(onRampAbi, "CCIPMessageSent")).toBe(CCIP_TOPICS.messageSent);
    expect(topicOf(evm2EvmOnRampAbi, "CCIPSendRequested")).toBe(CCIP_TOPICS.sendRequested);
    expect(topicOf(offRampAbi, "ExecutionStateChanged")).toBe(CCIP_TOPICS.executionStateChangedV2);
    expect(topicOf(evm2EvmOffRampAbi, "ExecutionStateChanged")).toBe(CCIP_TOPICS.executionStateChanged);
    expect(CCIP_SEND_TOPICS).toEqual([CCIP_TOPICS.messageSent, CCIP_TOPICS.sendRequested]);
    expect(CCIP_EXECUTION_TOPICS).toEqual([CCIP_TOPICS.executionStateChangedV2, CCIP_TOPICS.executionStateChanged]);

    const seen = (file: string, address: string) =>
      loadReceipt(file).logs.find((log) => isAddr(log.address, address))!.topics[0];
    expect(seen("eth-send-v2.json", ONRAMP_V2.ethereum)).toBe(CCIP_TOPICS.messageSent);
    expect(seen("bsc-send-v2.json", ONRAMP_V2.bsc)).toBe(CCIP_TOPICS.messageSent);
    expect(seen("eth-send-v15.json", ONRAMP_V15.ethereum)).toBe(CCIP_TOPICS.sendRequested);
    expect(seen("bsc-send-v15.json", ONRAMP_V15.bsc)).toBe(CCIP_TOPICS.sendRequested);
    expect(seen("eth-exec-v2.json", OFFRAMP_V2.ethereum)).toBe(CCIP_TOPICS.executionStateChangedV2);
    expect(seen("bsc-exec-v2.json", OFFRAMP_V2.bsc)).toBe(CCIP_TOPICS.executionStateChangedV2);
    expect(seen("eth-exec-v15.json", OFFRAMP_V15.ethereum)).toBe(CCIP_TOPICS.executionStateChanged);
    expect(seen("bsc-exec-v15-batch.json", OFFRAMP_V15.bsc)).toBe(CCIP_TOPICS.executionStateChanged);
  });

  it("matches the LockReleaseTokenPool 1.6.3-dev verified events", () => {
    const expected: Record<string, Hex> = {
      LockedOrBurned: "0xf33bc26b4413b0e7f19f1ea739fdf99098c0061f1f87d954b11f5293fad9ae10",
      ReleasedOrMinted: "0xfc5e3a5bddc11d92c2dc20fae6f7d5eb989f056be35239f7de7e86150609abc0",
      OutboundRateLimitConsumed: "0xff0133389f9bb82d5b9385826160eaf2328039f6fa950eeb8cf0836da8178944",
      InboundRateLimitConsumed: "0x50f6fbee3ceedce6b7fd7eaef18244487867e6718aec7208187efb6b7908c14c",
      LiquidityAdded: "0xc17cea59c2955cb181b03393209566960365771dbba9dc3d510180e7cb312088",
      LiquidityRemoved: "0xc2c3f06e49b9f15e7b4af9055e183b0d73362e033ad82a07dec9bf9840171719",
      LiquidityTransferred: "0x6fa7abcf1345d1d478e5ea0da6b5f26a90eadb0546ef15ed3833944fbfd1db62",
      RebalancerSet: "0x64187bd7b97e66658c91904f3021d7c28de967281d18b1a20742348afdd6a6b3",
      RateLimitAdminSet: "0x44676b5284b809a22248eba0da87391d79098be38bb03154be88a58bf4d09174",
      RouterUpdated: "0x02dc5c233404867c793b749c6d644beb2277536d18a7e7974d3f238e4c6f1684",
      ChainAdded: "0x8d340f17e19058004c20453540862a9c62778504476f6756755cb33bcd6c38c2",
      ChainConfigured: "0x0350d63aa5f270e01729d00d627eeb8f3429772b1818c016c66a588a864f912b",
      ChainRemoved: "0x5204aec90a3c794d8e90fded8b46ae9c7c552803e7e832e0c1d358396d859916",
      RemotePoolAdded: "0x7d628c9a1796743d365ab521a8b2a4686e419b3269919dc9145ea2ce853b54ea",
      RemotePoolRemoved: "0x52d00ee4d9bd51b40168f2afc5848837288ce258784ad914278791464b3f4d76",
      AllowListAdd: "0x2640d4d76caf8bf478aabfa982fa4e1c4eb71a37f93cd15e80dbc657911546d8",
      AllowListRemove: "0x800671136ab6cfee9fbe5ed1fb7ca417811aca3cf864800d127b927adedf7566",
      ConfigChanged: "0x9ea3374b67bf275e6bb9c8ae68f9cae023e1c528b4b27e092f0bb209d3531c19",
      OwnershipTransferRequested: "0xed8889f560326eb138920d842192f0eb3dd22b4f139c87a2c57538e05bae1278",
      OwnershipTransferred: "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
    };
    const declared = tokenPoolAbi.filter((item) => item.type === "event").map((item) => item.name);
    expect([...declared].sort()).toEqual(Object.keys(expected).sort());
    for (const [name, topic] of Object.entries(expected)) expect(topicOf(tokenPoolAbi, name), name).toBe(topic);
  });

  it("drops the Locked/Released events the 1.6.3-dev pool does not have", () => {
    const names = tokenPoolAbi.map((item) => ("name" in item ? item.name : ""));
    expect(names).not.toContain("Locked");
    expect(names).not.toContain("Released");
  });

  it("matches the registry, router and token verified events", () => {
    expect(topicOf(tokenAdminRegistryAbi, "PoolSet")).toBe(
      "0x754449ec3aff3bd528bfce43ae9319c4a381b67fcd1d20097b3b24dacaecc35d",
    );
    expect(topicOf(tokenAdminRegistryAbi, "AdministratorTransferRequested")).toBe(
      "0xc54c3051ff16e63bb9203214432372aca006c589e3653619b577a3265675b716",
    );
    expect(topicOf(tokenAdminRegistryAbi, "AdministratorTransferred")).toBe(
      "0x399b55200f7f639a63d76efe3dcfa9156ce367058d6b673041b84a628885f5a7",
    );
    expect(topicOf(routerAbi, "OnRampSet")).toBe("0x1f7d0ec248b80e5c0dde0ee531c4fc8fdb6ce9a2b3d90f560c74acd6a7202f23");
    expect(topicOf(routerAbi, "OffRampAdded")).toBe(
      "0xa4bdf64ebdf3316320601a081916a75aa144bcef6c4beeb0e9fb1982cacc6b94",
    );
    expect(topicOf(routerAbi, "OffRampRemoved")).toBe(
      "0xa823809efda3ba66c873364eec120fa0923d9fabda73bc97dd5663341e2d9bcb",
    );
    expect(topicOf(routerAbi, "MessageExecuted")).toBe(
      "0x9b877de93ea9895756e337442c657f95a34fc68e7eb988bdfa693d5be83016b6",
    );
    expect(topicOf(saharaTokenAbi, "Transfer")).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
    expect(topicOf(saharaTokenAbi, "Paused")).toBe(
      "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258",
    );
    expect(topicOf(saharaTokenAbi, "Unpaused")).toBe(
      "0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa",
    );
  });

  it("decodes every captured pool and token log strictly", () => {
    const files = [
      "eth-send-v2.json",
      "bsc-exec-v2.json",
      "bsc-send-v2.json",
      "eth-exec-v2.json",
      "eth-send-v15.json",
      "bsc-exec-v15-batch.json",
      "bsc-send-v15.json",
      "eth-exec-v15.json",
    ];
    for (const file of files) {
      const {logs} = loadReceipt(file);
      const pool = logs.filter((log) => isAddr(log.address, POOL));
      expect(poolEvents(logs), file).toHaveLength(pool.length);
      const token = logs.filter((log) => isAddr(log.address, SAHARA));
      expect(parseEventLogs({abi: saharaTokenAbi, logs: token, strict: true}), file).toHaveLength(token.length);
      // The Router's MessageExecuted (other tokens' messages in the batch) also decodes.
      for (const log of logs.filter((item) => item.topics[0] === topicOf(routerAbi, "MessageExecuted"))) {
        expect(decodeEventLog({abi: routerAbi, data: log.data, topics: log.topics}).eventName).toBe("MessageExecuted");
      }
    }
  });
});

describe("decodeSentMessage", () => {
  it("decodes an OnRamp 2.0.0 CCIPMessageSent ETH -> BSC (explorer oracle)", () => {
    const {logs} = loadReceipt("eth-send-v2.json");
    const sent = onlySend(logs);
    expect(sent).toMatchObject({
      kind: "OnRamp 2.0.0",
      messageId: "0x464c1cd159afdc6ef58d0797e92c5332fa25c6630015cfffdc1e64edf4612a64",
      sourceChainSelector: ETH,
      destChainSelector: BSC,
      sequenceNumber: 2239n,
      sender: "0x023fa838682C115c2cFBA96Ef3791CB5Bd931Fc7",
      receiver: "0xA00049b5f36c6fdF35bEbC9f204F60E6D567C45E",
      feeToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      transactionHash: "0xa2369c2c9f81061bf215b6e36911d6a5404283f982f18c8f4c57ab53a2322c0e",
      blockNumber: 26220231n,
      logIndex: 301,
    });
    expect(isAddr(sent.onRamp, ONRAMP_V2.ethereum)).toBe(true);
    expect(sent.tokenAmounts).toEqual([
      {
        token: SAHARA,
        amount: 37201291377450963840000n,
        sourcePoolAddress: POOL,
        destTokenAddress: SAHARA,
        tokenReceiver: "0xA00049b5f36c6fdF35bEbC9f204F60E6D567C45E",
      },
    ]);
  });

  it("decodes an OnRamp 2.0.0 CCIPMessageSent BSC -> ETH and its MessageV1 (explorer oracle)", () => {
    const {logs} = loadReceipt("bsc-send-v2.json");
    const sent = onlySend(logs);
    expect(sent).toMatchObject({
      messageId: "0xe70919efc1c62d574d9067333f31573db8863e61f6c9e9cba1bca49046591db8",
      sourceChainSelector: BSC,
      destChainSelector: ETH,
      sequenceNumber: 700n,
      sender: "0x023fa838682C115c2cFBA96Ef3791CB5Bd931Fc7",
      receiver: "0x7cD7b759E3E4A3FA3317c8d8c078A612d1B7B570",
    });
    expect(sent.tokenAmounts[0]).toMatchObject({amount: 3975300385764232335217n, sourcePoolAddress: POOL});

    const {args} = decodeEventLog({abi: onRampAbi, data: sent.log.data, topics: sent.log.topics});
    if (!("encodedMessage" in args)) throw new Error("not CCIPMessageSent");
    expect(keccak256(args.encodedMessage)).toBe(sent.messageId);
    expect(args.tokenAmountBeforeTokenPoolFees).toBe(3975300385764232335217n);
    const message = decodeMessageV1(args.encodedMessage);
    expect(message).toMatchObject({
      sourceChainSelector: BSC,
      destChainSelector: ETH,
      messageNumber: 700n,
      executionGasLimit: 383800,
      ccipReceiveGasLimit: 0,
      ccvAndExecutorHash: "0x57f26601394e874c981211a7626034b7130cd6a1b5c61d89ff5e9d15118a7ae3",
      offRampAddress: OFFRAMP_V2.ethereum.toLowerCase(),
      receiver: "0x7cd7b759e3e4a3fa3317c8d8c078a612d1b7b570",
      destBlob: "0x",
      data: "0x",
    });
    expect(evmAddressFromBytes(message.onRampAddress)).toBe(ONRAMP_V2.bsc);
    expect(evmAddressFromBytes(message.sender)).toBe(sent.sender);
    expect(message.tokenTransfer).toHaveLength(1);
    // LockReleaseTokenPool destPoolData = abi.encode(uint256 localDecimals).
    expect(BigInt(message.tokenTransfer[0]!.extraData)).toBe(18n);
  });

  it("decodes EVM2EVMOnRamp 1.5.0 CCIPSendRequested in both directions", () => {
    const eth = onlySend(loadReceipt("eth-send-v15.json").logs);
    expect(eth).toMatchObject({
      kind: "EVM2EVMOnRamp",
      messageId: "0x2a4b9cf533a631fea76d2f9f9f9a5cf3111c9913f43e6a0d31ce9c250895cc3f",
      sourceChainSelector: ETH,
      // Not in the event: the lane is fixed per EVM2EVMOnRamp.
      destChainSelector: null,
      sequenceNumber: 22379n,
      sender: "0x07dc9C65e03d269f3E05A1C3F85E3e10a32d6783",
      receiver: "0x9923c9e820F538E3C50970f97b8ceed4A9D1AFDc",
    });
    expect(eth.tokenAmounts).toEqual([
      {
        token: SAHARA,
        amount: 10n ** 18n,
        sourcePoolAddress: POOL,
        destTokenAddress: SAHARA,
        tokenReceiver: "0x9923c9e820F538E3C50970f97b8ceed4A9D1AFDc",
      },
    ]);

    const bsc = onlySend(loadReceipt("bsc-send-v15.json").logs, {destChainSelector: ETH});
    expect(bsc).toMatchObject({
      messageId: "0xfb5a22f89a399301267f1738c530e86f3a4e58b7a82bc7230269333edb5714c2",
      sourceChainSelector: BSC,
      destChainSelector: ETH,
      sequenceNumber: 19654n,
    });
    expect(bsc.tokenAmounts[0]).toMatchObject({amount: 10n ** 18n, sourcePoolAddress: POOL});
  });

  it("returns null for other logs and keeps sourcePoolAddress null for opaque 1.2.0 sourceTokenData", () => {
    const {logs} = loadReceipt("eth-send-v2.json");
    for (const log of logs.filter((item) => !CCIP_SEND_TOPICS.includes(item.topics[0]!))) {
      expect(decodeSentMessage(log)).toBeNull();
    }
    const v15 = onlySend(loadReceipt("eth-send-v15.json").logs);
    const {args} = decodeEventLog({abi: evm2EvmOnRampAbi, data: v15.log.data, topics: v15.log.topics});
    const opaque: Hex = `0x${"00".repeat(31)}12`;
    const message = {...args.message, sourceTokenData: [opaque]};
    const data = encodeAbiParameters(evm2EvmOnRampAbi.find((item) => item.type === "event")!.inputs, [message]);
    const legacy = decodeSentMessage({...v15.log, data});
    expect(legacy?.tokenAmounts[0]).toEqual({
      token: SAHARA,
      amount: 10n ** 18n,
      sourcePoolAddress: null,
      destTokenAddress: null,
      tokenReceiver: "0x9923c9e820F538E3C50970f97b8ceed4A9D1AFDc",
    });
  });

  it("throws on a send event whose payload is inconsistent", () => {
    const sent = onlySend(loadReceipt("eth-send-v2.json").logs);
    const [signature, destination, sender] = sent.log.topics as Hex[];
    const wrongId: Hex = `0x${"11".repeat(32)}`;
    const forged = {...sent.log, topics: [signature!, destination!, sender!, wrongId] as [Hex, ...Hex[]]};
    expect(() => decodeSentMessage(forged)).toThrow(/does not match messageId/);
  });
});

describe("decodeMessageV1", () => {
  const sent = onlySend(loadReceipt("bsc-send-v2.json").logs);
  const {args} = decodeEventLog({abi: onRampAbi, data: sent.log.data, topics: sent.log.topics});
  const encoded = (args as {encodedMessage: Hex}).encodedMessage;

  it("rejects truncated, padded and unknown-version input", () => {
    expect(() => decodeMessageV1(slice(encoded, 0, size(encoded) - 1))).toThrow(/truncated/);
    expect(() => decodeMessageV1(`${encoded}00`)).toThrow(/trailing/);
    expect(() => decodeMessageV1(`0x02${encoded.slice(4)}`)).toThrow(/version 2/);
  });
});

describe("decodeExecutionState", () => {
  it("decodes OffRamp 2.0.0 and EVM2EVMOffRamp 1.5.0 SUCCESS logs", () => {
    const eth = executions(loadReceipt("eth-exec-v2.json").logs);
    expect(eth).toHaveLength(1);
    expect(eth[0]).toMatchObject({
      kind: "OffRamp 2.0.0",
      offRamp: OFFRAMP_V2.ethereum,
      messageId: "0xe70919efc1c62d574d9067333f31573db8863e61f6c9e9cba1bca49046591db8",
      sourceChainSelector: BSC,
      sequenceNumber: 700n,
      state: MESSAGE_EXECUTION_STATE.SUCCESS,
      stateName: "SUCCESS",
      returnData: "0x",
      blockNumber: 26114582n,
      logIndex: 440,
    });
    const v15 = executions(loadReceipt("eth-exec-v15.json").logs);
    expect(v15).toHaveLength(1);
    expect(v15[0]).toMatchObject({
      kind: "EVM2EVMOffRamp",
      offRamp: OFFRAMP_V15.ethereum,
      messageId: "0xfb5a22f89a399301267f1738c530e86f3a4e58b7a82bc7230269333edb5714c2",
      sourceChainSelector: null,
      sequenceNumber: 19654n,
      state: 2,
    });
  });

  it("decodes a FAILURE, its manual re-execution and a truncated failure reason", () => {
    const [failure] = executions(loadReceipt("eth-exec-v2-failure.json").logs);
    const [retry] = executions(loadReceipt("eth-exec-v2-retry.json").logs);
    expect(failure).toMatchObject({
      messageId: "0xd5864a73f173f9019614dc30be121547ea1dde653ad4645f7d9123a5680c649b",
      sourceChainSelector: BSC,
      sequenceNumber: 319n,
      state: MESSAGE_EXECUTION_STATE.FAILURE,
      stateName: "FAILURE",
    });
    expect(size(failure!.returnData)).toBe(132);
    expect(slice(failure!.returnData, 0, 4)).toBe("0x9fe2f95a");
    expect(describeExecutionError(failure!.returnData)).toBe(
      "TokenHandlingError(target=0x169E36F327cAA83d004f5c2668AC25A1424C940d, err=unrecognised error 0xa17e11d5)",
    );
    expect(retry).toMatchObject({messageId: failure!.messageId, sequenceNumber: 319n, state: 2, returnData: "0x"});

    const [stuck] = executions(loadReceipt("eth-exec-v2-failure-truncated.json").logs);
    expect(stuck).toMatchObject({sequenceNumber: 89n, state: 3});
    expect(describeExecutionError(stuck!.returnData)).toBe(
      "TokenHandlingError(target=0xDBB5Cf12408a3Ac17d668037Ce289f9eA75439D7, err=Error(…truncated))",
    );
  });

  it("returns null for other logs and names states", () => {
    for (const log of loadReceipt("eth-exec-v2.json").logs.slice(0, 3)) expect(decodeExecutionState(log)).toBeNull();
    expect(executionStateName(0)).toBe("UNTOUCHED");
    expect(executionStateName(3)).toBe("FAILURE");
    expect(executionStateName(7)).toBe("UNKNOWN(7)");
  });
});

describe("describeExecutionError", () => {
  const insufficient = encodeErrorResult({
    abi: saharaTokenAbi,
    errorName: "ERC20InsufficientBalance",
    args: [POOL, 5n, 10n],
  });

  it("describes nested pool / token errors in full when they fit", () => {
    const v15 = encodeErrorResult({abi: evm2EvmOffRampAbi, errorName: "TokenHandlingError", args: [insufficient]});
    expect(describeExecutionError(v15)).toBe(
      `TokenHandlingError(err=ERC20InsufficientBalance(sender=${POOL}, balance=5, needed=10))`,
    );
    const rateLimited = encodeErrorResult({
      abi: tokenPoolAbi,
      errorName: "TokenRateLimitReached",
      args: [60n, 1n, SAHARA],
    });
    expect(describeExecutionError(rateLimited)).toBe(
      `TokenRateLimitReached(minWaitInSeconds=60, available=1, tokenAddress=${SAHARA})`,
    );
  });

  it("recovers the target and inner error name from an OffRamp 2.0.0 reason truncated to 132 bytes", () => {
    const full = encodeErrorResult({abi: offRampAbi, errorName: "TokenHandlingError", args: [SAHARA, insufficient]});
    expect(describeExecutionError(slice(full, 0, 132))).toBe(
      `TokenHandlingError(target=${SAHARA}, err=ERC20InsufficientBalance(…truncated))`,
    );
    expect(describeExecutionError("0x")).toBe("empty revert data");
    expect(describeExecutionError("0xdeadbeef")).toBe("unrecognised error 0xdeadbeef");
  });
});

describe("source and destination log ordering in real receipts", () => {
  const pairs = [
    {send: "eth-send-v2.json", exec: "bsc-exec-v2.json", onRamp: ONRAMP_V2.ethereum, offRamp: OFFRAMP_V2.bsc},
    {send: "bsc-send-v2.json", exec: "eth-exec-v2.json", onRamp: ONRAMP_V2.bsc, offRamp: OFFRAMP_V2.ethereum},
    {send: "eth-send-v15.json", exec: "bsc-exec-v15-batch.json", onRamp: ONRAMP_V15.ethereum, offRamp: OFFRAMP_V15.bsc},
    {send: "bsc-send-v15.json", exec: "eth-exec-v15.json", onRamp: ONRAMP_V15.bsc, offRamp: OFFRAMP_V15.ethereum},
  ];

  for (const pair of pairs) {
    it(`${pair.send} -> ${pair.exec}`, () => {
      // Source: Transfer(sender -> pool) < OutboundRateLimitConsumed < LockedOrBurned(sender = OnRamp) < send event.
      const source = loadReceipt(pair.send).logs;
      const sent = onlySend(source);
      const deposit = tokenTransfers(source).find((log) => isAddr(log.args.to, POOL))!;
      const [outbound, locked] = poolEvents(source);
      expect(deposit.args).toMatchObject({from: sent.sender, value: sent.tokenAmounts[0]!.amount});
      expect(outbound?.eventName).toBe("OutboundRateLimitConsumed");
      expect(locked?.eventName).toBe("LockedOrBurned");
      if (locked?.eventName !== "LockedOrBurned") throw new Error("unreachable");
      expect(isAddr(locked.args.sender, pair.onRamp)).toBe(true);
      // LockedOrBurned carries the destination selector the 1.5.0 send event lacks.
      if (sent.destChainSelector !== null) expect(locked.args.remoteChainSelector).toBe(sent.destChainSelector);
      expect(locked.args.remoteChainSelector).toBe(pair.send.startsWith("eth") ? BSC : ETH);
      expect(locked.args.amount).toBe(sent.tokenAmounts[0]!.amount);
      expect(deposit.logIndex).toBeLessThan(outbound!.logIndex);
      expect(outbound!.logIndex).toBeLessThan(locked.logIndex);
      expect(locked.logIndex).toBeLessThan(sent.logIndex!);

      // Destination: InboundRateLimitConsumed < Transfer(pool -> receiver) < ReleasedOrMinted(sender = OffRamp)
      // < ExecutionStateChanged of the same message; the pool logs belong to the NEXT execution log in the tx.
      const destination = loadReceipt(pair.exec).logs;
      const [inbound, released] = poolEvents(destination);
      expect(inbound?.eventName).toBe("InboundRateLimitConsumed");
      if (released?.eventName !== "ReleasedOrMinted") throw new Error("expected ReleasedOrMinted");
      const payout = tokenTransfers(destination).find((log) => isAddr(log.args.from, POOL))!;
      const execution = executions(destination).find((change) => change.logIndex! > released.logIndex)!;
      expect(execution).toMatchObject({messageId: sent.messageId, sequenceNumber: sent.sequenceNumber, state: 2});
      expect(isAddr(execution.offRamp, pair.offRamp)).toBe(true);
      expect(isAddr(released.args.sender, pair.offRamp)).toBe(true);
      expect(released.args.remoteChainSelector).toBe(sent.sourceChainSelector);
      expect(released.args.amount).toBe(sent.tokenAmounts[0]!.amount);
      expect(isAddr(released.args.recipient, sent.tokenAmounts[0]!.tokenReceiver!)).toBe(true);
      expect(payout.args).toMatchObject({to: released.args.recipient, value: released.args.amount});
      expect(inbound!.logIndex).toBeLessThan(payout.logIndex);
      expect(payout.logIndex).toBeLessThan(released.logIndex);
      if (execution.sourceChainSelector !== null) expect(execution.sourceChainSelector).toBe(sent.sourceChainSelector);
    });
  }

  it("attributes pool logs in a batched EVM2EVMOffRamp 1.5.0 execution to the following execution log", () => {
    const {logs} = loadReceipt("bsc-exec-v15-batch.json");
    const changes = executions(logs);
    expect(changes.map((change) => change.sequenceNumber)).toEqual([22377n, 22378n, 22379n]);
    const released = poolEvents(logs).find((log) => log.eventName === "ReleasedOrMinted")!;
    expect(released.logIndex).toBeGreaterThan(changes[1]!.logIndex!);
    const next = changes.find((change) => change.logIndex! > released.logIndex)!;
    expect(next.messageId).toBe("0x2a4b9cf533a631fea76d2f9f9f9a5cf3111c9913f43e6a0d31ce9c250895cc3f");
  });
});

describe("view decoding of the EVM2EVM ramps", () => {
  interface StaticConfigCall {
    address: string;
    typeAndVersion: string;
    getStaticConfig: Hex;
  }
  const {calls} = readFixture<{calls: StaticConfigCall[]}>("static-configs.json");
  const call = (version: string) => calls.find((item) => item.typeAndVersion === version)!;

  it("reads the lane of EVM2EVMOnRamp 1.5.0 and 1.2.0 with the shared (1.2.0-prefix) layout", () => {
    for (const version of ["EVM2EVMOnRamp 1.5.0", "EVM2EVMOnRamp 1.2.0"]) {
      const config = decodeFunctionResult({
        abi: evm2EvmOnRampAbi,
        functionName: "getStaticConfig",
        data: call(version).getStaticConfig,
      });
      expect(config, version).toMatchObject({chainSelector: ETH, destChainSelector: BSC});
    }
  });

  it("reads the lane of EVM2EVMOffRamp 1.5.0 and 1.2.0 with the shared (1.2.0-prefix) layout", () => {
    const v15 = decodeFunctionResult({
      abi: evm2EvmOffRampAbi,
      functionName: "getStaticConfig",
      data: call("EVM2EVMOffRamp 1.5.0").getStaticConfig,
    });
    expect(v15).toMatchObject({chainSelector: ETH, sourceChainSelector: BSC, onRamp: ONRAMP_V15.bsc});
    const v12 = decodeFunctionResult({
      abi: evm2EvmOffRampAbi,
      functionName: "getStaticConfig",
      data: call("EVM2EVMOffRamp 1.2.0").getStaticConfig,
    });
    expect(v12).toMatchObject({chainSelector: ETH, sourceChainSelector: BSC});
    expect(v12.prevOffRamp).toBe("0x0000000000000000000000000000000000000000");
  });
});

describe("evmAddressFromBytes", () => {
  it("accepts raw and abi-encoded EVM addresses only", () => {
    expect(evmAddressFromBytes(POOL.toLowerCase() as Hex)).toBe(POOL);
    expect(evmAddressFromBytes(encodeAbiParameters(parseAbiParameters("address"), [POOL]))).toBe(POOL);
    expect(evmAddressFromBytes(`0x${"ff".repeat(32)}`)).toBeNull();
    expect(evmAddressFromBytes(`0x${"11".repeat(32)}`)).toBeNull();
    expect(evmAddressFromBytes("0x")).toBeNull();
  });
});
