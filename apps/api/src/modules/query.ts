import { OpenAPIHono } from "@hono/zod-openapi";
import {
  COUNT_CAP, OPERATORS_BY_TYPE, QueryError, compileExport, compileQuery, getEntity, listEntities, renderExport, validateFilter,
  type EntityDef, type Filter, type QuerySpec,
} from "@orchestrador/reporting";

import { env } from "../env.js";
import { run } from "../lib/db.js";
import { saveDocument, readDocument } from "../lib/documents.js";
import { HttpError, forbidden, notFound } from "../lib/errors.js";
import { can, type Principal } from "../lib/principal.js";
import { define, z } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";

export const query = new OpenAPIHono<AppEnv>();
const TAG = "Query & exports";

const filterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    z.object({ field: z.string(), op: z.enum(["eq", "neq", "in", "nin", "gt", "gte", "lt", "lte", "contains", "startsWith", "between", "null", "notnull"]), value: z.unknown().optional(), value2: z.unknown().optional() }),
    z.object({ op: z.enum(["and", "or"]), items: z.array(filterSchema) }),
  ]),
).openapi({ type: "object", description: "A condition { field, op, value } or a group { op: 'and' | 'or', items: [...] }" }) as never;

export const specSchema = z.object({
  filter: filterSchema.nullable().optional(),
  columns: z.array(z.string()).max(60).optional(),
  sort: z.array(z.object({ key: z.string(), dir: z.enum(["asc", "desc"]).optional() })).max(5).optional(),
  q: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});

const entityParam = z.object({ entity: z.string() });

/** Resolves an entity the caller is allowed to read; unknown and forbidden both look like "not found" for hidden ones. */
export function entityFor(p: Principal, key: string): EntityDef {
  const e = getEntity(key);
  if (!e) throw notFound("Entity");
  if (!can(p, e.permission)) throw forbidden(`Missing permission ${e.permission}`);
  return e;
}

export async function runSpec(db: Parameters<Parameters<typeof run>[1]>[0], e: EntityDef, spec: QuerySpec, maxRows?: number) {
  try {
    const compiled = maxRows ? compileExport(e, spec, maxRows) : compileQuery(e, spec);
    const rows = await db.query(compiled.select, compiled.params);
    return { compiled, rows: rows.rows as Record<string, unknown>[] };
  } catch (error) {
    if (error instanceof QueryError) throw new HttpError(400, error.message, "bad_query");
    throw error;
  }
}

// ───────────── metadata (drives the filter builder and column picker in the UI) ─────────────
define(query, { method: "get", path: "/query/entities", tag: TAG, summary: "Entities, columns and operators available to the current user", authenticated: true }, async (c) => {
  const p = c.get("principal");
  return c.json({
    entities: listEntities().filter((e) => can(p, e.permission)).map((e) => ({
      key: e.key, label: e.label, id: e.id, defaults: e.defaults, defaultSort: e.defaultSort, searchable: e.search.length > 0,
      columns: e.columns.filter((x) => !x.hidden).map((x) => ({
        key: x.key, label: x.label, type: x.type, options: x.options ?? null, filterable: !x.noFilter, sortable: !x.noSort,
        operators: x.noFilter ? [] : OPERATORS_BY_TYPE[x.type],
      })),
    })),
    relativeDates: ["today", "+1d", "+7d", "-7d", "-30d", "startOfWeek", "startOfMonth", "startOfYear"],
  });
});

define(query, {
  method: "post", path: "/query/{entity}", tag: TAG, summary: "Filtered, sorted, paged listing of any whitelisted entity", params: entityParam, body: specSchema, authenticated: true,
  description: "One filter language for lists, saved filters, drill-down from the dashboard, exports and alerts. Visibility follows the caller's delegation, zone and project scope.",
}, async (c, i) => {
  const e = entityFor(c.get("principal"), i.params.entity);
  const out = await run(c, async (db) => {
    const { compiled, rows } = await runSpec(db, e, i.body);
    const n = (await db.query<{ n: number }>(compiled.countCapped, compiled.params)).rows[0]!.n;
    return { rows, total: Math.min(n, COUNT_CAP), totalCapped: n > COUNT_CAP, columns: compiled.columns.map((x) => x.key) };
  });
  return c.json({ entity: e.key, ...out });
});

