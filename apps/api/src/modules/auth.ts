import { OpenAPIHono } from "@hono/zod-openapi";
import { getCookie } from "hono/cookie";

import { requestOtp, normalizeEmail, verifyOtp } from "../auth/otp.js";
import { completeLogin, logoutUrl, safeReturnTo, startLogin } from "../auth/oidc.js";
import { upsertOidcUser } from "../auth/provision.js";
import { endSession, SESSION_COOKIE, startSession } from "../auth/session.js";
import { env } from "../env.js";
import { runSystem } from "../lib/db.js";
import { HttpError } from "../lib/errors.js";
import { define, z } from "../lib/route.js";
import { log } from "../lib/services.js";
import type { AppEnv } from "../lib/types.js";
import { limiter } from "../middleware/core.js";

export const auth = new OpenAPIHono<AppEnv>();
auth.use("/auth/*", limiter("auth"));

const userSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  scopeAll: z.boolean(),
  mfa: z.boolean(),
  locale: z.string(),
});

define(
  auth,
  { method: "get", path: "/auth/config", tag: "Auth", summary: "Login mode for the front end", public: true, response: z.object({ mode: z.enum(["otp", "oidc"]) }) },
  (c) => c.json({ mode: env.AUTH_MODE }),
);

define(auth, { method: "get", path: "/auth/login", tag: "Auth", summary: "Start the OIDC login (redirects to the identity provider)", public: true, status: 302, query: z.object({ returnTo: z.string().optional() }) }, async (c, i) => {
  if (env.AUTH_MODE !== "oidc") throw new HttpError(404, "OIDC login is not enabled", "not_found");
  return c.redirect(await startLogin(i.query?.returnTo ?? "/"));
});

define(auth, { method: "get", path: "/auth/callback", tag: "Auth", summary: "OIDC redirect target", public: true, status: 302, query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }) }, async (c, i) => {
  if (env.AUTH_MODE !== "oidc") throw new HttpError(404, "OIDC login is not enabled", "not_found");
  const fail = (reason: string) => c.redirect(`${env.WEB_ORIGIN}/?login_error=${encodeURIComponent(reason)}`);
  if (i.query?.error || !i.query?.code || !i.query?.state) return fail(i.query?.error ?? "missing_code");
  try {
    const { claims, returnTo } = await completeLogin(i.query.code, i.query.state);
    const userId = await upsertOidcUser(claims);
    if (!userId) return fail("not_authorized");
    await startSession(c, userId, { mfa: claims.mfa, method: "oidc", idToken: claims.idToken, ip: c.get("ip") });
    return c.redirect(`${env.WEB_ORIGIN}${safeReturnTo(returnTo)}`);
  } catch (error) {
    log.warn({ err: (error as Error).message }, "oidc callback failed");
    return fail("login_failed");
  }
});

define(auth, { method: "post", path: "/auth/request-otp", tag: "Auth", summary: "Send a one-time code (otp mode only)", public: true, body: z.object({ email: z.string() }), response: z.object({ ok: z.literal(true) }) }, async (c, i) => {
  if (env.AUTH_MODE !== "otp") throw new HttpError(404, "OTP login is disabled", "not_found");
  const email = normalizeEmail(i.body.email);
  if (!email) throw new HttpError(400, "Correo no válido", "bad_request");
  await requestOtp(email).catch((error) => {
    log.error({ err: (error as Error).message }, "request-otp failed");
    throw new HttpError(502, "No se pudo enviar el código", "upstream");
  });
  return c.json({ ok: true });
});

define(auth, { method: "post", path: "/auth/verify-otp", tag: "Auth", summary: "Exchange the one-time code for a session", public: true, body: z.object({ email: z.string(), code: z.string() }) }, async (c, i) => {
  if (env.AUTH_MODE !== "otp") throw new HttpError(404, "OTP login is disabled", "not_found");
  const email = normalizeEmail(i.body.email);
  const code = String(i.body.code).trim();
  if (!email || !/^\d{6}$/.test(code)) throw new HttpError(400, "Código no válido", "bad_request");
  const userId = await verifyOtp(email, code);
  if (!userId) throw new HttpError(401, "Código incorrecto o caducado", "unauthenticated");
  await startSession(c, userId, { mfa: false, method: "otp", ip: c.get("ip") });
  return c.json({ ok: true });
});

define(auth, { method: "post", path: "/auth/logout", tag: "Auth", summary: "End the session", public: true }, async (c) => {
  const had = Boolean(getCookie(c, SESSION_COOKIE));
  const hint = await endSession(c);
  return c.json({ ok: true, loggedOut: had, redirect: await logoutUrl(hint).catch(() => null) });
});

define(auth, { method: "get", path: "/auth/me", tag: "Auth", summary: "Current identity and effective permissions", authenticated: true, response: z.object({ user: userSchema }) }, (c) => {
  const p = c.get("principal");
  return c.json({
    user: {
      id: p.id,
      email: p.email,
      displayName: p.displayName,
      roles: p.roles,
      permissions: [...p.permissions].sort(),
      scopeAll: p.scopeAll,
      mfa: p.mfa,
      locale: p.locale,
    },
  });
});

define(auth, { method: "patch", path: "/auth/me", tag: "Auth", summary: "Update own profile (language)", authenticated: true, body: z.object({ locale: z.enum(["es", "en", "ca"]) }) }, async (c, i) => {
  const p = c.get("principal");
  if (p.kind !== "user") throw new HttpError(400, "Only users have a profile", "bad_request");
  await runSystem((db) => db.query("UPDATE users SET locale = $2 WHERE id = $1", [p.id, i.body.locale]));
  return c.json({ ok: true });
});
