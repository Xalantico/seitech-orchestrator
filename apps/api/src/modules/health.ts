import { metrics } from "@orchestrador/observability";
import { Hono } from "hono";

import { env } from "../env.js";
import { pool } from "../lib/db.js";
import { redis } from "../lib/services.js";
import { getTemporal } from "../lib/temporal.js";

export const health = new Hono();

health.get("/healthz", (c) => c.json({ ok: true }));

/** Readiness checks every hard dependency so the proxy can drain a broken replica (RNF-13, RNF-026). */
health.get("/readyz", async (c) => {
  const checks: Record<string, "up" | "down"> = {};
  await Promise.all([
    pool.query("SELECT 1").then(() => (checks.postgres = "up"), () => (checks.postgres = "down")),
    getTemporal().then((t) => t.workflowService.getSystemInfo({})).then(() => (checks.temporal = "up"), () => (checks.temporal = "down")),
    redis ? redis.ping().then(() => (checks.redis = "up"), () => (checks.redis = "down")) : Promise.resolve(),
  ]);
  const ok = Object.values(checks).every((v) => v === "up");
  return c.json({ ok, checks, env: env.APP_ENV }, ok ? 200 : 503);
});

health.get("/metrics", async (c) => {
  const out = await metrics.registry.metrics();
  return c.body(out, 200, { "content-type": metrics.registry.contentType });
});

health.get("/api/health", (c) => c.json({ ok: true }));
