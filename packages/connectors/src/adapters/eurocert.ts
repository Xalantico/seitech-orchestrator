import { permanent, type InboundHandler } from "@orchestrador/connector-sdk";

import { visitPackage } from "../domain.js";
import { defineRestAdapter } from "../rest.js";
import { asObj, isUuid, need, saveIncoming } from "../util.js";

/**
 * The unsigned certificate comes back from Eurocert: it is stored, attached to the certificate record and announced
 * so the flow can send it to the digital signature tool (ORF-074). Redelivery of the same certificate adds nothing.
 */
const certificateGenerated: InboundHandler = async (ctx, payload) => {
  const p = asObj(payload);
  const ref = need(p, "certificateRef");
  const woId = isUuid(p.workOrderId) ? p.workOrderId : null;
  const cert = woId
    ? (await ctx.db.query<{ id: string; document_id: string | null }>("SELECT id, document_id FROM certificates WHERE work_order_id = $1 ORDER BY created_at DESC LIMIT 1", [woId])).rows[0]
    : undefined;
  if (cert?.document_id) return { summary: `certificate ${ref} already stored` };
  const doc = await saveIncoming(ctx, {
    contentBase64: p.contentBase64, filename: p.filename ?? `${ref}.pdf`, mime: p.mime ?? "application/pdf", kind: "certificate", entityType: cert ? "certificate" : woId ? "work_order" : null, entityId: cert?.id ?? woId,
    metadata: { eurocertRef: ref, signed: false },
  });
  if (cert) await ctx.db.query("UPDATE certificates SET document_id = $2, issued_at = coalesce(issued_at, now()), extra = extra || $3::jsonb WHERE id = $1", [cert.id, doc.id, JSON.stringify({ eurocertRef: ref })]);
  return { summary: `certificate ${ref} stored`, events: [{ type: "certificate.generated", entityType: cert ? "certificate" : "document", entityId: cert?.id ?? doc.id, payload: { certificateRef: ref, documentId: doc.id, workOrderId: woId } }] };
};

export const eurocertAdapter = defineRestAdapter({
  kind: "eurocert",
  label: "Eurocert (certificados)",
  description: "Generación de certificados con los campos que dictan línea, área/subárea y comunidad autónoma. Devuelve el certificado sin firmar.",
  pingPath: "/ping",
  actions: [
    {
      key: "request-certificate", label: "Pedir certificado", direction: "push",
      description: "Se lanza al cerrarse la visita (cierre total) con los datos de la inspección.",
      input: [{ key: "visitId", label: "Visita (la última de la OT)", type: "string", required: true }, { key: "fields", label: "Campos adicionales", type: "json" }],
      path: "/certificates", externalIdPath: "id",
      async body(input, ctx) {
        const p = await visitPackage(ctx, input.visitId);
        const result = (await ctx.db.query<{ result: string | null; field_sheet: string | null; data: unknown }>("SELECT result, field_sheet, data FROM inspection_results WHERE visit_id = $1 ORDER BY submitted_at DESC LIMIT 1", [p.visit.id])).rows[0];
        if (!result) throw permanent("result_missing", "The visit has no inspection result to certify");
        return {
          workOrder: p.workOrder.number, workOrderId: p.workOrder.id, line: p.workOrder.line ?? "N/D", area: p.workOrder.area ?? "N/D", regulation: p.workOrder.regulation,
          autonomousCommunity: p.site?.autonomousCommunity ?? null, customer: p.customer, site: p.site, result: result.result, fieldSheet: result.field_sheet, data: result.data, ...(typeof input.fields === "object" && input.fields ? input.fields : {}),
        };
      },
    },
    {
      key: "fetch-certificate", label: "Traer certificado", direction: "pull", idempotent: true,
      input: [{ key: "certificateRef", label: "Certificado en Eurocert", type: "string", required: true }, { key: "workOrderId", label: "OT", type: "string" }],
      path: "/certificates/{certificateRef}",
    },
  ],
  inbound: { "certificate.generated": certificateGenerated },
});

