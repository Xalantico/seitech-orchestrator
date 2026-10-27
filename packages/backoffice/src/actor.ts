import type { DbActor } from "@orchestrador/db";
import type pg from "pg";

export type UserActor = { actor: DbActor; permissions: ReadonlySet<string>; email: string };

/**
 * What a user may see and do right now, loaded from the database. Scheduled work runs "as" its creator, so a user who
 * lost a role or their access stops receiving data the moment that changes.
 */
export async function loadUserActor(db: Pick<pg.PoolClient, "query">, userId: string): Promise<UserActor | null> {
  const u = (await db.query<{ id: string; email: string; status: string; scope_all: boolean; permissions: string[] | null }>(
    `SELECT u.id, u.email::text AS email, u.status, u.scope_all,
            (SELECT array_agg(DISTINCT rp.permission_key) FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id) AS permissions
       FROM users u WHERE u.id = $1`,
    [userId],
  )).rows[0];
  if (!u || u.status !== "active") return null;
  const scopes = (await db.query<{ d: string | null; z: string | null; p: string | null }>("SELECT delegation_id AS d, zone_id AS z, project_id AS p FROM user_scopes WHERE user_id = $1", [userId])).rows;
  return { actor: { userId: u.id, label: u.email, scopeAll: u.scope_all, scopes }, permissions: new Set(u.permissions ?? []), email: u.email };
}

export const hasPermission = (a: UserActor, permission: string) => a.permissions.has("system:admin") || a.permissions.has(permission);
