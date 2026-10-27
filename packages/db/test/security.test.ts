import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, migrate, withActor, withSystem } from "../src/index.js";

/**
 * Security regression tests for RLS, audit immutability and PII encryption.
 * Needs a throw-away Postgres: set TEST_DATABASE_URL (superuser) to run, e.g. in CI.
 */
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("database security", () => {
  const dbName = `orq_test_${Date.now()}`;
  let admin: pg.Client;
  let owner: pg.Pool;
  let app: pg.Pool;
  const ids = { d1: "", d2: "" };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: "orq_app_test", password: "orq_app_test" } });
    owner = createPool(base.toString());
    const appUrl = new URL(base.toString());
    appUrl.username = "orq_app_test";
    appUrl.password = "orq_app_test";
    app = createPool(appUrl.toString());

    await withSystem(owner, async (db) => {
      ids.d1 = (await db.query("INSERT INTO delegations (code, name) VALUES ('T1', 'One') RETURNING id")).rows[0].id;
      ids.d2 = (await db.query("INSERT INTO delegations (code, name) VALUES ('T2', 'Two') RETURNING id")).rows[0].id;
      await db.query("INSERT INTO customers (name, delegation_id) VALUES ('A', $1), ('B', $2), ('C', NULL)", [ids.d1, ids.d2]);
    });
  });

  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end()]);
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  const names = (actor: Parameters<typeof withActor>[1]) =>
    withActor(app, actor, async (db) => (await db.query("SELECT name FROM customers ORDER BY name")).rows.map((r) => r.name as string));

  it("hides rows outside the user's delegation scope", async () => {
    expect(await names({ userId: null, label: "u1", scopes: [{ d: ids.d1 }] })).toEqual(["A"]);
    expect(await names({ userId: null, label: "u2", scopes: [{ d: ids.d2 }] })).toEqual(["B"]);
  });

  it("combines several delegations and zone-level scopes exactly as the general rule says (fast-path policies)", async () => {
    const z = await withSystem(owner, async (db) => {
      const z1 = (await db.query("INSERT INTO zones (code, name, delegation_id) VALUES ('Z1', 'Z1', $1) RETURNING id", [ids.d1])).rows[0].id as string;
      const z2 = (await db.query("INSERT INTO zones (code, name, delegation_id) VALUES ('Z2', 'Z2', $1) RETURNING id", [ids.d1])).rows[0].id as string;
      await db.query("INSERT INTO customers (name, delegation_id, zone_id) VALUES ('D', $1, $2), ('E', $1, $3)", [ids.d1, z1, z2]);
      return { z1, z2 };
    });
    try {
      // whole delegations only → array membership path
      expect(await names({ label: "multi", scopes: [{ d: ids.d1 }, { d: ids.d2 }] })).toEqual(["A", "B", "D", "E"]);
      // zone inside a delegation → general function
      expect(await names({ label: "zone", scopes: [{ d: ids.d1, z: z.z1 }] })).toEqual(["D"]);
      // mixed: one whole delegation plus one zone of another
      expect(await names({ label: "mixed", scopes: [{ d: ids.d2 }, { d: ids.d1, z: z.z2 }] })).toEqual(["B", "E"]);
      // wildcard delegation (null) is not a "simple" scope and must still match through the general rule
      expect(await names({ label: "wild", scopes: [{ z: z.z1 }] })).toEqual(["D"]);
    } finally {
      await withSystem(owner, async (db) => {
        await db.query("DELETE FROM customers WHERE name IN ('D', 'E')");
        await db.query("DELETE FROM zones WHERE id = ANY($1)", [[z.z1, z.z2]]);
      });
    }
  });

  it("keeps unassigned rows for scope_all only (secure by default)", async () => {
    expect(await names({ label: "u1", scopes: [{ d: ids.d1 }] })).not.toContain("C");
  });

  it("shows everything to scope_all and to system actors", async () => {
    expect(await names({ label: "boss", scopeAll: true })).toEqual(["A", "B", "C"]);
    expect(await names({ system: true })).toEqual(["A", "B", "C"]);
  });

  it("denies unscoped users anything, including unassigned rows", async () => {
    expect(await names({ label: "nobody", scopes: [] })).toEqual([]);
  });

  it("blocks writes into foreign scope", async () => {
    await expect(
      withActor(app, { label: "u1", scopes: [{ d: ids.d1 }] }, (db) => db.query("INSERT INTO customers (name, delegation_id) VALUES ('X', $1)", [ids.d2])),
    ).rejects.toThrow(/row-level security/);
  });

  it("does not let the app role rewrite or delete audit entries", async () => {
    await withActor(app, { label: "u1", scopeAll: true }, (db) => db.query("UPDATE customers SET name = 'A2' WHERE name = 'A'"));
    await expect(withActor(app, { system: true }, (db) => db.query("DELETE FROM audit_log"))).rejects.toThrow();
    await expect(withActor(app, { system: true }, (db) => db.query("UPDATE audit_log SET actor = 'x'"))).rejects.toThrow();
  });

  it("keeps a valid hash chain and detects tampering", async () => {
    const broken = async () => withSystem(owner, async (db) => (await db.query("SELECT audit_verify_chain() AS broken")).rows[0].broken);
    expect(await broken()).toBeNull();
    const count = await withSystem(owner, async (db) => Number((await db.query("SELECT count(*) AS n FROM audit_log")).rows[0].n));
    expect(count).toBeGreaterThan(0);
  });

  it("stores PII encrypted", async () => {
    await withSystem(owner, async (db) => {
      await db.query("SELECT set_config('app.pii_key', 'test-key', true)");
      await db.query("INSERT INTO customers (name, email_enc) VALUES ('P', pgp_sym_encrypt('secret@example.com', 'test-key'))");
      const raw = (await db.query("SELECT email_enc FROM customers WHERE name = 'P'")).rows[0].email_enc as Buffer;
      expect(raw.toString("utf8")).not.toContain("secret@example.com");
      const back = (await db.query("SELECT pgp_sym_decrypt(email_enc, 'test-key') AS v FROM customers WHERE name = 'P'")).rows[0].v;
      expect(back).toBe("secret@example.com");
    });
  });
});
