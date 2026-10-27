import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { run, type Tx } from "./db.js";
import { HttpError, notFound } from "./errors.js";
import { requirePermission } from "../middleware/auth.js";
import type { AppEnv } from "./types.js";

export { z };

export const zUuid = z.string().uuid();
export const zJson = z.record(z.unknown());
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const zTimestamp = z.string().datetime({ offset: true });

export type FieldDef = {
  schema: z.ZodTypeAny;
  /** Postgres cast applied on write and filter, e.g. "jsonb", "text[]", "uuid", "date". */
  cast?: string;
  /** Select expression when the column needs conversion (e.g. `email::text`). */
  expr?: string;
};

export type CrudConfig = {
  tag: string;
  table: string;
  basePath: string;
  permissions: { read: string; write: string; delete?: string };
  fields: Record<string, FieldDef>;
  /** Extra read-only columns, e.g. created_at. */
  readonly?: string[];
  search?: string[];
  filters?: string[];
  sort?: string[];
  defaultOrder?: string;
  deletable?: boolean;
  idType?: "uuid" | "text";
  transformCreate?: (data: Record<string, unknown>, c: Context<AppEnv>, db: Tx) => Promise<Record<string, unknown>> | Record<string, unknown>;
  transformUpdate?: (data: Record<string, unknown>, c: Context<AppEnv>, db: Tx, id: string) => Promise<Record<string, unknown>> | Record<string, unknown>;
  afterWrite?: (row: Record<string, unknown>, c: Context<AppEnv>, op: "create" | "update" | "delete") => Promise<void> | void;
};

const errorSchema = z.object({ error: z.string(), code: z.string().optional() });

