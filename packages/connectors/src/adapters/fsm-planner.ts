import { permanent, type InboundHandler } from "@orchestrador/connector-sdk";

import { visitPackage } from "../domain.js";
import { defineRestAdapter } from "../rest.js";
import { asObj, findVisit, linkExternal, need, str } from "../util.js";

/**
 * The planner (FSM-Planner / Optimiza) tells us who goes where and when, also when someone drags an appointment in
 * the calendar (ORF-066): each change is a webhook, applied to the visit and announced so the flow can react.
 */
function appointmentHandler(kind: "assigned" | "changed" | "cancelled"): InboundHandler {
  return async (ctx, payload) => {
    const p = asObj(payload);
    const visit = await findVisit(ctx, p.visitRef);
    if (!visit) throw permanent("visit_not_found", `The planner referred to visit "${String(p.visitRef)}", which does not exist`);
    const base = { visitId: visit.id, workOrderId: visit.work_order_id, appointmentId: str(p.appointmentId) };
    if (str(p.appointmentId)) await linkExternal(ctx, "visit", visit.id, String(p.appointmentId));
    if (kind === "cancelled") {
      await ctx.db.query("UPDATE visits SET scheduled_start = NULL, scheduled_end = NULL, updated_at = now() WHERE id = $1", [visit.id]);
      return { summary: `appointment cancelled for visit ${visit.id}`, events: [{ type: "visit.planning_cancelled", entityType: "visit", entityId: visit.id, payload: { ...base, reason: str(p.reason) } }] };
    }
    const code = str(p.technicianCode);
    const tech = code ? (await ctx.db.query<{ id: string }>("SELECT id FROM technicians WHERE code = $1", [code])).rows[0] : undefined;
    if (code && !tech) throw permanent("technician_not_found", `The planner assigned technician "${code}", which is not known`);
    const before = (await ctx.db.query<{ scheduled_start: Date | null; technician_id: string | null }>("SELECT scheduled_start, technician_id FROM visits WHERE id = $1", [visit.id])).rows[0]!;
    await ctx.db.query(
      "UPDATE visits SET technician_id = coalesce($2, technician_id), scheduled_start = coalesce($3::timestamptz, scheduled_start), scheduled_end = coalesce($4::timestamptz, scheduled_end), updated_at = now() WHERE id = $1",
      [visit.id, tech?.id ?? null, str(p.start), str(p.end)],
    );
    const replanned = before.scheduled_start !== null || before.technician_id !== null;
    return {
      summary: `visit ${visit.id} ${replanned ? "replanned" : "planned"}`,
      events: [{ type: replanned ? "visit.replanned" : "visit.planned", entityType: "visit", entityId: visit.id, payload: { ...base, technicianCode: code, start: str(p.start), end: str(p.end) } }],
    };
  };
}

export const fsmPlannerAdapter = defineRestAdapter({
  kind: "fsm-planner",
  label: "FSM-Planner (Optimiza)",
  description: "Planificación: envía OT, visitas, empleados y servicios; recibe técnico, fecha y hora asignados y los cambios de calendario; cancela citas.",
  pingPath: "/plan/appointments?limit=1",
  actions: [
    {
      key: "request-planning", label: "Solicitar planificación", direction: "push",
      description: "Envía la OT y sus visitas pendientes al planificador. Con `visitIds` rellena los datos de cada visita desde la base de datos.",
      input: [{ key: "visitIds", label: "Visitas (ids)", type: "json", required: true }, { key: "workOrderNumber", label: "Nº de OT", type: "string" }, { key: "notes", label: "Notas para el planificador", type: "text" }],
      path: "/plan/requests", externalIdPath: "id",
      async body(input, ctx) {
        const ids = Array.isArray(input.visitIds) ? input.visitIds : [input.visitIds];
        const packages = [];
        for (const id of ids) packages.push(await visitPackage(ctx, id));
        if (packages.length === 0) throw permanent("input_invalid", "No visits to plan");
        const first = packages[0]!;
        return {
          workOrder: { ...first.workOrder, customer: first.customer, site: first.site },
          visits: packages.map((p) => ({ ...p.visit, requiredQualifications: p.qualifications.map((q) => q.kind) })),
          employees: [...new Map(packages.filter((p) => p.technician).map((p) => [String(p.technician!.code), p.technician])).values()],
          services: [{ code: first.workOrder.inspectionType, regulation: first.workOrder.regulation }],
          notes: str(input.notes),
        };
      },
    },
    {
      key: "update-visit", label: "Comunicar estado de la visita", direction: "push", idempotent: true,
      description: "Estado, fecha real de inicio y fin y geolocalización de la visita de campo.",
      input: [{ key: "visitRef", label: "Visita", type: "string", required: true }, { key: "status", label: "Estado", type: "string", required: true }, { key: "actualStart", label: "Inicio real", type: "string" }, { key: "actualEnd", label: "Fin real", type: "string" }, { key: "geo", label: "Geolocalización", type: "json" }],
      method: "PATCH", path: "/plan/visits/{visitRef}",
    },
    {
      key: "cancel-appointment", label: "Cancelar cita", direction: "push", idempotent: true,
      description: "Cancela la cita en el planificador (p. ej. al cancelarse la OT). Repetir la cancelación no es un error.",
      input: [{ key: "appointmentId", label: "Cita", type: "string", required: true }, { key: "reason", label: "Motivo", type: "string", required: true }],
      path: "/plan/appointments/{appointmentId}/cancel", body: (i) => ({ reason: need(i, "reason") }),
    },
    { key: "list-appointments", label: "Listar citas", direction: "pull", input: [{ key: "updatedSince", label: "Modificadas desde", type: "string" }], path: "/plan/appointments", query: (i) => ({ updatedSince: i.updatedSince ? String(i.updatedSince) : undefined }), output: (b) => (b as { items?: unknown }).items },
  ],
  inbound: { "appointment.assigned": appointmentHandler("assigned"), "appointment.changed": appointmentHandler("changed"), "appointment.cancelled": appointmentHandler("cancelled") },
  feeds: [{ path: "/plan/appointments", eventType: (i) => (i.status === "cancelled" ? "appointment.cancelled" : "appointment.changed"), listPath: "items", idPath: "id", updatedPath: "updatedAt", cursorParam: "updatedSince", nextPath: "next" }],
});
