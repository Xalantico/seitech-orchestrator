import { OpenAPIHono } from "@hono/zod-openapi";
import { recordVisitResult, transitionEntity } from "@orchestrador/flowhost";

import { env } from "../env.js";
import { crud, zDate, zJson, zTimestamp, zUuid, type FieldDef } from "../lib/crud.js";
import { run, type Tx } from "../lib/db.js";
import { conflict, notFound } from "../lib/errors.js";
import type { Principal } from "../lib/principal.js";
import { define, z } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";

export const operations = new OpenAPIHono<AppEnv>();
const TAG = "Operations";

const scope: Record<string, FieldDef> = {
  delegation_id: { schema: zUuid.nullable().optional() },
  zone_id: { schema: zUuid.nullable().optional() },
  project_id: { schema: zUuid.nullable().optional() },
};
const extra: Record<string, FieldDef> = { extra: { schema: zJson.optional(), cast: "jsonb" } };
const nullableText = z.string().nullable().optional();

// `status` is deliberately absent from every field list below: states only change through the state machine
// (POST /entities/{type}/{id}/transitions or the lifecycle endpoints), so guards, roles and history always apply.

operations.route("/", crud({
  permissions: { read: "customers:read", write: "customers:write" }, tag: TAG, table: "customers", basePath: "/customers",
  fields: { code: { schema: z.string().min(1).nullable().optional() }, name: { schema: z.string().min(1) }, address: { schema: nullableText }, consent_comms: { schema: z.boolean().optional() }, external_refs: { schema: zJson.optional(), cast: "jsonb" }, ...scope, ...extra },
  readonly: ["anonymized_at", "created_at", "updated_at"], search: ["code", "name"], filters: ["delegation_id"], defaultOrder: "name",
}));

/** Personal data is encrypted at rest (pgcrypto) and only readable with `customers:pii` (and MFA in production). */
define(operations, {
  method: "put", path: "/customers/{id}/pii", tag: TAG, summary: "Set a customer's tax id, e-mail and phone (stored encrypted)", permission: "customers:write", params: z.object({ id: zUuid }),
  body: z.object({ taxId: z.string().max(40).nullable().optional(), email: z.string().email().nullable().optional(), phone: z.string().max(30).nullable().optional() }),
}, async (c, i) => {
  const b = i.body;
  const r = await run(c, (db) => db.query(
    `UPDATE customers SET
       tax_id_enc = CASE WHEN $2::boolean THEN pgp_sym_encrypt($3, $6) ELSE tax_id_enc END,
       email_enc = CASE WHEN $4::boolean THEN pgp_sym_encrypt($5, $6) ELSE email_enc END,
       phone_enc = CASE WHEN $7::boolean THEN pgp_sym_encrypt($8, $6) ELSE phone_enc END
     WHERE id = $1 AND anonymized_at IS NULL RETURNING id`,
    [i.params.id, b.taxId !== undefined, b.taxId ?? null, b.email !== undefined, b.email ?? null, env.piiKey, b.phone !== undefined, b.phone ?? null],
  ));
  if (!r.rows[0]) throw notFound("Customer");
  return c.json({ ok: true });
});

define(operations, { method: "get", path: "/customers/{id}/pii", tag: TAG, summary: "Read a customer's personal data (audited)", permission: "customers:pii", params: z.object({ id: zUuid }) }, async (c, i) => {
  const r = await run(c, async (db) => {
    const row = (await db.query(
      "SELECT pgp_sym_decrypt(tax_id_enc, $2) AS tax_id, pgp_sym_decrypt(email_enc, $2) AS email, pgp_sym_decrypt(phone_enc, $2) AS phone FROM customers WHERE id = $1 AND anonymized_at IS NULL",
      [i.params.id, env.piiKey],
    )).rows[0];
    if (!row) return null;
    await db.query("SELECT audit_event('pii.read', 'customer', $1, '{}'::jsonb)", [i.params.id]);
    return row;
  });
  if (!r) throw notFound("Customer");
  return c.json(r);
});

