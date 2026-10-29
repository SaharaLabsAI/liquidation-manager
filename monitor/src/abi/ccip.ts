// CCIP ramp ABIs and log decoders for tracking SAHARA bridge messages on the Ethereum <-> BSC lanes.
// VERIFIED (2026-10-28): OffRamp 2.0.0, EVM2EVMOnRamp 1.5.0 / 1.2.0 and EVM2EVMOffRamp 1.5.0 / 1.2.0 against their
// Sourcify-verified sources; OnRamp 2.0.0 against its Etherscan-verified source (identical to chainlink-ccip tag
// contracts-ccip-v2.0.0); every event topic0 against real SAHARA receipts on both chains (src/abi/VERIFICATION.md).
//
// Lanes (Router 1.2.0 on both chains): messages are sent through OnRamp 2.0.0 and executed by OffRamp 2.0.0. Messages
// sent before the 2.0 migration went through EVM2EVMOnRamp 1.5.0 and were executed by EVM2EVMOffRamp 1.5.0, which is
// still authorised on the Router. EVM2EVMOffRamp 1.2.0 is authorised too but has no pool for SAHARA (its own pool map
// reverts UnsupportedToken), so it cannot release from the pool. The 1.2.0 and 1.5.0 ramps share their event
// signatures, so one ABI and one topic0 cover both.
import {
  bytesToBigInt,
  bytesToHex,
  decodeAbiParameters,
  decodeErrorResult,
  decodeEventLog,
  getAddress,
  hexToBytes,
  keccak256,
  parseAbi,
  parseAbiParameters,
  size,
  slice,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
  type Log,
} from "viem";
import {formatAbiItem} from "viem/utils";

import {saharaTokenAbi, tokenPoolAbi} from "./external.ts";

type AbiError = Extract<Abi[number], {type: "error"}>;

/** OnRamp 2.0.0 (CCV-based CCIP). One OnRamp serves every destination; `messageNumber` is per destination lane. */
export const onRampAbi = parseAbi([
  "struct Receipt { address issuer; uint32 destGasLimit; uint32 destBytesOverhead; uint256 feeTokenAmount; bytes extraArgs; }",
  "struct DestChainConfig { address router; uint64 messageNumber; uint8 addressBytesLength; bool tokenReceiverAllowed; uint16 messageNetworkFeeUSDCents; uint16 tokenNetworkFeeUSDCents; uint32 baseExecutionGasCost; address defaultExecutor; address[] laneMandatedCCVs; address[] defaultCCVs; bytes offRamp; }",
  // `sender` is the Router caller (the address the token Transfer into the pool comes from). `encodedMessage` is the
  // MessageV1Codec packed message (not ABI encoded, see decodeMessageV1) and messageId == keccak256(encodedMessage).
  "event CCIPMessageSent(uint64 indexed destChainSelector, address indexed sender, bytes32 indexed messageId, address feeToken, uint256 tokenAmountBeforeTokenPoolFees, bytes encodedMessage, Receipt[] receipts, bytes[] verifierBlobs)",
  "function typeAndVersion() view returns (string)",
  "function owner() view returns (address)",
  // Last used message number + 1 for the lane: every message below it has been sent.
  "function getExpectedNextMessageNumber(uint64 destChainSelector) view returns (uint64)",
  "function getDestChainConfig(uint64 destChainSelector) view returns (DestChainConfig)",
  "function getPoolBySourceToken(uint64 destChainSelector, address sourceToken) view returns (address)",
]);

