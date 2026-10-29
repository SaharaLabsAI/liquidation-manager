// Helpers shared by the rule modules.
import {getAddress, type Address, type Hex, type Log} from "viem";

import type {AlertField, AlertLink, ChainContext} from "../types.ts";

export function sameAddress(a: string | undefined | null, b: string | undefined | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function includesAddress(list: readonly string[], address: string | undefined | null): boolean {
  return !!address && list.some((item) => sameAddress(item, address));
}

/** CCIP selectors of the other configured chains (the counterpart lane(s) of this chain). */
export function otherChainSelectors(ctx: ChainContext): bigint[] {
  return Object.entries(ctx.global.chains)
    .filter(([name]) => name !== ctx.name)
    .map(([, chain]) => chain.chainSelector);
}

/** Configured chain name for a CCIP selector, or the selector itself. */
export function chainNameForSelector(ctx: ChainContext, selector: bigint): string {
  const match = Object.entries(ctx.global.chains).find(([, chain]) => chain.chainSelector === selector);
  return match ? match[0] : selector.toString();
}

/** Groups logs by transaction, keeping block/log order within and across transactions. */
export function groupByTx(logs: readonly Log[]): Map<Hex, Log[]> {
  const groups = new Map<Hex, Log[]>();
  for (const log of logs) {
    if (!log.transactionHash) continue;
    const group = groups.get(log.transactionHash);
    if (group) group.push(log);
    else groups.set(log.transactionHash, [log]);
  }
  return groups;
}

/** Unique event-alert key for one log. */
export function logKey(ctx: ChainContext, rule: string, log: Log): string {
  return `${ctx.name}:${rule}:${log.transactionHash}:${log.logIndex}`;
}

export function txLink(ctx: ChainContext, hash: Hex): AlertLink {
  return {label: "Transaction", url: ctx.explorer.tx(hash)};
}

export function addressLink(ctx: ChainContext, address: Address, label?: string): AlertLink {
  return {label: label ?? ctx.label(address), url: ctx.explorer.address(address)};
}

/** "Pool (0x194E…)" style field: the known label plus the full checksummed address, monospace. */
export function addressField(ctx: ChainContext, label: string, address: string): AlertField {
  const checksummed = getAddress(address);
  const name = ctx.label(checksummed);
  return {label, value: name === checksummed ? checksummed : `${name} ${checksummed}`, code: true};
}

/**
 * Block timestamps (unix seconds) for the blocks of `logs`. Uses the `blockTimestamp` field some RPCs add to logs and
 * falls back to fetching the block header.
 */
export async function blockTimestamps(ctx: ChainContext, logs: readonly Log[]): Promise<Map<bigint, number>> {
  const result = new Map<bigint, number>();
  const missing = new Set<bigint>();
  for (const log of logs) {
    if (log.blockNumber === null) continue;
    const raw = (log as Log & {blockTimestamp?: Hex | bigint | number}).blockTimestamp;
    if (raw !== undefined && raw !== null) result.set(log.blockNumber, Number(BigInt(raw)));
    else if (!result.has(log.blockNumber)) missing.add(log.blockNumber);
  }
  for (const blockNumber of missing) {
    if (result.has(blockNumber)) continue;
    const block = await ctx.client.getBlock({blockNumber});
    result.set(blockNumber, Number(block.timestamp));
  }
  return result;
}
