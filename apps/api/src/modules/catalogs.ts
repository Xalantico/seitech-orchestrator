import { OpenAPIHono } from "@hono/zod-openapi";

import { crud, z, zDate, zJson, zUuid } from "../lib/crud.js";
import { run } from "../lib/db.js";
import { notFound } from "../lib/errors.js";
import { define } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";

const perms = { read: "catalogs:read", write: "catalogs:write" };

export const catalogs = new OpenAPIHono<AppEnv>();

catalogs.route("/", crud({
  permissions: perms, tag: "Catalogs", table: "catalogs", basePath: "/catalogs",
  fields: { key: { schema: z.string().regex(/^[a-z][a-z0-9_]*$/) }, name: { schema: z.string().min(1) }, description: { schema: z.string().optional() } },
  readonly: ["is_system", "created_at"], search: ["key", "name"], defaultOrder: "key",
}));

catalogs.route("/", crud({
  permissions: perms, tag: "Catalogs", table: "catalog_items", basePath: "/catalog-items",
  fields: {
    catalog_id: { schema: zUuid }, code: { schema: z.string().min(1) }, label: { schema: z.string().min(1) },
    parent_code: { schema: z.string().nullable().optional() }, sort: { schema: z.number().int().optional() },
    active: { schema: z.boolean().optional() }, valid_from: { schema: zDate.nullable().optional(), cast: "date" },
    valid_to: { schema: zDate.nullable().optional(), cast: "date" }, extra: { schema: zJson.optional(), cast: "jsonb" },
  },
  readonly: ["updated_at"], search: ["code", "label"], filters: ["catalog_id", "active"], defaultOrder: "catalog_id, sort, code",
}));

/** Items of a catalog by key, for form drop-downs. */
define(catalogs, { method: "get", path: "/catalogs/by-key/{key}/items", tag: "Catalogs", summary: "Active items of a catalog", permission: "catalogs:read", params: z.object({ key: z.string() }) }, async (c, i) => {
  const r = await run(c, (db) =>
    db.query(
      `SELECT ci.code, ci.label, ci.parent_code, ci.extra FROM catalog_items ci JOIN catalogs ct ON ct.id = ci.catalog_id
       WHERE ct.key = $1 AND ci.active AND (ci.valid_to IS NULL OR ci.valid_to >= current_date) ORDER BY ci.sort, ci.code`,
      [i.params.key],
    ),
  );
  return c.json({ items: r.rows });
});

catalogs.route("/", crud({
  permissions: perms, tag: "Catalogs", table: "visit_types", basePath: "/visit-types",
  fields: {
    code: { schema: z.string().min(1) }, name: { schema: z.string().min(1) }, inspection_type: { schema: z.string().nullable().optional() },
    regulation: { schema: z.string().nullable().optional() }, avg_duration_min: { schema: z.number().int().positive() },
    avg_travel_min: { schema: z.number().int().min(0).optional() }, second_visit_days: { schema: z.number().int().nullable().optional() },
    active: { schema: z.boolean().optional() }, extra: { schema: zJson.optional(), cast: "jsonb" },
  },
  search: ["code", "name"], filters: ["inspection_type", "active"], defaultOrder: "code",
}));

define(catalogs, { method: "put", path: "/visit-types/{id}/overrides/{delegationId}", tag: "Catalogs", summary: "Delegation-specific duration and planning rules for a visit type (ORF-031)", permission: "catalogs:write", params: z.object({ id: zUuid, delegationId: zUuid }), body: z.object({ durationMin: z.number().int().positive().nullable(), travelMin: z.number().int().min(0).nullable(), planningRules: zJson.default({}) }) }, async (c, i) => {
  await run(c, (db) =>
    db.query(
      `INSERT INTO visit_type_overrides (visit_type_id, delegation_id, duration_min, travel_min, planning_rules) VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (visit_type_id, delegation_id) DO UPDATE SET duration_min = EXCLUDED.duration_min, travel_min = EXCLUDED.travel_min, planning_rules = EXCLUDED.planning_rules`,
      [i.params.id, i.params.delegationId, i.body.durationMin, i.body.travelMin, JSON.stringify(i.body.planningRules)],
    ),
  );
  return c.json({ ok: true });
});

define(catalogs, { method: "get", path: "/visit-types/{id}/overrides", tag: "Catalogs", summary: "Overrides of a visit type", permission: "catalogs:read", params: z.object({ id: zUuid }) }, async (c, i) => {
  const r = await run(c, (db) => db.query("SELECT * FROM visit_type_overrides WHERE visit_type_id = $1", [i.params.id]));
  if (!r.rows) throw notFound("Visit type");
  return c.json({ items: r.rows });
});

catalogs.route("/", crud({
  permissions: perms, tag: "Catalogs", table: "sla_policies", basePath: "/sla-policies",
  fields: {
    code: { schema: z.string().min(1) }, name: { schema: z.string().min(1) }, target_hours: { schema: z.number().int().positive() },
    warn_percent: { schema: z.number().int().min(1).max(100).optional() }, business_hours_only: { schema: z.boolean().optional() },
    extra: { schema: zJson.optional(), cast: "jsonb" },
  },
  defaultOrder: "code",
}));

catalogs.route("/", crud({
  permissions: { read: "catalogs:read", write: "catalogs:write" }, tag: "Parameters", table: "parameters", basePath: "/parameters",
  fields: {
    key: { schema: z.string().min(1) }, value: { schema: z.unknown(), cast: "jsonb" }, description: { schema: z.string().optional() },
    delegation_id: { schema: zUuid.nullable().optional() },
  },
  readonly: ["updated_at"], search: ["key", "description"], filters: ["delegation_id"], defaultOrder: "key",
}));

