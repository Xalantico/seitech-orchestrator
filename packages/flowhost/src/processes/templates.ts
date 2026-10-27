import { FlowBuilder } from "./builder.js";

export type ProcessTemplate = {
  key: string;
  name: string;
  description: string;
  tags: string[];
  diagram: unknown;
  /** Rows for `flow_triggers` (kind + config). */
  triggers: { kind: "event" | "schedule" | "entity_transition"; config: Record<string, unknown> }[];
};

const MADRID = "Europe/Madrid";
const rule = (when: unknown, port = "true") => ({ kind: "rules", mode: "first", rules: [{ id: "r1", name: "Regla", when: { logic: when }, then: { port } }], default: { port: port === "true" ? "false" : "true" } });
const cont = { errorPolicy: "continue" } as const;

// ───────────────────────────── inspections (ORF-001..012) ─────────────────────────────

type InspectionOptions = {
  key: string;
  name: string;
  description: string;
  regulation: string;
  tags: string[];
  /** One validator, or the high-voltage four-eyes check. */
  validation: "single" | "double";
  approverRole: string;
  /** How long the process waits for the visit result before alerting the back office. */
  visitWait: string;
  notes: string;
};

/**
 * Plan → visit → result → technical validation → certificate → close. The same skeleton serves every regulation;
 * what changes is the validation rigour and the waiting times, which administrators edit per delegation.
 */
function inspectionProcess(o: InspectionOptions): ProcessTemplate {
  const b = new FlowBuilder().start();
  b.node("load", "data.load-entity", "Cargar OT", {})
    .node("notify_planned", "comm.notify", "Avisar al cliente", { channel: "email", to: "{{entity.customerEmail}}", templateKey: "wo.planned", ...cont })
    .node("wait_visit", "flow.wait-event", "Esperar resultado de visita", { eventName: "visit.result", correlation: "{{entity.id}}", timeout: o.visitWait, breachAfter: o.visitWait })
    .node("stale_task", "human.user-task", "OT sin resultado", { title: "OT {{entity.number}} sin resultado de visita", instructions: `La inspección (${o.regulation}) no ha recibido resultado en ${o.visitWait}. Revise la planificación o la herramienta de campo.`, queue: "backoffice", priority: "high", dueIn: "2d" })
    .node("start_wo", "state.transition", "OT en curso", { entityType: "work_order", to: "in_progress", ...cont })
    .node("route", "flow.switch", "Según resultado", { value: "{{nodes.wait_visit.result}}", case1: "favorable", case2: "conditioned", case3: "unfavorable", case4: "partial" })
    .node("alert_supervisor", "comm.notify", "Avisar a supervisión", { channel: "internal", to: "role:supervisor", templateKey: "ops.alert", variables: { alertTitle: "Resultado {{nodes.wait_visit.result}} en OT {{entity.number}}", alertText: `Inspección ${o.regulation} con resultado no favorable en {{entity.siteName}}. Valore segunda visita.` }, ...cont })
    .node("submit", "state.transition", "Enviar a validación", { entityType: "work_order", to: "pending_validation" })
    .node("validate_task", "human.approval", "Validación técnica", {
      title: "Validar inspección {{entity.number}} ({{entity.siteName}})", instructions: o.notes, queue: "validacion-tecnica", approverRole: o.approverRole,
      secondValidation: o.validation === "double", priority: o.validation === "double" ? "high" : "medium", dueIn: "2d", warnAfter: "1d", breachAfter: "2d",
    })
    .node("validate", "state.transition", "Validar OT", { entityType: "work_order", to: "validated" })
    .node("wait_cert", "flow.wait-event", "Esperar certificado", { eventName: "certificate.distributed", correlation: "{{entity.id}}", timeout: "30d" })
    .node("cert_stale", "human.user-task", "Certificado pendiente", { title: "OT {{entity.number}}: certificado sin distribuir", queue: "certificacion", priority: "high", dueIn: "2d" })
    .node("close", "state.transition", "Cerrar OT", { entityType: "work_order", to: "closed" })
    .node("reject", "state.transition", "Devolver OT", { entityType: "work_order", transition: "reject", to: "in_progress", payload: { reason: "Devuelta en la validación técnica" } })
    .node("rework_task", "human.user-task", "Corregir inspección", { title: "Corregir inspección {{entity.number}}", instructions: "El validador ha devuelto la inspección. Corrija el informe y reenvíe a validación.", queue: "backoffice", priority: "high", dueIn: "3d" })
    .end("end_ok", "OT cerrada", "completed", "Inspección completada y certificada")
    .end("end_stale", "Sin resultado", "completed", "Escalada a back-office por falta de resultado")
    .end("end_rework", "Devuelta", "completed", "Devuelta para corrección")
    .end("end_cert", "Certificado pendiente", "completed", "Escalada por certificado sin distribuir");
  b.chain("trigger", "load", "notify_planned", "wait_visit");
  b.link("wait_visit", "start_wo", "received").link("wait_visit", "stale_task", "timeout").link("stale_task", "end_stale", "done").link("stale_task", "end_stale", "rejected").link("stale_task", "end_stale", "timeout");
  b.link("start_wo", "route");
  b.link("route", "submit", "c5").link("route", "submit", "c1").link("route", "alert_supervisor", "c2").link("route", "alert_supervisor", "c3").link("route", "alert_supervisor", "c4").link("route", "submit", "default");
  b.link("alert_supervisor", "submit").link("submit", "validate_task");
  b.link("validate_task", "validate", "approved").link("validate_task", "reject", "rejected").link("validate_task", "reject", "timeout");
  b.link("validate", "wait_cert").link("wait_cert", "close", "received").link("wait_cert", "cert_stale", "timeout").link("cert_stale", "end_cert", "done").link("cert_stale", "end_cert", "rejected").link("cert_stale", "end_cert", "timeout");
  b.link("close", "end_ok");
  b.link("reject", "rework_task").link("rework_task", "end_rework", "done").link("rework_task", "end_rework", "rejected").link("rework_task", "end_rework", "timeout");
  return {
    key: o.key, name: o.name, description: o.description, tags: ["inspección", ...o.tags], diagram: b.build(o.name),
    triggers: [{ kind: "event", config: { event: "work_order.planned", filter: { "==": [{ var: "event.regulation" }, o.regulation] } } }],
  };
}

