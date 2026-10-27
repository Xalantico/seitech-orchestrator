import { registerEntity, type Column, type EntityDef } from "./query.js";

const t = (key: string, label: string, sql: string, extra: Partial<Column> = {}): Column => ({ key, label, sql, type: "text", ...extra });
const n = (key: string, label: string, sql: string, extra: Partial<Column> = {}): Column => ({ key, label, sql, type: "number", ...extra });
const d = (key: string, label: string, sql: string, extra: Partial<Column> = {}): Column => ({ key, label, sql, type: "date", ...extra });
const ts = (key: string, label: string, sql: string, extra: Partial<Column> = {}): Column => ({ key, label, sql, type: "timestamp", ...extra });
const b = (key: string, label: string, sql: string, extra: Partial<Column> = {}): Column => ({ key, label, sql, type: "bool", ...extra });
const e = (key: string, label: string, sql: string, options: readonly string[], extra: Partial<Column> = {}): Column => ({ key, label, sql, type: "enum", options, ...extra });
const id = (sql = "t.id::text"): Column => ({ key: "id", label: "Id", sql, type: "text", noFilter: true, hidden: true });

export const WORK_ORDER_STATES = ["created", "planned", "in_progress", "on_hold", "pending_validation", "validated", "closed", "cancelled"] as const;
export const VISIT_STATES = ["created", "scheduled", "in_progress", "incident", "completed", "cancelled"] as const;
export const ORDER_STATES = ["received", "validated", "in_progress", "completed", "invoiced", "cancelled"] as const;
export const NC_STATES = ["detected", "reported", "remediation", "verification", "escalated", "closed"] as const;
export const CERT_STATES = ["pending", "generated", "signing", "signed", "rejected", "distributed"] as const;
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const VISIT_RESULTS = ["favorable", "conditioned", "unfavorable", "rescheduled", "partial", "failed"] as const;

const WO_DONE = "('closed', 'cancelled')";
const VISIT_DONE = "('completed', 'cancelled')";

const scope = [
  t("delegation", "Delegación", "dg.name"),
  t("zone", "Zona", "zn.name"),
  t("project", "Proyecto", "pr.name"),
];
const scopeJoins = (alias = "t") => `LEFT JOIN delegations dg ON dg.id = ${alias}.delegation_id LEFT JOIN zones zn ON zn.id = ${alias}.zone_id LEFT JOIN projects pr ON pr.id = ${alias}.project_id`;

