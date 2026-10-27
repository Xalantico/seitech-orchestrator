import { defineRestAdapter } from "../rest.js";

/**
 * Qualifications (Navision today, the FSM later) and equipment calibrations (Calibri, delivered through Navision).
 * Items reach the orchestrator through the mappings `navision.qualification` and `navision.calibration`, so the day
 * the FSM replaces Navision only the connector and its mapping change (ORF-063, ORF-064).
 */
export const navisionAdapter = defineRestAdapter({
  kind: "navision",
  label: "Navision (cualificaciones y calibraciones)",
  description: "Cualificaciones y certificaciones de técnicos (vigencias, renovaciones) y calibración de equipos (Calibri vía Navision).",
  pingPath: "/nav/qualifications?limit=1",
  actions: [
    {
      key: "request-renewal", label: "Solicitar renovación", direction: "push",
      description: "Pide a Navision que gestione la renovación de una cualificación que caduca.",
      input: [{ key: "employeeCode", label: "Código de empleado", type: "string", required: true }, { key: "qualification", label: "Cualificación", type: "string", required: true }, { key: "validTo", label: "Caduca el", type: "string" }],
      path: "/nav/renewals", externalIdPath: "id",
    },
    { key: "list-qualifications", label: "Listar cualificaciones", direction: "pull", input: [{ key: "updatedSince", label: "Modificadas desde", type: "string" }], path: "/nav/qualifications", query: (i) => ({ updatedSince: i.updatedSince ? String(i.updatedSince) : undefined }), output: (b) => (b as { items?: unknown }).items },
    { key: "list-calibrations", label: "Listar calibraciones", direction: "pull", input: [{ key: "updatedSince", label: "Modificadas desde", type: "string" }], path: "/nav/calibrations", query: (i) => ({ updatedSince: i.updatedSince ? String(i.updatedSince) : undefined }), output: (b) => (b as { items?: unknown }).items },
  ],
  feeds: [
    { path: "/nav/qualifications", eventType: "qualification.upsert", listPath: "items", idPath: "id", updatedPath: "updatedAt", cursorParam: "updatedSince", nextPath: "next" },
    { path: "/nav/calibrations", eventType: "calibration.upsert", listPath: "items", idPath: "id", updatedPath: "updatedAt", cursorParam: "updatedSince", nextPath: "next" },
  ],
});
