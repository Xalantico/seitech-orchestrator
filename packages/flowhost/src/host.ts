import {
  DEFAULT_CALENDAR,
  FAILURE_TYPE,
  INTERPRETER_WORKFLOW,
  QUERY,
  SIGNAL,
  UPDATE,
  workflowIdFor,
  type BusinessCalendar,
  type CompiledDefinition,
  type EntityRef,
  type ExecutionInput,
  type Resolution,
  type ScopeRef,
} from "@orchestrador/engine";
import { DiagramValidationError, SIM_SUFFIX, TASK_QUEUES, toDefinition } from "@orchestrador/shared";
import { WorkflowNotFoundError, WorkflowUpdateFailedError } from "@temporalio/client";
import { randomUUID } from "node:crypto";

import { bakeRefs } from "./bake.js";
import { FlowError } from "./errors.js";
import { transitionEntity, type TransitionInput, type TransitionOutcome } from "./transitions.js";
import type { FlowHostDeps, Tx } from "./types.js";

export type StartOptions = {
  /** Flow id or key. */
  flow?: string;
  /** Specific version number; defaults to the published one (or the latest draft when simulating). */
  version?: number;
  /** Ad-hoc diagram (editor "run what I see"): only allowed as a simulation. */
  diagram?: unknown;
  triggerPayload?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  simulated?: boolean;
  stepMode?: boolean;
  triggerKind?: string;
  correlationId?: string | null;
  entity?: EntityRef | null;
  scope?: ScopeRef;
  userId?: string | null;
  /** Deterministic id for idempotent starts (webhooks, schedules, domain events). */
  idempotencyKey?: string;
};

export type Started = { executionId: string; workflowId: string; temporalUrl: string; simulated: boolean; flowVersionId: string | null };

export async function loadCalendar(db: Tx, delegationId?: string | null): Promise<BusinessCalendar> {
  const rows = await db.query<{ day: string }>(
    "SELECT to_char(day, 'YYYY-MM-DD') AS day FROM holidays WHERE delegation_id IS NULL OR delegation_id = $1",
    [delegationId ?? null],
  );
  return { ...DEFAULT_CALENDAR, holidays: rows.rows.map((r) => r.day) };
}

async function loadGlobals(db: Tx, delegationId?: string | null): Promise<Record<string, unknown>> {
  const rows = await db.query<{ key: string; value: unknown }>(
    `SELECT DISTINCT ON (key) key, value FROM parameters
     WHERE delegation_id IS NULL OR delegation_id = $1
     ORDER BY key, delegation_id NULLS LAST`,
    [delegationId ?? null],
  );
  return Object.fromEntries(rows.rows.map((r) => [r.key, r.value]));
}

export type FlowHost = ReturnType<typeof createFlowHost>;

