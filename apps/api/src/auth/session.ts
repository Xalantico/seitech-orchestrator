import { randomToken, sha256 } from "@orchestrador/platform";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { env } from "../env.js";
import { runSystem } from "../lib/db.js";

export const SESSION_COOKIE = "orch_session";
const TOUCH_INTERVAL_MS = 60_000;
const lastTouch = new Map<string, number>();

export type SessionInfo = { id: string; userId: string; mfa: boolean; method: string; idTokenHint: string | null };

export async function startSession(
  c: Context,
  userId: string,
  options: { mfa: boolean; method: "otp" | "oidc"; idToken?: string; ip?: string },
): Promise<void> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 86_400_000);
  await runSystem(async (db) => {
    await db.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, mfa, auth_method, id_token_hint, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [sha256(token), userId, expiresAt, options.mfa, options.method, options.idToken ?? null, options.ip ?? null, c.req.header("user-agent")?.slice(0, 300) ?? null],
    );
    await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
    await db.query("SELECT audit_event('login', 'users', $1, $2::jsonb)", [userId, JSON.stringify({ method: options.method, mfa: options.mfa })]);
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.secureCookies,
    path: "/",
    expires: expiresAt,
  });
}

export async function getSession(c: Context): Promise<SessionInfo | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const hash = sha256(token);
  const row = await runSystem(async (db) => {
    const r = await db.query<{ id: string; user_id: string; mfa: boolean; auth_method: string; id_token_hint: string | null }>(
      `SELECT id, user_id, mfa, auth_method, id_token_hint FROM sessions WHERE token_hash = $1 AND expires_at > now()`,
      [hash],
    );
    const found = r.rows[0];
    const now = Date.now();
    if (found && now - (lastTouch.get(hash) ?? 0) > TOUCH_INTERVAL_MS) {
      lastTouch.set(hash, now);
      await db.query("UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1", [hash]);
      if (lastTouch.size > 20_000) lastTouch.clear();
    }
    return found;
  });
  return row ? { id: row.id, userId: row.user_id, mfa: row.mfa, method: row.auth_method, idTokenHint: row.id_token_hint } : null;
}

export async function endSession(c: Context): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE);
  let hint: string | null = null;
  if (token) {
    hint = await runSystem(async (db) => {
      const r = await db.query<{ id_token_hint: string | null }>(
        "DELETE FROM sessions WHERE token_hash = $1 RETURNING id_token_hint",
        [sha256(token)],
      );
      return r.rows[0]?.id_token_hint ?? null;
    });
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return hint;
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await runSystem((db) => db.query("DELETE FROM sessions WHERE user_id = $1", [userId]));
}
