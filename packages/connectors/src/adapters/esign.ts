import { permanent, request, createBackofficeTask, type InboundHandler } from "@orchestrador/connector-sdk";

import { defineRestAdapter } from "../rest.js";
import { asObj, documentsOf, isUuid, need, saveIncoming, str, toB64 } from "../util.js";

/** The signed document comes back as a new version of the original and replaces it in the certificate (ORF-075). */
const signatureCompleted: InboundHandler = async (ctx, payload) => {
  const p = asObj(payload);
  const id = need(p, "id");
  const res = await request(ctx, { path: `/signatures/${encodeURIComponent(id)}` });
  const sig = asObj(res.body);
  if (sig.status !== "completed" || !sig.signedContentBase64) throw permanent("signature_not_completed", `Signature ${id} is not completed yet`);
  const meta = asObj(sig.metadata);
  const originalId = isUuid(meta.documentId) ? meta.documentId : null;
  const certId = isUuid(meta.certificateId) ? meta.certificateId : null;
  const already = originalId ? (await ctx.db.query("SELECT 1 FROM documents WHERE previous_version_id = $1 AND signed", [originalId])).rows[0] : undefined;
  if (already) return { summary: `signature ${id} already applied` };
  const doc = await saveIncoming(ctx, {
    contentBase64: sig.signedContentBase64, filename: String(sig.filename ?? `${id}.pdf`).replace(/(\.pdf)?$/i, "-firmado.pdf"), mime: "application/pdf", kind: str(meta.kind) ?? "certificate", signed: true,
    previousVersionId: originalId, entityType: certId ? "certificate" : str(meta.entityType), entityId: certId ?? (isUuid(meta.entityId) ? meta.entityId : null), metadata: { signatureId: id, signedAt: sig.signedAt ?? null },
  });
  if (certId) await ctx.db.query("UPDATE certificates SET signed_document_id = $2, updated_at = now() WHERE id = $1", [certId, doc.id]);
  return { summary: `signed document ${doc.id}`, events: [{ type: "document.signed", entityType: certId ? "certificate" : "document", entityId: certId ?? doc.id, payload: { documentId: doc.id, signatureId: id, originalDocumentId: originalId } }] };
};

const signatureDeclined: InboundHandler = async (ctx, payload) => {
  const p = asObj(payload);
  const id = need(p, "id");
  const task = await createBackofficeTask(ctx.db, { queue: "certificacion", title: `Firma rechazada ${id}`, priority: "high", kind: "signature_declined", dedupeKey: `signature:${id}`, description: str(p.reason) ?? "El firmante rechazó el documento.", extra: { signatureId: id } });
  return { summary: `signature ${id} declined, task ${task.id}`, events: [{ type: "document.signature_declined", entityType: "task", entityId: task.id, payload: { signatureId: id, reason: str(p.reason) } }] };
};

export const esignAdapter = defineRestAdapter({
  kind: "esign",
  label: "Firma digital (eIDAS)",
  description: "Envía el documento sin firmar a la herramienta de firma y recibe el firmado para el gestor documental.",
  pingPath: "/ping",
  actions: [
    {
      key: "send-for-signature", label: "Enviar a firma", direction: "push",
      description: "Con la clave de idempotencia por documento, reenviar tras un fallo no crea una segunda petición de firma.",
      input: [
        { key: "documentId", label: "Documento", type: "string", required: true }, { key: "signers", label: "Firmantes [{name,email}]", type: "json", required: true }, { key: "reason", label: "Motivo", type: "string" },
        { key: "level", label: "Nivel eIDAS", type: "select", options: [["SES", "Simple"], ["AES", "Avanzada"], ["QES", "Cualificada"]], default: "AES" },
        { key: "certificateId", label: "Certificado asociado", type: "string" },
      ],
      path: "/signatures", externalIdPath: "id",
      async body(input, ctx) {
        const doc = await documentsOf(ctx).read(need(input, "documentId"));
        const signers = Array.isArray(input.signers) ? input.signers : [];
        if (signers.length === 0) throw permanent("input_invalid", "At least one signer is required");
        return { filename: doc.filename, contentBase64: toB64(doc.data), signers, reason: str(input.reason) ?? "Firma de certificado", level: str(input.level) ?? "AES", metadata: { documentId: doc.id, certificateId: str(input.certificateId), kind: doc.kind, entityType: doc.entityType, entityId: doc.entityId } };
      },
      output: (b) => ({ id: asObj(b).id, status: asObj(b).status }),
    },
    { key: "get-signature", label: "Estado de la firma", direction: "pull", input: [{ key: "id", label: "Petición de firma", type: "string", required: true }], path: "/signatures/{id}", output: (b) => { const o = asObj(b); return { id: o.id, status: o.status, signedAt: o.signedAt ?? null }; } },
  ],
  inbound: { "signature.completed": signatureCompleted, "signature.declined": signatureDeclined },
});