export function createFlowHost(deps: FlowHostDeps) {
  const { pool, system, log } = deps;
  const uiUrl = (workflowId: string, namespace: string) => `${deps.uiOrigin.replace(/\/$/, "")}/namespaces/${namespace}/workflows/${encodeURIComponent(workflowId)}`;

  /** Resolves, compiles and starts an execution. Always system-level: authorisation happened in the caller. */
  async function startExecution(opts: StartOptions): Promise<Started> {
    const simulated = Boolean(opts.simulated);
    let flowId: string | null = null;
    let flowVersionId: string | null = null;
    let flowName: string | undefined;
    let diagram: unknown = opts.diagram;
    let stored: unknown = null;

    if (opts.flow) {
      const row = await system(async (db) => {
        const where = opts.version !== undefined ? "v.version = $2" : simulated ? "v.version = (SELECT max(version) FROM flow_versions WHERE flow_id = f.id)" : "v.id = f.published_version_id";
        const r = await db.query<{ flow_id: string; name: string; version_id: string; diagram: unknown; definition: unknown; state: string }>(
          `SELECT f.id AS flow_id, f.name, v.id AS version_id, v.diagram, v.definition, v.state
           FROM flows f JOIN flow_versions v ON v.flow_id = f.id AND ${where}
           WHERE (f.id::text = $1 OR f.key = $1) AND f.archived_at IS NULL`,
          opts.version !== undefined ? [opts.flow, opts.version] : [opts.flow],
        );
        return r.rows[0];
      });
      if (!row) throw opts.version !== undefined || simulated ? new FlowError(404, "Flow version not found", "not_found") : new FlowError(409, "The flow has no published version", "not_published");
      if (!simulated && row.state !== "published") throw new FlowError(409, `Version is ${row.state}, only published versions run for real`, "not_published");
      flowId = row.flow_id;
      flowVersionId = row.version_id;
      flowName = row.name;
      diagram = row.diagram;
      stored = row.definition;
    } else if (opts.diagram === undefined) {
      throw new FlowError(400, "Provide a flow or a diagram", "bad_request");
    } else if (!simulated && deps.isProd) {
      throw new FlowError(403, "Ad-hoc diagrams can only be simulated in production", "adhoc_forbidden");
    }

    let definition: CompiledDefinition;
    try {
      definition = (stored ?? toDefinition(diagram, flowId ?? "adhoc")) as CompiledDefinition;
    } catch (error) {
      if (error instanceof DiagramValidationError) throw new FlowError(422, error.message, "invalid_flow");
      throw error;
    }

    const executionId = opts.idempotencyKey ? `idem-${opts.idempotencyKey}`.slice(0, 120) : randomUUID();
    const workflowId = workflowIdFor(executionId);
    const scope = opts.scope ?? {};

    const input: ExecutionInput = await system(async (db) => {
      // Real runs use what was pinned at publish time; simulations and ad-hoc diagrams pin the latest rules now.
      if (!stored || simulated) {
        const baked = await bakeRefs(db, definition, { allowDraft: simulated });
        if (baked.refs.missing.length > 0 && !simulated) throw new FlowError(422, `Unknown rule sets: ${baked.refs.missing.join(", ")}`, "invalid_flow");
        definition = baked.definition;
      }
      const [calendar, global] = await Promise.all([loadCalendar(db, scope.delegationId), loadGlobals(db, scope.delegationId)]);
      const inserted = await db.query(
        `INSERT INTO executions (id, workflow_id, temporal_workflow_id, status, trigger_payload, user_id, flow_id, flow_version_id, correlation_id,
                                 entity_type, entity_id, simulated, delegation_id, zone_id, project_id, trigger_kind)
         VALUES ($1, NULL, $2, 'running', $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO NOTHING`,
        [executionId, workflowId, JSON.stringify(opts.triggerPayload ?? {}), opts.userId ?? null, flowId, flowVersionId, opts.correlationId ?? null,
          opts.entity?.type ?? null, opts.entity?.id ?? null, simulated, scope.delegationId ?? null, scope.zoneId ?? null, scope.projectId ?? null, opts.triggerKind ?? "manual"],
      );
      if (inserted.rowCount === 0) throw new FlowError(409, "Execution already started for this key", "duplicate");
      return {
        executionId,
        flowId,
        flowVersionId,
        ...(flowName ? { flowName } : {}),
        definition: { ...definition, workflowId: flowId ?? "adhoc" },
        triggerPayload: opts.triggerPayload ?? {},
        variables: opts.variables ?? {},
        global,
        entity: opts.entity ?? null,
        scope,
        simulated,
        stepMode: Boolean(opts.stepMode),
        calendar,
        depth: 0,
      } satisfies ExecutionInput;
    });

    const client = simulated ? await deps.simTemporal() : await deps.temporal();
    const namespace = simulated ? (deps.simNamespace ?? deps.namespace) : deps.namespace;
    try {
      await client.workflow.start(INTERPRETER_WORKFLOW, {
        workflowId,
        taskQueue: simulated ? `${TASK_QUEUES.flows}${SIM_SUFFIX}` : TASK_QUEUES.flows,
        args: [input],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ executionId, err: message }, "could not start workflow");
      await pool.query("UPDATE executions SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1", [executionId, `Could not start: ${message}`]);
      throw new FlowError(503, "The execution engine is unavailable, try again shortly", "engine_unavailable");
    }
    deps.onStarted?.(opts.triggerKind ?? "manual");
    return { executionId, workflowId, temporalUrl: uiUrl(workflowId, namespace), simulated, flowVersionId };
  }

  async function handleOf(executionId: string) {
    const row = await system(async (db) =>
      (await db.query<{ simulated: boolean; temporal_workflow_id: string }>("SELECT simulated, temporal_workflow_id FROM executions WHERE id = $1", [executionId])).rows[0],
    );
    if (!row) throw new FlowError(404, "Execution not found", "not_found");
    const client = row.simulated ? await deps.simTemporal() : await deps.temporal();
    return client.workflow.getHandle(row.temporal_workflow_id);
  }

  function mapEngineError(error: unknown): never {
    if (error instanceof WorkflowNotFoundError) throw new FlowError(409, "The execution is no longer running", "not_running");
    if (error instanceof WorkflowUpdateFailedError) {
      const cause = error.cause as { type?: string; message?: string } | undefined;
      if (cause?.type === FAILURE_TYPE.rejected) throw new FlowError(409, cause.message ?? "Rejected by the flow", "flow_rejected");
      throw new FlowError(409, cause?.message ?? "Update failed", "flow_rejected");
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|already completed|workflow execution already/i.test(message)) throw new FlowError(409, "The execution is no longer running", "not_running");
    throw new FlowError(503, "The execution engine is unavailable", "engine_unavailable");
  }

  async function resolveNode(executionId: string, nodeId: string, resolution: Resolution): Promise<void> {
    const handle = await handleOf(executionId);
    try {
      await handle.executeUpdate(UPDATE.resolveNode, { args: [{ nodeId, resolution }] });
    } catch (error) {
      mapEngineError(error);
    }
  }

  async function signalExecution(executionId: string, kind: keyof typeof SIGNAL, arg?: unknown): Promise<void> {
    const handle = await handleOf(executionId);
    try {
      await (arg === undefined ? handle.signal(SIGNAL[kind]) : handle.signal(SIGNAL[kind], arg));
    } catch (error) {
      mapEngineError(error);
    }
  }

  async function cancelExecution(executionId: string): Promise<void> {
    const handle = await handleOf(executionId);
    try {
      await handle.cancel();
    } catch (error) {
      mapEngineError(error);
    }
  }

  async function queryExecution(executionId: string): Promise<unknown | null> {
    const handle = await handleOf(executionId);
    try {
      return await handle.query(QUERY.state);
    } catch {
      return null;
    }
  }

  /** System-level transition in its own transaction (used by the `state.transition` node). */
  function transition(input: TransitionInput): Promise<TransitionOutcome> {
    return system((db) => transitionEntity(db, input));
  }

  return { deps, startExecution, resolveNode, signalExecution, cancelExecution, queryExecution, transition, loadCalendar };
}
