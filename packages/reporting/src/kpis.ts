import type { Aggregate, Filter } from "./query.js";

/**
 * Dashboard KPIs (ORF-033..037). Each KPI is a count or aggregate over one entity with a filter, so clicking it opens
 * the very same list (drill-down) with identical numbers. `tone` tells the UI how to colour a non-zero value.
 */
export type Kpi = {
  key: string;
  label: string;
  group: "operations" | "quality" | "backoffice" | "finance" | "platform" | "people";
  entity: string;
  filter: Filter | null;
  aggregate: Aggregate;
  tone: "neutral" | "good" | "warn" | "bad";
  unit?: "count" | "eur" | "min";
  /** Series for the trend chart: column to bucket by. */
  seriesBy?: string;
};

const and = (...items: Filter[]): Filter => ({ op: "and", items });
const c = (field: string, op: string, value?: unknown, value2?: unknown): Filter => ({ field, op, value, value2 }) as Filter;

const OPEN_WO = c("status", "nin", ["closed", "cancelled"]);
const OPEN_VISIT = c("status", "nin", ["completed", "cancelled"]);

export const KPIS: readonly Kpi[] = [
  { key: "wo_open", label: "OT abiertas", group: "operations", entity: "work_orders", filter: OPEN_WO, aggregate: { fn: "count" }, tone: "neutral", seriesBy: "created_at" },
  { key: "wo_overdue", label: "OT vencidas", group: "operations", entity: "work_orders", filter: and(OPEN_WO, c("overdue", "eq", true)), aggregate: { fn: "count" }, tone: "bad" },
  { key: "wo_unassigned", label: "OT sin técnico", group: "operations", entity: "work_orders", filter: and(OPEN_WO, c("technician", "null")), aggregate: { fn: "count" }, tone: "warn" },
  { key: "wo_urgent", label: "OT urgentes abiertas", group: "operations", entity: "work_orders", filter: and(OPEN_WO, c("priority", "eq", "urgent")), aggregate: { fn: "count" }, tone: "warn" },
  { key: "wo_pending_validation", label: "OT pendientes de validar", group: "operations", entity: "work_orders", filter: c("status", "eq", "pending_validation"), aggregate: { fn: "count" }, tone: "warn" },
  { key: "wo_closed_30d", label: "OT cerradas (30 días)", group: "operations", entity: "work_orders", filter: and(c("status", "eq", "closed"), c("updated_at", "gte", "-30d")), aggregate: { fn: "count" }, tone: "good", seriesBy: "updated_at" },
  { key: "visits_today", label: "Visitas hoy", group: "operations", entity: "visits", filter: and(c("scheduled_start", "gte", "today"), c("scheduled_start", "lt", "+1d")), aggregate: { fn: "count" }, tone: "neutral" },
  { key: "visits_week", label: "Visitas esta semana", group: "operations", entity: "visits", filter: and(c("scheduled_start", "gte", "startOfWeek"), c("scheduled_start", "lt", "+7d")), aggregate: { fn: "count" }, tone: "neutral", seriesBy: "scheduled_start" },
  { key: "visits_late", label: "Visitas fuera de plazo legal", group: "operations", entity: "visits", filter: and(OPEN_VISIT, c("overdue", "eq", true)), aggregate: { fn: "count" }, tone: "bad" },
  { key: "visits_incident", label: "Visitas con incidencia", group: "operations", entity: "visits", filter: c("status", "eq", "incident"), aggregate: { fn: "count" }, tone: "bad" },
  { key: "visits_second", label: "Segundas visitas (30 días)", group: "operations", entity: "visits", filter: and(c("second_visit", "eq", true), c("created_at", "gte", "-30d")), aggregate: { fn: "count" }, tone: "warn" },
  { key: "visit_avg_estimate", label: "Duración media estimada", group: "operations", entity: "visits", filter: c("estimated_duration_min", "notnull"), aggregate: { fn: "avg", column: "estimated_duration_min" }, tone: "neutral", unit: "min" },
  { key: "nc_open", label: "No conformidades abiertas", group: "quality", entity: "nonconformities", filter: c("status", "neq", "closed"), aggregate: { fn: "count" }, tone: "warn" },
  { key: "nc_overdue", label: "No conformidades fuera de plazo", group: "quality", entity: "nonconformities", filter: and(c("overdue", "eq", true)), aggregate: { fn: "count" }, tone: "bad" },
  { key: "nc_escalated", label: "No conformidades escaladas", group: "quality", entity: "nonconformities", filter: c("status", "eq", "escalated"), aggregate: { fn: "count" }, tone: "bad" },
  { key: "cert_pending", label: "Certificados pendientes", group: "quality", entity: "certificates", filter: c("status", "in", ["pending", "generated", "signing"]), aggregate: { fn: "count" }, tone: "warn" },
  { key: "cert_rejected", label: "Certificados rechazados", group: "quality", entity: "certificates", filter: c("status", "eq", "rejected"), aggregate: { fn: "count" }, tone: "bad" },
  { key: "tasks_open", label: "Tareas abiertas", group: "backoffice", entity: "tasks", filter: c("status", "in", ["open", "in_progress"]), aggregate: { fn: "count" }, tone: "neutral", seriesBy: "created_at" },
  { key: "tasks_unassigned", label: "Tareas sin asignar", group: "backoffice", entity: "tasks", filter: and(c("status", "in", ["open", "in_progress"]), c("assignee", "null")), aggregate: { fn: "count" }, tone: "warn" },
  { key: "tasks_sla_breached", label: "Tareas con SLA incumplido", group: "backoffice", entity: "tasks", filter: c("sla_breached", "eq", true), aggregate: { fn: "count" }, tone: "bad" },
  { key: "orders_new", label: "Pedidos sin validar", group: "backoffice", entity: "orders", filter: c("status", "eq", "received"), aggregate: { fn: "count" }, tone: "warn", seriesBy: "created_at" },
  { key: "billing_pending", label: "Pendiente de facturar", group: "finance", entity: "billing_lines", filter: c("status", "eq", "pending"), aggregate: { fn: "sum", column: "amount" }, tone: "neutral", unit: "eur" },
  { key: "billing_invoiced_month", label: "Facturado este mes", group: "finance", entity: "billing_lines", filter: and(c("status", "eq", "invoiced"), c("created_at", "gte", "startOfMonth")), aggregate: { fn: "sum", column: "amount" }, tone: "good", unit: "eur" },
  { key: "exec_running", label: "Ejecuciones en curso", group: "platform", entity: "executions", filter: c("status", "in", ["running", "waiting"]), aggregate: { fn: "count" }, tone: "neutral" },
  { key: "exec_failed_24h", label: "Ejecuciones fallidas (24 h)", group: "platform", entity: "executions", filter: and(c("status", "eq", "failed"), c("updated_at", "gte", "-1d")), aggregate: { fn: "count" }, tone: "bad" },
  { key: "qual_expiring", label: "Habilitaciones por caducar (30 días)", group: "people", entity: "qualifications", filter: and(c("valid_to", "lte", "+30d"), c("status", "neq", "revoked")), aggregate: { fn: "count" }, tone: "warn" },
];

export const getKpi = (key: string) => KPIS.find((k) => k.key === key);
