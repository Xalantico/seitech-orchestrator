import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { TICKET_PRIORITIES } from "@orchestrador/shared";

import { crud, z as cz, zJson, zUuid } from "../lib/crud.js";
import { env } from "../env.js";
import { retryIntegrationError } from "@orchestrador/connector-sdk";
import { run, runSystem } from "../lib/db.js";
import { saveDocument } from "../lib/documents.js";
import { HttpError, notFound } from "../lib/errors.js";
import { resolveTaskWait } from "../lib/task-hooks.js";
import { define, z } from "../lib/route.js";
import { requirePermission } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";

export const tasks = new OpenAPIHono<AppEnv>();
const TAG = "Tasks";
const PRIORITY = z.enum(TICKET_PRIORITIES);
const STATUS = z.enum(["open", "in_progress", "resolved", "closed", "cancelled"]);

tasks.route("/", crud({
  permissions: { read: "queues:read", write: "queues:write" }, tag: "Queues", table: "queues", basePath: "/queues",
  fields: {
    key: { schema: cz.string().regex(/^[a-z][a-z0-9-]*$/) }, name: { schema: cz.string().min(1) }, description: { schema: cz.string().optional() },
    role_id: { schema: zUuid.nullable().optional() }, sla_policy_id: { schema: zUuid.nullable().optional() },
    delegation_id: { schema: zUuid.nullable().optional() }, active: { schema: cz.boolean().optional() }, extra: { schema: zJson.optional(), cast: "jsonb" },
  },
  readonly: ["created_at"], search: ["key", "name"], defaultOrder: "name",
}));

const SELECT = `
  SELECT t.id, t.number, t.title, t.description, t.status, t.priority, t.assignee_email::text AS assignee_email, t.assignee_user_id,
         t.source, t.kind, t.queue_id, q.name AS queue_name, t.execution_id, t.node_id, t.entity_type, t.entity_id, t.form_id, t.form_data,
         t.available_actions, t.due_at, t.sla_due_at, t.resolved_at, t.delegation_id, t.zone_id, t.project_id, t.extra, t.created_at, t.updated_at,
         (t.sla_due_at IS NOT NULL AND t.sla_due_at < now() AND t.status IN ('open', 'in_progress')) AS sla_breached
  FROM tasks t LEFT JOIN queues q ON q.id = t.queue_id`;

const listQuery = z.object({
  status: z.string().optional(), priority: z.string().optional(), queue_id: z.string().uuid().optional(), queue_key: z.string().optional(),
  assignee: z.string().optional(), entity_type: z.string().optional(), entity_id: z.string().uuid().optional(),
  source: z.string().optional(), overdue: z.enum(["true", "false"]).optional(), q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0),
});

