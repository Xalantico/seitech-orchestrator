import { describe, expect, it } from "vitest";

import {
  buildLogic, checkTransition, evalRuleSet, evalTable, evaluate, matchCell, test as logicTest, validateLogic, validateRuleSet, validateStateMachine, validateTable,
  type DecisionTable, type Group, type RuleSetDefinition, type StateMachineDef,
} from "../src/index.js";

describe("json-logic", () => {
  const data = { entity: { type: "lift", age: 12, tags: ["a", "b"], customer: { name: "ACME" } }, trigger: { amount: 1500 } };
  it("evaluates comparisons, logic, vars and defaults", () => {
    expect(evaluate({ ">": [{ var: "trigger.amount" }, 1000] }, data)).toBe(true);
    expect(evaluate({ and: [{ "==": [{ var: "entity.type" }, "lift"] }, { "<": [{ var: "entity.age" }, 5] }] }, data)).toBe(false);
    expect(evaluate({ or: [false, { var: "entity.customer.name" }] }, data)).toBe("ACME");
    expect(evaluate({ var: ["entity.missing", "n/a"] }, data)).toBe("n/a");
    expect(evaluate({ if: [{ "<": [{ var: "entity.age" }, 5] }, "new", { "<": [{ var: "entity.age" }, 15] }, "mid", "old"] }, data)).toBe("mid");
    expect(evaluate({ in: ["b", { var: "entity.tags" }] }, data)).toBe(true);
    expect(evaluate({ cat: ["OT-", { var: "entity.age" }] }, data)).toBe("OT-12");
  });
  it("supports collection operators and domain operators", () => {
    expect(evaluate({ some: [{ var: "list" }, { ">": [{ var: "" }, 3] }] }, { list: [1, 5] })).toBe(true);
    expect(evaluate({ all: [{ var: "list" }, { ">": [{ var: "" }, 3] }] }, { list: [1, 5] })).toBe(false);
    expect(evaluate({ reduce: [{ var: "list" }, { "+": [{ var: "current" }, { var: "accumulator" }] }, 0] }, { list: [1, 2, 3] })).toBe(6);
    expect(evaluate({ days_between: ["2026-03-01", "2026-03-11"] })).toBe(10);
    expect(evaluate({ between: [5, 1, 10] })).toBe(true);
    expect(evaluate({ missing: ["a", "b"] }, { a: 1 })).toEqual(["b"]);
    expect(logicTest({ regex: [{ var: "ref" }, "^OT-\\d+$"] }, { ref: "OT-42" })).toBe(true);
  });
  it("rejects unknown operators and absurd nesting", () => {
    expect(() => evaluate({ exec: ["rm"] })).toThrow(/Unknown operator/);
    expect(validateLogic({ and: [{ nope: 1 }] })).toEqual(['$.and[0]: unknown operator "nope"']);
    let deep: unknown = true;
    for (let i = 0; i < 100; i += 1) deep = { "!": deep };
    expect(() => evaluate(deep)).toThrow(/nested too deeply/);
  });
});

describe("visual builder", () => {
  it("compiles groups and conditions to JSON-Logic", () => {
    const tree: Group = {
      kind: "group", combinator: "and", rules: [
        { kind: "condition", field: "entity.type", operator: "eq", value: "lift" },
        { kind: "group", combinator: "or", rules: [
          { kind: "condition", field: "entity.age", operator: "gt", value: 20 },
          { kind: "condition", field: "entity.defects", operator: "not_empty" },
        ] },
      ],
    };
    const logic = buildLogic(tree);
    expect(logicTest(logic, { entity: { type: "lift", age: 25 } })).toBe(true);
    expect(logicTest(logic, { entity: { type: "lift", age: 3, defects: [] } })).toBe(false);
    expect(logicTest(logic, { entity: { type: "lift", age: 3, defects: ["x"] } })).toBe(true);
    expect(logicTest(buildLogic({ kind: "group", combinator: "and", rules: [] }), {})).toBe(true);
    expect(logicTest(buildLogic({ kind: "condition", field: "d", operator: "days_after", valueField: "ref", value2: 30 }), { d: "2026-04-01", ref: "2026-03-01" })).toBe(true);
  });
});

describe("decision tables", () => {
  const table: DecisionTable = {
    kind: "decision_table", hitPolicy: "first",
    inputs: [{ key: "type", path: "entity.inspection_type" }, { key: "age", path: "entity.age" }],
    outputs: [{ key: "months" }, { key: "second_visit" }],
    rows: [
      { when: { type: "lift", age: ">= 20" }, then: { months: 6, second_visit: true } },
      { when: { type: "lift", age: "" }, then: { months: 12, second_visit: false } },
      { when: { type: "in a|b", age: "0..5" }, then: { months: 24, second_visit: false } },
    ],
    default: { months: 36, second_visit: false },
  };
  it("matches rows by FEEL-lite cells and honours hit policies", () => {
    expect(evalTable(table, { entity: { inspection_type: "lift", age: 25 } }).outputs).toEqual({ months: 6, second_visit: true });
    expect(evalTable(table, { entity: { inspection_type: "lift", age: 3 } }).outputs).toEqual({ months: 12, second_visit: false });
    expect(evalTable(table, { entity: { inspection_type: "b", age: 4 } }).rows).toEqual([2]);
    expect(evalTable(table, { entity: { inspection_type: "z", age: 4 } })).toMatchObject({ matched: false, outputs: { months: 36 } });
    expect(evalTable({ ...table, hitPolicy: "collect" }, { entity: { inspection_type: "lift", age: 25 } }).rows).toEqual([0, 1]);
    expect(() => evalTable({ ...table, hitPolicy: "unique" }, { entity: { inspection_type: "lift", age: 25 } })).toThrow(/ambiguous/);
  });
  it("parses every cell form", () => {
    expect(matchCell("> 5", 6)).toBe(true);
    expect(matchCell("!= x", "y")).toBe(true);
    expect(matchCell("1..3", 2)).toBe(true);
    expect(matchCell("a, b", "B")).toBe(true);
    expect(matchCell("contains fire", "Wildfire")).toBe(true);
    expect(matchCell("empty", "")).toBe(true);
    expect(matchCell("not empty", "")).toBe(false);
    expect(matchCell('= "x y"', "x y")).toBe(true);
  });
  it("validates structure", () => {
    expect(validateTable({ ...table, rows: [{ when: { nope: "1" }, then: { zzz: 1 } }] })).toEqual(['Row 1: unknown input "nope"', 'Row 1: unknown output "zzz"']);
  });
});

