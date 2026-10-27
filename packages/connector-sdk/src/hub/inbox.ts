import { getAdapter, findAction, type InboundHandler, type InboundOutcome } from "../adapter.js";
import { ConnectorError, backoffMs, permanent } from "../errors.js";
import { buildContext, loadConnector, type HubDeps } from "./connectors.js";
import type { Db } from "./db.js";
import { emitEvents, INBOUND_ENTITIES, upsertEntity, type InboundEntity } from "./entities.js";
import { recordIntegrationError } from "./errors.js";
import { mapWith } from "./mappings.js";

export const INBOX_MAX_ATTEMPTS = 5;

export type InboxInput = { connectorKey: string; eventId: string; eventType: string; payload: unknown; headers?: Record<string, string>; correlationId?: string | null };

/** Stores a received event. A second delivery of the same (connector, event id) is a no-op (idempotent webhooks). */
export async function receiveInbound(db: Db, input: InboxInput): Promise<{ id: string; duplicate: boolean }> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO inbox_events (connector_key, event_id, event_type, payload, headers, correlation_id) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     ON CONFLICT (connector_key, event_id) DO NOTHING RETURNING id`,
    [input.connectorKey, input.eventId, input.eventType, JSON.stringify(input.payload ?? null), JSON.stringify(redact(input.headers ?? {})), input.correlationId ?? null],
  );
  if (inserted.rows[0]) {
    await db.query("SELECT pg_notify('orq_outbox', 'inbox')");
    return { id: inserted.rows[0].id, duplicate: false };
  }
  const existing = (await db.query<{ id: string }>("SELECT id FROM inbox_events WHERE connector_key = $1 AND event_id = $2", [input.connectorKey, input.eventId])).rows[0]!;
  return { id: existing.id, duplicate: true };
}

const SENSITIVE = /^(authorization|cookie|x-api-key|x-orq-signature|x-hub-signature.*|x-signature)$/i;
function redact(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, SENSITIVE.test(k) ? "[redacted]" : v]));
}

type InboundRule = { mapping: string; entity: InboundEntity; passthroughExtra?: boolean; passthroughFrom?: string; events?: string[] };

/** Handler built from `connectors.config.inbound[eventType]`: mapping, then entity upsert, then domain events. */
function configuredHandler(rule: InboundRule, deps: HubDeps): InboundHandler {
  return async (ctx, payload) => {
    if (!INBOUND_ENTITIES.includes(rule.entity)) throw permanent("entity_not_supported", `Inbound entity "${rule.entity}" is not supported`);
    const mapped = await mapWith(ctx.db, rule.mapping, payload, { passthroughExtra: rule.passthroughExtra ?? true, ...(rule.passthroughFrom ? { passthroughFrom: rule.passthroughFrom } : {}) });
    const externalId = typeof mapped.output.external_id === "string" ? mapped.output.external_id : null;
    const result = await upsertEntity(ctx.db, rule.entity, mapped.output, { connectorKey: ctx.connector.key, externalId, ...(deps.piiKey ? { piiKey: deps.piiKey } : {}), ...(deps.now ? { now: deps.now() } : {}) });
    return {
      summary: `${result.created ? "created" : "updated"} ${result.entity} ${result.id} (mapping ${mapped.mapping.key} v${mapped.mapping.version})`,
      events: result.events.map((e) => ({ type: e.type, entityType: e.entityType, entityId: e.entityId, payload: e.payload })),
    };
  };
}

type InboxRow = { id: string; connector_key: string; event_id: string; event_type: string; payload: unknown; attempts: number; correlation_id: string | null };

/**
 * Processes received events: claims a batch with SKIP LOCKED + a lease (any number of worker replicas), runs the
 * adapter handler or the configured mapping, and records the outcome. Transient failures back off; permanent ones
 * (or exhausted attempts) go to the integration error panel.
 */
export async function processInbox(deps: HubDeps, batch = 20): Promise<number> {
  const claimed = await deps.db.query<InboxRow>(
    `UPDATE inbox_events SET locked_until = now() + interval '2 minutes', attempts = attempts + 1
     WHERE id IN (SELECT id FROM inbox_events WHERE status = 'received' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
                  ORDER BY received_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, connector_key, event_id, event_type, payload, attempts, correlation_id`,
    [batch],
  );
  for (const row of claimed.rows) await processOne(deps, row);
  return claimed.rows.length;
}

async function processOne(deps: HubDeps, row: InboxRow): Promise<void> {
  const { db } = deps;
  try {
    const connector = await loadConnector(db, row.connector_key);
    if (!connector) throw permanent("connector_missing", `Connector "${row.connector_key}" does not exist`);
    if (!connector.enabled) {
      // Park, do not burn an attempt: the connector may be re-enabled.
      await db.query("UPDATE inbox_events SET attempts = attempts - 1, locked_until = NULL, next_attempt_at = now() + interval '5 minutes' WHERE id = $1", [row.id]);
      return;
    }
    const adapter = getAdapter(connector.system_kind);
    const rule = (connector.config.inbound as Record<string, InboundRule> | undefined)?.[row.event_type];
    const handler = rule ? configuredHandler(rule, deps) : adapter?.inbound?.[row.event_type];
    if (!handler) {
      await db.query("UPDATE inbox_events SET status = 'ignored', processed_at = now(), locked_until = NULL, outcome = $2 WHERE id = $1", [row.id, `no handler for ${row.event_type}`]);
      return;
    }
    // Handler, domain events and the inbox status commit together: a crash never leaves half an event applied.
    const inTransaction = deps.transaction ?? (<T>(fn: (tdb: typeof db) => Promise<T>) => fn(db));
    await inTransaction(async (tdb) => {
      const ctx = await buildContext({ ...deps, db: tdb }, connector, row.correlation_id ? { correlationId: row.correlation_id } : {});
      const outcome: InboundOutcome = await handler(ctx, row.payload, { eventId: row.event_id, eventType: row.event_type });
      await emitEvents(tdb, (outcome.events ?? []).map((e) => ({ type: e.type, entityType: e.entityType ?? "", entityId: e.entityId ?? "", payload: e.payload ?? {} })).filter((e) => e.entityType && e.entityId), row.correlation_id);
      // A raw event is always announced so flows can subscribe to anything a connector sends.
      await tdb.query("INSERT INTO domain_events (type, entity_type, entity_id, payload, correlation_id) VALUES ($1, 'inbox_event', $2, $3::jsonb, $4)", [`int.${row.connector_key}.${row.event_type}`, row.id, JSON.stringify({ inboxId: row.id, eventId: row.event_id, summary: outcome.summary ?? null }), row.correlation_id]);
      await tdb.query("UPDATE inbox_events SET status = 'processed', processed_at = now(), locked_until = NULL, outcome = $2, error = NULL WHERE id = $1", [row.id, outcome.summary ?? "processed"]);
    });
    await db.query("UPDATE connectors SET last_status = 'ok' WHERE key = $1", [row.connector_key]);
  } catch (error) {
    const e = error instanceof ConnectorError ? error : new ConnectorError(error instanceof Error ? error.message : String(error), "inbound_failed", false);
    const final = !e.retryable || row.attempts >= INBOX_MAX_ATTEMPTS;
    if (final) {
      await db.query("UPDATE inbox_events SET status = 'failed', error = $2, locked_until = NULL WHERE id = $1", [row.id, e.message.slice(0, 2000)]);
      await recordIntegrationError(db, { connectorKey: row.connector_key, direction: "inbound", action: row.event_type, code: e.code, message: e.message, payload: row.payload, inboxId: row.id, correlationId: row.correlation_id });
      await db.query("UPDATE connectors SET last_status = 'error' WHERE key = $1", [row.connector_key]);
    } else {
      const wait = e.details.retryAfterMs ?? backoffMs(row.attempts);
      await db.query("UPDATE inbox_events SET error = $2, locked_until = NULL, next_attempt_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1", [row.id, e.message.slice(0, 2000), String(wait)]);
    }
    deps.log.warn({ connector: row.connector_key, inbox: row.id, code: e.code, final }, "inbound event failed");
  }
}

export { findAction };
