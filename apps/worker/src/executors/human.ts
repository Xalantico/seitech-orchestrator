import { parseDuration, PRIORITY_OPTIONS } from "@orchestrador/shared";
import type { CompiledNode, NodeContext } from "@orchestrador/engine";

import { renderJson, renderString } from "./template.js";
import { asRecord, PermanentNodeError, type Executor, type ExecutorDeps, type ExecutorRegistry } from "./types.js";

type Action = { action: string; label: string; nextPort: string };

const PRIORITIES = PRIORITY_OPTIONS.map(([v]) => v);

const USER_TASK_ACTIONS: Action[] = [
  { action: "complete", label: "Completar", nextPort: "done" },
  { action: "reject", label: "Rechazar", nextPort: "rejected" },
];
const APPROVAL_ACTIONS: Action[] = [
  { action: "advance", label: "Aprobar", nextPort: "approved" },
  { action: "reject", label: "Rechazar", nextPort: "rejected" },
];

type TaskSpec = {
  node: CompiledNode;
  ctx: NodeContext;
  deps: ExecutorDeps;
  kind: "user_task" | "approval" | "subtask";
  actions: Action[];
  nodeId?: string;
  title?: string;
  extra?: Record<string, unknown>;
};

/** Idempotent: (execution, node) is unique, so an activity retry returns the task it already created. */
async function createTask(spec: TaskSpec) {
  const { node, ctx, deps } = spec;
  const cfg = asRecord(node.config);
  const title = (spec.title ?? renderString(ctx, cfg.title || cfg.prompt || node.label || node.id)).trim().slice(0, 200);
  if (!title) throw new PermanentNodeError("task_invalid", "The task needs a title");
  const priority = renderString(ctx, cfg.priority || "medium");
  if (!PRIORITIES.includes(priority)) throw new PermanentNodeError("task_invalid", `Invalid priority "${priority}"`);
  const assignee = renderString(ctx, cfg.assigneeEmail).trim().toLowerCase();
  if (assignee && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(assignee)) throw new PermanentNodeError("task_invalid", `Invalid assignee email "${assignee}"`);
  const queueKey = renderString(ctx, cfg.queue).trim();
  const formKey = renderString(ctx, cfg.formKey).trim();
  const now = Date.now();
  const due = parseDuration(renderString(ctx, cfg.dueIn));
  const breach = parseDuration(renderString(ctx, cfg.breachAfter));
  const timeout = parseDuration(renderString(ctx, cfg.timeout));
  const dueAt = due !== null ? new Date(now + due).toISOString() : timeout !== null ? new Date(now + timeout).toISOString() : null;
  const slaDueAt = breach !== null ? new Date(now + breach).toISOString() : null;
  const extra = {
    flowId: ctx.flowId ?? null,
    nodeLabel: node.label ?? node.id,
    approverRole: cfg.approverRole ? renderString(ctx, cfg.approverRole) : undefined,
    secondValidation: cfg.secondValidation === true,
    ...spec.extra,
  };

  return deps.sys(async (db) => {
    const queueId = queueKey ? ((await db.query<{ id: string }>("SELECT id FROM queues WHERE key = $1 AND active", [queueKey])).rows[0]?.id ?? null) : null;
    if (queueKey && !queueId) throw new PermanentNodeError("queue_not_found", `Work queue "${queueKey}" does not exist`);
    const formId = formKey ? ((await db.query<{ id: string }>("SELECT id FROM forms WHERE key = $1", [formKey])).rows[0]?.id ?? null) : null;
    if (formKey && !formId) throw new PermanentNodeError("form_not_found", `Form "${formKey}" does not exist`);
    const r = await db.query<{ id: string; number: number }>(
      `INSERT INTO tasks (title, description, priority, assignee_email, queue_id, source, kind, execution_id, node_id, entity_type, entity_id,
                          form_id, available_actions, due_at, sla_due_at, delegation_id, zone_id, project_id, extra)
       VALUES ($1, $2, $3, $4, $5, 'flow', $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18::jsonb)
       ON CONFLICT (execution_id, node_id) WHERE execution_id IS NOT NULL DO UPDATE SET updated_at = tasks.updated_at
       RETURNING id, number`,
      [title, renderString(ctx, cfg.instructions), priority, assignee || null, queueId, spec.kind, ctx.executionId, spec.nodeId ?? node.id,
        ctx.entity?.type ?? null, ctx.entity?.id ?? null, formId, JSON.stringify(spec.actions), dueAt, slaDueAt,
        ctx.scope?.delegationId ?? null, ctx.scope?.zoneId ?? null, ctx.scope?.projectId ?? null, JSON.stringify(extra)],
    );
    return r.rows[0]!;
  });
}

function taskExecutor(kind: "user_task" | "approval", actions: Action[]): Executor {
  return {
    sideEffects: true,
    simulate: () => ({ waiting: true }),
    async run(node, ctx, deps) {
      await createTask({ node, ctx, deps, kind, actions });
      return { waiting: true };
    },
  };
}

const subtasks: Executor = {
  sideEffects: true,
  simulate: () => ({ waiting: true }),
  async run(node, ctx, deps) {
    const cfg = asRecord(node.config);
    const raw = renderJson(ctx, cfg.items, []);
    const items = (Array.isArray(raw) ? raw : []) as unknown[];
    if (items.length === 0) return { waiting: false, output: { subtasks: 0 }, nextPort: "done" };
    const base = renderString(ctx, cfg.title);
    for (const [index, item] of items.entries()) {
      const entry = typeof item === "string" ? { title: item } : asRecord(item);
      await createTask({
        node, ctx, deps, kind: "subtask", actions: [{ action: "complete", label: "Hecha", nextPort: "done" }],
        nodeId: `${node.id}#${index + 1}`,
        title: `${base}: ${String(entry.title ?? `#${index + 1}`)}`,
        extra: { parentNode: node.id, index: index + 1, of: items.length },
      });
    }
    return { waiting: true };
  },
};

export const humanExecutors: ExecutorRegistry = {
  "human.user-task": taskExecutor("user_task", USER_TASK_ACTIONS),
  "human.approval": taskExecutor("approval", APPROVAL_ACTIONS),
  "poc/approval": taskExecutor("approval", APPROVAL_ACTIONS),
  "human.subtask": subtasks,
};