describe("rule sets", () => {
  const def: RuleSetDefinition = {
    kind: "rules", mode: "all",
    rules: [
      { id: "r1", name: "High voltage", when: { kind: "condition", field: "entity.voltage", operator: "gte", value: 1000 }, then: { set: { double_validation: true }, tags: ["AT"] }, else: { set: { double_validation: false } } },
      { id: "r2", name: "Old", when: { logic: { ">": [{ var: "entity.age" }, 15] } }, then: { port: "second_visit" } },
    ],
    default: { port: "none" },
  };
  it("applies matching rules in order", () => {
    const r = evalRuleSet(def, { entity: { voltage: 20000, age: 20 } });
    expect(r).toMatchObject({ port: "second_visit", set: { double_validation: true }, tags: ["AT"], matched: true });
    expect(evalRuleSet(def, { entity: { voltage: 230, age: 1 } })).toMatchObject({ set: { double_validation: false }, matched: false, port: "none" });
    expect(evalRuleSet({ ...def, mode: "first" }, { entity: { voltage: 20000, age: 20 } }).port).toBeUndefined();
    expect(validateRuleSet({ ...def, rules: [...def.rules, { id: "r1", name: "dup", when: { logic: { nope: 1 } }, then: {} }] })).toHaveLength(2);
  });
});

describe("state machines", () => {
  const sm: StateMachineDef = {
    entityType: "work_order", initial: "created",
    states: [
      { key: "created", label: "Creada" },
      { key: "planned", label: "Planificada", onEnter: [{ type: "start_flow", flow: "planning-reminders" }] },
      { key: "closed", label: "Cerrada", final: true },
      { key: "orphan", label: "Huérfana" },
    ],
    transitions: [
      { key: "plan", label: "Planificar", from: "created", to: "planned", roles: ["planner"], requires: ["technician"], guard: { kind: "condition", field: "entity.line", operator: "not_empty" } },
      { key: "close", label: "Cerrar", from: ["planned", "created"], to: "closed" },
      { key: "cancel", label: "Cancelar", from: "*", to: "closed" },
    ],
  };
  it("checks role, payload and guard in that order and returns actions", () => {
    const ctx = { entity: { line: "lifts" }, actor: { roles: ["planner"] }, payload: { technician: "t1" } };
    const ok = checkTransition(sm, "created", { to: "planned" }, ctx);
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) expect(ok.actions).toEqual([{ type: "start_flow", flow: "planning-reminders" }]);
    expect(checkTransition(sm, "created", { key: "plan" }, { ...ctx, actor: { roles: ["viewer"] } })).toMatchObject({ ok: false, code: "role_denied" });
    expect(checkTransition(sm, "created", { key: "plan" }, { ...ctx, payload: {} })).toMatchObject({ ok: false, code: "payload_missing" });
    expect(checkTransition(sm, "created", { key: "plan" }, { ...ctx, entity: { line: "" } })).toMatchObject({ ok: false, code: "guard_failed" });
    expect(checkTransition(sm, "closed", { key: "plan" }, ctx)).toMatchObject({ ok: false, code: "final_state" });
    expect(checkTransition(sm, "planned", { to: "created" }, ctx)).toMatchObject({ ok: false, code: "no_transition" });
    expect(checkTransition(sm, "planned", { key: "cancel" }, ctx)).toMatchObject({ ok: true });
  });
  it("validates definitions", () => {
    expect(validateStateMachine(sm).map((i) => i.message)).toEqual(['State "Huérfana" can never be reached']);
    expect(validateStateMachine({ ...sm, initial: "nope", transitions: [{ key: "x", label: "x", from: "ghost", to: "ghost2" }] }).filter((i) => i.severity === "error")).toHaveLength(3);
  });
});

import { DEFAULT_STATE_MACHINES } from "../src/index.js";

describe("default state machines", () => {
  it.each(Object.entries(DEFAULT_STATE_MACHINES))("%s is valid and fully reachable", (_k, m) => {
    expect(validateStateMachine(m.definition)).toEqual([]);
  });
  it("visit can only be scheduled with a date and loops back from an incident", () => {
    const visit = DEFAULT_STATE_MACHINES.visit!.definition;
    expect(checkTransition(visit, "created", { key: "schedule" }, { entity: { scheduled_start: null } })).toMatchObject({ ok: false, code: "guard_failed" });
    expect(checkTransition(visit, "created", { key: "schedule" }, { entity: { scheduled_start: "2026-03-01T10:00:00Z" } })).toMatchObject({ ok: true });
    expect(checkTransition(visit, "incident", { to: "scheduled" }, { entity: { scheduled_start: "2026-03-05T10:00:00Z" } })).toMatchObject({ ok: true });
  });
});
