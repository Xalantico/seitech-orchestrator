// Needs a throw-away Postgres superuser URL:  TEST_DATABASE_URL=postgres://...@127.0.0.1:5437/postgres pnpm --filter @orchestrador/flowhost test
import { createPool, migrate, seedBase, withSystem } from "@orchestrador/db";
import { evalTable, test as logicTest, type DecisionTable } from "@orchestrador/rules";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkDiagram, FlowBuilder, PROCESS_TEMPLATES, publishVersion, seedProcessTemplates, SEED_TEMPLATES, triggerMatches } from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

describe("flow builder", () => {
  it("lays nodes out by depth and encodes ports as handles", () => {
    const b = new FlowBuilder().start().node("a", "flow.condition", "A", { left: "1", operator: "eq", right: "1" }).end("y", "Y").end("n", "N");
    b.link("trigger", "a").link("a", "y", "true").link("a", "n", "false");
    const d = b.build("t");
    expect(d.nodes.find((n) => n.id === "a")!.position!.x).toBe(300);
    expect(d.nodes.find((n) => n.id === "y")!.position!.x).toBe(600);
    expect(d.nodes.find((n) => n.id === "trigger")!.data!.isStartNode).toBe(true);
    expect(d.edges.map((e) => e.sourceHandle)).toEqual([undefined, "source:inner:true", "source:inner:false"]);
  });
});

describe("process template content", () => {
  it("has unique keys and every referenced notification template exists", () => {
    const keys = PROCESS_TEMPLATES.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(["inspection-lifts-rd203", "inspection-lv-rebt", "inspection-hv-rat", "nonconformity-handling", "certification", "billing-on-close", "visit-reminders", "sla-escalation", "visit-reassignment", "qa-sampling", "qualification-alerts"]));
    const known = new Set(SEED_TEMPLATES.map((t) => t.key));
    for (const p of PROCESS_TEMPLATES) {
      for (const n of (p.diagram as { nodes: { data: { properties: { templateKey?: string } } }[] }).nodes) {
        const k = n.data.properties.templateKey;
        if (k) expect(known.has(k), `${p.key} uses unknown template ${k}`).toBe(true);
      }
    }
  });

  it("only the high-voltage process requires the second validation", () => {
    const secondOf = (key: string) => {
      const p = PROCESS_TEMPLATES.find((x) => x.key === key)!;
      return (p.diagram as { nodes: { id: string; data: { properties: { secondValidation?: boolean } } }[] }).nodes.find((n) => n.id === "validate_task")!.data.properties.secondValidation;
    };
    expect(secondOf("inspection-hv-rat")).toBe(true);
    expect(secondOf("inspection-lifts-rd203")).toBe(false);
    expect(secondOf("inspection-lv-rebt")).toBe(false);
  });

  it("routes work orders to exactly one inspection process by regulation", () => {
    const event = (regulation: string) => ({ id: "e", type: "work_order.planned", entity_type: "work_order", entity_id: "w", payload: { regulation }, correlation_id: null, delegation_id: null, created_at: new Date() });
    for (const [regulation, expected] of [["RD-203-2021", "inspection-lifts-rd203"], ["REBT-RD-842-2002", "inspection-lv-rebt"], ["RAT-RD-223-2008", "inspection-hv-rat"]] as const) {
      const hits = PROCESS_TEMPLATES.filter((p) => p.triggers.some((t) => triggerMatches({ id: "t", flow_id: p.key, kind: t.kind, config: t.config } as never, event(regulation) as never)));
      expect(hits.map((h) => h.key)).toEqual([expected]);
    }
  });

  it("prices by regulation with a default", () => {
    const table = (PROCESS_TEMPLATES.find((p) => p.key === "billing-on-close")!.diagram as { nodes: { id: string; data: { properties: { definition?: DecisionTable } } }[] }).nodes.find((n) => n.id === "price")!.data.properties.definition!;
    expect(evalTable(table, { entity: { regulation: "RAT-RD-223-2008" } }).outputs.unitPrice).toBe(450);
    expect(evalTable(table, { entity: { regulation: "RD-203-2021" } }).outputs.unitPrice).toBe(85);
    expect(evalTable(table, { entity: { regulation: "OTHER" } }).outputs.unitPrice).toBe(100);
  });

  it("samples roughly the configured share, stably per work order", () => {
    let hits = 0;
    const total = 4000;
    for (let i = 0; i < total; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const a = logicTest({ sample: [{ var: "entity.id" }, 5] }, { entity: { id } });
      expect(logicTest({ sample: [{ var: "entity.id" }, 5] }, { entity: { id } })).toBe(a);
      if (a) hits++;
    }
    expect(hits / total).toBeGreaterThan(0.03);
    expect(hits / total).toBeLessThan(0.07);
  });
});

suite("process template seeding", () => {
  const dbName = `orq_proc_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const base = new URL(url!);
    base.pathname = `/${dbName}`;
    await migrate(base.toString(), { appRole: { name: `orq_proc_${Date.now()}`, password: "x" } });
    pool = createPool(base.toString());
    await seedBase(pool as never);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("every template compiles without errors or warnings", async () => {
    await withSystem(pool, async (db) => {
      for (const p of PROCESS_TEMPLATES) {
        const checked = await checkDiagram(db, p.diagram, { key: p.key }, { allowDraftRefs: true });
        const problems = checked.issues.map((i) => `${i.severity}:${i.code}:${i.message}`);
        expect(problems, p.key).toEqual([]);
      }
    });
  });

  it("installs, publishes and registers triggers; a second run changes nothing", async () => {
    const first = await withSystem(pool, (db) => seedProcessTemplates(db));
    expect(first.created).toHaveLength(PROCESS_TEMPLATES.length);
    expect(first.templates).toHaveLength(SEED_TEMPLATES.length);

    await withSystem(pool, async (db) => {
      const flows = (await db.query("SELECT key, published_version_id FROM flows WHERE 'plantilla' = ANY(tags)")).rows;
      expect(flows).toHaveLength(PROCESS_TEMPLATES.length);
      expect(flows.every((f) => f.published_version_id)).toBe(true);
      const triggers = (await db.query("SELECT f.key, t.kind FROM flow_triggers t JOIN flows f ON f.id = t.flow_id")).rows;
      expect(triggers.filter((t) => t.kind === "schedule").map((t) => t.key).sort()).toEqual(["qualification-alerts", "sla-escalation"]);
      expect(triggers.filter((t) => t.kind === "event")).toHaveLength(PROCESS_TEMPLATES.length - 2);
      const published = (await db.query("SELECT count(*)::int AS n FROM template_versions WHERE state = 'published' AND origin = 'seed'")).rows[0];
      expect(published.n).toBe(SEED_TEMPLATES.length);
    });

    const second = await withSystem(pool, (db) => seedProcessTemplates(db));
    expect(second.created).toEqual([]);
    expect(second.templates).toEqual([]);
    expect(second.skipped).toHaveLength(PROCESS_TEMPLATES.length);
  });

  it("does not republish a version that is already published", async () => {
    await withSystem(pool, async (db) => {
      const f = (await db.query<{ id: string }>("SELECT id FROM flows WHERE key = 'certification'")).rows[0]!;
      await expect(publishVersion(db, { flowId: f.id, version: 1, skipApproval: true })).rejects.toMatchObject({ code: "already_published" });
    });
  });
});
