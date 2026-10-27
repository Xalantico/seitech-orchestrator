import { buildLogic, type Condition, type Group } from "./builder.js";
import { test, type Data, type Logic } from "./logic.js";

/** Side effects a state change can trigger. Executed by the state machine manager, never by the definition itself. */
export type StateAction =
  | { type: "start_flow"; flow: string; input?: Record<string, unknown> }
  | { type: "emit_event"; name: string; payload?: Record<string, unknown> }
  | { type: "set_field"; field: string; value: unknown }
  | { type: "notify"; template: string; to?: string; channel?: string };

export type StateDef = {
  key: string;
  label: string;
  final?: boolean;
  /** Informational: shown in the UI and used by reports. */
  category?: "open" | "waiting" | "done" | "blocked";
  onEnter?: StateAction[];
  onExit?: StateAction[];
};

export type TransitionDef = {
  key: string;
  label: string;
  from: string | string[];
  to: string;
  /** JSON-Logic or the visual tree, evaluated over `{ entity, actor, payload, now }`. */
  guard?: Group | Condition | { logic: Logic };
  /** Roles allowed to perform it (empty = anyone who may edit the entity). */
  roles?: string[];
  /** Payload keys that must be present, e.g. ["reason"]. */
  requires?: string[];
  actions?: StateAction[];
};

export type StateMachineDef = {
  entityType: string;
  initial: string;
  states: StateDef[];
  transitions: TransitionDef[];
};

export type TransitionContext = {
  entity: Record<string, unknown>;
  /** `system` actors (flows, schedulers) are not subject to the role list; guards still apply. */
  actor?: { roles?: string[]; label?: string; system?: boolean };
  payload?: Record<string, unknown>;
  now?: string;
};

export type TransitionCheck =
  | { ok: true; transition: TransitionDef; actions: StateAction[] }
  | { ok: false; code: "unknown_state" | "no_transition" | "guard_failed" | "role_denied" | "payload_missing" | "final_state"; message: string };

const fromList = (t: TransitionDef) => (Array.isArray(t.from) ? t.from : [t.from]);

function guardLogic(t: TransitionDef): Logic | null {
  const g = t.guard;
  if (!g) return null;
  if ("logic" in g) return g.logic;
  return buildLogic(g);
}

export function availableTransitions(def: StateMachineDef, from: string): TransitionDef[] {
  return def.transitions.filter((t) => fromList(t).includes(from) || fromList(t).includes("*"));
}

/** Resolves a transition by key or by target state and checks guard, roles and payload. */
export function checkTransition(def: StateMachineDef, from: string, via: { key?: string; to?: string }, ctx: TransitionContext): TransitionCheck {
  const state = def.states.find((s) => s.key === from);
  if (!state) return { ok: false, code: "unknown_state", message: `State "${from}" is not part of the ${def.entityType} state machine` };
  if (state.final) return { ok: false, code: "final_state", message: `"${state.label}" is a final state` };
  const candidates = availableTransitions(def, from).filter((t) => (via.key ? t.key === via.key : t.to === via.to));
  if (candidates.length === 0) {
    return { ok: false, code: "no_transition", message: `No transition ${via.key ?? `to "${via.to}"`} from "${state.label}"` };
  }
  const data: Data = { entity: ctx.entity, actor: ctx.actor ?? {}, payload: ctx.payload ?? {}, now: ctx.now ?? "" };
  let lastFailure: TransitionCheck | null = null;
  for (const t of candidates) {
    if (!ctx.actor?.system && t.roles && t.roles.length > 0 && !(ctx.actor?.roles ?? []).some((r) => t.roles!.includes(r))) {
      lastFailure = { ok: false, code: "role_denied", message: `Only ${t.roles.join(", ")} can "${t.label}"` };
      continue;
    }
    const missing = (t.requires ?? []).filter((k) => ctx.payload?.[k] === undefined || ctx.payload[k] === null || ctx.payload[k] === "");
    if (missing.length > 0) {
      lastFailure = { ok: false, code: "payload_missing", message: `"${t.label}" needs: ${missing.join(", ")}` };
      continue;
    }
    const logic = guardLogic(t);
    if (logic !== null && !test(logic, data)) {
      lastFailure = { ok: false, code: "guard_failed", message: `The conditions to "${t.label}" are not met` };
      continue;
    }
    const target = def.states.find((s) => s.key === t.to);
    const actions = [...(state.onExit ?? []), ...(t.actions ?? []), ...(target?.onEnter ?? [])];
    return { ok: true, transition: t, actions };
  }
  return lastFailure!;
}

export type StateMachineIssue = { severity: "error" | "warning"; message: string };

export function validateStateMachine(def: StateMachineDef): StateMachineIssue[] {
  const issues: StateMachineIssue[] = [];
  const keys = new Set(def.states.map((s) => s.key));
  if (keys.size !== def.states.length) issues.push({ severity: "error", message: "State keys must be unique" });
  if (!keys.has(def.initial)) issues.push({ severity: "error", message: `Initial state "${def.initial}" is not defined` });
  if (!def.states.some((s) => s.final)) issues.push({ severity: "warning", message: "No final state is defined" });
  const tk = new Set<string>();
  for (const t of def.transitions) {
    const dup = `${t.key}`;
    if (tk.has(dup)) issues.push({ severity: "error", message: `Duplicate transition key "${t.key}"` });
    tk.add(dup);
    for (const f of fromList(t)) if (f !== "*" && !keys.has(f)) issues.push({ severity: "error", message: `Transition "${t.key}" starts from unknown state "${f}"` });
    if (!keys.has(t.to)) issues.push({ severity: "error", message: `Transition "${t.key}" goes to unknown state "${t.to}"` });
  }
  // Reachability from the initial state.
  const reached = new Set<string>([def.initial]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of def.transitions) {
      if (fromList(t).some((f) => f === "*" || reached.has(f)) && !reached.has(t.to)) {
        reached.add(t.to);
        changed = true;
      }
    }
  }
  for (const s of def.states) if (!reached.has(s.key)) issues.push({ severity: "warning", message: `State "${s.label}" can never be reached` });
  for (const s of def.states) {
    if (!s.final && !def.transitions.some((t) => fromList(t).includes(s.key) || fromList(t).includes("*"))) {
      issues.push({ severity: "warning", message: `State "${s.label}" has no way out and is not final` });
    }
  }
  return issues;
}
