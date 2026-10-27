import { OpenAPIHono } from "@hono/zod-openapi";
import { ALERT_METRICS, evaluateAlerts, nextRunAfter, runScheduledExport, verifyDownloadToken, type ExportDeps } from "@orchestrador/backoffice";
import { validateCron } from "@orchestrador/flowhost";
import { getEntity, getKpi } from "@orchestrador/reporting";

import { env } from "../env.js";
import { zUuid } from "../lib/crud.js";
import { pool, run, runSystem } from "../lib/db.js";
import { HttpError, conflict, forbidden, notFound } from "../lib/errors.js";
import { gateways } from "../lib/gateways.js";
import { can } from "../lib/principal.js";
import { define, z } from "../lib/route.js";
import { log, store } from "../lib/services.js";
import type { AppEnv } from "../lib/types.js";
import { specSchema } from "./query.js";

export const backoffice = new OpenAPIHono<AppEnv>();
const TAG = "Back office";
const idParam = z.object({ id: zUuid });

/** Dependencies the scheduler needs when the API runs an export on demand (the worker builds the same set). */
export const exportDeps = (): ExportDeps => ({
  pool,
  log,
  publicBaseUrl: env.publicBaseUrl,
  linkSecret: env.linkSecret,
  maxRows: env.EXPORT_MAX_ROWS,
  saveDocument: (f) => gateways.documents.save({ data: f.data, filename: f.filename, mime: f.mime, kind: "export", entityType: "export", entityId: f.entityId, metadata: f.metadata }),
});

// ───────────── scheduled exports (ORF-042) ─────────────
const scheduleBody = z.object({
  name: z.string().min(1).max(120),
  entity: z.string().min(1),
  format: z.enum(["csv", "xlsx", "pdf"]).default("xlsx"),
  cron: z.string().min(9).max(120),
  timezone: z.string().min(3).max(60).default("Europe/Madrid"),
  recipients: z.array(z.string().email()).max(20).default([]),
  savedFilterId: zUuid.nullable().optional(),
  definition: specSchema.default({}),
  columns: z.array(z.string()).max(60).default([]),
  linkTtlHours: z.number().int().min(1).max(720).default(72),
  enabled: z.boolean().default(true),
});

const SCHEDULE_COLS = `id, name, entity, format, cron, timezone, recipients, saved_filter_id, definition, columns, link_ttl_hours, enabled, next_run_at, last_run_at,
  last_status, last_error, last_job_id, created_by, created_at`;

function checkSchedule(p: Parameters<typeof can>[0], b: z.infer<typeof scheduleBody>) {
  const entity = getEntity(b.entity);
  if (!entity) throw new HttpError(400, `Unknown entity "${b.entity}"`, "bad_entity");
  if (!can(p, entity.permission)) throw forbidden(`Missing permission ${entity.permission}`);
  const cronProblem = validateCron(b.cron, b.timezone);
  if (cronProblem) throw new HttpError(400, `Invalid schedule: ${cronProblem}`, "bad_cron");
  const next = nextRunAfter(b.cron, b.timezone, new Date());
  // A schedule that fires more often than every 15 minutes would hammer the database for no reporting value.
  const after = next && nextRunAfter(b.cron, b.timezone, next);
  if (next && after && after.getTime() - next.getTime() < 15 * 60_000) throw new HttpError(400, "Scheduled exports can run at most every 15 minutes", "too_frequent");
  return next;
}

const mine = (p: Parameters<typeof can>[0]) => !(can(p, "audit:read"));

define(backoffice, { method: "get", path: "/export-schedules", tag: TAG, summary: "Scheduled exports (yours; all for auditors)", permission: "exports:schedule" }, async (c) => {
  const p = c.get("principal");
  const r = await run(c, (db) => db.query(`SELECT ${SCHEDULE_COLS} FROM export_schedules WHERE ($1::boolean = false OR created_by = $2) ORDER BY name`, [mine(p), p.id]));
  return c.json({ items: r.rows });
});

