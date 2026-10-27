import { compileAggregate, compileQuery, getEntity, getKpi, KPIS, listEntities, QueryError, type Filter } from "@orchestrador/reporting";
import type pg from "pg";

import type { ToolSpec } from "./llm.js";

type Db = Pick<pg.PoolClient, "query">;

/** What the asking user may do. Tools run inside the caller's database session, so row-level security applies on top. */
export type ToolContext = { db: Db; permissions: ReadonlySet<string>; now?: Date };

const can = (ctx: ToolContext, permission: string) => ctx.permissions.has("system:admin") || ctx.permissions.has(permission);
const MAX_ROWS = 20;

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "get_kpi",
      description: "Current value of a dashboard indicator (open work orders, overdue visits, open nonconformities, pending certificates...). Call with no key to list the available indicators.",
      parameters: { type: "object", properties: { key: { type: "string", description: "Indicator key" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "query_records",
      description: `Read records of one entity (${listEntities().map((e) => e.key).join(", ")}). Read-only; returns at most ${MAX_ROWS} rows. Filter format: {field, op, value} or {op:"and"|"or", items:[...]}; ops: eq, neq, in, gt, gte, lt, lte, contains, null, notnull.`,
      parameters: {
        type: "object",
        required: ["entity"],
        properties: {
          entity: { type: "string" },
          filter: { type: "object" },
          columns: { type: "array", items: { type: "string" } },
          count_only: { type: "boolean" },
        },
      },
    },
  },
];

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export async function runTool(ctx: ToolContext, name: string, rawArgs: string | Record<string, unknown>): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = typeof rawArgs === "string" ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : rawArgs;
  } catch {
    return { ok: false, error: "Arguments are not valid JSON" };
  }
  try {
    if (name === "get_kpi") return await getKpiTool(ctx, typeof args.key === "string" ? args.key : undefined);
    if (name === "query_records") return await queryTool(ctx, args);
    return { ok: false, error: `Unknown tool "${name}"` };
  } catch (error) {
    if (error instanceof QueryError) return { ok: false, error: error.message };
    throw error;
  }
}

async function getKpiTool(ctx: ToolContext, key?: string): Promise<ToolResult> {
  const visible = KPIS.filter((k) => {
    const e = getEntity(k.entity);
    return e && can(ctx, e.permission);
  });
  if (!key) return { ok: true, data: visible.map((k) => ({ key: k.key, label: k.label })) };
  const kpi = getKpi(key);
  const entity = kpi && getEntity(kpi.entity);
  if (!kpi || !entity || !can(ctx, entity.permission)) return { ok: false, error: `Indicator "${key}" is not available` };
  const q = compileAggregate(entity, kpi.filter, kpi.aggregate, {}, ctx.now);
  const r = await ctx.db.query<{ value: number | null }>(q.sql, q.params);
  return { ok: true, data: { key: kpi.key, label: kpi.label, value: Number(r.rows[0]?.value ?? 0), unit: kpi.unit ?? "count" } };
}

async function queryTool(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const entity = typeof args.entity === "string" ? getEntity(args.entity) : undefined;
  if (!entity || !can(ctx, entity.permission)) return { ok: false, error: `Entity "${String(args.entity)}" is not available` };
  const filter = (args.filter && typeof args.filter === "object" ? args.filter : null) as Filter | null;
  if (args.count_only === true) {
    const q = compileAggregate(entity, filter, { fn: "count" }, {}, ctx.now);
    return { ok: true, data: { entity: entity.key, count: Number((await ctx.db.query<{ value: number }>(q.sql, q.params)).rows[0]?.value ?? 0) } };
  }
  const columns = Array.isArray(args.columns) ? args.columns.filter((c): c is string => typeof c === "string").slice(0, 12) : undefined;
  const compiled = compileQuery(entity, { filter, ...(columns?.length ? { columns } : {}), limit: MAX_ROWS }, ctx.now, { maxLimit: MAX_ROWS });
  const rows = (await ctx.db.query(compiled.select, compiled.params)).rows as Record<string, unknown>[];
  return { ok: true, data: { entity: entity.key, columns: compiled.columns.map((c) => c.key), rows } };
}
