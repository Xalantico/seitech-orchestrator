import { SpanKind, metrics, runWithContext, withSpan } from "@orchestrador/observability";
import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

import { env } from "../env.js";
import { errorBody, HttpError, toHttpError } from "../lib/errors.js";
import { log, rateLimit } from "../lib/services.js";
import type { AppEnv } from "../lib/types.js";

export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || c.req.header("x-real-ip") || "unknown";
}

/** Request id, correlation context, access log, metrics and a server span (RNF-015, RNF-034). */
export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.set("requestId", requestId);
  c.set("ip", clientIp(c));
  c.header("x-request-id", requestId);
  const started = performance.now();
  await runWithContext({ requestId }, () =>
    withSpan(
      `${c.req.method} ${c.req.path}`,
      async (span) => {
        await next();
        span.setAttribute("http.status_code", c.res.status);
      },
      { kind: SpanKind.SERVER, headers: Object.fromEntries(c.req.raw.headers.entries()), attributes: { "http.method": c.req.method } },
    ),
  );
  const seconds = (performance.now() - started) / 1000;
  const route = c.req.routePath ?? "unmatched";
  metrics.httpRequests.inc({ method: c.req.method, route, status: String(c.res.status) });
  metrics.httpDuration.observe({ method: c.req.method, route }, seconds);
  if (c.req.path !== "/healthz" && c.req.path !== "/readyz" && c.req.path !== "/metrics") {
    log.info(
      { requestId, method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(seconds * 1000), user: c.get("principal")?.label },
      "request",
    );
  }
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Cross-Origin-Resource-Policy", "same-site");
  c.header("Permissions-Policy", "geolocation=(self), camera=(), microphone=()");
  if (env.secureCookies) c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  if (!c.req.path.startsWith("/api/docs")) c.header("Cache-Control", "no-store");
};

/** Fixed-window limiter; `auth` routes get the stricter bucket (brute-force protection). */
export function limiter(kind: "auth" | "api"): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    const limit =
      kind === "auth" ? env.AUTH_RATE_LIMIT_PER_MIN : principal?.rateLimitPerMin ?? env.RATE_LIMIT_PER_MIN;
    const key = kind === "auth" ? `auth:${clientIp(c)}` : `api:${principal ? principal.id : clientIp(c)}`;
    const result = await rateLimit(key, limit, 60).catch(() => ({ allowed: true, remaining: limit, resetSec: 60 }));
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      c.header("Retry-After", String(result.resetSec));
      throw new HttpError(429, "Too many requests", "rate_limited");
    }
    await next();
  };
}

export function handleError(error: Error, c: Context<AppEnv>) {
  const http = toHttpError(error);
  if (http.status >= 500) {
    log.error({ err: error.message, stack: error.stack, path: c.req.path }, "unhandled error");
  }
  return c.json(errorBody(http), http.status);
}
