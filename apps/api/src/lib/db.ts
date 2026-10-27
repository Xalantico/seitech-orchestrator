import { createPool, withActor, type DbActor } from "@orchestrador/db";
import type pg from "pg";

import { env } from "../env.js";
import type { Principal } from "./principal.js";

export const pool = createPool(env.DATABASE_URL, { max: env.DB_POOL_MAX, applicationName: "orq-api" });

export function actorOf(principal: Principal | undefined, requestId?: string, ip?: string): DbActor {
  if (!principal) return { system: true, label: "anonymous-system", requestId, ip };
  return {
    userId: principal.kind === "user" ? principal.id : null,
    label: principal.label,
    scopeAll: principal.scopeAll,
    scopes: principal.scopes,
    requestId,
    ip,
  };
}

export type Tx = pg.PoolClient;

/** Convenience used by handlers: `await run(c, (db) => db.query(...))`. */
export function run<T>(
  c: { get(key: "principal"): Principal | undefined; get(key: "requestId"): string | undefined; get(key: "ip"): string | undefined },
  fn: (db: Tx) => Promise<T>,
): Promise<T> {
  return withActor(pool, actorOf(c.get("principal"), c.get("requestId"), c.get("ip")), fn);
}

/** System-level access for background loops that have no principal. */
export function runSystem<T>(fn: (db: Tx) => Promise<T>): Promise<T> {
  return withActor(pool, { system: true, label: "api-system" }, fn);
}
