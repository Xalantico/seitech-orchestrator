import { OpenAPIHono } from "@hono/zod-openapi";
import { randomBytes } from "node:crypto";
import { randomToken, sha256 } from "@orchestrador/platform";

import { run } from "../lib/db.js";
import { notFound } from "../lib/errors.js";
import { define, z } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";

export const apiKeys = new OpenAPIHono<AppEnv>();
const TAG = "API keys";

define(apiKeys, { method: "get", path: "/api-keys", tag: TAG, summary: "List API keys (never returns the secret)", permission: "apikeys:manage" }, async (c) => {
  const r = await run(c, (db) => db.query(`SELECT id, name, prefix, role_id, permissions, scope_all, delegation_id, rate_limit_per_min, expires_at, last_used_at, revoked_at, created_at FROM api_keys ORDER BY created_at DESC`));
  return c.json({ items: r.rows });
});

define(apiKeys, { method: "post", path: "/api-keys", tag: TAG, summary: "Create an API key; the secret is shown once", permission: "apikeys:manage", status: 201, body: z.object({ name: z.string().min(1), roleId: z.string().uuid().optional(), permissions: z.array(z.string()).default([]), scopeAll: z.boolean().default(false), delegationId: z.string().uuid().optional(), rateLimitPerMin: z.number().int().min(10).max(100_000).default(600), expiresAt: z.string().datetime().optional() }) }, async (c, i) => {
  const prefix = randomBytes(4).toString("hex");
  const key = `orq_${prefix}_${randomToken(24)}`;
  const b = i.body;
  const row = await run(c, (db) =>
    db.query(
      `INSERT INTO api_keys (name, prefix, key_hash, role_id, permissions, scope_all, delegation_id, rate_limit_per_min, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, name, prefix, expires_at, created_at`,
      [b.name, prefix, sha256(key), b.roleId ?? null, b.permissions, b.scopeAll, b.delegationId ?? null, b.rateLimitPerMin, b.expiresAt ?? null, c.get("principal").kind === "user" ? c.get("principal").id : null],
    ),
  );
  return c.json({ ...row.rows[0], key }, 201);
});

define(apiKeys, { method: "post", path: "/api-keys/{id}/revoke", tag: TAG, summary: "Revoke an API key", permission: "apikeys:manage", params: z.object({ id: z.string().uuid() }) }, async (c, i) => {
  const r = await run(c, (db) => db.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id", [i.params.id]));
  if (!r.rows[0]) throw notFound("API key");
  return c.json({ ok: true });
});
