import { OpenAPIHono } from "@hono/zod-openapi";
import { TERMINAL_STATUSES } from "@orchestrador/engine";
import { deliverEvent } from "@orchestrador/flowhost";
import { streamSSE } from "hono/streaming";

import { run } from "../lib/db.js";
import {
  cancelExecution,
  host,
  queryExecution,
  resolveNode,
  signalExecution,
  startExecution,
} from "../lib/engine.js";
import { subscribe } from "../lib/event-bus.js";
import { HttpError, notFound } from "../lib/errors.js";
import { can } from "../lib/principal.js";
import { define, z } from "../lib/route.js";
import { setTaskResolver } from "../lib/task-hooks.js";
import type { AppEnv } from "../lib/types.js";
import { runSystem } from "../lib/db.js";

export const executions = new OpenAPIHono<AppEnv>();
const TAG = "Executions";
const id = z.object({ id: z.string().min(1) });
const json = z.record(z.unknown());

const COLUMNS = `e.id, e.status, e.error_message, e.outcome, e.trigger_kind, e.simulated, e.correlation_id, e.entity_type, e.entity_id,
  e.parent_execution_id, e.flow_id, e.flow_version_id, e.delegation_id, e.created_at, e.updated_at, f.name AS flow_name, f.key AS flow_key, v.version AS flow_version`;
const FROM = "FROM executions e LEFT JOIN flows f ON f.id = e.flow_id LEFT JOIN flow_versions v ON v.id = e.flow_version_id";

define(executions, { method: "get", path: "/executions", tag: TAG, summary: "List executions", permission: "executions:read", query: z.object({
  status: z.string().optional(), flow: z.string().optional(), entity_type: z.string().optional(), entity_id: z.string().uuid().optional(),
  simulated: z.enum(["true", "false"]).optional(), parent: z.string().optional(), correlation_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0) }) }, async (c, i) => {
  const q = i.query;
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (q.status) add("e.status = ANY(string_to_array(?, ','))", q.status);
  if (q.flow) { params.push(q.flow); where.push(`(e.flow_id::text = $${params.length} OR f.key = $${params.length})`); }
  if (q.entity_type) add("e.entity_type = ?", q.entity_type);
  if (q.entity_id) add("e.entity_id = ?", q.entity_id);
  add("e.simulated = ?", q.simulated === "true");
  if (q.parent) add("e.parent_execution_id = ?", q.parent);
  if (q.correlation_id) add("e.correlation_id = ?", q.correlation_id);
  const rows = await run(c, async (db) => {
    const list = await db.query(`SELECT ${COLUMNS} ${FROM} WHERE ${where.join(" AND ")} ORDER BY e.created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`, params);
    const total = await db.query(`SELECT count(*)::int AS n ${FROM} WHERE ${where.join(" AND ")}`, params);
    return { items: list.rows, total: total.rows[0]?.n ?? 0 };
  });
  return c.json(rows);
});

define(executions, { method: "post", path: "/executions", tag: TAG, summary: "Start an execution", status: 202, description: "Runs a published flow version. Simulations (`simulate: true`) run on isolated workers, never touch real systems and may use drafts or an ad-hoc diagram.", permission: "executions:run", body: z.object({
  flow: z.string().optional(), version: z.number().int().positive().optional(), diagram: z.unknown().optional(),
  input: json.default({}), variables: json.default({}), simulate: z.boolean().default(false), stepMode: z.boolean().default(false),
  correlationId: z.string().max(200).optional(), entity: z.object({ type: z.string(), id: z.string().uuid() }).optional(),
  delegationId: z.string().uuid().optional(), idempotencyKey: z.string().max(100).optional() }) }, async (c, i) => {
  const b = i.body;
  const p = c.get("principal");
  if (b.simulate && !can(p, "flows:simulate")) throw new HttpError(403, "Missing permission flows:simulate", "forbidden");
  const started = await startExecution({
    ...(b.flow ? { flow: b.flow } : {}),
    ...(b.version ? { version: b.version } : {}),
    ...(b.diagram !== undefined ? { diagram: b.diagram } : {}),
    triggerPayload: b.input,
    variables: b.variables,
    simulated: b.simulate,
    stepMode: b.stepMode,
    triggerKind: b.simulate ? "simulation" : "manual",
    correlationId: b.correlationId ?? null,
    entity: b.entity ?? null,
    scope: { delegationId: b.delegationId ?? null },
    userId: p.kind === "user" ? p.id : null,
    ...(b.idempotencyKey ? { idempotencyKey: b.idempotencyKey } : {}),
  });
  return c.json(started, 202);
});