/** EVM2EVMOnRamp 1.5.0 and 1.2.0 (one OnRamp per lane; the event carries no destination selector). */
export const evm2EvmOnRampAbi = parseAbi([
  "struct EVMTokenAmount { address token; uint256 amount; }",
  "struct EVM2EVMMessage { uint64 sourceChainSelector; address sender; address receiver; uint64 sequenceNumber; uint256 gasLimit; bool strict; uint64 nonce; address feeToken; uint256 feeTokenAmount; bytes data; EVMTokenAmount[] tokenAmounts; bytes[] sourceTokenData; bytes32 messageId; }",
  "event CCIPSendRequested(EVM2EVMMessage message)",
  "function typeAndVersion() view returns (string)",
  "function getExpectedNextSequenceNumber() view returns (uint64)",
  // The 1.2.0 layout; 1.5.0 appends `address tokenAdminRegistry`, which decoding ignores. Gives the lane's
  // destChainSelector that CCIPSendRequested lacks.
  "struct StaticConfig { address linkToken; uint64 chainSelector; uint64 destChainSelector; uint64 defaultTxGasLimit; uint96 maxNopFeesJuels; address prevOnRamp; address rmnProxy; }",
  "function getStaticConfig() view returns (StaticConfig)",
]);

/** OffRamp 2.0.0: one OffRamp for every source chain; execution state is keyed by messageId. */
export const offRampAbi = parseAbi([
  "struct SourceChainConfig { address router; bool isEnabled; bytes[] onRamps; address[] defaultCCVs; address[] laneMandatedCCVs; }",
  // Emitted once per execution attempt (SUCCESS or FAILURE; a failed message can be re-executed manually, a second
  // failure reverts the transaction instead). `returnData` is truncated to 132 bytes.
  "event ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed messageNumber, bytes32 indexed messageId, uint8 state, bytes returnData)",
  "function typeAndVersion() view returns (string)",
  "function owner() view returns (address)",
  "function getExecutionState(bytes32 messageId) view returns (uint8)",
  "function getSourceChainConfig(uint64 sourceChainSelector) view returns (SourceChainConfig)",
  // Failure reasons carried in ExecutionStateChanged.returnData (the rest only revert `execute` itself).
  "error TokenHandlingError(address target, bytes err)",
  "error ReceiverError(bytes err)",
  "error NotACompatiblePool(address notPool)",
  "error InvalidEVMAddress(bytes encodedAddress)",
  "error InvalidNumberOfTokens(uint256 numTokens)",
  "error RequiredCCVMissing(address requiredCCV)",
  "error OptionalCCVQuorumNotReached(uint256 wanted, uint256 got)",
  "error InboundImplementationNotFound(address ccvAddress, bytes verifierResults)",
  "error CanOnlySelfCall()",
  "error NoStateProgressMade(bytes32 messageId, bytes err)",
  "error SkippedAlreadyExecutedMessage(bytes32 messageId, uint64 sourceChainSelector, uint64 messageNumber)",
]);

/** EVM2EVMOffRamp 1.5.0 and 1.2.0 (one OffRamp per lane; execution state is keyed by sequence number). */
export const evm2EvmOffRampAbi = parseAbi([
  "event ExecutionStateChanged(uint64 indexed sequenceNumber, bytes32 indexed messageId, uint8 state, bytes returnData)",
  "event SkippedAlreadyExecutedMessage(uint64 indexed sequenceNumber)",
  "function typeAndVersion() view returns (string)",
  "function owner() view returns (address)",
  "function getExecutionState(uint64 sequenceNumber) view returns (uint8)",
  // The 1.2.0 layout; 1.5.0 appends `address tokenAdminRegistry`, which decoding ignores.
  "struct StaticConfig { address commitStore; uint64 chainSelector; uint64 sourceChainSelector; address onRamp; address prevOffRamp; address rmnProxy; }",
  "function getStaticConfig() view returns (StaticConfig)",
  "error TokenHandlingError(bytes err)",
  "error ReceiverError(bytes err)",
  "error ExecutionError(bytes err)",
  "error ReleaseOrMintBalanceMismatch(uint256 amountReleased, uint256 balancePre, uint256 balancePost)",
  "error NotACompatiblePool(address notPool)",
  "error InvalidEVMAddress(bytes encodedAddress)",
  "error UnsupportedToken(address token)",
  "error TokenDataMismatch(uint64 sequenceNumber)",
  "error AggregateValueMaxCapacityExceeded(uint256 capacity, uint256 requested)",
  "error AggregateValueRateLimitReached(uint256 minWaitInSeconds, uint256 available)",
]);