define(backoffice, { method: "post", path: "/export-schedules", tag: TAG, summary: "Schedule an export: runs on a cron and mails an expiring download link", permission: "exports:schedule", body: scheduleBody, status: 201 }, async (c, i) => {
  const p = c.get("principal");
  const next = checkSchedule(p, i.body);
  const r = await run(c, async (db) => {
    if (i.body.savedFilterId) {
      const sf = (await db.query<{ entity: string }>("SELECT entity FROM saved_filters WHERE id = $1", [i.body.savedFilterId])).rows[0];
      if (!sf || sf.entity !== i.body.entity) throw new HttpError(400, "That saved filter does not belong to this entity", "bad_filter");
    }
    const row = await db.query(
      `INSERT INTO export_schedules (name, entity, format, cron, timezone, recipients, saved_filter_id, definition, columns, link_ttl_hours, enabled, next_run_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13) RETURNING ${SCHEDULE_COLS}`,
      [i.body.name, i.body.entity, i.body.format, i.body.cron, i.body.timezone, i.body.recipients, i.body.savedFilterId ?? null, JSON.stringify(i.body.definition), i.body.columns, i.body.linkTtlHours, i.body.enabled, next, p.kind === "user" ? p.id : null],
    );
    await db.query("SELECT audit_event('export_schedule.create', 'export_schedule', $1, $2::jsonb)", [row.rows[0].id, JSON.stringify({ entity: i.body.entity, cron: i.body.cron })]);
    return row.rows[0];
  });
  return c.json(r, 201);
});

async function ownedSchedule(c: Parameters<typeof run>[0], id: string, p: Parameters<typeof can>[0]) {
  const s = (await run(c, (db) => db.query<{ created_by: string | null }>("SELECT created_by FROM export_schedules WHERE id = $1", [id]))).rows[0];
  if (!s) throw notFound("Schedule");
  if (s.created_by !== p.id && !can(p, "audit:read")) throw forbidden("Only the owner can change this schedule");
}

define(backoffice, { method: "put", path: "/export-schedules/{id}", tag: TAG, summary: "Edit a scheduled export", permission: "exports:schedule", params: idParam, body: scheduleBody }, async (c, i) => {
  const p = c.get("principal");
  await ownedSchedule(c, i.params.id, p);
  const next = checkSchedule(p, i.body);
  const r = await run(c, (db) => db.query(
    `UPDATE export_schedules SET name = $2, entity = $3, format = $4, cron = $5, timezone = $6, recipients = $7, saved_filter_id = $8, definition = $9::jsonb, columns = $10,
            link_ttl_hours = $11, enabled = $12, next_run_at = CASE WHEN $12 THEN $13 ELSE NULL END, updated_at = now() WHERE id = $1 RETURNING ${SCHEDULE_COLS}`,
    [i.params.id, i.body.name, i.body.entity, i.body.format, i.body.cron, i.body.timezone, i.body.recipients, i.body.savedFilterId ?? null, JSON.stringify(i.body.definition), i.body.columns, i.body.linkTtlHours, i.body.enabled, next],
  ));
  return c.json(r.rows[0]);
});

define(backoffice, { method: "delete", path: "/export-schedules/{id}", tag: TAG, summary: "Delete a scheduled export", permission: "exports:schedule", params: idParam }, async (c, i) => {
  await ownedSchedule(c, i.params.id, c.get("principal"));
  await run(c, async (db) => {
    await db.query("DELETE FROM export_schedules WHERE id = $1", [i.params.id]);
    await db.query("SELECT audit_event('export_schedule.delete', 'export_schedule', $1, '{}'::jsonb)", [i.params.id]);
  });
  return c.json({ ok: true });
});

define(backoffice, { method: "post", path: "/export-schedules/{id}/run", tag: TAG, summary: "Run a scheduled export now (does not move its next planned run)", permission: "exports:schedule", params: idParam }, async (c, i) => {
  await ownedSchedule(c, i.params.id, c.get("principal"));
  const s = (await runSystem((db) => db.query(
    "SELECT id, name, saved_filter_id, entity, format, columns, cron, timezone, recipients, definition, created_by, link_ttl_hours, next_run_at FROM export_schedules WHERE id = $1",
    [i.params.id],
  ))).rows[0];
  if (!s) throw notFound("Schedule");
  const out = await runScheduledExport(exportDeps(), s, new Date());
  if (out.error) throw conflict(out.error, "export_failed");
  return c.json({ jobId: out.jobId, documentId: out.documentId });
});

