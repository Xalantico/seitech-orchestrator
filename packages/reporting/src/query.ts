/**
 * One filter language for everything that lists business data: tables, saved filters, dashboard drill-down,
 * exports, alert metrics. Fields are whitelisted per entity and every value travels as a bound parameter,
 * so a filter stored by a user can never inject SQL.
 */
export type ColType = "text" | "number" | "date" | "timestamp" | "bool" | "enum";

export type Column = {
  key: string;
  label: string;
  /** SQL expression (may use the entity's joined aliases). */
  sql: string;
  type: ColType;
  options?: readonly string[];
  /** Not offered in the filter builder (still selectable). */
  noFilter?: boolean;
  noSort?: boolean;
  /** Excluded from the default export column set. */
  hidden?: boolean;
};

export type EntityDef = {
  key: string;
  label: string;
  /** `FROM ...` clause with joins; the base table is aliased as `t`. */
  from: string;
  columns: readonly Column[];
  /** Key of the column holding the record id. */
  id: string;
  defaultSort: { key: string; dir: "asc" | "desc" }[];
  /** Columns searched by the free-text box. */
  search: readonly string[];
  /** Permission needed to list the entity. */
  permission: string;
  /** Default column keys shown in lists and exports. */
  defaults: readonly string[];
};

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}

export type Operator = "eq" | "neq" | "in" | "nin" | "gt" | "gte" | "lt" | "lte" | "contains" | "startsWith" | "between" | "null" | "notnull";
export const OPERATORS_BY_TYPE: Record<ColType, readonly Operator[]> = {
  text: ["eq", "neq", "in", "nin", "contains", "startsWith", "null", "notnull"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "null", "notnull"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "null", "notnull"],
  timestamp: ["gt", "gte", "lt", "lte", "between", "null", "notnull"],
  bool: ["eq"],
  enum: ["eq", "neq", "in", "nin", "null", "notnull"],
};

export type Condition = { field: string; op: Operator; value?: unknown; value2?: unknown };
export type FilterGroup = { op: "and" | "or"; items: Filter[] };
export type Filter = Condition | FilterGroup;
export type SortSpec = { key: string; dir?: "asc" | "desc" };

export type QuerySpec = {
  filter?: Filter | null;
  q?: string;
  sort?: SortSpec[];
  columns?: string[];
  limit?: number;
  offset?: number;
};

const registry = new Map<string, EntityDef>();
export const registerEntity = (def: EntityDef) => void registry.set(def.key, def);
export const getEntity = (key: string): EntityDef | undefined => registry.get(key);
export const listEntities = (): EntityDef[] => [...registry.values()];

const MAX_DEPTH = 6;
const MAX_CONDITIONS = 60;

/** Relative date tokens: today, +7d, -30d, startOfMonth, endOfMonth, startOfWeek, startOfYear. */
export function resolveDateToken(token: string, now: Date): string | null {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (token === "today") return day(base);
  const rel = /^([+-])(\d{1,4})([dwm])$/.exec(token);
  if (rel) {
    const n = Number(rel[2]) * (rel[1] === "-" ? -1 : 1);
    const d = new Date(base);
    if (rel[3] === "d") d.setUTCDate(d.getUTCDate() + n);
    else if (rel[3] === "w") d.setUTCDate(d.getUTCDate() + n * 7);
    else d.setUTCMonth(d.getUTCMonth() + n);
    return day(d);
  }
  if (token === "startOfMonth") return day(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1)));
  if (token === "endOfMonth") return day(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)));
  if (token === "startOfYear") return day(new Date(Date.UTC(base.getUTCFullYear(), 0, 1)));
  if (token === "startOfWeek") {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return day(d);
  }
  return null;
}

type Ctx = { entity: EntityDef; params: unknown[]; now: Date; count: number };

function bind(ctx: Ctx, col: Column, raw: unknown): string {
  let value = raw;
  if ((col.type === "date" || col.type === "timestamp") && typeof raw === "string") {
    const resolved = resolveDateToken(raw, ctx.now);
    if (resolved) value = resolved;
    else if (Number.isNaN(Date.parse(raw))) throw new QueryError(`"${raw}" is not a valid date for ${col.label}`);
  }
  if (col.type === "number") {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (raw === "" || raw === null || Number.isNaN(n)) throw new QueryError(`"${String(raw)}" is not a number (${col.label})`);
    value = n;
  }
  if (col.type === "bool") value = raw === true || raw === "true";
  if (col.type === "enum" && col.options && !col.options.includes(String(raw))) throw new QueryError(`"${String(raw)}" is not a valid ${col.label}`);
  ctx.params.push(value);
  const cast = col.type === "date" ? "::date" : col.type === "timestamp" ? "::timestamptz" : "";
  return `$${ctx.params.length}${cast}`;
}