// ───────────────────────────── nonconformity (ORF-012, ORF-024) ─────────────────────────────

function nonconformity(): ProcessTemplate {
  const name = "No conformidad: aviso, subsanación y verificación";
  const b = new FlowBuilder().start();
  b.node("load", "data.load-entity", "Cargar no conformidad", {})
    .node("report", "state.transition", "Marcar como notificada", { entityType: "nonconformity", to: "reported", ...cont })
    .node("notify", "comm.notify", "Avisar al cliente", { channel: "email", to: "{{entity.customerEmail}}", templateKey: "nc.notice", priority: 5, ...cont })
    .node("wait_verification", "flow.wait-event", "Esperar subsanación", { eventName: "nonconformity.verification", correlation: "{{entity.id}}", timeout: "30d", warnAfter: "20d", breachAfter: "30d" })
    .node("verify", "human.approval", "Verificar subsanación", { title: "Verificar subsanación de la NC {{entity.number}}", instructions: "Compruebe la evidencia aportada por el cliente. Apruebe si la no conformidad queda resuelta.", queue: "no-conformidades", approverRole: "supervisor", dueIn: "5d", warnAfter: "3d", breachAfter: "5d" })
    .node("close_nc", "state.transition", "Cerrar no conformidad", { entityType: "nonconformity", to: "closed" })
    .node("reopen", "state.transition", "Reabrir subsanación", { entityType: "nonconformity", transition: "reopen", to: "remediation", payload: { reason: "Subsanación no aceptada" } })
    .node("escalate", "state.transition", "Escalar", { entityType: "nonconformity", to: "escalated", ...cont })
    .node("alert", "comm.notify", "Avisar a supervisión", { channel: "internal", to: "role:supervisor", templateKey: "nc.escalated", priority: 8, ...cont })
    .node("escalate_task", "human.user-task", "Gestionar NC escalada", { title: "NC {{entity.number}} escalada: plazo vencido", instructions: "El plazo de subsanación ha vencido. Contacte con el cliente y decida los siguientes pasos.", queue: "no-conformidades", priority: "high", dueIn: "2d" })
    .end("end_closed", "NC cerrada", "completed", "No conformidad resuelta")
    .end("end_reopened", "NC reabierta", "completed", "Subsanación rechazada; la NC vuelve a subsanación")
    .end("end_escalated", "NC escalada", "completed", "Plazo vencido y escalada");
  b.chain("trigger", "load", "report", "notify", "wait_verification");
  b.link("wait_verification", "verify", "received").link("wait_verification", "escalate", "timeout");
  b.link("verify", "close_nc", "approved").link("verify", "reopen", "rejected").link("verify", "reopen", "timeout");
  b.link("close_nc", "end_closed").link("reopen", "end_reopened");
  b.chain("escalate", "alert", "escalate_task");
  b.link("escalate_task", "end_escalated", "done").link("escalate_task", "end_escalated", "rejected").link("escalate_task", "end_escalated", "timeout");
  return { key: "nonconformity-handling", name, description: "Notifica la no conformidad al cliente, espera la subsanación dentro del plazo, la verifica o la escala.", tags: ["no conformidad"], diagram: b.build(name), triggers: [{ kind: "event", config: { event: "nc.detected" } }] };
}

