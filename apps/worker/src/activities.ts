import { metrics } from "@orchestrador/observability";
import { toDefinition, type WorkflowDefinition } from "@orchestrador/shared";
import {
  TERMINAL_STATUSES,
  type ChildSpec,
  type CompensationEntry,
  type CompiledDefinition,
  type CompiledNode,
  type ExecutionInput,
  type HookName,
  type NodeContext,
  type NodeResult,
} from "@orchestrador/engine";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { randomUUID } from "node:crypto";

import { executors, PermanentNodeError, TransientNodeError } from "./executors/index.js";
import type { ExecutorDeps } from "./executors/index.js";
import { log, sys } from "./services.js";

export type EventRow = { sequence: number; type: string; payload?: unknown; nodeId?: string };

function toFailure(error: unknown, attempt: number): ApplicationFailure {
  if (error instanceof ApplicationFailure) return error;
  if (error instanceof PermanentNodeError) {
    return ApplicationFailure.create({ message: error.message, type: error.code, nonRetryable: true, details: [{ nodeError: 1, code: error.code, attempt }] });
  }
  if (error instanceof TransientNodeError) {
    return ApplicationFailure.create({ message: error.message, type: error.code, nonRetryable: false, details: [{ nodeError: 1, code: error.code, attempt }] });
  }
  const message = error instanceof Error ? error.message : String(error);
  return ApplicationFailure.create({ message, type: "unexpected", nonRetryable: false, details: [{ nodeError: 1, code: "unexpected", attempt }] });
}

const deps = (): ExecutorDeps => ({
  log,
  sys,
  heartbeat: (details) => {
    try {
      Context.current().heartbeat(details);
    } catch {
      /* not inside an activity (unit tests) */
    }
  },
});

/** `event` or `event|correlation`; the API matches incoming events against this key. */
const waitKey = (p: Record<string, unknown>): string | null =>
  typeof p.eventName === "string" && p.eventName ? (typeof p.correlation === "string" && p.correlation ? `${p.eventName}|${p.correlation}` : p.eventName) : null;