function compileCondition(ctx: Ctx, c: Condition): string {
  if (++ctx.count > MAX_CONDITIONS) throw new QueryError("Too many conditions");
  const col = ctx.entity.columns.find((x) => x.key === c.field);
  if (!col || col.noFilter) throw new QueryError(`Unknown field "${c.field}" for ${ctx.entity.label}`);
  if (!OPERATORS_BY_TYPE[col.type].includes(c.op)) throw new QueryError(`"${c.op}" cannot be used on ${col.label}`);
  const sql = `(${col.sql})`;
  switch (c.op) {
    case "eq": return col.type === "bool" ? `${sql} IS ${c.value === true || c.value === "true" ? "TRUE" : "NOT TRUE"}` : `${sql} = ${bind(ctx, col, c.value)}`;
    case "neq": return `${sql} IS DISTINCT FROM ${bind(ctx, col, c.value)}`;
    case "gt": return `${sql} > ${bind(ctx, col, c.value)}`;
    case "gte": return `${sql} >= ${bind(ctx, col, c.value)}`;
    case "lt": return `${sql} < ${bind(ctx, col, c.value)}`;
    case "lte": return `${sql} <= ${bind(ctx, col, c.value)}`;
    case "between": return `${sql} BETWEEN ${bind(ctx, col, c.value)} AND ${bind(ctx, col, c.value2)}`;
    case "contains": {
      ctx.params.push(`%${String(c.value ?? "").replace(/[\\%_]/g, "\\$&")}%`);
      return `${sql} ILIKE $${ctx.params.length}`;
    }
    case "startsWith": {
      ctx.params.push(`${String(c.value ?? "").replace(/[\\%_]/g, "\\$&")}%`);
      return `${sql} ILIKE $${ctx.params.length}`;
    }
    case "in":
    case "nin": {
      const list = Array.isArray(c.value) ? c.value : typeof c.value === "string" ? c.value.split(",").map((s) => s.trim()).filter(Boolean) : [];
      if (list.length === 0) return c.op === "in" ? "FALSE" : "TRUE";
      if (list.length > 200) throw new QueryError("Too many values in the list");
      const marks = list.map((v) => bind(ctx, col, v));
      return `${sql} ${c.op === "nin" ? "NOT " : ""}IN (${marks.join(", ")})`;
    }
    case "null": return `${sql} IS NULL`;
    case "notnull": return `${sql} IS NOT NULL`;
  }
}

function compileFilter(ctx: Ctx, f: Filter, depth = 0): string {
  if (depth > MAX_DEPTH) throw new QueryError("Filter is nested too deeply");
  if ("items" in f) {
    if (f.op !== "and" && f.op !== "or") throw new QueryError(`Unknown group operator "${String((f as { op: unknown }).op)}"`);
    const parts = f.items.map((i) => compileFilter(ctx, i, depth + 1)).filter(Boolean);
    return parts.length === 0 ? "" : `(${parts.join(f.op === "and" ? " AND " : " OR ")})`;
  }
  if (typeof f !== "object" || f === null || typeof (f as Condition).field !== "string") throw new QueryError("Malformed filter");
  return compileCondition(ctx, f);
}

/** Lists show an exact total up to this many rows and "N+" beyond: counting millions of rows on every page view is what breaks response times. */
export const COUNT_CAP = 10_000;

export type Compiled = { select: string; count: string; countCapped: string; params: unknown[]; columns: Column[] };