// ───────────────────────────── certification (ORF-033..036) ─────────────────────────────

function certification(): ProcessTemplate {
  const name = "Certificación: generación, firma y distribución";
  const cert = { entityType: "certificate", id: "{{variables.created.id}}" };
  const b = new FlowBuilder().start();
  b.node("load_wo", "data.load-entity", "Cargar OT", {})
    .node("create_cert", "data.entity-create", "Crear certificado", { entity: "certificates", fields: { number: "CERT-{{entity.number}}" }, variable: "created" })
    .node("load_cert", "data.load-entity", "Cargar certificado", { entityType: "certificate", id: "{{variables.created.id}}" })
    .node("generate", "state.transition", "Generado", { ...cert, to: "generated" })
    .node("send_sign", "state.transition", "Enviado a firma", { ...cert, to: "signing" })
    .node("sign_approval", "human.approval", "Firma del certificado", { title: "Firmar certificado {{entity.number}} (OT {{entity.workOrderNumber}})", instructions: "Revise el certificado generado y fírmelo. Si hay errores, rechácelo indicando el motivo.", queue: "certificacion", approverRole: "director_tecnico", priority: "high", dueIn: "2d", warnAfter: "1d", breachAfter: "2d" })
    .node("sign", "state.transition", "Firmado", { ...cert, to: "signed" })
    .node("notify", "comm.notify", "Entregar al cliente", { channel: "email", to: "{{entity.customerEmail}}", templateKey: "cert.ready", priority: 3, ...cont })
    .node("distribute", "state.transition", "Distribuido", { ...cert, to: "distributed" })
    .node("reject_cert", "state.transition", "Rechazado", { ...cert, to: "rejected", payload: { reason: "Rechazado en la firma" } })
    .node("regen_task", "human.user-task", "Regenerar certificado", { title: "Regenerar el certificado {{entity.number}}", instructions: "La firma fue rechazada. Corrija los datos y vuelva a generarlo.", queue: "certificacion", priority: "high", dueIn: "2d" })
    .end("end_ok", "Certificado distribuido", "completed")
    .end("end_rejected", "Certificado rechazado", "completed", "Rechazado en la firma");
  b.chain("trigger", "load_wo", "create_cert", "load_cert", "generate", "send_sign", "sign_approval");
  b.link("sign_approval", "sign", "approved").link("sign_approval", "reject_cert", "rejected").link("sign_approval", "reject_cert", "timeout");
  b.chain("sign", "notify", "distribute", "end_ok");
  b.link("reject_cert", "regen_task").link("regen_task", "end_rejected", "done").link("regen_task", "end_rejected", "rejected").link("regen_task", "end_rejected", "timeout");
  return { key: "certification", name, description: "Crea el certificado de una OT validada, lo envía a firma, lo entrega al cliente y avisa al proceso de inspección.", tags: ["certificado"], diagram: b.build(name), triggers: [{ kind: "event", config: { event: "work_order.validated" } }] };
}

// ───────────────────────────── billing (ORF-037..038) ─────────────────────────────

