import { createPool, withSystem } from "@orchestrador/db";
import { createLogger, type Logger } from "@orchestrador/observability";
import type pg from "pg";

import { env } from "./env.js";

export const log: Logger = createLogger("worker", env.LOG_LEVEL);
export const pool = createPool(env.DATABASE_URL, { max: env.DB_POOL_MAX, applicationName: "orq-worker" });

/** Activities act as the system: flow side effects are authorised by the flow, not by a user session. */
export function sys<T>(fn: (db: pg.PoolClient) => Promise<T>, label = "worker"): Promise<T> {
  return withSystem(pool, async (db) => {
    await db.query("SELECT set_config('app.actor', $1, true)", [label]);
    return fn(db);
  });
}
