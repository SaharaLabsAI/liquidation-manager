// Loads the real CCIP receipts captured in test/fixtures/ccip (raw eth_getTransactionReceipt log shape) as viem Logs.
import {readFileSync} from "node:fs";

import type {Address, Hex, Log} from "viem";

interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  logIndex: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
}

export interface ReceiptFixture {
  description: string;
  chain: "ethereum" | "bsc";
  chainId: number;
  transactionHash: Hex;
  blockNumber: Hex;
  status: Hex;
  /** True when unrelated logs (aggregator/DEX noise) were dropped; logIndex values are the real ones. */
  trimmed: boolean;
  logs: RawLog[];
}

export function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/ccip/${name}`, import.meta.url), "utf8")) as T;
}

export function toViemLog(raw: RawLog): Log {
  return {
    address: raw.address,
    topics: raw.topics as [Hex, ...Hex[]],
    data: raw.data,
    blockHash: raw.blockHash,
    blockNumber: BigInt(raw.blockNumber),
    logIndex: Number(BigInt(raw.logIndex)),
    transactionHash: raw.transactionHash,
    transactionIndex: Number(BigInt(raw.transactionIndex)),
    removed: false,
  };
}

/** The fixture's logs as viem Logs, in logIndex order. */
export function loadReceipt(name: string): {fixture: ReceiptFixture; logs: Log[]} {
  const fixture = readFixture<ReceiptFixture>(name);
  const logs = fixture.logs.map(toViemLog).sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0));
  return {fixture, logs};
}
