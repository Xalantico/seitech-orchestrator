import { withActor, withSystem } from "@orchestrador/db";
import { nextCronRun, validateCron } from "@orchestrador/flowhost";
import { compileExport, getEntity, QueryError, renderExport, type ExportFormat, type QuerySpec } from "@orchestrador/reporting";
import type pg from "pg";

import { hasPermission, loadUserActor } from "./actor.js";
import { signDownloadToken } from "./links.js";
import { queueEmail } from "./mail.js";

export type Logger = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

export type ExportDeps = {
  pool: pg.Pool;
  log: Logger;
  /** Stores the rendered file (object storage + documents table) and returns its id. */
  saveDocument(file: { data: Buffer; filename: string; mime: string; entityId: string; metadata: Record<string, unknown> }): Promise<{ id: string }>;
  publicBaseUrl: string;
  linkSecret: string;
  maxRows: number;
  now?: () => Date;
};

type Schedule = {
  id: string; name: string; saved_filter_id: string | null; entity: string; format: ExportFormat; columns: string[]; cron: string; timezone: string;
  recipients: string[]; definition: QuerySpec; created_by: string | null; link_ttl_hours: number; next_run_at: Date | null;
};

const summarise = (filter: unknown): string => {
  const f = filter as { items?: unknown[]; op?: string; field?: string; value?: unknown } | null | undefined;
  if (!f) return "";
  if (f.items) return f.items.map(summarise).filter(Boolean).join(f.op === "and" ? " y " : " o ");
  return `${f.field} ${f.op}${f.value !== undefined ? ` ${JSON.stringify(f.value)}` : ""}`;
};

/** Next planned run after `from`, or null when the expression is invalid. */
export function nextRunAfter(cron: string, timezone: string, from: Date): Date | null {
  return validateCron(cron, timezone) ? null : nextCronRun(cron, from, timezone);
}

/**
 * Runs every export schedule that is due. Each schedule is claimed (next run moved forward) in its own short transaction
 * before the work starts, so replicas never run the same slot twice and a slow export never blocks the others.
 */
