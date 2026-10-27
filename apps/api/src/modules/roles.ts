import { OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@orchestrador/shared";

import { run } from "../lib/db.js";
import { HttpError, notFound } from "../lib/errors.js";
import { invalidatePrincipal } from "../lib/principal.js";
import { define, z } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";

export const roles = new OpenAPIHono<AppEnv>();
const TAG = "Roles";
const uuid = z.string().uuid();

define(roles, { method: "get", path: "/permissions", tag: TAG, summary: "Permission catalog", permission: "roles:read" }, (c) => c.json({ items: PERMISSIONS }));

define(roles, { method: "get", path: "/roles", tag: TAG, summary: "List roles with their permissions", permission: "roles:read" }, async (c) => {
  const r = await run(c, (db) =>
    db.query(
      `SELECT r.id, r.key, r.name, r.description, r.is_system,
              coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions,
              (SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS users
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id ORDER BY r.is_system DESC, r.name`,
    ),
  );
  return c.json({ items: r.rows });
});

const roleBody = z.object({ key: z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/), name: z.string().min(1), description: z.string().default(""), permissions: z.array(z.string()).default([]) });

async function validatePermissions(keys: string[]) {
  const known = new Set(PERMISSIONS.map((p) => p.key));
  const bad = keys.filter((k) => !known.has(k));
  if (bad.length) throw new HttpError(400, `Unknown permissions: ${bad.join(", ")}`, "bad_request");
}

define(roles, { method: "post", path: "/roles", tag: TAG, summary: "Create a custom role", permission: "roles:write", status: 201, body: roleBody }, async (c, i) => {
  await validatePermissions(i.body.permissions);
  const id = await run(c, async (db) => {
    const r = await db.query<{ id: string }>("INSERT INTO roles (key, name, description) VALUES ($1, $2, $3) RETURNING id", [i.body.key, i.body.name, i.body.description]);
    await db.query("INSERT INTO role_permissions (role_id, permission_key) SELECT $1, unnest($2::text[])", [r.rows[0]!.id, i.body.permissions]);
    return r.rows[0]!.id;
  });
  return c.json({ id, ...i.body }, 201);
});

define(roles, { method: "put", path: "/roles/{id}", tag: TAG, summary: "Edit a role and its permissions", permission: "roles:write", params: z.object({ id: uuid }), body: roleBody.partial().omit({ key: true }) }, async (c, i) => {
  if (i.body.permissions) await validatePermissions(i.body.permissions);
  await run(c, async (db) => {
    const role = (await db.query<{ key: string }>("SELECT key FROM roles WHERE id = $1", [i.params.id])).rows[0];
    if (!role) throw notFound("Role");
    if (role.key === "admin" && i.body.permissions) throw new HttpError(409, "The admin role always holds every permission", "conflict");
    await db.query("UPDATE roles SET name = coalesce($2, name), description = coalesce($3, description) WHERE id = $1", [i.params.id, i.body.name ?? null, i.body.description ?? null]);
    if (i.body.permissions) {
      await db.query("DELETE FROM role_permissions WHERE role_id = $1", [i.params.id]);
      await db.query("INSERT INTO role_permissions (role_id, permission_key) SELECT $1, unnest($2::text[])", [i.params.id, i.body.permissions]);
    }
  });
  invalidatePrincipal();
  return c.json({ ok: true });
});

define(roles, { method: "delete", path: "/roles/{id}", tag: TAG, summary: "Delete a custom role", permission: "roles:write", params: z.object({ id: uuid }) }, async (c, i) => {
  const r = await run(c, (db) => db.query("DELETE FROM roles WHERE id = $1 AND NOT is_system RETURNING id", [i.params.id]));
  if (!r.rows[0]) throw new HttpError(409, "System roles cannot be deleted", "conflict");
  invalidatePrincipal();
  return c.json({ ok: true });
});
