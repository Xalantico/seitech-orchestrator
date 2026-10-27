import { withSystem } from "@orchestrador/db";
import { nextCronRun } from "@orchestrador/flowhost";
import type pg from "pg";

import type { Logger } from "./exports.js";

/**
 * Retention policy, in code on purpose (ORF-030): changing how long data lives is a reviewed change, not a setting.
 * The audit log is never purged here: its hash chain would break, and it is the evidence for everything else.
 */
export type RetentionPolicy = {
  /** Closed work orders, their messages and integration traffic are removed after this many years. */
  operationalYears: number;
  /** Engine step history is bulky and only useful for diagnosis. */
  executionEventsDays: number;
  /** Inbox/outbox rows already processed; the business effect is in the domain tables. */
  integrationDays: number;
  /** Soft-deleted documents are physically removed after this grace period. */
  deletedDocumentGraceDays: number;
};

export const DEFAULT_RETENTION: RetentionPolicy = { operationalYears: 5, executionEventsDays: 365, integrationDays: 180, deletedDocumentGraceDays: 30 };

export type RetentionDeps = {
  pool: pg.Pool;
  log: Logger;
  policy?: Partial<RetentionPolicy>;
  /** Deletes the stored bytes of a document; failures keep the row so the next run retries. */
  removeObject?: (bucket: string, key: string) => Promise<void>;
  now?: () => Date;
};

export type RetentionReport = {
  runId: string;
  dryRun: boolean;
  policy: RetentionPolicy;
  counts: Record<string, number>;
  documentsRemoved: number;
  documentErrors: number;
};

