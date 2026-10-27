import { interpolateString, TICKET_PRIORITIES } from "@orchestrador/shared";

import { httpExecutor } from "./http.js";
import { templateOf } from "./template.js";
import { asRecord, PermanentNodeError, TransientNodeError, type ExecutorRegistry } from "./types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The proof-of-concept node types, kept so stored diagrams run unchanged. */
export const pocExecutors: ExecutorRegistry = {
  "poc/http-request": httpExecutor,

  "poc/flaky": {
    async run(node, ctx) {
      const config = asRecord(node.config);
      const failUntil = Number(config.failUntilAttempt ?? 3);
      const delayMs = Number(config.delayMs ?? 400);
      if (delayMs > 0) await sleep(delayMs);
      const attempt = ctx.attempt ?? 1;
      if (attempt < failUntil) throw new TransientNodeError("flaky", `intentional failure on attempt ${attempt} (succeeds at ${failUntil})`);
      return { output: { attempt, ok: true } };
    },
  },

  "poc/notify": {
    sideEffects: true,
    simulate: (node) => ({ output: { simulated: true, channel: String(asRecord(node.config).channel ?? "email"), delivered: false } }),
    async run(node, ctx) {
      const config = asRecord(node.config);
      const t = templateOf(ctx);
      return {
        output: {
          channel: String(config.channel ?? "email"),
          to: interpolateString(String(config.to ?? ""), t),
          subject: interpolateString(String(config.subject ?? ""), t),
          body: interpolateString(String(config.body ?? ""), t),
          delivered: true,
          mock: true,
          at: new Date().toISOString(),
        },
      };
    },
  },

  "poc/create-ticket": {
    sideEffects: true,
    simulate: (node) => ({ output: { simulated: true, title: String(asRecord(node.config).title ?? "") } }),
    async run(node, ctx, deps) {
      const config = asRecord(node.config);
      const t = templateOf(ctx);
      const title = interpolateString(String(config.title ?? ""), t).trim();
      const description = interpolateString(String(config.ticketDescription ?? ""), t);
      const assignee = interpolateString(String(config.assigneeEmail ?? ""), t).trim();
      const priority = String(config.priority ?? "medium");
      if (!title) throw new PermanentNodeError("ticket_invalid", "Create ticket needs a title");
      if (!(TICKET_PRIORITIES as readonly string[]).includes(priority)) throw new PermanentNodeError("ticket_invalid", `Invalid priority "${priority}"`);
      if (assignee && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(assignee)) throw new PermanentNodeError("ticket_invalid", `Invalid assignee email "${assignee}"`);
      // (execution_id, node_id) is unique, so a retried activity returns the existing ticket.
      const row = await deps.sys(async (db) =>
        (
          await db.query<{ id: string; number: number; title: string; status: string; priority: string; assignee_email: string | null }>(
            `INSERT INTO tasks (title, description, priority, assignee_email, source, kind, execution_id, node_id, delegation_id, zone_id, project_id)
             VALUES ($1, $2, $3, $4, 'flow', 'ticket', $5, $6, $7, $8, $9)
             ON CONFLICT (execution_id, node_id) WHERE execution_id IS NOT NULL DO UPDATE SET updated_at = tasks.updated_at
             RETURNING id, number, title, status, priority, assignee_email::text AS assignee_email`,
            [title.slice(0, 200), description, priority, assignee ? assignee.toLowerCase() : null, ctx.executionId, node.id, ctx.scope?.delegationId ?? null, ctx.scope?.zoneId ?? null, ctx.scope?.projectId ?? null],
          )
        ).rows[0]!,
      );
      return { output: { ticketId: row.id, number: Number(row.number), title: row.title, status: row.status, priority: row.priority, assigneeEmail: row.assignee_email } };
    },
  },
};