define(query, { method: "post", path: "/query/{entity}/validate", tag: TAG, summary: "Check a filter without running it", params: entityParam, body: z.object({ filter: filterSchema.nullable() }), authenticated: true }, async (c, i) => {
  const e = entityFor(c.get("principal"), i.params.entity);
  const problem = validateFilter(e, i.body.filter);
  return c.json({ valid: problem === null, problem });
});

// ───────────── saved filters (ORF-040..042) ─────────────
const savedBody = z.object({
  name: z.string().min(1).max(120), entity: z.string(), definition: specSchema,
  visibility: z.enum(["private", "role", "all"]).default("private"), roleId: z.string().uuid().nullable().optional(), editableByOthers: z.boolean().default(false),
});
const SF_SELECT = `SELECT f.id, f.name, f.entity, f.definition, f.visibility, f.role_id, f.editable_by_others, f.duplicated_from, f.created_at, f.updated_at,
  f.owner_id, u.display_name AS owner_name, (f.owner_id = nullif(current_setting('app.actor_id', true), '')::uuid) AS mine
  FROM saved_filters f JOIN users u ON u.id = f.owner_id`;
/** A filter is visible to its owner, to everyone ("all") or to holders of the role ("role"). */
const VISIBLE = `(f.owner_id = $1 OR f.visibility = 'all' OR (f.visibility = 'role' AND f.role_id IN (SELECT role_id FROM user_roles WHERE user_id = $1)))`;

function checkDefinition(entity: string, definition: z.infer<typeof specSchema>) {
  const e = getEntity(entity);
  if (!e) throw new HttpError(400, `Unknown entity ${entity}`, "bad_query");
  const problem = validateFilter(e, definition.filter ?? null);
  if (problem) throw new HttpError(400, problem, "bad_query");
  try { compileQuery(e, { ...definition, limit: 1 }); } catch (error) { if (error instanceof QueryError) throw new HttpError(400, error.message, "bad_query"); throw error; }
}

define(query, { method: "get", path: "/saved-filters", tag: TAG, summary: "Saved filters I can use", permission: "filters:read", query: z.object({ entity: z.string().optional() }) }, async (c, i) => {
  const p = c.get("principal");
  const r = await run(c, (db) => db.query(`${SF_SELECT} WHERE ${VISIBLE} ${i.query.entity ? "AND f.entity = $2" : ""} ORDER BY mine DESC, f.name`, i.query.entity ? [p.id, i.query.entity] : [p.id]));
  return c.json({ items: r.rows });
});

define(query, { method: "post", path: "/saved-filters", tag: TAG, summary: "Save a filter, private or shared with a role or everyone", permission: "filters:write", body: savedBody, status: 201 }, async (c, i) => {
  const p = c.get("principal");
  checkDefinition(i.body.entity, i.body.definition);
  if (i.body.visibility === "role" && !i.body.roleId) throw new HttpError(400, "A role is needed to share with a role", "bad_request");
  const r = await run(c, (db) => db.query(
    `INSERT INTO saved_filters (owner_id, name, entity, definition, visibility, role_id, editable_by_others) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING id`,
    [p.id, i.body.name, i.body.entity, JSON.stringify(i.body.definition), i.body.visibility, i.body.visibility === "role" ? i.body.roleId : null, i.body.editableByOthers],
  ));
  return c.json({ id: r.rows[0].id }, 201);
});

