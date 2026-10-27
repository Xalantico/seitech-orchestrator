import { compileQuery, getEntity, type Filter } from "@orchestrador/reporting";
import { interpolateString } from "@orchestrador/shared";

import { env } from "../env.js";
import { renderJson, renderString, templateOf } from "./template.js";
import { asRecord, PermanentNodeError, type ExecutorRegistry } from "./types.js";



const PARTY = `
  c.id AS customer_id, c.name AS customer_name, c.code AS customer_code, c.consent_comms,
  pgp_sym_decrypt(c.email_enc, $2) AS customer_email, pgp_sym_decrypt(c.phone_enc, $2) AS customer_phone,
  s.id AS site_id, s.name AS site_name, s.address AS site_address, s.municipality, s.autonomous_community,
  t.id AS technician_id, t.name AS technician_name, t.email::text AS technician_email`;
const PARTY_JOINS = (wo: string) => `LEFT JOIN customers c ON c.id = ${wo}.customer_id LEFT JOIN sites s ON s.id = ${wo}.site_id LEFT JOIN technicians t ON t.id = ${wo}.technician_id`;

/** One SELECT per entity type; every one ends with the customer, site and technician so templates can address people uniformly. */
const LOADERS: Record<string, string> = {
  work_order: `SELECT w.id, w.number, w.status, w.priority, w.inspection_type, w.regulation, w.line, w.area, w.due_date, w.order_id, w.external_ref, w.delegation_id, w.extra, w.id AS work_order_id, w.number AS work_order_number, ${PARTY}
               FROM work_orders w ${PARTY_JOINS("w")} WHERE w.id = $1`,
  visit: `SELECT v.id, v.number, v.status, v.result, v.sequence, v.scheduled_start, v.scheduled_end, v.actual_start, v.actual_end, v.legal_deadline, v.estimated_duration_min, v.incident_reason, v.parent_visit_id,
                 v.delegation_id, v.extra, w.id AS work_order_id, w.number AS work_order_number, w.inspection_type, w.regulation, w.priority, vt.name AS visit_type, ${PARTY}
          FROM visits v JOIN work_orders w ON w.id = v.work_order_id LEFT JOIN visit_types vt ON vt.id = v.visit_type_id
          LEFT JOIN customers c ON c.id = w.customer_id LEFT JOIN sites s ON s.id = w.site_id LEFT JOIN technicians t ON t.id = coalesce(v.technician_id, w.technician_id) WHERE v.id = $1`,
  nonconformity: `SELECT n.id, n.number, n.status, n.report, n.remediation_deadline, n.verified_at, n.visit_id, n.delegation_id, n.extra, w.id AS work_order_id, w.number AS work_order_number, w.inspection_type, w.regulation, ${PARTY}
                  FROM nonconformities n JOIN work_orders w ON w.id = n.work_order_id ${PARTY_JOINS("w")} WHERE n.id = $1`,
  certificate: `SELECT k.id, k.number, k.status, k.document_id, k.signed_document_id, k.issued_at, k.retention_until, k.delegation_id, k.extra, w.id AS work_order_id, w.number AS work_order_number, w.inspection_type, w.regulation, ${PARTY}
                FROM certificates k JOIN work_orders w ON w.id = k.work_order_id ${PARTY_JOINS("w")} WHERE k.id = $1`,
  order: `SELECT o.id, o.number, o.status, o.service_code, o.amount, o.currency, o.source, o.external_ref, o.delegation_id, o.extra, ${PARTY.replace("t.id AS technician_id, t.name AS technician_name, t.email::text AS technician_email", "NULL::uuid AS technician_id, NULL::text AS technician_name, NULL::text AS technician_email")}
          FROM orders o LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN sites s ON s.id = o.site_id WHERE o.id = $1`,
};

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const plain = (v: unknown): unknown => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  return v;
};

export const loadExecutors: ExecutorRegistry = {
  "data.load-entity": {
    async run(node, ctx, deps) {
      const cfg = asRecord(node.config);
      const type = renderString(ctx, cfg.entityType).trim() || ctx.entity?.type || "";
      const id = renderString(ctx, cfg.id).trim() || (ctx.entity?.type === type ? ctx.entity.id : "") || "";
      const sql = LOADERS[type];
      if (!sql) throw new PermanentNodeError("entity_not_loadable", `Cannot load entities of type "${type}"`);
      if (!id) throw new PermanentNodeError("entity_missing", "Launch the flow with an entity or provide its id");
      const row = await deps.sys(async (db) => (await db.query<Record<string, unknown>>(sql, [id, env.piiKey])).rows[0]);
      if (!row) throw new PermanentNodeError("entity_not_found", `${type} ${id} was not found`);
      const entity: Record<string, unknown> = { type, ...Object.fromEntries(Object.entries(row).filter(([k]) => k !== "extra").map(([k, v]) => [camel(k), plain(v)])), extra: row.extra ?? {} };
      entity.id = id;
      if (type === "visit" && typeof entity.scheduledStart === "string") {
        // Reminder instants (ORF-020): empty when already in the past, so a flow can skip a stale reminder.
        const leads = await deps.sys(async (db) => (await db.query<{ value: unknown }>("SELECT value FROM parameters WHERE key = 'reminder_lead_hours' AND delegation_id IS NULL")).rows[0]?.value);
        const hours = (Array.isArray(leads) ? leads : [48, 24]).map(Number).filter((n) => n > 0).sort((a, b) => b - a);
        hours.slice(0, 2).forEach((h, i) => {
          const at = new Date(Date.parse(entity.scheduledStart as string) - h * 3_600_000);
          entity[`reminderAt${i + 1}`] = at.getTime() > Date.now() ? at.toISOString() : "";
          entity[`reminderLead${i + 1}`] = h;
        });
      }
      // The email/phone are only exposed to the flow, never written to the execution timeline.
      return { output: { type, id, number: entity.number ?? null, status: entity.status ?? null }, setVariables: { entity } };
    },
  },

  "data.query": {
    async run(node, ctx, deps) {
      const cfg = asRecord(node.config);
      const def = getEntity(String(cfg.entity ?? ""));
      if (!def) throw new PermanentNodeError("entity_unknown", `Unknown entity "${String(cfg.entity)}"`);
      const filter = renderJson(ctx, cfg.filter, null) as Filter | null;
      let compiled;
      try {
        compiled = compileQuery(def, { filter, columns: def.columns.filter((c) => !c.hidden).map((c) => c.key), limit: Number(cfg.limit ?? 100) || 100, sort: undefined }, new Date());
      } catch (error) {
        throw new PermanentNodeError("query_invalid", error instanceof Error ? error.message : "Invalid query");
      }
      const rows = await deps.sys(async (db) => (await db.query<Record<string, unknown>>(compiled.select, compiled.params)).rows);
      const clean = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? (v.toISOString().endsWith("T00:00:00.000Z") ? v.toISOString().slice(0, 10) : v.toISOString()) : plain(v)])));
      const template = String(cfg.lineTemplate ?? "").trim();
      const lines = clean.map((row) => (template ? interpolateString(template, { ...templateOf(ctx), entity: row }) : Object.values(row).filter((v) => v !== null && v !== undefined).join(" · ")));
      const name = String(cfg.variable || "query").replace(/[^\w]/g, "_");
      const result = { count: clean.length, rows: clean, lines, text: lines.join("\n") };
      return { output: { count: result.count, lines }, setVariables: { [name]: result } };
    },
  },
};
