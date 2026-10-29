// Harness smoke test: anvil starts, the contracts deploy into the post-handover state, the generated config parses, the
// monitor resolves the deployment and its state rules see a healthy system (apart from KNOWN_MOCK_CONDITIONS), the
// Telegram mock behaves like the Bot API towards the real TelegramSink, and every scenario action works.
import {readFileSync, rmSync} from "node:fs";

import {zeroHash} from "viem";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {saharaTokenAbi} from "../../src/abi/external.ts";
import {guardianControllerAbi, liquidityManagerAbi} from "../../src/abi/generated.ts";
import {TelegramSink} from "../../src/alerts/telegram.ts";
import {resolveAddresses} from "../../src/chain/addresses.ts";
import {confirmedHead, createChainClient, createChainContext} from "../../src/chain/client.ts";
import {parseConfig, type ChainConfig, type Config} from "../../src/config.ts";
import {redact, silentLogger} from "../../src/log.ts";
import {stateRules} from "../../src/rules/state.ts";
import {timelockQueueRule} from "../../src/rules/timelock.ts";
import {createStore} from "../../src/store.ts";
import type {Alert, Alerter, OutgoingMessage} from "../../src/types.ts";
import {anvilAvailable, startAnvil, type Anvil} from "./helpers/anvil.ts";
import {CHAIN, CHAT_ID, KNOWN_MOCK_CONDITIONS, writeE2EConfig, type E2EConfig} from "./helpers/config.ts";
import {
  deploySystem,
  encodeManager,
  mockPoolAbi,
  OPERATION_STATE,
  REMOTE_CHAIN_SELECTOR,
  tokens,
  type E2EDeployment,
} from "./helpers/deploy.ts";
import {FAKE_BOT_TOKEN, startTelegramMock, type TelegramMock} from "./helpers/telegram-mock.ts";

/** Alerter that delivers nothing: the state rules return their conditions, which is all this test inspects. */
const nullAlerter: Alerter = {emit: () => {}, sync: () => {}, resolve: () => {}};

