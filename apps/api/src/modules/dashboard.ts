import { createHash } from "node:crypto";

import { OpenAPIHono } from "@hono/zod-openapi";
import { KPIS, QueryError, compileAggregate, getEntity, type Filter, type Kpi } from "@orchestrador/reporting";
import { streamSSE } from "hono/streaming";

import { run } from "../lib/db.js";
import { HttpError, notFound } from "../lib/errors.js";
import { can, type Principal } from "../lib/principal.js";
import { define, z } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";
import { entityFor } from "./query.js";

export const dashboard = new OpenAPIHono<AppEnv>();
const TAG = "Dashboard";

const withDelegation = (kpiFilter: Filter | null, entityKey: string, delegation?: string): Filter | null => {
  if (!delegation || !getEntity(entityKey)?.columns.some((c) => c.key === "delegation")) return kpiFilter;
  const d: Filter = { field: "delegation", op: "eq", value: delegation };
  return kpiFilter ? { op: "and", items: [kpiFilter, d] } : d;
};

/**
 * Shared snapshot cache (RNF-17/18). Hundreds of open dashboards must not mean hundreds of KPI recalculations:
 *  - the key is the visible data scope (not the user), so everyone with the same scope and permissions shares one snapshot;
 *  - concurrent misses share one computation (single flight);
 *  - a snapshot slightly past its TTL is served immediately while a refresh runs in the background.
 */
type Snapshot = { generatedAt: string; kpis: unknown[] };
const cache = new Map<string, { at: number; body: Snapshot }>();
const inflight = new Map<string, Promise<Snapshot>>();
const TTL_MS = Number(process.env.DASHBOARD_CACHE_SECONDS ?? 10) * 1000;
const STALE_MS = TTL_MS * 6;

const scopeKey = (p: Principal, visible: Kpi[], delegation?: string) =>
  createHash("sha1").update(JSON.stringify([p.scopeAll, [...p.scopes].map((s) => JSON.stringify(s)).sort(), visible.map((k) => k.key), delegation ?? ""])).digest("hex");

async function compute(c: Parameters<typeof run>[0], visible: Kpi[], delegation?: string): Promise<Snapshot> {
  const kpis = await run(c, async (db) => {
    const out: unknown[] = [];
    for (const k of visible) {
      const entity = getEntity(k.entity)!;
      const filter = withDelegation(k.filter, k.entity, delegation);
      const q = compileAggregate(entity, filter, k.aggregate);
      const value = (await db.query<{ value: string | number | null }>(q.sql, q.params)).rows[0]?.value ?? null;
      out.push({
        key: k.key, label: k.label, group: k.group, tone: k.tone, unit: k.unit ?? "count", value: value === null ? null : Number(value),
        drill: { entity: k.entity, filter },
      });
    }
    return out;
  });
  return { generatedAt: new Date().toISOString(), kpis };
}

