import { permanent } from "@orchestrador/connector-sdk";

import { defineRestAdapter } from "../rest.js";
import { asObj, findVisit, need, str } from "../util.js";

/** Hours worked in each visit go to TASK (the timesheet tool; the FSM replaces it later) (ORF-071). */
export const taskAdapter = defineRestAdapter({
  kind: "task",
  label: "TASK (partes de horas)",
  description: "Envía a la herramienta de partes de horas las horas de cada técnico por visita, con geolocalización.",
  pingPath: "/ping",
  actions: [
    {
      key: "push-timesheet", label: "Enviar parte de horas", direction: "push", idempotent: true,
      description: "Una línea por técnico y visita; repetir el envío actualiza la misma línea.",
      input: [{ key: "visitId", label: "Visita", type: "string", required: true }],
      path: "/api/timesheets", externalIdPath: "id",
      async body(input, ctx) {
        const visit = await findVisit(ctx, input.visitId);
        if (!visit) throw permanent("visit_not_found", `Visit "${String(input.visitId)}" does not exist`);
        const row = (await ctx.db.query<{ code: string | null; name: string | null; actual_start: Date | null; actual_end: Date | null; geo: unknown; status: string; number: string }>(
          `SELECT t.code, t.name, v.actual_start, v.actual_end, v.geo, v.status, v.number::text FROM visits v LEFT JOIN technicians t ON t.id = v.technician_id WHERE v.id = $1`, [visit.id])).rows[0]!;
        if (!row.code) throw permanent("technician_missing", "The visit has no technician");
        if (!row.actual_start || !row.actual_end) throw permanent("hours_missing", "The visit has no real start and end yet");
        return { employeeCode: row.code, employeeName: row.name, visitRef: row.number, start: row.actual_start.toISOString(), end: row.actual_end.toISOString(), minutes: Math.round((row.actual_end.getTime() - row.actual_start.getTime()) / 60_000), geo: row.geo ?? null, inspectionStatus: row.status };
      },
    },
    { key: "get-timesheet", label: "Consultar parte", direction: "pull", input: [{ key: "id", label: "Id del parte", type: "string", required: true }], path: "/api/timesheets/{id}" },
  ],
  inbound: {
    "timesheet.approved": async (ctx, payload) => {
      const p = asObj(payload);
      const visit = await findVisit(ctx, need(p, "visitRef"));
      if (!visit) throw permanent("visit_not_found", `Visit "${str(p.visitRef)}" does not exist`);
      const tech = (await ctx.db.query<{ id: string }>("SELECT id FROM technicians WHERE code = $1", [need(p, "employeeCode")])).rows[0];
      if (!tech) throw permanent("technician_not_found", `Employee "${str(p.employeeCode)}" is not known`);
      const minutes = Number(p.minutes ?? 0);
      await ctx.db.query(
        `INSERT INTO timesheets (technician_id, visit_id, work_order_id, started_at, ended_at, minutes, cost, source)
         SELECT $1, v.id, v.work_order_id, $3::timestamptz, $4::timestamptz, $5, $6, $2 FROM visits v WHERE v.id = $7
         AND NOT EXISTS (SELECT 1 FROM timesheets WHERE technician_id = $1 AND visit_id = v.id AND source = $2)`,
        [tech.id, ctx.connector.key, str(p.start), str(p.end), minutes, p.cost ?? null, visit.id],
      );
      return { summary: `timesheet approved for visit ${visit.id}` };
    },
  },
});
