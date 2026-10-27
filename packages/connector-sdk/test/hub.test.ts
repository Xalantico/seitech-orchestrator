// Needs a throw-away Postgres superuser URL:  TEST_DATABASE_URL=postgres://...@127.0.0.1:5437/postgres pnpm --filter @orchestrador/connector-sdk test
import { createPool, migrate, seedBase } from "@orchestrador/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  callNow, closeIntegrationError, enqueueOutbound, loadPublishedMapping, mapWith, processInbox, receiveInbound, registerBuiltinAdapters, resetMockAdapter, retryIntegrationError, runDueSyncs,
  runOutbox, runSync, upsertEntity, type HubDeps,
} from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("integration hub", () => {
  const dbName = `orq_hub_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let deps: HubDeps;
  const now = () => new Date("2026-03-01T10:00:00Z");

  beforeAll(async () => {
    registerBuiltinAdapters();
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: `orq_hub_${Date.now()}`, password: "x" } });
    pool = createPool(base.toString());
    await seedBase(pool as never);
    deps = { db: pool, log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, readSecret: async () => ({}), piiKey: "test-pii-key-123456", now };
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  beforeEach(async () => {
    resetMockAdapter();
    await pool.query("DELETE FROM integration_errors; DELETE FROM outbox_events; DELETE FROM inbox_events; DELETE FROM sync_runs; DELETE FROM connectors; DELETE FROM tasks WHERE source = 'integration'");
    await pool.query("INSERT INTO connectors (key, name, system_kind, mode) VALUES ('m1', 'Mock 1', 'mock', 'mock')");
  });

  const q = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<R & Record<string, unknown>>(sql, params).then((r) => r.rows);
  const makeDue = () => pool.query("UPDATE outbox_events SET next_attempt_at = now() WHERE status = 'failed'");

  describe("outbox", () => {
    it("is idempotent per key and sends once", async () => {
      const a = await enqueueOutbound(pool, { connectorKey: "m1", action: "echo", payload: { value: "a" }, idempotencyKey: "k-1" });
      const b = await enqueueOutbound(pool, { connectorKey: "m1", action: "echo", payload: { value: "a" }, idempotencyKey: "k-1" });
      expect(b).toEqual({ id: a.id, duplicate: true });
      expect(await runOutbox(deps)).toBe(1);
      expect(await runOutbox(deps)).toBe(0);
      const [row] = await q("SELECT status, attempts, response FROM outbox_events WHERE id = $1", [a.id]);
      expect(row).toMatchObject({ status: "sent", attempts: 1, response: { echoed: { value: "a" }, idempotencyKey: "k-1" } });
    });

    it("records the remote id in external_refs", async () => {
      const wo = (await q<{ id: string }>("INSERT INTO orders (source) VALUES ('t') RETURNING id"))[0]!.id;
      await enqueueOutbound(pool, { connectorKey: "m1", action: "echo", payload: { value: "ord" }, entityType: "order", entityId: wo });
      await runOutbox(deps);
      expect(await q("SELECT external_id FROM external_refs WHERE entity_id = $1 AND connector_key = 'm1'", [wo])).toEqual([{ external_id: "mock-ord" }]);
    });

    it("retries transient failures with backoff and succeeds without a task", async () => {
      const { id } = await enqueueOutbound(pool, { connectorKey: "m1", action: "flaky", payload: { failures: 2, tag: "t1" } });
      await runOutbox(deps);
      let [row] = await q("SELECT status, attempts, last_error, next_attempt_at > now() AS later FROM outbox_events WHERE id = $1", [id]);
      expect(row).toMatchObject({ status: "failed", attempts: 1, later: true });
      expect(row!.last_error).toContain("unavailable");
      expect(await runOutbox(deps)).toBe(0); // not due yet
      await makeDue();
      await runOutbox(deps);
      await makeDue();
      await runOutbox(deps);
      [row] = await q("SELECT status, attempts FROM outbox_events WHERE id = $1", [id]);
      expect(row).toMatchObject({ status: "sent", attempts: 3 });
      expect(await q("SELECT 1 FROM integration_errors")).toHaveLength(0);
    });

    it("dead-letters permanent failures into the error panel with a back-office task, and retry re-queues", async () => {
      const { id } = await enqueueOutbound(pool, { connectorKey: "m1", action: "reject", payload: {}, correlationId: "OT-9" });
      await runOutbox(deps);
      const [out] = await q("SELECT status, attempts FROM outbox_events WHERE id = $1", [id]);
      expect(out).toMatchObject({ status: "dead", attempts: 1 });
      const [err] = await q<{ id: string; task_id: string }>("SELECT id, task_id, direction, action, error_code, resolved, correlation_id FROM integration_errors WHERE outbox_id = $1", [id]);
      expect(err).toMatchObject({ direction: "outbound", action: "reject", error_code: "remote_rejected", resolved: false, correlation_id: "OT-9" });
      const [task] = await q("SELECT t.source, t.kind, t.priority, q.key AS queue, t.available_actions FROM tasks t JOIN queues q ON q.id = t.queue_id WHERE t.id = $1", [err!.task_id]);
      expect(task).toMatchObject({ source: "integration", kind: "integration_error", priority: "high", queue: "integraciones" });
      expect(JSON.stringify(task!.available_actions)).toContain("retry");

      // Failing again must not pile up a second task.
      expect(await retryIntegrationError(pool, err!.id)).toBe("outbox");
      await runOutbox(deps);
      expect(await q("SELECT 1 FROM tasks WHERE source = 'integration'")).toHaveLength(2); // the resolved first task + one new task for the new error row
      const [resolved] = await q("SELECT resolved, resolution FROM integration_errors WHERE id = $1", [err!.id]);
      expect(resolved).toMatchObject({ resolved: true });
      const [oldTask] = await q("SELECT status FROM tasks WHERE id = $1", [err!.task_id]);
      expect(oldTask!.status).toBe("resolved");
    });

    it("gives up after max attempts", async () => {
      const { id } = await enqueueOutbound(pool, { connectorKey: "m1", action: "flaky", payload: { failures: 99, tag: "t2" }, maxAttempts: 2 });
      await runOutbox(deps);
      await makeDue();
      await runOutbox(deps);
      expect((await q("SELECT status, attempts FROM outbox_events WHERE id = $1", [id]))[0]).toMatchObject({ status: "dead", attempts: 2 });
      expect(await q("SELECT 1 FROM integration_errors WHERE outbox_id = $1", [id])).toHaveLength(1);
    });

    it("recovers rows whose worker died mid-send (lease expired) and parks calls to disabled connectors", async () => {
      const { id } = await enqueueOutbound(pool, { connectorKey: "m1", action: "echo", payload: { value: "z" } });
      await pool.query("UPDATE outbox_events SET status = 'sending', locked_until = now() - interval '1 minute' WHERE id = $1", [id]);
      await runOutbox(deps);
      expect((await q("SELECT status FROM outbox_events WHERE id = $1", [id]))[0]!.status).toBe("sent");

      await pool.query("UPDATE connectors SET enabled = false WHERE key = 'm1'");
      const parked = await enqueueOutbound(pool, { connectorKey: "m1", action: "echo", payload: { value: "p" } });
      await runOutbox(deps);
      expect((await q("SELECT status, attempts FROM outbox_events WHERE id = $1", [parked.id]))[0]).toMatchObject({ status: "pending", attempts: 0 });
      expect(await q("SELECT 1 FROM integration_errors")).toHaveLength(0);
    });

    it("does not process the same row twice when two workers run at once", async () => {
      for (let i = 0; i < 30; i++) await enqueueOutbound(pool, { connectorKey: "m1", action: "echo", payload: { value: `v${i}` } });
      const [a, b] = await Promise.all([runOutbox(deps, 20), runOutbox(deps, 20)]);
      expect(a + b).toBe(30);
      expect((await q("SELECT count(*)::int AS n FROM outbox_events WHERE status = 'sent' AND attempts = 1"))[0]!.n).toBe(30);
    });

    it("callNow is synchronous, traceable and replays a completed call", async () => {
      const first = await callNow(deps, { connectorKey: "m1", action: "echo", input: { value: "s" }, idempotencyKey: "sync-1", correlationId: "OT-1" });
      expect(first).toMatchObject({ replayed: false, externalId: "mock-s" });
      const again = await callNow(deps, { connectorKey: "m1", action: "echo", input: { value: "s" }, idempotencyKey: "sync-1" });
      expect(again).toMatchObject({ replayed: true, outboxId: first.outboxId });
      await expect(callNow(deps, { connectorKey: "m1", action: "reject", input: {}, idempotencyKey: "sync-2" })).rejects.toMatchObject({ code: "remote_rejected", retryable: false });
      expect((await q("SELECT status FROM outbox_events WHERE idempotency_key = 'sync-2'"))[0]!.status).toBe("failed");
      await expect(callNow(deps, { connectorKey: "m1", action: "nope", input: {} })).rejects.toMatchObject({ code: "action_unknown" });
      await expect(callNow(deps, { connectorKey: "m1", action: "flaky", input: { failures: 1, tag: "sync-flaky" } })).rejects.toMatchObject({ retryable: true });
    });
  });

  describe("inbox", () => {
    it("stores a webhook once (idempotent), redacts secrets and processes it", async () => {
      const input = { connectorKey: "m1", eventId: "evt-1", eventType: "ping", payload: { n: 1 }, headers: { "x-orq-signature": "sha256=abc", "x-request-id": "r1", authorization: "Bearer zzz" } };
      const a = await receiveInbound(pool, input);
      const b = await receiveInbound(pool, input);
      expect(a.duplicate).toBe(false);
      expect(b).toEqual({ id: a.id, duplicate: true });
      const [stored] = await q("SELECT headers FROM inbox_events WHERE id = $1", [a.id]);
      expect(stored!.headers).toEqual({ "x-orq-signature": "[redacted]", "x-request-id": "r1", authorization: "[redacted]" });
      expect(await processInbox(deps)).toBe(1);
      expect((await q("SELECT status, outcome FROM inbox_events WHERE id = $1", [a.id]))[0]).toMatchObject({ status: "processed", outcome: 'ping {"n":1}' });
      expect(await q("SELECT payload FROM domain_events WHERE type = 'int.m1.ping'")).toHaveLength(1);
    });

    it("ignores events nobody handles and sends failures to the error panel", async () => {
      const ignored = await receiveInbound(pool, { connectorKey: "m1", eventId: "e2", eventType: "unknown", payload: {} });
      const bad = await receiveInbound(pool, { connectorKey: "m1", eventId: "e3", eventType: "boom", payload: { x: 1 } });
      await processInbox(deps);
      expect((await q("SELECT status FROM inbox_events WHERE id = $1", [ignored.id]))[0]!.status).toBe("ignored");
      expect((await q("SELECT status, error FROM inbox_events WHERE id = $1", [bad.id]))[0]).toMatchObject({ status: "failed", error: "The handler refused this event" });
      const [err] = await q("SELECT direction, action, error_code FROM integration_errors WHERE inbox_id = $1", [bad.id]);
      expect(err).toMatchObject({ direction: "inbound", action: "boom", error_code: "handler_failed" });
      // Replay from the panel.
      const errId = (await q<{ id: string }>("SELECT id FROM integration_errors WHERE inbox_id = $1", [bad.id]))[0]!.id;
      expect(await retryIntegrationError(pool, errId)).toBe("inbox");
      expect((await q("SELECT status, attempts FROM inbox_events WHERE id = $1", [bad.id]))[0]).toMatchObject({ status: "received", attempts: 0 });
    });

    it("creates the order, customer and site from a published mapping, once, and keeps open fields in extra", async () => {
      const mapping = (await q<{ id: string }>("INSERT INTO mapping_registry (key, connector_key, entity, direction) VALUES ('hubspot.deal.in', 'm1', 'order', 'inbound') RETURNING id"))[0]!.id;
      await pool.query(
        "INSERT INTO mapping_versions (mapping_id, version, state, fields) VALUES ($1, 1, 'published', $2::jsonb)",
        [mapping, JSON.stringify([
          { source: "deal.id", target: "external_id", transform: "string", required: true },
          { source: "deal.service", target: "service_code", transform: "upper" },
          { source: "deal.amount", target: "amount", transform: "number" },
          { source: "company.id", target: "customer.external_id", transform: "string" },
          { source: "company.name", target: "customer.name" },
          { source: "company.email", target: "customer.email", transform: "email" },
          { source: "company.consent", target: "customer.consent_comms", transform: "boolean" },
          { source: "site.id", target: "site.external_id", transform: "string" },
          { source: "site.name", target: "site.name" },
          { source: "site.city", target: "site.municipality" },
        ])],
      );
      await pool.query("UPDATE connectors SET config = $1::jsonb WHERE key = 'm1'", [JSON.stringify({ inbound: { "deal.won": { mapping: "hubspot.deal.in", entity: "order" } } })]);
      const payload = { deal: { id: 555, service: "insp-per", amount: "320.50" }, company: { id: "C1", name: "Comunidad Mar", email: "adm@mar.es", consent: "yes" }, site: { id: "S1", name: "Edificio Mar", city: "Valencia" }, pipeline_stage: "won" };

      await receiveInbound(pool, { connectorKey: "m1", eventId: "deal-555", eventType: "deal.won", payload });
      await processInbox(deps);
      const orders = await q("SELECT o.id, o.external_ref, o.service_code, o.amount::float AS amount, o.source, o.extra, c.name, c.consent_comms, pgp_sym_decrypt(c.email_enc, 'test-pii-key-123456') AS email, s.name AS site, s.municipality FROM orders o JOIN customers c ON c.id = o.customer_id JOIN sites s ON s.id = o.site_id WHERE o.external_ref = '555'");
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ service_code: "INSP-PER", amount: 320.5, source: "m1", name: "Comunidad Mar", consent_comms: true, email: "adm@mar.es", site: "Edificio Mar", municipality: "Valencia" });
      expect(orders[0]!.extra).toEqual({ pipeline_stage: "won" });
      expect(await q("SELECT type FROM domain_events WHERE entity_type = 'order'")).toEqual([{ type: "order.received" }]);

      // A changed redelivery with a new event id updates instead of duplicating.
      await receiveInbound(pool, { connectorKey: "m1", eventId: "deal-555-v2", eventType: "deal.won", payload: { ...payload, deal: { ...payload.deal, amount: "400" } } });
      await processInbox(deps);
      expect(await q("SELECT amount::float AS amount FROM orders WHERE external_ref = '555'")).toEqual([{ amount: 400 }]);
      expect(await q("SELECT 1 FROM customers WHERE name = 'Comunidad Mar'")).toHaveLength(1);
      expect(await q("SELECT 1 FROM domain_events WHERE type = 'order.received'")).toHaveLength(1);
    });

    it("a mapping with errors is a permanent failure that names the field", async () => {
      const mapping = (await q<{ id: string }>("INSERT INTO mapping_registry (key, connector_key, entity, direction) VALUES ('bad.in', 'm1', 'order', 'inbound') RETURNING id"))[0]!.id;
      await pool.query("INSERT INTO mapping_versions (mapping_id, version, state, fields) VALUES ($1, 1, 'published', $2::jsonb)", [mapping, JSON.stringify([{ source: "id", target: "external_id", required: true }])]);
      await pool.query("UPDATE connectors SET config = $1::jsonb WHERE key = 'm1'", [JSON.stringify({ inbound: { x: { mapping: "bad.in", entity: "order" } } })]);
      const e = await receiveInbound(pool, { connectorKey: "m1", eventId: "bad-1", eventType: "x", payload: {} });
      await processInbox(deps);
      const [row] = await q("SELECT status, attempts, error FROM inbox_events WHERE id = $1", [e.id]);
      expect(row).toMatchObject({ status: "failed", attempts: 1 });
      expect(row!.error).toContain("external_id: Required value is missing");
    });
  });

  describe("mappings registry", () => {
    it("loads only the published version and refuses an unpublished mapping", async () => {
      const id = (await q<{ id: string }>("INSERT INTO mapping_registry (key, connector_key, entity, direction) VALUES ('v.test', 'm1', 'customer', 'inbound') RETURNING id"))[0]!.id;
      await pool.query("INSERT INTO mapping_versions (mapping_id, version, state, fields) VALUES ($1, 1, 'draft', '[]'::jsonb)", [id]);
      await expect(loadPublishedMapping(pool, "v.test")).rejects.toMatchObject({ code: "mapping_not_published" });
      await pool.query("INSERT INTO mapping_versions (mapping_id, version, state, fields) VALUES ($1, 2, 'published', $2::jsonb)", [id, JSON.stringify([{ source: "n", target: "name" }])]);
      expect((await mapWith(pool, "v.test", { n: "Ana" })).output).toEqual({ name: "Ana" });
      await expect(pool.query("INSERT INTO mapping_versions (mapping_id, version, state, fields) VALUES ($1, 3, 'published', '[]'::jsonb)", [id])).rejects.toThrow(/mapping_versions_one_published/);
    });
  });

  describe("entities", () => {
    it("upserts technicians and qualifications, computes the qualification status and announces unavailability", async () => {
      const tech = await upsertEntity(pool, "technician", { code: "T-01", name: "Luis Gil", email: "luis@seitech.es" }, { connectorKey: "m1", externalId: "N-77" });
      expect(tech.created).toBe(true);
      const same = await upsertEntity(pool, "technician", { name: "Luis Gil G." }, { connectorKey: "m1", externalId: "N-77" });
      expect(same).toMatchObject({ id: tech.id, created: false });
      const q1 = await upsertEntity(pool, "qualification", { technician_external_id: "N-77", kind: "REBT", reference: "IBTE-1", valid_to: "2026-03-20" }, { connectorKey: "m1", now: now(), qualificationAlertDays: 30 });
      expect((await q("SELECT status FROM qualifications WHERE id = $1", [q1.id]))[0]!.status).toBe("expiring");
      await upsertEntity(pool, "qualification", { technician_code: "T-01", kind: "REBT", reference: "IBTE-1", valid_to: "2027-03-20" }, { connectorKey: "m1", now: now() });
      expect(await q("SELECT status FROM qualifications WHERE technician_id = $1", [tech.id])).toEqual([{ status: "valid" }]);
      await expect(upsertEntity(pool, "qualification", { technician_code: "NOPE", kind: "X" }, { connectorKey: "m1" })).rejects.toMatchObject({ code: "technician_not_found" });
      const off = await upsertEntity(pool, "technician", { active: false, name: "Luis Gil G." }, { connectorKey: "m1", externalId: "N-77" });
      expect(off.events.map((e) => e.type)).toEqual(["technician.unavailable"]);
    });

    it("refuses to store customer PII without an encryption key", async () => {
      await expect(upsertEntity(pool, "customer", { name: "X", email: "x@y.es" }, { connectorKey: "m1" })).rejects.toMatchObject({ code: "pii_key_missing" });
    });
  });

  describe("synchronisation", () => {
    it("records runs, stores the cursor and reports failures to the panel", async () => {
      const ok = await runSync(deps, "m1", { full: true, trigger: "manual" });
      expect(ok).toMatchObject({ status: "succeeded", stats: { pulled: 10 } });
      expect((await q("SELECT value FROM connector_state WHERE connector_key = 'm1'"))[0]!.value).toBe("1970-01-01T00:00:00.000Z");
      await pool.query("UPDATE connectors SET system_kind = 'generic-http' WHERE key = 'm1'");
      const bad = await runSync(deps, "m1");
      expect(bad.status).toBe("failed");
      expect((await q("SELECT direction, error_code FROM integration_errors"))[0]).toMatchObject({ direction: "sync", error_code: "sync_unsupported" });
      expect((await q("SELECT last_status FROM connectors WHERE key = 'm1'"))[0]).toEqual({ last_status: "error" });
    });

    it("starts a scheduled sync once per cron slot", async () => {
      await pool.query("UPDATE connectors SET config = $1::jsonb WHERE key = 'm1'", [JSON.stringify({ sync: { cron: "0 3 * * *", timezone: "UTC", full: true } })]);
      const at = new Date("2026-03-02T03:05:00Z");
      expect(await runDueSyncs(deps, at)).toBe(1);
      expect(await runDueSyncs(deps, new Date("2026-03-02T03:30:00Z"))).toBe(0);
      expect((await q("SELECT kind, trigger, status FROM sync_runs"))[0]).toMatchObject({ kind: "full", trigger: "schedule", status: "succeeded" });
    });
  });

  it("closeIntegrationError resolves the task too", async () => {
    await enqueueOutbound(pool, { connectorKey: "m1", action: "reject", payload: {} });
    await runOutbox(deps);
    const [e] = await q<{ id: string; task_id: string }>("SELECT id, task_id FROM integration_errors");
    expect(await closeIntegrationError(pool, e!.id, "Resuelto a mano en el ERP")).toBe(true);
    expect(await closeIntegrationError(pool, e!.id, "otra vez")).toBe(false);
    expect((await q("SELECT status FROM tasks WHERE id = $1", [e!.task_id]))[0]!.status).toBe("resolved");
  });
});