function billing(): ProcessTemplate {
  const name = "Facturación al cerrar la OT";
  const b = new FlowBuilder().start();
  b.node("load", "data.load-entity", "Cargar OT", {})
    .node("price", "flow.decision-table", "Tarifa por normativa", {
      definition: {
        kind: "decision_table", hitPolicy: "first",
        inputs: [{ key: "regulation", path: "entity.regulation" }], outputs: [{ key: "unitPrice" }],
        rows: [
          { id: "lifts", when: { regulation: "RD-203-2021" }, then: { unitPrice: 85 } },
          { id: "lv", when: { regulation: "REBT-RD-842-2002" }, then: { unitPrice: 120 } },
          { id: "hv", when: { regulation: "RAT-RD-223-2008" }, then: { unitPrice: 450 } },
        ],
        default: { unitPrice: 100 },
      },
    })
    .node("line", "data.entity-create", "Crear línea de facturación", { entity: "billing_lines", fields: { description: "Inspección {{entity.inspectionType}} · OT {{entity.number}} · {{entity.siteName}}", quantity: 1, unit_price: "{{variables.unitPrice}}" }, variable: "billingLine" })
    .end("end", "Línea creada", "completed", "Pendiente de envío al ERP");
  b.link("trigger", "load").link("load", "price").link("price", "line", "true").link("price", "line", "false").link("line", "end");
  return { key: "billing-on-close", name, description: "Al cerrar una OT crea la línea de facturación con la tarifa de su normativa (tabla de decisión editable).", tags: ["facturación"], diagram: b.build(name), triggers: [{ kind: "event", config: { event: "work_order.closed" } }] };
}

// ───────────────────────────── reminders (ORF-020) ─────────────────────────────

function reminders(): ProcessTemplate {
  const name = "Recordatorios de visita al cliente";
  const unchanged = rule({ and: [{ "==": [{ var: "entity.status" }, "scheduled"] }, { "==": [{ var: "entity.scheduledStart" }, { var: "variables.originalStart" }] }] });
  const b = new FlowBuilder().start();
  b.node("load", "data.load-entity", "Cargar visita", {})
    .node("remember", "flow.set-variable", "Recordar fecha", { name: "originalStart", value: "{{entity.scheduledStart}}" })
    .node("confirm", "comm.notify", "Confirmar visita", { channel: "email", to: "{{entity.customerEmail}}", templateKey: "visit.scheduled", ...cont });
  for (const n of [1, 2]) {
    b.node(`has${n}`, "flow.condition", `¿Recordatorio ${n} pendiente?`, { left: `{{entity.reminderAt${n}}}`, operator: "truthy", right: "" })
      .node(`wait${n}`, "flow.timer", `Esperar recordatorio ${n}`, { until: `{{entity.reminderAt${n}}}` })
      .node(`reload${n}`, "data.load-entity", "Recargar visita", {})
      .node(`same${n}`, "flow.rule", "¿Visita sin cambios?", { definition: unchanged })
      .node(`mail${n}`, "comm.notify", `Recordatorio ${n} (correo)`, { channel: "email", to: "{{entity.customerEmail}}", templateKey: "visit.reminder", ...cont })
      .node(`sms${n}`, "comm.notify", `Recordatorio ${n} (SMS)`, { channel: "sms", to: "{{entity.customerPhone}}", templateKey: "visit.reminder.sms", ...cont });
  }
  b.end("end", "Recordatorios enviados", "completed").end("end_stale", "Visita cambiada o cancelada", "completed", "La visita cambió; el nuevo programa tiene sus propios recordatorios");
  b.chain("trigger", "load", "remember", "confirm", "has1");
  b.link("has1", "wait1", "true").link("has1", "has2", "false").chain("wait1", "reload1", "same1");
  b.link("same1", "mail1", "true").link("same1", "end_stale", "false").chain("mail1", "sms1").link("sms1", "has2");
  b.link("has2", "wait2", "true").link("has2", "end", "false").chain("wait2", "reload2", "same2");
  b.link("same2", "mail2", "true").link("same2", "end_stale", "false").chain("mail2", "sms2", "end");
  return { key: "visit-reminders", name, description: "Confirma la visita y envía recordatorios por correo y SMS (horas configurables en el parámetro reminder_lead_hours); no avisa si la visita cambió.", tags: ["recordatorio", "cliente"], diagram: b.build(name), triggers: [{ kind: "event", config: { event: "visit.scheduled" } }] };
}