/** Verified topic0 of the CCIP send and execution events (tests assert they match the ABIs and real logs). */
export const CCIP_TOPICS = {
  /** OnRamp 2.0.0 CCIPMessageSent. */
  messageSent: "0x371bc2ff0a006f4ef863b1d27a065d4e9f938b6d883eb154572b4aea593b32cc",
  /** EVM2EVMOnRamp 1.2.0 / 1.5.0 CCIPSendRequested. */
  sendRequested: "0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd",
  /** OffRamp 2.0.0 ExecutionStateChanged. */
  executionStateChangedV2: "0x8c324ce1367b83031769f6a813e3bb4c117aba2185789d66b98b791405be6df2",
  /** EVM2EVMOffRamp 1.2.0 / 1.5.0 ExecutionStateChanged. */
  executionStateChanged: "0xd4f851956a5d67c3997d1c9205045fef79bae2947fdee7e9e2641abc7391ef65",
} as const;

export const CCIP_SEND_TOPICS: Hex[] = [CCIP_TOPICS.messageSent, CCIP_TOPICS.sendRequested];
export const CCIP_EXECUTION_TOPICS: Hex[] = [CCIP_TOPICS.executionStateChangedV2, CCIP_TOPICS.executionStateChanged];

/** Internal.MessageExecutionState (identical in the 1.2.0, 1.5.0 and 2.0.0 libraries). */
export const MESSAGE_EXECUTION_STATE = {UNTOUCHED: 0, IN_PROGRESS: 1, SUCCESS: 2, FAILURE: 3} as const;
export type MessageExecutionStateName = keyof typeof MESSAGE_EXECUTION_STATE;
export type MessageExecutionState = (typeof MESSAGE_EXECUTION_STATE)[MessageExecutionStateName];

const STATE_NAMES: readonly MessageExecutionStateName[] = ["UNTOUCHED", "IN_PROGRESS", "SUCCESS", "FAILURE"];

export function executionStateName(state: number): MessageExecutionStateName | `UNKNOWN(${number})` {
  return STATE_NAMES[state] ?? `UNKNOWN(${state})`;
}

/** The parts of a viem `Log` the decoders read; position fields are copied through when present. */
export type CcipLog = Pick<Log, "address" | "data" | "topics"> &
  Partial<Pick<Log, "blockNumber" | "logIndex" | "transactionHash">>;

interface LogPosition {
  transactionHash: Hex | null;
  blockNumber: bigint | null;
  logIndex: number | null;
}

function position(log: CcipLog): LogPosition {
  return {
    transactionHash: log.transactionHash ?? null,
    blockNumber: log.blockNumber ?? null,
    logIndex: log.logIndex ?? null,
  };
}

function topic0(log: CcipLog): string | undefined {
  return log.topics[0]?.toLowerCase();
}

// ---------------------------------------------------------------------------------------------------------------
// MessageV1Codec (OnRamp 2.0.0 `encodedMessage`): a packed, length-prefixed format, not ABI encoding, so it is parsed
// by hand here (mirrors MessageV1Codec._decodeMessageV1 including its bounds and final-offset checks).

export interface TokenTransferV1 {
  amount: bigint;
  /** Source-side address bytes, abi.encode(address) for EVM sources (32 bytes). */
  sourcePoolAddress: Hex;
  sourceTokenAddress: Hex;
  /** Destination-side address bytes, unpadded (20 bytes for EVM). */
  destTokenAddress: Hex;
  tokenReceiver: Hex;
  /** Pool `destPoolData` (the LockReleaseTokenPool sends abi.encode(uint256 localDecimals)). */
  extraData: Hex;
}