export async function runDueExports(deps: ExportDeps, batch = 10): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const claimed = await withSystem(deps.pool, async (db) => {
    const due = await db.query<Schedule>(
      `SELECT id, name, saved_filter_id, entity, format, columns, cron, timezone, recipients, definition, created_by, link_ttl_hours, next_run_at
         FROM export_schedules WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1
        ORDER BY next_run_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, batch],
    );
    const runnable: Schedule[] = [];
    for (const s of due.rows) {
      const next = nextRunAfter(s.cron, s.timezone, now);
      if (!next) {
        await db.query("UPDATE export_schedules SET enabled = false, last_status = 'failed', last_error = 'Invalid cron expression', updated_at = now() WHERE id = $1", [s.id]);
        continue;
      }
      await db.query("UPDATE export_schedules SET next_run_at = $2, updated_at = now() WHERE id = $1", [s.id, next]);
      runnable.push(s);
    }
    return runnable;
  });
  for (const s of claimed) await runScheduledExport(deps, s, now);
  return claimed.length;
}

export async function runScheduledExport(deps: ExportDeps, s: Schedule, now: Date): Promise<{ jobId: string; documentId: string | null; error?: string }> {
  const job = (await withSystem(deps.pool, (db) =>
    db.query<{ id: string }>("INSERT INTO export_jobs (requested_by, entity, format, filter, columns, status, schedule_id) VALUES ($1, $2, $3, '{}'::jsonb, $4, 'running', $5) RETURNING id", [s.created_by, s.entity, s.format, s.columns, s.id]),
  )).rows[0]!.id;

  try {
    const entity = getEntity(s.entity);
    if (!entity) throw new Error(`Unknown entity "${s.entity}"`);
    const owner = s.created_by ? await withSystem(deps.pool, (db) => loadUserActor(db, s.created_by!)) : null;
    if (!owner) throw new Error("The owner of this schedule is no longer an active user");
    if (!hasPermission(owner, "exports:run") || !hasPermission(owner, entity.permission)) throw new Error("The owner of this schedule no longer has permission to export this data");

    let spec: QuerySpec = { ...(s.definition ?? {}) };
    if (s.saved_filter_id) {
      const sf = (await withSystem(deps.pool, (db) => db.query<{ definition: QuerySpec; entity: string }>("SELECT definition, entity FROM saved_filters WHERE id = $1", [s.saved_filter_id]))).rows[0];
      if (!sf || sf.entity !== s.entity) throw new Error("The saved filter of this schedule no longer exists");
      spec = { ...sf.definition, ...spec };
    }
    if (s.columns.length > 0) spec = { ...spec, columns: s.columns };

    // The data is read with the owner's scope, exactly as if they had pressed Export.
    const { compiled, rows } = await withActor(deps.pool, owner.actor, async (db) => {
      const c = compileExport(entity, spec, deps.maxRows, now);
      return { compiled: c, rows: (await db.query(c.select, c.params)).rows as Record<string, unknown>[] };
    });
    const rendered = await renderExport(s.format, { title: `${s.name} · ${entity.label}`, columns: compiled.columns, rows, generatedAt: now, filterSummary: summarise(spec.filter) });
    const filename = `${s.name.replace(/[^\w.-]+/g, "_")}-${now.toISOString().slice(0, 10)}.${rendered.extension}`;
    const doc = await deps.saveDocument({ data: rendered.data, filename, mime: rendered.mime, entityId: job, metadata: { entity: entity.key, rows: rows.length, scheduleId: s.id } });

    await withSystem(deps.pool, async (db) => {
      await db.query("SELECT set_config('app.actor', 'export-scheduler', true)");
      await db.query("UPDATE export_jobs SET status = 'done', row_count = $2, document_id = $3, finished_at = now() WHERE id = $1", [job, rows.length, doc.id]);
      await db.query("UPDATE export_schedules SET last_run_at = $2, last_status = 'done', last_error = NULL, last_job_id = $3, updated_at = now() WHERE id = $1", [s.id, now, job]);
      await db.query("SELECT audit_event('export.scheduled', $1, $2, $3::jsonb)", [entity.key, job, JSON.stringify({ schedule: s.id, format: s.format, rows: rows.length, recipients: s.recipients.length })]);
      if (s.recipients.length > 0) {
        const expires = new Date(now.getTime() + s.link_ttl_hours * 3_600_000);
        const link = `${deps.publicBaseUrl.replace(/\/+$/, "")}/api/v1/shared/exports/${signDownloadToken(deps.linkSecret, { documentId: doc.id, expiresAt: expires })}`;
        for (const to of s.recipients) {
          await queueEmail(db, {
            to,
            subject: `${s.name}: informe del ${now.toISOString().slice(0, 10)}`,
            text: `El informe «${s.name}» (${entity.label}, ${rows.length} filas) está listo.\n\nDescárgalo aquí: ${link}\n\nEl enlace caduca el ${expires.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
            entityType: "export_schedule",
            entityId: s.id,
          });
        }
      }
    });
    deps.log.info({ schedule: s.id, rows: rows.length, recipients: s.recipients.length }, "scheduled export done");
    return { jobId: job, documentId: doc.id };
  } catch (error) {
    const message = (error instanceof QueryError ? error.message : error instanceof Error ? error.message : "failed").slice(0, 500);
    await withSystem(deps.pool, async (db) => {
      await db.query("UPDATE export_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [job, message]);
      await db.query("UPDATE export_schedules SET last_run_at = $2, last_status = 'failed', last_error = $3, last_job_id = $4, updated_at = now() WHERE id = $1", [s.id, now, message, job]);
    });
    deps.log.warn({ schedule: s.id, err: message }, "scheduled export failed");
    return { jobId: job, documentId: null, error: message };
  }
}
