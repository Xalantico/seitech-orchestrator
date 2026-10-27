import { OpenAPIHono } from "@hono/zod-openapi";

import { run, type Tx } from "./db.js";
import { HttpError, notFound } from "./errors.js";
import { define, z } from "./route.js";
import type { AppEnv } from "./types.js";

export type VersionedConfig = {
  tag: string;
  basePath: string;
  parentTable: string;
  versionTable: string;
  fk: string;
  permissions: { read: string; write: string; publish: string };
  /** Extra columns accepted when creating the parent. */
  parentFields?: z.ZodRawShape;
  /** Returns blocking problems for a definition (empty = publishable). */
  validate(definition: unknown): { errors: string[]; warnings?: string[] };
  /** Parent columns to insert beyond key/name/description: column → body field. */
  extraColumns?: Record<string, string>;
};

const uuid = z.string().uuid();

/**
 * Registers the common lifecycle of a versioned artefact (state machines, rule sets): list, create (with v1 draft),
 * read, new draft versions, edit drafts, publish (retires the previous published version), validate.
 * Published versions are immutable: edits go to a new draft, running executions stay pinned (ORF-013).
 */
export function versionedRoutes(cfg: VersionedConfig): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  const { basePath: base } = cfg;
  const definition = z.record(z.unknown());
  const extra = Object.keys(cfg.extraColumns ?? {});

  define(app, { method: "get", path: base, tag: cfg.tag, summary: `List (${base})`, permission: cfg.permissions.read, query: z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) }, async (c, i) => {
    const r = await run(c, (db) =>
      db.query(
        `SELECT p.*, pub.version AS published_version,
                (SELECT max(version) FROM ${cfg.versionTable} WHERE ${cfg.fk} = p.id) AS latest_version
         FROM ${cfg.parentTable} p
         LEFT JOIN LATERAL (SELECT version FROM ${cfg.versionTable} WHERE ${cfg.fk} = p.id AND state = 'published' ORDER BY version DESC LIMIT 1) pub ON true
         WHERE ($1::text IS NULL OR p.key ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%')
         ORDER BY p.key LIMIT $2`,
        [i.query.q ?? null, i.query.limit],
      ),
    );
    return c.json({ items: r.rows });
  });

  define(app, {
    method: "post", path: base, tag: cfg.tag, summary: "Create with a first draft version", permission: cfg.permissions.write, status: 201,
    body: z.object({ key: z.string().regex(/^[a-z][a-z0-9_.-]*$/), name: z.string().min(1), description: z.string().default(""), definition, ...(cfg.parentFields ?? {}) }),
  }, async (c, i) => {
    const b = i.body as Record<string, unknown> & { key: string; name: string; description: string; definition: Record<string, unknown> };
    const checked = cfg.validate(b.definition);
    const row = await run(c, async (db) => {
      const cols = ["key", "name", "description", ...extra];
      const parent = await db.query(`INSERT INTO ${cfg.parentTable} (${cols.join(", ")}) VALUES (${cols.map((_, n) => `$${n + 1}`).join(", ")}) RETURNING *`, cols.map((k) => b[cfg.extraColumns?.[k] ?? k] ?? null));
      const principal = c.get("principal");
      await db.query(`INSERT INTO ${cfg.versionTable} (${cfg.fk}, version, state, definition, created_by) VALUES ($1, 1, 'draft', $2::jsonb, $3)`, [parent.rows[0].id, JSON.stringify(b.definition), principal?.kind === "user" ? principal.id : null]);
      return parent.rows[0];
    });
    return c.json({ ...row, validation: checked }, 201);
  });

  define(app, { method: "post", path: `${base}/validate`, tag: cfg.tag, summary: "Validate a definition without saving", permission: cfg.permissions.read, body: z.object({ definition }) }, async (c, i) =>
    c.json(cfg.validate(i.body.definition)),
  );

  define(app, { method: "get", path: `${base}/{id}`, tag: cfg.tag, summary: "Read with all versions", permission: cfg.permissions.read, params: z.object({ id: uuid }) }, async (c, i) => {
    const out = await run(c, async (db) => {
      const parent = (await db.query(`SELECT * FROM ${cfg.parentTable} WHERE id = $1`, [i.params.id])).rows[0];
      if (!parent) return null;
      const versions = (await db.query(`SELECT * FROM ${cfg.versionTable} WHERE ${cfg.fk} = $1 ORDER BY version DESC`, [parent.id])).rows;
      return { ...parent, versions };
    });
    if (!out) throw notFound(cfg.tag);
    return c.json(out);
  });

  define(app, { method: "post", path: `${base}/{id}/versions`, tag: cfg.tag, summary: "Create a new draft version (optionally from a definition)", permission: cfg.permissions.write, status: 201, params: z.object({ id: uuid }), body: z.object({ definition: definition.optional() }) }, async (c, i) => {
    const row = await run(c, async (db) => {
      await db.query(`SELECT 1 FROM ${cfg.parentTable} WHERE id = $1 FOR UPDATE`, [i.params.id]);
      const last = (await db.query(`SELECT version, state, definition FROM ${cfg.versionTable} WHERE ${cfg.fk} = $1 ORDER BY version DESC LIMIT 1`, [i.params.id])).rows[0];
      if (!last) throw notFound(cfg.tag);
      if (last.state === "draft" && !i.body.definition) throw new HttpError(409, "A draft already exists: edit it or publish it", "draft_exists");
      const def = i.body.definition ?? last.definition;
      const principal = c.get("principal");
      const r = await db.query(`INSERT INTO ${cfg.versionTable} (${cfg.fk}, version, state, definition, created_by) VALUES ($1, $2, 'draft', $3::jsonb, $4) RETURNING *`, [i.params.id, last.version + 1, JSON.stringify(def), principal?.kind === "user" ? principal.id : null]);
      return r.rows[0];
    });
    return c.json({ ...row, validation: cfg.validate(row.definition) }, 201);
  });

  const versionParams = z.object({ id: uuid, version: z.coerce.number().int().positive() });
  const draftOf = async (db: Tx, id: string, version: number) => {
    const row = (await db.query(`SELECT * FROM ${cfg.versionTable} WHERE ${cfg.fk} = $1 AND version = $2 FOR UPDATE`, [id, version])).rows[0];
    if (!row) throw notFound("Version");
    return row;
  };

  define(app, { method: "put", path: `${base}/{id}/versions/{version}`, tag: cfg.tag, summary: "Edit a draft version", permission: cfg.permissions.write, params: versionParams, body: z.object({ definition }) }, async (c, i) => {
    const row = await run(c, async (db) => {
      const cur = await draftOf(db, i.params.id, i.params.version);
      if (cur.state !== "draft") throw new HttpError(409, "Only drafts can be edited; create a new version", "not_draft");
      return (await db.query(`UPDATE ${cfg.versionTable} SET definition = $2::jsonb WHERE id = $1 RETURNING *`, [cur.id, JSON.stringify(i.body.definition)])).rows[0];
    });
    return c.json({ ...row, validation: cfg.validate(row.definition) });
  });

  define(app, { method: "post", path: `${base}/{id}/versions/{version}/publish`, tag: cfg.tag, summary: "Publish a draft (retires the previous published version)", permission: cfg.permissions.publish, params: versionParams }, async (c, i) => {
    const row = await run(c, async (db) => {
      const cur = await draftOf(db, i.params.id, i.params.version);
      if (cur.state !== "draft") throw new HttpError(409, "Only drafts can be published", "not_draft");
      const checked = cfg.validate(cur.definition);
      if (checked.errors.length > 0) throw new HttpError(422, "The definition has errors", "invalid_definition", checked);
      await db.query(`UPDATE ${cfg.versionTable} SET state = 'retired' WHERE ${cfg.fk} = $1 AND state = 'published'`, [i.params.id]);
      return (await db.query(`UPDATE ${cfg.versionTable} SET state = 'published' WHERE id = $1 RETURNING *`, [cur.id])).rows[0];
    });
    return c.json(row);
  });

  return app;
}