operations.route("/", crud({
  permissions: { read: "customers:read", write: "customers:write" }, tag: TAG, table: "sites", basePath: "/sites",
  fields: {
    customer_id: { schema: zUuid.nullable().optional() }, name: { schema: z.string().min(1) }, address: { schema: nullableText }, municipality: { schema: nullableText },
    autonomous_community: { schema: nullableText }, latitude: { schema: z.number().min(-90).max(90).nullable().optional() }, longitude: { schema: z.number().min(-180).max(180).nullable().optional() },
    installation_type: { schema: nullableText }, external_refs: { schema: zJson.optional(), cast: "jsonb" }, ...scope, ...extra,
  },
  readonly: ["created_at", "updated_at"], search: ["name", "address", "municipality"], filters: ["customer_id", "delegation_id", "municipality"], defaultOrder: "name",
}));

operations.route("/", crud({
  permissions: { read: "technicians:read", write: "technicians:write" }, tag: TAG, table: "technicians", basePath: "/technicians",
  fields: {
    user_id: { schema: zUuid.nullable().optional() }, code: { schema: z.string().min(1).nullable().optional() }, name: { schema: z.string().min(1) },
    email: { schema: z.string().email().nullable().optional(), expr: "email::text" }, active: { schema: z.boolean().optional() },
    home_latitude: { schema: z.number().nullable().optional() }, home_longitude: { schema: z.number().nullable().optional() }, external_refs: { schema: zJson.optional(), cast: "jsonb" }, ...scope, ...extra,
  },
  readonly: ["created_at", "updated_at"], search: ["code", "name", "email"], filters: ["active", "delegation_id"], defaultOrder: "name",
  // An unavailable technician triggers the visit-reassignment process (ORF-016).
  afterWrite: async (row, c, op) => {
    if (op !== "update" || row.active !== false) return;
    await run(c, (db) => db.query("INSERT INTO domain_events (type, entity_type, entity_id, payload, delegation_id) VALUES ('technician.unavailable', 'technician', $1, $2::jsonb, $3)", [row.id, JSON.stringify({ technicianId: row.id, technicianName: row.name }), row.delegation_id ?? null]));
  },
}));

operations.route("/", crud({
  permissions: { read: "technicians:read", write: "technicians:write" }, tag: TAG, table: "qualifications", basePath: "/qualifications",
  fields: {
    technician_id: { schema: zUuid }, kind: { schema: z.string().min(1) }, reference: { schema: nullableText }, valid_from: { schema: zDate.nullable().optional(), cast: "date" },
    valid_to: { schema: zDate.nullable().optional(), cast: "date" }, status: { schema: z.enum(["valid", "expiring", "expired", "revoked"]).optional() }, source: { schema: z.string().optional() }, ...extra,
  },
  readonly: ["updated_at"], filters: ["technician_id", "kind", "status"], defaultOrder: "valid_to NULLS LAST",
}));

operations.route("/", crud({
  permissions: { read: "technicians:read", write: "technicians:write" }, tag: TAG, table: "equipment_calibrations", basePath: "/equipment-calibrations",
  fields: {
    equipment_code: { schema: z.string().min(1) }, name: { schema: z.string().min(1) }, calibrated_at: { schema: zDate.nullable().optional(), cast: "date" }, valid_to: { schema: zDate.nullable().optional(), cast: "date" },
    technician_id: { schema: zUuid.nullable().optional() }, status: { schema: z.enum(["valid", "expiring", "expired"]).optional() }, source: { schema: z.string().optional() }, ...extra,
  },
  readonly: ["updated_at"], search: ["equipment_code", "name"], filters: ["technician_id", "status"], defaultOrder: "valid_to NULLS LAST",
}));

operations.route("/", crud({
  permissions: { read: "orders:read", write: "orders:write" }, tag: TAG, table: "orders", basePath: "/orders",
  fields: {
    external_ref: { schema: nullableText }, customer_id: { schema: zUuid.nullable().optional() }, site_id: { schema: zUuid.nullable().optional() }, service_code: { schema: nullableText },
    amount: { schema: z.number().nullable().optional() }, currency: { schema: z.string().length(3).optional() }, source: { schema: z.string().optional() }, ...scope, ...extra,
  },
  readonly: ["number", "status", "created_at", "updated_at"], search: ["external_ref", "service_code"], filters: ["status", "customer_id", "delegation_id"], defaultOrder: "created_at DESC",
}));

