import { sha256 } from "@orchestrador/platform";
import { annotateContext } from "@orchestrador/observability";
import type { MiddlewareHandler } from "hono";

import { bearerRoles, verifyBearer } from "../auth/oidc.js";
import { getSession } from "../auth/session.js";
import { runSystem } from "../lib/db.js";
import { HttpError } from "../lib/errors.js";
import { can, loadUserPrincipal, type Principal } from "../lib/principal.js";
import type { AppEnv } from "../lib/types.js";
import { trackUsage } from "../lib/usage.js";

async function apiKeyPrincipal(key: string): Promise<Principal | null> {
  const match = /^orq_([a-z0-9]{8})_[A-Za-z0-9_-]{20,}$/.exec(key);
  if (!match) return null;
  return runSystem(async (db) => {
    const r = await db.query<{
      id: string; name: string; key_hash: string; permissions: string[]; role_perms: string[] | null;
      scope_all: boolean; delegation_id: string | null; rate_limit_per_min: number;
    }>(
      `SELECT k.id, k.name, k.key_hash, k.permissions, k.scope_all, k.delegation_id, k.rate_limit_per_min,
              (SELECT array_agg(rp.permission_key) FROM role_permissions rp WHERE rp.role_id = k.role_id) AS role_perms
       FROM api_keys k
       WHERE k.prefix = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())`,
      [match[1]],
    );
    const row = r.rows[0];
    if (!row || row.key_hash !== sha256(key)) return null;
    await db.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [row.id]);
    return {
      kind: "api_key" as const,
      id: row.id,
      label: `api-key:${row.name}`,
      roles: [],
      permissions: new Set([...(row.permissions ?? []), ...(row.role_perms ?? [])]),
      scopeAll: row.scope_all,
      scopes: row.delegation_id ? [{ d: row.delegation_id, z: null, p: null }] : [],
      mfa: true,
      locale: "es",
      rateLimitPerMin: row.rate_limit_per_min,
    };
  });
}

async function servicePrincipal(email: string | undefined, sub: string, roles: string[]): Promise<Principal | null> {
  return runSystem(async (db) => {
    const known = await db.query<{ key: string; perms: string[] }>(
      `SELECT r.key, coalesce(array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS perms
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE r.key = ANY($1::text[]) GROUP BY r.key`,
      [roles],
    );
    if (known.rows.length === 0) return null;
    return {
      kind: "service" as const,
      id: sub,
      label: `service:${email ?? sub}`,
      roles: known.rows.map((r) => r.key),
      permissions: new Set(known.rows.flatMap((r) => r.perms)),
      scopeAll: roles.includes("admin"),
      scopes: [],
      mfa: true,
      locale: "es",
    };
  });
}

/** Resolves the caller (session cookie, API key, or bearer JWT) without requiring one. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization");
  const apiKey = c.req.header("x-api-key") ?? (header?.startsWith("Bearer orq_") ? header.slice(7) : undefined);
  let principal: Principal | null = null;

  if (apiKey) {
    principal = await apiKeyPrincipal(apiKey);
    if (!principal) throw new HttpError(401, "Invalid API key", "unauthenticated");
  } else if (header?.startsWith("Bearer ")) {
    const claims = await verifyBearer(header.slice(7));
    if (!claims?.sub) throw new HttpError(401, "Invalid token", "unauthenticated");
    principal = await servicePrincipal(typeof claims.email === "string" ? claims.email : undefined, claims.sub, bearerRoles(claims));
    if (!principal) throw new HttpError(403, "Token carries no known role", "forbidden");
  } else {
    const session = await getSession(c);
    if (session) {
      principal = await loadUserPrincipal(session.userId, session.mfa);
      if (principal) c.set("sessionId", session.id);
    }
  }

  if (principal) {
    c.set("principal", principal);
    annotateContext({ userId: principal.id });
    if (principal.kind === "user") trackUsage(principal.id);
  }
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  if (!c.get("principal")) throw new HttpError(401, "No autenticado", "unauthenticated");
  return next();
};

/** Passes when the caller holds ALL listed permissions (system:admin implies everything). */
export function requirePermission(...permissions: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal) throw new HttpError(401, "No autenticado", "unauthenticated");
    const missing = permissions.filter((p) => !can(principal, p));
    if (missing.length > 0) throw new HttpError(403, "No tienes permiso para esta acción", "forbidden", { missing });
    return next();
  };
}
