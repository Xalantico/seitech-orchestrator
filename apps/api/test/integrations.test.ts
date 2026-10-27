// API integration for the integration hub: signed webhooks, connectors, mapping versions, errors panel (real Postgres).
import { OpenAPIHono } from "@hono/zod-openapi";
import { enqueueOutbound, processInbox, registerBuiltinAdapters, runOutbox, signPayload, type HubDeps } from "@orchestrador/connector-sdk";
import { migrate } from "@orchestrador/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/documents.js", () => ({
  saveDocument: async (_db: unknown, doc: { filename: string }) => ({ id: crypto.randomUUID(), filename: doc.filename }),
  readDocument: async () => { throw new Error("not used"); },
}));

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("integration hub API", () => {
  const dbName = `orq_hub_api_${Date.now()}`;
  const SECRET = "whsec_test_secret_value";
  let admin: pg.Client;
  let pool: pg.Pool;
  let app: OpenAPIHono;
  let deps: HubDeps;
  const users: Record<string, string> = {};
  const perms: Record<string, string[]> = {
    admin: ["connectors:read", "connectors:write", "connectors:sync", "mappings:read", "mappings:write", "integration_errors:read", "integration_errors:resolve", "tasks:read", "tasks:act"],
    viewer: ["connectors:read", "mappings:read", "integration_errors:read"],
  };

  beforeAll(async () => {
    registerBuiltinAdapters();
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: `orq_ha_${Date.now()}`, password: "x" } });
    process.env.DATABASE_URL = base.toString();
    process.env.APP_ENV = "test";
    process.env.SECRET__CONNECTORS_MOCK1__SECRET = SECRET;
    pool = new pg.Pool({ connectionString: base.toString() });
    deps = { db: pool as never, log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never, readSecret: async (ref) => (ref === "connectors/mock1" ? { secret: SECRET } : {}), piiKey: "test-key-test-key-1" };
    for (const name of Object.keys(perms)) users[name] = (await pool.query("INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id", [`${name}@example.com`, name])).rows[0].id;
    const { integrations } = await import("../src/modules/integrations.js");
    const { tasks } = await import("../src/modules/tasks.js");
    const { handleError } = await import("../src/middleware/core.js");
    app = new OpenAPIHono();
    app.use("*", async (c, next) => {
      const who = c.req.header("x-user") ?? "admin";
      c.set("principal" as never, { kind: "user", id: users[who], label: who, roles: [who], permissions: new Set(perms[who]), scopeAll: true, scopes: [], mfa: true, locale: "es" } as never);
      await next();
    });
    for (const m of [integrations, tasks]) app.route("/", m);
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
  async function webhook(connector: string, payload: unknown, opts: { secret?: string; eventId?: string; type?: string; ts?: number; omitSignature?: boolean } = {}) {
    const body = JSON.stringify(payload);
    const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = { "content-type": "application/json", "x-event-id": opts.eventId ?? crypto.randomUUID(), "x-event-type": opts.type ?? "ping", "x-orq-timestamp": ts };
    if (!opts.omitSignature) headers["x-orq-signature"] = signPayload(opts.secret ?? SECRET, ts, body);
    const res = await app.request(`/webhooks/${connector}`, { method: "POST", headers, body });
    return { status: res.status, json: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  it("manages connectors and lists the adapters", async () => {
    const adapters = await call("GET", "/integrations/adapters");
    expect(adapters.json.items.map((a: { kind: string }) => a.kind)).toEqual(expect.arrayContaining(["generic-http", "mock"]));
    const created = await call("POST", "/connectors", { key: "mock1", name: "Mock 1", system_kind: "mock", mode: "mock", webhook_secret_ref: "connectors/mock1" });
    expect(created.status).toBe(201);
    expect((await call("POST", "/connectors", { key: "mock1", name: "dup", system_kind: "mock" })).status).toBe(409);
    expect((await call("POST", "/connectors", { key: "x", name: "x", system_kind: "mock" }, "viewer")).status).toBe(403);
    expect((await call("POST", "/connectors/mock1/test")).json).toMatchObject({ ok: true });
    expect((await call("POST", "/connectors/ghost/test")).status).toBe(404);
  });

  it("accepts only correctly signed, fresh webhooks and stores them once", async () => {
    const ok = await webhook("mock1", { hello: "world" }, { eventId: "evt-1" });
    expect(ok.status).toBe(202);
    const dup = await webhook("mock1", { hello: "world" }, { eventId: "evt-1" });
    expect(dup.status).toBe(200);
    expect(dup.json).toMatchObject({ duplicate: true, id: ok.json.id });
    expect((await webhook("mock1", { a: 1 }, { secret: "wrong-secret" })).status).toBe(401);
    expect((await webhook("mock1", { a: 1 }, { omitSignature: true })).status).toBe(401);
    expect((await webhook("mock1", { a: 1 }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await webhook("ghost", { a: 1 })).status).toBe(401);
    await call("PATCH", "/connectors/" + (await pool.query("SELECT id FROM connectors WHERE key = 'mock1'")).rows[0].id, { enabled: false });
    expect((await webhook("mock1", { a: 1 })).status).toBe(401);
    await call("PATCH", "/connectors/" + (await pool.query("SELECT id FROM connectors WHERE key = 'mock1'")).rows[0].id, { enabled: true });

    await processInbox(deps, 10);
    const inbox = await call("GET", "/integrations/inbox?connector_key=mock1");
    expect(inbox.json.items).toHaveLength(1);
    expect(inbox.json.items[0]).toMatchObject({ event_id: "evt-1", status: "processed" });
  });

  it("versions mappings: draft, validate, publish, dry-run and diff", async () => {
    expect((await call("POST", "/mappings", { key: "mock1.order", connector_key: "mock1", entity: "bogus", direction: "inbound" })).status).toBe(422);
    expect((await call("POST", "/mappings", { key: "mock1.order", connector_key: "mock1", entity: "order", direction: "inbound" })).status).toBe(201);
    expect((await call("POST", "/mappings", { key: "mock1.order", connector_key: "mock1", entity: "order", direction: "inbound" })).status).toBe(409);

    const v1 = await call("POST", "/mappings/mock1.order/versions", { fields: [{ source: "ref", target: "externalRef", transform: "trim", required: true }, { source: "cust.name", target: "customer.name" }], change_note: "first" });
    expect(v1.status).toBe(201);
    expect(v1.json).toMatchObject({ version: 1, problems: [] });
    expect((await call("POST", "/mappings/mock1.order/versions/1/publish")).status).toBe(200);
    expect((await call("POST", "/mappings/mock1.order/versions/1/publish")).status).toBe(409);
    expect((await call("PUT", "/mappings/mock1.order/versions/1", { fields: [] })).status).toBe(409);

    const bad = await call("POST", "/mappings/mock1.order/versions", { fields: [{ source: "a", target: "x" }, { source: "b", target: "x" }, { source: "c", target: "y", transform: "lookup" }] });
    expect(bad.json.problems.length).toBeGreaterThan(0);
    expect((await call("POST", "/mappings/mock1.order/versions/2/publish")).status).toBe(422);
    expect((await call("PUT", "/mappings/mock1.order/versions/2", { fields: [{ source: "ref", target: "externalRef", transform: "upper", required: true }, { source: "cust.name", target: "customer.name" }, { source: "po", target: "poNumber" }] })).json.problems).toEqual([]);

    const test = await call("POST", "/mappings/mock1.order/test", { version: 2, source: { ref: "ab1", cust: { name: "ACME" }, po: "P-9" } });
    expect(test.json.output).toMatchObject({ externalRef: "AB1", customer: { name: "ACME" }, poNumber: "P-9" });
    expect((await call("POST", "/mappings/mock1.order/test", { source: {} })).json.errors).toHaveLength(1);

    expect((await call("POST", "/mappings/mock1.order/versions/2/publish")).status).toBe(200);
    const detail = await call("GET", "/mappings/mock1.order");
    expect(detail.json.versions.map((v: { version: number; state: string }) => `${v.version}:${v.state}`)).toEqual(["2:published", "1:retired"]);
    const diff = await call("GET", "/mappings/mock1.order/diff?from=1&to=2");
    expect(JSON.stringify(diff.json)).toContain("poNumber");
    expect((await call("GET", "/mappings")).json.items[0]).toMatchObject({ published_version: 2, latest_version: 2 });
    expect((await call("POST", "/mappings", { key: "z", connector_key: "mock1", entity: "order", direction: "inbound" }, "viewer")).status).toBe(403);
  });

  it("invokes actions through the outbox and shows failures in the error panel, with retry from the task", async () => {
    const sync = await call("POST", "/connectors/mock1/invoke", { action: "echo", input: { value: "x" }, mode: "sync", idempotencyKey: "k-1" });
    expect(sync.status).toBe(202);
    expect(sync.json).toMatchObject({ queued: false, replayed: false });
    expect((await call("POST", "/connectors/mock1/invoke", { action: "echo", input: { value: "x" }, mode: "sync", idempotencyKey: "k-1" })).json.replayed).toBe(true);
    expect((await call("POST", "/connectors/mock1/invoke", { action: "reject", input: {}, mode: "sync" })).status).toBe(422);

    const queued = await call("POST", "/connectors/mock1/invoke", { action: "reject", input: {}, mode: "async", idempotencyKey: "k-reject" });
    expect(queued.json.queued).toBe(true);
    await runOutbox(deps, 10);
    const outbox = await call("GET", "/integrations/outbox?status=dead&connector_key=mock1");
    expect(outbox.json.items.map((o: { action: string }) => o.action)).toContain("reject");

    const errors = await call("GET", "/integration-errors?connector_key=mock1");
    const reject = errors.json.items.find((e: { error_code: string; outbox_id: string }) => e.error_code === "remote_rejected" && e.outbox_id === queued.json.id);
    expect(reject).toBeTruthy();
    const task = (await pool.query("SELECT id, kind, status FROM tasks WHERE id = $1", [reject.task_id])).rows[0];
    expect(task).toMatchObject({ kind: "integration_error", status: "open" });

    // Retry from the back-office task: the same call is queued again (and fails again, as the mock always rejects).
    const retried = await call("POST", `/tasks/${task.id}/actions`, { action: "retry" });
    expect(retried.status).toBe(200);
    expect(retried.json.requeued).toBe("outbox");
    expect((await call("POST", `/tasks/${task.id}/actions`, { action: "retry" })).status).toBe(409);
    expect((await pool.query("SELECT status FROM outbox_events WHERE id = $1", [queued.json.id])).rows[0].status).toBe("pending");
    expect((await call("GET", "/integration-errors/" + reject.id)).json.resolved).toBe(true);

    // Manual resolution of another error.
    await runOutbox(deps, 10);
    const second = (await call("GET", "/integration-errors?connector_key=mock1")).json.items[0];
    expect((await call("POST", `/integration-errors/${second.id}/resolve`, { note: "handled by phone" }, "viewer")).status).toBe(403);
    expect((await call("POST", `/integration-errors/${second.id}/resolve`, { note: "handled by phone" })).status).toBe(200);
    expect((await call("POST", `/integration-errors/${second.id}/resolve`, { note: "again" })).status).toBe(409);
  });

  it("retries and cancels outbox rows, replays inbox events, reports health and syncs", async () => {
    const q = await enqueueOutbound(pool as never, { connectorKey: "mock1", action: "flaky", payload: { failures: 99, tag: "t" }, idempotencyKey: "k-flaky" });
    expect((await call("POST", `/integrations/outbox/${q.id}/cancel`)).status).toBe(200);
    expect((await call("POST", `/integrations/outbox/${q.id}/cancel`)).status).toBe(409);
    expect((await call("POST", `/integrations/outbox/${q.id}/retry`)).status).toBe(200);
    expect((await call("POST", `/integrations/outbox/${q.id}/retry`)).status).toBe(409);

    const inboxId = (await call("GET", "/integrations/inbox?connector_key=mock1")).json.items[0].id;
    expect((await call("POST", `/integrations/inbox/${inboxId}/replay`)).status).toBe(200);
    expect((await call("GET", `/integrations/inbox/${inboxId}`)).status).toBe(200);
    expect((await call("GET", `/integrations/inbox/${inboxId}`, undefined, "viewer")).status).toBe(403);

    const health = (await call("GET", "/integrations/health")).json.items.find((h: { key: string }) => h.key === "mock1");
    expect(health).toMatchObject({ enabled: true });
    expect(health.outbox_backlog).toBeGreaterThanOrEqual(1);

    expect((await call("POST", "/connectors/mock1/sync", { full: true })).status).toBe(202);
    await vi.waitFor(async () => {
      const runs = (await call("GET", "/integrations/syncs?connector_key=mock1")).json.items;
      expect(runs[0]).toMatchObject({ status: "succeeded", kind: "full", trigger: "manual" });
    }, { timeout: 5000 });
  });
});