/** Builds the list and count statements for an entity. Scope (RLS) is applied by the database session, not here. */
export function compileQuery(entity: EntityDef, spec: QuerySpec, now = new Date(), opts: { maxLimit?: number } = {}): Compiled {
  const ctx: Ctx = { entity, params: [], now, count: 0 };
  const where: string[] = [];
  if (spec.filter) {
    const w = compileFilter(ctx, spec.filter);
    if (w) where.push(w);
  }
  const q = spec.q?.trim();
  if (q && entity.search.length > 0) {
    ctx.params.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(${entity.search.map((k) => `(${entity.columns.find((c) => c.key === k)!.sql})::text ILIKE $${ctx.params.length}`).join(" OR ")})`);
  }
  const wanted = spec.columns && spec.columns.length > 0 ? spec.columns : [...entity.defaults];
  const columns = wanted.map((k) => {
    const col = entity.columns.find((c) => c.key === k);
    if (!col) throw new QueryError(`Unknown column "${k}" for ${entity.label}`);
    return col;
  });
  const idCol = entity.columns.find((c) => c.key === entity.id)!;
  const selectList = [`${idCol.sql} AS "${idCol.key}"`, ...columns.filter((c) => c.key !== idCol.key).map((c) => `${c.sql} AS "${c.key}"`)].join(", ");

  const sorts = (spec.sort && spec.sort.length > 0 ? spec.sort : entity.defaultSort).map((s) => {
    const col = entity.columns.find((c) => c.key === s.key);
    if (!col || col.noSort) throw new QueryError(`Cannot sort by "${s.key}"`);
    return `"${col.key}" ${s.dir === "asc" ? "ASC" : "DESC"} NULLS LAST`;
  });
  // Sort aliases need the select list; wrap so ORDER BY can reference output names and stay stable via the id.
  const limit = Math.min(Math.max(1, Math.floor(spec.limit ?? 50)), opts.maxLimit ?? 500);
  const offset = Math.max(0, Math.floor(spec.offset ?? 0));
  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const allCols = entity.columns.filter((c) => !columns.includes(c) && sorts.some((s) => s.startsWith(`"${c.key}"`)));
  const inner = [selectList, ...allCols.map((c) => `${c.sql} AS "${c.key}"`)].join(", ");
  return {
    select: `SELECT * FROM (SELECT ${inner} ${entity.from}${whereSql}) r ORDER BY ${sorts.join(", ")}, "${idCol.key}" LIMIT ${limit} OFFSET ${offset}`,
    count: `SELECT count(*)::int AS n ${entity.from}${whereSql}`,
    countCapped: `SELECT count(*)::int AS n FROM (SELECT 1 ${entity.from}${whereSql} LIMIT ${COUNT_CAP + 1}) q`,
    params: ctx.params,
    columns,
  };
}

/** Statement without paging, for exports (the caller streams or caps rows). */
export function compileExport(entity: EntityDef, spec: QuerySpec, maxRows: number, now = new Date()): Compiled {
  return compileQuery(entity, { ...spec, limit: maxRows, offset: 0 }, now, { maxLimit: maxRows });
}

/** Counts rows matching a filter (alerts, dashboard cards, drill-down badges). */
export function compileCount(entity: EntityDef, filter: Filter | null | undefined, now = new Date()): { sql: string; params: unknown[] } {
  const c = compileQuery(entity, { filter: filter ?? null, limit: 1 }, now);
  return { sql: c.count, params: c.params };
}

/** Structural validation without a database, for saved filters and API input. */
export function validateFilter(entity: EntityDef, filter: Filter | null | undefined): string | null {
  try {
    compileQuery(entity, { filter: filter ?? null, limit: 1 });
    return null;
  } catch (error) {
    return error instanceof QueryError ? error.message : "Invalid filter";
  }
}

export type Aggregate = { fn: "count" | "sum" | "avg" | "min" | "max"; column?: string };

/**
 * Aggregates over an entity with the same filter language, optionally grouped by one column (or by a day bucket
 * for date columns). Used by dashboards, KPIs and threshold alerts so numbers always match the drill-down list.
 */
export function compileAggregate(
  entity: EntityDef,
  filter: Filter | null | undefined,
  agg: Aggregate,
  opts: { groupBy?: string; bucket?: "day" | "week" | "month"; limit?: number } = {},
  now = new Date(),
): { sql: string; params: unknown[] } {
  const ctx: Ctx = { entity, params: [], now, count: 0 };
  const w = filter ? compileFilter(ctx, filter) : "";
  const whereSql = w ? ` WHERE ${w}` : "";
  const col = (key: string) => {
    const c = entity.columns.find((x) => x.key === key);
    if (!c) throw new QueryError(`Unknown column "${key}" for ${entity.label}`);
    return c;
  };
  let value = "count(*)::int";
  if (agg.fn !== "count") {
    if (!agg.column) throw new QueryError(`${agg.fn} needs a column`);
    const c = col(agg.column);
    if (c.type !== "number" && !(agg.fn === "min" || agg.fn === "max")) throw new QueryError(`${agg.fn} needs a numeric column`);
    value = `${agg.fn}((${c.sql}))::float8`;
  }
  if (!opts.groupBy) return { sql: `SELECT ${value} AS value ${entity.from}${whereSql}`, params: ctx.params };
  const g = col(opts.groupBy);
  const expr = (g.type === "date" || g.type === "timestamp") && opts.bucket ? `date_trunc('${opts.bucket}', ${g.sql})::date::text` : `(${g.sql})::text`;
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 1000);
  return { sql: `SELECT ${expr} AS key, ${value} AS value ${entity.from}${whereSql} GROUP BY 1 ORDER BY 1 LIMIT ${limit}`, params: ctx.params };
}
