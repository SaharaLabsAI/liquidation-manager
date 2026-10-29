// Display helpers shared by rules and sinks. Output is plain text (sinks escape it).
import {formatUnits, getAddress, type Address} from "viem";

/** 1234567.891 SAHARA -> "1,234,567.89 SAHARA". Keeps up to `maxFraction` fraction digits, trimming zeros. */
export function formatAmount(raw: bigint, decimals: number, symbol?: string, maxFraction = 2): string {
  const negative = raw < 0n;
  const [whole = "0", fraction = ""] = formatUnits(negative ? -raw : raw, decimals).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = fraction.slice(0, maxFraction).replace(/0+$/, "");
  if (frac === "" && fraction !== "" && /[1-9]/.test(fraction) && whole === "0") {
    // Never print a non-zero dust amount as "0".
    frac = fraction.replace(/0+$/, "");
  }
  const text = `${negative ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
  return symbol ? `${text} ${symbol}` : text;
}

/** Checksummed address. */
export function checksum(address: string): Address {
  return getAddress(address);
}

/** 0x1234…abcd */
export function shortHex(value: string, keep = 4): string {
  return value.length <= 2 + keep * 2 ? value : `${value.slice(0, 2 + keep)}…${value.slice(-keep)}`;
}

/** 93784 -> "1d 2h 3m". */
export function formatDuration(seconds: number | bigint): string {
  let rest = Math.max(0, Math.floor(Number(seconds)));
  const days = Math.floor(rest / 86400);
  rest %= 86400;
  const hours = Math.floor(rest / 3600);
  rest %= 3600;
  const minutes = Math.floor(rest / 60);
  const secs = rest % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length) parts.push(`${secs}s`);
  return parts.join(" ");
}

/** Unix seconds -> "2026-10-28 09:00:00 UTC". */
export function formatTimestamp(unixSeconds: number | bigint): string {
  return `${new Date(Number(unixSeconds) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "")} UTC`;
}
