import type pg from "pg";

/** Identity a database session acts as. Drives row-level security and the audit trigger. */
export type DbActor = {
  /** System actors (worker, schedulers, migrations) skip data-scope filtering. */
  system?: boolean;
  userId?: string | null;
  label?: string;
  ip?: string;
  requestId?: string;
  scopeAll?: boolean;
  scopes?: readonly { d?: string | null; z?: string | null; p?: string | null }[];
};

export const SYSTEM_ACTOR: DbActor = { system: true, label: "system" };

async function applyActor(client: pg.PoolClient, actor: DbActor): Promise<void> {
  const settings: [string, string][] = [
    ["app.bypass", actor.system ? "on" : "off"],
    ["app.scope_all", actor.scopeAll ? "on" : "off"],
    ["app.scopes", JSON.stringify(actor.scopes ?? [])],
    ["app.actor", actor.label ?? ""],
    ["app.actor_id", actor.userId ?? ""],
    ["app.ip", actor.ip ?? ""],
    ["app.request_id", actor.requestId ?? ""],
  ];
  for (const [key, value] of settings) {
    // set_config(..., true) is transaction-local, so pooled connections never leak scope.
    await client.query("SELECT set_config($1, $2, true)", [key, value]);
  }
}

/** Runs `fn` in a transaction with the actor's scope applied. Commits on success. */
export async function withActor<T>(
  pool: pg.Pool,
  actor: DbActor,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await applyActor(client, actor);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function withSystem<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withActor(pool, SYSTEM_ACTOR, fn);
}
