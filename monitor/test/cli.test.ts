import {existsSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {numberToHex, type PublicClient, type RpcLog} from "viem";
import {describe, expect, it, vi} from "vitest";

import {saharaTokenAbi} from "../src/abi/external.ts";
import {EXIT_ALERT, EXIT_ERROR, EXIT_OK, main, parseCli, USAGE, type CliDeps} from "../src/cli.ts";
import {daemonNamespace} from "../src/daemon.ts";
import {serializeState} from "../src/store.ts";
import {deploymentClient, logger} from "./helpers/daemon-fakes.ts";
import {eventLog} from "./helpers/flows-fixtures.ts";
import {A, BLOCK, deployment, ETH, expectedConfig, sdAddr, type Deployment} from "./helpers/state-deployment.ts";

describe("parseCli", () => {
  it("parses every command with its options and the default config path", () => {
    expect(parseCli(["run"])).toEqual({command: "run", config: "./config.yaml", dryRun: false});
    expect(parseCli(["run", "--dry-run", "--config", "/etc/monitor.yaml"])).toEqual({
      command: "run",
      config: "/etc/monitor.yaml",
      dryRun: true,
    });
    expect(parseCli(["--config=c.yaml", "check"])).toEqual({command: "check", config: "c.yaml"});
    expect(parseCli(["test-alert"])).toEqual({command: "test-alert", config: "./config.yaml"});
    expect(parseCli(["scan", "--chain", "bsc", "--from", "100", "--to", "200"])).toEqual({
      command: "scan",
      config: "./config.yaml",
      chain: "bsc",
      from: 100n,
      to: 200n,
    });
    expect(parseCli(["--help"])).toEqual({command: "help"});
    expect(parseCli(["check", "-h"])).toEqual({command: "help"});
  });

  it.each([
    [[], "missing command"],
    [["status"], 'unknown command "status"'],
    [["check", "extra"], 'unexpected argument "extra"'],
    [["check", "--dry-run"], '--dry-run is not an option of "check"'],
    [["run", "--chain", "bsc"], '--chain is not an option of "run"'],
    [["run", "--verbose"], "Unknown option '--verbose'"],
    [["scan", "--from", "1", "--to", "2"], "scan needs --chain <name>"],
    [["scan", "--chain", "bsc", "--to", "2"], "scan needs --from <block>"],
    [["scan", "--chain", "bsc", "--from", "0x10", "--to", "20"], '--from must be a block number, got "0x10"'],
    [["scan", "--chain", "bsc", "--from", "30", "--to", "20"], "--from 30 is after --to 20"],
    [["check", "--config"], "--config"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCli(argv)).toThrow(message);
  });
});

function io(overrides: Partial<CliDeps> = {}) {
  let out = "";
  let err = "";
  const log = logger();
  const deps: CliDeps = {
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    env: {},
    log,
    ...overrides,
  };
  return {deps, log, out: () => out, err: () => err};
}

/** A one-chain config on the state-deployment model, written as JSON (valid YAML) to a fresh directory. */
function writeConfig(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "monitor-cli-"));
  const path = join(dir, "config.yaml");
  const stateFile = join(dir, "state.json");
  const config = {
    stateFile,
    reconciliation: {enabled: false},
    chains: {
      ethereum: {
        chainId: 1,
        chainSelector: ETH.toString(),
        rpcUrls: ["https://rpc.example.com/v2/cli-secret-api-key"],
        explorerUrl: "https://etherscan.io",
        confirmations: 0,
        maxLogRange: 100,
        contracts: {token: A.token, registry: A.registry, pool: A.pool, manager: A.manager, timelock: A.timelock},
        expected: expectedConfig(),
      },
    },
    ...extra,
  };
  writeFileSync(path, JSON.stringify(config));
  return {path, stateFile};
}

const clientFor = (model: Deployment, logs: RpcLog[] = []) => () => deploymentClient(model, BLOCK, logs);

