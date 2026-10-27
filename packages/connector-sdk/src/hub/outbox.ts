import { findAction, type ActionResult } from "../adapter.js";
import { ConnectorError, backoffMs, permanent } from "../errors.js";
import { buildContext, loadConnector, resolveAdapter, type HubDeps } from "./connectors.js";
import type { Db } from "./db.js";
import { recordIntegrationError } from "./errors.js";

export type OutboxInput = {
  connectorKey: string;
  action: string;
  payload?: Record<string, unknown>;
  entityType?: string | null;
  entityId?: string | null;
  /** Same key = same logical call: the second enqueue returns the first row and nothing is sent twice. */
  idempotencyKey?: string | null;
  correlationId?: string | null;
  executionId?: string | null;
  nodeId?: string | null;
  delaySeconds?: number;
  maxAttempts?: number;
};

/**
 * Transactional outbox: the row is written in the caller's transaction (state change + message commit together), and
 * the worker sends it afterwards. A crash can delay a send, never lose or duplicate one.
 */
export async function enqueueOutbound(db: Db, input: OutboxInput): Promise<{ id: string; duplicate: boolean }> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO outbox_events (connector_key, action, entity_type, entity_id, payload, idempotency_key, correlation_id, execution_id, node_id, next_attempt_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, now() + ($10 || ' seconds')::interval, $11)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [input.connectorKey, input.action, input.entityType ?? null, input.entityId ?? null, JSON.stringify(input.payload ?? {}), input.idempotencyKey ?? null, input.correlationId ?? null, input.executionId ?? null, input.nodeId ?? null, String(input.delaySeconds ?? 0), input.maxAttempts ?? 8],
  );
  if (inserted.rows[0]) {
    await db.query("SELECT pg_notify('orq_outbox', 'outbox')");
    return { id: inserted.rows[0].id, duplicate: false };
  }
  const existing = (await db.query<{ id: string }>("SELECT id FROM outbox_events WHERE idempotency_key = $1", [input.idempotencyKey]))
    .rows[0]!;
  return { id: existing.id, duplicate: true };
}

type OutboxRow = { id: string; connector_key: string; action: string; entity_type: string | null; entity_id: string | null; payload: Record<string, unknown>; attempts: number; max_attempts: number; idempotency_key: string | null; correlation_id: string | null; execution_id: string | null };

/** Runs one action against its connector (shared by the outbox worker and synchronous `int.call`). */
export async function runAction(deps: HubDeps, call: { connectorKey: string; action: string; input: Record<string, unknown>; idempotencyKey?: string | null; correlationId?: string | null; executionId?: string | null }): Promise<ActionResult> {
  const connector = await loadConnector(deps.db, call.connectorKey);
  if (!connector) throw permanent("connector_missing", `Connector "${call.connectorKey}" does not exist`);
  if (!connector.enabled) throw new ConnectorError(`Connector "${call.connectorKey}" is disabled`, "connector_disabled", true);
  const adapter = await resolveAdapter(connector);
  const action = findAction(adapter, call.action);
  if (!action) throw permanent("action_unknown", `Connector kind "${adapter.kind}" has no action "${call.action}"`);
  const missing = action.input.filter((f) => f.required && (call.input[f.key] === undefined || call.input[f.key] === null || call.input[f.key] === "")).map((f) => f.key);
  if (missing.length > 0) throw permanent("input_invalid", `Missing required input: ${missing.join(", ")}`);
  const ctx = await buildContext(deps, connector, { ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}), ...(call.correlationId ? { correlationId: call.correlationId } : {}), ...(call.executionId ? { executionId: call.executionId } : {}) });
  return action.run(ctx, call.input);
}

async function markSent(db: Db, row: Pick<OutboxRow, "id" | "connector_key" | "entity_type" | "entity_id">, result: ActionResult) {
  await db.query("UPDATE outbox_events SET status = 'sent', sent_at = now(), locked_until = NULL, last_error = NULL, response = $2::jsonb WHERE id = $1", [row.id, JSON.stringify(result.output ?? null)]);
  if (result.externalId && row.entity_type && row.entity_id) {
    await db.query(
      `INSERT INTO external_refs (entity_type, entity_id, connector_key, external_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (entity_type, entity_id, connector_key) DO UPDATE SET external_id = EXCLUDED.external_id, synced_at = now()`,
      [row.entity_type, row.entity_id, row.connector_key, result.externalId],
    );
  }
  await db.query("UPDATE connectors SET last_sync_at = now(), last_status = 'ok' WHERE key = $1", [row.connector_key]);
}

