import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const LOCK_KEY = 7_483_921;

export type MigrateResult = { applied: string[]; skipped: string[] };

export async function listMigrations(): Promise<{ name: string; sql: string; checksum: string }[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }),
  );
}

/**
 * Applies pending SQL migrations in order, one transaction each, under an advisory lock so that
 * concurrent replicas cannot race. Applied files are checksummed; editing one is an error.
 * `appRole` (optional) is the least-privilege role the API and workers connect as.
 * `biRole` (optional) is the read-only role Metabase connects as; it only sees the flat `bi` views.
 */
export async function migrate(
  connectionString: string,
  options: { appRole?: { name: string; password?: string }; biRole?: { name: string; password?: string } } = {},
): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );

    for (const migration of await listMigrations()) {
      const existing = done.get(migration.name);
      if (existing) {
        if (existing !== migration.checksum) {
          throw new Error(`Migration ${migration.name} was modified after being applied`);
        }
        result.skipped.push(migration.name);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.bypass', 'on', true)");
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          migration.name,
          migration.checksum,
        ]);
        await client.query("COMMIT");
        result.applied.push(migration.name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${migration.name} failed: ${error instanceof Error ? error.message : error}`);
      }
    }

    if (options.appRole) {
      await ensureAppRole(client, options.appRole.name, options.appRole.password);
    }
    if (options.biRole) {
      await ensureBiRole(client, options.biRole.name, options.biRole.password);
    }
    await client.query("SELECT ensure_audit_partitions(3)");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return result;
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Invalid role name: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Creates the least-privilege runtime role: no superuser, no BYPASSRLS, DML only. The audit log is
 * writable only through SECURITY DEFINER triggers, so the app can never rewrite history.
 */
async function ensureAppRole(client: pg.Client, name: string, password?: string): Promise<void> {
  const role = ident(name);
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  }
  if (password) {
    await client.query(`ALTER ROLE ${role} PASSWORD ${pg.escapeLiteral(password)}`);
  }
  const db = (await client.query<{ current_database: string }>("SELECT current_database()")).rows[0]!.current_database;
  await client.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
  await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_log FROM ${role}`);
  await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_chain_head FROM ${role}`);
  await client.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${role}`);
}

/**
 * Read-only reporting role. It has no access to `public` tables, only to the `bi` views (no personal data). The views read
 * tables that have row-level security, so this role's sessions run with `app.bypass` on (a role-level default): safe because
 * the role can touch nothing else, and it is what makes dashboards show every delegation.
 */
async function ensureBiRole(client: pg.Client, name: string, password?: string): Promise<void> {
  const role = ident(name);
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  }
  if (password) {
    await client.query(`ALTER ROLE ${role} PASSWORD ${pg.escapeLiteral(password)}`);
  }
  const db = (await client.query<{ current_database: string }>("SELECT current_database()")).rows[0]!.current_database;
  await client.query(`ALTER ROLE ${role} SET app.bypass = 'on'`);
  await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
  await client.query(`ALTER ROLE ${role} SET statement_timeout = '60s'`);
  await client.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO ${role}`);
  await client.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA bi TO ${role}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA bi TO ${role}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA bi GRANT SELECT ON TABLES TO ${role}`);
}
