import { describe, expect, it } from "vitest";

import { definition, edge, launch, node, start } from "./helpers.js";

const act = (id: string) => node(id, `act.${id}`, "activity");

const ruleSet = {
  kind: "rules", mode: "all",
  rules: [{ id: "hv", name: "High voltage", when: { kind: "condition", field: "trigger.voltage", operator: "gte", value: 1000 }, then: { set: { double_validation: true } }, else: { set: { double_validation: false } } }],
};

describe("rule nodes", () => {
  it("routes by a baked rule set and exposes its variables", async () => {
    const rule = node("r", "flow.rule", "inline", { config: { __resolved: ruleSet } });
    const def = definition([start(), rule, act("hv"), act("lv")], [edge("start", "r"), edge("r", "hv", "true"), edge("r", "lv", "false")]);
    const { rt, promise } = launch(def, { triggerPayload: { voltage: 20000 } });
    await promise;
    expect(rt.types("hv")).toContain("node_completed");
    expect(rt.events.find((e) => e.nodeId === "lv" && e.type === "node_skipped")).toBeTruthy();
  });

  it("uses inline JSON when nothing is pinned, and fails clearly with neither", async () => {
    const rule = node("r", "flow.rule", "inline", { config: { definition: JSON.stringify(ruleSet) } });
    const { rt, promise } = launch(definition([start(), rule, act("lv")], [edge("start", "r"), edge("r", "lv", "false")]), { triggerPayload: { voltage: 230 } });
    await promise;
    expect(rt.types("lv")).toContain("node_completed");

    const empty = node("r", "flow.rule", "inline", { config: {} });
    const failing = launch(definition([start(), empty], [edge("start", "r")]), {});
    await failing.promise;
    expect(failing.result.value?.status).toBe("failed");
  });

  it("decision tables set prefixed variables", async () => {
    const table = {
      kind: "decision_table", hitPolicy: "first", inputs: [{ key: "type", path: "trigger.type" }], outputs: [{ key: "months" }],
      rows: [{ when: { type: "lift" }, then: { months: 6 } }, { when: { type: "" }, then: { months: 12 } }],
    };
    const t = node("t", "flow.decision-table", "inline", { config: { definition: table, prefix: "plan_" } });
    const { rt, promise } = launch(definition([start(), t, act("after")], [edge("start", "t"), edge("t", "after", "true")]), { triggerPayload: { type: "lift" } });
    await promise;
    const completed = rt.events.find((e) => e.nodeId === "t" && e.type === "node_completed");
    expect(JSON.stringify(completed?.payload)).toContain('"months":6');
  });
});