define(executions, { method: "get", path: "/executions/{id}", tag: TAG, summary: "Get an execution with its waits and tasks", permission: "executions:read", params: id }, async (c, i) => {
  const row = await run(c, async (db) => {
    const e = (await db.query(`SELECT ${COLUMNS}, e.trigger_payload, e.temporal_workflow_id ${FROM} WHERE e.id = $1`, [i.params.id])).rows[0];
    if (!e) return null;
    const waits = (await db.query("SELECT node_id, kind, correlation_key, due_at, resolved_at, created_at FROM execution_waits WHERE execution_id = $1 ORDER BY created_at", [i.params.id])).rows;
    const tasks = (await db.query("SELECT id, number, title, status, priority, node_id, assignee_email::text AS assignee_email, due_at FROM tasks WHERE execution_id = $1 ORDER BY created_at", [i.params.id])).rows;
    const children = (await db.query("SELECT id, status, flow_id FROM executions WHERE parent_execution_id = $1 ORDER BY created_at", [i.params.id])).rows;
    return { ...e, waits, tasks, children };
  });
  if (!row) throw notFound("Execution");
  return c.json(row);
});

define(executions, { method: "get", path: "/executions/{id}/events", tag: TAG, summary: "Execution timeline events", permission: "executions:read", params: id, query: z.object({
  after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(5000).default(1000) }) }, async (c, i) => {
  const rows = await run(c, async (db) => {
    const visible = await db.query("SELECT status FROM executions WHERE id = $1", [i.params.id]);
    if (!visible.rows[0]) return null;
    return (await db.query("SELECT sequence, type, payload, node_id, created_at FROM execution_events WHERE execution_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3", [i.params.id, i.query.after, i.query.limit])).rows;
  });
  if (!rows) throw notFound("Execution");
  return c.json({ events: rows });
});

/** Server-sent events: replays history after `after`, then follows pg_notify until the execution ends. */
define(executions, { method: "get", path: "/executions/{id}/stream", tag: TAG, summary: "Live event stream (SSE)", permission: "executions:read", params: id, query: z.object({ after: z.coerce.number().int().min(0).default(0) }) }, async (c, i) => {
  const executionId = i.params.id;
  const exists = await run(c, async (db) => (await db.query("SELECT status FROM executions WHERE id = $1", [executionId])).rows[0]);
  if (!exists) throw notFound("Execution");
  return streamSSE(c, async (stream) => {
    let last = Number(c.req.header("last-event-id") ?? i.query.after) || 0;
    let wake: (() => void) | undefined;
    const unsubscribe = subscribe(executionId, () => wake?.());
    let aborted = false;
    stream.onAbort(() => { aborted = true; wake?.(); });
    try {
      while (!aborted) {
        const { events, status } = await runSystem(async (db) => ({
          events: (await db.query<{ sequence: number; type: string; payload: unknown; node_id: string | null; created_at: Date }>(
            "SELECT sequence, type, payload, node_id, created_at FROM execution_events WHERE execution_id = $1 AND sequence > $2 ORDER BY sequence LIMIT 500", [executionId, last])).rows,
          status: (await db.query<{ status: string }>("SELECT status FROM executions WHERE id = $1", [executionId])).rows[0]?.status,
        }));
        for (const e of events) {
          await stream.writeSSE({ id: String(e.sequence), event: e.type, data: JSON.stringify({ sequence: e.sequence, type: e.type, nodeId: e.node_id, payload: e.payload, at: e.created_at }) });
          last = e.sequence;
        }
        if (events.length === 0 && status && (TERMINAL_STATUSES as readonly string[]).includes(status)) {
          await stream.writeSSE({ event: "end", data: JSON.stringify({ status }) });
          break;
        }
        if (events.length < 500) await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 2000); });
      }
    } finally {
      unsubscribe();
    }
  });
});

