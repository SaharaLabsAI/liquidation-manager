import {readFileSync} from "node:fs";
import {join} from "node:path";

import {zeroAddress, type Address} from "viem";
import {describe, expect, it} from "vitest";

import {
  effectiveExpected,
  interpolateEnv,
  parseConfig,
  reconcileStaleAfterSec,
  resolveRef,
  toUnits,
} from "../src/config.ts";
import {redact} from "../src/log.ts";
import type {ResolvedAddresses} from "../src/types.ts";

const example = readFileSync(join(import.meta.dirname, "..", "config.example.yaml"), "utf8");

const MANAGER = "0x1111111111111111111111111111111111111111";
const TIMELOCK = "0x2222222222222222222222222222222222222222";
const CONTROLLER = "0x3333333333333333333333333333333333333333";
const ADAPTER = "0x4444444444444444444444444444444444444444";
const POOL = "0x194E4C58DED42b35ed984C8e8F85E854bD1e62B4";

const env = {
  TELEGRAM_BOT_TOKEN: "123456:ABCdefGhIJKlmNoPQRstuVWXyz",
  TELEGRAM_CHANNEL_ID: "@sahara_liquidity_alerts",
  ETH_RPC_URL: "https://eth.example.com/v2/secret-api-key",
  BSC_RPC_URL: "https://bsc.example.com/secret-bsc-key",
  ETH_MANAGER: MANAGER,
};

