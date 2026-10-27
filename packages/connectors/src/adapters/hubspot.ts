import { permanent, request, type InboundHandler } from "@orchestrador/connector-sdk";

import { defineRestAdapter } from "../rest.js";
import { asObj, documentsOf, fromB64, isUuid, need, saveIncoming, str, toB64 } from "../util.js";

const OBJECT_TYPES: [string, string][] = [["companies", "Empresa"], ["contacts", "Contacto"], ["deals", "Oportunidad"], ["notes", "Nota / comunicación"]];

/** A document the CRM holds (offer, contract) arrives in the Orquestador for the document manager or for sending (ORF-060). */
const documentReceived: InboundHandler = async (ctx, payload) => {
  const p = asObj(payload);
  const fileId = need(p, "fileId");
  const res = await request(ctx, { path: `/files/v3/files/${encodeURIComponent(fileId)}` });
  const file = asObj(res.body);
  const entityId = isUuid(p.entityId) ? p.entityId : null;
  const doc = await saveIncoming(ctx, {
    contentBase64: file.contentBase64, filename: file.name, mime: file.mime, kind: str(p.kind) ?? "crm_document",
    entityType: entityId ? str(p.entityType) ?? "order" : null, entityId, metadata: { crmFileId: fileId, crmRef: str(p.dealId) },
  });
  return { summary: `stored ${doc.filename}`, events: [{ type: "document.received", entityType: "document", entityId: doc.id, payload: { kind: str(p.kind) ?? "crm_document", source: ctx.connector.key } }] };
};

export const hubspotAdapter = defineRestAdapter({
  kind: "hubspot",
  label: "HubSpot CRM",
  description: "CRM corporativo: clientes, contactos y oportunidades en ambos sentidos, y documentos (ofertas, contratos) y comunicaciones.",
  pingPath: "/crm/v3/objects/companies?limit=1",
  actions: [
    {
      key: "upsert-object", label: "Crear o actualizar objeto", direction: "push",
      description: "Crea el objeto en el CRM, o lo actualiza si se indica su id. Los campos viajan en `properties`.",
      input: [
        { key: "objectType", label: "Tipo", type: "select", required: true, options: OBJECT_TYPES },
        { key: "id", label: "Id en el CRM (vacío = crear)", type: "string" },
        { key: "properties", label: "Campos", type: "json", required: true },
      ],
      method: "POST", path: "/crm/v3/objects/{objectType}", externalIdPath: "id",
    },
    { key: "get-object", label: "Leer objeto", direction: "pull", input: [{ key: "objectType", label: "Tipo", type: "select", required: true, options: OBJECT_TYPES }, { key: "id", label: "Id", type: "string", required: true }], path: "/crm/v3/objects/{objectType}/{id}", externalIdPath: "id" },
    {
      key: "list-objects", label: "Listar objetos modificados", direction: "pull",
      input: [{ key: "objectType", label: "Tipo", type: "select", required: true, options: OBJECT_TYPES }, { key: "updatedSince", label: "Modificados desde", type: "string" }, { key: "limit", label: "Máximo", type: "number" }],
      path: "/crm/v3/objects/{objectType}", query: (i) => ({ updatedSince: str(i.updatedSince), limit: i.limit === undefined ? 100 : Number(i.limit) }),
    },
    {
      key: "log-communication", label: "Registrar comunicación enviada", direction: "push",
      description: "Deja constancia en la ficha del cliente del correo o SMS enviado desde el gestor de comunicaciones.",
      input: [{ key: "contactId", label: "Contacto en el CRM", type: "string", required: true }, { key: "subject", label: "Asunto", type: "string", required: true }, { key: "body", label: "Contenido", type: "text" }, { key: "channel", label: "Canal", type: "string" }],
      path: "/crm/v3/objects/notes", body: (i) => ({ properties: { subject: i.subject, body: i.body ?? "", channel: i.channel ?? "email", sentAt: new Date().toISOString() }, associations: [{ type: "contact", id: i.contactId }] }), externalIdPath: "id",
    },
  ],
  inbound: { "document.received": documentReceived },
  feeds: [
    { path: "/crm/v3/objects/companies", eventType: "company.upsert", listPath: "results", idPath: "id", updatedPath: "updatedAt", cursorParam: "updatedSince", nextPath: "paging.next.after" },
    { path: "/crm/v3/objects/deals", eventType: "deal.won", listPath: "results", idPath: "id", updatedPath: "updatedAt", cursorParam: "updatedSince", nextPath: "paging.next.after", accept: (d) => asObj(d.properties).dealstage === "closedwon" },
  ],
});

// upsert-object needs "update when an id is given": the generic builder POSTs, so wrap the action.
const upsert = hubspotAdapter.actions.find((a) => a.key === "upsert-object")!;
const create = upsert.run;
upsert.run = async (ctx, input) => {
  const id = str(input.id);
  if (!id) return create(ctx, input);
  const type = need(input, "objectType");
  if (!asObj(input.properties) || Object.keys(asObj(input.properties)).length === 0) throw permanent("input_invalid", '"properties" is required');
  const res = await request(ctx, { method: "PATCH", path: `/crm/v3/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, body: { properties: input.properties } });
  return { output: res.body, externalId: id };
};
upsert.idempotent = false;

// Document transfer actions need the document gateway, so they are added next to the generic ones.
hubspotAdapter.actions.push(
  {
    key: "upload-document", label: "Enviar documento al CRM", direction: "push", input: [{ key: "documentId", label: "Documento", type: "string", required: true }, { key: "folder", label: "Carpeta del CRM", type: "string" }],
    async run(ctx, input) {
      const doc = await documentsOf(ctx).read(need(input, "documentId"));
      const res = await request(ctx, { method: "POST", path: "/files/v3/files", body: { name: doc.filename, mime: doc.mime, folder: str(input.folder), contentBase64: toB64(doc.data) } });
      return { output: res.body, externalId: str(asObj(res.body).id) ?? "" };
    },
  },
  {
    key: "download-document", label: "Traer documento del CRM", direction: "pull",
    input: [{ key: "fileId", label: "Archivo en el CRM", type: "string", required: true }, { key: "kind", label: "Tipo de documento", type: "string" }, { key: "entityType", label: "Entidad", type: "string" }, { key: "entityId", label: "Id de la entidad", type: "string" }],
    idempotent: true,
    async run(ctx, input) {
      const res = await request(ctx, { path: `/files/v3/files/${encodeURIComponent(need(input, "fileId"))}` });
      const file = asObj(res.body);
      const doc = await saveIncoming(ctx, { contentBase64: file.contentBase64, filename: file.name, mime: file.mime, kind: str(input.kind) ?? "crm_document", entityType: isUuid(input.entityId) ? str(input.entityType) : null, entityId: isUuid(input.entityId) ? input.entityId : null, metadata: { crmFileId: str(input.fileId) } });
      return { output: { documentId: doc.id, filename: doc.filename, bytes: fromB64(String(file.contentBase64 ?? "")).length } };
    },
  },
);