export const ENTITIES: EntityDef[] = [
  {
    key: "work_orders", label: "Órdenes de trabajo", permission: "work_orders:read", id: "id",
    from: `FROM work_orders t LEFT JOIN customers cu ON cu.id = t.customer_id LEFT JOIN sites si ON si.id = t.site_id LEFT JOIN technicians te ON te.id = t.technician_id ${scopeJoins()}`,
    columns: [
      id(),
      n("number", "Nº", "t.number"),
      e("status", "Estado", "t.status", WORK_ORDER_STATES),
      e("priority", "Prioridad", "t.priority", PRIORITIES),
      t("inspection_type", "Tipo de inspección", "t.inspection_type"),
      t("regulation", "Normativa", "t.regulation"),
      t("line", "Línea", "t.line"),
      t("area", "Área", "t.area"),
      t("customer", "Cliente", "cu.name"),
      t("site", "Instalación", "si.name"),
      t("municipality", "Municipio", "si.municipality"),
      t("technician", "Técnico", "te.name"),
      d("due_date", "Fecha límite", "t.due_date"),
      b("overdue", "Vencida", `(t.due_date < current_date AND t.status NOT IN ${WO_DONE})`),
      n("visits", "Visitas", "(SELECT count(*) FROM visits v WHERE v.work_order_id = t.id)"),
      t("external_ref", "Ref. externa", "t.external_ref"),
      ...scope,
      ts("created_at", "Creada", "t.created_at"),
      ts("updated_at", "Actualizada", "t.updated_at"),
    ],
    defaults: ["number", "status", "priority", "inspection_type", "customer", "site", "technician", "due_date", "delegation"],
    defaultSort: [{ key: "created_at", dir: "desc" }],
    search: ["customer", "site", "external_ref", "number"],
  },
  {
    key: "visits", label: "Visitas", permission: "visits:read", id: "id",
    from: `FROM visits t JOIN work_orders w ON w.id = t.work_order_id LEFT JOIN visit_types vt ON vt.id = t.visit_type_id LEFT JOIN technicians te ON te.id = t.technician_id LEFT JOIN customers cu ON cu.id = w.customer_id LEFT JOIN sites si ON si.id = w.site_id ${scopeJoins()}`,
    columns: [
      id(),
      n("number", "Nº", "t.number"),
      n("work_order", "OT", "w.number"),
      n("sequence", "Secuencia", "t.sequence"),
      e("status", "Estado", "t.status", VISIT_STATES),
      e("result", "Resultado", "t.result", VISIT_RESULTS),
      t("visit_type", "Tipo de visita", "vt.name"),
      t("inspection_type", "Tipo de inspección", "w.inspection_type"),
      t("technician", "Técnico", "te.name"),
      t("customer", "Cliente", "cu.name"),
      t("site", "Instalación", "si.name"),
      ts("scheduled_start", "Inicio previsto", "t.scheduled_start"),
      ts("scheduled_end", "Fin previsto", "t.scheduled_end"),
      ts("actual_start", "Inicio real", "t.actual_start"),
      ts("actual_end", "Fin real", "t.actual_end"),
      n("estimated_duration_min", "Duración estimada (min)", "t.estimated_duration_min"),
      d("legal_deadline", "Plazo legal", "t.legal_deadline"),
      b("overdue", "Fuera de plazo", `(t.legal_deadline < current_date AND t.status NOT IN ${VISIT_DONE})`),
      b("second_visit", "Segunda visita", "(t.parent_visit_id IS NOT NULL)"),
      t("incident_reason", "Motivo de incidencia", "t.incident_reason"),
      ...scope,
      ts("created_at", "Creada", "t.created_at"),
    ],
    defaults: ["number", "work_order", "status", "visit_type", "technician", "customer", "scheduled_start", "legal_deadline", "result", "delegation"],
    defaultSort: [{ key: "scheduled_start", dir: "asc" }],
    search: ["customer", "site", "technician", "number"],
  },
  {
    key: "orders", label: "Pedidos", permission: "orders:read", id: "id",
    from: `FROM orders t LEFT JOIN customers cu ON cu.id = t.customer_id LEFT JOIN sites si ON si.id = t.site_id ${scopeJoins()}`,
    columns: [
      id(), n("number", "Nº", "t.number"), e("status", "Estado", "t.status", ORDER_STATES), t("customer", "Cliente", "cu.name"), t("site", "Instalación", "si.name"),
      t("service_code", "Servicio", "t.service_code"), n("amount", "Importe", "t.amount"), t("source", "Origen", "t.source"), t("external_ref", "Ref. externa", "t.external_ref"),
      ...scope, ts("created_at", "Creado", "t.created_at"), ts("updated_at", "Actualizado", "t.updated_at"),
    ],
    defaults: ["number", "status", "customer", "service_code", "amount", "source", "created_at"],
    defaultSort: [{ key: "created_at", dir: "desc" }], search: ["customer", "external_ref", "number"],
  },
  {
    key: "nonconformities", label: "No conformidades", permission: "nonconformities:read", id: "id",
    from: `FROM nonconformities t JOIN work_orders w ON w.id = t.work_order_id LEFT JOIN customers cu ON cu.id = w.customer_id ${scopeJoins()}`,
    columns: [
      id(), n("number", "Nº", "t.number"), n("work_order", "OT", "w.number"), e("status", "Estado", "t.status", NC_STATES), t("customer", "Cliente", "cu.name"),
      d("remediation_deadline", "Plazo de subsanación", "t.remediation_deadline"),
      b("overdue", "Fuera de plazo", "(t.remediation_deadline < current_date AND t.status <> 'closed')"),
      ts("verified_at", "Verificada", "t.verified_at"), ...scope, ts("created_at", "Detectada", "t.created_at"),
    ],
    defaults: ["number", "work_order", "status", "customer", "remediation_deadline", "created_at"],
    defaultSort: [{ key: "created_at", dir: "desc" }], search: ["customer", "number"],
  },
  {
    key: "certificates", label: "Certificados", permission: "certificates:read", id: "id",
    from: `FROM certificates t JOIN work_orders w ON w.id = t.work_order_id LEFT JOIN customers cu ON cu.id = w.customer_id ${scopeJoins()}`,
    columns: [
      id(), t("number", "Nº", "t.number"), n("work_order", "OT", "w.number"), e("status", "Estado", "t.status", CERT_STATES), t("customer", "Cliente", "cu.name"),
      ts("issued_at", "Emitido", "t.issued_at"), d("retention_until", "Conservar hasta", "t.retention_until"), ...scope, ts("created_at", "Creado", "t.created_at"),
    ],
    defaults: ["number", "work_order", "status", "customer", "issued_at", "created_at"],
    defaultSort: [{ key: "created_at", dir: "desc" }], search: ["customer", "number"],
  },
  {
    key: "billing_lines", label: "Líneas de facturación", permission: "orders:read", id: "id",
    from: `FROM billing_lines t LEFT JOIN work_orders w ON w.id = t.work_order_id LEFT JOIN orders o ON o.id = t.order_id ${scopeJoins()}`,
    columns: [
      id(), t("description", "Descripción", "t.description"), n("work_order", "OT", "w.number"), n("order", "Pedido", "o.number"), n("quantity", "Cantidad", "t.quantity"),
      n("unit_price", "Precio", "t.unit_price"), n("amount", "Importe", "t.amount"), e("status", "Estado", "t.status", ["pending", "sent", "invoiced", "cancelled"]),
      b("recurring", "Recurrente", "t.recurring"), t("period", "Periodo", "t.period"), t("erp_ref", "Ref. ERP", "t.erp_ref"), ...scope, ts("created_at", "Creada", "t.created_at"),
    ],
    defaults: ["description", "work_order", "amount", "status", "period", "erp_ref", "created_at"],
    defaultSort: [{ key: "created_at", dir: "desc" }], search: ["description", "erp_ref"],
  },
  {
    key: "tasks", label: "Tareas", permission: "tasks:read", id: "id",
    from: `FROM tasks t LEFT JOIN queues q ON q.id = t.queue_id ${scopeJoins()}`,
    columns: [
      id(), n("number", "Nº", "t.number"), t("title", "Título", "t.title"), e("status", "Estado", "t.status", ["open", "in_progress", "resolved", "closed", "cancelled"]),
      e("priority", "Prioridad", "t.priority", PRIORITIES), t("queue", "Cola", "q.name"), t("queue_key", "Clave de cola", "q.key"), t("assignee", "Responsable", "t.assignee_email::text"),
      t("kind", "Tipo", "t.kind"), t("source", "Origen", "t.source"), t("entity_type", "Entidad", "t.entity_type"), ts("due_at", "Vence", "t.due_at"), ts("sla_due_at", "SLA", "t.sla_due_at"),
      b("sla_breached", "SLA incumplido", "(t.sla_due_at < now() AND t.status IN ('open', 'in_progress'))"),
      ts("resolved_at", "Resuelta", "t.resolved_at"), ...scope, ts("created_at", "Creada", "t.created_at"),
    ],
    defaults: ["number", "title", "status", "priority", "queue", "assignee", "sla_due_at", "created_at"],
    defaultSort: [{ key: "created_at", dir: "desc" }], search: ["title", "assignee", "number"],
  },
  {
    key: "executions", label: "Ejecuciones", permission: "executions:read", id: "id",
    from: `FROM executions t LEFT JOIN flows f ON f.id = t.flow_id ${scopeJoins()}`,
    columns: [
      id("t.id"), t("flow", "Flujo", "f.name"), t("flow_key", "Clave de flujo", "f.key"),
      e("status", "Estado", "t.status", ["running", "waiting", "completed", "failed", "cancelled", "timed_out"]),
      t("trigger_kind", "Origen", "t.trigger_kind"), b("simulated", "Simulada", "t.simulated"), t("entity_type", "Entidad", "t.entity_type"), t("error", "Error", "t.error_message"),
      ...scope, ts("created_at", "Inicio", "t.created_at"), ts("updated_at", "Actualización", "t.updated_at"),
    ],
    defaults: ["flow", "status", "trigger_kind", "entity_type", "created_at", "updated_at"],
    defaultSort: [{ key: "created_at", dir: "desc" }], search: ["flow", "id"],
  },
  {
    key: "messages", label: "Mensajes", permission: "messages:read", id: "id",
    from: "FROM messages t LEFT JOIN channels ch ON ch.id = t.channel_id LEFT JOIN delegations dg ON dg.id = t.delegation_id",
    columns: [
      id(), e("channel_kind", "Canal", "t.channel_kind", ["email", "sms", "whatsapp", "push", "internal"]), t("channel", "Canal configurado", "ch.name"), t("to", "Destinatario", "t.to_address"), t("subject", "Asunto", "t.subject"),
      e("status", "Estado", "t.status", ["queued", "sending", "sent", "delivered", "failed", "bounced"]), n("attempts", "Intentos", "t.attempts"), t("error", "Error", "t.error"),
      t("entity_type", "Entidad", "t.entity_type"), t("delegation", "Delegación", "dg.name"), ts("created_at", "Creado", "t.created_at"), ts("sent_at", "Enviado", "t.sent_at"),
    ],
    defaults: ["channel_kind", "to", "subject", "status", "attempts", "created_at", "sent_at"],
    defaultSort: [{ key: "created_at", dir: "desc" }], search: ["to", "subject"],
  },
  {
    key: "customers", label: "Clientes", permission: "customers:read", id: "id",
    from: `FROM customers t ${scopeJoins()}`,
    columns: [id(), t("code", "Código", "t.code"), t("name", "Nombre", "t.name"), t("address", "Dirección", "t.address"), b("consent_comms", "Consentimiento comunicaciones", "t.consent_comms"), ...scope, ts("created_at", "Alta", "t.created_at")],
    defaults: ["code", "name", "address", "consent_comms", "delegation"],
    defaultSort: [{ key: "name", dir: "asc" }], search: ["code", "name"],
  },
  {
    key: "technicians", label: "Técnicos", permission: "technicians:read", id: "id",
    from: `FROM technicians t ${scopeJoins()}`,
    columns: [
      id(), t("code", "Código", "t.code"), t("name", "Nombre", "t.name"), t("email", "Correo", "t.email::text"), b("active", "Activo", "t.active"),
      n("expiring_qualifications", "Habilitaciones por caducar", "(SELECT count(*) FROM qualifications q WHERE q.technician_id = t.id AND q.valid_to IS NOT NULL AND q.valid_to < current_date + 30 AND q.status <> 'revoked')"),
      ...scope,
    ],
    defaults: ["code", "name", "email", "active", "expiring_qualifications", "delegation"],
    defaultSort: [{ key: "name", dir: "asc" }], search: ["code", "name", "email"],
  },
  {
    key: "qualifications", label: "Habilitaciones", permission: "technicians:read", id: "id",
    from: `FROM qualifications t JOIN technicians te ON te.id = t.technician_id`,
    columns: [
      id(), t("technician", "Técnico", "te.name"), t("kind", "Tipo", "t.kind"), t("reference", "Referencia", "t.reference"), d("valid_to", "Válida hasta", "t.valid_to"),
      e("status", "Estado", "t.status", ["valid", "expiring", "expired", "revoked"]),
      n("days_left", "Días restantes", "(t.valid_to - current_date)"),
    ],
    defaults: ["technician", "kind", "reference", "valid_to", "status", "days_left"],
    defaultSort: [{ key: "valid_to", dir: "asc" }], search: ["technician", "kind", "reference"],
  },
];

for (const entity of ENTITIES) registerEntity(entity);