const WO_FIELDS: Record<string, FieldDef> = {
  order_id: { schema: zUuid.nullable().optional() }, customer_id: { schema: zUuid.nullable().optional() }, site_id: { schema: zUuid.nullable().optional() },
  inspection_type: { schema: nullableText }, regulation: { schema: nullableText }, line: { schema: nullableText }, area: { schema: nullableText },
  priority: { schema: z.enum(["low", "medium", "high", "urgent"]).optional() }, technician_id: { schema: zUuid.nullable().optional() }, due_date: { schema: zDate.nullable().optional(), cast: "date" },
  external_ref: { schema: nullableText }, ...scope, ...extra,
};
operations.route("/", crud({
  permissions: { read: "work_orders:read", write: "work_orders:write" }, tag: TAG, table: "work_orders", basePath: "/work-orders", fields: WO_FIELDS,
  readonly: ["number", "status", "flow_execution_id", "created_at", "updated_at"], search: ["external_ref", "inspection_type", "regulation"],
  filters: ["status", "priority", "customer_id", "site_id", "technician_id", "delegation_id", "inspection_type"], defaultOrder: "created_at DESC",
}));

operations.route("/", crud({
  permissions: { read: "visits:read", write: "visits:write" }, tag: TAG, table: "visits", basePath: "/visits",
  fields: {
    work_order_id: { schema: zUuid }, visit_type_id: { schema: zUuid.nullable().optional() }, technician_id: { schema: zUuid.nullable().optional() },
    scheduled_start: { schema: zTimestamp.nullable().optional() }, scheduled_end: { schema: zTimestamp.nullable().optional() }, legal_deadline: { schema: zDate.nullable().optional(), cast: "date" },
    external_ref: { schema: nullableText }, ...scope, ...extra,
  },
  readonly: ["number", "sequence", "status", "result", "parent_visit_id", "actual_start", "actual_end", "estimated_duration_min", "duration_overridden", "incident_reason", "created_at", "updated_at"],
  filters: ["status", "work_order_id", "technician_id", "visit_type_id", "delegation_id"], defaultOrder: "scheduled_start NULLS LAST, created_at DESC",
}));

operations.route("/", crud({
  permissions: { read: "nonconformities:read", write: "nonconformities:write" }, tag: TAG, table: "nonconformities", basePath: "/nonconformities",
  fields: { work_order_id: { schema: zUuid }, visit_id: { schema: zUuid.nullable().optional() }, report: { schema: nullableText }, remediation_deadline: { schema: zDate.nullable().optional(), cast: "date" }, ...scope, ...extra },
  readonly: ["number", "status", "verified_at", "created_at", "updated_at"], filters: ["status", "work_order_id", "delegation_id"], defaultOrder: "created_at DESC",
}));

operations.route("/", crud({
  permissions: { read: "certificates:read", write: "certificates:write" }, tag: TAG, table: "certificates", basePath: "/certificates",
  fields: { work_order_id: { schema: zUuid }, number: { schema: nullableText }, retention_until: { schema: zDate.nullable().optional(), cast: "date" }, ...scope, ...extra },
  readonly: ["status", "document_id", "signed_document_id", "issued_at", "distributed_to", "created_at", "updated_at"], filters: ["status", "work_order_id", "delegation_id"], defaultOrder: "created_at DESC",
}));

operations.route("/", crud({
  permissions: { read: "orders:read", write: "orders:write" }, tag: TAG, table: "billing_lines", basePath: "/billing-lines",
  fields: {
    work_order_id: { schema: zUuid.nullable().optional() }, order_id: { schema: zUuid.nullable().optional() }, description: { schema: z.string().min(1) }, quantity: { schema: z.number().positive().optional() },
    unit_price: { schema: z.number().min(0).optional() }, status: { schema: z.enum(["pending", "sent", "invoiced", "cancelled"]).optional() }, recurring: { schema: z.boolean().optional() },
    period: { schema: nullableText }, erp_ref: { schema: nullableText }, ...scope, ...extra,
  },
  readonly: ["amount", "created_at", "updated_at"], search: ["description", "erp_ref"], filters: ["status", "work_order_id", "order_id", "delegation_id"], defaultOrder: "created_at DESC",
}));

