// API integration for operations, query, saved filters, exports and the dashboard (real Postgres).
//   TEST_DATABASE_URL=postgres://<superuser>@127.0.0.1:5437/postgres pnpm --filter @orchestrador/api test
import { OpenAPIHono } from "@hono/zod-openapi";
import { migrate, seedBase } from "@orchestrador/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const files = new Map<string, { data: Buffer; filename: string; mime: string }>();
vi.mock("../src/lib/documents.js", () => ({
  saveDocument: async (_db: unknown, doc: { data: Buffer; filename: string; mime?: string }) => {
    const id = crypto.randomUUID();
    files.set(id, { data: doc.data, filename: doc.filename, mime: doc.mime ?? "application/octet-stream" });
    return { id };
  },
  readDocument: async (_c: unknown, id: string) => ({ ...files.get(id)!, body: files.get(id)!.data }),
}));

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("operations, query and dashboard API", () => {
  const dbName = `orq_ops_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let app: OpenAPIHono;
  const users: Record<string, string> = {};

  const OPS = ["work_orders:read", "work_orders:write", "work_orders:transition", "visits:read", "visits:write", "visits:transition", "orders:read", "orders:write", "customers:read", "customers:write", "technicians:read", "technicians:write",
    "nonconformities:read", "nonconformities:write", "certificates:read", "tasks:read", "executions:read", "dashboard:read", "filters:read", "filters:write", "exports:run", "catalogs:read", "catalogs:write"];
  const perms: Record<string, string[]> = {
    ops: OPS,
    boss: [...OPS, "visits:edit_duration", "customers:pii", "audit:read"],
    peer: ["filters:read", "filters:write", "work_orders:read"],
    reader: ["dashboard:read"],
  };
  let ids: { customer: string; site: string; tech: string; type: string; delegation: string };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: `orq_ops_${Date.now()}`, password: "x" } });
    process.env.DATABASE_URL = base.toString();
    process.env.APP_ENV = "test";
    pool = new pg.Pool({ connectionString: base.toString() });
    await seedBase(pool as never);
    for (const name of Object.keys(perms)) {
      users[name] = (await pool.query("INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id", [`${name}@example.com`, name])).rows[0].id;
    }
    const delegation = (await pool.query("INSERT INTO delegations (code, name) VALUES ('MAD', 'Madrid') ON CONFLICT (code) DO UPDATE SET name = 'Madrid' RETURNING id")).rows[0].id;
    const customer = (await pool.query("INSERT INTO customers (code, name, delegation_id) VALUES ('C-T1', 'Cliente Test', $1) RETURNING id", [delegation])).rows[0].id;
    const site = (await pool.query("INSERT INTO sites (customer_id, name, delegation_id) VALUES ($1, 'Edificio A', $2) RETURNING id", [customer, delegation])).rows[0].id;
    const tech = (await pool.query("INSERT INTO technicians (code, name, delegation_id) VALUES ('T-X', 'Ana Técnica', $1) RETURNING id", [delegation])).rows[0].id;
    await pool.query("INSERT INTO qualifications (technician_id, kind, valid_to) VALUES ($1, 'lifts', current_date + 200)", [tech]);
    const type = (await pool.query("INSERT INTO visit_types (code, name, inspection_type, avg_duration_min, avg_travel_min, second_visit_days) VALUES ('LIFT-PERIODIC', 'Lift periodic', 'lifts', 90, 20, 15) RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO visit_type_overrides (visit_type_id, delegation_id, duration_min) VALUES ($1, $2, 120)", [type, delegation]);
    ids = { customer, site, tech, type, delegation };

    const { operations } = await import("../src/modules/operations.js");
    const { query } = await import("../src/modules/query.js");
    const { dashboard } = await import("../src/modules/dashboard.js");
    const { logic } = await import("../src/modules/logic.js");
    const { handleError } = await import("../src/middleware/core.js");
    app = new OpenAPIHono();
    app.use("*", async (c, next) => {
      const who = c.req.header("x-user") ?? "ops";
      c.set("principal" as never, { kind: "user", id: users[who], label: who, roles: [who === "boss" ? "supervisor" : "gestor"], permissions: new Set(perms[who]), scopeAll: true, scopes: [], mfa: true, locale: "es" } as never);
      await next();
    });
    for (const m of [operations, query, dashboard, logic]) app.route("/", m);
    app.onError(handleError);
  });

  afterAll(async () => {
    await pool?.end();
    await (await import("../src/lib/db.js")).pool.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  async function call(method: string, path: string, body?: unknown, who = "ops") {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", "x-user": who }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const ct = res.headers.get("content-type") ?? "";
    const json = ct.includes("json") ? await res.json() : undefined;
    return { status: res.status, json: json as any, res }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const at = (days: number, hour = 9) => { const d = new Date(Date.now() + days * 86_400_000); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

  let woId: string;
  let visitId: string;

  it("builds a work order and a visit whose duration comes from the delegation override", async () => {
    const wo = await call("POST", "/work-orders", { customer_id: ids.customer, site_id: ids.site, inspection_type: "lifts", priority: "high", due_date: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10), delegation_id: ids.delegation });
    expect(wo.status).toBe(201);
    expect(wo.json.status).toBe("created");
    woId = wo.json.id;
    expect((await call("PATCH", `/work-orders/${woId}`, { status: "closed" })).status).toBe(400); // status cannot be edited directly
    expect((await pool.query("SELECT status FROM work_orders WHERE id = $1", [woId])).rows[0].status).toBe("created");

    const v = await call("POST", `/work-orders/${woId}/visits`, { visitTypeId: ids.type });
    expect(v.status).toBe(201);
    expect(v.json).toMatchObject({ sequence: 1, status: "created", estimated_duration_min: 120 });
    visitId = v.json.id;
  });

  it("schedules, detects overlaps and expired qualifications, and guards the duration override", async () => {
    const ok = await call("POST", `/visits/${visitId}/schedule`, { technicianId: ids.tech, start: at(3) });
    expect(ok.json).toMatchObject({}); expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ transition: "schedule", visit: { status: "scheduled" } });
    expect(new Date(ok.json.visit.scheduled_end).getTime() - new Date(ok.json.visit.scheduled_start).getTime()).toBe(120 * 60_000);

    const second = await call("POST", `/work-orders/${woId}/visits`, { visitTypeId: ids.type });
    const clash = await call("POST", `/visits/${second.json.id}/schedule`, { technicianId: ids.tech, start: at(3) });
    expect(clash.status).toBe(409);
    expect(clash.json.code).toBe("technician_busy");
    expect((await call("POST", `/visits/${second.json.id}/schedule`, { technicianId: ids.tech, start: at(3), allowOverlap: true })).status).toBe(200);

    // Qualification valid for 200 days only.
    const late = await call("POST", `/visits/${second.json.id}/schedule`, { technicianId: ids.tech, start: at(400), allowOverlap: true });
    expect(late.json.code).toBe("qualification_invalid");

    expect((await call("PATCH", `/visits/${visitId}/duration`, { durationMin: 45 })).status).toBe(403);
    const dur = await call("PATCH", `/visits/${visitId}/duration`, { durationMin: 45 }, "boss");
    expect(dur.json.estimated_duration_min).toBe(45);
    expect((await call("GET", `/visits/${visitId}`)).json.duration_overridden).toBe(true);
    await call("POST", `/visits/${second.json.id}/start`);
    await call("POST", `/visits/${second.json.id}/incident`, { reason: "Cliente ausente" });
  });

  it("records an unfavorable result: completes the visit, raises a nonconformity and allows a second visit", async () => {
    expect((await call("POST", `/visits/${visitId}/second-visit`, {})).json.code).toBe("second_visit_not_applicable");
    const res = await call("POST", `/visits/${visitId}/result`, { result: "unfavorable", defects: [{ code: "ASC-12", severity: "major", description: "Freno desgastado" }] });
    expect(res.status).toBe(201);
    expect(res.json.nonconformityId).toBeTruthy();
    expect(res.json.secondVisitSuggested).toBe(true);
    expect((await call("GET", `/visits/${visitId}`)).json).toMatchObject({ status: "completed", result: "unfavorable" });

    const sv = await call("POST", `/visits/${visitId}/second-visit`, {});
    expect(sv.status).toBe(201);
    expect(sv.json).toMatchObject({ parent_visit_id: visitId, sequence: 3, estimated_duration_min: 120 });

    const timeline = await call("GET", `/work-orders/${woId}/timeline`);
    expect(timeline.json.visits).toHaveLength(3);
    expect(timeline.json.nonconformities).toHaveLength(1);
    expect(timeline.json.stateHistory.map((h: { to_state: string }) => h.to_state)).toEqual(expect.arrayContaining(["scheduled", "in_progress", "completed", "incident"]));
    const events = await pool.query("SELECT type FROM domain_events WHERE type IN ('nc.detected', 'visit.result')");
    expect(events.rows.map((r) => r.type).sort()).toEqual(["nc.detected", "visit.result"]);
  });

  it("encrypts customer personal data and audits reads", async () => {
    expect((await call("PUT", `/customers/${ids.customer}/pii`, { email: "cliente@example.com", phone: "+34600111222" })).status).toBe(200);
    expect((await call("GET", `/customers/${ids.customer}/pii`)).status).toBe(403);
    expect((await call("GET", `/customers/${ids.customer}`)).json).not.toHaveProperty("email_enc");
    const pii = await call("GET", `/customers/${ids.customer}/pii`, undefined, "boss");
    expect(pii.json).toMatchObject({ email: "cliente@example.com", phone: "+34600111222", tax_id: null });
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'pii.read'")).rows[0].n).toBe(1);
    const raw = (await pool.query("SELECT email_enc FROM customers WHERE id = $1", [ids.customer])).rows[0].email_enc as Buffer;
    expect(raw.toString("utf8")).not.toContain("cliente@example.com");
  });

  it("queries any entity with the shared filter language and keeps it safe", async () => {
    const meta = await call("GET", "/query/entities");
    expect(meta.json.entities.map((e: { key: string }) => e.key)).toEqual(expect.arrayContaining(["work_orders", "visits", "tasks"]));
    expect((await call("GET", "/query/entities", undefined, "reader")).json.entities).toHaveLength(0);

    const r = await call("POST", "/query/visits", { filter: { op: "and", items: [{ field: "status", op: "eq", value: "completed" }, { field: "customer", op: "contains", value: "Cliente" }] }, columns: ["number", "status", "result", "technician"] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ total: 1, columns: ["number", "status", "result", "technician"] });
    expect(r.json.rows[0]).toMatchObject({ result: "unfavorable", technician: "Ana Técnica" });

    expect((await call("POST", "/query/visits", { filter: { field: "status", op: "eq", value: "bogus" } })).status).toBe(400);
    expect((await call("POST", "/query/nope", {})).status).toBe(404);
    expect((await call("POST", "/query/visits", {}, "reader")).status).toBe(403);
    const injection = await call("POST", "/query/work_orders", { q: "'; DROP TABLE work_orders; --" });
    expect(injection.status).toBe(200);
    expect(injection.json.total).toBe(0);
  });

  it("saves, shares and duplicates filters with the right permissions", async () => {
    const def = { filter: { field: "status", op: "in", value: ["created", "planned"] }, columns: ["number", "status"] };
    const created = await call("POST", "/saved-filters", { name: "Abiertas", entity: "work_orders", definition: def, visibility: "private" });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect((await call("GET", "/saved-filters?entity=work_orders", undefined, "peer")).json.items).toHaveLength(0);
    expect((await call("POST", "/saved-filters", { name: "mala", entity: "work_orders", definition: { filter: { field: "x", op: "eq", value: 1 } } })).status).toBe(400);

    const shared = await call("POST", "/saved-filters", { name: "Para todos", entity: "work_orders", definition: def, visibility: "all", editableByOthers: false });
    expect((await call("GET", "/saved-filters", undefined, "peer")).json.items.map((f: { name: string }) => f.name)).toEqual(["Para todos"]);
    expect((await call("PUT", `/saved-filters/${shared.json.id}`, { name: "hack" }, "peer")).status).toBe(403);
    await call("PUT", `/saved-filters/${shared.json.id}`, { editableByOthers: true });
    expect((await call("PUT", `/saved-filters/${shared.json.id}`, { name: "Editado por peer" }, "peer")).status).toBe(200);
    const copy = await call("POST", `/saved-filters/${shared.json.id}/duplicate`, undefined, "peer");
    expect(copy.status).toBe(201);
    expect((await call("DELETE", `/saved-filters/${shared.json.id}`, undefined, "peer")).status).toBe(404);
    expect((await call("DELETE", `/saved-filters/${copy.json.id}`, undefined, "peer")).status).toBe(200);
  });

  it("exports the same rows the list shows and audits it", async () => {
    const out = await call("POST", "/exports", { entity: "visits", format: "csv", spec: { columns: ["number", "status", "result"], filter: { field: "status", op: "eq", value: "completed" } } });
    expect(out.status).toBe(201);
    expect(out.json).toMatchObject({ status: "done", rowCount: 1 });
    const download = await call("GET", `/exports/${out.json.id}/download`);
    const text = await download.res.text();
    expect(text).toContain("unfavorable");
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(2);
    expect((await call("GET", `/exports/${out.json.id}/download`, undefined, "peer")).status).toBe(403); // no exports:run
    expect((await call("GET", "/exports")).json.items).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'export'")).rows[0].n).toBe(1);

    for (const format of ["xlsx", "pdf"]) expect((await call("POST", "/exports", { entity: "work_orders", format, spec: {} })).json.status).toBe("done");
    expect((await call("POST", "/exports", { entity: "visits", format: "csv", spec: { columns: ["nope"] } })).status).toBe(400);
    expect((await pool.query("SELECT count(*)::int AS n FROM export_jobs WHERE status = 'failed'")).rows[0].n).toBe(1);
  });

  it("dashboard KPIs match their drill-down lists exactly", async () => {
    const kpis = await call("GET", "/dashboard/kpis");
    expect(kpis.status).toBe(200);
    const byKey = Object.fromEntries(kpis.json.kpis.map((k: { key: string }) => [k.key, k]));
    expect(byKey.wo_open.value).toBe(1);
    expect(byKey.nc_open.value).toBe(1);
    expect(byKey.visits_second.value).toBe(1);
    expect(byKey.visits_incident.value).toBe(1);

    // Every KPI's number equals the total of the list it drills into.
    for (const k of kpis.json.kpis.filter((x: { unit: string }) => x.unit === "count")) {
      const list = await call("POST", `/query/${k.drill.entity}`, { filter: k.drill.filter, limit: 1 });
      expect(list.json.total, k.key).toBe(k.value);
    }
    expect((await call("GET", "/dashboard/kpis", undefined, "reader")).json.kpis).toHaveLength(0); // no entity permissions

    const series = await call("GET", "/dashboard/kpis/wo_open/series?days=7");
    expect(series.json.points.reduce((a: number, p: { value: number }) => a + p.value, 0)).toBe(1);
    const breakdown = await call("POST", "/dashboard/breakdown", { entity: "visits", groupBy: "status" });
    expect(Object.fromEntries(breakdown.json.items.map((i: { key: string; value: number }) => [i.key, i.value]))).toMatchObject({ completed: 1, incident: 1 });
    expect((await call("POST", "/dashboard/breakdown", { entity: "visits", groupBy: "zzz" })).status).toBe(400);
    expect((await call("GET", "/dashboard/kpis?delegation=Madrid")).json.kpis.find((k: { key: string }) => k.key === "wo_open").value).toBe(1);
    expect((await call("GET", "/dashboard/kpis?delegation=Sevilla")).json.kpis.find((k: { key: string }) => k.key === "wo_open").value).toBe(0);
  });
});
