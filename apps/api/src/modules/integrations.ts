import { OpenAPIHono } from "@hono/zod-openapi";
import {
  applyMapping, closeIntegrationError, decode, diffMappings, enqueueOutbound, callNow, ConnectorError, formatOf, getAdapter, listAdapters, loadConnector, buildContext,
  receiveInbound, retryIntegrationError, runSync, validateMapping, verifyWebhook, webhookSecrets, INBOUND_ENTITIES, TRANSFORMS, type HubDeps, type MappingField,
} from "@orchestrador/connector-sdk";
import { registerAllAdapters } from "@orchestrador/connectors";
import { readSecret } from "@orchestrador/platform";
import { createHash } from "node:crypto";
import { bodyLimit } from "hono/body-limit";

import { env } from "../env.js";
import { crud, zJson, zUuid } from "../lib/crud.js";
import { run, runSystem, type Tx } from "../lib/db.js";
import { HttpError, conflict, notFound } from "../lib/errors.js";
import { define, z } from "../lib/route.js";
import { gateways } from "../lib/gateways.js";
import { log } from "../lib/services.js";
import type { AppEnv } from "../lib/types.js";

registerAllAdapters();

export const integrations = new OpenAPIHono<AppEnv>();
const TAG = "Integrations";
const MAX_WEBHOOK_BYTES = 2_000_000;

const hubDeps = (db: Tx): HubDeps => ({ db, log, readSecret: (ref) => readSecret(ref) as Promise<Record<string, string>>, piiKey: env.piiKey, documents: gateways.documents, objects: gateways.objects });
const page = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });

// ───────────── inbound webhooks (ORF-058, ORF-059) ─────────────
/**
 * Public by design: authenticity comes from the HMAC signature, not a session. Unknown connector and bad signature get
 * the same answer so the endpoint reveals nothing. The event is stored (idempotent) and answered with 202; the worker
 * processes it, so a slow downstream never makes the sender time out.
 */
