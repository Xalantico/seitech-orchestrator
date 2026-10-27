import { permanent } from "@orchestrador/connector-sdk";

import { defineRestAdapter } from "../rest.js";
import { asObj, list, need, str } from "../util.js";

const recipients = (v: unknown) => list(v).map((x) => ({ emailAddress: { address: typeof x === "string" ? x : String(asObj(x).address ?? asObj(asObj(x).emailAddress).address ?? "") } })).filter((r) => r.emailAddress.address.includes("@"));

/** Mail and calendar through Microsoft Graph (RNF-018). */
export const m365Adapter = defineRestAdapter({
  kind: "m365",
  label: "Microsoft 365",
  description: "Envío de correo y creación de eventos de calendario (p. ej. cita de la visita en el calendario del inspector) mediante Microsoft Graph.",
  configSchema: [{ key: "defaultUser", label: "Buzón por defecto", type: "string", help: "Usuario desde el que se envía si la acción no indica otro." }],
  pingPath: "/users?$top=1",
  actions: [
    {
      key: "send-mail", label: "Enviar correo", direction: "push",
      input: [{ key: "from", label: "Desde (buzón)", type: "string" }, { key: "to", label: "Para", type: "json", required: true }, { key: "subject", label: "Asunto", type: "string", required: true }, { key: "body", label: "Contenido", type: "text", required: true }, { key: "html", label: "Es HTML", type: "boolean" }],
      path: "/users/{from}/sendMail",
      body: (i) => {
        const to = recipients(i.to);
        if (to.length === 0) throw permanent("input_invalid", "No valid recipient");
        return { message: { subject: need(i, "subject"), body: { contentType: i.html ? "HTML" : "Text", content: need(i, "body") }, toRecipients: to }, saveToSentItems: true };
      },
      output: () => ({ accepted: true }),
    },
    {
      key: "create-event", label: "Crear evento de calendario", direction: "push",
      input: [{ key: "user", label: "Calendario de", type: "string", required: true }, { key: "subject", label: "Asunto", type: "string", required: true }, { key: "start", label: "Inicio", type: "string", required: true }, { key: "end", label: "Fin", type: "string", required: true }, { key: "location", label: "Lugar", type: "string" }, { key: "attendees", label: "Asistentes", type: "json" }],
      path: "/users/{user}/events", externalIdPath: "id",
      body: (i) => ({ subject: need(i, "subject"), start: { dateTime: need(i, "start"), timeZone: "Europe/Madrid" }, end: { dateTime: need(i, "end"), timeZone: "Europe/Madrid" }, location: { displayName: str(i.location) ?? "" }, attendees: recipients(i.attendees).map((r) => ({ ...r, type: "required" })) }),
    },
    { key: "list-users", label: "Listar usuarios", direction: "pull", input: [], path: "/users", output: (b) => asObj(b).value },
  ],
});

// Actions that default the mailbox from the connector settings.
const send = m365Adapter.actions.find((a) => a.key === "send-mail")!;
const inner = send.run;
send.run = (ctx, input) => inner(ctx, { ...input, from: str(input.from) ?? str(asObj(ctx.connector.config).defaultUser) ?? "" });