operations.route("/", crud({
  permissions: { read: "work_orders:read", write: "work_orders:write" }, tag: TAG, table: "timesheets", basePath: "/timesheets",
  fields: {
    technician_id: { schema: zUuid }, visit_id: { schema: zUuid.nullable().optional() }, work_order_id: { schema: zUuid.nullable().optional() }, project_id: { schema: zUuid.nullable().optional() },
    delegation_id: { schema: zUuid.nullable().optional() }, zone_id: { schema: zUuid.nullable().optional() }, started_at: { schema: zTimestamp }, ended_at: { schema: zTimestamp.nullable().optional() },
    minutes: { schema: z.number().int().min(0).nullable().optional() }, cost: { schema: z.number().min(0).nullable().optional() }, source: { schema: z.string().optional() }, ...extra,
  },
  filters: ["technician_id", "visit_id", "work_order_id"], defaultOrder: "started_at DESC",
}));

// ───────────── lifecycle ─────────────
const actorOf = (p: Principal) => ({ label: p.label, userId: p.kind === "user" ? p.id : null, roles: p.roles });
const idParam = z.object({ id: zUuid });

async function move(db: Tx, p: Principal, type: string, id: string, transition: string, payload: Record<string, unknown> = {}, reason?: string) {
  return transitionEntity(db, { entityType: type, entityId: id, transition, payload, reason: reason ?? null, actor: actorOf(p) });
}

async function parameter<T>(db: Tx, key: string, delegationId: string | null, fallback: T): Promise<T> {
  const r = await db.query<{ value: T }>("SELECT value FROM parameters WHERE key = $1 AND (delegation_id = $2 OR delegation_id IS NULL) ORDER BY delegation_id NULLS LAST LIMIT 1", [key, delegationId]);
  return r.rows[0]?.value ?? fallback;
}

type TypeInfo = { duration: number; travel: number; secondDays: number | null };
/** Duration of a visit type, with the delegation-specific override applied (ORF-031). */
async function visitTypeInfo(db: Tx, visitTypeId: string, delegationId: string | null): Promise<TypeInfo> {
  const r = await db.query<{ avg_duration_min: number; avg_travel_min: number; second_visit_days: number | null; duration_min: number | null; travel_min: number | null }>(
    `SELECT vt.avg_duration_min, vt.avg_travel_min, vt.second_visit_days, vo.duration_min, vo.travel_min FROM visit_types vt
     LEFT JOIN visit_type_overrides vo ON vo.visit_type_id = vt.id AND vo.delegation_id = $2 WHERE vt.id = $1`,
    [visitTypeId, delegationId],
  );
  const row = r.rows[0];
  if (!row) throw notFound("Visit type");
  return { duration: row.duration_min ?? row.avg_duration_min, travel: row.travel_min ?? row.avg_travel_min, secondDays: row.second_visit_days };
}

const addDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

define(operations, {
  method: "post", path: "/work-orders/{id}/visits", tag: TAG, summary: "Create a visit for a work order (duration comes from the visit type)", permission: "visits:write", params: idParam, status: 201,
  body: z.object({ visitTypeId: zUuid.optional(), technicianId: zUuid.nullable().optional(), scheduledStart: zTimestamp.optional(), legalDeadline: zDate.optional() }),
}, async (c, i) => {
  const out = await run(c, async (db) => {
    const wo = (await db.query("SELECT * FROM work_orders WHERE id = $1 FOR UPDATE", [i.params.id])).rows[0];
    if (!wo) throw notFound("Work order");
    if (["closed", "cancelled"].includes(wo.status)) throw conflict("The work order is closed", "wo_closed");
    const info = i.body.visitTypeId ? await visitTypeInfo(db, i.body.visitTypeId, wo.delegation_id) : null;
    const seq = (await db.query<{ n: number }>("SELECT coalesce(max(sequence), 0)::int + 1 AS n FROM visits WHERE work_order_id = $1", [wo.id])).rows[0]!.n;
    const visit = (await db.query(
      `INSERT INTO visits (work_order_id, visit_type_id, sequence, technician_id, scheduled_start, estimated_duration_min, legal_deadline, delegation_id, zone_id, project_id, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) RETURNING *`,
      [wo.id, i.body.visitTypeId ?? null, seq, i.body.technicianId ?? wo.technician_id, i.body.scheduledStart ?? null, info?.duration ?? null, i.body.legalDeadline ?? wo.due_date,
       wo.delegation_id, wo.zone_id, wo.project_id, JSON.stringify(info ? { travel_min: info.travel } : {})],
    )).rows[0];
    return visit;
  });
  return c.json(out, 201);
});