describe("config", () => {
  it("parses the example with only the required variables set", () => {
    const config = parseConfig(example, env);
    expect(Object.keys(config.chains)).toEqual(["ethereum", "bsc"]);
    const eth = config.chains.ethereum!;
    expect(eth.chainSelector).toBe(5009297550715157269n);
    expect(eth.contracts.manager).toBe(MANAGER);
    expect(eth.contracts.timelock).toBeUndefined();
    expect(eth.expected.fundingOperators).toEqual([]);
    expect(eth.expected.timelockRoles?.cancellers).toEqual(["governanceSafe", "controller"]);
    expect(config.chains.bsc!.contracts.manager).toBeUndefined();
    expect(config.alerts.heartbeatUrl).toBeUndefined();
    expect(config.telegram?.routes[0]?.chatId).toBe("@sahara_liquidity_alerts");
    expect(toUnits(config.reconciliation.requiredBacking, config.token.decimals)).toBe(10_000_000_000n * 10n ** 18n);
  });

  it("registers the bot token and RPC keys for redaction", () => {
    parseConfig(example, env);
    const line = `POST https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage via ${env.ETH_RPC_URL}`;
    const redacted = redact(line);
    expect(redacted).not.toContain("ABCdefGhIJKlmNoPQRstuVWXyz");
    expect(redacted).not.toContain("secret-api-key");
  });

  it("rejects a missing required variable with its path", () => {
    expect(() => parseConfig(example, {...env, TELEGRAM_BOT_TOKEN: undefined})).toThrow(
      /telegram\.botToken: environment variable TELEGRAM_BOT_TOKEN is not set/,
    );
  });

  it("parses acknowledged in-flight obligations, lowercasing their hashes", () => {
    const hash = `0x${"AB".repeat(32)}`;
    const withAcks = (list: string) =>
      example.replace("reconciliation:\n", `reconciliation:\n  acknowledged: ${list}\n`);
    const config = parseConfig(withAcks(`[{chain: ethereum, txHash: "${hash}", note: checked}]`), env);
    expect(config.reconciliation.acknowledged).toEqual([
      {chain: "ethereum", txHash: hash.toLowerCase(), note: "checked"},
    ]);
    expect(parseConfig(example, env).reconciliation.acknowledged).toEqual([]);

    const both = `{chain: ethereum, txHash: "${hash}", messageId: "${hash}", note: x}`;
    for (const entry of ["{chain: ethereum, note: x}", both]) {
      expect(() => parseConfig(withAcks(`[${entry}]`), env)).toThrow(
        /reconciliation\.acknowledged\.0: set exactly one of txHash and messageId/,
      );
    }
    expect(() => parseConfig(withAcks(`[{chain: ethereum, txHash: "0x12", note: x}]`), env)).toThrow(
      /reconciliation\.acknowledged\.0\.txHash: expected 32 bytes of hex/,
    );
  });

  it("defaults reconciliation.staleAfterSec to 3 × intervalSec and rejects one below 2 × intervalSec", () => {
    const config = parseConfig(example, env);
    expect(config.reconciliation.staleAfterSec).toBeUndefined();
    expect(reconcileStaleAfterSec(config.reconciliation)).toBe(900);
    const interval = parseConfig(example.replace("  intervalSec: 300\n", "  intervalSec: 60\n"), env);
    expect(reconcileStaleAfterSec(interval.reconciliation)).toBe(180);

    const at = (staleAfterSec: number, intervalSec = 300) =>
      parseConfig(
        example.replace("  intervalSec: 300\n", `  intervalSec: ${intervalSec}\n  staleAfterSec: ${staleAfterSec}\n`),
        env,
      );
    expect(reconcileStaleAfterSec(at(600).reconciliation)).toBe(600);
    expect(reconcileStaleAfterSec(at(120, 60).reconciliation)).toBe(120);
    expect(() => at(599)).toThrow(/reconciliation\.staleAfterSec: must be at least 2 × intervalSec/);
    // Not a promise that one blocked run followed by a good one never pages: both runs' durations count too.
    expect(() => at(599)).toThrow(/blocked for intervalSec plus both runs' durations, and pages when that exceeds/);
    expect(() => at(599)).not.toThrow(/must not page/);
    expect(() => at(119, 60)).toThrow(/reconciliation\.staleAfterSec/);
    expect(() => at(0)).toThrow(/reconciliation\.staleAfterSec/);
  });

  it("reports schema errors with paths", () => {
    expect(() => parseConfig(example, {...env, ETH_MANAGER: "0x1234"})).toThrow(/chains\.ethereum\.contracts\.manager/);
  });

  it("accepts port 0 (a free port) for the status server, defaults to 9464 and rejects other ports", () => {
    const withHttp = (http: unknown) => example.replace(/^http:\n {2}port: 9464.*$/m, `http: ${JSON.stringify(http)}`);
    expect(withHttp({port: 0})).not.toBe(example);
    expect(parseConfig(withHttp({port: 0}), env).http).toEqual({host: "0.0.0.0", port: 0});
    expect(parseConfig(withHttp({host: "127.0.0.1"}), env).http).toEqual({host: "127.0.0.1", port: 9464});
    expect(parseConfig(example, env).http?.port).toBe(9464);
    for (const port of [-1, 65_536, 1.5]) expect(() => parseConfig(withHttp({port}), env)).toThrow(/http\.port/);
  });

  it("interpolates defaults", () => {
    expect(interpolateEnv({a: "${X:-fallback}", b: ["${Y}"]}, {Y: "y"})).toEqual({a: "fallback", b: ["y"]});
  });

  it("applies Manager defaults to expected state only when a Manager is configured", () => {
    const config = parseConfig(example, env);
    expect(effectiveExpected(config.chains.ethereum!)).toMatchObject({
      tokenOwner: "timelock",
      poolOwner: "timelock",
      registryAdmin: "timelock",
      rebalancer: "adapter",
      rateLimitAdmin: "controller",
    });
    expect(effectiveExpected(config.chains.bsc!).tokenOwner).toBeUndefined();
  });

  it("resolves address references", () => {
    const config = parseConfig(example, env);
    const chain = config.chains.ethereum!;
    const addresses = {
      timelock: TIMELOCK as Address,
      manager: MANAGER as Address,
      controller: CONTROLLER as Address,
      adapters: [{id: 1n, adapter: ADAPTER as Address, pool: POOL as Address, fundingEnabled: true, recallEnabled: true}],
    } as unknown as ResolvedAddresses;
    expect(resolveRef("timelock", addresses, chain)).toBe(TIMELOCK);
    expect(resolveRef("adapter", addresses, chain, {pool: POOL.toLowerCase() as Address})).toBe(ADAPTER);
    expect(resolveRef("adapter", addresses, chain, {pool: zeroAddress})).toBeUndefined();
    expect(resolveRef("zero", addresses, chain)).toBe(zeroAddress);
    expect(resolveRef(undefined, addresses, chain)).toBeUndefined();
  });
});