integrations.post(
  "/webhooks/:connector",
  bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: (c) => c.json({ error: "Payload too large", code: "too_large" }, 413) }),
  async (c) => {
    const key = c.req.param("connector");
    const raw = await c.req.text();
    const headers = Object.fromEntries([...c.req.raw.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
    const unauthorized = () => c.json({ error: "Invalid signature", code: "unauthorized" }, 401);

    const result = await runSystem(async (db) => {
      const connector = await loadConnector(db, key);
      if (!connector || !connector.enabled) return { status: 401 as const };
      const secrets = await webhookSecrets(hubDeps(db), connector).catch(() => []);
      const verdict = verifyWebhook({ secrets, signature: headers["x-orq-signature"] ?? headers["x-signature"], timestamp: headers["x-orq-timestamp"] ?? headers["x-timestamp"], rawBody: raw });
      if (!verdict.ok) {
        log.warn({ connector: key, reason: verdict.reason }, "webhook rejected");
        return { status: 401 as const };
      }
      let payload: unknown;
      try {
        payload = raw.trim() ? decode(formatOf(headers["content-type"]), raw) : null;
      } catch {
        return { status: 400 as const };
      }
      const adapter = getAdapter(connector.system_kind);
      const eventId = headers["x-event-id"] ?? headers["x-orq-event-id"] ?? adapter?.eventIdOf?.(payload, headers) ?? ((payload as { id?: unknown } | null)?.id !== undefined ? String((payload as { id: unknown }).id) : createHash("sha256").update(raw).digest("hex"));
      const eventType = headers["x-event-type"] ?? adapter?.eventTypeOf?.(payload, headers) ?? (typeof (payload as { type?: unknown } | null)?.type === "string" ? (payload as { type: string }).type : "event");
      const stored = await receiveInbound(db, { connectorKey: key, eventId: String(eventId).slice(0, 200), eventType: String(eventType).slice(0, 120), payload, headers, correlationId: headers["x-correlation-id"] ?? null });
      return { status: (stored.duplicate ? 200 : 202) as 200 | 202, body: { id: stored.id, duplicate: stored.duplicate } };
    });
    if (result.status === 401) return unauthorized();
    if (result.status === 400) return c.json({ error: "The payload could not be parsed", code: "bad_request" }, 400);
    return c.json(result.body, result.status);
  },
);

// ───────────── adapters and connectors ─────────────
define(integrations, { method: "get", path: "/integrations/adapters", tag: TAG, summary: "Adapters available to connectors, with their actions", permission: "connectors:read" }, (c) =>
  c.json({
    items: listAdapters().map((a) => ({
      kind: a.kind, label: a.label, description: a.description, configSchema: a.configSchema ?? [], inboundEvents: Object.keys(a.inbound ?? {}), supportsSync: Boolean(a.sync), supportsPing: Boolean(a.ping),
      actions: a.actions.map((x) => ({ key: x.key, label: x.label, description: x.description ?? "", direction: x.direction, idempotent: Boolean(x.idempotent), input: x.input })),
    })),
    inboundEntities: INBOUND_ENTITIES, transforms: TOOLS(),
  }),
);
function TOOLS() {
  return TRANSFORMS;
}

integrations.route("/", crud({
  permissions: { read: "connectors:read", write: "connectors:write" }, tag: TAG, table: "connectors", basePath: "/connectors",
  fields: {
    key: { schema: z.string().regex(/^[a-z][a-z0-9_-]*$/) }, name: { schema: z.string().min(1) }, system_kind: { schema: z.string().min(1) },
    base_url: { schema: z.string().url().nullable().optional() }, auth_type: { schema: z.enum(["none", "api_key", "basic", "bearer", "oauth2"]).optional() },
    credentials_ref: { schema: z.string().nullable().optional() }, webhook_secret_ref: { schema: z.string().nullable().optional() },
    config: { schema: zJson.optional(), cast: "jsonb" }, enabled: { schema: z.boolean().optional() }, mode: { schema: z.enum(["mock", "live"]).optional() },
  },
  readonly: ["last_sync_at", "last_status", "created_at"], search: ["key", "name", "system_kind"], filters: ["system_kind", "enabled", "mode"], defaultOrder: "key",
}));

async function withConnector<T>(key: string, fn: (db: Tx, connector: NonNullable<Awaited<ReturnType<typeof loadConnector>>>) => Promise<T>): Promise<T> {
  return runSystem(async (db) => {
    const connector = await loadConnector(db, key);
    if (!connector) throw notFound("Connector");
    return fn(db, connector);
  });
}

define(integrations, { method: "post", path: "/connectors/{key}/test", tag: TAG, summary: "Test the connection", permission: "connectors:write", params: z.object({ key: z.string() }) }, async (c, i) => {
  const out = await withConnector(i.params.key, async (db, connector) => {
    const adapter = getAdapter(connector.system_kind);
    if (!adapter?.ping) return { ok: false, detail: `The "${connector.system_kind}" adapter has no connection test` };
    try {
      return await adapter.ping(await buildContext(hubDeps(db), connector));
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "failed" };
    }
  });
  return c.json(out);
});

define(integrations, {
  method: "post", path: "/connectors/{key}/invoke", tag: TAG, summary: "Run a connector action now (sync) or through the outbox (async)", permission: "connectors:sync", params: z.object({ key: z.string() }),
  body: z.object({ action: z.string().min(1), input: zJson.default({}), mode: z.enum(["sync", "async"]).default("async"), idempotencyKey: z.string().max(200).optional() }), status: 202,
}, async (c, i) => {
  const b = i.body;
  const key = i.params.key;
  const p = c.get("principal");
  const out = await withConnector(key, async (db) => {
    const call = { connectorKey: key, action: b.action, idempotencyKey: b.idempotencyKey ?? null, correlationId: c.get("requestId") ?? null };
    if (b.mode === "async") return { queued: true, ...(await enqueueOutbound(db, { ...call, payload: b.input })) };
    try {
      const r = await callNow(hubDeps(db), { ...call, input: b.input });
      return { queued: false, outboxId: r.outboxId, replayed: r.replayed, externalId: r.externalId ?? null, output: r.output };
    } catch (error) {
      if (error instanceof ConnectorError) throw new HttpError(error.retryable ? 502 : 422, error.message, error.code, error.details);
      throw error;
    }
  });
  await runSystem((db) => db.query("SELECT audit_event('connector.invoke', 'connector', NULL, $1::jsonb)", [JSON.stringify({ connector: key, action: b.action, mode: b.mode, by: p.label })]));
  return c.json(out, 202);
});

define(integrations, {
  method: "post", path: "/connectors/{key}/sync", tag: TAG, summary: "Start a synchronisation", permission: "connectors:sync", params: z.object({ key: z.string() }), body: z.object({ full: z.boolean().default(false) }), status: 202,
}, async (c, i) => {
  const key = i.params.key;
  await withConnector(key, async () => undefined);
  // The sync runs in the background (a full sync can take hours); progress is in /integrations/syncs.
  void runSystem((db) => runSync(hubDeps(db), key, { full: i.body.full, trigger: "manual" })).catch((error) => log.error({ connector: key, err: String(error) }, "manual sync crashed"));
  return c.json({ started: true }, 202);
});

