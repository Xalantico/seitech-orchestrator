import { OpenAPIHono } from "@hono/zod-openapi";

import { keycloakLogoutUser, keycloakUpsertUser } from "../auth/keycloak-admin.js";
import { findToxicConflict, setUserRoles } from "../auth/provision.js";
import { revokeUserSessions } from "../auth/session.js";
import { run } from "../lib/db.js";
import { HttpError, notFound } from "../lib/errors.js";
import { invalidatePrincipal } from "../lib/principal.js";
import { define, z } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";

export const users = new OpenAPIHono<AppEnv>();
const TAG = "Users";

const uuid = z.string().uuid();
const scopeSchema = z.object({ delegationId: uuid.nullable(), zoneId: uuid.nullable().optional(), projectId: uuid.nullable().optional() });

const SELECT = `
  SELECT u.id, u.email::text AS email, u.display_name, u.status, u.scope_all, u.locale, u.mfa_enrolled,
         u.last_login_at, u.created_at,
         coalesce((SELECT array_agg(r.key ORDER BY r.key) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '{}') AS roles,
         coalesce((SELECT jsonb_agg(jsonb_build_object('delegationId', s.delegation_id, 'zoneId', s.zone_id, 'projectId', s.project_id))
                   FROM user_scopes s WHERE s.user_id = u.id), '[]') AS scopes
  FROM users u`;

define(users, { method: "get", path: "/users", tag: TAG, summary: "List users", permission: "users:read", query: z.object({ q: z.string().optional(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }) }, async (c, i) => {
  const params: unknown[] = [];
  const where: string[] = [];
  if (i.query.q) { params.push(`%${i.query.q}%`); where.push(`(u.email::text ILIKE $${params.length} OR u.display_name ILIKE $${params.length})`); }
  if (i.query.status) { params.push(i.query.status); where.push(`u.status = $${params.length}`); }
  const rows = await run(c, (db) => db.query(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY u.email LIMIT ${i.query.limit} OFFSET ${i.query.offset}`, params));
  return c.json({ items: rows.rows });
});

define(users, { method: "get", path: "/users/{id}", tag: TAG, summary: "Get a user", permission: "users:read", params: z.object({ id: uuid }) }, async (c, i) => {
  const row = (await run(c, (db) => db.query(`${SELECT} WHERE u.id = $1`, [i.params.id]))).rows[0];
  if (!row) throw notFound("User");
  return c.json(row);
});

define(users, { method: "post", path: "/users", tag: TAG, summary: "Create a user (alta)", permission: "users:write", status: 201, body: z.object({ email: z.string().email(), displayName: z.string().optional(), roles: z.array(z.string()).default([]), scopeAll: z.boolean().default(false), locale: z.enum(["es", "en", "ca"]).default("es"), scopes: z.array(scopeSchema).default([]) }) }, async (c, i) => {
  const b = i.body;
  const result = await run(c, async (db) => {
    const created = await db.query<{ id: string }>(
      `INSERT INTO users (email, display_name, scope_all, locale) VALUES ($1, $2, $3, $4) RETURNING id`,
      [b.email.toLowerCase(), b.displayName ?? b.email, b.scopeAll, b.locale],
    );
    const id = created.rows[0]!.id;
    try { await setUserRoles(db, id, b.roles); } catch (e) { throw new HttpError(409, (e as Error).message, "toxic_roles"); }
    for (const s of b.scopes) await db.query("INSERT INTO user_scopes (user_id, delegation_id, zone_id, project_id) VALUES ($1, $2, $3, $4)", [id, s.delegationId, s.zoneId ?? null, s.projectId ?? null]);
    return id;
  });
  const sync = await keycloakUpsertUser({ email: b.email.toLowerCase(), name: b.displayName, enabled: true, roles: b.roles });
  const row = (await run(c, (db) => db.query(`${SELECT} WHERE u.id = $1`, [result]))).rows[0];
  return c.json({ ...row, keycloakSync: sync }, 201);
});

define(users, { method: "patch", path: "/users/{id}", tag: TAG, summary: "Update, block (bloqueo) or deactivate (baja) a user", permission: "users:write", params: z.object({ id: uuid }), body: z.object({ displayName: z.string().optional(), status: z.enum(["active", "blocked", "disabled"]).optional(), scopeAll: z.boolean().optional(), locale: z.enum(["es", "en", "ca"]).optional() }) }, async (c, i) => {
  const b = i.body;
  const p = c.get("principal");
  if (b.status && b.status !== "active" && p.id === i.params.id) throw new HttpError(409, "You cannot block yourself", "conflict");
  const row = await run(c, async (db) => {
    const r = await db.query(
      `UPDATE users SET display_name = coalesce($2, display_name), status = coalesce($3, status),
              scope_all = coalesce($4, scope_all), locale = coalesce($5, locale) WHERE id = $1 RETURNING email::text AS email, display_name, status`,
      [i.params.id, b.displayName ?? null, b.status ?? null, b.scopeAll ?? null, b.locale ?? null],
    );
    return r.rows[0] as { email: string; display_name: string; status: string } | undefined;
  });
  if (!row) throw notFound("User");
  invalidatePrincipal(i.params.id);
  let sync = "skipped";
  if (b.status) {
    if (b.status !== "active") { await revokeUserSessions(i.params.id); await keycloakLogoutUser(row.email); }
    sync = await keycloakUpsertUser({ email: row.email, name: row.display_name, enabled: b.status === "active" });
  }
  const full = (await run(c, (db) => db.query(`${SELECT} WHERE u.id = $1`, [i.params.id]))).rows[0];
  return c.json({ ...full, keycloakSync: sync });
});

define(users, { method: "put", path: "/users/{id}/roles", tag: TAG, summary: "Assign roles (segregation-of-duties checked)", permission: "users:write", params: z.object({ id: uuid }), body: z.object({ roles: z.array(z.string()) }) }, async (c, i) => {
  await run(c, async (db) => {
    const conflict = await findToxicConflict(db, i.body.roles);
    if (conflict) throw new HttpError(409, `Combinación de roles no permitida (${conflict.a} + ${conflict.b}): ${conflict.reason}`, "toxic_roles", conflict);
    await setUserRoles(db, i.params.id, i.body.roles);
  });
  const email = (await run(c, (db) => db.query<{ email: string }>("SELECT email::text AS email FROM users WHERE id = $1", [i.params.id]))).rows[0]?.email;
  if (email) await keycloakUpsertUser({ email, enabled: true, roles: i.body.roles });
  return c.json({ ok: true, roles: i.body.roles });
});

define(users, { method: "put", path: "/users/{id}/scopes", tag: TAG, summary: "Assign delegation / zone / project scope (ORF-057)", permission: "users:write", params: z.object({ id: uuid }), body: z.object({ scopes: z.array(scopeSchema) }) }, async (c, i) => {
  await run(c, async (db) => {
    await db.query("DELETE FROM user_scopes WHERE user_id = $1", [i.params.id]);
    for (const s of i.body.scopes) await db.query("INSERT INTO user_scopes (user_id, delegation_id, zone_id, project_id) VALUES ($1, $2, $3, $4)", [i.params.id, s.delegationId, s.zoneId ?? null, s.projectId ?? null]);
  });
  invalidatePrincipal(i.params.id);
  return c.json({ ok: true });
});

define(users, { method: "post", path: "/users/{id}/revoke-sessions", tag: TAG, summary: "Force sign-out everywhere", permission: "users:write", params: z.object({ id: uuid }) }, async (c, i) => {
  await revokeUserSessions(i.params.id);
  return c.json({ ok: true });
});
