import type { Db } from "./db.js";

export type NewIntegrationError = {
  connectorKey: string;
  direction: "inbound" | "outbound" | "sync";
  action?: string | null;
  code?: string | null;
  message: string;
  payload?: unknown;
  outboxId?: string | null;
  inboxId?: string | null;
  correlationId?: string | null;
};

/**
 * Records a failure that needs a person (ORF-046): a row for the integration error panel plus a task in the
 * "integraciones" queue with a Retry button. One open error per outbox/inbox row, so retries do not pile up tasks.
 */
export async function recordIntegrationError(db: Db, e: NewIntegrationError): Promise<string> {
  const existing = e.outboxId || e.inboxId
    ? (await db.query<{ id: string }>("SELECT id FROM integration_errors WHERE NOT resolved AND (outbox_id = $1 OR inbox_id = $2) LIMIT 1", [e.outboxId ?? null, e.inboxId ?? null])).rows[0]
    : undefined;
  if (existing) {
    await db.query("UPDATE integration_errors SET message = $2, error_code = $3 WHERE id = $1", [existing.id, e.message.slice(0, 2000), e.code ?? null]);
    return existing.id;
  }
  const row = (await db.query<{ id: string }>(
    `INSERT INTO integration_errors (connector_key, direction, action, error_code, message, payload, outbox_id, inbox_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) RETURNING id`,
    [e.connectorKey, e.direction, e.action ?? null, e.code ?? null, e.message.slice(0, 2000), e.payload === undefined ? null : JSON.stringify(e.payload), e.outboxId ?? null, e.inboxId ?? null, e.correlationId ?? null],
  )).rows[0]!;
  const task = await db.query<{ id: string }>(
    `INSERT INTO tasks (queue_id, title, description, priority, source, kind, available_actions, extra)
     VALUES ((SELECT id FROM queues WHERE key = 'integraciones'), $1, $2, 'high', 'integration', 'integration_error',
             '[{"action":"retry","label":"Reintentar"},{"action":"comment","label":"Comentar"}]'::jsonb, $3::jsonb) RETURNING id`,
    [`Error de integración · ${e.connectorKey}${e.action ? ` · ${e.action}` : ""}`, e.message.slice(0, 2000), JSON.stringify({ integrationErrorId: row.id, connectorKey: e.connectorKey, direction: e.direction })],
  );
  await db.query("UPDATE integration_errors SET task_id = $2 WHERE id = $1", [row.id, task.rows[0]!.id]);
  return row.id;
}

/** Puts the failed item back in its queue and closes the error. Returns what was re-queued. */
export async function retryIntegrationError(db: Db, id: string, note = "Reintentado"): Promise<"outbox" | "inbox" | "none"> {
  const e = (await db.query<{ outbox_id: string | null; inbox_id: string | null; task_id: string | null; resolved: boolean }>("SELECT outbox_id, inbox_id, task_id, resolved FROM integration_errors WHERE id = $1", [id])).rows[0];
  if (!e) return "none";
  let kind: "outbox" | "inbox" | "none" = "none";
  if (e.outbox_id) {
    const r = await db.query("UPDATE outbox_events SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1 AND status IN ('failed', 'dead')", [e.outbox_id]);
    if (r.rowCount) kind = "outbox";
  }
  if (e.inbox_id) {
    const r = await db.query("UPDATE inbox_events SET status = 'received', attempts = 0, next_attempt_at = now(), locked_until = NULL, error = NULL WHERE id = $1 AND status IN ('failed', 'received')", [e.inbox_id]);
    if (r.rowCount) kind = "inbox";
  }
  if (kind !== "none") await closeIntegrationError(db, id, note);
  return kind;
}

export async function closeIntegrationError(db: Db, id: string, resolution: string): Promise<boolean> {
  const r = await db.query<{ task_id: string | null }>("UPDATE integration_errors SET resolved = true, resolved_at = now(), resolution = $2 WHERE id = $1 AND NOT resolved RETURNING task_id", [id, resolution.slice(0, 500)]);
  const taskId = r.rows[0]?.task_id;
  if (taskId) await db.query("UPDATE tasks SET status = 'resolved', resolved_at = now() WHERE id = $1 AND status IN ('open', 'in_progress')", [taskId]);
  return r.rows.length > 0;
}