// ───────────── mapping registry and editor (ORF-086) ─────────────
const fieldSchema: z.ZodType<MappingField> = z.object({
  source: z.string().optional(), sources: z.array(z.string()).optional(), target: z.string(), transform: z.enum(TRANSFORMS).optional(), default: z.unknown().optional(), required: z.boolean().optional(),
  value: z.unknown().optional(), options: z.record(z.unknown()).optional(), separator: z.string().optional(), description: z.string().optional(),
}) as never;

define(integrations, { method: "get", path: "/mappings", tag: TAG, summary: "Mappings with their published version", permission: "mappings:read", query: z.object({ connector_key: z.string().optional() }) }, async (c, i) => {
  const r = await run(c, (db) => db.query(
    `SELECT m.id, m.key, m.connector_key, m.entity, m.direction, m.description, m.created_at,
            (SELECT version FROM mapping_versions v WHERE v.mapping_id = m.id AND v.state = 'published') AS published_version,
            (SELECT max(version) FROM mapping_versions v WHERE v.mapping_id = m.id) AS latest_version
     FROM mapping_registry m WHERE ($1::text IS NULL OR m.connector_key = $1) ORDER BY m.connector_key, m.key`, [i.query.connector_key ?? null]));
  return c.json({ items: r.rows });
});

define(integrations, {
  method: "post", path: "/mappings", tag: TAG, summary: "Create a mapping", permission: "mappings:write", status: 201,
  body: z.object({ key: z.string().regex(/^[a-z][a-z0-9._-]*$/), connector_key: z.string().min(1), entity: z.string().min(1), direction: z.enum(["inbound", "outbound"]), description: z.string().default("") }),
}, async (c, i) => {
  const b = i.body;
  const row = await run(c, async (db) => {
    if (b.direction === "inbound" && !(INBOUND_ENTITIES as readonly string[]).includes(b.entity)) throw new HttpError(422, `Inbound mappings target one of: ${INBOUND_ENTITIES.join(", ")}`, "invalid_entity");
    try {
      return (await db.query("INSERT INTO mapping_registry (key, connector_key, entity, direction, description) VALUES ($1, $2, $3, $4, $5) RETURNING id, key", [b.key, b.connector_key, b.entity, b.direction, b.description])).rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw conflict(`Mapping "${b.key}" already exists`);
      throw error;
    }
  });
  return c.json(row, 201);
});

define(integrations, { method: "get", path: "/mappings/{key}", tag: TAG, summary: "A mapping and its versions", permission: "mappings:read", params: z.object({ key: z.string() }) }, async (c, i) => {
  const out = await run(c, async (db) => {
    const m = (await db.query("SELECT id, key, connector_key, entity, direction, description, created_at FROM mapping_registry WHERE key = $1", [i.params.key])).rows[0];
    if (!m) return null;
    const versions = (await db.query("SELECT version, state, fields, source_schema, target_schema, change_note, created_by, created_at FROM mapping_versions WHERE mapping_id = $1 ORDER BY version DESC", [m.id])).rows;
    return { ...m, versions };
  });
  if (!out) throw notFound("Mapping");
  return c.json(out);
});

const versionBody = z.object({ fields: z.array(fieldSchema).max(500), change_note: z.string().max(500).default(""), source_schema: zJson.nullable().optional(), target_schema: zJson.nullable().optional() });

define(integrations, { method: "post", path: "/mappings/{key}/versions", tag: TAG, summary: "Add a draft version (copy it from the published one by posting its fields)", permission: "mappings:write", params: z.object({ key: z.string() }), body: versionBody, status: 201 }, async (c, i) => {
  const p = c.get("principal");
  const out = await run(c, async (db) => {
    const m = (await db.query<{ id: string }>("SELECT id FROM mapping_registry WHERE key = $1", [i.params.key])).rows[0];
    if (!m) throw notFound("Mapping");
    const next = (await db.query<{ n: number }>("SELECT coalesce(max(version), 0)::int + 1 AS n FROM mapping_versions WHERE mapping_id = $1", [m.id])).rows[0]!.n;
    await db.query("INSERT INTO mapping_versions (mapping_id, version, state, fields, source_schema, target_schema, change_note, created_by) VALUES ($1, $2, 'draft', $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)", [m.id, next, JSON.stringify(i.body.fields), i.body.source_schema ? JSON.stringify(i.body.source_schema) : null, i.body.target_schema ? JSON.stringify(i.body.target_schema) : null, i.body.change_note, p.kind === "user" ? p.id : null]);
    return { version: next, state: "draft", problems: validateMapping(i.body.fields) };
  });
  return c.json(out, 201);
});