describe("main", () => {
  it("prints the usage and exits 2 on bad arguments, 0 on --help", async () => {
    const bad = io();
    expect(await main(["nope"], bad.deps)).toBe(EXIT_ERROR);
    expect(bad.err()).toBe(`error: unknown command "nope"\n\n${USAGE}`);
    const help = io();
    expect(await main(["--help"], help.deps)).toBe(EXIT_OK);
    expect(help.out()).toBe(USAGE);
  });

  it("exits 2 when the configuration cannot be loaded, without leaking the environment", async () => {
    const missing = io();
    expect(await main(["check", "--config", "/nonexistent/config.yaml"], missing.deps)).toBe(EXIT_ERROR);
    expect(missing.log.lines[0]).toMatchObject({level: "error", message: "cannot load the configuration"});

    const {path} = writeConfig({telegram: {botToken: "${BOT_TOKEN}", routes: [{chatId: "1"}]}});
    const unset = io();
    expect(await main(["check", "--config", path], unset.deps)).toBe(EXIT_ERROR);
    expect(String(unset.log.lines[0]?.fields?.error)).toContain("environment variable BOT_TOKEN is not set");
  });
});

describe("check", () => {
  it("prints addresses, snapshots and conditions and exits 0 on a healthy deployment", async () => {
    const {path, stateFile} = writeConfig();
    const run = io({createClient: clientFor(deployment())});
    expect(await main(["check", "--config", path], run.deps)).toBe(EXIT_OK);
    const out = run.out();
    expect(out).toContain(`== ethereum at confirmed block ${BLOCK} ==`);
    expect(out).toContain(`  Manager: ${A.manager} (Manager)`);
    expect(out).toContain(`  Adapter #1: ${A.adapter} (Adapter #1) -> pool ${A.pool} (Pool)`);
    expect(out).toContain("[state-inventory]\n  Manager balance: 100,000,000 SAHARA");
    expect(out).toContain("== Reconciliation: disabled ==");
    expect(out).toContain("== Violated conditions: 0 ==");
    expect(out).toContain("Result: no critical/high condition – exit 0");
    // Read-only: the state file is never written.
    expect(existsSync(stateFile)).toBe(false);
  });

  it("exits 1 when a critical or high condition holds and prints it", async () => {
    const {path} = writeConfig();
    const model = deployment();
    model.token.paused = true;
    const run = io({createClient: clientFor(model)});
    expect(await main(["check", "--config", path], run.deps)).toBe(EXIT_ALERT);
    expect(run.out()).toMatch(/\[CRITICAL\] ethereum · .*paused/i);
    expect(run.out()).toContain("Result: 1 critical/high condition – exit 1");
  });

  it("uses the real state file read-only: pending Timelock operations are checked, nothing is saved", async () => {
    const {path, stateFile} = writeConfig();
    const id = `0x${"ab".repeat(32)}`;
    const op = {
      id,
      calls: [],
      predecessor: `0x${"00".repeat(32)}`,
      salt: null,
      delay: 172_800n,
      scheduledAt: 1_700_000_000,
      readyAt: 1_700_172_800,
      txHash: `0x${"cd".repeat(32)}`,
      summary: "LiquidityManager.setGuardian(newGuardian=0x…)",
      severity: "critical",
      protected: true,
      status: "pending",
      batch: false,
      scheduledBlock: 1n,
    };
    const state = serializeState({"timelock:ethereum": {ops: {[id]: op}}, [daemonNamespace("ethereum")]: {cursor: 5n}});
    writeFileSync(stateFile, state);
    const model = deployment();
    const client = deploymentClient(model, BLOCK) as unknown as {readContract: (p: {functionName: string}) => unknown};
    const read = client.readContract.bind(client);
    client.readContract = async (params: {functionName: string}) => {
      if (params.functionName === "getOperationState") return 2;
      if (params.functionName === "getTimestamp") return 1_700_172_800n;
      return read(params);
    };
    const run = io({createClient: () => client as unknown as PublicClient});
    expect(await main(["check", "--config", path], run.deps)).toBe(EXIT_ALERT);
    expect(run.out()).toContain("Timelock operation executable now: ");
    expect(readFileSync(stateFile, "utf8")).toBe(state);
  });

  it("runs the reconciliation when enabled and prints its report", async () => {
    const {path} = writeConfig({reconciliation: {enabled: true}});
    const run = io({createClient: clientFor(deployment()), now: () => 1_760_000_000_000});
    const code = await main(["check", "--config", path], run.deps);
    expect(run.out()).toContain("== Reconciliation ==\nSAHARA reconciliation at ");
    expect(run.out()).toContain("Reserves: ");
    // No CCIP tracking yet (empty state file): incomplete is a warning, not an exit code.
    expect(code).toBe(EXIT_OK);
  });

  it("exits 2 on an RPC error, with the RPC URL redacted", async () => {
    const {path} = writeConfig();
    const failing = {
      getBlockNumber: async () => {
        throw new Error("fetch failed: https://rpc.example.com/v2/cli-secret-api-key");
      },
    } as unknown as PublicClient;
    const run = io({createClient: () => failing});
    expect(await main(["check", "--config", path], run.deps)).toBe(EXIT_ERROR);
    expect(run.out()).toContain("== ethereum: RPC error ==");
    expect(run.out()).not.toContain("cli-secret-api-key");
    expect(run.out()).toContain("Result: incomplete (ethereum failed) – exit 2");
  });
});

