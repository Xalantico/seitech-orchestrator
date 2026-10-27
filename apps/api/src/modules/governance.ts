import { OpenAPIHono } from "@hono/zod-openapi";
import { DEFAULT_RETENTION, eraseSubject, exportSubject, runRetention, signDashboardEmbed } from "@orchestrador/backoffice";

import { env } from "../env.js";
import { zUuid } from "../lib/crud.js";
import { pool, run } from "../lib/db.js";
import { HttpError, conflict, notFound } from "../lib/errors.js";
import { gateways } from "../lib/gateways.js";
import { readDocument } from "../lib/documents.js";
import { define, z } from "../lib/route.js";
import { log, store } from "../lib/services.js";
import type { AppEnv } from "../lib/types.js";

export const governance = new OpenAPIHono<AppEnv>();
const TAG = "Governance";

const policy = () => ({ ...DEFAULT_RETENTION, operationalYears: env.RETENTION_OPERATIONAL_YEARS });

// ───────────── governance centre overview (ORF-054) ─────────────
define(governance, { method: "get", path: "/governance/overview", tag: TAG, summary: "One-page state of security, audit, data protection and retention", permission: "audit:read" }, async (c) => {
  const out = await run(c, async (db) => {
    const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T & Record<string, unknown>>(sql, params)).rows[0]!;
    const audit = await one<{ last_24h: number; last_7d: number }>("SELECT count(*) FILTER (WHERE at > now() - interval '1 day')::int AS last_24h, count(*) FILTER (WHERE at > now() - interval '7 days')::int AS last_7d FROM audit_log WHERE at > now() - interval '7 days'");
    const topActions = (await db.query("SELECT action, count(*)::int AS n FROM audit_log WHERE at > now() - interval '7 days' GROUP BY action ORDER BY n DESC LIMIT 6")).rows;
    const users = await one<{ active: number; blocked: number; mfa: number; without_role: number }>(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
              count(*) FILTER (WHERE status = 'active' AND mfa_enrolled)::int AS mfa,
              count(*) FILTER (WHERE status = 'active' AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = users.id))::int AS without_role FROM users`);
    const toxic = (await db.query(
      `SELECT u.email::text AS email, t.role_a, t.role_b, t.reason FROM toxic_role_combinations t
         JOIN roles ra ON ra.key = t.role_a JOIN roles rb ON rb.key = t.role_b
         JOIN user_roles ua ON ua.role_id = ra.id JOIN user_roles ub ON ub.role_id = rb.id AND ub.user_id = ua.user_id JOIN users u ON u.id = ua.user_id ORDER BY u.email LIMIT 50`)).rows;
    const documents = await one<{ total: number; expiring_30d: number; infected: number; deleted: number }>(
      `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS total,
              count(*) FILTER (WHERE deleted_at IS NULL AND retention_until BETWEEN current_date AND current_date + 30)::int AS expiring_30d,
              count(*) FILTER (WHERE scan_status = 'infected')::int AS infected, count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted FROM documents`);
    const privacy = await one<{ anonymised: number; requests_30d: number; withdrawn: number }>(
      `SELECT (SELECT count(*)::int FROM customers WHERE anonymized_at IS NOT NULL) AS anonymised,
              (SELECT count(*)::int FROM gdpr_requests WHERE created_at > now() - interval '30 days') AS requests_30d,
              (SELECT count(*)::int FROM customers WHERE NOT consent_comms) AS withdrawn`);
    const runs = (await db.query("SELECT id, kind, dry_run, status, started_at, finished_at, detail->'counts' AS counts FROM maintenance_runs WHERE kind = 'retention' ORDER BY started_at DESC LIMIT 5")).rows;
    const integrations = await one<{ connectors: number; open_errors: number }>("SELECT (SELECT count(*)::int FROM connectors WHERE enabled) AS connectors, (SELECT count(*)::int FROM integration_errors WHERE NOT resolved) AS open_errors");
    return { audit: { ...audit, topActions }, users, toxicRoleHolders: toxic, documents, privacy, retention: { policy: policy(), runs }, integrations, generatedAt: new Date().toISOString() };
  });
  return c.json(out);
});

// ───────────── retention (ORF-030) ─────────────
define(governance, { method: "get", path: "/governance/retention", tag: TAG, summary: "Retention policy and the latest purge runs", permission: "audit:read" }, async (c) => {
  const runs = await run(c, (db) => db.query("SELECT id, dry_run, status, detail, error, triggered_by, started_at, finished_at FROM maintenance_runs WHERE kind = 'retention' ORDER BY started_at DESC LIMIT 20"));
  return c.json({ policy: policy(), schedule: "0 3 * * * (Europe/Madrid)", runs: runs.rows });
});

define(governance, {
  method: "post", path: "/governance/retention/run", tag: TAG, summary: "Run the retention purge now (preview first with dryRun)", permission: "system:admin", body: z.object({ dryRun: z.boolean().default(true) }),
}, async (c, i) => {
  const p = c.get("principal");
  const report = await runRetention({ pool, log, policy: policy(), removeObject: (bucket, key) => store.remove(bucket, key) }, { dryRun: i.body.dryRun, triggeredBy: p.label });
  if ("skipped" in report) throw conflict("A purge is already running", "already_running");
  return c.json(report);
});

// ───────────── GDPR: portability and erasure (RNF-013, RNF-024) ─────────────
const subjectParams = z.object({ subjectType: z.enum(["customer", "technician"]), id: zUuid });

define(governance, { method: "post", path: "/gdpr/{subjectType}/{id}/export", tag: TAG, summary: "Export everything held about a person (right of access / portability)", permission: "gdpr:manage", params: subjectParams, status: 201 }, async (c, i) => {
  const p = c.get("principal");
  const bundle = await run(c, (db) => exportSubject(db, env.piiKey, i.params.subjectType, i.params.id));
  if (!bundle) throw notFound("Subject");
  const doc = await gateways.documents.save({
    data: Buffer.from(JSON.stringify(bundle, null, 2)), filename: `gdpr-${i.params.subjectType}-${i.params.id.slice(0, 8)}.json`, mime: "application/json", kind: "gdpr_export", entityType: i.params.subjectType, entityId: i.params.id, metadata: { gdpr: true },
  });
  const counts = Object.fromEntries(Object.entries(bundle.data).map(([k, v]) => [k, Array.isArray(v) ? v.length : 1]));
  const request = await run(c, async (db) => {
    const r = await db.query<{ id: string }>("INSERT INTO gdpr_requests (kind, subject_type, subject_id, status, result, document_id, requested_by) VALUES ('export', $1, $2, 'done', $3::jsonb, $4, $5) RETURNING id", [i.params.subjectType, i.params.id, JSON.stringify({ counts }), doc.id, p.kind === "user" ? p.id : null]);
    await db.query("SELECT audit_event('gdpr.export', $1, $2, $3::jsonb)", [i.params.subjectType, i.params.id, JSON.stringify({ request: r.rows[0]!.id })]);
    return r.rows[0]!.id;
  });
  return c.json({ requestId: request, documentId: doc.id, counts }, 201);
});

define(governance, {
  method: "post", path: "/gdpr/{subjectType}/{id}/erase", tag: TAG, summary: "Erase a person by anonymisation (right to be forgotten)", permission: "gdpr:manage", params: subjectParams,
  description: "Irreversible. Legally required records (work orders, certificates, billing) are kept without any link to the person. Refused while the person has open work.",
  body: z.object({ confirm: z.literal(true), reason: z.string().min(5).max(500) }),
}, async (c, i) => {
  const p = c.get("principal");
  const by = p.kind === "user" ? p.id : null;
  const outcome = await run(c, async (db) => {
    const r = await eraseSubject(db, env.piiKey, i.params.subjectType, i.params.id);
    if (r.status === "done") {
      await db.query("INSERT INTO gdpr_requests (kind, subject_type, subject_id, status, reason, result, requested_by) VALUES ('erase', $1, $2, 'done', $3, $4::jsonb, $5)", [i.params.subjectType, i.params.id, i.body.reason, JSON.stringify({ counts: r.counts }), by]);
      await db.query("SELECT audit_event('gdpr.erase', $1, $2, $3::jsonb)", [i.params.subjectType, i.params.id, JSON.stringify({ counts: r.counts })]);
    }
    return r;
  });
  if (outcome.status === "refused") {
    if (outcome.reason === "not_found") throw notFound("Subject");
    await run(c, (db) => db.query("INSERT INTO gdpr_requests (kind, subject_type, subject_id, status, reason, result, requested_by) VALUES ('erase', $1, $2, 'refused', $3, $4::jsonb, $5)", [i.params.subjectType, i.params.id, i.body.reason, JSON.stringify({ refusal: outcome.reason }), by]));
    throw new HttpError(409, outcome.reason === "already_anonymized" ? "This person is already anonymised" : `Erasure refused: ${outcome.reason}`, outcome.reason?.split(":")[0] ?? "refused", { reason: outcome.reason });
  }
  return c.json({ status: "done", counts: outcome.counts });
});

define(governance, { method: "get", path: "/gdpr/requests", tag: TAG, summary: "GDPR requests handled", permission: "gdpr:manage", query: z.object({ subjectId: zUuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }, async (c, i) => {
  const r = await run(c, (db) => db.query(
    `SELECT g.id, g.kind, g.subject_type, g.subject_id, g.status, g.reason, g.result, g.document_id, g.created_at, u.email::text AS requested_by
       FROM gdpr_requests g LEFT JOIN users u ON u.id = g.requested_by WHERE ($1::uuid IS NULL OR g.subject_id = $1) ORDER BY g.created_at DESC LIMIT ${i.query.limit}`,
    [i.query.subjectId ?? null],
  ));
  return c.json({ items: r.rows });
});

define(governance, { method: "get", path: "/gdpr/requests/{id}/bundle", tag: TAG, summary: "Download the data bundle of an export request", permission: "gdpr:manage", params: z.object({ id: zUuid }) }, async (c, i) => {
  const row = (await run(c, (db) => db.query<{ document_id: string | null }>("SELECT document_id FROM gdpr_requests WHERE id = $1 AND kind = 'export'", [i.params.id]))).rows[0];
  if (!row?.document_id) throw notFound("Export");
  const doc = await readDocument(c, row.document_id, "download");
  c.header("content-type", doc.mime);
  c.header("content-disposition", `attachment; filename="${encodeURIComponent(doc.filename)}"`);
  c.header("cache-control", "private, no-store");
  return c.body(new Uint8Array(doc.body));
});

// ───────────── BI dashboards (ORF-053) ─────────────
define(governance, { method: "get", path: "/bi/dashboards", tag: TAG, summary: "BI dashboards with short-lived signed embed URLs", permission: "bi:read" }, async (c) => {
  const p = c.get("principal");
  if (!env.METABASE_SITE_URL || !env.METABASE_EMBEDDING_SECRET) return c.json({ configured: false, items: [] });
  // People who only see some delegations get the dashboards locked to those delegations.
  const delegations = p.scopeAll ? null : (await run(c, (db) => db.query<{ name: string }>("SELECT name FROM delegations WHERE id = ANY($1::uuid[])", [p.scopes.map((s) => s.d).filter((d): d is string => Boolean(d))]))).rows.map((r) => r.name);
  const items = env.dashboards.map((d) => ({
    ...d,
    ...signDashboardEmbed({ siteUrl: env.METABASE_SITE_URL!, secret: env.METABASE_EMBEDDING_SECRET!, dashboardId: d.id, ttlMinutes: 10, params: delegations ? { delegacion: delegations } : {} }),
  }));
  return c.json({ configured: true, items });
});
