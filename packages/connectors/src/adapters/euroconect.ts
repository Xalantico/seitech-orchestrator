import { permanent, type InboundHandler } from "@orchestrador/connector-sdk";

import { defineRestAdapter } from "../rest.js";
import { createBackofficeTask } from "@orchestrador/connector-sdk";
import { asObj, list, need, saveIncoming, str } from "../util.js";

const ADMINISTRATIONS: [string, string][] = [["sioca", "Sioca"], ["aire", "Aire"], ["exim", "Exim"], ["piti", "Piti"], ["sede", "Sede"], ["ica", "ICA"]];

/**
 * Euroconect generated the batch file. The administration websites are not integrated (out of scope), so a person
 * uploads it: the file is stored and a task goes to the "lotes" queue with the file attached (ORF-072, ORF-087..092).
 */
const batchGenerated: InboundHandler = async (ctx, payload) => {
  const p = asObj(payload);
  const batchRef = need(p, "batchId");
  const administration = str(p.administration) ?? "desconocida";
  const doc = await saveIncoming(ctx, { contentBase64: p.contentBase64, filename: p.filename ?? `lote-${batchRef}.xml`, mime: p.mime, kind: "batch_file", metadata: { batchRef, administration, inspections: list(p.inspectionIds).length } });
  const task = await createBackofficeTask(ctx.db, {
    queue: "lotes", title: `Subir lote ${batchRef} a ${administration}`, priority: "high", kind: "batch_upload", source: "integration", dedupeKey: `batch:${ctx.connector.key}:${batchRef}`, dueInHours: 24,
    description: `Euroconect ha generado el lote ${batchRef} para ${administration} (${list(p.inspectionIds).length} inspecciones). Súbalo a la web de la administración y anote el resultado.`,
    actions: [{ action: "complete", label: "Subido", nextPort: "uploaded" }, { action: "reject", label: "Rechazado por la administración", nextPort: "rejected" }, { action: "comment", label: "Comentar" }],
    extra: { batchRef, administration, documentId: doc.id, connectorKey: ctx.connector.key },
  });
  await ctx.db.query(
    `INSERT INTO batch_files (connector_key, batch_ref, administration, status, document_id, task_id, inspection_ids) VALUES ($1, $2, $3, 'generated', $4, $5, $6::jsonb)
     ON CONFLICT (connector_key, batch_ref) DO UPDATE SET status = 'generated', document_id = EXCLUDED.document_id, task_id = EXCLUDED.task_id, updated_at = now()`,
    [ctx.connector.key, batchRef, administration, doc.id, task.id, JSON.stringify(list(p.inspectionIds))],
  );
  return { summary: `batch ${batchRef} stored, task ${task.id} created`, events: [{ type: "batch.generated", entityType: "document", entityId: doc.id, payload: { batchRef, administration, taskId: task.id } }] };
};

export const euroconectAdapter = defineRestAdapter({
  kind: "euroconect",
  label: "Euroconect (archivos de lotes)",
  description: "Generador de lotes XML/XLS por administración. El fichero devuelto crea una tarea de back-office para subirlo a la web de la administración.",
  pingPath: "/ping",
  actions: [
    {
      key: "request-batch", label: "Pedir generación de lote", direction: "push",
      description: "Indica qué inspecciones debe incluir el lote y para qué administración. Sioca, Aire, Exim, Piti, Sede e ICA no tienen conector: el lote lo sube una persona.",
      input: [
        { key: "administration", label: "Administración", type: "select", required: true, options: ADMINISTRATIONS },
        { key: "inspectionIds", label: "Inspecciones (ids)", type: "json", required: true },
        { key: "format", label: "Formato", type: "select", options: [["xml", "XML"], ["xls", "XLS"]], default: "xml" },
      ],
      path: "/batches", externalIdPath: "id",
      async body(input) {
        const ids = list(input.inspectionIds);
        if (ids.length === 0) throw permanent("input_invalid", "inspectionIds is empty");
        return { administration: need(input, "administration"), inspectionIds: ids, format: str(input.format) ?? "xml" };
      },
    },
    { key: "get-batch", label: "Consultar lote", direction: "pull", input: [{ key: "id", label: "Lote", type: "string", required: true }], path: "/batches/{id}" },
  ],
  inbound: { "batch.generated": batchGenerated },
});