describe("test-alert", () => {
  const telegram = {
    botToken: "123456:cli-test-bot-token",
    apiUrl: "https://telegram.example.com",
    routes: [{chatId: "-1001"}, {chatId: "-1002", threadId: 42}],
  };

  it("sends the info test message to every route, says it arrives silently and prints each result", async () => {
    const {path} = writeConfig({telegram});
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.chat_id === "-1002") {
        return new Response(JSON.stringify({ok: false, error_code: 400, description: "chat not found"}), {status: 400});
      }
      return new Response(JSON.stringify({ok: true}));
    });
    const run = io({fetch});
    expect(await main(["test-alert", "--config", path], run.deps)).toBe(EXIT_ALERT);
    expect(run.out()).toContain("info severity, so it arrives silently (disable_notification");
    expect(run.out()).toContain("chat -1001: ok\n");
    expect(run.out()).toContain("chat -1002 thread 42: error: ");
    expect(run.out()).toContain("chat not found");
    expect(bodies.every((body) => body.disable_notification === true)).toBe(true);
    expect(run.out()).not.toContain("cli-test-bot-token");

    const ok = io({fetch: async () => new Response(JSON.stringify({ok: true}))});
    expect(await main(["test-alert", "--config", path], ok.deps)).toBe(EXIT_OK);
  });

  it("exits 1 without a telegram section", async () => {
    const {path} = writeConfig();
    const run = io();
    expect(await main(["test-alert", "--config", path], run.deps)).toBe(EXIT_ALERT);
    expect(run.out()).toContain("No telegram section is configured");
  });
});

