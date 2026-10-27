import type { MappingField } from "@orchestrador/connector-sdk";

export type MappingDefault = { key: string; connectorKey: string; entity: string; direction: "inbound" | "outbound"; description: string; fields: MappingField[] };
export type ConnectorDefault = { key: string; name: string; kind: string; path: string; config: Record<string, unknown>; enabled?: boolean };

const nightly = { cron: "0 2 * * *", timezone: "Europe/Madrid", full: true };

/**
 * The connectors an installation starts with, each pointing at its simulator. Real deployments edit the base URL,
 * the credentials reference and `mode` in the connector screen; the mappings stay as the starting point.
 */
export const CONNECTOR_DEFAULTS: ConnectorDefault[] = [
  { key: "hubspot", name: "HubSpot CRM", kind: "hubspot", path: "/hubspot", config: { inbound: { "company.upsert": { mapping: "hubspot.customer", entity: "customer", passthroughExtra: true, passthroughFrom: "properties" }, "deal.won": { mapping: "hubspot.order", entity: "order", passthroughExtra: true, passthroughFrom: "properties" } }, sync: nightly } },
  { key: "business-central", name: "Business Central (ERP)", kind: "business-central", path: "/bc", config: { company: "SEITECH", inbound: { "salesOrder.upsert": { mapping: "bc.order", entity: "order", passthroughExtra: true }, "employee.upsert": { mapping: "bc.employee", entity: "technician", passthroughExtra: true } }, sync: nightly } },
  { key: "navision", name: "Navision · cualificaciones y calibraciones", kind: "navision", path: "/navision", config: { inbound: { "qualification.upsert": { mapping: "navision.qualification", entity: "qualification" }, "calibration.upsert": { mapping: "navision.calibration", entity: "calibration" } }, sync: nightly } },
  { key: "fsm-planner", name: "FSM-Planner (Optimiza)", kind: "fsm-planner", path: "/planner", config: { sync: { cron: "*/15 * * * *", timezone: "Europe/Madrid" } } },
  { key: "fsm-field", name: "FSM · herramienta de campo", kind: "fsm-field", path: "/field", config: {} },
  { key: "task", name: "TASK · partes de horas", kind: "task", path: "/task", config: {} },
  { key: "euroconect", name: "Euroconect · lotes", kind: "euroconect", path: "/euroconect", config: {} },
  { key: "eurocert", name: "Eurocert · certificados", kind: "eurocert", path: "/eurocert", config: {} },
  { key: "fsm-forms", name: "FSM · gestor de formularios", kind: "fsm-forms", path: "/forms/api", config: { sync: { cron: "*/30 * * * *", timezone: "Europe/Madrid" } } },
  { key: "signature", name: "Firma digital", kind: "esign", path: "/signature", config: {} },
  { key: "comms", name: "Gestor de comunicaciones", kind: "comms-manager", path: "/comms", config: {} },
  { key: "dms", name: "Gestor documental (SharePoint)", kind: "dms", path: "/dms/v1.0", config: { driver: "graph", drive: "drive-1", rootFolder: "/Orquestador" } },
  { key: "cae", name: "Plataforma CAE", kind: "cae", path: "/cae", config: { inspectingCompany: "Seitech Inspección, S.A." } },
  { key: "portal", name: "Portal de cliente", kind: "portal", path: "/portal", config: {} },
  { key: "m365", name: "Microsoft 365", kind: "m365", path: "/m365/v1.0", config: { defaultUser: "orquestador@example.com" } },
];

const text = (source: string, target: string, extra: Partial<MappingField> = {}): MappingField => ({ source, target, ...extra });

export const MAPPING_DEFAULTS: MappingDefault[] = [
  {
    key: "hubspot.customer", connectorKey: "hubspot", entity: "customer", direction: "inbound", description: "Empresa del CRM -> cliente. El CRM es el maestro de los datos del cliente.",
    fields: [
      text("id", "external_id", { transform: "string", required: true }), text("properties.name", "name", { transform: "trim", required: true }), text("properties.customer_code", "code", { transform: "trim" }),
      text("properties.address", "address"), text("properties.email", "email", { transform: "email" }), text("properties.phone", "phone", { transform: "phone" }), text("properties.cif", "tax_id", { transform: "upper" }),
      text("properties.delegation", "delegation_code"), text("properties.consent_comms", "consent_comms", { transform: "boolean" }),
    ],
  },
  {
    key: "hubspot.order", connectorKey: "hubspot", entity: "order", direction: "inbound", description: "Oportunidad ganada del CRM -> pedido de inspección.",
    fields: [
      text("id", "external_id", { transform: "string", required: true }), text("properties.company_id", "customer_external_id", { transform: "string" }), text("properties.service_code", "service_code", { transform: "upper" }),
      text("properties.amount", "amount", { transform: "number" }), text("properties.currency", "currency", { transform: "upper", default: "EUR" }), text("properties.delegation", "delegation_code"), text("properties.dealname", "extra.deal_name"),
    ],
  },
  {
    key: "bc.order", connectorKey: "business-central", entity: "order", direction: "inbound", description: "Pedido de venta del ERP -> pedido.",
    fields: [
      text("number", "external_id", { transform: "string", required: true }), text("number", "external_ref", { transform: "string" }), text("customerNumber", "customer_code", { transform: "trim" }),
      text("serviceCode", "service_code", { transform: "upper" }), text("totalAmountIncludingTax", "amount", { transform: "number" }), text("currencyCode", "currency", { transform: "upper", default: "EUR" }),
    ],
  },
  {
    key: "bc.employee", connectorKey: "business-central", entity: "technician", direction: "inbound", description: "Empleado del ERP -> técnico (activo o baja).",
    fields: [
      text("number", "external_id", { transform: "string", required: true }), text("number", "code", { transform: "string" }), text("displayName", "name", { transform: "trim", required: true }), text("email", "email", { transform: "email" }),
      text("status", "active", { transform: "lookup", options: { Active: true, Inactive: false, Terminated: false }, default: true }),
    ],
  },
  {
    key: "navision.qualification", connectorKey: "navision", entity: "qualification", direction: "inbound", description: "Cualificación de Navision -> cualificación del técnico (el estado de vigencia lo calcula el Orquestador).",
    fields: [text("employeeCode", "technician_code", { required: true }), text("kind", "kind", { required: true }), text("reference", "reference"), text("validFrom", "valid_from", { transform: "date" }), text("validTo", "valid_to", { transform: "date" }), text("status", "status", { transform: "lower" })],
  },
  {
    key: "navision.calibration", connectorKey: "navision", entity: "calibration", direction: "inbound", description: "Calibración de equipo (Calibri vía Navision) -> calibración.",
    fields: [text("equipmentCode", "equipment_code", { required: true }), text("name", "name"), text("calibratedAt", "calibrated_at", { transform: "date" }), text("validTo", "valid_to", { transform: "date" }), text("employeeCode", "technician_code")],
  },
  {
    key: "bc.invoice-line", connectorKey: "business-central", entity: "billing_line", direction: "outbound", description: "Línea de facturación del Orquestador -> línea de factura del ERP (para el nodo «Aplicar mapeo»).",
    fields: [text("description", "description", { required: true }), text("quantity", "quantity", { transform: "number", default: 1 }), text("price", "unitPrice", { transform: "number", required: true }), text("serviceCode", "itemNumber", { transform: "upper" })],
  },
];
