import { permanent, type ConnectorContext } from "@orchestrador/connector-sdk";

import { findVisit, type Obj } from "./util.js";

export type VisitPackage = {
  visit: Obj;
  workOrder: Obj;
  customer: Obj | null;
  site: Obj | null;
  technician: Obj | null;
  form: Obj | null;
  qualifications: Obj[];
  calibrations: Obj[];
};

/**
 * Everything an outside system needs to know about a visit. Personal data (customer e-mail, phone, tax id) is left
 * out on purpose: it is encrypted at rest and the planner or field tool do not need it to do their job.
 */
export async function visitPackage(ctx: ConnectorContext, ref: unknown): Promise<VisitPackage> {
  const found = await findVisit(ctx, ref);
  if (!found) throw permanent("visit_not_found", `Visit "${String(ref)}" does not exist`);
  const q = <R extends object>(sql: string, params: unknown[]) => ctx.db.query<R>(sql, params).then((r) => r.rows);
  const visit = (await q<Obj>(
    `SELECT v.id, v.number, v.sequence, v.status, v.scheduled_start AS "scheduledStart", v.scheduled_end AS "scheduledEnd", v.estimated_duration_min AS "estimatedDurationMin",
            v.legal_deadline AS "legalDeadline", vt.code AS "visitType", vt.name AS "visitTypeName", v.parent_visit_id AS "parentVisitId"
     FROM visits v LEFT JOIN visit_types vt ON vt.id = v.visit_type_id WHERE v.id = $1`, [found.id]))[0]!;
  const workOrder = (await q<Obj>(
    `SELECT w.id, w.number, w.inspection_type AS "inspectionType", w.regulation, w.line, w.area, w.priority, w.due_date AS "dueDate", w.customer_id, w.site_id
     FROM work_orders w WHERE w.id = $1`, [found.work_order_id]))[0]!;
  const customer = workOrder.customer_id ? (await q<Obj>("SELECT code, name FROM customers WHERE id = $1", [workOrder.customer_id]))[0] ?? null : null;
  const site = workOrder.site_id ? (await q<Obj>(`SELECT name, address, municipality, autonomous_community AS "autonomousCommunity", latitude, longitude, installation_type AS "installationType" FROM sites WHERE id = $1`, [workOrder.site_id]))[0] ?? null : null;
  const technician = found.technician_id ? (await q<Obj>("SELECT code, name FROM technicians WHERE id = $1", [found.technician_id]))[0] ?? null : null;
  const form = (await q<Obj>(
    `SELECT f.key, fv.version, fv.valid_to AS "validTo", fv.external_ref AS "externalRef"
     FROM visits v JOIN form_versions fv ON fv.id = v.form_version_id JOIN forms f ON f.id = fv.form_id WHERE v.id = $1`, [found.id]))[0] ?? null;
  const qualifications = found.technician_id ? await q<Obj>(`SELECT kind, reference, valid_to AS "validTo", status FROM qualifications WHERE technician_id = $1 AND status <> 'revoked' ORDER BY kind`, [found.technician_id]) : [];
  const calibrations = found.technician_id ? await q<Obj>(`SELECT equipment_code AS "equipmentCode", name, valid_to AS "validTo", status FROM equipment_calibrations WHERE technician_id = $1 ORDER BY equipment_code`, [found.technician_id]) : [];
  const { customer_id: _c, site_id: _s, ...wo } = workOrder;
  return { visit, workOrder: wo, customer, site, technician, form, qualifications, calibrations };
}