describe("scan", () => {
  /** A SAHARA Paused log two blocks below the head (a critical event alert). */
  function pausedLog(): RpcLog {
    const paused = eventLog(saharaTokenAbi, A.token, "Paused", {account: sdAddr(0x99)}, {
      txHash: `0x${"ee".repeat(32)}`,
      blockNumber: BLOCK - 2n,
      logIndex: 3,
    });
    return {
      ...paused,
      blockNumber: numberToHex(paused.blockNumber!),
      logIndex: numberToHex(paused.logIndex!),
      transactionIndex: numberToHex(0),
    } as unknown as RpcLog;
  }

  it("replays every event rule over the range and prints the alerts, sending and saving nothing", async () => {
    const {path, stateFile} = writeConfig({telegram: {botToken: "123456:never-used-token", routes: [{chatId: "1"}]}});
    const rpc = pausedLog();
    const fetch = vi.fn();
    const run = io({createClient: clientFor(deployment(), [rpc]), fetch});
    const argv = ["scan", "--config", path, "--chain", "ethereum", "--from", `${BLOCK - 150n}`, "--to", `${BLOCK}`];
    const code = await main(argv, run.deps);
    expect(code).toBe(EXIT_OK);
    const range = `${BLOCK - 150n}-${BLOCK}`;
    expect(run.out()).toContain(`Scanning ethereum blocks ${range} (addresses resolved at block ${BLOCK})`);
    expect(run.out()).toMatch(/\[CRITICAL\] ethereum · .*[Pp]aused/);
    expect(run.out()).toContain("Done: 2 chunk(s) of up to 100 blocks.");
    // Printed in the background during the scan, all of it before "Done".
    expect(run.out().indexOf("[CRITICAL]")).toBeLessThan(run.out().indexOf("Done:"));
    expect(run.out()).not.toContain("could not be printed");
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(stateFile)).toBe(false);
  });

  it("waits a bounded time for the alerts, then says how many it could not print", async () => {
    const {path} = writeConfig();
    let text = "";
    const broken = io({
      createClient: clientFor(deployment(), [pausedLog()]),
      out: (chunk) => {
        if (chunk.startsWith("[")) throw new Error("write EPIPE");
        text += chunk;
      },
    });
    const argv = ["scan", "--config", path, "--chain", "ethereum", "--from", `${BLOCK - 150n}`, "--to", `${BLOCK}`];
    const started = Date.now();
    expect(await main(argv, broken.deps)).toBe(EXIT_OK);
    // The failed write is retried later, but the scan does not wait for that: the retry is cancelled.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(text).toMatch(/\n\d+ alert message\(s\) could not be printed\.\nDone: 2 chunk/);
    expect(broken.log.lines.map((line) => line.message)).toContain(
      "alert delivery failed with an unclassified error, retrying",
    );
  });

  it("exits 2 for an unknown chain or an RPC failure", async () => {
    const {path} = writeConfig();
    const unknown = io();
    const scan = (chain: string) => ["scan", "--config", path, "--chain", chain, "--from", "1", "--to", "2"];
    expect(await main(scan("polygon"), unknown.deps)).toBe(EXIT_ERROR);
    expect(unknown.out()).toContain('Unknown chain "polygon"; configured: ethereum');

    const failing = {
      readContract: async () => {
        throw new Error("timeout");
      },
    } as unknown as PublicClient;
    const rpc = io({createClient: () => failing});
    expect(await main(scan("ethereum"), rpc.deps)).toBe(EXIT_ERROR);
    expect(rpc.out()).toContain("Scan failed: timeout");
  });
});

describe("run", () => {
  it("starts the daemon and stops it cleanly when the stop signal arrives (dry run: no state file)", async () => {
    const {path, stateFile} = writeConfig();
    let signal!: (name: string) => void;
    const stop = new Promise<string>((resolve) => (signal = resolve));
    const run = io({createClient: clientFor(deployment()), waitForStop: () => stop});
    const exit = main(["run", "--dry-run", "--config", path], run.deps);
    await vi.waitFor(() => expect(run.out()).toContain("Monitor started (dry run)"));
    signal("SIGTERM");
    expect(await exit).toBe(EXIT_OK);
    const messages = run.log.lines.map((line) => line.message);
    expect(messages).toEqual(expect.arrayContaining(["monitor started", "stopping", "monitor stopped"]));
    expect(messages.indexOf("stopping")).toBeLessThan(messages.indexOf("monitor stopped"));
    expect(existsSync(stateFile)).toBe(false);
  });

  it("saves the state file on stop outside a dry run", async () => {
    const {path, stateFile} = writeConfig();
    let signal!: (name: string) => void;
    const stop = new Promise<string>((resolve) => (signal = resolve));
    const run = io({createClient: clientFor(deployment()), waitForStop: () => stop});
    const exit = main(["run", "--config", path], run.deps);
    await vi.waitFor(() => expect(run.out()).toContain("Monitor started"));
    signal("SIGINT");
    expect(await exit).toBe(EXIT_OK);
    const saved = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, {cursor?: {$bigint: string}}>;
    expect(saved[daemonNamespace("ethereum")]?.cursor).toEqual({$bigint: String(BLOCK)});
  });
});
