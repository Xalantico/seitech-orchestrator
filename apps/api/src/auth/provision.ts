import { env } from "../env.js";
import { runSystem, type Tx } from "../lib/db.js";
import { invalidatePrincipal } from "../lib/principal.js";
import { log } from "../lib/services.js";
import type { OidcClaims } from "./oidc.js";

/** RNF-28: returns the first forbidden pair found in a set of role keys. */
export async function findToxicConflict(db: Tx, roleKeys: string[]): Promise<{ a: string; b: string; reason: string } | null> {
  if (roleKeys.length < 2) return null;
  const r = await db.query<{ role_a: string; role_b: string; reason: string }>(
    `SELECT role_a, role_b, reason FROM toxic_role_combinations WHERE role_a = ANY($1) AND role_b = ANY($1) LIMIT 1`,
    [roleKeys],
  );
  const row = r.rows[0];
  return row ? { a: row.role_a, b: row.role_b, reason: row.reason } : null;
}

export async function setUserRoles(db: Tx, userId: string, roleKeys: string[]): Promise<void> {
  const conflict = await findToxicConflict(db, roleKeys);
  if (conflict) {
    throw Object.assign(new Error(`Toxic role combination ${conflict.a} + ${conflict.b}: ${conflict.reason}`), { toxic: conflict });
  }
  await db.query("DELETE FROM user_roles WHERE user_id = $1", [userId]);
  await db.query(
    `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = ANY($2::text[])`,
    [userId, roleKeys],
  );
  invalidatePrincipal(userId);
}

/**
 * Finds or creates the local user for a verified OIDC identity and (when the IdP sends them)
 * synchronises roles and delegation scope. Keycloak is the authority for identity; this table is
 * the authority for what the user may do inside the Orquestador.
 */
export async function upsertOidcUser(claims: OidcClaims): Promise<string | null> {
  return runSystem(async (db) => {
    let found = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE external_id = $1 OR email = $2 ORDER BY (external_id = $1) DESC LIMIT 1`,
      [claims.sub, claims.email],
    );
    if (!found.rows[0]) {
      const bootstrap = env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase() === claims.email;
      if (!env.oidcAutoProvision && !bootstrap) return null;
      found = await db.query(
        `INSERT INTO users (email, display_name, external_id, scope_all, mfa_enrolled) VALUES ($1, $2, $3, $4, $5) RETURNING id, status`,
        [claims.email, claims.name ?? claims.email, claims.sub, bootstrap, claims.mfa],
      );
      if (bootstrap) {
        await db.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'admin' ON CONFLICT DO NOTHING`, [found.rows[0]!.id]);
      }
    }
    const user = found.rows[0]!;
    if (user.status !== "active") return null;
    await db.query(
      `UPDATE users SET external_id = $2, display_name = coalesce($3, display_name), mfa_enrolled = mfa_enrolled OR $4 WHERE id = $1`,
      [user.id, claims.sub, claims.name, claims.mfa],
    );

    const known = await db.query<{ key: string }>("SELECT key FROM roles WHERE key = ANY($1::text[])", [claims.roles]);
    const roleKeys = known.rows.map((r) => r.key);
    if (roleKeys.length > 0) {
      try {
        await setUserRoles(db, user.id, roleKeys);
      } catch (error) {
        log.warn({ user: claims.email, err: (error as Error).message }, "role sync rejected by segregation-of-duties policy");
      }
    }
    if (claims.scopeAll) {
      await db.query("UPDATE users SET scope_all = true WHERE id = $1", [user.id]);
    }
    if (claims.delegations) {
      await db.query("DELETE FROM user_scopes WHERE user_id = $1", [user.id]);
      await db.query(
        `INSERT INTO user_scopes (user_id, delegation_id) SELECT $1, id FROM delegations WHERE code = ANY($2::text[])`,
        [user.id, claims.delegations],
      );
    }
    invalidatePrincipal(user.id);
    return user.id;
  });
}
