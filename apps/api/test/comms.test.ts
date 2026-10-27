// API integration for channels, templates, messages, consents, queues and task attachments (real Postgres).
import { OpenAPIHono } from "@hono/zod-openapi";
import { migrate } from "@orchestrador/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/documents.js", () => ({
  saveDocument: async (_db: unknown, doc: { filename: string }) => ({ id: crypto.randomUUID(), filename: doc.filename }),
  readDocument: async () => { throw new Error("not used"); },
}));

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("communications, queues and attachments API", () => {
  const dbName = `orq_comms_api_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let app: OpenAPIHono;
  const users: Record<string, string> = {};
  const perms: Record<string, string[]> = {
    admin: ["channels:read", "channels:write", "templates:read", "templates:write", "messages:read", "messages:send", "customers:read", "customers:write", "tasks:read", "tasks:write", "tasks:act", "tasks:claim", "queues:read", "queues:write", "documents:write", "dashboard:read", "catalogs:write", "catalogs:read"],
    viewer: ["templates:read", "messages:read"],
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: `orq_ca_${Date.now()}`, password: "x" } });
    process.env.DATABASE_URL = base.toString();
    process.env.APP_ENV = "test";
    pool = new pg.Pool({ connectionString: base.toString() });
    for (const name of Object.keys(perms)) users[name] = (await pool.query("INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id", [`${name}@example.com`, name])).rows[0].id;
    const { comms } = await import("../src/modules/comms.js");
    const { tasks } = await import("../src/modules/tasks.js");
    const { catalogs } = await import("../src/modules/catalogs.js");
    const { handleError } = await import("../src/middleware/core.js");
    app = new OpenAPIHono();
    app.use("*", async (c, next) => {
      const who = c.req.header("x-user") ?? "admin";
      c.set("principal" as never, { kind: "user", id: users[who], label: who, roles: [who], permissions: new Set(perms[who]), scopeAll: true, scopes: [], mfa: true, locale: "es" } as never);
      await next();
    });
    for (const m of [comms, tasks, catalogs]) app.route("/", m);
    app.onError(handleError);
  });
  afterAll(async () => {
    await pool?.end();
    await (await import("../src/lib/db.js")).pool.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  async function call(method: string, path: string, body?: unknown, who = "admin") {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", "x-user": who }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = (res.headers.get("content-type") ?? "").includes("json") ? await res.json() : undefined;
    return { status: res.status, json: json as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  async function upload(path: string, filename: string, content: string, fields: Record<string, string> = {}, who = "admin") {
    const form = new FormData();
    form.set("file", new File([content], filename, { type: "text/html" }));
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const res = await app.request(path, { method: "POST", headers: { "x-user": who }, body: form });
    return { status: res.status, json: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  let madrid: string;
  let templateId: string;

  it("configures channels per delegation", async () => {
    madrid = (await pool.query("INSERT INTO delegations (code, name) VALUES ('MAD', 'Madrid') ON CONFLICT (code) DO UPDATE SET name = 'Madrid' RETURNING id")).rows[0].id;
    const generic = await call("POST", "/channels", { key: "sms-default", kind: "sms", name: "SMS global", provider: "mock" });
    const local = await call("POST", "/channels", { key: "sms-madrid", kind: "sms", name: "SMS Madrid", provider: "http", delegation_id: madrid, config: { url: "https://gw.example" }, rate_limit_per_min: 120 });
    expect([generic.status, local.status]).toEqual([201, 201]);
    expect((await call("POST", "/channels", { key: "BAD KEY", kind: "sms", name: "x" })).status).toBe(400);
    expect((await call("POST", "/channels", { key: "x", kind: "sms", name: "x" }, "viewer")).status).toBe(403);
  });

  it("creates, uploads, validates, previews and publishes template versions", async () => {
    const created = await call("POST", "/templates", { key: "visit.reminder", name: "Recordatorio de visita", channelKind: "email", subject: "Visita {{entity.number}}", bodyHtml: "<p>Hola {{entity.customer}}</p>", bodyText: "Hola {{entity.customer}}" });
    expect(created.status).toBe(201);
    templateId = created.json.id;
    expect(created.json.version).toMatchObject({ version: 1, state: "draft", variables: ["entity.customer", "entity.number"] });
    expect((await call("POST", "/templates", { key: "evil", name: "x", channelKind: "email", subject: "s", bodyHtml: "<script>alert(1)</script>", bodyText: "t" })).json.code).toBe("invalid_template");

    const up = await upload(`/templates/${templateId}/upload`, "nuevo.html", "<html><head><title>Aviso {{entity.number}}</title></head><body><p>Estimado {{entity.customer}}, su visita es el {{entity.date}}</p></body></html>", { bodyText: "Visita {{entity.date}}" });
    expect(up.status).toBe(201);
    expect(up.json).toMatchObject({ version: 2, origin: "upload" });
    expect((await upload(`/templates/${templateId}/upload`, "x.exe", "MZ")).status).toBe(400);
    expect((await upload(`/templates/${templateId}/upload`, "bad.html", "<img src=x onerror=alert(1)>")).status).toBe(422);

    const preview = await call("POST", `/templates/${templateId}/versions/2/preview`, { data: { entity: { number: 55, customer: "Ana" } } });
    expect(preview.json).toMatchObject({ subject: "Aviso 55", missing: ["entity.date"] });
    expect(preview.json.html).toContain("Estimado Ana");

    expect((await call("POST", `/templates/${templateId}/versions/1/publish`, {})).status).toBe(200);
    expect((await call("POST", `/templates/${templateId}/versions/2/publish`, {})).status).toBe(200);
    const t = await call("GET", `/templates/${templateId}`);
    expect(t.json.versions.map((v: { version: number; state: string }) => `${v.version}:${v.state}`)).toEqual(["2:published", "1:retired"]);
    expect((await call("GET", "/templates", undefined, "viewer")).json.items[0]).toMatchObject({ key: "visit.reminder", published_version: 2, latest_version: 2 });
    expect((await call("POST", `/templates/${templateId}/versions`, { subject: "x", bodyText: "x" }, "viewer")).status).toBe(403);
  });

  it("queues manual messages through the delegation's channel, with retry and cancel", async () => {
    const sms = await call("POST", "/messages", { channel: "sms", to: "+34600111222", body: "Su visita es mañana", delegationId: madrid });
    expect(sms.status).toBe(201);
    expect(sms.json.channelConfigured).toBe(true);
    const row = (await pool.query("SELECT c.key FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = $1", [sms.json.id])).rows[0];
    expect(row.key).toBe("sms-madrid"); // the delegation's own channel wins over the global one
    const global = await call("POST", "/messages", { channel: "sms", to: "+34600111333", body: "x" });
    expect((await pool.query("SELECT c.key FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = $1", [global.json.id])).rows[0].key).toBe("sms-default");

    const mail = await call("POST", "/messages", { channel: "email", to: "a@example.com", templateKey: "visit.reminder", variables: { entity: { number: 9, customer: "Ana", date: "lunes" } } });
    const stored = await call("GET", `/messages/${mail.json.id}`);
    expect(stored.json).toMatchObject({ subject: "Aviso 9", html: true, status: "queued" });
    expect(stored.json.body).toContain("lunes");
    expect((await call("POST", "/messages", { channel: "email", to: "a@example.com", templateKey: "nope" })).json.code).toBe("template_not_found");
    expect((await call("POST", "/messages", { channel: "sms", to: "+34600" })).status).toBe(400);

    expect((await call("POST", `/messages/${sms.json.id}/retry`)).status).toBe(409);
    expect((await call("POST", `/messages/${sms.json.id}/cancel`)).status).toBe(200);
    expect((await call("POST", `/messages/${sms.json.id}/retry`)).status).toBe(200);
    const list = await call("GET", "/messages?status=queued", undefined, "viewer");
    expect(list.json.items).toHaveLength(3);
    expect(list.json.stats).toEqual({ queued: 3 });
    expect((await call("POST", "/messages", { channel: "sms", to: "+1", body: "x" }, "viewer")).status).toBe(403);
  });

  it("withdrawing consent cancels the customer's queued messages and is recorded", async () => {
    const customer = (await pool.query("INSERT INTO customers (name, consent_comms) VALUES ('Cliente RGPD', true) RETURNING id")).rows[0].id;
    await call("POST", "/messages", { channel: "sms", to: "+34600999000", body: "hola", entityType: "customer", entityId: customer });
    expect((await call("POST", `/customers/${customer}/consent`, { granted: false, source: "portal" })).status).toBe(200);
    expect((await pool.query("SELECT status, error FROM messages WHERE entity_id = $1", [customer])).rows[0]).toEqual({ status: "failed", error: "consent withdrawn" });
    const history = await call("GET", `/customers/${customer}/consents`);
    expect(history.json.items[0]).toMatchObject({ granted: false, source: "portal" });
  });

  it("works queues and tasks: SLA from the queue, claiming, attachments", async () => {
    const sla = await call("POST", "/sla-policies", { code: "S4", name: "4 horas", target_hours: 4 });
    expect(sla.status).toBe(201);
    const queue = await call("POST", "/queues", { key: "validaciones", name: "Validaciones", sla_policy_id: sla.json.id });
    expect(queue.status).toBe(201);
    const task = await call("POST", "/tasks", { title: "Revisar certificado", queue_id: queue.json.id, priority: "high" });
    expect(task.status).toBe(201);
    expect(new Date(task.json.sla_due_at).getTime() - Date.now()).toBeGreaterThan(3.9 * 3_600_000);
    expect((await call("POST", `/tasks/${task.json.id}/claim`)).status).toBe(200);
    expect((await call("GET", "/tasks?assignee=me")).json.total).toBe(1);

    const att = await upload(`/tasks/${task.json.id}/attachments`, "evidencia.pdf", "%PDF-1.4");
    expect(att.status).toBe(201);
    const detail = await call("GET", `/tasks/${task.json.id}`);
    expect(detail.json.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(["created", "claimed", "attachment"]));
    expect((await upload(`/tasks/${crypto.randomUUID()}/attachments`, "x.pdf", "x")).status).toBe(404);
  });
});
