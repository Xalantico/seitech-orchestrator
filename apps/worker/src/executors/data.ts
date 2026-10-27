import { renderJson, renderString } from "./template.js";
import { asRecord, PermanentNodeError, type ExecutorRegistry } from "./types.js";

/** Columns a flow may change per table. Anything else is rejected (flows never write arbitrary SQL). */
const WRITABLE: Record<string, { columns: Record<string, "text" | "int" | "numeric" | "date" | "timestamptz" | "uuid" | "jsonb" | "bool">; entityType: string }> = {
  orders: { entityType: "order", columns: { status: "text", amount: "numeric", service_code: "text", external_ref: "text", extra: "jsonb" } },
  work_orders: { entityType: "work_order", columns: { status: "text", priority: "text", technician_id: "uuid", due_date: "date", line: "text", area: "text", extra: "jsonb" } },
  visits: {
    entityType: "visit",
    columns: { status: "text", result: "text", technician_id: "uuid", scheduled_start: "timestamptz", scheduled_end: "timestamptz", legal_deadline: "date", incident_reason: "text", estimated_duration_min: "int", extra: "jsonb" },
  },
  nonconformities: { entityType: "nonconformity", columns: { status: "text", report: "text", remediation_deadline: "date", extra: "jsonb" } },
  certificates: { entityType: "certificate", columns: { status: "text", number: "text", extra: "jsonb" } },
  billing_lines: { entityType: "billing_line", columns: { status: "text", quantity: "numeric", unit_price: "numeric", erp_ref: "text", extra: "jsonb" } },
};

type ColumnType = "text" | "int" | "numeric" | "date" | "timestamptz" | "uuid" | "jsonb" | "bool";

/** Tables a flow may insert into. The row inherits delegation/zone/project from its work order. */
const CREATABLE: Record<string, { entityType: string; columns: Record<string, ColumnType> }> = {
  certificates: { entityType: "certificate", columns: { number: "text", retention_until: "date" } },
  billing_lines: { entityType: "billing_line", columns: { order_id: "uuid", description: "text", quantity: "numeric", unit_price: "numeric", recurring: "bool", period: "text" } },
  nonconformities: { entityType: "nonconformity", columns: { visit_id: "uuid", report: "text", remediation_deadline: "date" } },
};

const sqlType = (t: ColumnType) => (t === "bool" ? "boolean" : t);

export const dataExecutors: ExecutorRegistry = {
  "data.entity-create": {
    sideEffects: true,
    simulate: (node) => ({ output: { simulated: true, entity: String(asRecord(node.config).entity ?? ""), id: "00000000-0000-0000-0000-000000000000" } }),
    async run(node, ctx, deps) {
      const cfg = asRecord(node.config);
      const table = renderString(ctx, cfg.entity);
      const spec = CREATABLE[table];
      if (!spec) throw new PermanentNodeError("entity_not_creatable", `Entity "${table}" cannot be created by a flow`);
      const workOrderId = renderString(ctx, cfg.workOrderId).trim() || (ctx.entity?.type === "work_order" ? ctx.entity.id : "");
      if (!workOrderId) throw new PermanentNodeError("work_order_missing", "Set the work order id (or launch the flow with a work order)");
      const fields = asRecord(renderJson(ctx, cfg.fields, {}));
      const key = `${ctx.executionId}:${node.id}`;
      const params: unknown[] = [workOrderId];
      const columns: string[] = [];
      const values: string[] = [];
      for (const [column, value] of Object.entries(fields)) {
        const type = spec.columns[column];
        if (!type) throw new PermanentNodeError("column_not_writable", `Column "${column}" of ${table} cannot be set by a flow`);
        if (value === undefined || value === null || value === "") continue;
        params.push(value);
        columns.push(column);
        values.push(`$${params.length}::${sqlType(spec.columns[column]!)}`);
      }
      params.push(JSON.stringify({ createdByNode: key, createdByExecution: ctx.executionId }));
      columns.push("work_order_id", "delegation_id", "zone_id", "project_id", "extra");
      values.push("wo.id", "wo.delegation_id", "wo.zone_id", "wo.project_id", `$${params.length}::jsonb`);
      // Idempotent under activity retries: one row per (execution, node).
      const id = await deps.sys(async (db) => {
        const found = await db.query<{ id: string }>(`SELECT id FROM ${table} WHERE extra->>'createdByNode' = $1 LIMIT 1`, [key]);
        if (found.rows[0]) return found.rows[0].id;
        const row = await db.query<{ id: string }>(
          `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${values.join(", ")} FROM work_orders wo WHERE wo.id = $1::uuid RETURNING id`,
          params,
        );
        if (!row.rows[0]) throw new PermanentNodeError("work_order_not_found", `Work order ${workOrderId} was not found`);
        return row.rows[0].id;
      });
      const variable = renderString(ctx, cfg.variable).trim() || "created";
      return { output: { id, entity: table }, setVariables: { [variable]: { id, entity: table } } };
    },
  },

  "data.entity-update": {
    sideEffects: true,
    simulate: (node) => ({ output: { simulated: true, entity: String(asRecord(node.config).entity ?? "") } }),
    async run(node, ctx, deps) {
      const cfg = asRecord(node.config);
      const table = renderString(ctx, cfg.entity);
      const spec = WRITABLE[table];
      if (!spec) throw new PermanentNodeError("entity_not_writable", `Entity "${table}" cannot be updated by a flow`);
      const id = renderString(ctx, cfg.id).trim() || (ctx.entity && ctx.entity.type === spec.entityType ? ctx.entity.id : "");
      if (!id) throw new PermanentNodeError("entity_missing", `No ${spec.entityType} to update: launch the flow with that entity or set the id`);
      const fields = asRecord(renderJson(ctx, cfg.fields, {}));
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [column, value] of Object.entries(fields)) {
        const type = spec.columns[column];
        if (!type) throw new PermanentNodeError("column_not_writable", `Column "${column}" of ${table} cannot be updated by a flow`);
        if (column === "extra") {
          params.push(JSON.stringify(value ?? {}));
          sets.push(`extra = extra || $${params.length}::jsonb`);
          continue;
        }
        params.push(type === "jsonb" ? JSON.stringify(value) : value);
        sets.push(`${column} = $${params.length}${type === "jsonb" ? "::jsonb" : type === "text" ? "" : `::${type === "bool" ? "boolean" : type}`}`);
      }
      if (sets.length === 0) throw new PermanentNodeError("no_fields", "No fields to update");
      const row = await deps.sys(async (db) => {
        const before = fields.status !== undefined ? (await db.query<{ status: string }>(`SELECT status FROM ${table} WHERE id = $1`, [id])).rows[0] : undefined;
        const r = await db.query<{ id: string }>(`UPDATE ${table} SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING id`, params);
        if (r.rows[0] && fields.status !== undefined) {
          await db.query(
            `INSERT INTO entity_state_history (entity_type, entity_id, from_state, to_state, actor, execution_id, reason)
             VALUES ($1, $2, $3, $4, 'flow', $5, $6)`,
            [spec.entityType, id, before?.status ?? null, String(fields.status), ctx.executionId, `node ${node.id}`],
          );
        }
        return r.rows[0];
      });
      if (!row) throw new PermanentNodeError("entity_not_found", `${spec.entityType} ${id} was not found`);
      return { output: { id, updated: Object.keys(fields) } };
    },
  },
};
