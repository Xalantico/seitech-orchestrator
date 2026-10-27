import { createBackofficeTask, type InboundHandler } from "@orchestrador/connector-sdk";

import { defineRestAdapter } from "../rest.js";
import { asObj, documentsOf, need, str } from "../util.js";

/** A customer asks something in the portal: it lands in the back-office queue with the customer's reference (ORF-083). */
const requestCreated: InboundHandler = async (ctx, payload) => {
  const p = asObj(payload);
  const ref = need(p, "requestId");
  const task = await createBackofficeTask(ctx.db, {
    queue: "backoffice", title: `Portal de cliente: ${str(p.subject) ?? "consulta"}`, priority: "medium", kind: "portal_request", dedupeKey: `portal:${ref}`, dueInHours: 48,
    description: str(p.message) ?? "", extra: { requestId: ref, customerRef: str(p.customerRef), inspectionRef: str(p.inspectionRef) },
  });
  return { summary: `portal request ${ref} -> task ${task.id}`, events: [{ type: "portal.request_created", entityType: "task", entityId: task.id, payload: { requestId: ref, inspectionRef: str(p.inspectionRef) } }] };
};

export const portalAdapter = defineRestAdapter({
  kind: "portal",
  label: "Portal de cliente",
  description: "Estado de las inspecciones y documentos hacia el portal; peticiones de los clientes hacia el back-office; estadísticas de uso para análisis.",
  pingPath: "/ping",
  actions: [
    {
      key: "push-status", label: "Publicar estado de la inspección", direction: "push", idempotent: true,
      input: [{ key: "inspectionRef", label: "Inspección", type: "string", required: true }, { key: "status", label: "Estado", type: "string", required: true }, { key: "message", label: "Mensaje para el cliente", type: "text" }, { key: "visibleTo", label: "Roles del portal", type: "json" }],
      path: "/inspections/{inspectionRef}/status",
    },
    {
      key: "publish-document", label: "Publicar documento", direction: "push",
      description: "El portal recibe la ficha del documento (oferta, certificado, factura) y lo pide a la plataforma con el rol del cliente; no se copia el archivo.",
      input: [{ key: "inspectionRef", label: "Inspección", type: "string", required: true }, { key: "documentId", label: "Documento", type: "string", required: true }, { key: "title", label: "Título", type: "string" }],
      path: "/inspections/{inspectionRef}/documents", externalIdPath: "id",
      async body(input, ctx) {
        const d = await documentsOf(ctx).read(need(input, "documentId"));
        return { documentId: d.id, kind: d.kind, title: str(input.title) ?? d.filename, mime: d.mime, size: d.data.length, signed: d.signed };
      },
    },
    { key: "get-analytics", label: "Estadísticas de acceso y experiencia", direction: "pull", input: [{ key: "period", label: "Periodo", type: "string", default: "30d" }], path: "/analytics", query: (i) => ({ period: str(i.period) ?? "30d" }) },
  ],
  inbound: { "request.created": requestCreated },
});
