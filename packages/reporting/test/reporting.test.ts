import { createPool, migrate } from "@orchestrador/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COUNT_CAP, ENTITIES, KPIS, compileAggregate, compileQuery, getEntity, listEntities, OPERATORS_BY_TYPE, QueryError, renderCsv, renderExport, resolveDateToken, validateFilter, type Column, type Filter } from "../src/index.js";

const wo = getEntity("work_orders")!;
const NOW = new Date("2026-03-18T10:00:00Z"); // a Wednesday

describe("bounded totals", () => {
  it("counts at most COUNT_CAP + 1 rows so a list page never scans the whole table", () => {
    const c = compileQuery(wo, { filter: { field: "status", op: "eq", value: "closed" } }, NOW);
    expect(c.countCapped).toContain(`LIMIT ${COUNT_CAP + 1}`);
    expect(c.countCapped).toMatch(/^SELECT count\(\*\)::int AS n FROM \(SELECT 1 /);
    expect(c.count).not.toContain("LIMIT"); // exports and alerts still use the exact count
  });
});

describe("filter compiler", () => {
  it("binds every value and never interpolates user text", () => {
    const c = compileQuery(wo, { filter: { op: "and", items: [{ field: "status", op: "in", value: ["planned", "in_progress"] }, { field: "customer", op: "contains", value: "x'; DROP TABLE work_orders;--" }] } }, NOW);
    expect(c.select).not.toContain("DROP");
    expect(c.params).toEqual(["planned", "in_progress", "%x'; DROP TABLE work\\_orders;--%"]);
    expect(c.select).toMatch(/LIMIT 50 OFFSET 0$/);
  });
  it("escapes LIKE wildcards and resolves relative dates", () => {
    expect(compileQuery(wo, { filter: { field: "customer", op: "startsWith", value: "100%_" } }, NOW).params).toEqual(["100\\%\\_%"]);
    const c = compileQuery(wo, { filter: { field: "due_date", op: "between", value: "today", value2: "+14d" } }, NOW);
    expect(c.params).toEqual(["2026-03-18", "2026-04-01"]);
    expect([resolveDateToken("startOfWeek", NOW), resolveDateToken("startOfMonth", NOW), resolveDateToken("-1m", NOW), resolveDateToken("nope", NOW)]).toEqual(["2026-03-16", "2026-03-01", "2026-02-18", null]);
  });
  it("rejects unknown fields, operators that do not fit the type, bad enums and numbers", () => {
    expect(() => compileQuery(wo, { filter: { field: "password", op: "eq", value: "x" } })).toThrow(QueryError);
    expect(() => compileQuery(wo, { filter: { field: "status", op: "contains", value: "x" } })).toThrow(/cannot be used/);
    expect(() => compileQuery(wo, { filter: { field: "status", op: "eq", value: "bogus" } })).toThrow(/not a valid/);
    expect(() => compileQuery(wo, { filter: { field: "number", op: "gt", value: "abc" } })).toThrow(/not a number/);
    expect(() => compileQuery(wo, { filter: { field: "due_date", op: "eq", value: "tomorrowish" } })).toThrow(/not a valid date/);
    expect(() => compileQuery(wo, { sort: [{ key: "id; DROP" }] })).toThrow(/Cannot sort/);
    expect(() => compileQuery(wo, { columns: ["nope"] })).toThrow(/Unknown column/);
    expect(validateFilter(wo, { field: "status", op: "eq", value: "planned" })).toBeNull();
    expect(validateFilter(wo, { field: "zzz", op: "eq", value: 1 })).toMatch(/Unknown field/);
  });
  it("limits depth, size and paging", () => {
    let f: Filter = { field: "status", op: "eq", value: "planned" };
    for (let i = 0; i < 10; i += 1) f = { op: "and", items: [f] };
    expect(() => compileQuery(wo, { filter: f })).toThrow(/nested too deeply/);
    expect(() => compileQuery(wo, { filter: { op: "or", items: Array.from({ length: 70 }, () => ({ field: "status", op: "eq", value: "planned" }) as Filter) } })).toThrow(/Too many conditions/);
    expect(compileQuery(wo, { limit: 99999, offset: -5 }).select).toMatch(/LIMIT 500 OFFSET 0$/);
    expect(compileQuery(wo, { filter: { field: "status", op: "in", value: [] } }).select).toContain("FALSE");
  });
  it("every column type declares at least one operator and every entity has a unique id and valid defaults", () => {
    for (const ops of Object.values(OPERATORS_BY_TYPE)) expect(ops.length).toBeGreaterThan(0);
    for (const e of ENTITIES) {
      const keys = e.columns.map((c) => c.key);
      expect(new Set(keys).size, e.key).toBe(keys.length);
      expect(keys, e.key).toContain(e.id);
      for (const k of [...e.defaults, ...e.search, ...e.defaultSort.map((s) => s.key)]) expect(keys, `${e.key}.${k}`).toContain(k);
    }
  });
});

describe("export rendering", () => {
  const columns: Column[] = [
    { key: "number", label: "Nº", sql: "", type: "number" }, { key: "name", label: "Nombre", sql: "", type: "text" },
    { key: "due", label: "Fecha", sql: "", type: "date" }, { key: "ok", label: "Vencida", sql: "", type: "bool" },
  ];
  const rows = [{ number: 1, name: "=HYPERLINK(\"http://evil\")", due: new Date("2026-03-01T00:00:00Z"), ok: true }, { number: 2, name: "Ñandú; \"quoted\"", due: null, ok: false }];

  it("CSV is Excel friendly and neutralises formulas", () => {
    const text = renderCsv({ title: "t", columns, rows }).toString("utf8");
    expect(text.startsWith("\uFEFFNº;Nombre;Fecha;Vencida\r\n")).toBe(true);
    expect(text).toContain("'=HYPERLINK");
    expect(text).toContain('"Ñandú; ""quoted"""');
    expect(text).toContain("1;");
  });
  it("XLSX and PDF produce valid files", async () => {
    const x = await renderExport("xlsx", { title: "Órdenes", columns, rows });
    expect(x.data.subarray(0, 2).toString()).toBe("PK");
    const p = await renderExport("pdf", { title: "Órdenes", columns, rows, filterSummary: "estado = planned" });
    expect(p.data.subarray(0, 5).toString()).toBe("%PDF-");
    expect(p.mime).toBe("application/pdf");
  });
});

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("entity registry against the real schema", () => {
  const dbName = `orq_rep_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: `orq_rep_${Date.now()}`, password: "x" } });
    pool = createPool(base.toString());
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it.each(listEntities().map((e) => [e.key]))("%s: all columns select, sort and filter without SQL errors", async (key) => {
    const e = getEntity(key!)!;
    const all = e.columns.map((c) => c.key);
    const c = compileQuery(e, { columns: all, q: "a", sort: [{ key: e.defaultSort[0]!.key, dir: "asc" }] }, NOW);
    await pool.query(c.select, c.params);
    await pool.query(c.count, c.params);
    for (const col of e.columns.filter((x) => !x.noFilter)) {
      const value = col.type === "number" ? 1 : col.type === "date" || col.type === "timestamp" ? "today" : col.type === "bool" ? true : col.options?.[0] ?? "x";
      const op = col.type === "bool" || col.type === "enum" ? "eq" : col.type === "text" ? "contains" : "gte";
      const q = compileQuery(e, { filter: { field: col.key, op, value } as Filter, columns: [col.key], sort: [{ key: col.key }] }, NOW);
      await pool.query(q.select, q.params);
    }
  });

  it("every KPI compiles and runs, and aggregates group by day", async () => {
    for (const k of KPIS) {
      const entity = getEntity(k.entity)!;
      expect(entity, k.key).toBeDefined();
      const q = compileAggregate(entity, k.filter, k.aggregate, {}, NOW);
      const r = await pool.query(q.sql, q.params);
      expect(r.rows[0].value === null || Number(r.rows[0].value) >= 0, k.key).toBe(true);
      if (k.seriesBy) {
        const g = compileAggregate(entity, k.filter, k.aggregate, { groupBy: k.seriesBy, bucket: "day" }, NOW);
        await pool.query(g.sql, g.params);
      }
    }
    expect(() => compileAggregate(wo, null, { fn: "sum", column: "status" })).toThrow(/numeric/);
  });
});