define(integrations, { method: "put", path: "/mappings/{key}/versions/{version}", tag: TAG, summary: "Edit a draft version", permission: "mappings:write", params: z.object({ key: z.string(), version: z.coerce.number().int() }), body: versionBody }, async (c, i) => {
  const out = await run(c, async (db) => {
    const v = (await db.query<{ id: string; state: string }>("SELECT v.id, v.state FROM mapping_versions v JOIN mapping_registry m ON m.id = v.mapping_id WHERE m.key = $1 AND v.version = $2 FOR UPDATE OF v", [i.params.key, i.params.version])).rows[0];
    if (!v) throw notFound("Mapping version");
    if (v.state !== "draft") throw conflict("Only a draft can be edited; add a new version instead", "not_draft");
    await db.query("UPDATE mapping_versions SET fields = $2::jsonb, change_note = $3, source_schema = $4::jsonb, target_schema = $5::jsonb WHERE id = $1", [v.id, JSON.stringify(i.body.fields), i.body.change_note, i.body.source_schema ? JSON.stringify(i.body.source_schema) : null, i.body.target_schema ? JSON.stringify(i.body.target_schema) : null]);
    return { version: i.params.version, problems: validateMapping(i.body.fields) };
  });
  return c.json(out);
});

define(integrations, { method: "post", path: "/mappings/{key}/versions/{version}/publish", tag: TAG, summary: "Publish a version; the previous one is retired", permission: "mappings:write", params: z.object({ key: z.string(), version: z.coerce.number().int() }) }, async (c, i) => {
  await run(c, async (db) => {
    const v = (await db.query<{ id: string; mapping_id: string; state: string; fields: MappingField[] }>("SELECT v.id, v.mapping_id, v.state, v.fields FROM mapping_versions v JOIN mapping_registry m ON m.id = v.mapping_id WHERE m.key = $1 AND v.version = $2 FOR UPDATE OF v", [i.params.key, i.params.version])).rows[0];
    if (!v) throw notFound("Mapping version");
    if (v.state === "published") throw conflict("Already published", "already_published");
    const problems = validateMapping(v.fields);
    if (problems.length > 0) throw new HttpError(422, problems.join("; "), "invalid_mapping", { problems });
    await db.query("UPDATE mapping_versions SET state = 'retired' WHERE mapping_id = $1 AND state = 'published'", [v.mapping_id]);
    await db.query("UPDATE mapping_versions SET state = 'published' WHERE id = $1", [v.id]);
    await db.query("SELECT audit_event('mapping.publish', 'mapping', $1, $2::jsonb)", [v.mapping_id, JSON.stringify({ key: i.params.key, version: i.params.version })]);
  });
  return c.json({ ok: true });
});

define(integrations, {
  method: "post", path: "/mappings/{key}/test", tag: TAG, summary: "Dry-run a mapping version on a sample payload", permission: "mappings:read", params: z.object({ key: z.string() }),
  body: z.object({ version: z.number().int().optional(), fields: z.array(fieldSchema).optional(), source: z.unknown(), passthroughExtra: z.boolean().default(true), passthroughFrom: z.string().optional() }),
}, async (c, i) => {
  const fields = i.body.fields ?? (await run(c, async (db) => {
    const r = (await db.query<{ fields: MappingField[] }>(
      `SELECT v.fields FROM mapping_versions v JOIN mapping_registry m ON m.id = v.mapping_id WHERE m.key = $1 AND ${i.body.version ? "v.version = $2" : "v.state = 'published'"}`,
      i.body.version ? [i.params.key, i.body.version] : [i.params.key])).rows[0];
    if (!r) throw notFound("Mapping version");
    return r.fields;
  }));
  return c.json({ ...applyMapping(fields, i.body.source, { passthroughExtra: i.body.passthroughExtra, ...(i.body.passthroughFrom ? { passthroughFrom: i.body.passthroughFrom } : {}) }), problems: validateMapping(fields) });
});

