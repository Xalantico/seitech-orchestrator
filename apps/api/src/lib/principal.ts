import { ALL_PERMISSION_KEYS } from "@orchestrador/shared";

import { env } from "../env.js";
import { runSystem } from "./db.js";

export type ScopeRule = { d: string | null; z: string | null; p: string | null };

export type Principal = {
  kind: "user" | "api_key" | "service";
  id: string;
  label: string;
  email?: string;
  displayName?: string;
  roles: string[];
  permissions: ReadonlySet<string>;
  scopeAll: boolean;
  scopes: ScopeRule[];
  mfa: boolean;
  locale: string;
  rateLimitPerMin?: number;
};

export function can(principal: Principal, permission: string): boolean {
  return principal.permissions.has("system:admin") || principal.permissions.has(permission);
}

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { at: number; value: Omit<Principal, "mfa"> | null }>();

export function invalidatePrincipal(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

type UserRow = {
  id: string;
  email: string;
  display_name: string | null;
  status: string;
  scope_all: boolean;
  locale: string;
  roles: string[] | null;
  permissions: string[] | null;
};

export async function loadUserPrincipal(userId: string, mfa: boolean): Promise<Principal | null> {
  const hit = cache.get(userId);
  let base = hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.value : undefined;
  if (base === undefined) {
    base = await runSystem(async (db) => {
      const u = await db.query<UserRow>(
        `SELECT u.id, u.email::text AS email, u.display_name, u.status, u.scope_all, u.locale,
                coalesce((SELECT array_agg(r.key) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '{}') AS roles,
                coalesce((SELECT array_agg(DISTINCT rp.permission_key) FROM user_roles ur
                          JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id), '{}') AS permissions
         FROM users u WHERE u.id = $1`,
        [userId],
      );
      const row = u.rows[0];
      if (!row || row.status !== "active") return null;
      const scopes = await db.query<{ d: string | null; z: string | null; p: string | null }>(
        `SELECT delegation_id AS d, zone_id AS z, project_id AS p FROM user_scopes WHERE user_id = $1`,
        [userId],
      );
      return {
        kind: "user" as const,
        id: row.id,
        label: row.email,
        email: row.email,
        displayName: row.display_name ?? row.email,
        roles: row.roles ?? [],
        permissions: new Set(row.permissions ?? []),
        scopeAll: row.scope_all,
        scopes: scopes.rows,
        locale: row.locale,
      };
    });
    cache.set(userId, { at: Date.now(), value: base });
  }
  if (!base) return null;

  const permissions = new Set(base.permissions);
  if (permissions.has("system:admin")) for (const key of ALL_PERMISSION_KEYS) permissions.add(key);
  // RNF-26: personal customer data needs a second factor.
  if (env.requireMfaForPii && !mfa) permissions.delete("customers:pii");
  return { ...base, permissions, mfa };
}