define(executions, { method: "get", path: "/executions/{id}/state", tag: TAG, summary: "Live interpreter state (running executions)", permission: "executions:read", params: id }, async (c, i) => {
  const visible = await run(c, async (db) => (await db.query("SELECT status FROM executions WHERE id = $1", [i.params.id])).rows[0]);
  if (!visible) throw notFound("Execution");
  const state = (TERMINAL_STATUSES as readonly string[]).includes(visible.status) ? null : await queryExecution(i.params.id);
  return c.json({ status: visible.status, state });
});

async function visible(c: Parameters<typeof run>[0], executionId: string): Promise<void> {
  const row = await run(c, async (db) => (await db.query("SELECT 1 FROM executions WHERE id = $1", [executionId])).rows[0]);
  if (!row) throw notFound("Execution");
}

define(executions, { method: "post", path: "/executions/{id}/cancel", tag: TAG, summary: "Cancel an execution", permission: "executions:cancel", params: id }, async (c, i) => {
  await visible(c, i.params.id);
  await cancelExecution(i.params.id);
  return c.json({ ok: true });
});
for (const [action, signal, permission] of [["pause", "pause", "executions:cancel"], ["resume", "resume", "executions:cancel"], ["stop", "stop", "executions:cancel"]] as const) {
  define(executions, { method: "post", path: `/executions/{id}/${action}`, tag: TAG, summary: `${action[0]!.toUpperCase()}${action.slice(1)} an execution`, permission, params: id }, async (c, i) => {
    await visible(c, i.params.id);
    await signalExecution(i.params.id, signal);
    return c.json({ ok: true });
  });
}
define(executions, { method: "post", path: "/executions/{id}/step", tag: TAG, summary: "Release the next node(s) of a step-through simulation", permission: "flows:simulate", params: id, body: z.object({ count: z.number().int().min(1).max(100).default(1) }) }, async (c, i) => {
  await visible(c, i.params.id);
  await signalExecution(i.params.id, "step", { count: i.body.count });
  return c.json({ ok: true });
});

define(executions, { method: "post", path: "/executions/{id}/nodes/{nodeId}/resolve", tag: TAG, summary: "Resolve a waiting node (approve, reject, advance)", permission: "executions:resolve", params: id.extend({ nodeId: z.string() }), body: z.object({
  nextPort: z.string().optional(), output: z.unknown().optional(), comment: z.string().optional(),
  outcome: z.object({ value: z.string(), resolvedBy: z.string() }).optional() }) }, async (c, i) => {
  await visible(c, i.params.id);
  const p = c.get("principal");
  await resolveNode(i.params.id, i.params.nodeId, {
    ...(i.body.nextPort ? { nextPort: i.body.nextPort } : {}),
    output: i.body.output ?? { comment: i.body.comment ?? null, by: p.label },
    ...(i.body.outcome ? { outcome: i.body.outcome } : {}),
  });
  return c.json({ ok: true });
});

/** External event (integration callback, other system): wakes every execution waiting on `name[|correlation]`. */
define(executions, { method: "post", path: "/executions/events", tag: TAG, summary: "Deliver an external event to waiting executions", permission: "executions:resolve", body: z.object({
  name: z.string().min(1), correlation: z.string().optional(), payload: z.unknown().optional(), executionId: z.string().optional() }) }, async (c, i) => {
  const b = i.body;
  const delivered = await deliverEvent(host, { name: b.name, ...(b.correlation ? { correlation: b.correlation } : {}), payload: b.payload, ...(b.executionId ? { executionId: b.executionId } : {}) });
  return c.json({ delivered });
});

setTaskResolver(async (task, resolution) => {
  try {
    await resolveNode(task.executionId, task.nodeId, { ...(resolution.nextPort ? { nextPort: resolution.nextPort } : {}), output: resolution.output ?? {} });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "resolve failed" };
  }
});
