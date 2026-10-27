import { OpenAPIHono } from "@hono/zod-openapi";
import { transitionEntity, loadStateMachine, STATEFUL_ENTITIES } from "@orchestrador/flowhost";
import {
  OPERATORS, evalRuleSet, evalTable, evaluate, checkTransition, validateLogic, validateRuleSet, validateStateMachine, validateTable,
  type DecisionTable, type RuleSetDefinition, type StateMachineDef,
} from "@orchestrador/rules";

import { run } from "../lib/db.js";
import { HttpError, notFound } from "../lib/errors.js";
import { can } from "../lib/principal.js";
import { define, z } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";
import { versionedRoutes } from "../lib/versioned.js";

export const logic = new OpenAPIHono<AppEnv>();

logic.route("/", versionedRoutes({
  tag: "State machines", basePath: "/state-machines", parentTable: "state_machines", versionTable: "state_machine_versions", fk: "state_machine_id",
  permissions: { read: "state_machines:read", write: "state_machines:write", publish: "flows:publish" },
  parentFields: { entityType: z.enum(Object.keys(STATEFUL_ENTITIES) as [string, ...string[]]) },
  extraColumns: { entity_type: "entityType" },
  validate(definition) {
    const issues = validateStateMachine(definition as StateMachineDef);
    return { errors: issues.filter((i) => i.severity === "error").map((i) => i.message), warnings: issues.filter((i) => i.severity === "warning").map((i) => i.message) };
  },
}));

function validateRuleDefinition(def: unknown): { errors: string[]; warnings?: string[] } {
  const d = def as { kind?: string };
  if (d?.kind === "decision_table") return { errors: validateTable(def as DecisionTable) };
  if (d?.kind === "rules") return { errors: validateRuleSet(def as RuleSetDefinition) };
  if (d?.kind === "parameters") return { errors: [] };
  return { errors: ['The definition needs a "kind": rules, decision_table or parameters'] };
}

logic.route("/", versionedRoutes({
  tag: "Rule sets", basePath: "/rule-sets", parentTable: "rule_sets", versionTable: "rule_set_versions", fk: "rule_set_id",
  permissions: { read: "rules:read", write: "rules:write", publish: "flows:publish" },
  parentFields: { kind: z.enum(["rules", "decision_table", "parameters"]).default("rules") },
  extraColumns: { kind: "kind" },
  validate: validateRuleDefinition,
}));

define(logic, { method: "get", path: "/rule-sets-operators", tag: "Rule sets", summary: "Operators the rule engine understands", permission: "rules:read" }, async (c) => c.json({ operators: OPERATORS }));

define(logic, {
  method: "post", path: "/rules/evaluate", tag: "Rule sets", summary: "Try a rule set, decision table or JSON-Logic expression against sample data", permission: "rules:read",
  body: z.object({ definition: z.unknown(), data: z.record(z.unknown()).default({}) }),
}, async (c, i) => {
  const def = i.body.definition as { kind?: string };
  try {
    if (def?.kind === "decision_table") return c.json({ kind: "decision_table", result: evalTable(def as DecisionTable, i.body.data) });
    if (def?.kind === "rules") return c.json({ kind: "rules", result: evalRuleSet(def as RuleSetDefinition, i.body.data) });
    const problems = validateLogic(def);
    if (problems.length > 0) throw new HttpError(422, problems.join("; "), "invalid_logic");
    return c.json({ kind: "logic", result: evaluate(def, i.body.data) });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, error instanceof Error ? error.message : "Evaluation failed", "evaluation_failed");
  }
});

// ───────────── entity transitions ─────────────
const TRANSITION_PERMISSION: Record<string, string> = {
  order: "orders:write",
  work_order: "work_orders:transition",
  visit: "visits:transition",
  nonconformity: "nonconformities:transition",
  certificate: "certificates:transition",
};
const entityParams = z.object({ type: z.enum(Object.keys(STATEFUL_ENTITIES) as [string, ...string[]]), id: z.string().uuid() });

define(logic, { method: "get", path: "/entities/{type}/{id}/transitions", tag: "State machines", summary: "Transitions the current user could take right now", permission: "state_machines:read", params: entityParams }, async (c, i) => {
  const p = c.get("principal")!;
  const out = await run(c, async (db) => {
    const machine = await loadStateMachine(db, i.params.type);
    if (!machine) return { state: null, transitions: [], machine: null };
    const row = (await db.query(`SELECT * FROM ${STATEFUL_ENTITIES[i.params.type]} WHERE id = $1`, [i.params.id])).rows[0];
    if (!row) throw notFound("Entity");
    const state = machine.definition.states.find((s) => s.key === row.status);
    const allowedByPermission = can(p, TRANSITION_PERMISSION[i.params.type]!);
    const transitions = machine.definition.transitions
      .filter((t) => (Array.isArray(t.from) ? t.from : [t.from]).some((f) => f === row.status || f === "*"))
      .map((t) => {
        // Payload is unknown here, so only role and guard are evaluated; required payload keys are reported.
        const check = checkTransition(machine.definition, row.status, { key: t.key }, { entity: row, actor: { roles: p.roles, label: p.label }, payload: Object.fromEntries((t.requires ?? []).map((k) => [k, true])), now: new Date().toISOString() });
        return { key: t.key, label: t.label, to: t.to, requires: t.requires ?? [], allowed: allowedByPermission && check.ok, reason: check.ok ? null : check.message };
      });
    return { state: row.status, stateLabel: state?.label ?? row.status, final: Boolean(state?.final), machine: { id: machine.id, version: machine.version }, transitions };
  });
  return c.json(out);
});

define(logic, {
  method: "post", path: "/entities/{type}/{id}/transitions", tag: "State machines", summary: "Move an entity to another state", permission: "state_machines:read", params: entityParams,
  description: "Checks the entity's state machine (guard, roles, required data), updates the status, records history and queues events. Needs the transition permission of the entity type.",
  body: z.object({ transition: z.string().optional(), to: z.string().optional(), payload: z.record(z.unknown()).default({}), reason: z.string().max(500).optional() }).refine((b) => b.transition || b.to, "Provide transition or to"),
}, async (c, i) => {
  const p = c.get("principal")!;
  const needed = TRANSITION_PERMISSION[i.params.type]!;
  if (!can(p, needed)) throw new HttpError(403, `Missing permission ${needed}`, "forbidden");
  const outcome = await run(c, (db) =>
    transitionEntity(db, {
      entityType: i.params.type, entityId: i.params.id, ...(i.body.to ? { to: i.body.to } : {}), ...(i.body.transition ? { transition: i.body.transition } : {}),
      payload: i.body.payload, reason: i.body.reason ?? null, actor: { label: p.label, userId: p.kind === "user" ? p.id : null, roles: p.roles },
    }),
  );
  return c.json({ from: outcome.from, to: outcome.to, transition: outcome.transition });
});

define(logic, { method: "get", path: "/entities/{type}/{id}/history", tag: "State machines", summary: "State change history of an entity", permission: "state_machines:read", params: entityParams }, async (c, i) => {
  const r = await run(c, (db) => db.query("SELECT from_state, to_state, actor, reason, execution_id, at FROM entity_state_history WHERE entity_type = $1 AND entity_id = $2 ORDER BY at DESC, id DESC LIMIT 500", [i.params.type, i.params.id]));
  return c.json({ items: r.rows });
});