define(query, { method: "put", path: "/saved-filters/{id}", tag: TAG, summary: "Edit a saved filter (owner, or anyone if the owner allowed it)", permission: "filters:write", params: z.object({ id: z.string().uuid() }), body: savedBody.partial() }, async (c, i) => {
  const p = c.get("principal");
  const r = await run(c, async (db) => {
    const cur = (await db.query(`${SF_SELECT} WHERE f.id = $2 AND ${VISIBLE}`, [p.id, i.params.id])).rows[0];
    if (!cur) throw notFound("Saved filter");
    if (cur.owner_id !== p.id && !cur.editable_by_others) throw forbidden("Only the owner can edit this filter");
    const next = {
      name: i.body.name ?? cur.name, entity: i.body.entity ?? cur.entity, definition: i.body.definition ?? cur.definition,
      visibility: cur.owner_id === p.id ? i.body.visibility ?? cur.visibility : cur.visibility,
      roleId: cur.owner_id === p.id ? (i.body.roleId === undefined ? cur.role_id : i.body.roleId) : cur.role_id,
      editable: cur.owner_id === p.id ? i.body.editableByOthers ?? cur.editable_by_others : cur.editable_by_others,
    };
    checkDefinition(next.entity, next.definition);
    await db.query(
      "UPDATE saved_filters SET name = $2, entity = $3, definition = $4::jsonb, visibility = $5, role_id = $6, editable_by_others = $7, updated_at = now() WHERE id = $1",
      [i.params.id, next.name, next.entity, JSON.stringify(next.definition), next.visibility, next.visibility === "role" ? next.roleId : null, next.editable],
    );
    return true;
  });
  return c.json({ ok: r });
});

define(query, { method: "post", path: "/saved-filters/{id}/duplicate", tag: TAG, summary: "Copy a filter I can see into my own private filters", permission: "filters:write", params: z.object({ id: z.string().uuid() }), status: 201 }, async (c, i) => {
  const p = c.get("principal");
  const r = await run(c, async (db) => {
    const cur = (await db.query(`${SF_SELECT} WHERE f.id = $2 AND ${VISIBLE}`, [p.id, i.params.id])).rows[0];
    if (!cur) throw notFound("Saved filter");
    return db.query(
      "INSERT INTO saved_filters (owner_id, name, entity, definition, visibility, duplicated_from) VALUES ($1, $2, $3, $4::jsonb, 'private', $5) RETURNING id",
      [p.id, `${cur.name} (copia)`.slice(0, 120), cur.entity, JSON.stringify(cur.definition), cur.id],
    );
  });
  return c.json({ id: r.rows[0].id }, 201);
});

define(query, { method: "delete", path: "/saved-filters/{id}", tag: TAG, summary: "Delete my saved filter", permission: "filters:write", params: z.object({ id: z.string().uuid() }) }, async (c, i) => {
  const p = c.get("principal");
  const r = await run(c, (db) => db.query("DELETE FROM saved_filters WHERE id = $1 AND (owner_id = $2 OR $3) RETURNING id", [i.params.id, p.id, can(p, "system:admin")]));
  if (!r.rows[0]) throw notFound("Saved filter");
  return c.json({ ok: true });
});

// ───────────── exports (ORF-043, ORF-044) ─────────────
const exportBody = z.object({ entity: z.string(), format: z.enum(["csv", "xlsx", "pdf"]), spec: specSchema.default({}), savedFilterId: z.string().uuid().optional() });

function summarise(filter: Filter | null | undefined): string {
  if (!filter) return "";
  if ("items" in filter) return filter.items.map(summarise).filter(Boolean).join(filter.op === "and" ? " y " : " o ");
  return `${filter.field} ${filter.op}${filter.value !== undefined ? ` ${JSON.stringify(filter.value)}` : ""}`;
}