define(operations, {
  method: "post", path: "/visits/{id}/schedule", tag: TAG, summary: "Schedule or reschedule a visit with a technician", permission: ["visits:write", "visits:transition"], params: idParam,
  body: z.object({ technicianId: zUuid, start: zTimestamp, durationMin: z.number().int().min(5).max(1440).optional(), allowOverlap: z.boolean().default(false) }),
  description: "Computes the end from the visit type duration (or the given override), checks the technician is active, has no overlapping visit and no expired qualification for the inspection type, then runs the schedule or reschedule transition.",
}, async (c, i) => {
  const p = c.get("principal");
  const out = await run(c, async (db) => {
    const v = (await db.query("SELECT v.*, w.inspection_type, w.regulation FROM visits v JOIN work_orders w ON w.id = v.work_order_id WHERE v.id = $1 FOR UPDATE OF v", [i.params.id])).rows[0];
    if (!v) throw notFound("Visit");
    const tech = (await db.query("SELECT id, name, active FROM technicians WHERE id = $1", [i.body.technicianId])).rows[0];
    if (!tech) throw notFound("Technician");
    if (!tech.active) throw conflict(`${tech.name} is not active`, "technician_inactive");
    let duration = i.body.durationMin ?? v.estimated_duration_min;
    if (!duration && v.visit_type_id) duration = (await visitTypeInfo(db, v.visit_type_id, v.delegation_id)).duration;
    duration ??= 60;
    const start = new Date(i.body.start);
    const end = new Date(start.getTime() + duration * 60_000);
    const warnings: string[] = [];
    if (!i.body.allowOverlap) {
      const clash = (await db.query("SELECT id, number FROM visits WHERE technician_id = $1 AND id <> $2 AND status IN ('scheduled', 'in_progress') AND tstzrange(scheduled_start, scheduled_end) && tstzrange($3, $4) LIMIT 1", [tech.id, v.id, start, end])).rows[0];
      if (clash) throw conflict(`${tech.name} already has visit #${clash.number} at that time`, "technician_busy");
    }
    const kinds = [v.inspection_type, v.regulation].filter(Boolean);
    if (kinds.length > 0) {
      const quals = (await db.query<{ kind: string; ok: boolean }>(
        "SELECT kind, (status <> 'revoked' AND (valid_to IS NULL OR valid_to >= $3::date)) AS ok FROM qualifications WHERE technician_id = $1 AND kind = ANY($2)",
        [tech.id, kinds, start.toISOString().slice(0, 10)],
      )).rows;
      if (quals.length === 0) warnings.push(`${tech.name} has no recorded qualification for ${kinds.join(" / ")}`);
      else if (!quals.some((q) => q.ok)) throw conflict(`${tech.name}'s qualification for ${kinds.join(" / ")} is expired or revoked on that date`, "qualification_invalid");
    }
    await db.query(
      "UPDATE visits SET technician_id = $2, scheduled_start = $3, scheduled_end = $4, estimated_duration_min = $5, duration_overridden = duration_overridden OR $6 WHERE id = $1",
      [v.id, tech.id, start, end, duration, i.body.durationMin !== undefined && i.body.durationMin !== v.estimated_duration_min],
    );
    const rescheduling = v.status !== "created";
    const outcome = await move(db, p, "visit", v.id, rescheduling ? "reschedule" : "schedule", { technician: tech.id });
    if (v.status === "incident") await db.query("UPDATE visits SET incident_reason = NULL WHERE id = $1", [v.id]);
    const updated = (await db.query("SELECT * FROM visits WHERE id = $1", [v.id])).rows[0];
    return { visit: updated, transition: outcome.transition, warnings };
  });
  return c.json(out);
});