const toTimestamp = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export function createActivities() {
  return {
    /** Runs one node's executor. Side-effecting executors are replaced by stubs in simulated executions. */
    async executeNode(node: CompiledNode, ctx: NodeContext): Promise<NodeResult> {
      const attempt = Context.current().info.attempt;
      const executor = executors[node.type];
      if (!executor) {
        throw ApplicationFailure.create({ message: `No executor registered for node type "${node.type}"`, type: "no_executor", nonRetryable: true, details: [{ nodeError: 1, code: "no_executor", attempt }] });
      }
      const stop = metrics.nodeActivityDuration.startTimer({ node_type: node.type });
      try {
        if (ctx.simulated && executor.sideEffects) {
          const simulated = executor.simulate ? executor.simulate(node, ctx) : { output: { simulated: true, type: node.type } };
          stop({ result: "simulated" });
          return simulated;
        }
        const result = await executor.run(node, { ...ctx, attempt }, deps());
        stop({ result: "ok" });
        return result;
      } catch (error) {
        stop({ result: "error" });
        log.warn({ executionId: ctx.executionId, node: node.id, type: node.type, attempt, err: error instanceof Error ? error.message : String(error) }, "node failed");
        throw toFailure(error, attempt);
      }
    },

    /** Saga compensation: undoes a completed node's side effect. */
    async executeCompensation(entry: CompensationEntry, ctx: NodeContext): Promise<void> {
      const attempt = Context.current().info.attempt;
      const spec = entry.spec;
      const executor = executors[spec.type];
      if (!executor) {
        throw ApplicationFailure.create({ message: `No executor for compensation "${spec.type}"`, type: "no_executor", nonRetryable: true });
      }
      const node: CompiledNode = { id: `${entry.nodeId}#compensate`, type: spec.type, kind: "activity", config: { ...(spec.config ?? {}), original: entry.output } };
      try {
        if (ctx.simulated && executor.sideEffects) return;
        await executor.run(node, { ...ctx, attempt, nodeOutputs: { ...ctx.nodeOutputs, [entry.nodeId]: entry.output } }, deps());
      } catch (error) {
        throw toFailure(error, attempt);
      }
      await sys((db) =>
        db.query("UPDATE compensations SET status = 'done' WHERE execution_id = $1 AND node_id = $2", [ctx.executionId, entry.nodeId]),
      );
    },

    /** Batched, idempotent event append (the interpreter flushes up to 200 events per call). */
    async emitEvents(executionId: string, rows: EventRow[]): Promise<void> {
      if (rows.length === 0) return;
      await sys(async (db) => {
        await db.query(
          `INSERT INTO execution_events (execution_id, sequence, type, payload, node_id)
           SELECT $1, e.sequence, e.type, e.payload, e.node_id
           FROM jsonb_to_recordset($2::jsonb) AS e(sequence int, type text, payload jsonb, node_id text)
           ON CONFLICT (execution_id, sequence) DO NOTHING`,
          [executionId, JSON.stringify(rows.map((r) => ({ sequence: r.sequence, type: r.type, payload: r.payload ?? null, node_id: r.nodeId ?? null })))],
        );
        await db.query("SELECT pg_notify('orq_exec', $1)", [executionId]);
      });
    },

    async updateExecutionStatus(executionId: string, status: string, errorMessage?: string, outcome?: unknown): Promise<void> {
      await sys((db) =>
        db.query(
          `UPDATE executions SET
             status = CASE WHEN status = ANY($5::text[]) THEN status ELSE $2 END,
             error_message = COALESCE($3, error_message),
             outcome = COALESCE($4::jsonb, outcome),
             updated_at = now()
           WHERE id = $1`,
          [executionId, status, errorMessage ?? null, outcome === undefined ? null : JSON.stringify(outcome), [...TERMINAL_STATUSES]],
        ),
      );
    },

    /** Bookkeeping the rest of the platform reads: waits, SLA events, domain events, cleanup. */
    async engineHook(name: HookName, payload: Record<string, unknown>): Promise<void> {
      const executionId = String(payload.executionId);
      const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : null;
      await sys(async (db) => {
        switch (name) {
          case "waitRegistered":
            await db.query(
              `INSERT INTO execution_waits (execution_id, node_id, kind, correlation_key, due_at)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (execution_id, node_id) DO UPDATE
                 SET kind = EXCLUDED.kind, correlation_key = EXCLUDED.correlation_key, due_at = EXCLUDED.due_at, resolved_at = NULL`,
              [executionId, nodeId, payload.kind, waitKey(payload), toTimestamp(payload.dueAt)],
            );
            break;
          case "waitResolved":
          case "waitTimedOut":
            await db.query("UPDATE execution_waits SET resolved_at = now() WHERE execution_id = $1 AND node_id = $2", [executionId, nodeId]);
            break;
          case "slaWarning":
          case "slaBreached": {
            const kind = name === "slaWarning" ? "sla_warning_at" : "sla_breached_at";
            await db.query("UPDATE tasks SET extra = extra || jsonb_build_object($3::text, now()) WHERE execution_id = $1 AND node_id = $2", [executionId, nodeId, kind]);
            await db.query(
              `INSERT INTO domain_events (type, entity_type, entity_id, payload, correlation_id)
               SELECT $3, e.entity_type, e.entity_id, jsonb_build_object('executionId', $1::text, 'nodeId', $2::text), $1
               FROM executions e WHERE e.id = $1`,
              [executionId, nodeId, name === "slaWarning" ? "sla.warning" : "sla.breached"],
            );
            break;
          }
          case "executionFinished": {
            const status = String(payload.status);
            await db.query("UPDATE execution_waits SET resolved_at = now() WHERE execution_id = $1 AND resolved_at IS NULL", [executionId]);
            if (status === "cancelled" || status === "failed") {
              await db.query(
                "UPDATE tasks SET status = 'cancelled', resolved_at = now() WHERE execution_id = $1 AND status IN ('open', 'in_progress')",
                [executionId],
              );
            }
            await db.query(
              `INSERT INTO domain_events (type, entity_type, entity_id, payload, correlation_id)
               SELECT 'execution.finished', e.entity_type, e.entity_id, jsonb_build_object('executionId', $1::text, 'status', $2::text, 'flowId', e.flow_id), $1
               FROM executions e WHERE e.id = $1 AND NOT e.simulated`,
              [executionId, status],
            );
            break;
          }
        }
      });
    },

    /** Resolves the flow a sub-process node calls and creates the child execution row. */
    async prepareChild(spec: ChildSpec & { parentExecutionId: string }): Promise<{ executionId: string; input: ExecutionInput }> {
      const ctx = spec.context;
      const row = await sys(async (db) => {
        const latest = spec.version === null || spec.version === undefined || spec.version === "latest";
        const found = await db.query<{ flow_id: string; flow_name: string; version_id: string; diagram: unknown; definition: CompiledDefinition | null }>(
          `SELECT f.id AS flow_id, f.name AS flow_name, v.id AS version_id, v.diagram, v.definition
           FROM flows f JOIN flow_versions v ON v.flow_id = f.id AND ${latest ? "v.id = f.published_version_id" : "v.version = $2::int"}
           WHERE (f.id::text = $1 OR f.key = $1) AND f.archived_at IS NULL`,
          latest ? [spec.flowId] : [spec.flowId, Number(spec.version)],
        );
        return found.rows[0];
      });
      if (!row) {
        throw ApplicationFailure.create({ message: `Sub-process flow "${spec.flowId}" has no published version`, type: "flow_not_found", nonRetryable: true });
      }
      const executionId = randomUUID();
      const definition: WorkflowDefinition | CompiledDefinition = row.definition ?? toDefinition(row.diagram, row.flow_id);
      await sys((db) =>
        db.query(
          `INSERT INTO executions (id, workflow_id, temporal_workflow_id, status, trigger_payload, flow_id, flow_version_id, parent_execution_id, simulated,
                                   entity_type, entity_id, delegation_id, zone_id, project_id, trigger_kind)
           VALUES ($1, NULL, $2, 'running', $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'subprocess')`,
          [
            executionId,
            `exec-${executionId}`,
            JSON.stringify(spec.input),
            row.flow_id,
            row.version_id,
            spec.parentExecutionId,
            Boolean(ctx.simulated),
            ctx.entity?.type ?? null,
            ctx.entity?.id ?? null,
            ctx.scope?.delegationId ?? null,
            ctx.scope?.zoneId ?? null,
            ctx.scope?.projectId ?? null,
          ],
        ),
      );
      const input: ExecutionInput = {
        executionId,
        flowId: row.flow_id,
        flowVersionId: row.version_id,
        flowName: row.flow_name,
        definition: { ...(definition as CompiledDefinition), workflowId: row.flow_id },
        triggerPayload: spec.input,
        variables: {},
        global: ctx.global,
        entity: ctx.entity ?? null,
        scope: ctx.scope ?? {},
        simulated: Boolean(ctx.simulated),
        parent: { executionId: spec.parentExecutionId, nodeId: spec.nodeId },
        depth: spec.depth,
      };
      return { executionId, input };
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
