import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { env } from "../env.js";
import { runSystem } from "../lib/db.js";

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
};

let discovery: { at: number; doc: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> } | undefined;

async function getDiscovery() {
  if (discovery && Date.now() - discovery.at < 3_600_000) return discovery;
  const url = env.OIDC_DISCOVERY_URL ?? `${env.OIDC_ISSUER!.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`OIDC discovery failed (${response.status}) at ${url}`);
  const doc = (await response.json()) as Discovery;
  discovery = { at: Date.now(), doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
  return discovery;
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const redirectUri = () => `${env.publicApiUrl.replace(/\/$/, "")}/api/v1/auth/callback`;

export async function startLogin(returnTo: string): Promise<string> {
  const { doc } = await getDiscovery();
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  await runSystem(async (db) => {
    await db.query("DELETE FROM oidc_transactions WHERE expires_at < now()");
    await db.query(
      `INSERT INTO oidc_transactions (state, nonce, code_verifier, return_to, expires_at) VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
      [state, nonce, verifier, safeReturnTo(returnTo)],
    );
  });
  const url = new URL(doc.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: env.OIDC_CLIENT_ID!,
    redirect_uri: redirectUri(),
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Only same-origin relative paths are allowed to avoid open redirects. */
export function safeReturnTo(value: string | undefined): string {
  return value && /^\/(?!\/)[\w\-./?=&%#]*$/.test(value) ? value : "/";
}

export type OidcClaims = {
  sub: string;
  email: string;
  name: string | null;
  roles: string[];
  delegations: string[] | null;
  scopeAll: boolean;
  mfa: boolean;
  idToken: string;
};

function rolesOf(payload: JWTPayload): string[] {
  const direct = payload.roles;
  if (Array.isArray(direct)) return direct.map(String);
  const realm = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
  return Array.isArray(realm) ? realm.map(String) : [];
}

function mfaOf(payload: JWTPayload): boolean {
  if (env.oidcAssumeMfa) return true;
  const amr = payload.amr;
  return Array.isArray(amr) && amr.some((m) => ["otp", "mfa", "hwk", "webauthn", "totp"].includes(String(m)));
}

function claimsFrom(payload: JWTPayload, idToken: string): OidcClaims {
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!email || !payload.sub) throw new Error("ID token has no email/sub");
  return {
    sub: payload.sub,
    email,
    name: typeof payload.name === "string" ? payload.name : null,
    roles: rolesOf(payload),
    delegations: Array.isArray(payload.delegations) ? payload.delegations.map(String) : null,
    scopeAll: payload.scope_all === true || payload.scope_all === "true",
    mfa: mfaOf(payload),
    idToken,
  };
}

export async function completeLogin(code: string, state: string): Promise<{ claims: OidcClaims; returnTo: string }> {
  const tx = await runSystem(async (db) => {
    const r = await db.query<{ nonce: string; code_verifier: string; return_to: string }>(
      `DELETE FROM oidc_transactions WHERE state = $1 AND expires_at > now() RETURNING nonce, code_verifier, return_to`,
      [state],
    );
    return r.rows[0];
  });
  if (!tx) throw new Error("Unknown or expired login transaction");
  const { doc, jwks } = await getDiscovery();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: env.OIDC_CLIENT_ID!,
    code_verifier: tx.code_verifier,
  });
  if (env.OIDC_CLIENT_SECRET) body.set("client_secret", env.OIDC_CLIENT_SECRET);
  const response = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Token exchange failed (${response.status})`);
  const tokens = (await response.json()) as { id_token?: string; access_token?: string };
  if (!tokens.id_token) throw new Error("No id_token returned");
  const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: env.OIDC_ISSUER, audience: env.OIDC_CLIENT_ID });
  if (payload.nonce !== tx.nonce) throw new Error("Nonce mismatch");
  const claims = claimsFrom(payload, tokens.id_token);
  if (claims.roles.length === 0 && tokens.access_token) {
    const access = await jwtVerify(tokens.access_token, jwks, { issuer: env.OIDC_ISSUER }).catch(() => null);
    if (access) claims.roles = rolesOf(access.payload);
  }
  return { claims, returnTo: tx.return_to };
}

/** Verifies a bearer JWT for machine clients (service accounts, integrations). */
export async function verifyBearer(token: string): Promise<JWTPayload | null> {
  if (env.AUTH_MODE !== "oidc") return null;
  try {
    const { jwks } = await getDiscovery();
    const { payload } = await jwtVerify(token, jwks, { issuer: env.OIDC_ISSUER });
    if (env.OIDC_AUDIENCE) {
      const aud = ([] as string[]).concat((payload.aud as string | string[] | undefined) ?? []);
      if (!aud.includes(env.OIDC_AUDIENCE) && payload.azp !== env.OIDC_CLIENT_ID) return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function bearerRoles(payload: JWTPayload): string[] {
  return rolesOf(payload);
}

export async function logoutUrl(idTokenHint: string | null): Promise<string | null> {
  if (env.AUTH_MODE !== "oidc") return null;
  const { doc } = await getDiscovery();
  if (!doc.end_session_endpoint) return null;
  const url = new URL(doc.end_session_endpoint);
  url.searchParams.set("post_logout_redirect_uri", env.WEB_ORIGIN);
  url.searchParams.set("client_id", env.OIDC_CLIENT_ID!);
  if (idTokenHint) url.searchParams.set("id_token_hint", idTokenHint);
  return url.toString();
}