export async function runRetention(deps: RetentionDeps, opts: { dryRun?: boolean; triggeredBy?: string } = {}): Promise<RetentionReport | { skipped: true }> {
  const policy = { ...DEFAULT_RETENTION, ...deps.policy };
  const now = deps.now?.() ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const day = 86_400_000;
  const cutoffs = {
    executionEvents: new Date(now.getTime() - policy.executionEventsDays * day),
    integration: new Date(now.getTime() - policy.integrationDays * day),
    deletedDocs: new Date(now.getTime() - policy.deletedDocumentGraceDays * day),
  };

  const run = (await withSystem(deps.pool, async (db) => {
    // One purge at a time across replicas.
    const lock = (await db.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('orq-retention')) AS ok")).rows[0]!.ok;
    if (!lock) return null;
    return (await db.query<{ id: string }>("INSERT INTO maintenance_runs (kind, dry_run, triggered_by) VALUES ('retention', $1, $2) RETURNING id", [dryRun, opts.triggeredBy ?? "scheduler"])).rows[0]!.id;
  }));
  if (!run) return { skipped: true };

  try {
    const counts: Record<string, number> = {};
    let documentsRemoved = 0;
    let documentErrors = 0;

    await withSystem(deps.pool, async (db) => {
      await db.query("SELECT set_config('app.actor', 'retention', true)");
      const count = async (key: string, sql: string, params: unknown[]) => void (counts[key] = (await db.query<{ n: number }>(sql, params)).rows[0]!.n);
      const interval = `${policy.operationalYears} years`;
      if (dryRun) {
        await count("execution_events", "SELECT count(*)::int AS n FROM execution_events WHERE created_at < $1", [cutoffs.executionEvents]);
        await count("messages", "SELECT count(*)::int AS n FROM messages WHERE created_at < now() - $1::interval", [interval]);
        await count("inbox_events", "SELECT count(*)::int AS n FROM inbox_events WHERE received_at < $1 AND status = 'processed'", [cutoffs.integration]);
        await count("outbox_events", "SELECT count(*)::int AS n FROM outbox_events WHERE created_at < $1 AND status IN ('sent', 'dead')", [cutoffs.integration]);
        await count("work_orders", "SELECT count(*)::int AS n FROM work_orders WHERE status IN ('closed', 'cancelled') AND updated_at < now() - $1::interval", [interval]);
      } else {
        await db.query("DELETE FROM execution_events WHERE created_at < $1", [cutoffs.executionEvents]).then((r) => void (counts.execution_events = r.rowCount ?? 0));
        await db.query("DELETE FROM inbox_events WHERE received_at < $1 AND status = 'processed'", [cutoffs.integration]).then((r) => void (counts.inbox_events = r.rowCount ?? 0));
        await db.query("DELETE FROM outbox_events WHERE created_at < $1 AND status IN ('sent', 'dead')", [cutoffs.integration]).then((r) => void (counts.outbox_events = r.rowCount ?? 0));
        // The SQL function applies the long operational window to closed work orders and messages.
        const purged = await db.query<{ entity: string; purged: string }>("SELECT entity, purged FROM purge_operational_data($1::interval)", [interval]);
        for (const p of purged.rows) if (p.entity === "messages" || p.entity === "work_orders") counts[p.entity] = Number(p.purged);
      }
      await count("documents_expired", "SELECT count(*)::int AS n FROM documents WHERE deleted_at IS NULL AND retention_until IS NOT NULL AND retention_until < $1::date", [now]);
      await count("documents_deleted", "SELECT count(*)::int AS n FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < $1", [cutoffs.deletedDocs]);
    });

    if (!dryRun) {
      // Past their retention date, documents are soft-deleted first (visible in the audit), then physically removed after the grace period.
      await withSystem(deps.pool, async (db) => {
        await db.query("SELECT set_config('app.actor', 'retention', true)");
        await db.query("UPDATE documents SET deleted_at = $1 WHERE deleted_at IS NULL AND retention_until IS NOT NULL AND retention_until < $1::date", [now]);
      });
      const doomed = (await withSystem(deps.pool, (db) => db.query<{ id: string; bucket: string; object_key: string }>(
        "SELECT id, bucket, object_key FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < $1 ORDER BY deleted_at LIMIT 500", [cutoffs.deletedDocs],
      ))).rows;
      for (const d of doomed) {
        try {
          await deps.removeObject?.(d.bucket, d.object_key);
          await withSystem(deps.pool, (db) => db.query("DELETE FROM documents WHERE id = $1", [d.id]));
          documentsRemoved += 1;
        } catch (error) {
          documentErrors += 1;
          deps.log.warn({ document: d.id, err: String(error) }, "document could not be removed, will retry");
        }
      }
    }

    const report: RetentionReport = { runId: run, dryRun, policy, counts, documentsRemoved, documentErrors };
    await withSystem(deps.pool, async (db) => {
      await db.query("UPDATE maintenance_runs SET status = 'done', finished_at = now(), detail = $2::jsonb WHERE id = $1", [run, JSON.stringify(report)]);
      if (!dryRun) await db.query("SELECT audit_event('retention.purge', 'maintenance', $1, $2::jsonb)", [run, JSON.stringify({ counts, documentsRemoved, policy })]);
    });
    deps.log.info({ dryRun, counts, documentsRemoved }, "retention run finished");
    return report;
  } catch (error) {
    await withSystem(deps.pool, (db) => db.query("UPDATE maintenance_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [run, String(error).slice(0, 500)]));
    throw error;
  }
}

/** The scheduler calls this every few minutes; the purge itself runs once a day at the planned hour. */
export async function runRetentionIfDue(deps: RetentionDeps, cron = "0 3 * * *", timezone = "Europe/Madrid"): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const last = (await withSystem(deps.pool, (db) => db.query<{ started_at: Date }>(
    "SELECT started_at FROM maintenance_runs WHERE kind IN ('retention', 'retention-baseline') AND NOT dry_run AND status = 'done' ORDER BY started_at DESC LIMIT 1",
  ))).rows[0]?.started_at;
  if (!last) {
    // First start: remember it and wait for the planned hour instead of purging as soon as the worker boots.
    await withSystem(deps.pool, (db) => db.query("INSERT INTO maintenance_runs (kind, status, finished_at, started_at, triggered_by) VALUES ('retention-baseline', 'done', $1, $1, 'scheduler')", [now]));
    return 0;
  }
  if (nextCronRun(cron, last, timezone) > now) return 0;
  const result = await runRetention(deps, { triggeredBy: "scheduler" });
  return "skipped" in result ? 0 : 1;
}
