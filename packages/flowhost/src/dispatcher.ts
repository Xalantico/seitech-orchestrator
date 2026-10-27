import { test, type Logic } from "@orchestrador/rules";
import cronParser from "cron-parser";

import { FlowError } from "./errors.js";
import type { FlowHost } from "./host.js";

type EventRow = {
  id: string;
  type: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  delegation_id: string | null;
  created_at: Date;
};

type TriggerRow = { id: string; flow_id: string; kind: string; config: Record<string, unknown> };

/** Does a trigger's configuration match the event? `event` triggers match the type; `entity_transition` the from/to pair. */
export function triggerMatches(trigger: TriggerRow, event: EventRow): boolean {
  const c = trigger.config ?? {};
  if (trigger.kind === "event") {
    const wanted = typeof c.event === "string" ? c.event : typeof c.type === "string" ? c.type : null;
    if (!wanted) return false;
    const hit = wanted.endsWith("*") ? event.type.startsWith(wanted.slice(0, -1)) : wanted === event.type;
    if (!hit) return false;
  } else if (trigger.kind === "entity_transition") {
    if (!event.type.endsWith(".transitioned")) return false;
    if (c.entityType && c.entityType !== event.entity_type) return false;
    if (c.from && c.from !== event.payload.from) return false;
    if (c.to && c.to !== event.payload.to) return false;
    if (c.transition && c.transition !== event.payload.transition) return false;
  } else {
    return false;
  }
  if (c.filter) {
    try {
      return test(c.filter as Logic, { event: event.payload, entity: { type: event.entity_type, id: event.entity_id }, type: event.type });
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Domain-event dispatcher (transactional outbox consumer). Claims a batch with SKIP LOCKED, so any number of worker
 * replicas can run it; starts are idempotent per (event, trigger), so a crash between start and commit is harmless.
 */
export async function dispatchDomainEvents(host: FlowHost, batch = 50): Promise<number> {
  const { log } = host.deps;
  return host.deps.system(async (db) => {
    const events = await db.query<EventRow>(
      `SELECT id, type, entity_type, entity_id, payload, correlation_id, delegation_id, created_at FROM domain_events
       WHERE dispatched_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    if (events.rows.length === 0) return 0;
    const triggers = await db.query<TriggerRow>(
      `SELECT t.id, t.flow_id, t.kind, t.config FROM flow_triggers t JOIN flows f ON f.id = t.flow_id
       WHERE t.enabled AND t.kind IN ('event', 'entity_transition') AND f.archived_at IS NULL AND f.published_version_id IS NOT NULL`,
    );
    for (const event of events.rows) {
      const entity = event.entity_type && event.entity_id ? { type: event.entity_type, id: event.entity_id } : null;
      const scope = { delegationId: event.delegation_id };
      const base = { event: event.type, eventId: event.id, entity, payload: event.payload, now: event.created_at.toISOString() };

      const starts: { flow: string; key: string; kind: string; payload: Record<string, unknown> }[] = [];
      if (event.type === "flow.start") {
        const p = event.payload as { flow?: string; input?: Record<string, unknown> };
        if (typeof p.flow === "string") starts.push({ flow: p.flow, key: `${event.id}:start`, kind: "entity_transition", payload: { ...base, ...(p.input ?? {}) } });
      }
      for (const t of triggers.rows) if (triggerMatches(t, event)) starts.push({ flow: t.flow_id, key: `${event.id}:${t.id}`, kind: t.kind, payload: base });

      for (const s of starts) {
        try {
          await host.startExecution({ flow: s.flow, triggerKind: s.kind, triggerPayload: s.payload, entity, scope, correlationId: event.correlation_id, idempotencyKey: s.key });
        } catch (error) {
          if (error instanceof FlowError && (error.code === "duplicate" || error.code === "not_published" || error.code === "not_found" || error.code === "invalid_flow")) {
            if (error.code !== "duplicate") log.warn({ eventId: event.id, flow: s.flow, code: error.code }, "event trigger skipped");
            continue;
          }
          throw error; // engine unavailable: roll back so the whole batch is retried
        }
      }
      // Executions parked on `flow.wait-event` wake up when the platform itself emits the awaited event (e.g. visit.completed).
      const correlations = [event.entity_id, typeof event.payload.workOrderId === "string" ? event.payload.workOrderId : null, event.correlation_id].filter((x): x is string => Boolean(x));
      if (!event.type.startsWith("flow.") && !event.type.startsWith("execution.")) await deliverEvent(host, { name: event.type, correlations, payload: event.payload, db });
      await db.query("UPDATE domain_events SET dispatched_at = now() WHERE id = $1", [event.id]);
    }
    return events.rows.length;
  });
}

export function nextCronRun(expression: string, after: Date, timeZone?: string): Date {
  return cronParser.parseExpression(expression, { currentDate: after, ...(timeZone ? { tz: timeZone } : {}) }).next().toDate();
}

export function validateCron(expression: string, timeZone?: string): string | null {
  try {
    nextCronRun(expression, new Date(), timeZone);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid cron expression";
  }
}

/** Fires due `schedule` triggers. Idempotent per (trigger, planned time), so replicas and restarts never double-run. */
export async function runSchedules(host: FlowHost, now = new Date()): Promise<number> {
  const { log } = host.deps;
  return host.deps.system(async (db) => {
    const due = await db.query<{ id: string; flow_id: string; config: { cron?: string; timezone?: string; payload?: Record<string, unknown> }; next_run_at: Date | null }>(
      `SELECT t.id, t.flow_id, t.config, t.next_run_at FROM flow_triggers t JOIN flows f ON f.id = t.flow_id
       WHERE t.enabled AND t.kind = 'schedule' AND f.archived_at IS NULL AND (t.next_run_at IS NULL OR t.next_run_at <= $1)
       ORDER BY t.next_run_at NULLS FIRST LIMIT 50 FOR UPDATE OF t SKIP LOCKED`,
      [now],
    );
    let fired = 0;
    for (const t of due.rows) {
      const cron = t.config.cron;
      if (!cron) continue;
      let next: Date;
      try {
        next = nextCronRun(cron, now, t.config.timezone);
      } catch (error) {
        log.warn({ trigger: t.id, cron, err: String(error) }, "invalid cron, trigger disabled");
        await db.query("UPDATE flow_triggers SET enabled = false WHERE id = $1", [t.id]);
        continue;
      }
      if (t.next_run_at) {
        try {
          await host.startExecution({
            flow: t.flow_id,
            triggerKind: "schedule",
            triggerPayload: { ...(t.config.payload ?? {}), scheduledFor: t.next_run_at.toISOString(), now: now.toISOString() },
            idempotencyKey: `${t.id}:${t.next_run_at.toISOString()}`,
          });
          fired += 1;
        } catch (error) {
          if (!(error instanceof FlowError && ["duplicate", "not_published", "not_found", "invalid_flow"].includes(error.code))) throw error;
          if (error.code !== "duplicate") log.warn({ trigger: t.id, code: error.code }, "schedule skipped");
        }
      }
      await db.query("UPDATE flow_triggers SET next_run_at = $2, last_run_at = CASE WHEN $3 THEN $4::timestamptz ELSE last_run_at END WHERE id = $1", [t.id, next, t.next_run_at !== null, now]);
    }
    return fired;
  });
}

/**
 * Wakes every execution parked on `flow.wait-event` with this name. A wait without correlation matches by name alone;
 * a wait with correlation matches when one of the event's correlation values equals it.
 */
export async function deliverEvent(
  host: FlowHost,
  event: { name: string; correlations?: string[]; correlation?: string; payload?: unknown; executionId?: string; db?: { query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> } },
): Promise<number> {
  const correlations = [...(event.correlations ?? []), ...(event.correlation ? [event.correlation] : [])];
  const keys = [event.name, ...correlations.map((c) => `${event.name}|${c}`)];
  type Hit = { executionId: string; correlation: string | undefined };
  const query = async (): Promise<Hit[]> => {
    if (event.executionId) return [{ executionId: event.executionId, correlation: event.correlation ?? correlations[0] }];
    const sql = `SELECT DISTINCT w.execution_id, w.correlation_key FROM execution_waits w JOIN executions e ON e.id = w.execution_id
                 WHERE w.resolved_at IS NULL AND w.kind = 'external_event' AND e.status IN ('running', 'waiting', 'paused') AND w.correlation_key = ANY($1)`;
    const rows = event.db ? (await event.db.query<{ execution_id: string; correlation_key: string }>(sql, [keys])).rows : (await host.deps.system((db) => db.query<{ execution_id: string; correlation_key: string }>(sql, [keys]))).rows;
    // The interpreter compares the wait's own correlation value, so hand it the one that matched (e.g. the work order id, not the visit id).
    return rows.map((r) => ({ executionId: r.execution_id, correlation: r.correlation_key.startsWith(`${event.name}|`) ? r.correlation_key.slice(event.name.length + 1) : correlations[0] }));
  };
  let delivered = 0;
  for (const hit of await query()) {
    try {
      await host.signalExecution(hit.executionId, "event", { name: event.name, payload: event.payload, ...(hit.correlation ? { correlation: hit.correlation } : {}) });
      delivered += 1;
    } catch {
      /* the execution finished meanwhile */
    }
  }
  return delivered;
}
