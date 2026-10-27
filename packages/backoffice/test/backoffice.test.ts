import { createPool, migrate, seedBase, withSystem } from "@orchestrador/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { eraseSubject, evaluateAlerts, exportSubject, runDueExports, runRetention, runRetentionIfDue, signDashboardEmbed, signDownloadToken, verifyDownloadToken } from "../src/index.js";

describe("signed links", () => {
  const secret = "s3cret-s3cret-s3cret";
  const doc = "6f1e6a62-7e8e-4d7a-9a6c-0e0b0b0b0b0b";
  it("accepts a fresh token and rejects expired, tampered and foreign ones", () => {
    const now = new Date("2026-01-01T10:00:00Z");
    const token = signDownloadToken(secret, { documentId: doc, expiresAt: new Date(now.getTime() + 3600_000) });
    expect(verifyDownloadToken(secret, token, now)).toEqual({ documentId: doc });
    expect(verifyDownloadToken(secret, token, new Date(now.getTime() + 2 * 3600_000))).toBeNull();
    expect(verifyDownloadToken("other-secret-other-secret", token, now)).toBeNull();
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ d: "another-doc", e: 9_999_999_999 })).toString("base64url");
    expect(verifyDownloadToken(secret, `${forged}.${sig}`, now)).toBeNull();
    expect(verifyDownloadToken(secret, `${payload}.${sig}.x`, now)).toBeNull();
    expect(verifyDownloadToken(secret, "garbage", now)).toBeNull();
  });
});