async function computeKpis(c: Parameters<typeof run>[0], p: Principal, delegation?: string): Promise<Snapshot> {
  const visible = KPIS.filter((k: Kpi) => can(p, getEntity(k.entity)?.permission ?? "system:admin"));
  const key = scopeKey(p, visible, delegation);
  const refresh = () => {
    let job = inflight.get(key);
    if (!job) {
      job = compute(c, visible, delegation)
        .then((body) => {
          cache.set(key, { at: Date.now(), body });
          if (cache.size > 500) for (const k of cache.keys()) { cache.delete(k); if (cache.size < 250) break; }
          return body;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    return job;
  };
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < TTL_MS) return hit.body;
  if (hit && age < STALE_MS) { refresh().catch(() => undefined); return hit.body; }
  return refresh();
}

define(dashboard, {
  method: "get", path: "/dashboard/kpis", tag: TAG, summary: "Back-office KPIs with drill-down definitions", permission: "dashboard:read",
  query: z.object({ delegation: z.string().max(120).optional() }),
  description: "Each KPI carries the entity and filter that produce its number: POST /query/{entity} with it returns the rows behind the figure.",
}, async (c, i) => c.json(await computeKpis(c, c.get("principal"), i.query.delegation)));

define(dashboard, {
  method: "get", path: "/dashboard/kpis/{key}/series", tag: TAG, summary: "Trend of a KPI, one point per day, week or month", permission: "dashboard:read",
  params: z.object({ key: z.string() }), query: z.object({ bucket: z.enum(["day", "week", "month"]).default("day"), days: z.coerce.number().int().min(1).max(730).default(30), delegation: z.string().optional() }),
}, async (c, i) => {
  const p = c.get("principal");
  const k = KPIS.find((x) => x.key === i.params.key);
  if (!k?.seriesBy) throw notFound("KPI with a series");
  const entity = entityFor(p, k.entity);
  const filter = withDelegation({ op: "and", items: [k.filter ?? { op: "and", items: [] }, { field: k.seriesBy, op: "gte", value: `-${i.query.days}d` }] }, k.entity, i.query.delegation);
  const q = compileAggregate(entity, filter, k.aggregate, { groupBy: k.seriesBy, bucket: i.query.bucket, limit: 800 });
  const rows = await run(c, (db) => db.query<{ key: string; value: number }>(q.sql, q.params));
  return c.json({ key: k.key, label: k.label, bucket: i.query.bucket, points: rows.rows.map((r) => ({ at: r.key, value: Number(r.value) })) });
});

define(dashboard, {
  method: "post", path: "/dashboard/breakdown", tag: TAG, summary: "Count (or sum) of any list grouped by a column, for charts", permission: "dashboard:read",
  body: z.object({
    entity: z.string(), groupBy: z.string(), bucket: z.enum(["day", "week", "month"]).optional(), filter: z.unknown().optional(),
    aggregate: z.object({ fn: z.enum(["count", "sum", "avg", "min", "max"]), column: z.string().optional() }).default({ fn: "count" }), limit: z.number().int().min(1).max(200).default(50),
  }),
}, async (c, i) => {
  const e = entityFor(c.get("principal"), i.body.entity);
  try {
    const q = compileAggregate(e, (i.body.filter ?? null) as Filter | null, i.body.aggregate, { groupBy: i.body.groupBy, bucket: i.body.bucket, limit: i.body.limit });
    const rows = await run(c, (db) => db.query<{ key: string | null; value: number }>(q.sql, q.params));
    return c.json({ entity: e.key, groupBy: i.body.groupBy, items: rows.rows.map((r) => ({ key: r.key, value: Number(r.value) })) });
  } catch (error) {
    if (error instanceof QueryError) throw new HttpError(400, error.message, "bad_query");
    throw error;
  }
});

define(dashboard, { method: "get", path: "/dashboard/stream", tag: TAG, summary: "Live dashboard: KPI snapshot pushed whenever a number changes (SSE)", permission: "dashboard:read", query: z.object({ delegation: z.string().optional(), interval: z.coerce.number().int().min(2).max(60).default(8) }) }, async (c, i) => {
  const p = c.get("principal");
  return streamSSE(c, async (stream) => {
    let aborted = false;
    stream.onAbort(() => { aborted = true; });
    let last = "";
    let beats = 0;
    while (!aborted) {
      try {
        const snapshot = await computeKpis(c, p, i.query.delegation);
        const digest = createHash("sha1").update(JSON.stringify((snapshot.kpis as { key: string; value: number | null }[]).map((k) => [k.key, k.value]))).digest("hex");
        if (digest !== last) {
          last = digest;
          await stream.writeSSE({ event: "kpis", data: JSON.stringify(snapshot) });
        } else if (++beats % 4 === 0) {
          await stream.writeSSE({ event: "ping", data: "{}" });
        }
      } catch (error) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: error instanceof Error ? error.message : "failed" }) });
      }
      await stream.sleep(i.query.interval * 1000);
    }
  });
});

export const kpiCatalog = () => KPIS.map(({ key, label, group, entity }) => ({ key, label, group, entity }));
define(dashboard, { method: "get", path: "/dashboard/catalog", tag: TAG, summary: "All KPI definitions (for alert rules and layout)", permission: "dashboard:read" }, async (c) => c.json({ items: kpiCatalog() }));
