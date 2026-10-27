// Forms catalogue and assignment to visits (ORF-093), against a real Postgres.
import { OpenAPIHono } from "@hono/zod-openapi";
import { migrate } from "@orchestrador/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("forms API", () => {
  const dbName = `orq_forms_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let app: OpenAPIHono;
  let userId: string;
  let visit: string;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: `orq_fm_${Date.now()}`, password: "x" } });
    process.env.DATABASE_URL = base.toString();
    process.env.APP_ENV = "test";
    pool = new pg.Pool({ connectionString: base.toString() });
    userId = (await pool.query("INSERT INTO users (email, display_name) VALUES ('f@example.com', 'f') RETURNING id")).rows[0].id;
    const wo = (await pool.query("INSERT INTO work_orders (status) VALUES ('created') RETURNING id")).rows[0].id;
    visit = (await pool.query("INSERT INTO visits (work_order_id, status) VALUES ($1, 'created') RETURNING id", [wo])).rows[0].id;
    const { forms } = await import("../src/modules/forms.js");
    const { handleError } = await import("../src/middleware/core.js");
    app = new OpenAPIHono();
    app.use("*", async (c, next) => {
      c.set("principal" as never, { kind: "user", id: userId, label: "f", roles: ["admin"], permissions: new Set(["forms:read", "forms:write", "visits:write"]), scopeAll: true, scopes: [], mfa: true, locale: "es" } as never);
      await next();
    });
    app.route("/", forms);
    app.onError(handleError);
  });
  afterAll(async () => {
    await pool?.end();
    await (await import("../src/lib/db.js")).pool.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  it("lists forms with their current version and tells current from expired", async () => {
    const form = (await call("POST", "/forms", { key: "lift.periodic", name: "Ascensores periódica" })).json;
    expect((await call("POST", "/forms", { key: "lift.periodic", name: "dup" })).status).toBe(409);
    const v1 = (await call("POST", `/forms/${form.id}/versions`, { schema: { type: "object" }, validFrom: "2020-01-01", validTo: "2020-12-31" })).json;
    const v2 = (await call("POST", `/forms/${form.id}/versions`, { schema: { type: "object", properties: { a: { type: "string" } } }, validFrom: "2021-01-01" })).json;
    expect([v1.version, v2.version]).toEqual([1, 2]);

    const versions = (await call("GET", `/forms/${form.id}/versions`)).json;
    expect(versions.items.map((v: { version: number; current: boolean; expired: boolean }) => [v.version, v.current, v.expired])).toEqual([[2, true, false], [1, false, true]]);
    expect((await call("GET", `/forms/${form.id}/versions?current=false`)).json.items).toHaveLength(1);

    const list = (await call("GET", "/forms?current=true")).json;
    expect(list.items[0]).toMatchObject({ key: "lift.periodic", versions: 2, current_version: { version: 2 } });
    expect((await call("GET", `/form-versions/${v2.id}`)).json).toMatchObject({ form_key: "lift.periodic", current: true });
  });

  it("assigns only a current version to a visit and moves the form state forward only", async () => {
    const form = (await pool.query("SELECT id FROM forms WHERE key = 'lift.periodic'")).rows[0].id;
    const [expired, current] = (await pool.query("SELECT id FROM form_versions WHERE form_id = $1 ORDER BY version", [form])).rows.map((r) => r.id);

    expect((await call("PUT", `/visits/${visit}/form`, { formVersionId: expired })).json.code).toBe("form_not_current");
    expect((await call("PUT", `/visits/${visit}/form-state`, { state: "in_progress" })).json.code).toBe("no_form");

    expect((await call("PUT", `/visits/${visit}/form`, { formVersionId: current })).json).toMatchObject({ form_version_id: current, form_state: "pending" });
    expect((await call("PUT", `/visits/${visit}/form-state`, { state: "completed" })).json.form_state).toBe("completed");
    expect((await call("PUT", `/visits/${visit}/form-state`, { state: "pending" })).json.code).toBe("invalid_form_state");
    expect((await call("PUT", `/visits/${visit}/form`, { formVersionId: null })).json).toMatchObject({ form_version_id: null, form_state: null });
  });

  it("does not let imported (field tool) forms be edited here, and retired versions cannot be assigned", async () => {
    const fsm = (await pool.query("INSERT INTO forms (key, name, source) VALUES ('fsm.x', 'X', 'fsm') RETURNING id")).rows[0].id;
    expect((await call("POST", `/forms/${fsm}/versions`, { schema: {} })).json.code).toBe("form_managed_externally");
    const local = (await pool.query("SELECT id FROM forms WHERE key = 'lift.periodic'")).rows[0].id;
    const v = (await call("POST", `/forms/${local}/versions`, { schema: {} })).json;
    await call("POST", `/form-versions/${v.id}/retire`);
    expect((await call("PUT", `/visits/${visit}/form`, { formVersionId: v.id })).json.code).toBe("form_not_current");
  });
});
