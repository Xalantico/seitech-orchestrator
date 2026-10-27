// Needs a throw-away Postgres superuser URL:  TEST_DATABASE_URL=postgres://postgres:...@127.0.0.1:5437/postgres pnpm --filter @orchestrador/flowhost test
import { createPool, migrate, withSystem } from "@orchestrador/db";
import type { StateMachineDef } from "@orchestrador/rules";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { bakeRefs, dispatchDomainEvents, FlowError, runSchedules, transitionEntity, validateCron, type FlowHost } from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const machine: StateMachineDef = {
  entityType: "work_order", initial: "created",
  states: [
    { key: "created", label: "Creada" },
    { key: "planned", label: "Planificada", onEnter: [{ type: "start_flow", flow: "reminders", input: { kind: "planned" } }] },
    { key: "closed", label: "Cerrada", final: true },
  ],
  transitions: [
    { key: "plan", label: "Planificar", from: "created", to: "planned", roles: ["planner"], requires: ["technician"], actions: [{ type: "emit_event", name: "work_order.plan_requested" }, { type: "set_field", field: "line", value: "lifts" }] },
    { key: "close", label: "Cerrar", from: ["planned", "created"], to: "closed", guard: { logic: { "!": { is_empty: [{ var: "entity.line" }] } } } },
  ],
};