define(operations, {
  method: "patch", path: "/visits/{id}/duration", tag: TAG, summary: "Override the estimated duration of one visit (ORF-031)", permission: "visits:edit_duration", params: idParam,
  body: z.object({ durationMin: z.number().int().min(5).max(1440) }),
}, async (c, i) => {
  const r = await run(c, (db) => db.query(
    `UPDATE visits SET estimated_duration_min = $2, duration_overridden = true,
            scheduled_end = CASE WHEN scheduled_start IS NOT NULL THEN scheduled_start + make_interval(mins => $2) ELSE scheduled_end END
     WHERE id = $1 AND status NOT IN ('completed', 'cancelled') RETURNING id, estimated_duration_min, scheduled_end`,
    [i.params.id, i.body.durationMin],
  ));
  if (!r.rows[0]) throw conflict("The visit does not exist or is already finished", "visit_finished");
  return c.json(r.rows[0]);
});

define(operations, {
  method: "post", path: "/visits/{id}/start", tag: TAG, summary: "Start a visit", permission: "visits:transition", params: idParam,
}, async (c, i) => {
  const p = c.get("principal");
  await run(c, async (db) => {
    await move(db, p, "visit", i.params.id, "start");
    await db.query("UPDATE visits SET actual_start = coalesce(actual_start, now()) WHERE id = $1", [i.params.id]);
  });
  return c.json({ ok: true });
});

define(operations, {
  method: "post", path: "/visits/{id}/incident", tag: TAG, summary: "Report an incident (client absent, access denied, ...) and optionally reschedule", permission: "visits:transition", params: idParam,
  body: z.object({ reason: z.string().min(3).max(500), reschedule: z.object({ technicianId: zUuid.optional(), start: zTimestamp }).optional() }),
}, async (c, i) => {
  const p = c.get("principal");
  const out = await run(c, async (db) => {
    const outcome = await move(db, p, "visit", i.params.id, "report_incident", { reason: i.body.reason }, i.body.reason);
    await db.query("UPDATE visits SET incident_reason = $2 WHERE id = $1", [i.params.id, i.body.reason]);
    return { state: outcome.to };
  });
  return c.json({ ...out, needsReschedule: !i.body.reschedule });
});

define(operations, {
  method: "post", path: "/visits/{id}/second-visit", tag: TAG, summary: "Create the follow-up (second) visit after an inspection with defects", permission: "visits:write", params: idParam, status: 201,
  body: z.object({ visitTypeId: zUuid.optional(), scheduledStart: zTimestamp.optional(), technicianId: zUuid.optional() }),
  description: "The parent must be completed with a conditioned, unfavorable or partial result. The legal deadline is the parent's, or today plus the visit type's second-visit days.",
}, async (c, i) => {
  const out = await run(c, async (db) => {
    const parent = (await db.query("SELECT * FROM visits WHERE id = $1 FOR UPDATE", [i.params.id])).rows[0];
    if (!parent) throw notFound("Visit");
    if (parent.status !== "completed" || !["conditioned", "unfavorable", "partial"].includes(parent.result ?? "")) {
      throw conflict("A second visit needs a completed visit with a conditioned, unfavorable or partial result", "second_visit_not_applicable");
    }
    const typeId = i.body.visitTypeId ?? parent.visit_type_id;
    const info = typeId ? await visitTypeInfo(db, typeId, parent.delegation_id) : null;
    const days = info?.secondDays ?? (await parameter<number>(db, "second_visit_default_days", parent.delegation_id, 30));
    const seq = (await db.query<{ n: number }>("SELECT max(sequence)::int + 1 AS n FROM visits WHERE work_order_id = $1", [parent.work_order_id])).rows[0]!.n;
    const visit = (await db.query(
      `INSERT INTO visits (work_order_id, parent_visit_id, visit_type_id, sequence, technician_id, scheduled_start, estimated_duration_min, legal_deadline, delegation_id, zone_id, project_id, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8::date, $9::date), $10, $11, $12, $13::jsonb) RETURNING *`,
      [parent.work_order_id, parent.id, typeId, seq, i.body.technicianId ?? parent.technician_id, i.body.scheduledStart ?? null, info?.duration ?? parent.estimated_duration_min, parent.legal_deadline, addDays(days),
       parent.delegation_id, parent.zone_id, parent.project_id, JSON.stringify({ second_visit: true })],
    )).rows[0];
    return visit;
  });
  return c.json(out, 201);
});