define(tasks, { method: "get", path: "/tasks", tag: TAG, summary: "List tasks (work-queue inbox)", permission: "tasks:read", query: listQuery }, async (c, i) => {
  const q = i.query;
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
  if (q.status) add("t.status = ANY(string_to_array(?, ','))", q.status);
  if (q.priority) add("t.priority = ?", q.priority);
  if (q.queue_id) add("t.queue_id = ?", q.queue_id);
  if (q.queue_key) add("q.key = ?", q.queue_key);
  if (q.assignee === "me") add("t.assignee_user_id = ?", c.get("principal").id);
  else if (q.assignee === "none") where.push("t.assignee_user_id IS NULL AND t.assignee_email IS NULL");
  else if (q.assignee) add("t.assignee_email = ?", q.assignee);
  if (q.entity_type) add("t.entity_type = ?", q.entity_type);
  if (q.entity_id) add("t.entity_id = ?", q.entity_id);
  if (q.source) add("t.source = ?", q.source);
  if (q.overdue === "true") where.push("t.sla_due_at < now() AND t.status IN ('open', 'in_progress')");
  if (q.q) add("(t.title ILIKE ? OR t.description ILIKE ?)", `%${q.q.replace(/[\\%_]/g, "\\$&")}%`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const result = await run(c, async (db) => {
    const items = await db.query(`${SELECT} ${whereSql} ORDER BY (t.status IN ('open','in_progress')) DESC, t.sla_due_at NULLS LAST, t.created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`, params);
    const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tasks t LEFT JOIN queues q ON q.id = t.queue_id ${whereSql}`, params);
    return { items: items.rows, total: total.rows[0]!.n };
  });
  return c.json(result);
});

define(tasks, { method: "post", path: "/tasks", tag: TAG, summary: "Create a back-office task outside any flow (ORF-037)", permission: "tasks:write", status: 201, body: z.object({
  title: z.string().min(1).max(200), description: z.string().default(""), priority: PRIORITY.default("medium"), queue_id: z.string().uuid().nullable().optional(),
  assignee_email: z.string().email().nullable().optional(), due_at: z.string().datetime().nullable().optional(),
  entity_type: z.string().nullable().optional(), entity_id: z.string().uuid().nullable().optional(), delegation_id: z.string().uuid().nullable().optional(),
  extra: zJson.optional() }) }, async (c, i) => {
  const b = i.body;
  const p = c.get("principal");
  const row = await run(c, async (db) => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO tasks (title, description, priority, queue_id, assignee_email, due_at, entity_type, entity_id, delegation_id, extra, created_by, source, sla_due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::jsonb, '{}'), $11, 'manual',
               (SELECT now() + make_interval(hours => s.target_hours) FROM queues q JOIN sla_policies s ON s.id = q.sla_policy_id WHERE q.id = $4))
       RETURNING id`,
      [b.title.trim(), b.description, b.priority, b.queue_id ?? null, b.assignee_email?.toLowerCase() ?? null, b.due_at ?? null, b.entity_type ?? null, b.entity_id ?? null, b.delegation_id ?? null, b.extra ? JSON.stringify(b.extra) : null, p.kind === "user" ? p.id : null],
    );
    await db.query("INSERT INTO task_actions (task_id, action, actor) VALUES ($1, 'created', $2)", [r.rows[0]!.id, p.label]);
    return (await db.query(`${SELECT} WHERE t.id = $1`, [r.rows[0]!.id])).rows[0];
  });
  return c.json(row, 201);
});

define(tasks, { method: "get", path: "/tasks/{id}", tag: TAG, summary: "Task with its action history", permission: "tasks:read", params: z.object({ id: z.string().uuid() }) }, async (c, i) => {
  const out = await run(c, async (db) => {
    const t = (await db.query(`${SELECT} WHERE t.id = $1`, [i.params.id])).rows[0];
    if (!t) return null;
    const actions = (await db.query("SELECT action, actor, payload, at FROM task_actions WHERE task_id = $1 ORDER BY at", [i.params.id])).rows;
    return { ...t, history: actions };
  });
  if (!out) throw notFound("Task");
  return c.json(out);
});

