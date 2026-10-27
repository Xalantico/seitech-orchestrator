import { checkTransition, type StateAction, type StateMachineDef, type TransitionCheck } from "@orchestrador/rules";

import { FlowError } from "./errors.js";
import type { Tx } from "./types.js";

/** Entity types that carry a `status` column governed by a state machine. */
export const STATEFUL_ENTITIES: Record<string, string> = {
  order: "orders",
  work_order: "work_orders",
  visit: "visits",
  nonconformity: "nonconformities",
  certificate: "certificates",
};

const IDENT = /^[a-z_][a-z0-9_]*$/;

export type TransitionInput = {
  entityType: string;
  entityId: string;
  to?: string;
  transition?: string;
  payload?: Record<string, unknown>;
  actor: { label: string; userId?: string | null; roles?: string[]; system?: boolean };
  executionId?: string | null;
  reason?: string | null;
  /** Dry run: evaluate guards without touching anything (simulation, UI "what can I do"). */
  dryRun?: boolean;
};

export type TransitionOutcome = { from: string; to: string; transition: string; actions: StateAction[] };

/** Latest published state machine for an entity type. */
export async function loadStateMachine(db: Tx, entityType: string): Promise<{ id: string; version: number; definition: StateMachineDef } | null> {
  const r = await db.query<{ id: string; version: number; definition: StateMachineDef }>(
    `SELECT m.id, v.version, v.definition FROM state_machines m JOIN state_machine_versions v ON v.state_machine_id = m.id
     WHERE m.entity_type = $1 AND v.state = 'published' ORDER BY v.version DESC LIMIT 1`,
    [entityType],
  );
  return r.rows[0] ?? null;
}

function failure(check: Extract<TransitionCheck, { ok: false }>): FlowError {
  const status = check.code === "role_denied" ? 403 : 409;
  return new FlowError(status, check.message, `transition_${check.code}`);
}

/**
 * Applies a state transition inside the caller's transaction: guard and role checks, status update, history row,
 * domain events and transactional follow-ups. Flow starts requested by the machine are queued as `flow.start`
 * domain events so they happen exactly once and only if the transaction commits.
 */
export async function transitionEntity(db: Tx, input: TransitionInput): Promise<TransitionOutcome> {
  const table = STATEFUL_ENTITIES[input.entityType];
  if (!table) throw new FlowError(400, `"${input.entityType}" has no state machine`, "not_stateful");
  const machine = await loadStateMachine(db, input.entityType);
  if (!machine) throw new FlowError(409, `No published state machine for ${input.entityType}`, "no_state_machine");

  const found = await db.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = $1 ${input.dryRun ? "" : "FOR UPDATE"}`, [input.entityId]);
  const entity = found.rows[0];
  if (!entity) throw new FlowError(404, `${input.entityType} not found`, "not_found");
  const from = String(entity.status);

  const check = checkTransition(
    machine.definition,
    from,
    input.transition ? { key: input.transition } : { to: input.to ?? "" },
    { entity, actor: { roles: input.actor.roles ?? [], label: input.actor.label, system: Boolean(input.actor.system) }, payload: input.payload ?? {}, now: new Date().toISOString() },
  );
  if (!check.ok) throw failure(check);
  const outcome: TransitionOutcome = { from, to: check.transition.to, transition: check.transition.key, actions: check.actions };
  if (input.dryRun) return outcome;

  await db.query(`UPDATE ${table} SET status = $2, updated_at = now() WHERE id = $1`, [input.entityId, outcome.to]);
  await db.query(
    `INSERT INTO entity_state_history (entity_type, entity_id, from_state, to_state, actor, reason, execution_id, delegation_id, zone_id, project_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [input.entityType, input.entityId, from, outcome.to, input.actor.label, input.reason ?? (input.payload?.reason as string | undefined) ?? null, input.executionId ?? null,
      entity.delegation_id ?? null, entity.zone_id ?? null, entity.project_id ?? null],
  );

  const base = { entity_type: input.entityType, entity_id: input.entityId, delegation_id: entity.delegation_id ?? null, correlation_id: input.executionId ?? null };
  const emit = (type: string, payload: Record<string, unknown>) =>
    db.query(
      "INSERT INTO domain_events (type, entity_type, entity_id, payload, correlation_id, delegation_id) VALUES ($1, $2, $3, $4::jsonb, $5, $6)",
      [type, base.entity_type, base.entity_id, JSON.stringify(payload), base.correlation_id, base.delegation_id],
    );
  const workOrderId = input.entityType === "work_order" ? input.entityId : ((entity.work_order_id as string | undefined) ?? null);
  // regulation/inspectionType/line/area let event triggers pick the right process template (lifts, REBT, RAT...).
  const summary = {
    from, to: outcome.to, transition: outcome.transition, actor: input.actor.label, payload: input.payload ?? {}, workOrderId,
    regulation: (entity.regulation as string | undefined) ?? null, inspectionType: (entity.inspection_type as string | undefined) ?? null,
    line: (entity.line as string | undefined) ?? null, area: (entity.area as string | undefined) ?? null,
  };
  await emit(`${input.entityType}.transitioned`, summary);
  await emit(`${input.entityType}.${outcome.to}`, summary);

  for (const action of outcome.actions) {
    switch (action.type) {
      case "set_field":
        if (!IDENT.test(action.field) || ["id", "status", "created_at"].includes(action.field)) throw new FlowError(422, `Field "${action.field}" cannot be set by a state action`, "invalid_action");
        await db.query(`UPDATE ${table} SET ${action.field} = $2 WHERE id = $1`, [input.entityId, action.value]);
        break;
      case "emit_event":
        await emit(action.name, { ...(action.payload ?? {}), ...summary });
        break;
      case "start_flow":
        await emit("flow.start", { flow: action.flow, input: action.input ?? {}, from, to: outcome.to, transition: outcome.transition });
        break;
      case "notify":
        await emit("notification.requested", { template: action.template, recipient: action.to ?? null, channel: action.channel ?? null, ...summary });
        break;
    }
  }
  return outcome;
}