/** Claims due rows (SKIP LOCKED + lease, so a crashed worker's rows come back) and sends them with backoff. */
export async function runOutbox(deps: HubDeps, batch = 20): Promise<number> {
  const claimed = await deps.db.query<OutboxRow>(
    `UPDATE outbox_events SET status = 'sending', locked_until = now() + interval '2 minutes', attempts = attempts + 1
     WHERE id IN (SELECT id FROM outbox_events
                  WHERE (status IN ('pending', 'failed') AND next_attempt_at <= now()) OR (status = 'sending' AND locked_until < now())
                  ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, connector_key, action, entity_type, entity_id, payload, attempts, max_attempts, idempotency_key, correlation_id, execution_id`,
    [batch],
  );
  for (const row of claimed.rows) {
    try {
      const result = await runAction(deps, { connectorKey: row.connector_key, action: row.action, input: row.payload, idempotencyKey: row.idempotency_key ?? row.id, correlationId: row.correlation_id, executionId: row.execution_id });
      await markSent(deps.db, row, result);
    } catch (error) {
      const e = error instanceof ConnectorError ? error : new ConnectorError(error instanceof Error ? error.message : String(error), "outbound_failed", false);
      if (e.code === "connector_disabled") {
        await deps.db.query("UPDATE outbox_events SET status = 'pending', attempts = attempts - 1, locked_until = NULL, next_attempt_at = now() + interval '5 minutes', last_error = $2 WHERE id = $1", [row.id, e.message]);
        continue;
      }
      const dead = !e.retryable || row.attempts >= row.max_attempts;
      if (dead) {
        await deps.db.query("UPDATE outbox_events SET status = 'dead', last_error = $2, locked_until = NULL WHERE id = $1", [row.id, e.message.slice(0, 2000)]);
        await recordIntegrationError(deps.db, { connectorKey: row.connector_key, direction: "outbound", action: row.action, code: e.code, message: e.message, payload: row.payload, outboxId: row.id, correlationId: row.correlation_id });
        await deps.db.query("UPDATE connectors SET last_status = 'error' WHERE key = $1", [row.connector_key]);
      } else {
        const wait = e.details.retryAfterMs ?? backoffMs(row.attempts);
        await deps.db.query("UPDATE outbox_events SET status = 'failed', last_error = $2, locked_until = NULL, next_attempt_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1", [row.id, e.message.slice(0, 2000), String(wait)]);
      }
      deps.log.warn({ connector: row.connector_key, outbox: row.id, code: e.code, attempt: row.attempts, dead }, "outbound call failed");
    }
  }
  return claimed.rows.length;
}

/**
 * Synchronous call for flows that need the answer (RNF-10 sync pattern). It still leaves an outbox row behind so every
 * exchange is traceable; the row is `sent` on success and `failed` (not retried by the loop) on error.
 */
export async function callNow(deps: HubDeps, call: OutboxInput & { input?: Record<string, unknown> }): Promise<ActionResult & { outboxId: string; replayed: boolean }> {
  const input = call.input ?? call.payload ?? {};
  const existing = call.idempotencyKey ? (await deps.db.query<{ id: string; status: string; response: unknown }>("SELECT id, status, response FROM outbox_events WHERE idempotency_key = $1", [call.idempotencyKey])).rows[0] : undefined;
  if (existing?.status === "sent") return { output: existing.response, outboxId: existing.id, replayed: true };
  const row = existing
    ? existing.id
    : (await deps.db.query<{ id: string }>(
        `INSERT INTO outbox_events (connector_key, action, entity_type, entity_id, payload, status, attempts, idempotency_key, correlation_id, execution_id, node_id, locked_until)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'sending', 1, $6, $7, $8, $9, now() + interval '2 minutes') RETURNING id`,
        [call.connectorKey, call.action, call.entityType ?? null, call.entityId ?? null, JSON.stringify(input), call.idempotencyKey ?? null, call.correlationId ?? null, call.executionId ?? null, call.nodeId ?? null],
      )).rows[0]!.id;
  try {
    const result = await runAction(deps, { connectorKey: call.connectorKey, action: call.action, input, idempotencyKey: call.idempotencyKey ?? row, correlationId: call.correlationId ?? null, executionId: call.executionId ?? null });
    await markSent(deps.db, { id: row, connector_key: call.connectorKey, entity_type: call.entityType ?? null, entity_id: call.entityId ?? null }, result);
    return { ...result, outboxId: row, replayed: false };
  } catch (error) {
    const e = error instanceof ConnectorError ? error : new ConnectorError(error instanceof Error ? error.message : String(error), "outbound_failed", false);
    // The flow decides what to do (retry the node, take the error route); the failed row stays for the panel.
    await deps.db.query("UPDATE outbox_events SET status = 'failed', last_error = $2, locked_until = NULL, next_attempt_at = 'infinity' WHERE id = $1", [row, e.message.slice(0, 2000)]);
    throw e;
  }
}
