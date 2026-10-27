import { request, type InboundHandler } from "@orchestrador/connector-sdk";

import { defineRestAdapter } from "../rest.js";
import { asObj, isUuid, need, saveIncoming, str } from "../util.js";

const COMPANY = "/api/v2.0";

/** The posted invoice (PDF) goes to the document manager and, from there, to the customer (ORF-062). */
const invoicePosted: InboundHandler = async (ctx, payload) => {
  const p = asObj(payload);
  const invoiceId = need(p, "id");
  const res = await request(ctx, { path: `${COMPANY}/salesInvoices/${encodeURIComponent(invoiceId)}/pdf` });
  const file = asObj(res.body);
  const orderId = isUuid(p.orderRef) ? p.orderRef : null;
  const doc = await saveIncoming(ctx, {
    contentBase64: file.contentBase64, filename: file.filename, mime: file.mime, kind: "invoice", entityType: orderId ? "order" : null, entityId: orderId,
    metadata: { invoiceNumber: str(p.number) ?? invoiceId, customerNumber: str(p.customerNumber) },
  });
  return { summary: `invoice ${str(p.number) ?? invoiceId} stored`, events: [{ type: "invoice.posted", entityType: "document", entityId: doc.id, payload: { invoiceNumber: str(p.number) ?? invoiceId, documentId: doc.id } }] };
};

export const businessCentralAdapter = defineRestAdapter({
  kind: "business-central",
  label: "Microsoft Dynamics 365 Business Central",
  description: "ERP: pedidos, servicios, empleados y validación de precios hacia el Orquestador; facturas y actualizaciones hacia el ERP.",
  configSchema: [{ key: "company", label: "Compañía", type: "string", help: "Identificador de la compañía en Business Central." }],
  pingPath: `${COMPANY}/employees?$top=1`,
  actions: [
    {
      key: "push-invoice", label: "Crear factura de venta", direction: "push",
      description: "Envía las líneas de facturación de una OT cerrada. La clave de idempotencia evita facturar dos veces.",
      input: [{ key: "customerNumber", label: "Nº de cliente en el ERP", type: "string", required: true }, { key: "orderNumber", label: "Nº de pedido", type: "string" }, { key: "lines", label: "Líneas", type: "json", required: true }, { key: "postingDate", label: "Fecha de registro", type: "string" }],
      path: `${COMPANY}/salesInvoices`, externalIdPath: "number",
    },
    {
      key: "validate-pricing", label: "Validar precio", direction: "pull", idempotent: true,
      input: [{ key: "itemNumber", label: "Producto o servicio", type: "string", required: true }, { key: "unitPrice", label: "Precio unitario", type: "number", required: true }, { key: "customerNumber", label: "Cliente", type: "string" }],
      method: "POST", path: `${COMPANY}/pricing/validate`,
    },
    {
      key: "update-order", label: "Actualizar pedido", direction: "push", idempotent: true,
      input: [{ key: "orderNumber", label: "Nº de pedido", type: "string", required: true }, { key: "status", label: "Estado", type: "string", required: true }, { key: "fields", label: "Otros campos", type: "json" }],
      method: "PATCH", path: `${COMPANY}/salesOrders/{orderNumber}`, body: (i) => ({ status: i.status, ...(i.fields && typeof i.fields === "object" ? i.fields : {}) }),
    },
    { key: "get-order", label: "Leer pedido", direction: "pull", input: [{ key: "orderNumber", label: "Nº de pedido", type: "string", required: true }], path: `${COMPANY}/salesOrders`, query: (i) => ({ $filter: `number eq '${String(i.orderNumber).replace(/'/g, "''")}'` }), output: (b) => asObj(b).value },
    { key: "list-employees", label: "Listar empleados", direction: "pull", input: [], path: `${COMPANY}/employees`, output: (b) => asObj(b).value },
  ],
  inbound: { "invoice.posted": invoicePosted },
  feeds: [
    { path: `${COMPANY}/salesOrders`, eventType: "salesOrder.upsert", listPath: "value", idPath: "number", updatedPath: "lastModifiedDateTime", cursorQuery: (c) => ({ $filter: `lastModifiedDateTime gt ${c}` }) },
    { path: `${COMPANY}/employees`, eventType: "employee.upsert", listPath: "value", idPath: "number", updatedPath: "lastModifiedDateTime", cursorQuery: (c) => ({ $filter: `lastModifiedDateTime gt ${c}` }) },
  ],
});
