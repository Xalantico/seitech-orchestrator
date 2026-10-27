import { env } from "../env.js";
import { log } from "../lib/services.js";

/**
 * Optional user provisioning in Keycloak (ORF-051: "alta, baja, bloqueo ... y con API"). Local
 * state always wins: failures are reported to the caller as `sync: "failed"` but never block.
 */
export function keycloakAdminEnabled(): boolean {
  return Boolean(env.KEYCLOAK_ADMIN_URL && env.KEYCLOAK_ADMIN_CLIENT_ID && env.KEYCLOAK_ADMIN_CLIENT_SECRET);
}

let token: { value: string; exp: number } | undefined;

async function adminToken(): Promise<string> {
  if (token && token.exp > Date.now() + 10_000) return token.value;
  const realmUrl = env.KEYCLOAK_ADMIN_URL!.replace(/\/$/, "");
  const response = await fetch(`${realmUrl.replace("/admin/realms/", "/realms/")}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.KEYCLOAK_ADMIN_CLIENT_ID!,
      client_secret: env.KEYCLOAK_ADMIN_CLIENT_SECRET!,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Keycloak token ${response.status}`);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 };
  return token.value;
}

async function kc(path: string, init: RequestInit = {}): Promise<Response> {
  const base = env.KEYCLOAK_ADMIN_URL!.replace(/\/$/, "");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await adminToken()}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
}

async function findUserId(email: string): Promise<string | null> {
  const r = await kc(`/users?email=${encodeURIComponent(email)}&exact=true`);
  if (!r.ok) throw new Error(`Keycloak user lookup ${r.status}`);
  const users = (await r.json()) as { id: string }[];
  return users[0]?.id ?? null;
}

export type SyncResult = "synced" | "skipped" | "failed";

export async function keycloakUpsertUser(input: { email: string; name?: string | null; enabled: boolean; roles?: string[] }): Promise<SyncResult> {
  if (!keycloakAdminEnabled()) return "skipped";
  try {
    let id = await findUserId(input.email);
    if (!id) {
      const created = await kc("/users", {
        method: "POST",
        body: JSON.stringify({
          username: input.email,
          email: input.email,
          firstName: input.name ?? undefined,
          enabled: input.enabled,
          emailVerified: false,
          requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"],
        }),
      });
      if (!created.ok && created.status !== 409) throw new Error(`create ${created.status}`);
      id = await findUserId(input.email);
    } else {
      await kc(`/users/${id}`, { method: "PUT", body: JSON.stringify({ enabled: input.enabled }) });
    }
    if (id && input.roles) {
      const all = await kc("/roles");
      const defs = ((await all.json()) as { id: string; name: string }[]).filter((r) => input.roles!.includes(r.name));
      await kc(`/users/${id}/role-mappings/realm`, { method: "POST", body: JSON.stringify(defs) });
    }
    return "synced";
  } catch (error) {
    log.warn({ err: (error as Error).message, email: input.email }, "keycloak sync failed");
    return "failed";
  }
}

export async function keycloakLogoutUser(email: string): Promise<void> {
  if (!keycloakAdminEnabled()) return;
  try {
    const id = await findUserId(email);
    if (id) await kc(`/users/${id}/logout`, { method: "POST" });
  } catch (error) {
    log.warn({ err: (error as Error).message }, "keycloak logout failed");
  }
}