// ───────────────────────────── escalation, reassignment, QA, qualifications ─────────────────────────────

function escalation(): ProcessTemplate {
  const name = "Escalado de tareas con SLA incumplido";
  const b = new FlowBuilder().start();
  b.node("find", "data.query", "Tareas con SLA incumplido", {
    entity: "tasks", variable: "breached", limit: 50,
    filter: { op: "and", items: [{ field: "sla_breached", op: "eq", value: true }, { field: "priority", op: "neq", value: "low" }] },
    lineTemplate: "#{{entity.number}} {{entity.title}} · cola {{entity.queue}} · {{entity.assignee}}",
  })
    .node("any", "flow.condition", "¿Hay tareas?", { left: "{{variables.breached.count}}", operator: "gt", right: "0" })
    .node("digest", "comm.notify", "Avisar a supervisión", { channel: "internal", to: "role:supervisor", templateKey: "ops.alert", priority: 8, variables: { alertTitle: "SLA incumplido: {{variables.breached.count}} tareas", alertText: "{{variables.breached.text}}" } })
    .end("end", "Escalado enviado", "completed").end("end_none", "Sin incumplimientos", "completed");
  b.link("trigger", "find").link("find", "any").link("any", "digest", "true").link("any", "end_none", "false").link("digest", "end");
  return { key: "sla-escalation", name, description: "Tres veces al día avisa a supervisión de las tareas cuyo SLA ha vencido.", tags: ["escalado", "SLA"], diagram: b.build(name), triggers: [{ kind: "schedule", config: { cron: "0 8,12,16 * * 1-5", timezone: MADRID } }] };
}

function reassignment(): ProcessTemplate {
  const name = "Reasignación de visitas por baja de técnico";
  const b = new FlowBuilder().start();
  b.node("find", "data.query", "Visitas pendientes del técnico", {
    entity: "visits", variable: "pending", limit: 200,
    filter: { op: "and", items: [{ field: "technician", op: "eq", value: "{{trigger.payload.technicianName}}" }, { field: "status", op: "in", value: ["created", "scheduled"] }] },
    lineTemplate: "Visita {{entity.number}} · OT {{entity.work_order}} · {{entity.customer}} · {{entity.scheduled_start}}",
  })
    .node("any", "flow.condition", "¿Hay visitas?", { left: "{{variables.pending.count}}", operator: "gt", right: "0" })
    .node("reassign", "human.subtask", "Reasignar visitas", { title: "Reasignar visita", items: "{{variables.pending.lines}}", queue: "planificacion", priority: "high", warnAfter: "4h", breachAfter: "1d" })
    .node("done", "comm.notify", "Avisar de que está hecho", { channel: "internal", to: "role:supervisor", templateKey: "ops.alert", variables: { alertTitle: "Visitas reasignadas", alertText: "Se han reasignado {{variables.pending.count}} visitas de {{trigger.payload.technicianName}}." } })
    .end("end", "Visitas reasignadas", "completed").end("end_none", "Sin visitas pendientes", "completed").end("end_late", "Reasignación caducada", "failed", "Subtareas sin cerrar");
  b.link("trigger", "find").link("find", "any").link("any", "reassign", "true").link("any", "end_none", "false");
  b.link("reassign", "done", "done").link("reassign", "end_late", "timeout").link("done", "end");
  return { key: "visit-reassignment", name, description: "Cuando un técnico queda no disponible crea una subtarea por cada visita pendiente suya.", tags: ["planificación"], diagram: b.build(name), triggers: [{ kind: "event", config: { event: "technician.unavailable" } }] };
}

