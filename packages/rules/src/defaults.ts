import type { StateMachineDef } from "./statemachine.js";

const notEmpty = (field: string) => ({ logic: { "!": { is_empty: [{ var: field }] } } });

/**
 * State machines every installation starts with (ORF-024..032). They are data: administrators publish new versions
 * to change them, and flows move entities with `state.transition`. The state keys of nonconformities and
 * certificates must stay inside the CHECK constraints of their tables.
 */
export const DEFAULT_STATE_MACHINES: Record<string, { key: string; name: string; definition: StateMachineDef }> = {
  order: {
    key: "order", name: "Pedido",
    definition: {
      entityType: "order", initial: "received",
      states: [
        { key: "received", label: "Recibido", category: "open" },
        { key: "validated", label: "Validado", category: "open" },
        { key: "in_progress", label: "En curso", category: "open" },
        { key: "completed", label: "Completado", category: "done" },
        { key: "invoiced", label: "Facturado", category: "done", final: true },
        { key: "cancelled", label: "Cancelado", category: "done", final: true },
      ],
      transitions: [
        { key: "validate", label: "Validar", from: "received", to: "validated" },
        { key: "start", label: "Iniciar", from: "validated", to: "in_progress" },
        { key: "complete", label: "Completar", from: "in_progress", to: "completed" },
        { key: "invoice", label: "Facturar", from: "completed", to: "invoiced" },
        { key: "cancel", label: "Cancelar", from: ["received", "validated", "in_progress"], to: "cancelled", requires: ["reason"] },
      ],
    },
  },
  work_order: {
    key: "work_order", name: "Orden de trabajo",
    definition: {
      entityType: "work_order", initial: "created",
      states: [
        { key: "created", label: "Creada", category: "open" },
        { key: "planned", label: "Planificada", category: "open" },
        { key: "in_progress", label: "En curso", category: "open" },
        { key: "on_hold", label: "En espera", category: "waiting" },
        { key: "pending_validation", label: "Pendiente de validación", category: "waiting" },
        { key: "validated", label: "Validada", category: "open" },
        { key: "closed", label: "Cerrada", category: "done", final: true },
        { key: "cancelled", label: "Cancelada", category: "done", final: true },
      ],
      transitions: [
        { key: "plan", label: "Planificar", from: ["created", "on_hold"], to: "planned", roles: ["gestor", "supervisor"] },
        { key: "start", label: "Iniciar", from: "planned", to: "in_progress" },
        { key: "hold", label: "Poner en espera", from: ["created", "planned", "in_progress"], to: "on_hold", requires: ["reason"] },
        { key: "resume", label: "Reanudar", from: "on_hold", to: "in_progress" },
        { key: "submit", label: "Enviar a validación", from: "in_progress", to: "pending_validation" },
        { key: "reject", label: "Devolver", from: "pending_validation", to: "in_progress", roles: ["supervisor"], requires: ["reason"] },
        { key: "validate", label: "Validar", from: "pending_validation", to: "validated", roles: ["supervisor"] },
        { key: "close", label: "Cerrar", from: "validated", to: "closed" },
        { key: "cancel", label: "Cancelar", from: ["created", "planned", "in_progress", "on_hold", "pending_validation"], to: "cancelled", roles: ["gestor", "supervisor"], requires: ["reason"] },
      ],
    },
  },
  visit: {
    key: "visit", name: "Visita",
    definition: {
      entityType: "visit", initial: "created",
      states: [
        { key: "created", label: "Creada", category: "open" },
        { key: "scheduled", label: "Programada", category: "open" },
        { key: "in_progress", label: "En curso", category: "open" },
        { key: "incident", label: "Con incidencia", category: "blocked" },
        { key: "completed", label: "Completada", category: "done", final: true },
        { key: "cancelled", label: "Cancelada", category: "done", final: true },
      ],
      transitions: [
        { key: "schedule", label: "Programar", from: "created", to: "scheduled", guard: notEmpty("entity.scheduled_start") },
        { key: "reschedule", label: "Reprogramar", from: ["scheduled", "incident"], to: "scheduled", guard: notEmpty("entity.scheduled_start") },
        { key: "start", label: "Iniciar", from: "scheduled", to: "in_progress" },
        { key: "report_incident", label: "Registrar incidencia", from: ["scheduled", "in_progress"], to: "incident", requires: ["reason"] },
        { key: "complete", label: "Completar", from: "in_progress", to: "completed" },
        { key: "cancel", label: "Cancelar", from: ["created", "scheduled", "incident"], to: "cancelled", requires: ["reason"] },
      ],
    },
  },
  nonconformity: {
    key: "nonconformity", name: "No conformidad",
    definition: {
      entityType: "nonconformity", initial: "detected",
      states: [
        { key: "detected", label: "Detectada", category: "open" },
        { key: "reported", label: "Notificada", category: "waiting" },
        { key: "remediation", label: "En subsanación", category: "waiting" },
        { key: "verification", label: "En verificación", category: "open" },
        { key: "escalated", label: "Escalada", category: "blocked" },
        { key: "closed", label: "Cerrada", category: "done", final: true },
      ],
      transitions: [
        { key: "report", label: "Notificar al cliente", from: "detected", to: "reported" },
        { key: "start_remediation", label: "Iniciar subsanación", from: "reported", to: "remediation" },
        { key: "verify", label: "Enviar a verificación", from: "remediation", to: "verification" },
        { key: "reopen", label: "Reabrir subsanación", from: "verification", to: "remediation", requires: ["reason"] },
        { key: "close", label: "Cerrar", from: "verification", to: "closed" },
        { key: "escalate", label: "Escalar", from: ["reported", "remediation", "verification"], to: "escalated" },
        { key: "resume", label: "Retomar", from: "escalated", to: "remediation", roles: ["supervisor"] },
      ],
    },
  },
  certificate: {
    key: "certificate", name: "Certificado",
    definition: {
      entityType: "certificate", initial: "pending",
      states: [
        { key: "pending", label: "Pendiente", category: "open" },
        { key: "generated", label: "Generado", category: "open" },
        { key: "signing", label: "En firma", category: "waiting" },
        { key: "signed", label: "Firmado", category: "open" },
        { key: "rejected", label: "Rechazado", category: "blocked" },
        { key: "distributed", label: "Distribuido", category: "done", final: true },
      ],
      transitions: [
        { key: "generate", label: "Generar", from: ["pending", "rejected"], to: "generated" },
        { key: "send_to_sign", label: "Enviar a firma", from: "generated", to: "signing" },
        { key: "sign", label: "Firmar", from: "signing", to: "signed" },
        { key: "reject", label: "Rechazar", from: ["generated", "signing"], to: "rejected", requires: ["reason"] },
        { key: "distribute", label: "Distribuir", from: "signed", to: "distributed" },
      ],
    },
  },
};
