import { type InboundHandler } from "@orchestrador/connector-sdk";

import { defineRestAdapter } from "../rest.js";
import { asObj, list, need, str } from "../util.js";

const STATUS: Record<string, string> = { delivered: "delivered", sent: "sent", failed: "failed", bounced: "bounced" };

/** Result of a communication the external manager sent on our behalf: updates the message trail (ORF-076). */
const result: InboundHandler = async (ctx, payload) => {
  const p = asObj(payload);
  const id = need(p, "id");
  let updated = 0;
  for (const r of list(p.results)) {
    const x = asObj(r);
    const status = STATUS[String(x.status)];
    if (!status) continue;
    const res = await ctx.db.query(
      `UPDATE messages SET status = $3, error = $4, delivered_at = CASE WHEN $3 = 'delivered' THEN now() ELSE delivered_at END
       WHERE provider_id = $1 AND to_address = $2 AND status NOT IN ('delivered', 'bounced')`,
      [id, str(x.to), status, str(x.error)],
    );
    updated += res.rowCount ?? 0;
  }
  return { summary: `communication ${id}: ${updated} messages updated`, events: [] };
};

export const commsManagerAdapter = defineRestAdapter({
  kind: "comms-manager",
  label: "Gestor de comunicaciones externo",
  description: "El Orquestador ordena el envío (listados, plantilla y momento) y recibe el resultado de cada comunicación.",
  pingPath: "/ping",
  actions: [
    {
      key: "send-communication", label: "Ordenar comunicación", direction: "push",
      input: [
        { key: "template", label: "Plantilla", type: "string", required: true }, { key: "recipients", label: "Destinatarios [{to, vars}]", type: "json", required: true },
        { key: "sendAt", label: "Enviar el", type: "string", help: "Vacío = ahora." }, { key: "channel", label: "Canal", type: "select", options: [["email", "Correo"], ["sms", "SMS"], ["whatsapp", "WhatsApp"]], default: "email" },
      ],
      path: "/communications", externalIdPath: "id",
    },
    { key: "get-communication", label: "Resultado de una comunicación", direction: "pull", input: [{ key: "id", label: "Comunicación", type: "string", required: true }], path: "/communications/{id}" },
  ],
  inbound: { "communication.result": result },
});
