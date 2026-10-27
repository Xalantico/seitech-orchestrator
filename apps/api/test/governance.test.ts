// Back office (alerts, scheduled exports), governance (GDPR, retention, BI), copilot and MJML templates, against a real Postgres.
import { OpenAPIHono } from "@hono/zod-openapi";
import { migrate, seedBase } from "@orchestrador/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const objects = new Map<string, Buffer>();
vi.mock("../src/lib/services.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/services.js")>();
  const store = {
    ensureBucket: async () => undefined,
    put: async (bucket: string, key: string, body: Buffer) => { objects.set(`${bucket}/${key}`, body); return { sha256: "x", size: body.length }; },
    get: async (bucket: string, key: string) => ({ body: objects.get(`${bucket}/${key}`) ?? Buffer.alloc(0), mime: undefined, metadata: {} }),
    remove: async (bucket: string, key: string) => { objects.delete(`${bucket}/${key}`); },
    list: async () => [],
  };
  return { ...real, store };
});

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("back office, governance and copilot API", () => {
  const dbName = `orq_gov_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let app: OpenAPIHono;
  let userId: string;
  let customerId: string;
  const perms = new Set(["exports:schedule", "alerts:read", "alerts:write", "audit:read", "gdpr:manage", "system:admin", "bi:read", "copilot:use", "work_orders:read", "templates:read", "templates:write", "customers:read"]);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: `orq_gv_${Date.now()}`, password: "x" } });
    process.env.DATABASE_URL = base.toString();
    process.env.APP_ENV = "test";
    pool = new pg.Pool({ connectionString: base.toString() });
    userId = (await pool.query("INSERT INTO users (email, display_name) VALUES ('g@example.com', 'g') RETURNING id")).rows[0].id;
    await seedBase(pool);
    await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'admin'", [userId]);
    customerId = (await pool.query("INSERT INTO customers (name, address) VALUES ('Comunidad Los Pinos', 'Calle Mayor 1') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO work_orders (status, customer_id) VALUES ('created', $1), ('created', $1)", [customerId]);
    const { backoffice } = await import("../src/modules/backoffice.js");
    const { governance } = await import("../src/modules/governance.js");
    const { copilot } = await import("../src/modules/copilot.js");
    const { comms } = await import("../src/modules/comms.js");
    const { handleError } = await import("../src/middleware/core.js");
    app = new OpenAPIHono();
    app.use("*", async (c, next) => {
      c.set("principal" as never, { kind: "user", id: userId, label: "g", roles: ["admin"], permissions: perms, scopeAll: true, scopes: [], mfa: true, locale: "es" } as never);
      await next();
    });
    for (const m of [backoffice, governance, copilot, comms]) app.route("/", m);
    app.onError(handleError);
  });
  afterAll(async () => {
    await pool?.end();
    await (await import("../src/lib/db.js")).pool.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text, headers: res.headers };
  }

  describe("alerts", () => {
    it("fires on a threshold, can be acknowledged once and is removed with its rule", async () => {
      expect((await call("GET", "/alert-metrics")).json.items.length).toBeGreaterThan(5);
      expect((await call("POST", "/alert-rules", { name: "x", metric: "nope", threshold: 1 })).status).toBe(400);
      const rule = (await call("POST", "/alert-rules", { name: "Demasiadas OT abiertas", metric: "wo_open", operator: "gte", threshold: 2, recipients: ["ops@example.com"] })).json;
      expect(rule.id).toBeTruthy();
      const evaluated = (await call("POST", "/alerts/evaluate")).json;
      expect(evaluated).toMatchObject({ fired: 1, failed: 0 });
      const open = (await call("GET", "/alerts?status=open")).json.items;
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ rule: "Demasiadas OT abiertas", metric: "wo_open", status: "firing" });
      expect(Number(open[0].value)).toBe(2);
      // A second evaluation does not open a second alert for the same rule.
      expect((await call("POST", "/alerts/evaluate")).json.fired).toBe(0);
      expect((await call("POST", `/alerts/${open[0].id}/acknowledge`)).json.status).toBe("acknowledged");
      expect((await call("POST", `/alerts/${open[0].id}/acknowledge`)).status).toBe(409);
      expect((await call("DELETE", `/alert-rules/${rule.id}`)).status).toBe(200);
      expect((await call("GET", "/alerts")).json.items).toHaveLength(0);
      expect((await call("DELETE", `/alert-rules/${rule.id}`)).status).toBe(404);
    });
  });

  describe("scheduled exports", () => {
    const body = { name: "OT semanales", entity: "work_orders", format: "csv", cron: "0 7 * * 1", recipients: ["jefe@example.com"] };
    it("rejects bad schedules", async () => {
      expect((await call("POST", "/export-schedules", { ...body, entity: "nope" })).json.code).toBe("bad_entity");
      expect((await call("POST", "/export-schedules", { ...body, cron: "not a cron!!" })).json.code).toBe("bad_cron");
      expect((await call("POST", "/export-schedules", { ...body, cron: "*/5 * * * *" })).json.code).toBe("too_frequent");
    });

    it("runs now, mails an expiring link and serves the file through it", async () => {
      const created = (await call("POST", "/export-schedules", body)).json;
      expect(created.next_run_at).toBeTruthy();
      const ran = await call("POST", `/export-schedules/${created.id}/run`);
      expect(ran.status).toBe(200);
      const mail = (await pool.query("SELECT body, to_address FROM messages WHERE to_address = 'jefe@example.com' ORDER BY created_at DESC LIMIT 1")).rows[0];
      const token = /shared\/exports\/([\w.-]+)/.exec(mail.body)?.[1];
      expect(token).toBeTruthy();
      const file = await call("GET", `/shared/exports/${token}`);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toContain("csv");
      expect(file.text.split("\n").filter(Boolean).length).toBe(3); // header + two work orders
      expect((await call("GET", `/shared/exports/${token}x`)).status).toBe(410);
      expect((await pool.query("SELECT count(*)::int AS n FROM document_access_log WHERE actor = 'shared-link'")).rows[0].n).toBe(1);
      expect((await call("DELETE", `/export-schedules/${created.id}`)).status).toBe(200);
    });
  });

  describe("governance", () => {
    it("summarises security and flags toxic role combinations", async () => {
      const overview = (await call("GET", "/governance/overview")).json;
      expect(overview.users.active).toBeGreaterThanOrEqual(1);
      expect(overview.retention.policy.operationalYears).toBe(5);
      expect(Array.isArray(overview.toxicRoleHolders)).toBe(true);
    });

    it("previews a retention purge and records it", async () => {
      const report = (await call("POST", "/governance/retention/run", { dryRun: true })).json;
      expect(report.dryRun).toBe(true);
      const status = (await call("GET", "/governance/retention")).json;
      expect(status.runs[0]).toMatchObject({ dry_run: true, status: "done" });
    });

    it("exports and then erases a customer, and refuses to erase twice", async () => {
      const exp = await call("POST", `/gdpr/customer/${customerId}/export`);
      expect(exp.status).toBe(201);
      expect(exp.json.counts.workOrders).toBe(2);
      const bundle = await call("GET", `/gdpr/requests/${exp.json.requestId}/bundle`);
      expect(bundle.status).toBe(200);
      expect(bundle.json.data.customer.name).toBe("Comunidad Los Pinos");

      expect((await call("POST", `/gdpr/customer/${customerId}/erase`, { confirm: false, reason: "pedido por el titular" })).status).toBe(400);
      // Open work blocks the erasure and the refusal is recorded.
      const refused = await call("POST", `/gdpr/customer/${customerId}/erase`, { confirm: true, reason: "pedido por el titular" });
      expect(refused.status).toBe(409);
      await pool.query("UPDATE work_orders SET status = 'closed' WHERE customer_id = $1", [customerId]);
      const done = await call("POST", `/gdpr/customer/${customerId}/erase`, { confirm: true, reason: "pedido por el titular" });
      expect(done.status).toBe(200);
      expect((await pool.query("SELECT name, anonymized_at FROM customers WHERE id = $1", [customerId])).rows[0].name).not.toBe("Comunidad Los Pinos");
      expect((await call("POST", `/gdpr/customer/${customerId}/erase`, { confirm: true, reason: "pedido por el titular" })).status).toBe(409);
      const requests = (await call("GET", `/gdpr/requests?subjectId=${customerId}`)).json.items;
      expect(requests.map((r: { kind: string; status: string }) => `${r.kind}:${r.status}`).sort()).toEqual(["erase:done", "erase:refused", "erase:refused", "export:done"]);
      expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('gdpr.export', 'gdpr.erase')")).rows[0].n).toBe(2);
    });

    it("reports BI as not configured until a Metabase is wired", async () => {
      expect((await call("GET", "/bi/dashboards")).json).toEqual({ configured: false, items: [] });
    });
  });

  describe("copilot", () => {
    it("answers from the knowledge base without a language model and keeps an audited history", async () => {
      expect((await call("GET", "/copilot/status")).json.mode).toBe("retrieval");
      expect((await call("POST", "/copilot/guide")).json.chunks).toBeGreaterThan(3);
      await call("POST", "/copilot/knowledge", { ref: "rd-203-2021", title: "RD 203/2021 inspecciones", content: "Las instalaciones de ascensores deben inspeccionarse cada dos años en edificios de uso residencial según la reglamentación vigente." });
      const answer = (await call("POST", "/copilot/ask", { question: "cada cuánto se inspeccionan los ascensores" })).json;
      expect(answer.mode).toBe("retrieval");
      expect(answer.sources.length).toBeGreaterThan(0);
      expect(answer.conversationId).toBeTruthy();
      const history = (await call("GET", "/copilot/history")).json.items;
      expect(history).toHaveLength(1);
      expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'copilot.prompt'")).rows[0].n).toBe(1);
    });
  });

  describe("MJML templates", () => {
    const mjml = (text: string) => `<mjml><mj-body><mj-section><mj-column><mj-text>${text}</mj-text></mj-column></mj-section></mj-body></mjml>`;
    it("compiles the MJML into the version's HTML", async () => {
      const r = await call("POST", "/templates", { key: "visita.aviso", name: "Aviso", channelKind: "email", subject: "Visita {{visita.fecha}}", mjml: mjml("Hola {{cliente.nombre}}") });
      expect(r.status).toBe(201);
      const html = (await pool.query("SELECT body_html, mjml FROM template_versions LIMIT 1")).rows[0];
      expect(html.body_html).toContain("Hola {{cliente.nombre}}");
      expect(html.mjml).toContain("<mjml>");
    });
    it("refuses MJML that tries to include files or is broken", async () => {
      const bad = await call("POST", "/templates", { key: "malo.include", name: "Malo", channelKind: "email", subject: "x", mjml: `<mjml><mj-body><mj-include path="/etc/passwd" /></mj-body></mjml>` });
      expect(bad.status).toBe(422);
      expect(bad.json.code).toBe("invalid_mjml");
    });
  });
});
