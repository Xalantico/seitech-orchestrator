import { permanent, request, type InboundHandler } from "@orchestrador/connector-sdk";
import { recordVisitResult } from "@orchestrador/flowhost";

import { visitPackage } from "../domain.js";
import { defineRestAdapter } from "../rest.js";
import { asObj, findVisit, list, need, saveIncoming, str, SYSTEM_ACTOR } from "../util.js";

const RESULTS = ["favorable", "conditioned", "unfavorable", "partial", "failed"] as const;
type Result = (typeof RESULTS)[number];

/** The inspector finished: result, defects, times and position arrive, the visit completes, flows are told (ORF-068). */
const inspectionCompleted: InboundHandler = async (ctx, payload) => {
  const p = asObj(payload);
  const visit = await findVisit(ctx, p.visitRef);
  if (!visit) throw permanent("visit_not_found", `The field tool reported visit "${String(p.visitRef)}", which does not exist`);
  const result = String(p.result ?? "") as Result;
  if (!RESULTS.includes(result)) throw permanent("result_invalid", `Unknown inspection result "${String(p.result)}" (expected ${RESULTS.join(", ")})`);
  const defects = list(p.defects).map((d) => {
    const x = asObj(d);
    const severity = ["minor", "major", "critical"].includes(String(x.severity)) ? (String(x.severity) as "minor" | "major" | "critical") : "minor";
    return { code: str(x.code) ?? undefined, severity, description: str(x.description) ?? "" };
  });
  const geo = asObj(p.geo);
  const outcome = await recordVisitResult(ctx.db as never, {
    visitId: visit.id, result, fieldSheet: str(p.fieldSheet), data: { ...asObj(p.data), hours: p.hours ?? null, reportedBy: str(p.technicianCode), source: ctx.connector.key },
    defects, startedAt: str(p.startedAt), endedAt: str(p.endedAt), geo: Object.keys(geo).length > 0 ? geo : null, actor: SYSTEM_ACTOR,
  });
  return { summary: `result ${result} for visit ${visit.id}${outcome.nonconformityId ? " (nonconformity raised)" : ""}` };
};

/** Photos, work report: stored against the visit for the document manager or for forwarding (ORF-069). */
const documentUploaded: InboundHandler = async (ctx, payload) => {
  const p = asObj(payload);
  const visit = await findVisit(ctx, p.visitRef);
  if (!visit) throw permanent("visit_not_found", `The field tool referred to visit "${String(p.visitRef)}", which does not exist`);
  const res = await request(ctx, { path: `/documents/${encodeURIComponent(need(p, "documentId"))}` });
  const file = asObj(res.body);
  const doc = await saveIncoming(ctx, { contentBase64: file.contentBase64, filename: file.filename, mime: file.mime, kind: str(p.kind) ?? "field_document", entityType: "visit", entityId: visit.id, metadata: { fieldDocumentId: str(p.documentId), visitRef: str(p.visitRef) } });
  return { summary: `document ${doc.filename} stored`, events: [{ type: "document.received", entityType: "document", entityId: doc.id, payload: { kind: str(p.kind) ?? "field_document", visitId: visit.id } }] };
};

export const fsmFieldAdapter = defineRestAdapter({
  kind: "fsm-field",
  label: "FSM · herramienta de campo",
  description: "Aplicación del inspector: apertura de visitas, notificaciones push, y recepción de resultados, defectos, tiempos, geolocalización y documentos.",
  pingPath: "/ping",
  actions: [
    {
      key: "open-visit", label: "Abrir visita de campo", direction: "push",
      description: "Envía OT, visita, cliente, técnico, planificación, hoja de campo, cualificaciones y calibraciones del técnico.",
      input: [{ key: "visitId", label: "Visita", type: "string", required: true }],
      path: "/visits", externalIdPath: "id",
      async body(input, ctx) {
        const p = await visitPackage(ctx, input.visitId);
        if (!p.technician) throw permanent("technician_missing", "The visit has no technician assigned yet");
        return { visitRef: p.visit.id, technicianCode: p.technician.code, ...p, fieldSheet: p.form };
      },
    },
    {
      key: "notify-technician", label: "Notificar al inspector (push)", direction: "push",
      description: "Nuevas visitas, cambios de planificación o urgencias en la app móvil.",
      input: [
        { key: "technicianCode", label: "Código del técnico", type: "string", required: true }, { key: "title", label: "Título", type: "string", required: true }, { key: "body", label: "Mensaje", type: "text" },
        { key: "kind", label: "Tipo", type: "select", options: [["new_visit", "Nueva visita"], ["schedule_change", "Cambio de planificación"], ["urgent", "Urgencia"]], default: "new_visit" },
      ],
      path: "/notifications", externalIdPath: "id",
    },
  ],
  inbound: { "inspection.completed": inspectionCompleted, "document.uploaded": documentUploaded },
});
