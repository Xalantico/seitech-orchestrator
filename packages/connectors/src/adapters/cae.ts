import { createBackofficeTask, permanent, type InboundHandler } from "@orchestrador/connector-sdk";

import { visitPackage } from "../domain.js";
import { defineRestAdapter } from "../rest.js";
import { asObj, list, need, str } from "../util.js";

/** Documentation status of a project: missing documents become a back-office task, acceptance is announced (ORF-082). */
const documentationStatus: InboundHandler = async (ctx, payload) => {
  const p = asObj(payload);
  const projectRef = need(p, "projectRef");
  const status = need(p, "status");
  if (!["accepted", "rejected", "missing"].includes(status)) throw permanent("status_invalid", `Unknown CAE status "${status}"`);
  const project = (await ctx.db.query<{ id: string }>("SELECT id FROM projects WHERE code = $1 LIMIT 1", [projectRef])).rows[0];
  const missing = list(p.missing).map(String);
  const events: { type: string; entityType: string; entityId: string; payload: Record<string, unknown> }[] = [];
  let summary = `project ${projectRef}: ${status}`;
  if (project) {
    await ctx.db.query("UPDATE projects SET extra = extra || $2::jsonb WHERE id = $1", [project.id, JSON.stringify({ cae: { status, missing, at: new Date().toISOString() } })]);
    events.push({ type: status === "accepted" ? "cae.documentation_accepted" : "cae.documentation_missing", entityType: "project", entityId: project.id, payload: { projectRef, status, missing } });
  }
  if (status !== "accepted") {
    const task = await createBackofficeTask(ctx.db, {
      queue: "backoffice", title: `CAE: documentación ${status === "missing" ? "pendiente" : "rechazada"} · ${projectRef}`, priority: "high", kind: "cae_documentation", dedupeKey: `cae:${projectRef}`,
      description: missing.length > 0 ? `Falta por subir a la plataforma CAE:\n- ${missing.join("\n- ")}` : "La plataforma CAE ha rechazado la documentación.", extra: { projectRef, missing },
    });
    summary += `, task ${task.id}`;
  }
  return { summary, events };
};

export const caeAdapter = defineRestAdapter({
  kind: "cae",
  label: "Plataforma CAE",
  description: "Coordinación de actividades empresariales: recibe el estado de la documentación por proyecto y envía las visitas programadas.",
  pingPath: "/ping",
  actions: [
    {
      key: "send-visit", label: "Enviar visita programada", direction: "push", idempotent: true,
      description: "Emplazamiento, fecha, empresa inspectora y técnicos participantes.",
      input: [{ key: "visitId", label: "Visita", type: "string", required: true }],
      path: "/visits", externalIdPath: "id",
      async body(input, ctx) {
        const p = await visitPackage(ctx, input.visitId);
        if (!p.visit.scheduledStart) throw permanent("visit_unscheduled", "The visit has no date yet");
        const company = str(asObj(ctx.connector.config).inspectingCompany) ?? "Empresa inspectora";
        return { visitRef: p.visit.id, site: p.site, date: p.visit.scheduledStart, company, technicians: p.technician ? [p.technician] : [] };
      },
    },
    { key: "get-documentation", label: "Estado de la documentación", direction: "pull", input: [{ key: "projectRef", label: "Proyecto", type: "string", required: true }], path: "/projects/{projectRef}/documentation" },
  ],
  configSchema: [{ key: "inspectingCompany", label: "Empresa inspectora", type: "string" }],
  inbound: { "documentation.status": documentationStatus },
});
