import { OpenAPIHono } from "@hono/zod-openapi";

import { run } from "../lib/db.js";
import { invalidatePrincipal } from "../lib/principal.js";
import { define, z } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";

export const usage = new OpenAPIHono<AppEnv>();

/** RNF-03 / RNF-037: lets an admin find low-usage licences and deactivate them. */
define(usage, { method: "get", path: "/usage/report", tag: "Usage", summary: "Licence usage per user", permission: "usage:read", query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30), lowThreshold: z.coerce.number().int().min(0).default(20) }) }, async (c, i) => {
  const r = await run(c, (db) =>
    db.query(
      `SELECT u.id, u.email::text AS email, u.display_name, u.status, u.last_login_at,
              coalesce(sum(d.requests), 0)::int AS requests, count(d.day)::int AS active_days, max(d.last_seen) AS last_seen,
              coalesce((SELECT array_agg(r.key) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '{}') AS roles
       FROM users u LEFT JOIN usage_daily d ON d.user_id = u.id AND d.day > current_date - $1::int
       GROUP BY u.id ORDER BY requests ASC, u.email`,
      [i.query.days],
    ),
  );
  const items = r.rows.map((u) => ({ ...u, lowUsage: u.status === "active" && u.requests < i.query.lowThreshold }));
  const summary = {
    activeUsers: items.filter((u) => u.status === "active").length,
    lowUsage: items.filter((u) => u.lowUsage).length,
    executions: (await run(c, (db) => db.query<{ n: number }>("SELECT count(*)::int AS n FROM executions WHERE created_at > now() - make_interval(days => $1)", [i.query.days]))).rows[0]?.n ?? 0,
  };
  return c.json({ days: i.query.days, summary, items });
});

define(usage, { method: "post", path: "/usage/deactivate", tag: "Usage", summary: "Deactivate licences of low-usage users", permission: ["usage:read", "users:write"], body: z.object({ userIds: z.array(z.string().uuid()).min(1).max(500) }) }, async (c, i) => {
  const self = c.get("principal").id;
  const r = await run(c, (db) =>
    db.query("UPDATE users SET status = 'disabled' WHERE id = ANY($1::uuid[]) AND id <> $2 AND status = 'active' RETURNING id", [i.body.userIds, self]),
  );
  for (const row of r.rows) invalidatePrincipal(row.id);
  return c.json({ deactivated: r.rows.length });
});
