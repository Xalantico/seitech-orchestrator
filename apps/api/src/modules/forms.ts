import { OpenAPIHono } from "@hono/zod-openapi";

import { zJson, zUuid } from "../lib/crud.js";
import { run } from "../lib/db.js";
import { conflict, notFound } from "../lib/errors.js";
import { define, z } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";

const TAG = "Forms";
const idParam = z.object({ id: zUuid });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/** A version is usable today when it is published and today falls inside its validity window (ORF-093). */
const CURRENT = "fv.state = 'published' AND (fv.valid_from IS NULL OR fv.valid_from <= current_date) AND (fv.valid_to IS NULL OR fv.valid_to >= current_date)";

export const forms = new OpenAPIHono<AppEnv>();

define(forms, {
  method: "get", path: "/forms", tag: TAG, summary: "Forms with their current version (local and imported from the field tool)", permission: "forms:read",
  query: z.object({ source: z.enum(["local", "fsm"]).optional(), q: z.string().optional(), current: z.enum(["true", "false"]).optional() }),
}, async (c, i) => {
  const q = i.query as { source?: string; q?: string; current?: string };
  const r = await run(c, (db) =>
    db.query(
      `SELECT f.id, f.key, f.name, f.source, f.created_at,
              (SELECT count(*)::int FROM form_versions WHERE form_id = f.id) AS versions,
              (SELECT jsonb_build_object('id', fv.id, 'version', fv.version, 'validFrom', fv.valid_from, 'validTo', fv.valid_to)
                 FROM form_versions fv WHERE fv.form_id = f.id AND ${CURRENT} ORDER BY fv.version DESC LIMIT 1) AS current_version
         FROM forms f
        WHERE ($1::text IS NULL OR f.source = $1) AND ($2::text IS NULL OR f.key ILIKE '%' || $2 || '%' OR f.name ILIKE '%' || $2 || '%')
        ORDER BY f.key`,
      [q.source ?? null, q.q ?? null],
    ),
  );
  const rows = q.current === undefined ? r.rows : r.rows.filter((f) => (q.current === "true") === Boolean(f.current_version));
  return c.json({ items: rows, total: rows.length });
});

define(forms, {
  method: "get", path: "/forms/{id}/versions", tag: TAG, summary: "Versions of a form, flagging which are current and which expired", permission: "forms:read", params: idParam,
  query: z.object({ state: z.enum(["draft", "published", "retired"]).optional(), current: z.enum(["true", "false"]).optional() }),
}, async (c, i) => {
  const q = i.query as { state?: string; current?: string };
  const r = await run(c, (db) =>
    db.query(
      `SELECT fv.id, fv.version, fv.state, fv.valid_from, fv.valid_to, fv.attributes, fv.external_ref, fv.created_at,
              (${CURRENT}) AS current,
              (fv.valid_to IS NOT NULL AND fv.valid_to < current_date) AS expired
         FROM form_versions fv WHERE fv.form_id = $1 AND ($2::text IS NULL OR fv.state = $2)
         ORDER BY fv.version DESC`,
      [i.params.id, q.state ?? null],
    ),
  );
  const rows = q.current === undefined ? r.rows : r.rows.filter((v) => (q.current === "true") === Boolean(v.current));
  return c.json({ items: rows, total: rows.length });
});

define(forms, {
  method: "get", path: "/form-versions/{id}", tag: TAG, summary: "A form version with its schema", permission: "forms:read", params: idParam,
}, async (c, i) => {
  const r = await run(c, (db) =>
    db.query(
      `SELECT fv.*, f.key AS form_key, f.name AS form_name, f.source, (${CURRENT}) AS current FROM form_versions fv JOIN forms f ON f.id = fv.form_id WHERE fv.id = $1`,
      [i.params.id],
    ),
  );
  if (!r.rows[0]) throw notFound("Form version");
  return c.json(r.rows[0]);
});

define(forms, {
  method: "post", path: "/forms", tag: TAG, summary: "Create a local form", permission: "forms:write", status: 201,
  body: z.object({ key: z.string().regex(/^[a-z][a-z0-9_.-]*$/), name: z.string().min(1) }),
}, async (c, i) => {
  const b = i.body as { key: string; name: string };
  const r = await run(c, async (db) => {
    const exists = await db.query("SELECT 1 FROM forms WHERE key = $1", [b.key]);
    if (exists.rowCount) throw conflict(`The form "${b.key}" already exists`, "form_exists");
    return db.query("INSERT INTO forms (key, name, source) VALUES ($1, $2, 'local') RETURNING *", [b.key, b.name]);
  });
  return c.json(r.rows[0], 201);
});

