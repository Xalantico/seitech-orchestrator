import pg from "pg";

export { withActor, withSystem, SYSTEM_ACTOR, type DbActor } from "./scope.js";
export { migrate, listMigrations, type MigrateResult } from "./migrate.js";
export { seedBase, seedDemo } from "./seed.js";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

// NUMERIC/BIGINT come back as strings by default; BIGINT identities fit in a JS number.
pg.types.setTypeParser(20, (value) => Number(value));

export function createPool(connectionString: string, options: { max?: number; applicationName?: string } = {}): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? "orchestrador",
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
}
