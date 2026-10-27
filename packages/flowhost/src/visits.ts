import type { Tx } from "./types.js";

import { FlowError } from "./errors.js";
import { transitionEntity, type TransitionInput } from "./transitions.js";

export type Defect = { code?: string | undefined; severity: "minor" | "major" | "critical"; description: string };

export type VisitResultInput = {
  visitId: string;
  result: "favorable" | "conditioned" | "unfavorable" | "partial" | "failed";
  fieldSheet?: string | null;
  data?: Record<string, unknown>;
  defects?: Defect[];
  createNonconformity?: boolean | undefined;
  actor: TransitionInput["actor"];
  /** Times and position reported by the field tool; the current time is used when absent. */
  startedAt?: string | null;
  endedAt?: string | null;
  geo?: Record<string, unknown> | null;
};

const addDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function parameter<T>(db: Tx, key: string, delegationId: string | null, fallback: T): Promise<T> {
  const r = await db.query<{ value: T }>("SELECT value FROM parameters WHERE key = $1 AND (delegation_id = $2 OR delegation_id IS NULL) ORDER BY delegation_id NULLS LAST LIMIT 1", [key, delegationId]);
  return r.rows[0]?.value ?? fallback;
}

/**
 * Records an inspection result: stores it with its defects, completes the visit through the state machine, raises a
 * nonconformity when needed and announces `visit.result` so waiting flows continue. Used by the API (a person enters
 * it) and by the field tool connector (the app reports it): both paths behave the same way.
 */
export async function recordVisitResult(db: Tx, input: VisitResultInput): Promise<{ inspectionResultId: string; nonconformityId: string | null; secondVisitSuggested: boolean }> {
  const move = (transition: string) => transitionEntity(db, { entityType: "visit", entityId: input.visitId, transition, actor: input.actor });
  const v = (await db.query("SELECT * FROM visits WHERE id = $1 FOR UPDATE", [input.visitId])).rows[0];
  if (!v) throw new FlowError(404, "Visit not found", "not_found");
  if (v.status === "scheduled") await move("start"); // field tools may report a result without an explicit start
  const defects = input.defects ?? [];
  const res = (await db.query(
    "INSERT INTO inspection_results (visit_id, result, field_sheet, data, delegation_id, zone_id, project_id) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING id",
    [v.id, input.result, input.fieldSheet ?? null, JSON.stringify(input.data ?? {}), v.delegation_id, v.zone_id, v.project_id],
  )).rows[0];
  for (const d of defects) await db.query("INSERT INTO defects (inspection_result_id, code, severity, description) VALUES ($1, $2, $3, $4)", [res.id, d.code ?? null, d.severity, d.description]);
  await db.query(
    "UPDATE visits SET result = $2, actual_start = coalesce($3::timestamptz, actual_start, now()), actual_end = coalesce($4::timestamptz, now()), geo = coalesce($5::jsonb, geo) WHERE id = $1",
    [v.id, input.result, input.startedAt ?? null, input.endedAt ?? null, input.geo ? JSON.stringify(input.geo) : null],
  );
  await move("complete");
  let nonconformityId: string | null = null;
  const needsNc = input.createNonconformity ?? (["unfavorable", "conditioned"].includes(input.result) && defects.length > 0);
  if (needsNc) {
    const days = await parameter<number>(db, "nonconformity_remediation_days", v.delegation_id, 30);
    nonconformityId = (await db.query(
      "INSERT INTO nonconformities (work_order_id, visit_id, report, remediation_deadline, delegation_id, zone_id, project_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [v.work_order_id, v.id, defects.map((d) => `${d.severity.toUpperCase()}${d.code ? ` ${d.code}` : ""}: ${d.description}`).join("\n") || null, addDays(days), v.delegation_id, v.zone_id, v.project_id],
    )).rows[0].id;
    await db.query("INSERT INTO domain_events (type, entity_type, entity_id, payload, delegation_id) VALUES ('nc.detected', 'nonconformity', $1, $2::jsonb, $3)", [nonconformityId, JSON.stringify({ workOrderId: v.work_order_id, visitId: v.id, result: input.result }), v.delegation_id]);
  }
  await db.query("INSERT INTO domain_events (type, entity_type, entity_id, payload, delegation_id) VALUES ('visit.result', 'visit', $1, $2::jsonb, $3)", [v.id, JSON.stringify({ result: input.result, defects: defects.length, workOrderId: v.work_order_id }), v.delegation_id]);
  return { inspectionResultId: res.id, nonconformityId, secondVisitSuggested: ["conditioned", "unfavorable", "partial"].includes(input.result) };
}