describe("dashboard embedding", () => {
  it("signs an HS256 token that names the dashboard and expires", () => {
    const { url, expiresAt } = signDashboardEmbed({ siteUrl: "https://bi.example.test/", secret: "k", dashboardId: 7, params: { delegation: "Madrid" }, ttlMinutes: 5, now: new Date("2026-01-01T00:00:00Z") });
    const token = url.split("/embed/dashboard/")[1]!.split("#")[0]!;
    const [h, p] = token.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toMatchObject({ resource: { dashboard: 7 }, params: { delegation: "Madrid" }, exp: 1767225900 });
    expect(expiresAt).toBe("2026-01-01T00:05:00.000Z");
  });
});

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("back-office jobs (real Postgres, row-level security on)", () => {
  const dbName = `orq_bo_${Date.now()}`;
  const PII = "test-pii-key-123456";
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let admin: pg.Client;
  let owner: pg.Pool;
  let app: pg.Pool;
  let userId: string;
  let madrid: string;
  let sevilla: string;

  const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await owner.query<T>(sql, params)).rows;
  const wo = (delegation: string | null, extra = "") => q(`INSERT INTO work_orders (status, delegation_id${extra ? ", " + extra.split("=")[0] : ""}) VALUES ('created', $1${extra ? ", " + extra.split("=")[1] : ""})`, [delegation]);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    const appRole = `orq_bo_app_${Date.now()}`;
    await migrate(base.toString(), { appRole: { name: appRole, password: "x" } });
    owner = createPool(base.toString());
    const appUrl = new URL(base.toString());
    appUrl.username = appRole;
    appUrl.password = "x";
    app = createPool(appUrl.toString());
    await seedBase(owner);
    madrid = (await q<{ id: string }>("INSERT INTO delegations (code, name) VALUES ('MAD', 'Madrid') RETURNING id"))[0]!.id;
    sevilla = (await q<{ id: string }>("INSERT INTO delegations (code, name) VALUES ('SEV', 'Sevilla') RETURNING id"))[0]!.id;
    userId = (await q<{ id: string }>("INSERT INTO users (email, display_name, scope_all) VALUES ('boss@example.com', 'Boss', true) RETURNING id"))[0]!.id;
    await q("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'admin'", [userId]);
    await q("INSERT INTO channels (kind, name, enabled, config) VALUES ('email', 'mail', true, '{}')").catch(() => undefined);
  });
  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });
  beforeEach(async () => {
    await q("DELETE FROM alerts; DELETE FROM alert_rules; DELETE FROM export_jobs; DELETE FROM export_schedules; DELETE FROM messages; DELETE FROM domain_events; DELETE FROM gdpr_requests");
    await q("DELETE FROM visits; DELETE FROM work_orders; DELETE FROM documents; DELETE FROM consents; DELETE FROM sites; DELETE FROM customers; DELETE FROM technicians; DELETE FROM maintenance_runs");
  });

  describe("threshold alerts (ORF-040)", () => {
    it("fires once, stays quiet while open, re-notifies later, and resolves itself", async () => {
      const rule = (await q<{ id: string }>("INSERT INTO alert_rules (name, metric, operator, threshold, severity, recipients, renotify_hours) VALUES ('Muchas OT sin técnico', 'wo_unassigned', 'gte', 2, 'critical', '{ops@example.com,boss@example.com}', 12) RETURNING id"))[0]!.id;
      const t0 = new Date("2026-03-02T08:00:00Z");
      await wo(madrid);
      expect(await evaluateAlerts({ pool: app, log, now: () => t0 })).toMatchObject({ evaluated: 1, fired: 0 });
      expect(await q("SELECT 1 FROM alerts")).toHaveLength(0);

      await wo(madrid);
      expect(await evaluateAlerts({ pool: app, log, now: () => t0 })).toMatchObject({ fired: 1 });
      expect(await q("SELECT status, value::int FROM alerts")).toEqual([{ status: "firing", value: 2 }]);
      expect(await q("SELECT to_address, subject FROM messages ORDER BY to_address")).toEqual([
        { to_address: "boss@example.com", subject: "[CRITICAL] Muchas OT sin técnico" },
        { to_address: "ops@example.com", subject: "[CRITICAL] Muchas OT sin técnico" },
      ]);
      expect(await q("SELECT type, payload->>'metric' AS metric FROM domain_events")).toEqual([{ type: "alert.fired", metric: "wo_unassigned" }]);

      // Still breached an hour later: same alert, no second e-mail round, value refreshed.
      await wo(madrid);
      expect(await evaluateAlerts({ pool: app, log, now: () => new Date(t0.getTime() + 3600_000) })).toMatchObject({ fired: 0 });
      expect(await q("SELECT last_value::int AS v FROM alerts")).toEqual([{ v: 3 }]);
      expect(await q("SELECT 1 FROM messages")).toHaveLength(2);

      // After the renotify window it reminds again, unless somebody acknowledged it.
      await evaluateAlerts({ pool: app, log, now: () => new Date(t0.getTime() + 13 * 3600_000) });
      expect(await q("SELECT 1 FROM messages")).toHaveLength(4);
      await q("UPDATE alerts SET status = 'acknowledged'");
      await evaluateAlerts({ pool: app, log, now: () => new Date(t0.getTime() + 40 * 3600_000) });
      expect(await q("SELECT 1 FROM messages")).toHaveLength(4);

      await q("UPDATE work_orders SET status = 'cancelled'");
      expect(await evaluateAlerts({ pool: app, log, now: () => new Date(t0.getTime() + 41 * 3600_000) })).toMatchObject({ resolved: 1 });
      expect(await q("SELECT status FROM alerts")).toEqual([{ status: "resolved" }]);
      expect((await q("SELECT type FROM domain_events ORDER BY created_at")).map((e) => e.type)).toEqual(["alert.fired", "alert.resolved"]);
      expect(await q("SELECT last_value::int AS v FROM alert_rules WHERE id = $1", [rule])).toEqual([{ v: 0 }]);
    });

    it("a rule tied to a delegation only counts what that delegation owns", async () => {
      await q("INSERT INTO alert_rules (name, metric, operator, threshold, delegation_id, recipients) VALUES ('Sevilla', 'wo_unassigned', 'gt', 1, $1, '{s@example.com}')", [sevilla]);
      await wo(madrid);
      await wo(madrid);
      await wo(madrid);
      await wo(sevilla);
      expect(await evaluateAlerts({ pool: app, log })).toMatchObject({ fired: 0 });
      await wo(sevilla);
      expect(await evaluateAlerts({ pool: app, log })).toMatchObject({ fired: 1 });
      expect(await q("SELECT value::int AS v FROM alerts")).toEqual([{ v: 2 }]);
    });

    it("reports an unknown metric instead of crashing the loop", async () => {
      await q("INSERT INTO alert_rules (name, metric, threshold) VALUES ('Rota', 'does_not_exist', 1)");
      await q("INSERT INTO alert_rules (name, metric, operator, threshold) VALUES ('Buena', 'wo_open', 'gte', 0)");
      expect(await evaluateAlerts({ pool: app, log })).toMatchObject({ failed: 1, evaluated: 1, fired: 1 });
    });
  });

  describe("scheduled exports (ORF-042)", () => {
    const saved: { filename: string; data: Buffer }[] = [];
    const deps = (over: Partial<Parameters<typeof runDueExports>[0]> = {}) => ({
      pool: app, log, publicBaseUrl: "https://orq.test:8443", linkSecret: "link-secret-link-secret", maxRows: 1000,
      saveDocument: async (f: { data: Buffer; filename: string }) => {
        saved.push({ filename: f.filename, data: f.data });
        const id = (await q<{ id: string }>("INSERT INTO documents (bucket, object_key, filename, kind) VALUES ('t', $1, $2, 'export') RETURNING id", [`k/${saved.length}`, f.filename]))[0]!.id;
        return { id };
      },
      ...over,
    });
    const schedule = async (extra: Record<string, unknown> = {}) => {
      const s = { name: "OT abiertas", entity: "work_orders", format: "csv", cron: "0 7 * * 1", timezone: "Europe/Madrid", recipients: ["a@example.com", "b@example.com"], created_by: userId, next_run_at: "2026-03-02T06:00:00Z", ...extra };
      return (await q<{ id: string }>(
        "INSERT INTO export_schedules (name, entity, format, cron, timezone, recipients, created_by, next_run_at, definition) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING id",
        [s.name, s.entity, s.format, s.cron, s.timezone, s.recipients, s.created_by, s.next_run_at, JSON.stringify({ filter: { field: "status", op: "eq", value: "created" }, columns: ["number", "status"] })],
      ))[0]!.id;
    };

    it("runs what is due, mails expiring links, moves the next run forward and never runs the slot twice", async () => {
      await wo(madrid);
      const id = await schedule();
      await schedule({ name: "Futuro", next_run_at: "2999-01-01T00:00:00Z" });
      const now = new Date("2026-03-02T06:30:00Z");

      expect(await runDueExports(deps({ now: () => now }))).toBe(1);
      expect(await runDueExports(deps({ now: () => now }))).toBe(0);

      const [s] = await q<{ last_status: string; next_run_at: Date; last_job_id: string }>("SELECT last_status, next_run_at, last_job_id FROM export_schedules WHERE id = $1", [id]);
      expect(s!.last_status).toBe("done");
      expect(s!.next_run_at.toISOString()).toBe("2026-03-09T06:00:00.000Z"); // Monday 07:00 Madrid (CET)
      expect(saved[0]!.filename).toMatch(/^OT_abiertas-2026-03-02\.csv$/);
      expect(saved[0]!.data.toString()).toContain("created");
      expect(await q("SELECT status, row_count FROM export_jobs WHERE id = $1", [s!.last_job_id])).toEqual([{ status: "done", row_count: 1 }]);

      const mails = await q<{ to_address: string; body: string }>("SELECT to_address, body FROM messages ORDER BY to_address");
      expect(mails.map((m) => m.to_address)).toEqual(["a@example.com", "b@example.com"]);
      const token = /\/api\/v1\/shared\/exports\/([\w.-]+)/.exec(mails[0]!.body)![1]!;
      const verified = verifyDownloadToken("link-secret-link-secret", token, now);
      expect(verified?.documentId).toBeTruthy();
      expect(verifyDownloadToken("link-secret-link-secret", token, new Date(now.getTime() + 73 * 3600_000))).toBeNull();
    });

    it("fails visibly when the owner lost the permission or the cron is invalid", async () => {
      const id = await schedule();
      await q("DELETE FROM user_roles WHERE user_id = $1", [userId]);
      expect(await runDueExports(deps({ now: () => new Date("2026-03-02T06:30:00Z") }))).toBe(1);
      expect(await q("SELECT last_status, last_error FROM export_schedules WHERE id = $1", [id])).toEqual([{ last_status: "failed", last_error: expect.stringContaining("permission") }]);
      expect(await q("SELECT status FROM export_jobs WHERE schedule_id = $1", [id])).toEqual([{ status: "failed" }]);
      expect(await q("SELECT 1 FROM messages")).toHaveLength(0);
      await q("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'admin'", [userId]);

      const bad = await schedule({ cron: "not a cron", next_run_at: "2026-03-02T06:00:00Z" });
      await q("UPDATE export_schedules SET next_run_at = NULL WHERE id = $1", [id]);
      await runDueExports(deps({ now: () => new Date("2026-03-02T06:30:00Z") }));
      expect(await q("SELECT enabled, last_error FROM export_schedules WHERE id = $1", [bad])).toEqual([{ enabled: false, last_error: "Invalid cron expression" }]);
    });
  });

  describe("retention purge (ORF-030)", () => {
    it("dry run only counts; a real run purges old data, expired documents and keeps the audit log", async () => {
      await q("INSERT INTO work_orders (status, updated_at) VALUES ('closed', now() - interval '6 years'), ('closed', now() - interval '1 year'), ('created', now() - interval '9 years')");
      await q("INSERT INTO messages (channel_kind, to_address, body, created_at) VALUES ('email', 'x@example.com', 'old', now() - interval '6 years'), ('email', 'y@example.com', 'new', now())");
      await q("INSERT INTO documents (bucket, object_key, filename, retention_until) VALUES ('b', 'expired', 'e.pdf', current_date - 1), ('b', 'valid', 'v.pdf', current_date + 400), ('b', 'forever', 'f.pdf', NULL)");
      await q("INSERT INTO documents (bucket, object_key, filename, deleted_at) VALUES ('b', 'gone', 'g.pdf', now() - interval '40 days'), ('b', 'recent-delete', 'r.pdf', now() - interval '2 days')");
      const removed: string[] = [];
      const deps = { pool: app, log, removeObject: async (_b: string, k: string) => void removed.push(k) };

      const dry = await runRetention(deps, { dryRun: true });
      expect(dry).toMatchObject({ dryRun: true, counts: { work_orders: 1, messages: 1, documents_expired: 1, documents_deleted: 1 } });
      expect(await q("SELECT 1 FROM work_orders")).toHaveLength(3);
      expect(removed).toEqual([]);

      const real = await runRetention(deps);
      expect(real).toMatchObject({ dryRun: false, documentsRemoved: 1, counts: { work_orders: 1, messages: 1 } });
      expect(removed).toEqual(["gone"]);
      expect((await q("SELECT status FROM work_orders ORDER BY status")).map((r) => r.status)).toEqual(["closed", "created"]);
      expect(await q("SELECT body FROM messages")).toEqual([{ body: "new" }]);
      // Expired document is soft-deleted now and physically removed after the grace period.
      expect(await q("SELECT object_key FROM documents WHERE deleted_at IS NULL ORDER BY object_key")).toEqual([{ object_key: "forever" }, { object_key: "valid" }]);
      expect(await q("SELECT 1 FROM audit_log WHERE action = 'retention.purge'")).toHaveLength(1);
      expect(await q("SELECT dry_run, status FROM maintenance_runs ORDER BY started_at")).toEqual([{ dry_run: true, status: "done" }, { dry_run: false, status: "done" }]);
    });

    it("keeps a document whose bytes cannot be removed so the next run retries", async () => {
      await q("INSERT INTO documents (bucket, object_key, filename, deleted_at) VALUES ('b', 'stuck', 's.pdf', now() - interval '40 days')");
      const report = await runRetention({ pool: app, log, removeObject: async () => { throw new Error("s3 down"); } });
      expect(report).toMatchObject({ documentsRemoved: 0, documentErrors: 1 });
      expect(await q("SELECT 1 FROM documents WHERE object_key = 'stuck'")).toHaveLength(1);
    });

    it("the daily scheduler waits for the planned hour and runs once per day", async () => {
      await q("DELETE FROM maintenance_runs");
      const deps = (iso: string) => ({ pool: app, log, now: () => new Date(iso) });
      expect(await runRetentionIfDue(deps("2026-03-02T01:00:00Z"))).toBe(0); // 02:00 Madrid, before 03:00
      expect(await runRetentionIfDue(deps("2026-03-02T02:30:00Z"))).toBe(1);
      await q("UPDATE maintenance_runs SET started_at = '2026-03-02T02:30:00Z'");
      expect(await runRetentionIfDue(deps("2026-03-02T09:00:00Z"))).toBe(0);
      expect(await runRetentionIfDue(deps("2026-03-03T02:10:00Z"))).toBe(1);
    });
  });

  describe("GDPR portability and erasure (RNF-013, RNF-024)", () => {
    async function customer() {
      const c = (await q<{ id: string }>(
        "INSERT INTO customers (code, name, tax_id_enc, email_enc, phone_enc, address, extra, delegation_id) VALUES ('C-GDPR', 'Ana Pérez', pgp_sym_encrypt('12345678Z', $1), pgp_sym_encrypt('ana@example.com', $1), pgp_sym_encrypt('600111222', $1), 'Calle Luna 3', '{\"nota\":\"vive sola\"}', $2) RETURNING id",
        [PII, madrid],
      ))[0]!.id;
      await q("INSERT INTO sites (customer_id, name, address, municipality) VALUES ($1, 'Casa Ana', 'Calle Luna 3', 'Madrid')", [c]);
      await q("INSERT INTO consents (subject_type, subject_id, purpose, granted) VALUES ('customer', $1, 'communications', true)", [c]);
      await q("INSERT INTO messages (channel_kind, to_address, subject, body, entity_type, entity_id) VALUES ('email', 'ana@example.com', 'Su visita', 'Hola Ana', 'customer', $1), ('email', 'other@example.com', 'Otro', 'x', NULL, NULL)", [c]);
      return c;
    }
    const inTx = async <T>(fn: (db: pg.PoolClient) => Promise<T>) => withSystem(owner, fn);

    it("exports everything held about a customer, decrypted, and nothing about anyone else", async () => {
      const c = await customer();
      const bundle = await inTx((db) => exportSubject(db, PII, "customer", c));
      const data = bundle!.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(data.customer).toMatchObject({ name: "Ana Pérez", taxId: "12345678Z", email: "ana@example.com", phone: "600111222" });
      expect(data.customer.tax_id_enc).toBeUndefined();
      expect(data.sites).toHaveLength(1);
      expect(data.consents).toHaveLength(1);
      expect(data.messages.map((m: { to: string }) => m.to)).toEqual(["ana@example.com"]);
      expect(await inTx((db) => exportSubject(db, PII, "customer", "00000000-0000-0000-0000-000000000000"))).toBeNull();
    });

    it("refuses erasure while work is open, then anonymises and keeps legally required records", async () => {
      const c = await customer();
      const w = (await q<{ id: string }>("INSERT INTO work_orders (customer_id, status) VALUES ($1, 'created') RETURNING id", [c]))[0]!.id;
      expect(await inTx((db) => eraseSubject(db, PII, "customer", c))).toMatchObject({ status: "refused", reason: "open_work_orders:1" });
      expect(await q("SELECT name FROM customers WHERE id = $1", [c])).toEqual([{ name: "Ana Pérez" }]);

      await q("UPDATE work_orders SET status = 'closed' WHERE id = $1", [w]);
      const out = await inTx((db) => eraseSubject(db, PII, "customer", c));
      expect(out).toMatchObject({ status: "done", counts: { customers: 1, sites: 1, messages: 1 } });

      const [row] = await q<{ name: string; code: string | null; tax_id_enc: unknown; email_enc: unknown; address: string | null; extra: object; anonymized_at: Date }>("SELECT name, code, tax_id_enc, email_enc, address, extra, anonymized_at FROM customers WHERE id = $1", [c]);
      expect(row).toMatchObject({ code: null, tax_id_enc: null, email_enc: null, address: null, extra: {} });
      expect(row!.name).toMatch(/^Anonimizado /);
      expect(row!.anonymized_at).toBeTruthy();
      expect(await q("SELECT address, name FROM sites WHERE customer_id = $1", [c])).toEqual([{ address: null, name: expect.stringMatching(/^Anonimizado/) }]);
      expect(await q("SELECT to_address, subject, body FROM messages WHERE entity_id = $1", [c])).toEqual([{ to_address: "erased", subject: null, body: expect.stringContaining("RGPD") }]);
      expect(await q("SELECT to_address FROM messages WHERE to_address = 'other@example.com'")).toHaveLength(1);
      expect(await q("SELECT status FROM work_orders WHERE id = $1", [w])).toEqual([{ status: "closed" }]); // the record the law requires stays
      expect(await q("SELECT granted FROM consents WHERE subject_id = $1 ORDER BY at DESC LIMIT 1", [c])).toEqual([{ granted: false }]);
      expect(await inTx((db) => eraseSubject(db, PII, "customer", c))).toMatchObject({ status: "refused", reason: "already_anonymized" });
    });

    it("anonymises a technician once their visits are done", async () => {
      const t = (await q<{ id: string }>("INSERT INTO technicians (code, name, email, home_latitude, home_longitude) VALUES ('T-GDPR', 'Luis Gómez', 'luis@example.com', 40.1, -3.7) RETURNING id"))[0]!.id;
      const w = (await q<{ id: string }>("INSERT INTO work_orders (status) VALUES ('created') RETURNING id"))[0]!.id;
      const v = (await q<{ id: string }>("INSERT INTO visits (work_order_id, technician_id, status) VALUES ($1, $2, 'scheduled') RETURNING id", [w, t]))[0]!.id;
      expect(await inTx((db) => eraseSubject(db, PII, "technician", t))).toMatchObject({ status: "refused", reason: "open_visits:1" });
      await q("UPDATE visits SET status = 'completed' WHERE id = $1", [v]);
      expect(await inTx((db) => eraseSubject(db, PII, "technician", t))).toMatchObject({ status: "done" });
      expect(await q("SELECT email, home_latitude, active, name FROM technicians WHERE id = $1", [t])).toEqual([{ email: null, home_latitude: null, active: false, name: expect.stringMatching(/^Anonimizado/) }]);
    });
  });
});