describe.skipIf(!anvilAvailable())("e2e harness", () => {
  let anvil: Anvil | undefined;
  let telegram: TelegramMock | undefined;
  let e2e: E2EConfig | undefined;
  let deployment: E2EDeployment;
  let config: Config;
  let chain: ChainConfig;

  beforeAll(async () => {
    anvil = await startAnvil();
    telegram = await startTelegramMock();
    deployment = await deploySystem(anvil);
    e2e = await writeE2EConfig({deployment, telegram});
    config = parseConfig(readFileSync(e2e.path, "utf8"), e2e.env);
    const local = config.chains[CHAIN];
    if (!local) throw new Error(`config has no chain ${CHAIN}`);
    chain = local;
  });

  afterAll(async () => {
    await telegram?.close();
    await anvil?.stop();
    if (e2e) rmSync(e2e.dir, {recursive: true, force: true});
  });

  const client = () =>
    createChainClient(chain, {name: CHAIN, timeoutMs: chain.rpcTimeoutMs, retryCount: chain.rpcRetryCount});

  it("writes a config that parses, with secrets taken from the environment", () => {
    const {addresses} = deployment;
    expect(chain.chainId).toBe(31337);
    expect(chain.rpcUrls).toEqual([anvil?.rpcUrl]);
    expect(chain.confirmations).toBe(0);
    expect(chain.maxLogRange).toBe(100);
    expect(chain.ccip.enabled).toBe(false);
    expect(chain.contracts.manager).toBe(addresses.manager);
    expect(chain.expected.guardian).toBe(deployment.accounts.guardian.address);
    expect(config.reconciliation.enabled).toBe(false);
    expect(config.http?.port).toBe(e2e?.httpPort);
    expect(config.stateFile).toBe(e2e?.stateFile);
    expect(config.telegram?.botToken).toBe(FAKE_BOT_TOKEN);
    expect(config.telegram?.apiUrl).toBe(telegram?.url);
    expect(config.telegram?.routes).toEqual([{chatId: CHAT_ID, minSeverity: "info"}]);
    // parseConfig registered the token for redaction.
    expect(redact(`token ${FAKE_BOT_TOKEN}`)).not.toContain(FAKE_BOT_TOKEN);
  });

  it("resolves the deployment's contracts, also when only the Manager is configured", async () => {
    const {addresses} = deployment;
    const rpc = client();
    const head = await confirmedHead(rpc, chain.confirmations);
    const minimal: ChainConfig = {
      ...chain,
      contracts: {token: addresses.token, registry: addresses.registry, manager: addresses.manager},
    };

    for (const resolved of [await resolveAddresses(rpc, chain, head), await resolveAddresses(rpc, minimal, head)]) {
      expect(resolved.manager).toBe(addresses.manager);
      expect(resolved.timelock).toBe(addresses.timelock);
      expect(resolved.controller).toBe(addresses.controller);
      expect(resolved.router).toBe(addresses.router);
      expect(resolved.guardian).toBe(deployment.accounts.guardian.address);
      expect(resolved.registryPool).toBe(addresses.pool);
      expect(resolved.pools).toEqual([addresses.pool]);
      expect(resolved.adapters).toEqual([
        {id: 1n, adapter: addresses.adapter, pool: addresses.pool, fundingEnabled: true, recallEnabled: true},
      ]);
      expect(resolved.adapterHistory).toEqual([addresses.adapter]);
      expect(resolved.endpoints).toEqual([addresses.manager, addresses.adapter, addresses.pool]);
    }
  });

  it("raises only the known mock conditions on the healthy deployment", async () => {
    const conditions = await checkState();
    expect(conditions.filter((alert) => alert.severity === "critical" || alert.severity === "high")).toEqual([]);
    const byKey = (a: {key: string}, b: {key: string}) => a.key.localeCompare(b.key);
    expect(conditions.map(({key, rule, severity}) => ({key, rule, severity})).sort(byKey)).toEqual(
      KNOWN_MOCK_CONDITIONS.map(({key, rule, severity}) => ({key, rule, severity})).sort(byKey),
    );
  });

  it("answers the real TelegramSink like the Bot API, including injected failures", async () => {
    const mock = telegram as TelegramMock;
    const settings = config.telegram;
    if (!settings) throw new Error("no telegram section");
    const sink = new TelegramSink({...settings, log: silentLogger});

    const [result] = await sink.sendTest();
    expect(result).toEqual({chatId: CHAT_ID, ok: true});
    const test = await mock.waitFor((message) => message.text.includes("Test alert"));
    expect(test).toMatchObject({chat_id: CHAT_ID, parse_mode: "HTML", disable_notification: true});

    // 429: the sink waits retry_after (1 s) and resends.
    mock.failNext(1, {kind: "rate-limit", retryAfterSec: 1});
    await sink.send(firing("Rate limited <once>"), CHAT_ID);
    const limited = await mock.waitFor((message) => message.text.includes("Rate limited &lt;once&gt;"));
    expect(limited.disable_notification).toBe(false);
    expect(mock.requests.filter((request) => request.status === 429)).toHaveLength(1);

    // 400 "can't parse entities": the sink resends the same text as plain text, which the mock accepts.
    mock.failNext(1, {kind: "parse-error"});
    await sink.send(firing("Parse error"), CHAT_ID);
    const plain = await mock.waitFor((message) => message.text.includes("Parse error") && !message.parse_mode);
    expect(plain.text).not.toContain("<b>");

    // A wrong token is rejected (401) and the error never echoes it.
    const wrong = new TelegramSink({...settings, botToken: "999999999:wrong-token-for-e2e", log: silentLogger});
    const [failed] = await wrong.sendTest();
    expect(failed?.ok).toBe(false);
    expect(failed?.error).not.toContain("wrong-token-for-e2e");
    expect(mock.requests.some((request) => request.status === 401)).toBe(true);
  });

  it("drives every scenario action", async () => {
    const d = deployment;
    const {addresses, accounts} = d;
    const rpc = d.anvil.client;
    const manager = {address: addresses.manager, abi: liquidityManagerAbi} as const;
    const operatorEnabled = () =>
      rpc.readContract({...manager, functionName: "isFundingOperator", args: [accounts.fundingOperator.address]});

    expect(await d.operationState(d.handover)).toBe(OPERATION_STATE.done);

    // Fund and recall move exactly the amount between the Manager and the pool.
    const managerBefore = await d.balanceOf(addresses.manager);
    const poolBefore = await d.balanceOf(addresses.pool);
    await d.fund(tokens(1_000_000));
    await d.recall(tokens(400_000));
    expect(await d.balanceOf(addresses.manager)).toBe(managerBefore - tokens(600_000));
    expect(await d.balanceOf(addresses.pool)).toBe(poolBefore + tokens(600_000));

    // Unexplained transfers into and out of the pool.
    await d.directTransferToPool(tokens(1_000));
    expect(await d.balanceOf(addresses.pool)).toBe(poolBefore + tokens(601_000));
    await d.transferOutOfPool(tokens(2_000));
    expect(await d.balanceOf(addresses.pool)).toBe(poolBefore + tokens(599_000));
    expect(await d.balanceOf(accounts.attacker.address)).toBe(tokens(2_000));

    // Guardian restriction, then the Timelock restores it; a scheduled restore can be cancelled by the Guardian.
    await d.guardianSuspendFundingOperator();
    expect(await operatorEnabled()).toBe(false);
    await expect(d.fund(tokens(1))).rejects.toThrow(/CallerNotFundingOperator/);
    const restore = () =>
      d.scheduleTimelockCall(
        addresses.manager,
        encodeManager("setFundingOperator", [accounts.fundingOperator.address, true]),
      );
    const cancelled = await restore();
    expect(await d.operationState(cancelled)).toBe(OPERATION_STATE.waiting);
    await d.guardianCancel(cancelled);
    expect(await d.operationState(cancelled)).toBe(OPERATION_STATE.unset);
    const restored = await restore();
    await d.executeTimelockCall(restored);
    expect(await d.operationState(restored)).toBe(OPERATION_STATE.done);
    expect(await operatorEnabled()).toBe(true);

    await d.guardianPauseFunding();
    await d.guardianRaisePoolMinimum(d.params.thresholds.minimum + 1n);

    // Lockdown zeroes both rate limits of the pool's only chain.
    await d.guardianLockdown();
    const locked = {isEnabled: true, capacity: 0n, rate: 0n};
    const readConfig = (functionName: "outboundConfig" | "inboundConfig") =>
      rpc.readContract({address: addresses.pool, abi: mockPoolAbi, functionName, args: [REMOTE_CHAIN_SELECTOR]});
    expect(await readConfig("outboundConfig")).toEqual([locked.isEnabled, locked.capacity, locked.rate]);
    expect(await readConfig("inboundConfig")).toEqual([locked.isEnabled, locked.capacity, locked.rate]);

    // Token pause and unpause go through the Timelock (the token owner).
    const paused = () => rpc.readContract({address: addresses.token, abi: saharaTokenAbi, functionName: "paused"});
    await d.pauseToken();
    expect(await paused()).toBe(true);
    await d.unpauseToken();
    expect(await paused()).toBe(false);

    // Protected Guardian recovery: the Guardian cannot cancel it; governance executes it after the delay.
    const recovery = await d.scheduleSetGuardian(accounts.replacementGuardian.address);
    expect(recovery.predecessor).toBe(zeroHash);
    const [call] = recovery.calls;
    if (!call) throw new Error("no call");
    const isProtected = await rpc.readContract({
      address: addresses.controller,
      abi: guardianControllerAbi,
      functionName: "isProtectedCall",
      args: [call.target, call.value, call.data],
    });
    expect(isProtected).toBe(true);
    await expect(d.guardianCancel(recovery)).rejects.toThrow(/ProtectedOperation/);
    await d.executeTimelockCall(recovery);
    expect(await rpc.readContract({...manager, functionName: "guardian"})).toBe(accounts.replacementGuardian.address);
  });

  /** Every state rule (stateRules + timelockQueueRule) once at the confirmed head, with a fresh in-memory store. */
  async function checkState(): Promise<Alert[]> {
    const rpc = client();
    const head = await confirmedHead(rpc, chain.confirmations);
    const ctx = createChainContext({
      name: CHAIN,
      chain,
      global: config,
      client: rpc,
      alerter: nullAlerter,
      store: createStore(),
      log: silentLogger,
      addresses: await resolveAddresses(rpc, chain, head),
    });
    const conditions: Alert[] = [];
    for (const rule of [...stateRules, timelockQueueRule]) {
      const result = await rule.check(ctx, head);
      for (const alert of result.conditions) expect(alert.key.startsWith(`${CHAIN}:${rule.id}:`)).toBe(true);
      conditions.push(...result.conditions);
    }
    return conditions;
  }
});

function firing(title: string): OutgoingMessage {
  return {
    alert: {key: `${CHAIN}:e2e:${title}`, kind: "event", severity: "high", rule: "e2e.smoke", chain: CHAIN, title},
    status: "firing",
  };
}