suite("flow host", () => {
  const dbName = `orq_fh_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  const flows: Record<string, string> = {};
  const started: { flow?: string; key?: string; kind?: string; payload?: Record<string, unknown> }[] = [];
  let host: FlowHost;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: `orq_fh_${Date.now()}`, password: "x" } });
    pool = createPool(base.toString());

    await withSystem(pool, async (db) => {
      const sm = (await db.query("INSERT INTO state_machines (key, entity_type, name) VALUES ('wo', 'work_order', 'Work order') RETURNING id")).rows[0].id;
      await db.query("INSERT INTO state_machine_versions (state_machine_id, version, state, definition) VALUES ($1, 1, 'published', $2)", [sm, JSON.stringify(machine)]);
      for (const key of ["on-plan", "on-any-wo", "reminders", "nightly"]) {
        const f = (await db.query("INSERT INTO flows (key, name) VALUES ($1, $1) RETURNING id", [key])).rows[0].id;
        const v = (await db.query("INSERT INTO flow_versions (flow_id, version, state, diagram) VALUES ($1, 1, 'published', '{}') RETURNING id", [f])).rows[0].id;
        await db.query("UPDATE flows SET published_version_id = $2 WHERE id = $1", [f, v]);
        flows[key] = f;
      }
      await db.query("INSERT INTO flow_triggers (flow_id, kind, config) VALUES ($1, 'entity_transition', $2)", [flows["on-plan"], JSON.stringify({ entityType: "work_order", to: "planned" })]);
      await db.query("INSERT INTO flow_triggers (flow_id, kind, config) VALUES ($1, 'event', $2)", [flows["on-any-wo"], JSON.stringify({ event: "work_order.*", filter: { "==": [{ var: "event.transition" }, "close"] } })]);
      await db.query("INSERT INTO flow_triggers (flow_id, kind, config) VALUES ($1, 'schedule', $2)", [flows["nightly"], JSON.stringify({ cron: "0 3 * * *", timezone: "Europe/Madrid" })]);
    });

    host = {
      deps: { system: (fn: Parameters<FlowHost["deps"]["system"]>[0]) => withSystem(pool, fn), log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } },
      startExecution: vi.fn(async (o: { flow?: string; idempotencyKey?: string; triggerKind?: string; triggerPayload?: Record<string, unknown> }) => {
        const key = o.idempotencyKey!;
        if (started.some((s) => s.key === key)) throw new FlowError(409, "dup", "duplicate");
        started.push({ flow: o.flow, key, kind: o.triggerKind, payload: o.triggerPayload });
        return { executionId: key, workflowId: key, temporalUrl: "", simulated: false, flowVersionId: null };
      }),
    } as unknown as FlowHost;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  const newWorkOrder = async () => (await withSystem(pool, (db) => db.query("INSERT INTO work_orders (line) VALUES (NULL) RETURNING id"))).rows[0].id as string;
  const tx = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem(pool, fn);

  it("applies a transition: status, history, events, actions", async () => {
    const id = await newWorkOrder();
    const out = await tx((db) => transitionEntity(db, { entityType: "work_order", entityId: id, to: "planned", payload: { technician: "t1" }, actor: { label: "ana", roles: ["planner"] } }));
    expect(out).toMatchObject({ from: "created", to: "planned", transition: "plan" });
    const row = (await pool.query("SELECT status, line FROM work_orders WHERE id = $1", [id])).rows[0];
    expect(row).toEqual({ status: "planned", line: "lifts" });
    expect((await pool.query("SELECT from_state, to_state, actor FROM entity_state_history WHERE entity_id = $1", [id])).rows).toEqual([{ from_state: "created", to_state: "planned", actor: "ana" }]);
    const types = (await pool.query("SELECT type FROM domain_events WHERE entity_id = $1 ORDER BY created_at, type", [id])).rows.map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(["work_order.transitioned", "work_order.planned", "work_order.plan_requested", "flow.start"]));
  });

  it("rejects bad transitions and rolls everything back", async () => {
    const id = await newWorkOrder();
    await expect(tx((db) => transitionEntity(db, { entityType: "work_order", entityId: id, to: "planned", payload: { technician: "t1" }, actor: { label: "bob", roles: ["viewer"] } }))).rejects.toMatchObject({ status: 403, code: "transition_role_denied" });
    await expect(tx((db) => transitionEntity(db, { entityType: "work_order", entityId: id, transition: "close", actor: { label: "bob", system: true } }))).rejects.toMatchObject({ status: 409, code: "transition_guard_failed" });
    await expect(tx((db) => transitionEntity(db, { entityType: "nonexistent", entityId: id, to: "x", actor: { label: "x" } }))).rejects.toBeInstanceOf(FlowError);
    expect((await pool.query("SELECT status FROM work_orders WHERE id = $1", [id])).rows[0].status).toBe("created");
    const dry = await tx((db) => transitionEntity(db, { entityType: "work_order", entityId: id, to: "planned", payload: { technician: "t" }, actor: { label: "x", system: true }, dryRun: true }));
    expect(dry.to).toBe("planned");
    expect((await pool.query("SELECT status FROM work_orders WHERE id = $1", [id])).rows[0].status).toBe("created");
  });

  it("dispatches domain events to matching triggers exactly once", async () => {
    await pool.query("UPDATE domain_events SET dispatched_at = now()"); // ignore earlier tests' events
    const id = await newWorkOrder();
    await tx((db) => transitionEntity(db, { entityType: "work_order", entityId: id, to: "planned", payload: { technician: "t1" }, actor: { label: "ana", roles: ["planner"] } }));
    expect(await dispatchDomainEvents(host)).toBeGreaterThan(0);
    const flowsStarted = started.map((s) => s.flow).sort();
    expect(flowsStarted).toContain(flows["on-plan"]); // entity_transition trigger
    expect(flowsStarted).toContain("reminders"); // flow.start action
    expect(flowsStarted).not.toContain(flows["on-any-wo"]); // filter requires transition == close
    const reminders = started.find((s) => s.flow === "reminders")!;
    expect(reminders.payload).toMatchObject({ kind: "planned", entity: { type: "work_order", id } });

    const before = started.length;
    expect(await dispatchDomainEvents(host)).toBe(0); // nothing pending any more
    expect(started.length).toBe(before);

    await tx((db) => transitionEntity(db, { entityType: "work_order", entityId: id, transition: "close", actor: { label: "ana", system: true } }));
    await dispatchDomainEvents(host);
    expect(started.some((s) => s.flow === flows["on-any-wo"])).toBe(true); // wildcard + filter now match
  });

  it("schedules: arms first, fires when due, idempotently", async () => {
    expect(await runSchedules(host, new Date("2026-03-01T00:00:00Z"))).toBe(0);
    const armed = (await pool.query("SELECT next_run_at FROM flow_triggers WHERE kind = 'schedule'")).rows[0].next_run_at as Date;
    expect(armed.toISOString()).toBe("2026-03-01T02:00:00.000Z"); // 03:00 Madrid (CET) = 02:00Z
    expect(await runSchedules(host, new Date("2026-03-01T01:00:00Z"))).toBe(0);
    expect(await runSchedules(host, new Date("2026-03-01T02:00:05Z"))).toBe(1);
    const run = started.find((s) => s.kind === "schedule")!;
    expect(run.key).toContain("2026-03-01T02:00:00.000Z");
    const next = (await pool.query("SELECT next_run_at, last_run_at FROM flow_triggers WHERE kind = 'schedule'")).rows[0];
    expect(next.next_run_at.toISOString()).toBe("2026-03-02T02:00:00.000Z");
    expect(validateCron("not a cron")).toBeTruthy();
    expect(validateCron("*/5 * * * *")).toBeNull();
  });

  it("bakes published rule sets into node configs", async () => {
    await withSystem(pool, async (db) => {
      const rs = (await db.query("INSERT INTO rule_sets (key, name) VALUES ('hv', 'High voltage') RETURNING id")).rows[0].id;
      await db.query("INSERT INTO rule_set_versions (rule_set_id, version, state, definition) VALUES ($1, 1, 'published', '{\"kind\":\"rules\",\"mode\":\"first\",\"rules\":[]}'), ($1, 2, 'draft', '{\"v\":2}')", [rs]);
    });
    const def = { workflowId: "w", edges: [], nodes: [{ id: "r", type: "flow.rule", kind: "inline" as const, config: { ruleSet: "hv" } }, { id: "m", type: "flow.rule", kind: "inline" as const, config: { ruleSet: "nope" } }] };
    const real = await tx((db) => bakeRefs(db, def));
    expect(real.refs).toEqual({ rule_sets: { hv: 1 }, missing: ["nope"] });
    expect(real.definition.nodes[0]!.config.__resolved).toMatchObject({ mode: "first" });
    const sim = await tx((db) => bakeRefs(db, def, { allowDraft: true }));
    expect(sim.refs.rule_sets.hv).toBe(1); // published still wins over a newer draft
  });
});