define(forms, {
  method: "post", path: "/forms/{id}/versions", tag: TAG, summary: "Publish a new version of a local form (versions are immutable)", permission: "forms:write", params: idParam, status: 201,
  body: z.object({ schema: zJson, uiSchema: zJson.optional(), validFrom: date.nullable().optional(), validTo: date.nullable().optional(), attributes: zJson.optional() }),
}, async (c, i) => {
  const b = i.body as { schema: Record<string, unknown>; uiSchema?: Record<string, unknown>; validFrom?: string | null; validTo?: string | null; attributes?: Record<string, unknown> };
  if (b.validFrom && b.validTo && b.validTo < b.validFrom) throw conflict("The end of validity is before its start", "invalid_validity");
  const r = await run(c, async (db) => {
    const form = (await db.query<{ source: string }>("SELECT source FROM forms WHERE id = $1 FOR UPDATE", [i.params.id])).rows[0];
    if (!form) throw notFound("Form");
    if (form.source === "fsm") throw conflict("Forms from the field tool are versioned there and cannot be edited here", "form_managed_externally");
    return db.query(
      `INSERT INTO form_versions (form_id, version, state, schema, ui_schema, valid_from, valid_to, attributes)
       SELECT $1, coalesce(max(version), 0) + 1, 'published', $2::jsonb, $3::jsonb, $4, $5, $6::jsonb FROM form_versions WHERE form_id = $1 RETURNING *`,
      [i.params.id, JSON.stringify(b.schema), JSON.stringify(b.uiSchema ?? {}), b.validFrom ?? null, b.validTo ?? null, JSON.stringify(b.attributes ?? {})],
    );
  });
  return c.json(r.rows[0], 201);
});

define(forms, {
  method: "post", path: "/form-versions/{id}/retire", tag: TAG, summary: "Retire a form version so it can no longer be assigned", permission: "forms:write", params: idParam,
}, async (c, i) => {
  const r = await run(c, (db) => db.query("UPDATE form_versions SET state = 'retired' WHERE id = $1 RETURNING id, state", [i.params.id]));
  if (!r.rows[0]) throw notFound("Form version");
  return c.json(r.rows[0]);
});

// ───────────── assignment to visits ─────────────
define(forms, {
  method: "put", path: "/visits/{id}/form", tag: TAG, summary: "Assign a form version to a visit (the field tool receives it with the visit)", permission: ["visits:write", "forms:read"], params: idParam,
  body: z.object({ formVersionId: zUuid.nullable() }),
}, async (c, i) => {
  const b = i.body as { formVersionId: string | null };
  const r = await run(c, async (db) => {
    if (b.formVersionId) {
      const v = (await db.query<{ ok: boolean; state: string }>(`SELECT (${CURRENT}) AS ok, fv.state FROM form_versions fv WHERE fv.id = $1`, [b.formVersionId])).rows[0];
      if (!v) throw notFound("Form version");
      if (!v.ok) throw conflict("That form version is not current (retired, not yet valid or expired)", "form_not_current");
    }
    return db.query(
      "UPDATE visits SET form_version_id = $2, form_state = CASE WHEN $2::uuid IS NULL THEN NULL ELSE 'pending' END, updated_at = now() WHERE id = $1 RETURNING id, form_version_id, form_state",
      [i.params.id, b.formVersionId],
    );
  });
  if (!r.rows[0]) throw notFound("Visit");
  return c.json(r.rows[0]);
});

const ORDER = ["pending", "in_progress", "completed", "validated"] as const;
define(forms, {
  method: "put", path: "/visits/{id}/form-state", tag: TAG, summary: "Move the form of a visit forward: pending, in progress, completed, validated", permission: "visits:write", params: idParam,
  body: z.object({ state: z.enum(ORDER) }),
}, async (c, i) => {
  const b = i.body as { state: (typeof ORDER)[number] };
  const r = await run(c, async (db) => {
    const v = (await db.query<{ form_version_id: string | null; form_state: (typeof ORDER)[number] | null }>("SELECT form_version_id, form_state FROM visits WHERE id = $1 FOR UPDATE", [i.params.id])).rows[0];
    if (!v) throw notFound("Visit");
    if (!v.form_version_id) throw conflict("The visit has no form assigned", "no_form");
    if (ORDER.indexOf(b.state) < ORDER.indexOf(v.form_state ?? "pending")) throw conflict(`The form cannot go back from ${v.form_state} to ${b.state}`, "invalid_form_state");
    return db.query("UPDATE visits SET form_state = $2, updated_at = now() WHERE id = $1 RETURNING id, form_version_id, form_state", [i.params.id, b.state]);
  });
  return c.json(r.rows[0]);
});