// ───────────── signed download links (public) ─────────────
define(backoffice, {
  method: "get", path: "/shared/exports/{token}", tag: TAG, summary: "Download an export through an expiring signed link", public: true, params: z.object({ token: z.string().min(20).max(600) }),
  description: "Authorised by the signature in the link, not by a session. Links expire; every download is logged against the document.",
}, async (c, i) => {
  const verified = verifyDownloadToken(env.linkSecret, i.params.token);
  if (!verified) throw new HttpError(410, "This link is invalid or has expired", "link_expired");
  const doc = await runSystem(async (db) => {
    const d = (await db.query<{ id: string; bucket: string; object_key: string; filename: string; mime: string; kind: string }>(
      "SELECT id, bucket, object_key, filename, mime, kind FROM documents WHERE id = $1 AND deleted_at IS NULL AND kind = 'export'", [verified.documentId],
    )).rows[0];
    if (d) await db.query("INSERT INTO document_access_log (document_id, action, actor, ip) VALUES ($1, 'download', 'shared-link', nullif(current_setting('app.ip', true), ''))", [d.id]);
    return d;
  });
  if (!doc) throw new HttpError(410, "This link is invalid or has expired", "link_expired");
  const object = await store.get(doc.bucket, doc.object_key);
  c.header("content-type", doc.mime);
  c.header("content-disposition", `attachment; filename="${encodeURIComponent(doc.filename)}"`);
  c.header("cache-control", "private, no-store");
  return c.body(new Uint8Array(object.body));
});

// ───────────── threshold alerts (ORF-040) ─────────────
const ruleBody = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(500).optional(),
  metric: z.string().min(1),
  operator: z.enum(["gt", "gte", "lt", "lte", "eq"]).default("gt"),
  threshold: z.number().finite(),
  severity: z.enum(["info", "warning", "critical"]).default("warning"),
  recipients: z.array(z.string().email()).max(30).default([]),
  delegationId: zUuid.nullable().optional(),
  renotifyHours: z.number().int().min(1).max(720).default(24),
  enabled: z.boolean().default(true),
});
const RULE_COLS = "id, name, description, metric, operator, threshold, severity, recipients, delegation_id, renotify_hours, enabled, last_evaluated_at, last_value, created_at";

define(backoffice, { method: "get", path: "/alert-metrics", tag: TAG, summary: "Indicators an alert rule can watch", permission: "alerts:read" }, (c) => c.json({ items: ALERT_METRICS }));

define(backoffice, { method: "get", path: "/alert-rules", tag: TAG, summary: "Alert rules", permission: "alerts:read" }, async (c) => {
  const r = await run(c, (db) => db.query(`SELECT ${RULE_COLS}, (SELECT count(*)::int FROM alerts a WHERE a.rule_id = alert_rules.id AND a.status <> 'resolved') AS open_alerts FROM alert_rules ORDER BY name`));
  return c.json({ items: r.rows });
});

define(backoffice, { method: "post", path: "/alert-rules", tag: TAG, summary: "Create an alert rule", permission: "alerts:write", body: ruleBody, status: 201 }, async (c, i) => {
  if (!getKpi(i.body.metric)) throw new HttpError(400, `Unknown metric "${i.body.metric}"`, "bad_metric");
  const p = c.get("principal");
  const r = await run(c, async (db) => {
    const row = await db.query(
      `INSERT INTO alert_rules (name, description, metric, operator, threshold, severity, recipients, delegation_id, renotify_hours, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${RULE_COLS}`,
      [i.body.name, i.body.description ?? null, i.body.metric, i.body.operator, i.body.threshold, i.body.severity, i.body.recipients, i.body.delegationId ?? null, i.body.renotifyHours, i.body.enabled, p.kind === "user" ? p.id : null],
    );
    await db.query("SELECT audit_event('alert_rule.create', 'alert_rule', $1, $2::jsonb)", [row.rows[0].id, JSON.stringify({ metric: i.body.metric, threshold: i.body.threshold })]);
    return row.rows[0];
  });
  return c.json(r, 201);
});

