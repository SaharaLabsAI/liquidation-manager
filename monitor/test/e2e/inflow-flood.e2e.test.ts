// End-to-end check of inflow merging (README "Flows"), the real daemon against anvil and the Telegram mock: an outsider
// mines a flood of 1-wei SAHARA transfers into the pool in one block, then a critical pool outflow follows in the next.
// Without merging every transfer is a high message, delivered at Telegram's 20 per minute ahead of the critical one.
// With it the flood is one message at once and one summary after the window, so the critical one is not held back.
import {rmSync} from "node:fs";

import type {TransactionReceipt} from "viem";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {saharaTokenAbi} from "../../src/abi/external.ts";
import {anvilAvailable, startAnvil, type Anvil} from "./helpers/anvil.ts";
import {CHAIN, writeE2EConfig, type E2EConfig} from "./helpers/config.ts";
import {deploySystem, type E2EDeployment} from "./helpers/deploy.ts";
import {startMonitor, waitForSavedCursor, type MonitorProcess} from "./helpers/monitor-process.ts";
import {firstLine, startTelegramMock, type TelegramMessage, type TelegramMock} from "./helpers/telegram-mock.ts";

/** Dust transfers in the flood block: unmerged, about 5 minutes of Telegram's rate limit. */
const FLOOD = 100;
const MERGE_SEC = 15;
const WAIT_MS = 90_000;

describe.skipIf(!anvilAvailable())("e2e inflow flood (node src/cli.ts run)", () => {
  let anvil: Anvil | undefined;
  let telegram: TelegramMock | undefined;
  let d: E2EDeployment;
  let e2e: E2EConfig | undefined;
  let monitor: MonitorProcess | undefined;

  beforeAll(async () => {
    anvil = await startAnvil();
    telegram = await startTelegramMock();
    d = await deploySystem(anvil);
    e2e = await writeE2EConfig({deployment: d, telegram, startBlock: d.readyBlock + 1n, inflowMergeSec: MERGE_SEC});
  });

  afterAll(async () => {
    await monitor?.stop("SIGKILL");
    await telegram?.close();
    await anvil?.stop();
    if (e2e) rmSync(e2e.dir, {recursive: true, force: true});
  });

  /** `FLOOD` separate 1-wei transfers attacker -> pool, mined into one block. */
  async function dustFlood(node: Anvil): Promise<void> {
    const {attacker} = d.accounts;
    await d.transferToken(d.accounts.deployer, attacker.address, BigInt(FLOOD));
    const wallet = d.wallet(attacker);
    let nonce = await node.client.getTransactionCount({address: attacker.address, blockTag: "pending"});
    await node.rpc("anvil_setAutomine", [false]);
    try {
      for (let i = 0; i < FLOOD; i++) {
        await wallet.writeContract({
          address: d.addresses.token,
          abi: saharaTokenAbi,
          functionName: "transfer",
          args: [d.addresses.pool, 1n],
          nonce: nonce++,
        });
      }
      await node.mine(1);
    } finally {
      await node.rpc("anvil_setAutomine", [true]);
    }
  }

  it("delivers a critical alert right behind the first of a dust flood, and the rest as one summary", async () => {
    if (!anvil || !telegram || !e2e) throw new Error("no setup");
    monitor = startMonitor(e2e, ["run"]);
    await waitForSavedCursor(e2e.stateFile, CHAIN, await anvil.blockNumber());
    telegram.clear();

    await dustFlood(anvil);
    const outflow = await d.transferOutOfPool(10n);
    const critical = await telegram.waitFor(event("flows.pool-outflow", outflow), WAIT_MS);
    const before = telegram.messages.slice(0, telegram.messages.indexOf(critical));
    expect(before.filter((message) => ruleOf(message) === "flows.pool-inflow")).toHaveLength(1);

    // The summary goes out with the first range scanned after the window closed; anvil mines only on demand.
    await new Promise((resolve) => setTimeout(resolve, (MERGE_SEC + 1) * 1000));
    await anvil.mine(1);
    const summary = await telegram.waitFor(
      (message) => ruleOf(message) === "flows.pool-inflow" && message.text.includes("more transfers to Pool merged"),
      WAIT_MS,
    );
    expect(firstLine(summary.text)).toContain(`${FLOOD - 1} more transfers to Pool merged`);
    expect(summary.text).toContain(`raw ${FLOOD - 1}`);
    expect(summary.text).toContain(d.accounts.attacker.address);
    expect(telegram.messages.filter((message) => ruleOf(message) === "flows.pool-inflow")).toHaveLength(2);
  });
});

/** The rule id from a message's footer line (`<i>rule manager.funded</i>`). */
function ruleOf(message: TelegramMessage): string | undefined {
  return /<i>rule ([^<]+)<\/i>/.exec(message.text)?.[1];
}

/** The event alert of `rule` for a transaction. */
function event(rule: string, receipt: TransactionReceipt): (message: TelegramMessage) => boolean {
  return (message) => ruleOf(message) === rule && message.text.toLowerCase().includes(receipt.transactionHash);
}