define(integrations, { method: "get", path: "/mappings/{key}/diff", tag: TAG, summary: "What changed between two versions", permission: "mappings:read", params: z.object({ key: z.string() }), query: z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }) }, async (c, i) => {
  const rows = (await run(c, (db) => db.query<{ version: number; fields: MappingField[] }>("SELECT v.version, v.fields FROM mapping_versions v JOIN mapping_registry m ON m.id = v.mapping_id WHERE m.key = $1 AND v.version = ANY($2)", [i.params.key, [i.query.from, i.query.to]]))).rows;
  const a = rows.find((r) => r.version === i.query.from);
  const b = rows.find((r) => r.version === i.query.to);
  if (!a || !b) throw notFound("Mapping version");
  return c.json(diffMappings(a.fields, b.fields));
});

// ───────────── inbox, outbox, errors, health ─────────────
define(integrations, { method: "get", path: "/integrations/inbox", tag: TAG, summary: "Received events", permission: "connectors:read", query: page.extend({ connector_key: z.string().optional(), status: z.enum(["received", "processed", "failed", "ignored"]).optional() }) }, async (c, i) => {
  const r = await run(c, (db) => db.query(
    `SELECT id, connector_key, event_id, event_type, status, attempts, error, outcome, received_at, processed_at, correlation_id FROM inbox_events
     WHERE ($1::text IS NULL OR connector_key = $1) AND ($2::text IS NULL OR status = $2) ORDER BY received_at DESC LIMIT $3 OFFSET $4`, [i.query.connector_key ?? null, i.query.status ?? null, i.query.limit, i.query.offset]));
  return c.json({ items: r.rows });
});

define(integrations, { method: "get", path: "/integrations/inbox/{id}", tag: TAG, summary: "A received event with its payload", permission: "connectors:write", params: z.object({ id: zUuid }) }, async (c, i) => {
  const row = (await run(c, (db) => db.query("SELECT * FROM inbox_events WHERE id = $1", [i.params.id]))).rows[0];
  if (!row) throw notFound("Inbox event");
  return c.json(row);
});

define(integrations, { method: "post", path: "/integrations/inbox/{id}/replay", tag: TAG, summary: "Process an event again", permission: "connectors:sync", params: z.object({ id: zUuid }) }, async (c, i) => {
  const r = await run(c, (db) => db.query("UPDATE inbox_events SET status = 'received', attempts = 0, next_attempt_at = now(), locked_until = NULL, error = NULL WHERE id = $1 AND status IN ('failed', 'ignored', 'processed') RETURNING id", [i.params.id]));
  if (!r.rows[0]) throw conflict("Only failed, ignored or processed events can be replayed", "not_replayable");
  return c.json({ ok: true });
});

define(integrations, { method: "get", path: "/integrations/outbox", tag: TAG, summary: "Outgoing calls", permission: "connectors:read", query: page.extend({ connector_key: z.string().optional(), status: z.enum(["pending", "sending", "sent", "failed", "dead"]).optional() }) }, async (c, i) => {
  const r = await run(c, (db) => db.query(
    `SELECT id, connector_key, action, entity_type, entity_id, status, attempts, max_attempts, next_attempt_at, last_error, correlation_id, execution_id, created_at, sent_at FROM outbox_events
     WHERE ($1::text IS NULL OR connector_key = $1) AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [i.query.connector_key ?? null, i.query.status ?? null, i.query.limit, i.query.offset]));
  return c.json({ items: r.rows });
});

define(integrations, { method: "post", path: "/integrations/outbox/{id}/retry", tag: TAG, summary: "Send a failed or dead call again now", permission: "connectors:sync", params: z.object({ id: zUuid }) }, async (c, i) => {
  const r = await run(c, (db) => db.query("UPDATE outbox_events SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1 AND status IN ('failed', 'dead') RETURNING id", [i.params.id]));
  if (!r.rows[0]) throw conflict("Only failed or dead calls can be retried", "not_retryable");
  return c.json({ ok: true });
});

define(integrations, { method: "post", path: "/integrations/outbox/{id}/cancel", tag: TAG, summary: "Cancel a call that has not been sent", permission: "connectors:sync", params: z.object({ id: zUuid }) }, async (c, i) => {
  const r = await run(c, (db) => db.query("UPDATE outbox_events SET status = 'dead', last_error = 'Cancelled by an operator', locked_until = NULL WHERE id = $1 AND status IN ('pending', 'failed') RETURNING id", [i.params.id]));
  if (!r.rows[0]) throw conflict("Only pending or failed calls can be cancelled", "not_cancellable");
  return c.json({ ok: true });
});

define(integrations, { method: "get", path: "/integration-errors", tag: TAG, summary: "Integration error panel (ORF-046)", permission: "integration_errors:read", query: page.extend({ connector_key: z.string().optional(), resolved: z.enum(["true", "false"]).default("false"), direction: z.enum(["inbound", "outbound", "sync"]).optional() }) }, async (c, i) => {
  const r = await run(c, (db) => db.query(
    `SELECT id, connector_key, direction, action, error_code, message, outbox_id, inbox_id, task_id, resolved, resolved_at, resolution, correlation_id, created_at FROM integration_errors
     WHERE resolved = $1::boolean AND ($2::text IS NULL OR connector_key = $2) AND ($3::text IS NULL OR direction = $3) ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
    [i.query.resolved, i.query.connector_key ?? null, i.query.direction ?? null, i.query.limit, i.query.offset]));
  return c.json({ items: r.rows });
});

