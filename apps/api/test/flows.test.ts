// API integration (routes + real Postgres, auth replaced by a header-selected principal).
//   TEST_DATABASE_URL=postgres://<superuser>@127.0.0.1:5437/postgres pnpm --filter @orchestrador/api test
import { OpenAPIHono } from "@hono/zod-openapi";
import { migrate } from "@orchestrador/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("flows & logic API", () => {
  const dbName = `orq_api_${Date.now()}`;
  let admin: pg.Client;
  let app: OpenAPIHono;
  let pool: pg.Pool;
  const users: Record<string, string> = {};

  const perms: Record<string, string[]> = {
    designer: ["flows:read", "flows:write", "flows:simulate", "rules:read", "rules:write", "state_machines:read", "state_machines:write", "work_orders:transition"],
    reviewer: ["flows:read", "flows:approve", "flows:publish", "rules:read", "state_machines:read"],
    viewer: ["flows:read"],
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: `orq_api_${Date.now()}`, password: "x" } });
    process.env.DATABASE_URL = base.toString();
    process.env.APP_ENV = "test";
    pool = new pg.Pool({ connectionString: base.toString() });
    for (const name of ["designer", "reviewer", "viewer"]) {
      users[name] = (await pool.query("INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id", [`${name}@example.com`, name])).rows[0].id;
    }
    const { flows } = await import("../src/modules/flows.js");
    const { logic } = await import("../src/modules/logic.js");
    const { handleError } = await import("../src/middleware/core.js");
    app = new OpenAPIHono();
    app.use("*", async (c, next) => {
      const who = c.req.header("x-user") ?? "viewer";
      c.set("principal" as never, { kind: "user", id: users[who], label: who, roles: [who], permissions: new Set(perms[who]), scopeAll: true, scopes: [], mfa: true, locale: "es" } as never);
      await next();
    });
    app.route("/", flows);
    app.route("/", logic);
    app.onError(handleError);
  });

  afterAll(async () => {
    await pool?.end();
    await (await import("../src/lib/db.js")).pool.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  async function call(method: string, path: string, body?: unknown, who = "designer") {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", "x-user": who }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers };
  }

  const node = (id: string, type: string, properties: Record<string, unknown> = {}, start = false) => ({ id, type: "node", position: { x: 0, y: 0 }, data: { type, properties, ...(start ? { isStartNode: true } : {}) } });
  const edge = (source: string, target: string, handle?: string) => ({ id: `${source}-${target}`, source, target, ...(handle ? { sourceHandle: `source:inner:${handle}` } : {}) });

  it("creates a flow with a starter draft and validates diagrams live", async () => {
    const created = await call("POST", "/flows", { key: "lifts", name: "Ascensores", tags: ["rd-203"] });
    expect(created.status).toBe(201);
    const flow = await call("GET", "/flows/lifts");
    expect(flow.json.versions).toHaveLength(1);
    expect(flow.json.versions[0]).toMatchObject({ version: 1, state: "draft", errors: 0 });

    const bad = await call("POST", "/flows/validate", { diagram: { nodes: [node("a", "flow.end"), node("b", "nope.type")], edges: [] } });
    expect(bad.json.valid).toBe(false);
    expect(bad.json.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(["no_start", "unknown_type"]));

    expect((await call("GET", "/flows?tag=rd-203")).json.items.map((f: { key: string }) => f.key)).toEqual(["lifts"]);
    expect((await call("GET", "/flows", undefined, "viewer")).status).toBe(200);
    expect((await call("POST", "/flows", { key: "x1", name: "x" }, "viewer")).status).toBe(403);
  });

  it("pins rule sets, enforces review (four eyes) and publishes hot", async () => {
    const rule = { key: "hv-rules", name: "Alta tensión", kind: "rules", definition: { kind: "rules", mode: "first", rules: [{ id: "r", name: "AT", when: { kind: "condition", field: "trigger.voltage", operator: "gte", value: 1000 }, then: {} }] } };
    expect((await call("POST", "/rule-sets", rule)).status).toBe(201);
    const diagram = { name: "Ascensores", nodes: [node("t", "flow.trigger", {}, true), node("r", "flow.rule", { ruleSet: "hv-rules" }), node("e1", "flow.end"), node("e2", "flow.end")], edges: [edge("t", "r"), edge("r", "e1", "true"), edge("r", "e2", "false")] };

    // The rule set is still a draft: the editor says so, and the flow cannot be reviewed yet.
    const saved = await call("PUT", "/flows/lifts/versions/1", { diagram });
    expect(saved.json.valid).toBe(true); // drafts may reference draft rule sets while designing
    const stillDraft = await call("POST", "/flows/lifts/versions/1/submit", { comment: "please" });
    expect(stillDraft.status).toBe(422);
    expect(stillDraft.json.details.issues[0].code).toBe("unknown_rule_set");

    expect((await call("POST", "/rule-sets", { definition: {} }, "designer")).status).toBe(400);
    const rs = (await call("GET", "/rule-sets")).json.items[0];
    expect((await call("POST", `/rule-sets/${rs.id}/versions/1/publish`, undefined, "reviewer")).status).toBe(200);
    expect((await call("POST", "/flows/lifts/versions/1/submit", { comment: "please" })).status).toBe(200);

    expect((await call("PUT", "/flows/lifts/versions/1", { diagram })).status).toBe(409); // in review: frozen
    expect((await call("POST", "/flows/lifts/versions/1/publish", {}, "reviewer")).json.code).toBe("not_approved");
    expect((await call("POST", "/flows/lifts/versions/1/reject", { comment: "" }, "reviewer")).status).toBe(400);

    // The designer cannot approve their own request even if they hold the permission.
    perms.designer!.push("flows:approve");
    expect((await call("POST", "/flows/lifts/versions/1/approve", {}, "designer")).json.code).toBe("four_eyes");
    perms.designer!.pop();

    expect((await call("POST", "/flows/lifts/versions/1/approve", { comment: "ok" }, "reviewer")).json.state).toBe("approved");
    const published = await call("POST", "/flows/lifts/versions/1/publish", {}, "reviewer");
    expect(published.status).toBe(200);
    expect(published.json).toMatchObject({ version: 1, previousVersion: null, refs: { rule_sets: { "hv-rules": 1 } } });

    const v1 = (await call("GET", "/flows/lifts/versions/1")).json;
    expect(v1.state).toBe("published");
    expect(v1.definition.nodes.find((n: { id: string }) => n.id === "r").config.__resolved.mode).toBe("first");
    expect(v1.approvals).toHaveLength(1);
    expect((await call("GET", "/flows/lifts")).json.published_version_id).toBe(v1.id);
  });

  it("evolves a published flow through new drafts, compare and rollback", async () => {
    expect((await call("PUT", "/flows/lifts/versions/1", { diagram: starter() })).status).toBe(409);
    const next = await call("POST", "/flows/lifts/versions", { changeNote: "añadir aviso" });
    expect(next.status).toBe(201);
    expect(next.json.version).toBe(2);
    expect((await call("POST", "/flows/lifts/versions", {})).json.code).toBe("open_version");

    const v1 = (await call("GET", "/flows/lifts/versions/1")).json;
    const changed = structuredClone(v1.diagram);
    changed.nodes.push(node("log", "flow.log", { message: "hola" }));
    changed.edges.push(edge("e1", "log"));
    changed.nodes.find((n: { id: string }) => n.id === "r").data.properties.ruleSet = "hv-rules ";
    await call("PUT", "/flows/lifts/versions/2", { diagram: changed });
    // e1 is an end node: an edge leaving it is allowed by the compiler only as a dangling flow; we just check the diff.
    const diff = (await call("GET", "/flows/lifts/versions/1/compare?to=2")).json;
    expect(diff.nodes.added.map((n: { id: string }) => n.id)).toEqual(["log"]);
    expect(diff.nodes.changed[0]).toMatchObject({ id: "r", fields: ["ruleSet"] });
    expect(diff.identical).toBe(false);

    expect((await call("DELETE", "/flows/lifts/versions/2")).status).toBe(200); // discard
    expect((await call("DELETE", "/flows/lifts/versions/1")).status).toBe(409); // published is kept
    const rb = await call("POST", "/flows/lifts/versions/1/rollback");
    expect(rb.status).toBe(201);
    expect(rb.json.version).toBe(2); // the discarded number is free again
  });

  it("copies flows, manages triggers and archives", async () => {
    const copy = await call("POST", "/flows/lifts/copy", { key: "lifts-bcn", name: "Ascensores BCN" });
    expect(copy.status).toBe(201);
    expect((await call("GET", "/flows/lifts-bcn")).json.copied_from).toBeTruthy();

    expect((await call("POST", "/flows/lifts/triggers", { kind: "schedule", config: { cron: "not cron" } })).status).toBe(400);
    const sched = await call("POST", "/flows/lifts/triggers", { kind: "schedule", name: "Diario", config: { cron: "0 7 * * 1-5" } });
    expect(sched.status).toBe(201);
    expect(sched.json.config.timezone).toBe("Europe/Madrid");
    const hook = await call("POST", "/flows/lifts/triggers", { kind: "webhook" });
    expect(hook.json.config.slug).toHaveLength(24);
    expect((await call("POST", "/flows/lifts/triggers", { kind: "event", config: {} })).status).toBe(400);
    await pool.query("UPDATE flow_triggers SET next_run_at = now() WHERE id = $1", [sched.json.id]);
    const patched = await call("PATCH", `/flows/lifts/triggers/${sched.json.id}`, { config: { cron: "0 8 * * *" } });
    expect(patched.json.next_run_at).toBeNull(); // re-armed
    expect((await call("DELETE", `/flows/lifts/triggers/${hook.json.id}`)).status).toBe(200);

    expect((await call("DELETE", "/flows/lifts-bcn", undefined, "reviewer")).status).toBe(200);
    expect((await call("GET", "/flows")).json.items.map((f: { key: string }) => f.key)).not.toContain("lifts-bcn");
    expect((await call("GET", "/flows?archived=true")).json.items.map((f: { key: string }) => f.key)).toContain("lifts-bcn");
  });

  it("exports and imports BPMN", async () => {
    const xml = await call("GET", "/flows/lifts/versions/1/bpmn");
    expect(xml.status).toBe(200);
    expect(xml.headers.get("content-type")).toContain("application/xml");
    expect(xml.json).toContain("<bpmn:businessRuleTask");
    const imported = await call("POST", "/flows/import-bpmn", { xml: xml.json, key: "lifts-from-bpmn" });
    expect(imported.status).toBe(201);
    expect(imported.json.native).toBe(true);
    const roundTrip = (await call("GET", "/flows/lifts-from-bpmn/versions/1")).json;
    expect(roundTrip.validation.filter((i: { severity: string }) => i.severity === "error")).toHaveLength(0);
    expect((await call("POST", "/flows/import-bpmn", { xml: "<not-bpmn/>" + " ".repeat(20), key: "zzz" })).status).toBe(422);
  });

  it("drives entity transitions through a published state machine", async () => {
    const def = {
      entityType: "work_order", initial: "created",
      states: [{ key: "created", label: "Creada" }, { key: "planned", label: "Planificada" }, { key: "closed", label: "Cerrada", final: true }],
      transitions: [{ key: "plan", label: "Planificar", from: "created", to: "planned", requires: ["technician"] }, { key: "close", label: "Cerrar", from: "planned", to: "closed" }],
    };
    expect((await call("POST", "/state-machines", { key: "bad", name: "bad", entityType: "visit", definition: { ...def, initial: "ghost" } })).status).toBe(201); // drafts may be invalid
    const sm = await call("POST", "/state-machines", { key: "wo", name: "Órdenes", entityType: "work_order", definition: def });
    expect(sm.status).toBe(201);
    expect((await call("POST", `/state-machines/${sm.json.id}/versions/1/publish`, undefined, "reviewer")).status).toBe(200);
    const bad = (await call("GET", "/state-machines")).json.items.find((s: { key: string }) => s.key === "bad");
    expect((await call("POST", `/state-machines/${bad.id}/versions/1/publish`, undefined, "reviewer")).status).toBe(422);

    const wo = (await pool.query("INSERT INTO work_orders (status) VALUES ('created') RETURNING id")).rows[0].id;
    const avail = (await call("GET", `/entities/work_order/${wo}/transitions`)).json;
    expect(avail).toMatchObject({ state: "created", transitions: [{ key: "plan", allowed: true, requires: ["technician"] }] });
    expect((await call("POST", `/entities/work_order/${wo}/transitions`, { to: "planned" })).json.code).toBe("transition_payload_missing");
    expect((await call("POST", `/entities/work_order/${wo}/transitions`, { to: "planned", payload: { technician: "t" } }, "viewer")).status).toBe(403);
    const moved = await call("POST", `/entities/work_order/${wo}/transitions`, { transition: "plan", payload: { technician: "t" }, reason: "ready" });
    expect(moved.json).toEqual({ from: "created", to: "planned", transition: "plan" });
    const hist = (await call("GET", `/entities/work_order/${wo}/history`)).json.items;
    expect(hist[0]).toMatchObject({ from_state: "created", to_state: "planned", actor: "designer", reason: "ready" });
    const sim = await call("POST", "/rules/evaluate", { definition: { ">": [{ var: "x" }, 1] }, data: { x: 5 } });
    expect(sim.json).toEqual({ kind: "logic", result: true });
    expect((await call("POST", "/rules/evaluate", { definition: { nope: [1] } })).status).toBe(422);
  });

  const starter = () => ({ nodes: [node("t", "flow.trigger", {}, true), node("e", "flow.end")], edges: [edge("t", "e")] });
});