/** Builds a documented, permission-checked REST resource from a declarative description. */
export function crud(cfg: CrudConfig): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  const names = Object.keys(cfg.fields);
  const readonly = cfg.readonly ?? [];
  const selectList = [
    "id",
    ...names.map((n) => (cfg.fields[n]!.expr ? `${cfg.fields[n]!.expr} AS ${n}` : n)),
    ...readonly,
  ].join(", ");
  const idSchema = cfg.idType === "text" ? z.string().min(1) : zUuid;
  const rowSchema = z
    .object({ id: idSchema, ...Object.fromEntries(names.map((n) => [n, cfg.fields[n]!.schema.optional()])) })
    .passthrough()
    .openapi(`${cfg.table}_row`);
  const createSchema = z.object(Object.fromEntries(names.map((n) => [n, cfg.fields[n]!.schema])));
  const updateSchema = createSchema.partial();
  const sortable = new Set(["id", ...(cfg.sort ?? []), ...readonly, ...names]);
  const filters = cfg.filters ?? [];
  const tags = [cfg.tag];
  const security: Record<string, string[]>[] = [{ cookieAuth: [] }, { bearerAuth: [] }, { apiKey: [] }];

  const querySchema = z.object({
    q: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    sort: z.string().optional(),
    order: z.enum(["asc", "desc"]).optional(),
    ...Object.fromEntries(filters.map((f) => [f, z.string().optional()])),
  });

  const column = (name: string) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad column ${name}`);
    return name;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: cfg.basePath,
      tags,
      security,
      summary: `List ${cfg.table}`,
      middleware: [requirePermission(cfg.permissions.read)] as const,
      request: { query: querySchema },
      responses: {
        200: { description: "Page of results", content: { "application/json": { schema: z.object({ items: z.array(rowSchema), total: z.number() }) } } },
      },
    }),
    (async (c: Context<AppEnv>) => {
      const q = (c.req as unknown as { valid: (t: string) => Record<string, string | number | undefined> }).valid("query");
      const where: string[] = [];
      const params: unknown[] = [];
      for (const f of filters) {
        const value = q[f];
        if (value !== undefined && value !== "") {
          params.push(value);
          const cast = cfg.fields[f]?.cast;
          where.push(`${column(f)} = $${params.length}${cast ? `::${cast}` : ""}`);
        }
      }
      if (q.q && cfg.search?.length) {
        params.push(`%${String(q.q).replace(/[\\%_]/g, "\\$&")}%`);
        where.push(`(${cfg.search.map((s) => `${column(s)}::text ILIKE $${params.length}`).join(" OR ")})`);
      }
      const sort = q.sort && sortable.has(String(q.sort)) ? column(String(q.sort)) : undefined;
      const order = sort ? `${sort} ${q.order === "desc" ? "DESC" : "ASC"}, id` : cfg.defaultOrder ?? (readonly.includes("created_at") ? "created_at DESC, id" : "id");
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const result = await run(c, async (db) => {
        const items = await db.query(
          `SELECT ${selectList} FROM ${cfg.table} ${whereSql} ORDER BY ${order} LIMIT ${Number(q.limit)} OFFSET ${Number(q.offset)}`,
          params,
        );
        const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${cfg.table} ${whereSql}`, params);
        return { items: items.rows, total: total.rows[0]!.n };
      });
      return c.json(result, 200);
    }) as never,
  );

  app.openapi(
    createRoute({
      method: "get",
      path: `${cfg.basePath}/{id}`,
      tags,
      security,
      summary: `Get one of ${cfg.table}`,
      middleware: [requirePermission(cfg.permissions.read)] as const,
      request: { params: z.object({ id: idSchema }) },
      responses: {
        200: { description: "The record", content: { "application/json": { schema: rowSchema } } },
        404: { description: "Not found", content: { "application/json": { schema: errorSchema } } },
      },
    }),
    (async (c: Context<AppEnv>) => {
      const id = c.req.param("id")!;
      const row = await run(c, async (db) => (await db.query(`SELECT ${selectList} FROM ${cfg.table} WHERE id = $1`, [id])).rows[0]);
      if (!row) throw notFound(cfg.table);
      return c.json(row, 200);
    }) as never,
  );

  app.openapi(
    createRoute({
      method: "post",
      path: cfg.basePath,
      tags,
      security,
      summary: `Create in ${cfg.table}`,
      middleware: [requirePermission(cfg.permissions.write)] as const,
      request: { body: { content: { "application/json": { schema: createSchema } }, required: true } },
      responses: { 201: { description: "Created", content: { "application/json": { schema: rowSchema } } } },
    }),
    (async (c: Context<AppEnv>) => {
      const body = (c.req as unknown as { valid: (t: string) => Record<string, unknown> }).valid("json");
      const row = await run(c, async (db) => {
        const data = cfg.transformCreate ? await cfg.transformCreate({ ...body }, c, db) : { ...body };
        const keys = Object.keys(data).filter((k) => k in cfg.fields && data[k] !== undefined);
                const values = keys.map((k) => (cfg.fields[k]!.cast === "jsonb" ? JSON.stringify(data[k]) : data[k]));
        const cols = keys.map(column);
        const placeholders = keys.map((k, i) => `$${i + 1}${cfg.fields[k]!.cast ? `::${cfg.fields[k]!.cast}` : ""}`);
        const sql = keys.length
          ? `INSERT INTO ${cfg.table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING ${selectList}`
          : `INSERT INTO ${cfg.table} DEFAULT VALUES RETURNING ${selectList}`;
        return (await db.query(sql, values)).rows[0]!;
      });
      await cfg.afterWrite?.(row, c, "create");
      return c.json(row, 201);
    }) as never,
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: `${cfg.basePath}/{id}`,
      tags,
      security,
      summary: `Update ${cfg.table}`,
      middleware: [requirePermission(cfg.permissions.write)] as const,
      request: { params: z.object({ id: idSchema }), body: { content: { "application/json": { schema: updateSchema } }, required: true } },
      responses: { 200: { description: "Updated", content: { "application/json": { schema: rowSchema } } } },
    }),
    (async (c: Context<AppEnv>) => {
      const id = c.req.param("id")!;
      const body = (c.req as unknown as { valid: (t: string) => Record<string, unknown> }).valid("json");
      const row = await run(c, async (db) => {
        const data = cfg.transformUpdate ? await cfg.transformUpdate({ ...body }, c, db, id) : { ...body };
        const keys = Object.keys(data).filter((k) => k in cfg.fields && data[k] !== undefined);
        if (keys.length === 0) throw new HttpError(400, "Nothing to update", "bad_request");
        const values = keys.map((k) => (cfg.fields[k]!.cast === "jsonb" ? JSON.stringify(data[k]) : data[k]));
        const sets = keys.map((k, i) => `${column(k)} = $${i + 2}${cfg.fields[k]!.cast ? `::${cfg.fields[k]!.cast}` : ""}`);
        const r = await db.query(`UPDATE ${cfg.table} SET ${sets.join(", ")} WHERE id = $1 RETURNING ${selectList}`, [id, ...values]);
        return r.rows[0];
      });
      if (!row) throw notFound(cfg.table);
      await cfg.afterWrite?.(row, c, "update");
      return c.json(row, 200);
    }) as never,
  );

  if (cfg.deletable !== false) {
    app.openapi(
      createRoute({
        method: "delete",
        path: `${cfg.basePath}/{id}`,
        tags,
        security,
        summary: `Delete from ${cfg.table}`,
        middleware: [requirePermission(cfg.permissions.delete ?? cfg.permissions.write)] as const,
        request: { params: z.object({ id: idSchema }) },
        responses: { 200: { description: "Deleted", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } } },
      }),
      (async (c: Context<AppEnv>) => {
        const id = c.req.param("id")!;
        const row = await run(c, async (db) => (await db.query(`DELETE FROM ${cfg.table} WHERE id = $1 RETURNING id`, [id])).rows[0]);
        if (!row) throw notFound(cfg.table);
        await cfg.afterWrite?.(row, c, "delete");
        return c.json({ ok: true }, 200);
      }) as never,
    );
  }

  return app;
}