define(integrations, { method: "get", path: "/integration-errors/{id}", tag: TAG, summary: "An error with the payload that failed", permission: "integration_errors:read", params: z.object({ id: zUuid }) }, async (c, i) => {
  const row = (await run(c, (db) => db.query("SELECT * FROM integration_errors WHERE id = $1", [i.params.id]))).rows[0];
  if (!row) throw notFound("Integration error");
  return c.json(row);
});

define(integrations, { method: "post", path: "/integration-errors/{id}/retry", tag: TAG, summary: "Re-queue the failed exchange and close the error", permission: "integration_errors:resolve", params: z.object({ id: zUuid }) }, async (c, i) => {
  const kind = await run(c, (db) => retryIntegrationError(db, i.params.id, `Reintentado por ${c.get("principal").label}`));
  if (kind === "none") throw conflict("Nothing to retry: the exchange was already handled or the error does not exist", "not_retryable");
  return c.json({ ok: true, requeued: kind });
});

define(integrations, { method: "post", path: "/integration-errors/{id}/resolve", tag: TAG, summary: "Mark an error as handled manually", permission: "integration_errors:resolve", params: z.object({ id: zUuid }), body: z.object({ note: z.string().min(1).max(500) }) }, async (c, i) => {
  const ok = await run(c, (db) => closeIntegrationError(db, i.params.id, `${c.get("principal").label}: ${i.body.note}`));
  if (!ok) throw conflict("The error is already resolved or does not exist", "already_resolved");
  return c.json({ ok: true });
});

define(integrations, { method: "get", path: "/integrations/syncs", tag: TAG, summary: "Synchronisation runs", permission: "connectors:read", query: page.extend({ connector_key: z.string().optional() }) }, async (c, i) => {
  const r = await run(c, (db) => db.query(
    `SELECT id, connector_key, kind, trigger, status, stats, error, started_at, finished_at, extract(epoch FROM (coalesce(finished_at, now()) - started_at))::int AS seconds
     FROM sync_runs WHERE ($1::text IS NULL OR connector_key = $1) ORDER BY started_at DESC LIMIT $2 OFFSET $3`, [i.query.connector_key ?? null, i.query.limit, i.query.offset]));
  return c.json({ items: r.rows });
});

define(integrations, { method: "get", path: "/integrations/health", tag: TAG, summary: "One line per connector: status, backlog, open errors", permission: "connectors:read" }, async (c) => {
  const r = await run(c, (db) => db.query(
    `SELECT c.key, c.name, c.system_kind, c.mode, c.enabled, c.last_status, c.last_sync_at,
            (SELECT count(*)::int FROM outbox_events o WHERE o.connector_key = c.key AND o.status IN ('pending', 'failed', 'sending')) AS outbox_backlog,
            (SELECT count(*)::int FROM outbox_events o WHERE o.connector_key = c.key AND o.status = 'dead') AS outbox_dead,
            (SELECT count(*)::int FROM inbox_events i WHERE i.connector_key = c.key AND i.status = 'received') AS inbox_backlog,
            (SELECT count(*)::int FROM integration_errors e WHERE e.connector_key = c.key AND NOT e.resolved) AS open_errors,
            (SELECT max(received_at) FROM inbox_events i WHERE i.connector_key = c.key) AS last_inbound_at,
            (SELECT status FROM sync_runs s WHERE s.connector_key = c.key ORDER BY started_at DESC LIMIT 1) AS last_sync_status
     FROM connectors c ORDER BY c.key`));
  return c.json({ items: r.rows });
});