const defectSchema = z.object({ code: z.string().optional(), severity: z.enum(["minor", "major", "critical"]).default("minor"), description: z.string().default("") });
define(operations, {
  method: "post", path: "/visits/{id}/result", tag: TAG, summary: "Record the inspection result, complete the visit and raise a nonconformity when needed", permission: "visits:transition", params: idParam,
  body: z.object({ result: z.enum(["favorable", "conditioned", "unfavorable", "partial", "failed"]), fieldSheet: z.string().optional(), data: zJson.default({}), defects: z.array(defectSchema).default([]), createNonconformity: z.boolean().optional() }),
}, async (c, i) => {
  const p = c.get("principal");
  const out = await run(c, (db) => recordVisitResult(db, { visitId: i.params.id, ...i.body, actor: actorOf(p) }));
  return c.json(out, 201);
});

define(operations, {
  method: "post", path: "/orders/{id}/work-orders", tag: TAG, summary: "Generate a work order from a validated order", permission: "work_orders:write", params: idParam, status: 201,
  body: z.object({ inspectionType: z.string().optional(), regulation: z.string().optional(), priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"), dueDate: zDate.optional() }),
}, async (c, i) => {
  const r = await run(c, async (db) => {
    const o = (await db.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [i.params.id])).rows[0];
    if (!o) throw notFound("Order");
    if (["received", "cancelled"].includes(o.status)) throw conflict("Validate the order before generating work orders", "order_not_validated");
    return (await db.query(
      `INSERT INTO work_orders (order_id, customer_id, site_id, inspection_type, regulation, priority, due_date, delegation_id, zone_id, project_id)
       VALUES ($1, $2, $3, coalesce($4, $5), $6, $7, $8, $9, $10, $11) RETURNING *`,
      [o.id, o.customer_id, o.site_id, i.body.inspectionType ?? null, o.service_code, i.body.regulation ?? null, i.body.priority, i.body.dueDate ?? null, o.delegation_id, o.zone_id, o.project_id],
    )).rows[0];
  });
  return c.json(r, 201);
});

define(operations, { method: "get", path: "/work-orders/{id}/timeline", tag: TAG, summary: "Everything that happened to a work order: states, visits, nonconformities, certificates, tasks", permission: "work_orders:read", params: idParam }, async (c, i) => {
  const out = await run(c, async (db) => {
    const wo = (await db.query("SELECT * FROM work_orders WHERE id = $1", [i.params.id])).rows[0];
    if (!wo) throw notFound("Work order");
    const q = (sql: string) => db.query(sql, [wo.id]);
    const visits = await q("SELECT v.id, v.number, v.sequence, v.parent_visit_id, v.status, v.result, v.technician_id, t.name AS technician, v.scheduled_start, v.scheduled_end, v.actual_start, v.actual_end, v.legal_deadline, v.incident_reason, v.estimated_duration_min FROM visits v LEFT JOIN technicians t ON t.id = v.technician_id WHERE v.work_order_id = $1 ORDER BY v.sequence");
    const states = await q("SELECT entity_type, entity_id, from_state, to_state, actor, reason, at FROM entity_state_history WHERE (entity_type = 'work_order' AND entity_id = $1) OR entity_id IN (SELECT id FROM visits WHERE work_order_id = $1) OR entity_id IN (SELECT id FROM nonconformities WHERE work_order_id = $1) OR entity_id IN (SELECT id FROM certificates WHERE work_order_id = $1) ORDER BY at, id");
    const ncs = await q("SELECT id, number, status, remediation_deadline, verified_at, created_at FROM nonconformities WHERE work_order_id = $1 ORDER BY created_at");
    const certs = await q("SELECT id, number, status, issued_at, document_id, signed_document_id FROM certificates WHERE work_order_id = $1 ORDER BY created_at");
    const tasks = await q("SELECT id, number, title, status, priority, sla_due_at FROM tasks WHERE entity_type = 'work_order' AND entity_id = $1 ORDER BY created_at");
    return { workOrder: wo, visits: visits.rows, stateHistory: states.rows, nonconformities: ncs.rows, certificates: certs.rows, tasks: tasks.rows };
  });
  return c.json(out);
});
