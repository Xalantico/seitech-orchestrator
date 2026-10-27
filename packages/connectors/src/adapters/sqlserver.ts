import { permanent, receiveInbound, transient, type Adapter, type ConnectorContext } from "@orchestrador/connector-sdk";

import { asObj, isObj, list, need, str, type Obj } from "../util.js";

export type SqlDriver = { query(sql: string, params: Obj): Promise<{ rows: Obj[]; rowsAffected: number }>; close(): Promise<void> };
export type SqlDriverFactory = (cfg: { server: string; database: string; port?: number; user: string; password: string; encrypt: boolean }) => Promise<SqlDriver>;

let factory: SqlDriverFactory | undefined;
/** Tests (and deployments with another client library) plug the driver in here. */
export function setSqlDriverFactory(f: SqlDriverFactory | undefined): void {
  factory = f;
}

/** Default driver: the `mssql` package, loaded on demand so deployments without SQL Server do not need it. */
const defaultFactory: SqlDriverFactory = async (cfg) => {
  let mssql: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    mssql = await import(/* @vite-ignore */ "mssql" as string);
  } catch {
    throw permanent("driver_missing", 'Install the "mssql" package in the worker image to use SQL Server connectors');
  }
  const pool = await new mssql.default.ConnectionPool({ server: cfg.server, database: cfg.database, port: cfg.port, user: cfg.user, password: cfg.password, options: { encrypt: cfg.encrypt, trustServerCertificate: false }, requestTimeout: 30_000 }).connect();
  return {
    async query(sql, params) {
      const req = pool.request();
      for (const [k, v] of Object.entries(params)) req.input(k, v);
      const r = await req.query(sql);
      return { rows: (r.recordset ?? []) as Obj[], rowsAffected: Array.isArray(r.rowsAffected) ? r.rowsAffected.reduce((a: number, b: number) => a + b, 0) : 0 };
    },
    close: () => pool.close(),
  };
};

type Statement = { sql: string; params?: string[]; mode?: "read" | "write" };
const statements = (ctx: ConnectorContext): Record<string, Statement> => asObj(asObj(ctx.connector.config).statements) as Record<string, Statement>;
const MAX_ROWS = 10_000;

async function open(ctx: ConnectorContext): Promise<SqlDriver> {
  const c = asObj(asObj(ctx.connector.config).sql);
  const server = str(c.server);
  const database = str(c.database);
  if (!server || !database) throw permanent("config_missing", 'Set "sql.server" and "sql.database" in the connector settings');
  try {
    return await (factory ?? defaultFactory)({ server, database, ...(c.port ? { port: Number(c.port) } : {}), user: ctx.secrets.user ?? "", password: ctx.secrets.password ?? "", encrypt: c.encrypt !== false });
  } catch (e) {
    if (e instanceof Error && "retryable" in e) throw e;
    throw transient("sql_connect", `Cannot connect to SQL Server: ${e instanceof Error ? e.message : "error"}`);
  }
}

/** Binds a named statement's parameters; anything not declared is rejected. There is no way to send free SQL. */
function bind(name: string, st: Statement, input: Obj): Obj {
  const declared = st.params ?? [];
  const unknown = Object.keys(input).filter((k) => !declared.includes(k));
  if (unknown.length > 0) throw permanent("input_invalid", `Statement "${name}" does not take: ${unknown.join(", ")}`);
  return Object.fromEntries(declared.map((k) => [k, input[k] ?? null]));
}

/**
 * SQL Server (RNF-018): only statements declared by an administrator in the connector settings can run, with bound
 * parameters. Statements are `read` (default) or `write`; the action decides which kind it may run.
 */
export const sqlServerAdapter: Adapter = {
  kind: "sqlserver",
  label: "SQL Server",
  description: "Consultas y operaciones con nombre contra una base SQL Server de otro sistema. Solo se ejecutan sentencias declaradas por un administrador, con parámetros enlazados.",
  configSchema: [
    { key: "sql", label: "Conexión {server, database, port, encrypt}", type: "json", required: true },
    { key: "statements", label: "Sentencias {nombre: {sql, params, mode}}", type: "json", required: true },
    { key: "feeds", label: "Lecturas para la sincronización [{statement, eventType, idColumn, updatedColumn}]", type: "json" },
  ],
  actions: [
    {
      key: "query", label: "Ejecutar consulta", direction: "pull", idempotent: true,
      input: [{ key: "statement", label: "Sentencia", type: "string", required: true }, { key: "params", label: "Parámetros", type: "json" }],
      async run(ctx, input) {
        const name = need(input, "statement");
        const st = statements(ctx)[name];
        if (!st || (st.mode ?? "read") !== "read") throw permanent("statement_unknown", `"${name}" is not a declared read statement`);
        const driver = await open(ctx);
        try {
          const r = await driver.query(st.sql, bind(name, st, asObj(input.params)));
          return { output: { rows: r.rows.slice(0, MAX_ROWS), count: r.rows.length, truncated: r.rows.length > MAX_ROWS } };
        } finally {
          await driver.close();
        }
      },
    },
    {
      key: "execute", label: "Ejecutar operación", direction: "push",
      input: [{ key: "statement", label: "Sentencia", type: "string", required: true }, { key: "params", label: "Parámetros", type: "json" }],
      async run(ctx, input) {
        const name = need(input, "statement");
        const st = statements(ctx)[name];
        if (!st || st.mode !== "write") throw permanent("statement_unknown", `"${name}" is not a declared write statement`);
        const driver = await open(ctx);
        try {
          const r = await driver.query(st.sql, bind(name, st, asObj(input.params)));
          return { output: { rowsAffected: r.rowsAffected } };
        } finally {
          await driver.close();
        }
      },
    },
  ],
  async ping(ctx) {
    try {
      const driver = await open(ctx);
      await driver.query("SELECT 1 AS ok", {});
      await driver.close();
      return { ok: true, detail: "ok" };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "failed" };
    }
  },
  async sync(ctx, { full, cursor }) {
    const feeds = list(asObj(ctx.connector.config).feeds).filter(isObj);
    const stats = { pulled: 0, stored: 0 };
    let newest = cursor ?? null;
    const driver = feeds.length > 0 ? await open(ctx) : undefined;
    try {
      for (const feed of feeds) {
        const name = String(feed.statement);
        const st = statements(ctx)[name];
        if (!st || (st.mode ?? "read") !== "read") throw permanent("statement_unknown", `Feed statement "${name}" is not a declared read statement`);
        const idColumn = String(feed.idColumn ?? "id");
        const updatedColumn = str(feed.updatedColumn);
        const r = await driver!.query(st.sql, bind(name, st, { since: full ? null : cursor ?? null }));
        for (const row of r.rows.slice(0, MAX_ROWS)) {
          stats.pulled++;
          const updated = updatedColumn ? str(row[updatedColumn] instanceof Date ? (row[updatedColumn] as Date).toISOString() : row[updatedColumn]) : null;
          if (updated && (!newest || updated > newest)) newest = updated;
          const stored = await receiveInbound(ctx.db, { connectorKey: ctx.connector.key, eventId: `sync:${String(feed.eventType)}:${String(row[idColumn])}:${updated ?? "-"}`, eventType: String(feed.eventType), payload: row });
          if (!stored.duplicate) stats.stored++;
        }
      }
    } finally {
      await driver?.close();
    }
    return { stats, cursor: newest };
  },
};
