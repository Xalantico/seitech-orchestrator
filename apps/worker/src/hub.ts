import { withSystem } from "@orchestrador/db";
import { registerAllAdapters } from "@orchestrador/connectors";
import type { Db, HubDeps } from "@orchestrador/connector-sdk";
import { readSecret } from "@orchestrador/platform";

import { env } from "./env.js";
import { documentGateway, objectGateway } from "./gateways.js";
import { log, pool } from "./services.js";

registerAllAdapters();

/**
 * One system transaction per statement. The hub claims rows with a single UPDATE ... RETURNING and calls external
 * systems between statements, so it must not hold a transaction (and its row locks) open during network calls.
 */
export const systemDb: Db = {
  query: (sql, params) => withSystem(pool, async (db) => {
    await db.query("SELECT set_config('app.actor', 'integration-hub', true)");
    return db.query(sql, params as unknown[]);
  }) as never,
};

async function inTransaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return withSystem(pool, async (db) => {
    await db.query("SELECT set_config('app.actor', 'integration-hub', true)");
    return fn(db as unknown as Db);
  });
}

export const hubDeps: HubDeps = { db: systemDb, transaction: inTransaction, log, readSecret: (ref) => readSecret(ref) as Promise<Record<string, string>>, piiKey: env.piiKey, documents: documentGateway, objects: objectGateway };