define(query, {
  method: "post", path: "/exports", tag: TAG, summary: "Export a filtered list to CSV, Excel or PDF", permission: "exports:run", body: exportBody, status: 201,
  description: "Exports exactly what the list shows (same filter, columns and scope). The file is stored as a document and every export is audited.",
}, async (c, i) => {
  const p = c.get("principal");
  const e = entityFor(p, i.body.entity);
  let spec: QuerySpec = i.body.spec;
  if (i.body.savedFilterId) {
    const sf = (await run(c, (db) => db.query(`${SF_SELECT} WHERE f.id = $2 AND ${VISIBLE}`, [p.id, i.body.savedFilterId]))).rows[0];
    if (!sf || sf.entity !== e.key) throw notFound("Saved filter");
    spec = { ...sf.definition, ...Object.fromEntries(Object.entries(i.body.spec).filter(([, v]) => v !== undefined)) };
  }
  // The job row is written in its own transaction so a failed export stays visible instead of rolling back with the error.
  const job = (await run(c, (db) => db.query("INSERT INTO export_jobs (requested_by, entity, format, filter, columns, status) VALUES ($1, $2, $3, $4::jsonb, $5, 'running') RETURNING id", [p.id, e.key, i.body.format, JSON.stringify(spec.filter ?? {}), spec.columns ?? []]))).rows[0].id as string;
  let out;
  try {
    out = await run(c, async (db) => {
      const { compiled, rows } = await runSpec(db, e, spec, env.EXPORT_MAX_ROWS);
      const now = new Date();
      const rendered = await renderExport(i.body.format, { title: e.label, columns: compiled.columns, rows, generatedAt: now, filterSummary: summarise(spec.filter) });
      const filename = `${e.key}-${now.toISOString().slice(0, 10)}.${rendered.extension}`;
      const doc = await saveDocument(db, { data: rendered.data, filename, mime: rendered.mime, kind: "export", entityType: "export", entityId: job, metadata: { entity: e.key, rows: rows.length } }, p.kind === "user" ? p.id : null);
      await db.query("UPDATE export_jobs SET status = 'done', row_count = $2, document_id = $3, finished_at = now() WHERE id = $1", [job, rows.length, doc.id]);
      await db.query("SELECT audit_event('export', $1, $2, $3::jsonb)", [e.key, job, JSON.stringify({ format: i.body.format, rows: rows.length, filter: spec.filter ?? null })]);
      return { id: job, status: "done", rowCount: rows.length, documentId: doc.id, filename, truncated: rows.length >= env.EXPORT_MAX_ROWS };
    });
  } catch (error) {
    await run(c, (db) => db.query("UPDATE export_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [job, error instanceof Error ? error.message.slice(0, 500) : "failed"]));
    throw error;
  }
  return c.json(out, 201);
});

define(query, { method: "get", path: "/exports", tag: TAG, summary: "My exports (all exports for auditors)", permission: "exports:run", query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }, async (c, i) => {
  const p = c.get("principal");
  const r = await run(c, (db) => db.query(
    `SELECT id, entity, format, status, row_count, document_id, error, created_at, finished_at, requested_by FROM export_jobs WHERE ($1 OR requested_by = $2) ORDER BY created_at DESC LIMIT ${i.query.limit}`,
    [can(p, "audit:read"), p.id],
  ));
  return c.json({ items: r.rows });
});

define(query, { method: "get", path: "/exports/{id}/download", tag: TAG, summary: "Download a finished export", permission: "exports:run", params: z.object({ id: z.string().uuid() }) }, async (c, i) => {
  const p = c.get("principal");
  const job = (await run(c, (db) => db.query("SELECT document_id, requested_by, entity FROM export_jobs WHERE id = $1", [i.params.id]))).rows[0];
  if (!job?.document_id || (job.requested_by !== p.id && !can(p, "audit:read"))) throw notFound("Export");
  const doc = await readDocument(c, job.document_id as string, "download");
  c.header("content-type", doc.mime);
  c.header("content-disposition", `attachment; filename="${encodeURIComponent(doc.filename)}"`);
  return c.body(new Uint8Array(doc.body));
});
