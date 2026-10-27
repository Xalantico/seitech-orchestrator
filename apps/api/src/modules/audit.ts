import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { stream } from "hono/streaming";

import { run } from "../lib/db.js";
import { HttpError } from "../lib/errors.js";
import { can } from "../lib/principal.js";
import { define, z } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";

export const audit = new OpenAPIHono<AppEnv>();
const TAG = "Audit";

const filterQuery = z.object({
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  actor: z.string().optional(),
  action: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  before_seq: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

function buildWhere(q: z.infer<typeof filterQuery>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (q.entity_type) add("entity_type = ?", q.entity_type);
  if (q.entity_id) add("entity_id = ?", q.entity_id);
  if (q.actor) add("actor ILIKE ?", `%${q.actor}%`);
  if (q.action) add("action = ?", q.action);
  if (q.from) add("at >= ?", q.from);
  if (q.to) add("at <= ?", q.to);
  if (q.before_seq) add("seq < ?", q.before_seq);
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

const COLS = "seq, at, actor, ip, action, entity_type, entity_id, diff, context, hash";

define(audit, { method: "get", path: "/audit", tag: TAG, summary: "Query the immutable audit log (centro de gobernanza)", permission: "audit:read", query: filterQuery }, async (c, i) => {
  const { sql, params } = buildWhere(i.query);
  const rows = await run(c, (db) => db.query(`SELECT ${COLS} FROM audit_log ${sql} ORDER BY seq DESC LIMIT ${i.query.limit}`, params));
  return c.json({ items: rows.rows, nextBeforeSeq: rows.rows.length === i.query.limit ? rows.rows.at(-1)?.seq : null });
});

/** Change history of one entity; also open to people who may read that entity (ORF-045). */
define(audit, { method: "get", path: "/audit/entity/{type}/{id}", tag: TAG, summary: "Who changed what on one work order, visit, etc.", authenticated: true, params: z.object({ type: z.string(), id: z.string() }) }, async (c, i) => {
  const p = c.get("principal");
  if (!can(p, "audit:read") && !can(p, `${i.params.type}:read`)) throw new HttpError(403, "No tienes permiso para ver este historial", "forbidden");
  const rows = await run(c, (db) =>
    db.query(`SELECT ${COLS} FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY seq DESC LIMIT 500`, [i.params.type, i.params.id]),
  );
  return c.json({ items: rows.rows });
});

define(audit, { method: "get", path: "/audit/verify", tag: TAG, summary: "Verify the hash chain end to end", permission: "audit:read" }, async (c) => {
  const r = await run(c, (db) => db.query<{ broken: number | null }>("SELECT audit_verify_chain() AS broken"));
  const broken = r.rows[0]?.broken ?? null;
  return c.json({ intact: broken === null, brokenAtSeq: broken });
});

async function exportCsv(c: Context<AppEnv>, query: z.infer<typeof filterQuery>) {
  const { sql, params } = buildWhere({ ...query, limit: 100_000 });
  const rows = await run(c, async (db) => {
    await db.query("SELECT audit_event('audit_export', 'audit_log', NULL, $1::jsonb)", [JSON.stringify({ filter: query })]);
    return db.query(`SELECT ${COLS} FROM audit_log ${sql} ORDER BY seq DESC LIMIT 100000`, params);
  });
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", 'attachment; filename="audit.csv"');
  return stream(c, async (s) => {
    await s.write("seq,at,actor,ip,action,entity_type,entity_id,diff,hash\n");
    for (const r of rows.rows) {
      await s.write([r.seq, new Date(r.at).toISOString(), r.actor, r.ip, r.action, r.entity_type, r.entity_id, JSON.stringify(r.diff), r.hash].map(esc).join(",") + "\n");
    }
  });
}

define(audit, { method: "get", path: "/audit/export", tag: TAG, summary: "Export audit entries as CSV for compliance", permission: "audit:export", query: filterQuery }, (c, i) => exportCsv(c, i.query));

define(audit, { method: "get", path: "/audit/stats", tag: TAG, summary: "Audit activity by action over the last days", permission: "audit:read", query: z.object({ days: z.coerce.number().int().min(1).max(365).default(7) }) }, async (c, i) => {
  const r = await run(c, (db) =>
    db.query(`SELECT date_trunc('day', at)::date AS day, action, count(*)::int AS n FROM audit_log WHERE at > now() - make_interval(days => $1) GROUP BY 1, 2 ORDER BY 1`, [i.query.days]),
  );
  return c.json({ items: r.rows });
});