define(tasks, { method: "patch", path: "/tasks/{id}", tag: TAG, summary: "Edit a task", permission: "tasks:write", params: z.object({ id: z.string().uuid() }), body: z.object({
  title: z.string().min(1).max(200).optional(), description: z.string().optional(), status: STATUS.optional(), priority: PRIORITY.optional(),
  assignee_email: z.string().email().nullable().optional(), queue_id: z.string().uuid().nullable().optional(), due_at: z.string().datetime().nullable().optional() }) }, async (c, i) => {
  const b = i.body;
  const row = await run(c, async (db) => {
    const sets: string[] = [];
    const params: unknown[] = [i.params.id];
    const set = (col: string, v: unknown, cast = "") => { params.push(v); sets.push(`${col} = $${params.length}${cast}`); };
    if (b.title !== undefined) set("title", b.title.trim());
    if (b.description !== undefined) set("description", b.description);
    if (b.status !== undefined) { set("status", b.status); sets.push(["resolved", "closed", "cancelled"].includes(b.status) ? "resolved_at = now()" : "resolved_at = NULL"); }
    if (b.priority !== undefined) set("priority", b.priority);
    if (b.assignee_email !== undefined) set("assignee_email", b.assignee_email?.toLowerCase() ?? null);
    if (b.queue_id !== undefined) set("queue_id", b.queue_id);
    if (b.due_at !== undefined) set("due_at", b.due_at);
    if (sets.length === 0) throw new HttpError(400, "Nothing to update", "bad_request");
    const r = await db.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $1 RETURNING id`, params);
    if (!r.rows[0]) return null;
    await db.query("INSERT INTO task_actions (task_id, action, actor, payload) VALUES ($1, 'updated', nullif(current_setting('app.actor', true), ''), $2::jsonb)", [i.params.id, JSON.stringify(b)]);
    return (await db.query(`${SELECT} WHERE t.id = $1`, [i.params.id])).rows[0];
  });
  if (!row) throw notFound("Task");
  return c.json(row);
});

define(tasks, { method: "post", path: "/tasks/{id}/claim", tag: TAG, summary: "Claim a task for myself", permission: "tasks:claim", params: z.object({ id: z.string().uuid() }) }, async (c, i) => {
  const p = c.get("principal");
  const r = await run(c, async (db) => {
    const x = await db.query(
      `UPDATE tasks SET assignee_user_id = $2, assignee_email = $3, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END
       WHERE id = $1 AND (assignee_user_id IS NULL OR assignee_user_id = $2) AND status IN ('open', 'in_progress') RETURNING id`,
      [i.params.id, p.id, p.email ?? null],
    );
    if (x.rows[0]) await db.query("INSERT INTO task_actions (task_id, action, actor) VALUES ($1, 'claimed', $2)", [i.params.id, p.label]);
    return x;
  });
  if (!r.rows[0]) throw new HttpError(409, "Task already claimed or closed", "conflict");
  return c.json({ ok: true });
});

define(tasks, { method: "post", path: "/tasks/{id}/release", tag: TAG, summary: "Release a claimed task", permission: "tasks:claim", params: z.object({ id: z.string().uuid() }) }, async (c, i) => {
  await run(c, (db) => db.query("UPDATE tasks SET assignee_user_id = NULL, assignee_email = NULL, status = 'open' WHERE id = $1 AND status = 'in_progress'", [i.params.id]));
  return c.json({ ok: true });
});

/** ORF-038: buttons to act on an exception (advance a state, complete a form, retry, escalate, comment). */
define(tasks, { method: "post", path: "/tasks/{id}/actions", tag: TAG, summary: "Run an action on a task", permission: "tasks:act", params: z.object({ id: z.string().uuid() }), body: z.object({
  action: z.enum(["comment", "advance", "complete", "reject", "reassign", "escalate", "retry"]), comment: z.string().optional(), nextPort: z.string().optional(), assignee_email: z.string().email().optional(), formData: zJson.optional() }) }, async (c, i) => {
  const b = i.body;
  const p = c.get("principal");
  type TaskRow = { id: string; execution_id: string | null; node_id: string | null; status: string; priority: string; kind: string; available_actions: { action: string; nextPort?: string }[]; extra: Record<string, unknown> };
  const task = await run(c, async (db) => (await db.query<TaskRow>("SELECT id, execution_id, node_id, status, priority, kind, available_actions, extra FROM tasks WHERE id = $1", [i.params.id])).rows[0]);
  if (!task) throw notFound("Task");
  if (["resolved", "closed", "cancelled"].includes(task.status) && b.action !== "comment") throw new HttpError(409, "Task is already closed", "conflict");

  let flow: { ok: boolean; error?: string } | null = null;
  let pending: string | undefined;
  // Integration error tasks (ORF-046): "retry" re-queues the failed exchange instead of advancing a flow.
  if (task.kind === "integration_error" && b.action === "retry") {
    const errorId = typeof task.extra.integrationErrorId === "string" ? task.extra.integrationErrorId : null;
    const requeued = errorId ? await runSystem((db) => retryIntegrationError(db, errorId, `Reintentado por ${p.label}`)) : "none";
    if (requeued === "none") throw new HttpError(409, "Nothing to retry: the exchange was already handled", "not_retryable");
    await run(c, (db) => db.query("INSERT INTO task_actions (task_id, action, actor, payload) VALUES ($1, 'retry', $2, $3::jsonb)", [i.params.id, p.label, JSON.stringify({ requeued })]));
    return c.json({ ok: true, flow: null, requeued });
  }
  if (["advance", "complete", "reject"].includes(b.action) && task.execution_id && task.node_id) {
    // Four-eyes: a second, different person must confirm before the flow advances (high-voltage inspections).
    if (task.extra.secondValidation === true && b.action !== "reject") {
      const first = task.extra.firstApprover as string | undefined;
      if (!first) {
        await run(c, (db) => db.query("UPDATE tasks SET status = 'in_progress', extra = extra || jsonb_build_object('firstApprover', $2::text, 'firstApprovedAt', now()) WHERE id = $1", [i.params.id, p.label]));
        await run(c, (db) => db.query("INSERT INTO task_actions (task_id, action, actor, payload) VALUES ($1, 'first_validation', $2, $3::jsonb)", [i.params.id, p.label, JSON.stringify({ comment: b.comment })]));
        return c.json({ ok: true, flow: null, pending: "second_validation" });
      }
      if (first === p.label) throw new HttpError(409, "The second validation must come from a different person", "same_validator");
    }
    const configured = task.available_actions?.find((a) => a.action === b.action)?.nextPort;
    const port = b.nextPort ?? configured ?? (b.action === "reject" ? "rejected" : "approved");
    // Sub-tasks only advance the flow when the last sibling closes.
    const parent = task.kind === "subtask" ? (task.extra.parentNode as string | undefined) : undefined;
    let target = { executionId: task.execution_id, nodeId: parent ?? task.node_id };
    let advance = true;
    if (parent) {
      const open = await run(c, async (db) => (await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM tasks WHERE execution_id = $1 AND extra->>'parentNode' = $2 AND id <> $3 AND status IN ('open', 'in_progress')", [task.execution_id, parent, task.id])).rows[0]?.n ?? 0);
      advance = open === 0;
      target = { executionId: task.execution_id, nodeId: parent };
    }
    if (advance) {
      flow = await resolveTaskWait(target, {
        nextPort: parent ? "done" : port,
        output: { action: b.action, comment: b.comment ?? null, form: b.formData ?? null, by: p.label, ...(task.extra.firstApprover ? { firstApprover: task.extra.firstApprover } : {}) },
        comment: b.comment,
      });
      if (!flow.ok) throw new HttpError(409, flow.error ?? "The flow could not be advanced", "flow_rejected");
    } else pending = "siblings_open";
  }

  await run(c, async (db) => {
    await db.query("INSERT INTO task_actions (task_id, action, actor, payload) VALUES ($1, $2, $3, $4::jsonb)", [i.params.id, b.action, p.label, JSON.stringify({ comment: b.comment, nextPort: b.nextPort, flow })]);
    if (b.action === "complete" || b.action === "advance") await db.query("UPDATE tasks SET status = 'resolved', resolved_at = now(), form_data = coalesce($2::jsonb, form_data) WHERE id = $1", [i.params.id, b.formData ? JSON.stringify(b.formData) : null]);
    if (b.action === "reject") await db.query("UPDATE tasks SET status = 'closed', resolved_at = now() WHERE id = $1", [i.params.id]);
    if (b.action === "reassign" && b.assignee_email) await db.query("UPDATE tasks SET assignee_email = $2, assignee_user_id = NULL WHERE id = $1", [i.params.id, b.assignee_email.toLowerCase()]);
    if (b.action === "escalate") await db.query("UPDATE tasks SET priority = 'urgent', extra = extra || jsonb_build_object('escalated_at', now()) WHERE id = $1", [i.params.id]);
  });
  return c.json({ ok: true, flow, ...(pending ? { pending } : {}) });
});

/** Attachments of a task (photos, PDFs, evidence): stored as documents linked to the task, scanned and versioned like any document. */
tasks.post(
  "/tasks/:id/attachments",
  requirePermission("tasks:act", "documents:write"),
  bodyLimit({ maxSize: env.MAX_UPLOAD_BYTES + 1_000_000, onError: (c) => c.json({ error: "File too large", code: "too_large" }, 413) }),
  async (c) => {
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(400, "Multipart field 'file' is required", "bad_request");
    const p = c.get("principal");
    const doc = await run(c, async (db) => {
      const t = (await db.query<{ delegation_id: string | null }>("SELECT delegation_id FROM tasks WHERE id = $1", [id])).rows[0];
      if (!t) throw notFound("Task");
      const created = await saveDocument(db, { data: Buffer.from(await file.arrayBuffer()), filename: file.name, mime: file.type || undefined, kind: "task_attachment", entityType: "task", entityId: id, delegationId: t.delegation_id }, p.kind === "user" ? p.id : null);
      await db.query("INSERT INTO task_actions (task_id, action, actor, payload) VALUES ($1, 'attachment', $2, $3::jsonb)", [id, p.label, JSON.stringify({ documentId: created.id, filename: file.name })]);
      return created;
    });
    return c.json(doc, 201);
  },
);

define(tasks, { method: "get", path: "/tasks/{id}/attachments", tag: TAG, summary: "Files attached to a task", permission: "tasks:read", params: z.object({ id: z.string().uuid() }) }, async (c, i) => {
  const r = await run(c, (db) => db.query("SELECT id, filename, mime, size_bytes, version, scan_status, created_at FROM documents WHERE entity_type = 'task' AND entity_id = $1 AND deleted_at IS NULL ORDER BY created_at", [i.params.id]));
  return c.json({ items: r.rows });
});
