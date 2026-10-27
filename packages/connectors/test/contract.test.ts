// Contract tests: every adapter against its simulator, over real HTTP, with a real Postgres.
//   TEST_DATABASE_URL=postgres://...@127.0.0.1:5437/postgres pnpm --filter @orchestrador/connectors test
import { buildContext, callNow, ConnectorError, getAdapter, loadConnector, processInbox, receiveInbound, runOutbox, runSync, enqueueOutbound, type DocumentGateway, type HubDeps, type ObjectGateway, type StoredDocument } from "@orchestrador/connector-sdk";
import { createPool, migrate, seedBase } from "@orchestrador/db";
import { createMockSystems } from "@orchestrador/mock-systems";
import { listen } from "@orchestrador/mock-systems/listen";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanPath, parseFilename, registerAllAdapters, renderPattern, seedConnectors, setSqlDriverFactory, type SqlDriver } from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("connector contracts", () => {
  const dbName = `orq_conn_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let deps: HubDeps;
  let mocks: ReturnType<typeof createMockSystems>;
  let server: { url: string; close: () => Promise<void> };
  const docs = new Map<string, StoredDocument & { previousVersionId?: string | null; dmsRef?: string | null }>();
  const objects = new Map<string, { data: Buffer; mime: string; metadata: Record<string, string> }>();

  const documents: DocumentGateway = {
    async read(id) {
      const d = docs.get(id);
      if (!d) throw new Error(`document ${id} not found`);
      return d;
    },
    async save(doc) {
      const id = randomUUID();
      docs.set(id, { id, filename: doc.filename, mime: doc.mime ?? "application/octet-stream", data: doc.data, kind: doc.kind ?? "attachment", entityType: doc.entityType ?? null, entityId: doc.entityId ?? null, metadata: doc.metadata ?? {}, signed: doc.signed ?? false, previousVersionId: doc.previousVersionId ?? null, dmsRef: doc.dmsRef ?? null });
      await pool.query("INSERT INTO documents (id, bucket, object_key, filename, kind, entity_type, entity_id, signed, metadata, previous_version_id) VALUES ($1, 'test', $2, $3, $4, $5, $6, $7, $8::jsonb, $9)", [id, `${id}/${doc.filename}`, doc.filename, doc.kind ?? "attachment", doc.entityType ?? null, doc.entityId ?? null, doc.signed ?? false, JSON.stringify(doc.metadata ?? {}), doc.previousVersionId ?? null]);
      return { id, filename: doc.filename };
    },
  };
  const objectGateway: ObjectGateway = {
    async put(key, data, mime, metadata = {}) { objects.set(key, { data, mime, metadata }); },
    async get(key) { return objects.get(key); },
    async remove(key) { objects.delete(key); },
    async list(prefix) { return [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, size: v.data.length, modifiedAt: new Date().toISOString() })); },
  };

  beforeAll(async () => {
    registerAllAdapters();
    mocks = createMockSystems({ token: "mock-token" });
    server = await listen(mocks);
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: `orq_conn_${Date.now()}`, password: "x" } });
    pool = createPool(base.toString());
    await seedBase(pool as never);
    await seedConnectors(pool, { baseUrl: server.url });
    deps = {
      db: pool, log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, piiKey: "test-pii-key-123456", documents, objects: objectGateway,
      readSecret: async () => ({ token: "mock-token", secret: "whsec" }),
      // The same shape the worker uses: one transaction per inbound event.
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const out = await fn(client as never);
          await client.query("COMMIT");
          return out;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
    };
  });

  afterAll(async () => {
    await pool?.end();
    await server?.close();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  beforeEach(async () => {
    mocks.requests.length = 0;
    await pool.query("DELETE FROM integration_errors; DELETE FROM outbox_events; DELETE FROM inbox_events; DELETE FROM sync_runs; DELETE FROM connector_state; DELETE FROM domain_events; DELETE FROM tasks WHERE source = 'integration'");
  });

  const q = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<R & Record<string, unknown>>(sql, params).then((r) => r.rows);
  const call = (connectorKey: string, action: string, input: Record<string, unknown>, idempotencyKey?: string) => callNow(deps, { connectorKey, action, input, ...(idempotencyKey ? { idempotencyKey } : {}) });
  /** An event arrives (the webhook endpoint stored it) and the worker handles it. */
  async function deliver(connectorKey: string, eventType: string, payload: unknown, eventId: string = randomUUID()) {
    const stored = await receiveInbound(pool, { connectorKey, eventId, eventType, payload });
    await processInbox(deps, 50);
    return (await q<{ status: string; error: string | null; outcome: string | null }>("SELECT status, error, outcome FROM inbox_events WHERE id = $1", [stored.id]))[0]!;
  }
  const events = async (type: string) => q("SELECT entity_type, entity_id, payload FROM domain_events WHERE type = $1 ORDER BY created_at", [type]);
  const failure = async (fn: () => Promise<unknown>) => fn().then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as ConnectorError);

  async function fixtureVisit(opts: { technician?: boolean; status?: string; actual?: boolean; scheduled?: boolean } = {}) {
    const suffix = randomUUID().slice(0, 6);
    const customer = (await q<{ id: string }>("INSERT INTO customers (code, name) VALUES ($1, $2) RETURNING id", [`C-${suffix}`, `Cliente ${suffix}`]))[0]!.id;
    const site = (await q<{ id: string }>("INSERT INTO sites (customer_id, name, address, autonomous_community) VALUES ($1, 'Edificio Sol', 'Calle Mayor 1', 'Madrid') RETURNING id", [customer]))[0]!.id;
    const tech = opts.technician === false ? null : (await q<{ id: string }>("INSERT INTO technicians (code, name) VALUES ($1, $2) RETURNING id", [`T-${suffix}`, `Técnico ${suffix}`]))[0]!.id;
    const wo = (await q<{ id: string; number: string }>("INSERT INTO work_orders (customer_id, site_id, inspection_type, regulation, line, area) VALUES ($1, $2, 'periodic', 'RD 203/2021', 'IND', 'ELEV') RETURNING id, number::text", [customer, site]))[0]!;
    const visit = (await q<{ id: string; number: string }>(
      `INSERT INTO visits (work_order_id, technician_id, status, scheduled_start, scheduled_end, actual_start, actual_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, number::text`,
      [wo.id, tech, opts.status ?? "scheduled", opts.scheduled === false ? null : "2026-06-01T08:00:00Z", opts.scheduled === false ? null : "2026-06-01T09:00:00Z", opts.actual ? "2026-06-01T08:05:00Z" : null, opts.actual ? "2026-06-01T09:10:00Z" : null],
    ))[0]!;
    const techCode = tech ? (await q<{ code: string }>("SELECT code FROM technicians WHERE id = $1", [tech]))[0]!.code : null;
    return { customer, site, tech, techCode, wo: wo.id, woNumber: wo.number, visit: visit.id, visitNumber: visit.number };
  }

  it("reaches every simulator: connection test passes for all adapters that have one", async () => {
    const keys = (await q<{ key: string; system_kind: string }>("SELECT key, system_kind FROM connectors ORDER BY key")).map((r) => r);
    expect(keys.length).toBe(15);
    for (const c of keys) {
      const connector = (await loadConnector(pool, c.key))!;
      const result = await getAdapter(connector.system_kind)!.ping!(await buildContext(deps, connector));
      expect({ key: c.key, ok: result.ok, detail: result.detail }).toEqual({ key: c.key, ok: true, detail: expect.any(String) });
    }
  });

  it("authentication: a wrong token is a permanent failure, not a retry storm", async () => {
    const wrong: HubDeps = { ...deps, readSecret: async () => ({ token: "nope" }) };
    const e = await failure(() => callNow(wrong, { connectorKey: "hubspot", action: "get-object", input: { objectType: "companies", id: "x" } }));
    expect(e).toMatchObject({ retryable: false, details: { status: 401 } });
  });

  describe("HubSpot (ORF-059, 060)", () => {
    it("creates and updates objects, and a retried call does not duplicate", async () => {
      const created = await call("hubspot", "upsert-object", { objectType: "companies", properties: { name: "ACME" } }, "hs-1");
      expect(created.externalId).toMatch(/^hs-companies-/);
      const again = await call("hubspot", "upsert-object", { objectType: "companies", properties: { name: "ACME" } }, "hs-1");
      expect(again).toMatchObject({ replayed: true, outboxId: created.outboxId });
      expect(mocks.requests.filter((r) => r.method === "POST" && r.path.endsWith("/objects/companies"))).toHaveLength(1);
      await call("hubspot", "upsert-object", { objectType: "companies", id: created.externalId, properties: { phone: "+34600000000" } }, "hs-2");
      const read = await call("hubspot", "get-object", { objectType: "companies", id: created.externalId });
      expect(read.output).toMatchObject({ properties: { name: "ACME", phone: "+34600000000" } });
      expect(mocks.requests.find((r) => r.method === "POST")?.idempotencyKey).toBe("hs-1");
    });

    it("validates input before calling the remote system", async () => {
      expect(await failure(() => call("hubspot", "upsert-object", { objectType: "spaceships", properties: { a: 1 } }))).toMatchObject({ code: "input_invalid", retryable: false });
      expect(mocks.requests).toHaveLength(0);
    });

    it("CRM company -> customer (mapped, open fields kept), second delivery updates instead of duplicating", async () => {
      const first = await deliver("hubspot", "company.upsert", { id: "9001", properties: { name: "  Hotel Sol ", customer_code: "HS-9001", cif: "b12345678", email: "Info@Hotel.example", sector: "hotel", delegation: "MAD" } });
      expect(first).toMatchObject({ status: "processed" });
      const [c] = await q("SELECT code, name, extra FROM customers WHERE code = 'HS-9001'");
      expect(c).toMatchObject({ name: "Hotel Sol", extra: { sector: "hotel" } });
      await deliver("hubspot", "company.upsert", { id: "9001", properties: { name: "Hotel Sol Palace", customer_code: "HS-9001" } });
      expect(await q("SELECT name FROM customers WHERE code = 'HS-9001'")).toEqual([{ name: "Hotel Sol Palace" }]);
      const [row] = await q<{ n: string }>("SELECT count(*)::text AS n FROM external_refs WHERE connector_key = 'hubspot' AND external_id = '9001'");
      expect(row!.n).toBe("1");
    });

    it("won deal -> order linked to the CRM company; the order event is raised", async () => {
      await deliver("hubspot", "company.upsert", { id: "9002", properties: { name: "Cliente Deal", customer_code: "HS-9002" } });
      const r = await deliver("hubspot", "deal.won", { id: "d-77", properties: { company_id: "9002", service_code: "insp-per", amount: "1250.50", dealname: "Inspección anual" } });
      expect(r.status).toBe("processed");
      const [o] = await q("SELECT o.service_code, o.amount::text AS amount, c.code FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.source = 'hubspot'");
      expect(o).toMatchObject({ service_code: "INSP-PER", amount: "1250.50", code: "HS-9002" });
      expect((await events("order.received")).length).toBe(1);
    });

    it("moves documents both ways", async () => {
      const original = await documents.save({ data: Buffer.from("OFERTA-1"), filename: "oferta.pdf", mime: "application/pdf", kind: "offer" });
      const up = await call("hubspot", "upload-document", { documentId: original.id });
      const down = await call("hubspot", "download-document", { fileId: up.externalId, kind: "offer_from_crm" });
      expect(docs.get((down.output as { documentId: string }).documentId)).toMatchObject({ filename: "oferta.pdf", kind: "offer_from_crm" });
      expect(docs.get((down.output as { documentId: string }).documentId)!.data.toString()).toBe("OFERTA-1");
    });

    it("synchronisation is incremental: a second run only brings what changed", async () => {
      await runSync(deps, "hubspot", { full: true }); // what earlier tests left in the CRM is not the subject here
      await processInbox(deps, 100);
      mocks.seed("hubspot:companies", [{ id: "s-1", properties: { name: "Sync Uno" } }, { id: "s-2", properties: { name: "Sync Dos" } }]);
      expect(await runSync(deps, "hubspot")).toMatchObject({ status: "succeeded", stats: { pulled: 2, stored: 2 } });
      await processInbox(deps, 50);
      expect(await q("SELECT name FROM customers WHERE name LIKE 'Sync %' ORDER BY name")).toHaveLength(2);
      expect(await runSync(deps, "hubspot")).toMatchObject({ status: "succeeded", stats: { pulled: 0 } });
      mocks.seed("hubspot:companies", [{ id: "s-2", properties: { name: "Sync Dos Renamed" } }]);
      expect(await runSync(deps, "hubspot")).toMatchObject({ stats: { pulled: 1, stored: 1 } });
    });

    it("transient remote failures are retried by the outbox with the same idempotency key", async () => {
      mocks.fail("hubspot", 503, 2);
      const q1 = await enqueueOutbound(pool, { connectorKey: "hubspot", action: "upsert-object", payload: { objectType: "contacts", properties: { email: "a@b.example" } }, idempotencyKey: "hs-retry" });
      expect(await runOutbox(deps)).toBe(1);
      expect((await q("SELECT status, attempts FROM outbox_events WHERE id = $1", [q1.id]))[0]).toMatchObject({ status: "failed", attempts: 1 });
      await pool.query("UPDATE outbox_events SET next_attempt_at = now()");
      await runOutbox(deps);
      await pool.query("UPDATE outbox_events SET next_attempt_at = now()");
      await runOutbox(deps);
      expect((await q("SELECT status, attempts FROM outbox_events WHERE id = $1", [q1.id]))[0]).toMatchObject({ status: "sent", attempts: 3 });
      expect(mocks.collection("hubspot:contacts")).toHaveLength(1);
    });
  });

  describe("Business Central (ORF-061, 062)", () => {
    it("creates an invoice once, and validates pricing", async () => {
      const lines = [{ description: "Inspección ascensor", quantity: 2, unitPrice: 100, itemNumber: "INSP-PER" }];
      const a = await call("business-central", "push-invoice", { customerNumber: "C-1", orderNumber: "SO-1", lines }, "inv-1");
      const b = await call("business-central", "push-invoice", { customerNumber: "C-1", orderNumber: "SO-1", lines }, "inv-1");
      expect(b.replayed).toBe(true);
      expect(a.externalId).toMatch(/^INV-/);
      expect(mocks.collection("bc:invoices")).toHaveLength(1);
      expect((await call("business-central", "validate-pricing", { itemNumber: "INSP-PER", unitPrice: 100 })).output).toMatchObject({ valid: true });
      expect((await call("business-central", "validate-pricing", { itemNumber: "INSP-PER", unitPrice: 150 })).output).toMatchObject({ valid: false });
      expect(await failure(() => call("business-central", "push-invoice", { customerNumber: "C-1", lines: [] }))).toMatchObject({ retryable: false });
    });

    it("sales order and employee reach the orchestrator; a terminated employee becomes unavailable", async () => {
      await q("INSERT INTO customers (code, name) VALUES ('BC-C1', 'Cliente ERP') ON CONFLICT DO NOTHING");
      expect((await deliver("business-central", "salesOrder.upsert", { number: "SO-100", customerNumber: "BC-C1", totalAmountIncludingTax: 480, currencyCode: "eur", salesperson: "ana" })).status).toBe("processed");
      expect((await q("SELECT external_ref, amount::text AS amount, extra FROM orders WHERE external_ref = 'SO-100'"))[0]).toMatchObject({ amount: "480.00", extra: { salesperson: "ana" } });
      await deliver("business-central", "employee.upsert", { number: "E-1", displayName: "Marta Ruiz", email: "marta@example.com", status: "Active" });
      expect(await q("SELECT active FROM technicians WHERE code = 'E-1'")).toEqual([{ active: true }]);
      await deliver("business-central", "employee.upsert", { number: "E-1", displayName: "Marta Ruiz", status: "Terminated" });
      expect(await q("SELECT active FROM technicians WHERE code = 'E-1'")).toEqual([{ active: false }]);
      expect((await events("technician.unavailable")).length).toBe(1);
    });

    it("a posted invoice is fetched as a document and announced", async () => {
      const inv = await call("business-central", "push-invoice", { customerNumber: "C-1", lines: [{ description: "x", quantity: 1, unitPrice: 10 }] });
      expect((await deliver("business-central", "invoice.posted", { id: inv.externalId, number: inv.externalId, customerNumber: "C-1" })).status).toBe("processed");
      const doc = [...docs.values()].find((d) => d.kind === "invoice");
      expect(doc?.filename).toBe(`${inv.externalId}.pdf`);
      expect((await events("invoice.posted")).length).toBe(1);
    });

    it("the nightly sync brings only modified records (OData filter)", async () => {
      mocks.seed("bc:orders", [{ id: "SO-S1", number: "SO-S1", customerNumber: "BC-C1" }]);
      await runSync(deps, "business-central", { full: true });
      expect((await q("SELECT count(*)::int AS n FROM inbox_events WHERE connector_key = 'business-central'"))[0]!.n).toBe(1);
      mocks.seed("bc:orders", [{ id: "SO-S2", number: "SO-S2", customerNumber: "BC-C1" }]);
      expect(await runSync(deps, "business-central")).toMatchObject({ stats: { pulled: 1, stored: 1 } });
    });
  });

  describe("Navision qualifications and Calibri calibrations (ORF-063, 064)", () => {
    it("computes qualification status and links calibrations to the technician", async () => {
      await q("INSERT INTO technicians (code, name) VALUES ('N-1', 'Ana Nav') ON CONFLICT DO NOTHING");
      const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
      const past = "2020-01-01";
      expect((await deliver("navision", "qualification.upsert", { id: "q1", employeeCode: "N-1", kind: "REBT-IBTE", reference: "R-1", validTo: soon })).status).toBe("processed");
      await deliver("navision", "qualification.upsert", { id: "q2", employeeCode: "N-1", kind: "ASC-OCA", validTo: past });
      expect(await q("SELECT kind, status FROM qualifications q JOIN technicians t ON t.id = q.technician_id WHERE t.code = 'N-1' ORDER BY kind")).toEqual([{ kind: "ASC-OCA", status: "expired" }, { kind: "REBT-IBTE", status: "expiring" }]);
      await deliver("navision", "calibration.upsert", { id: "k1", equipmentCode: "MEG-01", name: "Megóhmetro", calibratedAt: "2026-01-10", validTo: "2027-01-10", employeeCode: "N-1" });
      await deliver("navision", "calibration.upsert", { id: "k1", equipmentCode: "MEG-01", name: "Megóhmetro", calibratedAt: "2026-01-10", validTo: "2027-01-10", employeeCode: "N-1" }, "second-delivery");
      expect(await q("SELECT equipment_code, status FROM equipment_calibrations WHERE equipment_code = 'MEG-01'")).toEqual([{ equipment_code: "MEG-01", status: "valid" }]);
    });

    it("an unknown technician is a permanent error shown in the panel, with a task", async () => {
      const r = await deliver("navision", "qualification.upsert", { id: "qx", employeeCode: "NOBODY", kind: "X" });
      expect(r).toMatchObject({ status: "failed", error: expect.stringContaining("NOBODY") });
      const [err] = await q("SELECT error_code, resolved, task_id FROM integration_errors WHERE connector_key = 'navision'");
      expect(err).toMatchObject({ error_code: "technician_not_found", resolved: false });
      expect(err!.task_id).toBeTruthy();
    });

    it("asks for a renewal", async () => {
      expect((await call("navision", "request-renewal", { employeeCode: "N-1", qualification: "REBT-IBTE" }, "ren-1")).externalId).toMatch(/^REN-/);
    });
  });

  describe("FSM-Planner (ORF-065, 066, 067)", () => {
    it("sends the work order with its visits, technicians and services", async () => {
      const f = await fixtureVisit();
      const r = await call("fsm-planner", "request-planning", { visitIds: [f.visit] }, `plan-${f.visit}`);
      expect(r.externalId).toMatch(/^PLN-/);
      const sent = mocks.requests.find((x) => x.path.endsWith("/plan/requests"))!.body as { workOrder: { regulation: string; site: { name: string } }; visits: unknown[]; employees: { code: string }[] };
      expect(sent.workOrder).toMatchObject({ regulation: "RD 203/2021", site: { name: "Edificio Sol" } });
      expect(sent.employees.map((e) => e.code)).toEqual([f.techCode]);
      expect(sent.visits).toHaveLength(1);
      expect(JSON.stringify(sent)).not.toMatch(/email|tax_id/i);
    });

    it("a calendar change in the planner updates the visit and tells the flows", async () => {
      const f = await fixtureVisit({ technician: false, scheduled: false });
      const t = await q<{ code: string }>("INSERT INTO technicians (code, name) VALUES ($1, 'Plan Tech') RETURNING code", [`P-${randomUUID().slice(0, 5)}`]);
      const assigned = await deliver("fsm-planner", "appointment.assigned", { appointmentId: "A-1", visitRef: f.visit, technicianCode: t[0]!.code, start: "2026-07-01T08:00:00Z", end: "2026-07-01T09:00:00Z" });
      expect(assigned.status).toBe("processed");
      expect((await q("SELECT scheduled_start::text AS s FROM visits WHERE id = $1", [f.visit]))[0]!.s).toContain("2026-07-01 08:00");
      expect((await events("visit.planned")).length).toBe(1);
      await deliver("fsm-planner", "appointment.changed", { appointmentId: "A-1", visitRef: f.visit, technicianCode: t[0]!.code, start: "2026-07-02T10:00:00Z", end: "2026-07-02T11:00:00Z" });
      expect((await events("visit.replanned")).length).toBe(1);
      await deliver("fsm-planner", "appointment.cancelled", { appointmentId: "A-1", visitRef: f.visit, reason: "OT cancelada" });
      expect((await q("SELECT scheduled_start FROM visits WHERE id = $1", [f.visit]))[0]!.scheduled_start).toBeNull();
      expect((await events("visit.planning_cancelled")).length).toBe(1);
    });

    it("an unknown technician or visit is a permanent failure", async () => {
      const f = await fixtureVisit();
      expect(await deliver("fsm-planner", "appointment.assigned", { visitRef: f.visit, technicianCode: "GHOST" })).toMatchObject({ status: "failed" });
      expect(await deliver("fsm-planner", "appointment.assigned", { visitRef: randomUUID(), technicianCode: f.techCode })).toMatchObject({ status: "failed" });
    });

    it("cancelling an appointment twice is not an error; the reason is required", async () => {
      mocks.seed("planner:appointments", [{ id: "A-9", status: "booked" }]);
      await call("fsm-planner", "cancel-appointment", { appointmentId: "A-9", reason: "OT cancelada" }, "c1");
      await call("fsm-planner", "cancel-appointment", { appointmentId: "A-9", reason: "OT cancelada" }, "c2");
      expect(mocks.collection("planner:appointments").find((a) => a.id === "A-9")).toMatchObject({ status: "cancelled", cancelReason: "OT cancelada" });
      expect(await failure(() => call("fsm-planner", "cancel-appointment", { appointmentId: "A-9" }))).toMatchObject({ code: "input_invalid" });
    });

    it("keeps the planner informed of the field visit status", async () => {
      await call("fsm-planner", "update-visit", { visitRef: "V-1", status: "completed", actualStart: "2026-06-01T08:00:00Z", geo: { lat: 40.4, lng: -3.7 } });
      expect(mocks.collection("planner:visits")[0]).toMatchObject({ id: "V-1", status: "completed", geo: { lat: 40.4 } });
    });
  });

  describe("FSM field tool (ORF-068, 069, 070)", () => {
    it("opens the visit with the technician's qualifications and calibrations", async () => {
      const f = await fixtureVisit();
      await q("INSERT INTO qualifications (technician_id, kind, valid_to, status) VALUES ($1, 'ASC-OCA', '2030-01-01', 'valid')", [f.tech]);
      await q("INSERT INTO equipment_calibrations (equipment_code, name, calibrated_at, valid_to, technician_id) VALUES ($1, 'Medidor', '2026-01-01', '2027-01-01', $2)", [`EQ-${f.visitNumber}`, f.tech]);
      const r = await call("fsm-field", "open-visit", { visitId: f.visit }, `open-${f.visit}`);
      expect(r.externalId).toBe(`FLD-${f.visit}`);
      const sent = mocks.requests.find((x) => x.path.endsWith("/field/visits"))!.body as { qualifications: { kind: string }[]; calibrations: unknown[]; technicianCode: string };
      expect(sent).toMatchObject({ technicianCode: f.techCode, qualifications: [{ kind: "ASC-OCA" }] });
      expect(sent.calibrations).toHaveLength(1);
    });

    it("refuses to open a visit nobody is assigned to", async () => {
      const f = await fixtureVisit({ technician: false });
      expect(await failure(() => call("fsm-field", "open-visit", { visitId: f.visit }))).toMatchObject({ code: "technician_missing", retryable: false });
    });

    it("the inspection result completes the visit, raises a nonconformity and wakes the flow", async () => {
      const f = await fixtureVisit();
      const r = await deliver("fsm-field", "inspection.completed", {
        visitRef: f.visit, result: "unfavorable", fieldSheet: "FS-ELEV-3", technicianCode: f.techCode, startedAt: "2026-06-01T08:10:00Z", endedAt: "2026-06-01T09:00:00Z", geo: { lat: 40.4, lng: -3.7, utm: "30T 440000 4474000" },
        defects: [{ code: "D-12", severity: "major", description: "Cable desgastado" }], data: { floors: 7 },
      });
      expect(r.status).toBe("processed");
      expect((await q("SELECT status, result, geo FROM visits WHERE id = $1", [f.visit]))[0]).toMatchObject({ status: "completed", result: "unfavorable", geo: { lat: 40.4 } });
      expect((await q("SELECT field_sheet, data FROM inspection_results WHERE visit_id = $1", [f.visit]))[0]).toMatchObject({ field_sheet: "FS-ELEV-3", data: { floors: 7, source: "fsm-field" } });
      expect((await q("SELECT count(*)::int AS n FROM nonconformities WHERE visit_id = $1", [f.visit]))[0]!.n).toBe(1);
      expect((await events("visit.result"))[0]).toMatchObject({ payload: { result: "unfavorable", defects: 1 } });
      expect((await events("nc.detected")).length).toBe(1);
    });

    it("an invalid result is rejected and nothing is half-applied", async () => {
      const f = await fixtureVisit();
      expect(await deliver("fsm-field", "inspection.completed", { visitRef: f.visit, result: "maybe" })).toMatchObject({ status: "failed" });
      expect((await q("SELECT status FROM visits WHERE id = $1", [f.visit]))[0]!.status).toBe("scheduled");
      expect(await q("SELECT 1 FROM inspection_results WHERE visit_id = $1", [f.visit])).toHaveLength(0);
    });

    it("a failure in the middle rolls the whole event back (one transaction)", async () => {
      const f = await fixtureVisit({ status: "incident" }); // 'complete' is not allowed from an incident -> fails after nothing was committed
      const r = await deliver("fsm-field", "inspection.completed", { visitRef: f.visit, result: "favorable" });
      expect(r.status).toBe("failed");
      expect(await q("SELECT 1 FROM inspection_results WHERE visit_id = $1", [f.visit])).toHaveLength(0);
    });

    it("stores documents the field tool uploads against the visit", async () => {
      const f = await fixtureVisit();
      const { body } = await fetch(`${server.url}/field/documents`, { method: "POST", headers: { authorization: "Bearer mock-token", "content-type": "application/json" }, body: JSON.stringify({ filename: "parte.pdf", contentBase64: Buffer.from("PARTE").toString("base64") }) }).then(async (r) => ({ body: (await r.json()) as { id: string } }));
      expect((await deliver("fsm-field", "document.uploaded", { visitRef: f.visit, documentId: body.id, kind: "work_report" })).status).toBe("processed");
      expect([...docs.values()].find((d) => d.kind === "work_report")).toMatchObject({ filename: "parte.pdf", entityType: "visit", entityId: f.visit });
    });

    it("pushes notifications to the inspector", async () => {
      await call("fsm-field", "notify-technician", { technicianCode: "T-1", title: "Nueva visita", kind: "urgent" }, "n1");
      expect(mocks.collection("field:notifications")[0]).toMatchObject({ technicianCode: "T-1", kind: "urgent" });
      expect(await failure(() => call("fsm-field", "notify-technician", { technicianCode: "T-1", title: "x", kind: "gossip" }))).toMatchObject({ code: "input_invalid" });
    });
  });

  describe("TASK timesheets (ORF-071)", () => {
    it("sends the real hours once per technician and visit", async () => {
      const f = await fixtureVisit({ actual: true });
      await call("task", "push-timesheet", { visitId: f.visit }, "ts-1");
      await call("task", "push-timesheet", { visitId: f.visit }, "ts-2");
      const rows = mocks.collection("task:timesheets");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ employeeCode: f.techCode, minutes: 65 });
    });

    it("refuses when the visit has no real hours or no technician", async () => {
      expect(await failure(async () => call("task", "push-timesheet", { visitId: (await fixtureVisit()).visit }))).toMatchObject({ code: "hours_missing" });
      expect(await failure(async () => call("task", "push-timesheet", { visitId: (await fixtureVisit({ technician: false, actual: true })).visit }))).toMatchObject({ code: "technician_missing" });
    });

    it("an approved timesheet is recorded once", async () => {
      const f = await fixtureVisit();
      const payload = { employeeCode: f.techCode, visitRef: f.visit, start: "2026-06-01T08:00:00Z", end: "2026-06-01T09:00:00Z", minutes: 60, cost: 42.5 };
      await deliver("task", "timesheet.approved", payload);
      await deliver("task", "timesheet.approved", payload);
      expect(await q("SELECT minutes, cost::text AS cost FROM timesheets WHERE visit_id = $1", [f.visit])).toEqual([{ minutes: 60, cost: "42.50" }]);
    });
  });

  describe("Euroconect batches and administration websites (ORF-072, 087..092)", () => {
    it("requests a batch, and refuses an empty one", async () => {
      expect((await call("euroconect", "request-batch", { administration: "sioca", inspectionIds: ["i1", "i2"] }, "b1")).externalId).toMatch(/^LOT-/);
      expect(await failure(() => call("euroconect", "request-batch", { administration: "sioca", inspectionIds: [] }))).toMatchObject({ code: "input_invalid" });
      expect(await failure(() => call("euroconect", "request-batch", { administration: "narnia", inspectionIds: ["i1"] }))).toMatchObject({ code: "input_invalid" });
    });

    it("the generated file becomes a document and ONE task in the batch queue, however often it is delivered", async () => {
      const payload = { batchId: "LOT-0042", administration: "Sioca", inspectionIds: ["i1", "i2", "i3"], filename: "lote-42.xml", contentBase64: Buffer.from("<lote/>").toString("base64") };
      await deliver("euroconect", "batch.generated", payload, "e1");
      await deliver("euroconect", "batch.generated", payload, "e2");
      const tasks = await q("SELECT t.title, t.extra, q.key FROM tasks t JOIN queues q ON q.id = t.queue_id WHERE t.kind = 'batch_upload'");
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ key: "lotes", title: "Subir lote LOT-0042 a Sioca", extra: { administration: "Sioca" } });
      expect(await q("SELECT status, administration FROM batch_files WHERE batch_ref = 'LOT-0042'")).toEqual([{ status: "generated", administration: "Sioca" }]);
    });
  });

  describe("Eurocert certificates (ORF-073, 074)", () => {
    it("requests the certificate with the fields the line, area and region dictate", async () => {
      const f = await fixtureVisit({ actual: true });
      await q("INSERT INTO inspection_results (visit_id, result, data) VALUES ($1, 'favorable', '{\"floors\": 5}')", [f.visit]);
      await call("eurocert", "request-certificate", { visitId: f.visit }, `cert-${f.visit}`);
      expect(mocks.requests.find((r) => r.path.endsWith("/certificates") && r.method === "POST")!.body).toMatchObject({ line: "IND", area: "ELEV", regulation: "RD 203/2021", autonomousCommunity: "Madrid", result: "favorable" });
    });

    it("cannot certify a visit without a result", async () => {
      expect(await failure(async () => call("eurocert", "request-certificate", { visitId: (await fixtureVisit()).visit }))).toMatchObject({ code: "result_missing" });
    });

    it("the unsigned certificate is stored once and linked to the certificate record", async () => {
      const f = await fixtureVisit();
      const cert = (await q<{ id: string }>("INSERT INTO certificates (work_order_id, number) VALUES ($1, 'CERT-1') RETURNING id", [f.wo]))[0]!.id;
      const payload = { certificateRef: "CRT-1", workOrderId: f.wo, filename: "CRT-1.pdf", contentBase64: Buffer.from("%PDF").toString("base64") };
      expect((await deliver("eurocert", "certificate.generated", payload, "x1")).status).toBe("processed");
      await deliver("eurocert", "certificate.generated", payload, "x2");
      expect((await q("SELECT document_id FROM certificates WHERE id = $1", [cert]))[0]!.document_id).toBeTruthy();
      expect([...docs.values()].filter((d) => d.kind === "certificate" && d.entityId === cert)).toHaveLength(1);
      expect((await events("certificate.generated")).length).toBe(1);
    });
  });

  describe("FSM forms manager (ORF-093)", () => {
    const published = (over: Record<string, unknown> = {}) => ({ id: "f-1-v1", key: "FS-ELEV", name: "Hoja de campo ascensores", version: 1, validFrom: "2026-01-01", validTo: "2099-12-31", schema: { type: "object" }, ...over });

    it("new forms and new versions are stored with their validity dates", async () => {
      expect((await deliver("fsm-forms", "form.published", published())).status).toBe("processed");
      await deliver("fsm-forms", "form.published", published({ id: "f-1-v2", version: 2, validFrom: "2027-01-01" }));
      await deliver("fsm-forms", "form.published", published(), "again");
      expect(await q("SELECT f.key, v.version, v.valid_from::text AS valid_from, f.source FROM form_versions v JOIN forms f ON f.id = v.form_id WHERE f.key = 'FS-ELEV' ORDER BY v.version")).toEqual([
        { key: "FS-ELEV", version: 1, valid_from: "2026-01-01", source: "fsm" }, { key: "FS-ELEV", version: 2, valid_from: "2027-01-01", source: "fsm" },
      ]);
      expect((await events("form.published")).length).toBe(2);
    });

    it("rejects a validity that ends before it starts", async () => {
      expect(await deliver("fsm-forms", "form.published", published({ key: "BAD", validFrom: "2026-05-01", validTo: "2026-01-01" }))).toMatchObject({ status: "failed", error: expect.stringContaining("validity") });
    });

    it("queries current and expired forms in the manager", async () => {
      mocks.seed("forms:versions", [{ id: "q-current", key: "A", validFrom: "2020-01-01", validTo: "2099-01-01" }, { id: "q-expired", key: "B", validFrom: "2020-01-01", validTo: "2021-01-01" }]);
      const ids = async (status: string) => ((await call("fsm-forms", "list-forms", { status })).output as { id: string }[]).map((f) => f.id);
      expect(await ids("current")).toContain("q-current");
      expect(await ids("current")).not.toContain("q-expired");
      expect(await ids("expired")).toEqual(expect.arrayContaining(["q-expired"]));
      expect(await failure(() => call("fsm-forms", "list-forms", { status: "weird" }))).toMatchObject({ code: "input_invalid" });
    });
  });

  describe("digital signature (ORF-075)", () => {
    it("sends the certificate, and the signed one returns as a new version that replaces it", async () => {
      const f = await fixtureVisit();
      const cert = (await q<{ id: string }>("INSERT INTO certificates (work_order_id, number) VALUES ($1, 'CERT-S') RETURNING id", [f.wo]))[0]!.id;
      const original = await documents.save({ data: Buffer.from("%PDF unsigned"), filename: "cert.pdf", mime: "application/pdf", kind: "certificate", entityType: "certificate", entityId: cert });
      const sent = await call("signature", "send-for-signature", { documentId: original.id, signers: [{ name: "Director técnico", email: "dt@example.com" }], certificateId: cert }, `sig-${original.id}`);
      const again = await call("signature", "send-for-signature", { documentId: original.id, signers: [{ name: "Director técnico", email: "dt@example.com" }], certificateId: cert }, `sig-${original.id}`);
      expect(again.replayed).toBe(true);
      expect(mocks.collection("signature:requests")).toHaveLength(1);

      expect(await failure(() => deliver("signature", "signature.completed", { id: sent.externalId }).then((r) => { if (r.status === "failed") throw new ConnectorError(r.error ?? "", "x", false); }))).toBeTruthy();
      await mocks.app.request(`/_control/signatures/${sent.externalId}/complete`, { method: "POST", headers: { authorization: "Bearer mock-token" } });
      await pool.query("UPDATE inbox_events SET status = 'received', attempts = 0, next_attempt_at = now()");
      await processInbox(deps, 10);
      const signed = [...docs.values()].find((d) => d.signed);
      expect(signed).toMatchObject({ kind: "certificate", previousVersionId: original.id });
      expect((await q("SELECT signed_document_id FROM certificates WHERE id = $1", [cert]))[0]!.signed_document_id).toBeTruthy();
      expect((await events("document.signed")).length).toBe(1);
    });

    it("needs at least one signer; a declined signature becomes a task", async () => {
      const original = await documents.save({ data: Buffer.from("x"), filename: "a.pdf", kind: "certificate" });
      expect(await failure(() => call("signature", "send-for-signature", { documentId: original.id, signers: [] }))).toMatchObject({ retryable: false });
      await deliver("signature", "signature.declined", { id: "SIG-X", reason: "No procede" });
      expect(await q("SELECT title FROM tasks WHERE kind = 'signature_declined'")).toEqual([{ title: "Firma rechazada SIG-X" }]);
    });
  });

  describe("communications manager (ORF-076)", () => {
    it("orders a communication and updates the message trail with the result", async () => {
      const sent = await call("comms", "send-communication", { template: "visit.reminder", recipients: [{ to: "a@x.example", vars: { name: "A" } }] }, "cm-1");
      await q("INSERT INTO messages (channel_kind, to_address, body, status, provider_id) VALUES ('email', 'a@x.example', 'hola', 'sent', $1)", [sent.externalId]);
      await deliver("comms", "communication.result", { id: sent.externalId, results: [{ to: "a@x.example", status: "delivered" }] });
      expect(await q("SELECT status FROM messages WHERE provider_id = $1", [sent.externalId])).toEqual([{ status: "delivered" }]);
      expect(await failure(() => call("comms", "send-communication", { template: "x" }))).toMatchObject({ code: "input_invalid" });
    });
  });

  describe("document manager: SharePoint (Graph) and MinIO drivers (ORF-077..081)", () => {
    it("builds folders from a pattern, archives with a naming rule and is idempotent", async () => {
      const doc = await documents.save({ data: Buffer.from("%PDF cert"), filename: "informe.pdf", mime: "application/pdf", kind: "certificate" });
      const vars = { year: "2026", customer: "ACME S.L.", wo: "1234", offer: "O-77", customerId: "C-9" };
      const made = await call("dms", "create-folders", { pattern: "{year}/{customer}/OT-{wo}", vars }, "f1");
      expect(made.output).toEqual({ path: "/Orquestador/2026/ACME S.L./OT-1234" });
      const first = await call("dms", "archive-document", { documentId: doc.id, folderPattern: "{year}/{customer}/OT-{wo}", namePattern: "{customerId}_{offer}", vars }, "a1");
      expect(first.output).toMatchObject({ path: "/Orquestador/2026/ACME S.L./OT-1234/C-9_O-77.pdf" });
      const second = await call("dms", "archive-document", { documentId: doc.id, folderPattern: "{year}/{customer}/OT-{wo}", namePattern: "{customerId}_{offer}", vars }, "a2");
      expect(second.output).toMatchObject({ unchanged: true });
      expect((await q("SELECT dms_ref FROM documents WHERE id = $1", [doc.id]))[0]!.dms_ref).toBe("/Orquestador/2026/ACME S.L./OT-1234/C-9_O-77.pdf");
    });

    it("renames, moves, reads metadata from the file name, searches and deletes", async () => {
      const doc = await documents.save({ data: Buffer.from("x"), filename: "x.pdf", kind: "offer" });
      await call("dms", "archive-document", { documentId: doc.id, folderPattern: "inbox", namePattern: "{c}_{o}", vars: { c: "C123", o: "O456" } }, "m1");
      await call("dms", "rename", { path: "inbox/C123_O456.pdf", newName: "C123_O456_v2.pdf" }, "m2");
      const meta = await call("dms", "read-metadata", { path: "inbox/C123_O456_v2.pdf", namePattern: "{ID_Cliente}_{ID_Oferta}_v2", store: true });
      expect(meta.output).toMatchObject({ parsed: true, metadata: { ID_Cliente: "C123", ID_Oferta: "O456" } });
      expect((await call("dms", "search", { query: "C123" })).output).toMatchObject({ items: [{ name: "C123_O456_v2.pdf" }] });
      await call("dms", "move", { path: "inbox/C123_O456_v2.pdf", toFolder: "archive/2026" }, "m3");
      expect((await call("dms", "search", { query: "O456" })).output).toMatchObject({ items: [{ path: expect.stringContaining("archive/2026") }] });
      await call("dms", "delete", { path: "archive/2026/C123_O456_v2.pdf" }, "m4");
      await call("dms", "delete", { path: "archive/2026/C123_O456_v2.pdf" }, "m5"); // already gone: fine
      expect((await call("dms", "search", { query: "O456" })).output).toMatchObject({ items: [] });
      expect(await failure(() => call("dms", "delete", { path: "" }))).toBeTruthy();
    });

    it("refuses paths that escape the root and variables nobody supplied", async () => {
      expect(() => cleanPath("a/../b")).toThrow(/cannot be used/);
      expect(() => renderPattern("{year}/{customer}", { year: "2026" })).toThrow(/customer/);
      expect(await failure(() => call("dms", "create-folders", { pattern: "{x}", vars: { x: ".." } }))).toMatchObject({ code: "path_invalid" });
      expect(parseFilename("{ID_Cliente}_{ID_Oferta}", "C1_O2.pdf")).toEqual({ ID_Cliente: "C1", ID_Oferta: "O2" });
      expect(parseFilename("{ID_Cliente}_{ID_Oferta}", "random.pdf")).toBeNull();
    });

    it("the MinIO driver offers the same operations", async () => {
      await pool.query("UPDATE connectors SET config = config || '{\"driver\": \"minio\", \"rootFolder\": \"/dms\"}'::jsonb WHERE key = 'dms'");
      try {
        const doc = await documents.save({ data: Buffer.from("minio-bytes"), filename: "a.pdf", kind: "offer" });
        const r = await call("dms", "archive-document", { documentId: doc.id, folderPattern: "{y}", vars: { y: "2026" } }, "mn1");
        expect(r.output).toMatchObject({ path: "/dms/2026/a.pdf" });
        expect(objects.get("dms/2026/a.pdf")?.data.toString()).toBe("minio-bytes");
        await call("dms", "move", { path: "2026/a.pdf", toFolder: "2027" }, "mn2");
        expect([...objects.keys()]).toEqual(["dms/2027/a.pdf"]);
        const back = await call("dms", "fetch-document", { path: "2027/a.pdf", kind: "restored" });
        expect(docs.get((back.output as { documentId: string }).documentId)!.data.toString()).toBe("minio-bytes");
      } finally {
        await pool.query("UPDATE connectors SET config = config - 'driver' || '{\"driver\": \"graph\", \"rootFolder\": \"/Orquestador\"}'::jsonb WHERE key = 'dms'");
      }
    });
  });

  describe("CAE platform (ORF-082)", () => {
    it("sends scheduled visits (site, date, company, technicians)", async () => {
      const f = await fixtureVisit();
      await call("cae", "send-visit", { visitId: f.visit }, `cae-${f.visit}`);
      expect(mocks.collection("cae:visits")[0]).toMatchObject({ company: "Seitech Inspección, S.A.", site: { name: "Edificio Sol" }, technicians: [{ code: f.techCode }] });
      expect(await failure(async () => call("cae", "send-visit", { visitId: (await fixtureVisit({ scheduled: false })).visit }))).toMatchObject({ code: "visit_unscheduled" });
    });

    it("missing documentation opens one task and marks the project; acceptance clears it", async () => {
      const del = (await q<{ id: string }>("SELECT id FROM delegations LIMIT 1"))[0]?.id ?? (await q<{ id: string }>("INSERT INTO delegations (code, name) VALUES ('CAE', 'CAE') RETURNING id"))[0]!.id;
      await q("INSERT INTO projects (delegation_id, code, name) VALUES ($1, 'PRJ-1', 'Obra 1') ON CONFLICT DO NOTHING", [del]);
      await deliver("cae", "documentation.status", { projectRef: "PRJ-1", status: "missing", missing: ["Seguro RC", "TC2"] }, "c1");
      await deliver("cae", "documentation.status", { projectRef: "PRJ-1", status: "missing", missing: ["Seguro RC"] }, "c2");
      expect(await q("SELECT description FROM tasks WHERE kind = 'cae_documentation'")).toHaveLength(1);
      expect((await q("SELECT extra->'cae'->>'status' AS s FROM projects WHERE code = 'PRJ-1'"))[0]!.s).toBe("missing");
      await deliver("cae", "documentation.status", { projectRef: "PRJ-1", status: "accepted" }, "c3");
      expect((await events("cae.documentation_accepted")).length).toBe(1);
      expect(await deliver("cae", "documentation.status", { projectRef: "PRJ-1", status: "dunno" })).toMatchObject({ status: "failed" });
    });
  });

  describe("customer portal (ORF-083)", () => {
    it("publishes status and documents; portal requests become back-office tasks", async () => {
      await call("portal", "push-status", { inspectionRef: "OT-1", status: "scheduled", message: "Su visita es el lunes" }, "p1");
      expect(mocks.collection("portal:inspections")[0]).toMatchObject({ id: "OT-1", status: "scheduled" });
      const doc = await documents.save({ data: Buffer.from("x"), filename: "certificado.pdf", kind: "certificate" });
      await call("portal", "publish-document", { inspectionRef: "OT-1", documentId: doc.id }, "p2");
      expect(mocks.collection("portal:documents")[0]).toMatchObject({ kind: "certificate", title: "certificado.pdf", documentId: doc.id });
      expect(JSON.stringify(mocks.collection("portal:documents"))).not.toContain("contentBase64");
      await deliver("portal", "request.created", { requestId: "R-1", subject: "¿Cuándo vienen?", message: "Necesito saber la hora", customerRef: "C-1", inspectionRef: "OT-1" }, "r1");
      await deliver("portal", "request.created", { requestId: "R-1", subject: "¿Cuándo vienen?" }, "r2");
      expect(await q("SELECT title FROM tasks WHERE kind = 'portal_request'")).toEqual([{ title: "Portal de cliente: ¿Cuándo vienen?" }]);
      expect((await call("portal", "get-analytics", { period: "7d" })).output).toMatchObject({ period: "7d", visits: 1280 });
    });
  });

  describe("Microsoft 365 (RNF-018)", () => {
    it("sends mail and creates calendar events; bad recipients fail clearly", async () => {
      await call("m365", "send-mail", { to: ["cliente@example.com"], subject: "Cita", body: "Hola" }, "m1");
      expect(mocks.requests.find((r) => r.path.endsWith("/sendMail"))).toMatchObject({ path: "/m365/v1.0/users/orquestador%40example.com/sendMail" });
      expect(await failure(() => call("m365", "send-mail", { to: ["no-email"], subject: "x", body: "y" }))).toMatchObject({ code: "input_invalid" });
      const ev = await call("m365", "create-event", { user: "insp@example.com", subject: "Visita", start: "2026-06-01T08:00:00", end: "2026-06-01T09:00:00", attendees: ["cliente@example.com"] }, "e1");
      expect(ev.externalId).toMatch(/^EVT-/);
      expect(((await call("m365", "list-users", {})).output as unknown[]).length).toBe(2);
    });
  });

  describe("SQL Server (RNF-018)", () => {
    const calls: { sql: string; params: Record<string, unknown> }[] = [];
    const driver: SqlDriver = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (/FROM customers/i.test(sql)) return { rows: [{ id: 1, name: "Legacy SA", modified: "2026-02-01T00:00:00.000Z" }], rowsAffected: 0 };
        return { rows: [], rowsAffected: 3 };
      },
      async close() {},
    };
    beforeAll(async () => {
      setSqlDriverFactory(async () => driver);
      await pool.query(
        `INSERT INTO connectors (key, name, system_kind, mode, config) VALUES ('legacy-sql', 'ERP antiguo', 'sqlserver', 'mock', $1::jsonb) ON CONFLICT (key) DO UPDATE SET config = EXCLUDED.config`,
        [JSON.stringify({
          sql: { server: "sql.example", database: "erp" },
          statements: { customer_by_id: { sql: "SELECT id, name, modified FROM customers WHERE id = @id", params: ["id"] }, customers_since: { sql: "SELECT id, name, modified FROM customers WHERE @since IS NULL OR modified > @since", params: ["since"] }, close_order: { sql: "UPDATE orders SET status = 'closed' WHERE id = @id", params: ["id"], mode: "write" } },
          feeds: [{ statement: "customers_since", eventType: "customer.sync", idColumn: "id", updatedColumn: "modified" }],
        })],
      );
    });

    it("only runs declared statements with bound parameters", async () => {
      expect((await call("legacy-sql", "query", { statement: "customer_by_id", params: { id: 1 } })).output).toMatchObject({ count: 1, rows: [{ name: "Legacy SA" }] });
      expect(calls.at(-1)!.params).toEqual({ id: 1 });
      expect(await failure(() => call("legacy-sql", "query", { statement: "DROP TABLE customers" }))).toMatchObject({ code: "statement_unknown" });
      expect(await failure(() => call("legacy-sql", "query", { statement: "customer_by_id", params: { id: 1, evil: "1; DROP" } }))).toMatchObject({ code: "input_invalid" });
      expect(await failure(() => call("legacy-sql", "query", { statement: "close_order", params: { id: 1 } }))).toMatchObject({ code: "statement_unknown" });
      expect((await call("legacy-sql", "execute", { statement: "close_order", params: { id: 9 } })).output).toEqual({ rowsAffected: 3 });
      expect(await failure(() => call("legacy-sql", "execute", { statement: "customer_by_id", params: { id: 1 } }))).toMatchObject({ code: "statement_unknown" });
    });

    it("synchronises through a declared read statement", async () => {
      expect(await runSync(deps, "legacy-sql", { full: true })).toMatchObject({ status: "succeeded", stats: { pulled: 1, stored: 1 } });
      expect(await runSync(deps, "legacy-sql", { full: true })).toMatchObject({ stats: { pulled: 1, stored: 0 } });
    });

    it("explains a missing driver instead of crashing", async () => {
      setSqlDriverFactory(undefined);
      expect(await failure(() => call("legacy-sql", "query", { statement: "customer_by_id", params: { id: 1 } }))).toMatchObject({ code: "driver_missing", retryable: false });
      setSqlDriverFactory(async () => driver);
    });
  });

  it("webhook-style payload ids are idempotent across connectors (same id, different connector = different events)", async () => {
    await receiveInbound(pool, { connectorKey: "cae", eventId: "same", eventType: "documentation.status", payload: { projectRef: "A", status: "accepted" } });
    const other = await receiveInbound(pool, { connectorKey: "portal", eventId: "same", eventType: "request.created", payload: { requestId: "z" } });
    expect(other.duplicate).toBe(false);
    void createHash;
  });
});