export interface MessageV1 {
  sourceChainSelector: bigint;
  destChainSelector: bigint;
  messageNumber: bigint;
  executionGasLimit: number;
  ccipReceiveGasLimit: number;
  finality: Hex;
  ccvAndExecutorHash: Hex;
  onRampAddress: Hex;
  offRampAddress: Hex;
  sender: Hex;
  receiver: Hex;
  destBlob: Hex;
  tokenTransfer: TokenTransferV1[];
  data: Hex;
}

class PackedReader {
  readonly bytes: Uint8Array;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  take(length: number, what: string): Uint8Array {
    if (this.offset + length > this.bytes.length) throw new Error(`MessageV1: truncated at ${what}`);
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  uint(length: number, what: string): bigint {
    return bytesToBigInt(this.take(length, what));
  }

  /** Length-prefixed bytes; the prefix is `prefixBytes` wide (1 = uint8, 2 = uint16). */
  prefixed(prefixBytes: 1 | 2, what: string): Hex {
    const length = Number(this.uint(prefixBytes, `${what} length`));
    return bytesToHex(this.take(length, what));
  }
}

function decodeTokenTransferV1(reader: PackedReader): TokenTransferV1 {
  const version = Number(reader.uint(1, "token transfer version"));
  if (version !== 1) throw new Error(`MessageV1: unsupported token transfer version ${version}`);
  return {
    amount: reader.uint(32, "token amount"),
    sourcePoolAddress: reader.prefixed(1, "source pool"),
    sourceTokenAddress: reader.prefixed(1, "source token"),
    destTokenAddress: reader.prefixed(1, "dest token"),
    tokenReceiver: reader.prefixed(1, "token receiver"),
    extraData: reader.prefixed(2, "token extra data"),
  };
}

/** Decodes an OnRamp 2.0.0 `encodedMessage` (MessageV1Codec version 1). Throws on malformed input. */
export function decodeMessageV1(encoded: Hex): MessageV1 {
  const reader = new PackedReader(hexToBytes(encoded));
  const version = Number(reader.uint(1, "version"));
  if (version !== 1) throw new Error(`MessageV1: unsupported encoding version ${version}`);
  const header = {
    sourceChainSelector: reader.uint(8, "sourceChainSelector"),
    destChainSelector: reader.uint(8, "destChainSelector"),
    messageNumber: reader.uint(8, "messageNumber"),
    executionGasLimit: Number(reader.uint(4, "executionGasLimit")),
    ccipReceiveGasLimit: Number(reader.uint(4, "ccipReceiveGasLimit")),
    finality: bytesToHex(reader.take(4, "finality")),
    ccvAndExecutorHash: bytesToHex(reader.take(32, "ccvAndExecutorHash")),
  };
  const onRampAddress = reader.prefixed(1, "onRamp");
  const offRampAddress = reader.prefixed(1, "offRamp");
  const sender = reader.prefixed(1, "sender");
  const receiver = reader.prefixed(1, "receiver");
  const destBlob = reader.prefixed(2, "destBlob");
  const tokenTransferLength = Number(reader.uint(2, "tokenTransfer length"));
  const tokenTransfer: TokenTransferV1[] = [];
  if (tokenTransferLength > 0) {
    const expectedEnd = reader.offset + tokenTransferLength;
    tokenTransfer.push(decodeTokenTransferV1(reader));
    if (reader.offset !== expectedEnd) throw new Error("MessageV1: token transfer length mismatch");
  }
  const data = reader.prefixed(2, "data");
  if (reader.offset !== reader.bytes.length) throw new Error("MessageV1: trailing bytes");
  return {...header, onRampAddress, offRampAddress, sender, receiver, destBlob, tokenTransfer, data};
}

/** EVM address from raw (20-byte) or abi.encode(address) (32-byte, zero-padded) bytes; null for anything else. */
export function evmAddressFromBytes(bytes: Hex): Address | null {
  const length = size(bytes);
  if (length === 20) return getAddress(bytes);
  if (length === 32 && /^0x0{24}/i.test(bytes)) return getAddress(slice(bytes, 12));
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Send events

export type OnRampKind = "OnRamp 2.0.0" | "EVM2EVMOnRamp";

export interface SentTokenAmount {
  /** Source-chain token. */
  token: Address;
  /** Amount locked/burned on the source chain (source decimals). */
  amount: bigint;
  /**
   * Source pool the OnRamp used (match against the watched pool). Null only for EVM2EVMOnRamp 1.2.0, whose
   * `sourceTokenData` is opaque pool data.
   */
  sourcePoolAddress: Address | null;
  /** Destination token as returned by the source pool (untrusted); null if not an EVM address or unknown. */
  destTokenAddress: Address | null;
  /** Who receives the tokens on the destination (the ReleasedOrMinted `recipient`). */
  tokenReceiver: Address | null;
}

export interface SentMessage extends LogPosition {
  kind: OnRampKind;
  onRamp: Address;
  messageId: Hex;
  sourceChainSelector: bigint;
  /** From the event (2.0.0), else `opts.destChainSelector` (EVM2EVMOnRamp lanes are fixed per OnRamp), else null. */
  destChainSelector: bigint | null;
  /** Per-lane message number (2.0.0 `messageNumber`, EVM2EVM `sequenceNumber`). */
  sequenceNumber: bigint;
  /** Original sender: the Router caller, i.e. the `from` of the token Transfer into the source pool. */
  sender: Address;
  /** Message receiver on the destination; null if not a 20-byte address. */
  receiver: Address | null;
  feeToken: Address;
  tokenAmounts: SentTokenAmount[];
}

const sourceTokenDataParams = parseAbiParameters(
  "(bytes sourcePoolAddress, bytes destTokenAddress, bytes extraData, uint32 destGasAmount)",
);

/** EVM2EVMOnRamp 1.5.0 `sourceTokenData[i]` = abi.encode(Internal.SourceTokenData); 1.2.0 carries pool data instead. */
function decodeSourceTokenData(data: Hex | undefined): {sourcePool: Address | null; destToken: Address | null} {
  if (!data) return {sourcePool: null, destToken: null};
  try {
    const [decoded] = decodeAbiParameters(sourceTokenDataParams, data);
    return {
      sourcePool: evmAddressFromBytes(decoded.sourcePoolAddress),
      destToken: evmAddressFromBytes(decoded.destTokenAddress),
    };
  } catch {
    return {sourcePool: null, destToken: null};
  }
}

/**
 * Decodes an OnRamp send event (OnRamp 2.0.0 CCIPMessageSent or EVM2EVMOnRamp 1.2.0/1.5.0 CCIPSendRequested).
 * Returns null when the log is not a send event; throws when it is one but cannot be decoded (callers catch and warn).
 */
export function decodeSentMessage(log: CcipLog, opts: {destChainSelector?: bigint} = {}): SentMessage | null {
  const topic = topic0(log);
  if (topic === CCIP_TOPICS.messageSent) {
    const {args} = decodeEventLog({abi: onRampAbi, eventName: "CCIPMessageSent", data: log.data, topics: log.topics});
    if (keccak256(args.encodedMessage) !== args.messageId.toLowerCase()) {
      throw new Error(`CCIPMessageSent ${args.messageId}: keccak256(encodedMessage) does not match messageId`);
    }
    const message = decodeMessageV1(args.encodedMessage);
    return {
      kind: "OnRamp 2.0.0",
      onRamp: getAddress(log.address),
      messageId: args.messageId,
      sourceChainSelector: message.sourceChainSelector,
      destChainSelector: args.destChainSelector,
      sequenceNumber: message.messageNumber,
      sender: args.sender,
      receiver: evmAddressFromBytes(message.receiver),
      feeToken: args.feeToken,
      tokenAmounts: message.tokenTransfer.map((transfer) => {
        const token = evmAddressFromBytes(transfer.sourceTokenAddress);
        if (!token) throw new Error(`CCIPMessageSent ${args.messageId}: source token is not an EVM address`);
        return {
          token,
          amount: transfer.amount,
          sourcePoolAddress: evmAddressFromBytes(transfer.sourcePoolAddress),
          destTokenAddress: evmAddressFromBytes(transfer.destTokenAddress),
          tokenReceiver: evmAddressFromBytes(transfer.tokenReceiver),
        };
      }),
      ...position(log),
    };
  }
  if (topic === CCIP_TOPICS.sendRequested) {
    const {args} = decodeEventLog({
      abi: evm2EvmOnRampAbi,
      eventName: "CCIPSendRequested",
      data: log.data,
      topics: log.topics,
    });
    const message = args.message;
    return {
      kind: "EVM2EVMOnRamp",
      onRamp: getAddress(log.address),
      messageId: message.messageId,
      sourceChainSelector: message.sourceChainSelector,
      destChainSelector: opts.destChainSelector ?? null,
      sequenceNumber: message.sequenceNumber,
      sender: message.sender,
      receiver: message.receiver,
      feeToken: message.feeToken,
      tokenAmounts: message.tokenAmounts.map((tokenAmount, i) => {
        const sourceTokenData = decodeSourceTokenData(message.sourceTokenData[i]);
        return {
          token: tokenAmount.token,
          amount: tokenAmount.amount,
          sourcePoolAddress: sourceTokenData.sourcePool,
          destTokenAddress: sourceTokenData.destToken,
          // EVM2EVMOffRamp releases tokens to the message receiver.
          tokenReceiver: message.receiver,
        };
      }),
      ...position(log),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Execution events

export type OffRampKind = "OffRamp 2.0.0" | "EVM2EVMOffRamp";

export interface ExecutionStateChange extends LogPosition {
  kind: OffRampKind;
  offRamp: Address;
  messageId: Hex;
  /** 2.0.0 only (multi-source OffRamp); EVM2EVMOffRamp lanes are fixed per OffRamp. */
  sourceChainSelector: bigint | null;
  /** Per-lane message number (2.0.0 `messageNumber`, EVM2EVM `sequenceNumber`), same value as on the source. */
  sequenceNumber: bigint;
  state: MessageExecutionState;
  stateName: MessageExecutionStateName;
  /** Revert data of a FAILURE (empty on SUCCESS), truncated to 132 bytes by the OffRamp; see describeExecutionError. */
  returnData: Hex;
}

function toState(raw: number, messageId: Hex): MessageExecutionState {
  if (raw === 0 || raw === 1 || raw === 2 || raw === 3) return raw;
  throw new Error(`ExecutionStateChanged ${messageId}: unknown state ${raw}`);
}

/**
 * Decodes an OffRamp ExecutionStateChanged (OffRamp 2.0.0 or EVM2EVMOffRamp 1.2.0/1.5.0). Returns null when the log is
 * not one; throws when it is one but cannot be decoded.
 */
export function decodeExecutionState(log: CcipLog): ExecutionStateChange | null {
  const topic = topic0(log);
  if (topic === CCIP_TOPICS.executionStateChangedV2) {
    const {args} = decodeEventLog({
      abi: offRampAbi,
      eventName: "ExecutionStateChanged",
      data: log.data,
      topics: log.topics,
    });
    const state = toState(args.state, args.messageId);
    return {
      kind: "OffRamp 2.0.0",
      offRamp: getAddress(log.address),
      messageId: args.messageId,
      sourceChainSelector: args.sourceChainSelector,
      sequenceNumber: args.messageNumber,
      state,
      stateName: STATE_NAMES[state]!,
      returnData: args.returnData,
      ...position(log),
    };
  }
  if (topic === CCIP_TOPICS.executionStateChanged) {
    const {args} = decodeEventLog({
      abi: evm2EvmOffRampAbi,
      eventName: "ExecutionStateChanged",
      data: log.data,
      topics: log.topics,
    });
    const state = toState(args.state, args.messageId);
    return {
      kind: "EVM2EVMOffRamp",
      offRamp: getAddress(log.address),
      messageId: args.messageId,
      sourceChainSelector: null,
      sequenceNumber: args.sequenceNumber,
      state,
      stateName: STATE_NAMES[state]!,
      returnData: args.returnData,
      ...position(log),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Failure reasons

const executionErrorAbi: readonly AbiError[] = (
  [...offRampAbi, ...evm2EvmOffRampAbi, ...tokenPoolAbi, ...saharaTokenAbi] as readonly Abi[number][]
).filter((item): item is AbiError => item.type === "error");

const BUILTIN_ERRORS: Record<string, string> = {"0x08c379a0": "Error", "0x4e487b71": "Panic"};

const errorBySelector = new Map<string, AbiError>(
  executionErrorAbi.map((item) => [toFunctionSelector(formatAbiItem(item)), item] as const),
);

function errorName(selector: Hex): string | undefined {
  return errorBySelector.get(selector.toLowerCase())?.name ?? BUILTIN_ERRORS[selector.toLowerCase()];
}

function formatValue(value: unknown): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

/**
 * Best-effort, human-readable reason of a failed execution, e.g.
 * "TokenHandlingError(target=0xFDFf…, err=ERC20InsufficientBalance(…))". Nested `bytes` revert data is described
 * recursively. OffRamps truncate returnData to 132 bytes, so an OffRamp 2.0.0 TokenHandlingError never decodes in full:
 * then the static head arguments and the inner error selector are read from their fixed positions.
 */
export function describeExecutionError(returnData: Hex, depth = 0): string {
  const length = size(returnData);
  if (length === 0) return "empty revert data";
  if (length < 4) return `malformed revert data ${returnData}`;
  try {
    const {abiItem, args} = decodeErrorResult({abi: executionErrorAbi, data: returnData});
    const values = (args ?? []) as readonly unknown[];
    const parts = abiItem.inputs.map((input, i) => {
      const value = values[i];
      const shown =
        input.type === "bytes" && typeof value === "string" && depth < 2
          ? describeExecutionError(value as Hex, depth + 1)
          : formatValue(value);
      return input.name ? `${input.name}=${shown}` : shown;
    });
    return `${abiItem.name}(${parts.join(", ")})`;
  } catch {
    return describeTruncated(returnData, depth);
  }
}

function describeTruncated(returnData: Hex, depth: number): string {
  const selector = slice(returnData, 0, 4);
  const item = errorBySelector.get(selector.toLowerCase());
  if (!item) {
    const builtin = BUILTIN_ERRORS[selector.toLowerCase()];
    return builtin ? `${builtin}(…truncated)` : `unrecognised error ${selector}`;
  }
  const length = size(returnData);
  const word = (index: number): Hex | null =>
    4 + 32 * (index + 1) <= length ? slice(returnData, 4 + 32 * index, 4 + 32 * (index + 1)) : null;
  const parts: string[] = [];
  for (const [i, input] of item.inputs.entries()) {
    const head = word(i);
    if (head === null) break;
    let shown: string | null = null;
    if (input.type === "address") shown = getAddress(slice(head, 12));
    else if (/^u?int\d*$/.test(input.type)) shown = BigInt(head).toString();
    else if (input.type === "bytes" && depth < 2) {
      // Dynamic `bytes`: the head word is the offset of [length][data] from the start of the arguments.
      const start = 4 + Number(BigInt(head)) + 32;
      if (start + 4 <= length) {
        const inner = slice(returnData, start);
        const innerName = errorName(slice(inner, 0, 4));
        shown = innerName ? `${innerName}(…truncated)` : `unrecognised error ${slice(inner, 0, 4)}`;
      }
    }
    if (shown === null) break;
    parts.push(input.name ? `${input.name}=${shown}` : shown);
  }
  if (parts.length === item.inputs.length) return `${item.name}(${parts.join(", ")})`;
  return `${item.name}(${parts.length ? `${parts.join(", ")}, ` : ""}…truncated)`;
}
