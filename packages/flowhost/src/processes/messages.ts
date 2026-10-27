export type SeedTemplate = { key: string; name: string; channel: "email" | "sms" | "internal"; description: string; subject: string; text: string; html?: string };

const wrap = (title: string, body: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937"><h2 style="color:#0f4c81">${title}</h2>${body}<hr style="border:none;border-top:1px solid #e5e7eb"/><p style="font-size:12px;color:#6b7280">Mensaje automático del Orquestador. Si no desea recibir estas comunicaciones, responda indicándolo.</p></div>`;

/** Notification templates referenced by the seeded process templates. Administrators can publish new versions. */
export const SEED_TEMPLATES: SeedTemplate[] = [
  {
    key: "wo.planned", name: "OT planificada", channel: "email", description: "Aviso al cliente de que su inspección está planificada",
    subject: "Inspección {{entity.workOrderNumber}} planificada",
    text: "Hola {{entity.customerName}},\n\nHemos planificado la inspección de {{entity.siteName}} ({{entity.siteAddress}}). Le avisaremos con la fecha y hora de la visita.\n\nGracias.",
    html: wrap("Inspección planificada", "<p>Hola {{entity.customerName}},</p><p>Hemos planificado la inspección de <b>{{entity.siteName}}</b> ({{entity.siteAddress}}). Le avisaremos con la fecha y hora de la visita.</p>"),
  },
  {
    key: "visit.scheduled", name: "Visita programada", channel: "email", description: "Confirmación de fecha y hora de la visita",
    subject: "Visita programada: {{entity.scheduledStart}}",
    text: "Hola {{entity.customerName}},\n\nSu visita de inspección en {{entity.siteName}} está programada para {{entity.scheduledStart}}. Técnico: {{entity.technicianName}}.",
    html: wrap("Visita programada", "<p>Hola {{entity.customerName}},</p><p>Su visita en <b>{{entity.siteName}}</b> está programada para <b>{{entity.scheduledStart}}</b>.</p><p>Técnico: {{entity.technicianName}}</p>"),
  },
  {
    key: "visit.reminder", name: "Recordatorio de visita", channel: "email", description: "Recordatorio antes de la visita (ORF-020)",
    subject: "Recordatorio: visita el {{entity.scheduledStart}}",
    text: "Recordatorio: el {{entity.scheduledStart}} realizaremos la inspección en {{entity.siteName}}. Por favor, garantice el acceso a la instalación.",
    html: wrap("Recordatorio de visita", "<p>El <b>{{entity.scheduledStart}}</b> realizaremos la inspección en <b>{{entity.siteName}}</b>.</p><p>Por favor, garantice el acceso a la instalación.</p>"),
  },
  { key: "visit.reminder.sms", name: "Recordatorio de visita (SMS)", channel: "sms", description: "Recordatorio SMS", subject: "", text: "Recordatorio: inspeccion el {{entity.scheduledStart}} en {{entity.siteName}}. Garantice el acceso." },
  {
    key: "nc.notice", name: "Aviso de no conformidad", channel: "email", description: "Notificación al cliente de una no conformidad y su plazo de subsanación",
    subject: "No conformidad {{entity.number}} · {{entity.siteName}}",
    text: "Hola {{entity.customerName}},\n\nLa inspección ha detectado una no conformidad:\n{{entity.report}}\n\nPlazo de subsanación: {{entity.remediationDeadline}}.",
    html: wrap("No conformidad detectada", "<p>Hola {{entity.customerName}},</p><p>La inspección de <b>{{entity.siteName}}</b> ha detectado una no conformidad:</p><blockquote>{{entity.report}}</blockquote><p>Plazo de subsanación: <b>{{entity.remediationDeadline}}</b>.</p>"),
  },
  {
    key: "nc.escalated", name: "No conformidad escalada", channel: "internal", description: "Aviso interno de plazo de subsanación vencido",
    subject: "NC {{entity.number}} escalada", text: "La no conformidad {{entity.number}} de {{entity.customerName}} ({{entity.siteName}}) ha superado su plazo ({{entity.remediationDeadline}}) y se ha escalado.",
  },
  {
    key: "cert.ready", name: "Certificado disponible", channel: "email", description: "Entrega del certificado al cliente",
    subject: "Certificado de la inspección {{entity.workOrderNumber}}",
    text: "Hola {{entity.customerName}},\n\nYa está disponible el certificado de la inspección de {{entity.siteName}} (OT {{entity.workOrderNumber}}). Puede descargarlo desde el portal de clientes.",
    html: wrap("Certificado disponible", "<p>Hola {{entity.customerName}},</p><p>Ya está disponible el certificado de la inspección de <b>{{entity.siteName}}</b> (OT {{entity.workOrderNumber}}).</p><p>Puede descargarlo desde el portal de clientes.</p>"),
  },
  { key: "ops.alert", name: "Alerta interna", channel: "internal", description: "Aviso interno genérico a un rol", subject: "{{variables.alertTitle}}", text: "{{variables.alertText}}" },
];
