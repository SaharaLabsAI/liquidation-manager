import {describe, expect, it} from "vitest";

import {ConsoleSink, renderConsoleText} from "../src/alerts/console.ts";
import type {OutgoingMessage} from "../src/types.ts";

const firing: OutgoingMessage = {
  alert: {
    key: "ethereum:state-inventory:0xpool",
    kind: "condition",
    severity: "warning",
    rule: "state-inventory",
    chain: "ethereum",
    title: "Pool below refill trigger: fund up to target",
    fields: [
      {label: "Balance", value: "900 SAHARA", code: true},
      {label: "Calls", value: "first\nsecond"},
    ],
    links: [{label: "Pool", url: "https://etherscan.io/address/0xpool?a=1&b=2"}],
    note: "Fund the pool <now>.",
  },
  status: "firing",
};

describe("ConsoleSink", () => {
  it("renders plain text without markup or escaping", () => {
    expect(renderConsoleText(firing).split("\n")).toEqual([
      "[WARNING] ethereum · Pool below refill trigger: fund up to target",
      "  Balance: 900 SAHARA",
      "  Calls: first",
      "    second",
      "  Fund the pool <now>.",
      "  Pool: https://etherscan.io/address/0xpool?a=1&b=2",
      "  (rule state-inventory, key ethereum:state-inventory:0xpool)",
    ]);
  });

  it("labels reminders and resolved messages with the open duration", () => {
    const reminder = renderConsoleText({...firing, status: "reminder", openForSec: 43200});
    expect(reminder.split("\n")[0]).toBe(
      "[REMINDER WARNING] ethereum · Pool below refill trigger: fund up to target (open for 12h)",
    );
    const resolved = renderConsoleText({...firing, status: "resolved", openForSec: 90});
    expect(resolved.split("\n")[0]).toBe(
      "[RESOLVED] ethereum · Pool below refill trigger: fund up to target (was WARNING, open for 1m)",
    );
    expect(resolved).not.toContain("Fund the pool");
  });

  it("writes one block per message to the injected writer and honours minSeverity", async () => {
    const out: string[] = [];
    const sink = new ConsoleSink({write: (text) => out.push(text), minSeverity: "warning"});
    await sink.send(firing);
    await sink.send({...firing, alert: {...firing.alert, severity: "info", chain: undefined, title: "Routine"}});
    await sink.send({...firing, alert: {...firing.alert, severity: "critical"}});
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(`${renderConsoleText(firing)}\n\n`);
    expect(out[1]?.startsWith("[CRITICAL] ethereum · ")).toBe(true);
  });
});
