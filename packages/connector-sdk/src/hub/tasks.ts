import type { Db } from "./db.js";

export type BackofficeTask = {
  queue: string;
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "urgent";
  kind?: string;
  source?: string;
  entityType?: string | null;
  entityId?: string | null;
  actions?: { action: string; label: string; nextPort?: string }[];
  extra?: Record<string, unknown>;
  dueInHours?: number;
  /** One open task per key; a second call with the same key returns the existing task. */
  dedupeKey?: string;
};

/**
 * A task for a back-office work queue, raised by an integration. Used where the requirements say "without a
 * connector, create a task" (administration websites, batch files that people upload, missing CAE documents).
 */
export async function createBackofficeTask(db: Db, t: BackofficeTask): Promise<{ id: string; created: boolean }> {
  if (t.dedupeKey) {
    const open = (await db.query<{ id: string }>("SELECT id FROM tasks WHERE extra->>'dedupeKey' = $1 AND status IN ('open', 'in_progress') LIMIT 1", [t.dedupeKey])).rows[0];
    if (open) return { id: open.id, created: false };
  }
  const extra = { ...(t.extra ?? {}), ...(t.dedupeKey ? { dedupeKey: t.dedupeKey } : {}) };
  const row = (await db.query<{ id: string }>(
    `INSERT INTO tasks (queue_id, title, description, priority, source, kind, entity_type, entity_id, available_actions, due_at, extra)
     VALUES ((SELECT id FROM queues WHERE key = $1), $2, $3, $4, coalesce($5, 'integration'), coalesce($6, 'manual'), $7, $8, $9::jsonb,
             CASE WHEN $10::numeric IS NULL THEN NULL ELSE now() + make_interval(hours => $10::int) END, $11::jsonb) RETURNING id`,
    [t.queue, t.title.slice(0, 300), t.description ?? "", t.priority ?? "medium", t.source ?? null, t.kind ?? null, t.entityType ?? null, t.entityId ?? null,
     JSON.stringify(t.actions ?? [{ action: "complete", label: "Completar" }, { action: "comment", label: "Comentar" }]), t.dueInHours ?? null, JSON.stringify(extra)],
  )).rows[0]!;
  return { id: row.id, created: true };
}