function qaSampling(): ProcessTemplate {
  const name = "Muestreo de control de calidad";
  const b = new FlowBuilder().start();
  b.node("load", "data.load-entity", "Cargar OT", {})
    .node("sample", "flow.rule", "¿Entra en la muestra?", { definition: rule({ sample: [{ var: "entity.id" }, 5] }) })
    .node("review", "human.user-task", "Revisión de calidad", { title: "Revisión de calidad de la OT {{entity.number}}", instructions: "Revise el informe y las fotos de la inspección ({{entity.regulation}}). Registre cualquier desviación.", queue: "calidad", priority: "medium", dueIn: "5d", warnAfter: "3d", breachAfter: "5d" })
    .end("end", "Revisión hecha", "completed").end("end_skip", "Fuera de la muestra", "completed");
  b.link("trigger", "load").link("load", "sample").link("sample", "review", "true").link("sample", "end_skip", "false");
  b.link("review", "end", "done").link("review", "end", "rejected").link("review", "end", "timeout");
  return { key: "qa-sampling", name, description: "Selecciona de forma determinista el 5 % de las OT validadas para una revisión de calidad.", tags: ["calidad"], diagram: b.build(name), triggers: [{ kind: "event", config: { event: "work_order.validated" } }] };
}

function qualificationAlerts(): ProcessTemplate {
  const name = "Alertas de habilitaciones de técnicos";
  const b = new FlowBuilder().start();
  b.node("find", "data.query", "Habilitaciones que vencen", {
    entity: "qualifications", variable: "expiring", limit: 100,
    filter: { op: "and", items: [{ field: "status", op: "neq", value: "revoked" }, { op: "or", items: [{ field: "valid_to", op: "eq", value: "+30d" }, { field: "valid_to", op: "eq", value: "+7d" }, { field: "valid_to", op: "eq", value: "-1d" }] }] },
    lineTemplate: "{{entity.technician}} · {{entity.kind}} {{entity.reference}} · vence {{entity.valid_to}} ({{entity.days_left}} días)",
  })
    .node("any", "flow.condition", "¿Hay alertas?", { left: "{{variables.expiring.count}}", operator: "gt", right: "0" })
    .node("renew", "human.subtask", "Renovar habilitaciones", { title: "Renovar habilitación", items: "{{variables.expiring.lines}}", queue: "planificacion", priority: "medium", warnAfter: "7d", breachAfter: "14d" })
    .end("end", "Alertas gestionadas", "completed").end("end_none", "Sin alertas", "completed").end("end_late", "Renovaciones caducadas", "failed", "Subtareas sin cerrar");
  b.link("trigger", "find").link("find", "any").link("any", "renew", "true").link("any", "end_none", "false").link("renew", "end", "done").link("renew", "end_late", "timeout");
  return { key: "qualification-alerts", name, description: "Cada día laborable crea subtareas para las habilitaciones que vencen en 30 o 7 días o han vencido ayer.", tags: ["técnicos", "alertas"], diagram: b.build(name), triggers: [{ kind: "schedule", config: { cron: "0 7 * * 1-5", timezone: MADRID } }] };
}

export const PROCESS_TEMPLATES: ProcessTemplate[] = [
  inspectionProcess({
    key: "inspection-lifts-rd203", name: "Inspección de ascensores · RD 203/2021", regulation: "RD-203-2021", tags: ["ascensores", "RD 203/2021"], validation: "single", approverRole: "supervisor", visitWait: "60d",
    description: "Inspección periódica de aparatos elevadores: plan, visita, validación técnica, certificado y cierre.",
    notes: "Compruebe el informe, los defectos y el resultado de la visita (RD 203/2021).",
  }),
  inspectionProcess({
    key: "inspection-lv-rebt", name: "Inspección de baja tensión · REBT", regulation: "REBT-RD-842-2002", tags: ["baja tensión", "REBT"], validation: "single", approverRole: "supervisor", visitWait: "45d",
    description: "Inspección de instalaciones eléctricas de baja tensión con validación técnica.",
    notes: "Compruebe el informe, las medidas y la clasificación de defectos (REBT RD 842/2002).",
  }),
  inspectionProcess({
    key: "inspection-hv-rat", name: "Inspección de alta tensión · RAT (doble validación)", regulation: "RAT-RD-223-2008", tags: ["alta tensión", "RAT"], validation: "double", approverRole: "director_tecnico", visitWait: "45d",
    description: "Inspección de alta tensión: la validación técnica exige una segunda persona distinta (cuatro ojos).",
    notes: "Alta tensión (RAT RD 223/2008): dos personas distintas deben validar el informe antes del certificado.",
  }),
  nonconformity(),
  certification(),
  billing(),
  reminders(),
  escalation(),
  reassignment(),
  qaSampling(),
  qualificationAlerts(),
];