define(backoffice, { method: "put", path: "/alert-rules/{id}", tag: TAG, summary: "Edit an alert rule", permission: "alerts:write", params: idParam, body: ruleBody }, async (c, i) => {
  if (!getKpi(i.body.metric)) throw new HttpError(400, `Unknown metric "${i.body.metric}"`, "bad_metric");
  const r = await run(c, async (db) => {
    const row = await db.query(
      `UPDATE alert_rules SET name = $2, description = $3, metric = $4, operator = $5, threshold = $6, severity = $7, recipients = $8, delegation_id = $9, renotify_hours = $10, enabled = $11, updated_at = now()
        WHERE id = $1 RETURNING ${RULE_COLS}`,
      [i.params.id, i.body.name, i.body.description ?? null, i.body.metric, i.body.operator, i.body.threshold, i.body.severity, i.body.recipients, i.body.delegationId ?? null, i.body.renotifyHours, i.body.enabled],
    );
    if (row.rows[0]) await db.query("SELECT audit_event('alert_rule.update', 'alert_rule', $1, $2::jsonb)", [i.params.id, JSON.stringify({ metric: i.body.metric, threshold: i.body.threshold, enabled: i.body.enabled })]);
    return row.rows[0];
  });
  if (!r) throw notFound("Alert rule");
  return c.json(r);
});

define(backoffice, { method: "delete", path: "/alert-rules/{id}", tag: TAG, summary: "Delete an alert rule and its alerts", permission: "alerts:write", params: idParam }, async (c, i) => {
  const r = await run(c, async (db) => {
    const d = await db.query("DELETE FROM alert_rules WHERE id = $1", [i.params.id]);
    if (d.rowCount) await db.query("SELECT audit_event('alert_rule.delete', 'alert_rule', $1, '{}'::jsonb)", [i.params.id]);
    return d.rowCount;
  });
  if (!r) throw notFound("Alert rule");
  return c.json({ ok: true });
});

define(backoffice, { method: "get", path: "/alerts", tag: TAG, summary: "Alerts, most recent first", permission: "alerts:read", query: z.object({ status: z.enum(["firing", "acknowledged", "resolved", "open"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }, async (c, i) => {
  const status = i.query.status as string | undefined;
  const r = await run(c, (db) => db.query(
    `SELECT a.id, a.status, a.value, a.last_value, a.message, a.fired_at, a.resolved_at, a.acknowledged_at, r.id AS rule_id, r.name AS rule, r.metric, r.severity
       FROM alerts a JOIN alert_rules r ON r.id = a.rule_id
      WHERE ($1::text IS NULL OR ($1 = 'open' AND a.status <> 'resolved') OR a.status = $1) ORDER BY a.fired_at DESC LIMIT ${i.query.limit}`,
    [status ?? null],
  ));
  return c.json({ items: r.rows });
});

define(backoffice, { method: "post", path: "/alerts/{id}/acknowledge", tag: TAG, summary: "Take ownership of a firing alert (stops reminders until it resolves)", permission: "alerts:write", params: idParam }, async (c, i) => {
  const p = c.get("principal");
  const r = await run(c, async (db) => {
    const row = await db.query("UPDATE alerts SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), updated_at = now() WHERE id = $1 AND status = 'firing' RETURNING id, status", [i.params.id, p.kind === "user" ? p.id : null]);
    if (row.rows[0]) await db.query("SELECT audit_event('alert.acknowledge', 'alert', $1, '{}'::jsonb)", [i.params.id]);
    return row.rows[0];
  });
  if (!r) throw conflict("The alert does not exist or is not firing", "not_firing");
  return c.json(r);
});

define(backoffice, { method: "post", path: "/alerts/evaluate", tag: TAG, summary: "Evaluate all alert rules now", permission: "alerts:write" }, async (c) => {
  return c.json(await evaluateAlerts({ pool, log, publicBaseUrl: env.publicBaseUrl }));
});
