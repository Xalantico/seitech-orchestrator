/**
 * Permission catalog (ORF-052). Keys are `<resource>:<action>`. The API enforces them with
 * `requirePermission`, the UI hides what the session cannot do, and `packages/db` seeds them.
 */
export type PermissionDef = { key: string; module: string; description: string };

function group(module: string, resource: string, actions: Record<string, string>): PermissionDef[] {
  return Object.entries(actions).map(([action, description]) => ({
    key: `${resource}:${action}`,
    module,
    description,
  }));
}

export const PERMISSIONS: readonly PermissionDef[] = [
  ...group("flows", "flows", {
    read: "View flows and versions",
    write: "Create and edit flow drafts",
    publish: "Publish flow versions",
    approve: "Approve or reject flow versions for publication",
    simulate: "Simulate flow execution",
  }),
  ...group("flows", "executions", {
    read: "View executions and timelines",
    run: "Start executions",
    cancel: "Cancel executions",
    resolve: "Resolve waiting nodes (approve, advance)",
  }),
  ...group("flows", "state_machines", { read: "View state machines", write: "Edit state machines" }),
  ...group("flows", "rules", { read: "View rule sets and parameters", write: "Edit rule sets and parameters" }),
  ...group("flows", "forms", { read: "View forms", write: "Edit forms" }),
  ...group("operations", "orders", { read: "View orders", write: "Create and edit orders" }),
  ...group("operations", "work_orders", {
    read: "View work orders",
    write: "Create and edit work orders",
    transition: "Advance work order state",
  }),
  ...group("operations", "visits", {
    read: "View visits",
    write: "Create and edit visits",
    transition: "Advance visit state",
    edit_duration: "Edit estimated visit duration",
  }),
  ...group("operations", "nonconformities", {
    read: "View nonconformities",
    write: "Create and edit nonconformities",
    transition: "Advance nonconformity state",
  }),
  ...group("operations", "certificates", {
    read: "View certificates",
    write: "Create and edit certificates",
    transition: "Advance certificate state",
  }),
  ...group("operations", "customers", {
    read: "View customers",
    write: "Create and edit customers",
    pii: "View customer personal data (requires MFA)",
  }),
  ...group("operations", "technicians", { read: "View technicians and qualifications", write: "Edit technicians" }),
  ...group("backoffice", "dashboard", { read: "View the monitoring dashboard" }),
  ...group("backoffice", "tasks", {
    read: "View tasks",
    write: "Create and edit tasks",
    claim: "Claim or assign tasks",
    act: "Run task actions (advance, complete form)",
  }),
  ...group("backoffice", "queues", { read: "View work queues", write: "Configure work queues" }),
  ...group("backoffice", "filters", { read: "Use saved filters", write: "Create and share saved filters" }),
  ...group("backoffice", "exports", { run: "Export data", schedule: "Schedule exports" }),
  ...group("backoffice", "alerts", { read: "View alerts", write: "Configure alert rules" }),
  ...group("comms", "channels", { read: "View channels", write: "Configure channels" }),
  ...group("comms", "templates", { read: "View templates", write: "Create and upload templates" }),
  ...group("comms", "messages", { read: "View sent messages", send: "Send messages manually" }),
  ...group("config", "users", { read: "View users", write: "Manage users" }),
  ...group("config", "roles", { read: "View roles", write: "Manage roles and permissions" }),
  ...group("config", "scopes", { read: "View delegations, zones and projects", write: "Manage delegations, zones and projects" }),
  ...group("config", "catalogs", { read: "View catalogs", write: "Edit catalogs and masters" }),
  ...group("config", "apikeys", { manage: "Manage API keys" }),
  ...group("integrations", "connectors", { read: "View connectors", write: "Configure connectors", sync: "Trigger synchronisation" }),
  ...group("integrations", "mappings", { read: "View data mappings", write: "Edit data mappings" }),
  ...group("integrations", "integration_errors", { read: "View integration errors", resolve: "Resolve integration errors" }),
  ...group("governance", "audit", { read: "Query the audit log", export: "Export audit data" }),
  ...group("governance", "documents", { read: "View documents", write: "Upload and manage documents", audit: "View document access log" }),
  ...group("governance", "gdpr", { manage: "Run GDPR export and erasure" }),
  ...group("governance", "usage", { read: "View licence usage report" }),
  ...group("assist", "copilot", { use: "Use the copilot" }),
  ...group("assist", "bi", { read: "Open BI dashboards" }),
  ...group("system", "system", { admin: "Full administration" }),
];

export const ALL_PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);

const readOnly = ALL_PERMISSION_KEYS.filter((k) => k.endsWith(":read"));

const gestor = [
  ...readOnly.filter((k) => !/^(users|roles|apikeys|audit|usage|connectors|mappings)/.test(k)),
  "flows:simulate",
  "executions:run",
  "executions:resolve",
  "orders:write",
  "work_orders:write",
  "work_orders:transition",
  "visits:write",
  "visits:transition",
  "visits:edit_duration",
  "nonconformities:write",
  "nonconformities:transition",
  "certificates:write",
  "certificates:transition",
  "customers:write",
  "technicians:write",
  "tasks:write",
  "tasks:claim",
  "tasks:act",
  "filters:write",
  "exports:run",
  "messages:send",
  "documents:write",
  "integration_errors:read",
  "integration_errors:resolve",
  "copilot:use",
];

export const DEFAULT_ROLES: readonly { key: string; name: string; description: string; permissions: readonly string[] }[] = [
  { key: "admin", name: "Admin", description: "Full administration", permissions: ALL_PERMISSION_KEYS },
  { key: "gestor", name: "Gestor", description: "Back-office manager", permissions: gestor },
  {
    key: "supervisor",
    name: "Supervisor",
    description: "Supervises operations, approves flows, reads audit",
    permissions: [
      ...gestor,
      "flows:approve",
      "flows:publish",
      "executions:cancel",
      "exports:schedule",
      "alerts:write",
      "queues:write",
      "audit:read",
      "audit:export",
      "documents:audit",
      "usage:read",
      "bi:read",
      "connectors:read",
      "mappings:read",
      "customers:pii",
    ],
  },
  {
    key: "tecnico",
    name: "Técnico",
    description: "Field inspector with limited back-office access",
    permissions: [
      "work_orders:read",
      "visits:read",
      "visits:transition",
      "tasks:read",
      "tasks:act",
      "technicians:read",
      "customers:read",
      "documents:read",
      "documents:write",
      "copilot:use",
    ],
  },
  {
    key: "comercial",
    name: "Comercial",
    description: "Sales: customers and orders",
    permissions: [
      "orders:read",
      "orders:write",
      "customers:read",
      "customers:write",
      "work_orders:read",
      "templates:read",
      "messages:read",
      "documents:read",
      "dashboard:read",
      "filters:read",
      "filters:write",
      "exports:run",
    ],
  },
];

/** Segregation of duties (RNF-28): a user may not hold both roles. */
export const TOXIC_ROLE_COMBINATIONS: readonly { a: string; b: string; reason: string }[] = [
  { a: "tecnico", b: "supervisor", reason: "Inspector cannot approve their own inspections" },
  { a: "comercial", b: "supervisor", reason: "Sales cannot approve flow changes or audit data" },
  { a: "tecnico", b: "admin", reason: "Field users must not hold administrator rights" },
];
