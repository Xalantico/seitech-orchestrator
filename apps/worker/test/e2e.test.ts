// End-to-end: real Temporal server + real Postgres + the real workflow bundle and activities.
//   TEST_TEMPORAL_ADDRESS=127.0.0.1:7233 TEST_DATABASE_URL=postgres://.../orq_dev pnpm --filter @orchestrador/worker test
import { FAILURE_TYPE, INTERPRETER_WORKFLOW, QUERY, SIGNAL, UPDATE, workflowIdFor, type ExecutionInput } from "@orchestrador/engine";
import { SIM_SUFFIX, TASK_QUEUES, toDefinition } from "@orchestrador/shared";
import { Client, Connection, WorkflowFailedError, WorkflowUpdateFailedError } from "@temporalio/client";
import { NativeConnection, Worker, bundleWorkflowCode } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const address = process.env.TEST_TEMPORAL_ADDRESS;
const dbUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(address && dbUrl);

type Props = Record<string, unknown>;
const node = (id: string, type: string, properties: Props = {}, start = false) => ({ id, data: { type, properties, ...(start ? { isStartNode: true } : {}) } });
const edge = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}-${sourceHandle ?? ""}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });

describe.skipIf(!enabled)("interpreter on Temporal", () => {
  let client: Client;
  let connection: NativeConnection;
  const workers: Worker[] = [];
  let running: Promise<void[]>;
  let pool: import("pg").Pool;
  let sys: typeof import("../src/services.js");

  beforeAll(async () => {
    process.env.DATABASE_URL = dbUrl!;
    process.env.TEMPORAL_ADDRESS = address!;
    process.env.APP_ENV = "test";
    sys = await import("../src/services.js");
    pool = sys.pool;
    const { createActivities } = await import("../src/activities.js");
    connection = await NativeConnection.connect({ address: address! });
    client = new Client({ connection: await Connection.connect({ address: address! }) });
    const workflowBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)),
      webpackConfigHook: (config) => ({ ...config, resolve: { ...config.resolve, extensionAlias: { ".js": [".ts", ".js"] } } }),
    });
    const activities = createActivities();
    for (const [family, queue] of Object.entries(TASK_QUEUES)) {
      workers.push(await Worker.create({ connection, taskQueue: `${queue}${SIM_SUFFIX}`, activities, ...(family === "flows" ? { workflowBundle } : {}) }));
      workers.push(await Worker.create({ connection, taskQueue: queue, activities, ...(family === "flows" ? { workflowBundle } : {}) }));
    }
    running = Promise.all(workers.map((w) => w.run()));
  });

  afterAll(async () => {
    for (const w of workers) w.shutdown();
    await running;
    await pool.end();
  });

  async function start(diagram: unknown, opts: { simulated?: boolean; trigger?: Props; stepMode?: boolean; entity?: { type: string; id: string } } = {}) {
    const executionId = randomUUID();
    const definition = toDefinition(diagram, "e2e");
    await pool.query("INSERT INTO executions (id, workflow_id, temporal_workflow_id, status, simulated) VALUES ($1, NULL, $2, 'running', $3)", [executionId, workflowIdFor(executionId), Boolean(opts.simulated)]);
    const input: ExecutionInput = { executionId, definition, triggerPayload: opts.trigger ?? {}, variables: {}, global: {}, ...(opts.entity ? { entity: opts.entity } : {}), simulated: Boolean(opts.simulated), stepMode: Boolean(opts.stepMode) };
    const handle = await client.workflow.start(INTERPRETER_WORKFLOW, {
      workflowId: workflowIdFor(executionId),
      taskQueue: opts.simulated ? `${TASK_QUEUES.flows}${SIM_SUFFIX}` : TASK_QUEUES.flows,
      args: [input],
    });
    return { executionId, handle };
  }

  const events = async (id: string) => (await pool.query<{ type: string; node_id: string | null; payload: Props }>("SELECT type, node_id, payload FROM execution_events WHERE execution_id = $1 ORDER BY sequence", [id])).rows;
  const status = async (id: string) => (await pool.query<{ status: string; error_message: string | null }>("SELECT status, error_message FROM executions WHERE id = $1", [id])).rows[0]!;
  async function until<T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for condition");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("runs a branching flow end to end and records the timeline", async () => {
    const diagram = {
      nodes: [
        node("t", "poc/trigger", {}, true),
        node("v", "poc/set-variable", { name: "tier", value: "{{trigger.tier}}" }),
        node("c", "poc/condition", { left: "{{variables.tier}}", operator: "eq", right: "gold" }),
        node("gold", "poc/log", { message: "gold customer" }),
        node("std", "poc/log", { message: "standard" }),
      ],
      edges: [edge("t", "v"), edge("v", "c"), edge("c", "gold", "true"), edge("c", "std", "false")],
    };
    const { executionId, handle } = await start(diagram, { trigger: { tier: "gold" } });
    const result = await handle.result();
    expect(result.status).toBe("completed");
    const log = await events(executionId);
    expect(log.find((e) => e.node_id === "gold" && e.type === "node_completed")).toBeTruthy();
    expect(log.find((e) => e.node_id === "std" && e.type === "node_skipped")).toBeTruthy();
    expect((await status(executionId)).status).toBe("completed");
  });

  it("parks on an approval, accepts a verdict via update and rejects a duplicate", async () => {
    const diagram = {
      nodes: [node("t", "poc/trigger", {}, true), node("a", "poc/approval", { prompt: "ok?" }), node("yes", "poc/log", { message: "approved" }), node("no", "poc/log", { message: "rejected" })],
      edges: [edge("t", "a"), edge("a", "yes", "approved"), edge("a", "no", "rejected")],
    };
    const { executionId, handle } = await start(diagram);
    await until(async () => (await status(executionId)).status === "waiting");
    await handle.executeUpdate(UPDATE.resolveNode, { args: [{ nodeId: "a", resolution: { nextPort: "approved", output: { by: "test" } } }] });
    await expect(handle.executeUpdate(UPDATE.resolveNode, { args: [{ nodeId: "a", resolution: { nextPort: "approved" } }] })).rejects.toBeInstanceOf(WorkflowUpdateFailedError);
    const result = await handle.result();
    expect(result.status).toBe("completed");
    const log = await events(executionId);
    expect(log.some((e) => e.node_id === "yes" && e.type === "node_completed")).toBe(true);
    expect(log.some((e) => e.node_id === "no" && e.type === "node_skipped")).toBe(true);
    const waits = await pool.query("SELECT resolved_at FROM execution_waits WHERE execution_id = $1", [executionId]);
    expect(waits.rows[0]?.resolved_at).toBeTruthy();
  });

  it("follows the errorRoute when an activity fails permanently", async () => {
    const diagram = {
      nodes: [
        node("t", "poc/trigger", {}, true),
        node("h", "poc/http-request", { url: "http://127.0.0.1:9/nope", method: "GET", errorPolicy: "errorRoute" }),
        node("ok", "poc/log", { message: "ok" }),
        node("recover", "poc/log", { message: "recovered" }),
      ],
      edges: [edge("t", "h"), edge("h", "ok"), edge("h", "recover", "errorRoute")],
    };
    const { executionId, handle } = await start(diagram);
    const result = await handle.result();
    expect(result.status).toBe("completed");
    const log = await events(executionId);
    expect(log.some((e) => e.node_id === "recover" && e.type === "node_completed")).toBe(true);
    expect(log.some((e) => e.node_id === "h" && e.type === "node_failed")).toBe(true);
  }, 90_000);

  it("fails the execution when a node fails under the fail policy", async () => {
    const diagram = { nodes: [node("t", "poc/trigger", {}, true), node("h", "poc/http-request", { url: "not a url", method: "GET" })], edges: [edge("t", "h")] };
    const { executionId, handle } = await start(diagram);
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
    await until(async () => (await status(executionId)).status === "failed");
    expect((await status(executionId)).error_message).toBeTruthy();
  }, 90_000);

  it("simulations replace side effects with stubs", async () => {
    const diagram = { nodes: [node("t", "poc/trigger", {}, true), node("n", "poc/create-ticket", { title: "should not exist", priority: "low" })], edges: [edge("t", "n")] };
    const { executionId, handle } = await start(diagram, { simulated: true });
    expect((await handle.result()).status).toBe("completed");
    const tickets = await pool.query("SELECT 1 FROM tasks WHERE execution_id = $1", [executionId]);
    expect(tickets.rowCount).toBe(0);
    const done = (await events(executionId)).find((e) => e.node_id === "n" && e.type === "node_completed");
    expect((done?.payload.output as Props).simulated).toBe(true);
  });

  it("creates a task for a real (non-simulated) ticket node, once", async () => {
    const diagram = { nodes: [node("t", "poc/trigger", {}, true), node("n", "poc/create-ticket", { title: "Check lift {{trigger.lift}}", priority: "high" })], edges: [edge("t", "n")] };
    const { executionId, handle } = await start(diagram, { trigger: { lift: "A-17" } });
    expect((await handle.result()).status).toBe("completed");
    const rows = await pool.query("SELECT title, priority, source FROM tasks WHERE execution_id = $1", [executionId]);
    expect(rows.rows).toEqual([{ title: "Check lift A-17", priority: "high", source: "flow" }]);
  });

  it("calls a published flow as a sub-process (child workflow) and waits for it", async () => {
    const key = `child-${randomUUID().slice(0, 8)}`;
    const childDiagram = { nodes: [node("t", "poc/trigger", {}, true), node("l", "poc/log", { message: "child got {{trigger.x}}" }), node("e", "flow.end", { outcomeValue: "child_done" })], edges: [edge("t", "l"), edge("l", "e")] };
    const flow = await pool.query<{ id: string }>("INSERT INTO flows (key, name) VALUES ($1, 'Child') RETURNING id", [key]);
    const version = await pool.query<{ id: string }>("INSERT INTO flow_versions (flow_id, version, state, diagram) VALUES ($1, 1, 'published', $2::jsonb) RETURNING id", [flow.rows[0]!.id, JSON.stringify(childDiagram)]);
    await pool.query("UPDATE flows SET published_version_id = $2 WHERE id = $1", [flow.rows[0]!.id, version.rows[0]!.id]);
    const diagram = { nodes: [node("t", "poc/trigger", {}, true), node("sub", "flow.subprocess", { flowId: key, input: { x: 42 } }), node("after", "poc/log", { message: "parent continues" })], edges: [edge("t", "sub"), edge("sub", "after")] };
    const { executionId, handle } = await start(diagram);
    expect((await handle.result()).status).toBe("completed");
    const child = await pool.query<{ id: string; status: string }>("SELECT id, status FROM executions WHERE parent_execution_id = $1", [executionId]);
    expect(child.rows).toHaveLength(1);
    expect(child.rows[0]!.status).toBe("completed");
    const childEvents = await events(child.rows[0]!.id);
    expect(childEvents.find((e) => e.node_id === "l" && e.type === "node_completed")?.payload).toMatchObject({ output: { message: "child got 42" } });
    expect((await events(executionId)).some((e) => e.node_id === "after" && e.type === "node_completed")).toBe(true);
  });

  it("user task: creates a task with its actions and waits for the verdict", async () => {
    const diagram = {
      nodes: [node("t", "flow.trigger", {}, true), node("u", "human.user-task", { title: "Revisar {{trigger.ref}}", priority: "high", dueIn: "2d" }), node("ok", "flow.log", { message: "done" }), node("ko", "flow.log", { message: "rejected" })],
      edges: [edge("t", "u"), edge("u", "ok", "done"), edge("u", "ko", "rejected")],
    };
    const { executionId, handle } = await start(diagram, { trigger: { ref: "OT-9" } });
    const task = await until(async () => (await pool.query<{ title: string; kind: string; priority: string; available_actions: { nextPort: string }[] }>("SELECT title, kind, priority, available_actions FROM tasks WHERE execution_id = $1", [executionId])).rows[0]);
    expect(task).toMatchObject({ title: "Revisar OT-9", kind: "user_task", priority: "high" });
    expect(task.available_actions.map((a) => a.nextPort)).toEqual(["done", "rejected"]);
    await handle.executeUpdate(UPDATE.resolveNode, { args: [{ nodeId: "u", resolution: { nextPort: "rejected" } }] });
    expect((await handle.result()).status).toBe("completed");
    const log = await events(executionId);
    expect(log.some((e) => e.node_id === "ko" && e.type === "node_completed")).toBe(true);
  });

  it("wait with a timeout follows the timeout route; the wait-event node follows received", async () => {
    const late = {
      nodes: [node("t", "flow.trigger", {}, true), node("a", "human.approval", { title: "Aprobar", timeout: "1s" }), node("ok", "flow.log"), node("no", "flow.log"), node("expired", "flow.log", { message: "expired" })],
      edges: [edge("t", "a"), edge("a", "ok", "approved"), edge("a", "no", "rejected"), edge("a", "expired", "timeout")],
    };
    const first = await start(late);
    expect((await first.handle.result()).status).toBe("completed");
    expect((await events(first.executionId)).some((e) => e.node_id === "expired" && e.type === "node_completed")).toBe(true);
    expect((await events(first.executionId)).some((e) => e.type === "wait_timed_out")).toBe(true);

    const evt = {
      nodes: [node("t", "flow.trigger", {}, true), node("w", "flow.wait-event", { eventName: "cert.signed", correlation: "C-1", timeout: "1h" }), node("got", "flow.log", { message: "{{nodes.w.pdf}}" }), node("late", "flow.log")],
      edges: [edge("t", "w"), edge("w", "got", "received"), edge("w", "late", "timeout")],
    };
    const second = await start(evt);
    await until(async () => (await status(second.executionId)).status === "waiting");
    await second.handle.signal(SIGNAL.event, { name: "cert.signed", correlation: "C-1", payload: { pdf: "cert.pdf" } });
    expect((await second.handle.result()).status).toBe("completed");
    expect((await events(second.executionId)).find((e) => e.node_id === "got" && e.type === "node_completed")?.payload).toMatchObject({ output: { message: "cert.pdf" } });
  });

  it("timer completes after its duration", async () => {
    const diagram = { nodes: [node("t", "flow.trigger", {}, true), node("w", "flow.timer", { duration: "1s" }), node("after", "flow.log")], edges: [edge("t", "w"), edge("w", "after")] };
    const { handle } = await start(diagram);
    expect((await handle.result()).status).toBe("completed");
  });

  it("comm.notify queues one message per node and recipient (idempotent)", async () => {
    const diagram = { nodes: [node("t", "flow.trigger", {}, true), node("n", "comm.notify", { channel: "email", to: "{{trigger.email}}", subject: "Hola", body: "OT {{trigger.ref}}" })], edges: [edge("t", "n")] };
    const { executionId, handle } = await start(diagram, { trigger: { email: "cliente@example.com", ref: "OT-5" } });
    expect((await handle.result()).status).toBe("completed");
    const rows = await pool.query("SELECT to_address, subject, body, status FROM messages WHERE execution_id = $1", [executionId]);
    expect(rows.rows).toEqual([{ to_address: "cliente@example.com", subject: "Hola", body: "OT OT-5", status: "queued" }]);
  });

  it("data.entity-update changes a whitelisted column and records the state history", async () => {
    const wo = await pool.query<{ id: string }>("INSERT INTO work_orders (status) VALUES ('created') RETURNING id");
    const woId = wo.rows[0]!.id;
    const diagram = { nodes: [node("t", "flow.trigger", {}, true), node("u", "data.entity-update", { entity: "work_orders", id: "{{trigger.id}}", fields: '{"status":"planned","priority":"high"}' })], edges: [edge("t", "u")] };
    const { handle } = await start(diagram, { trigger: { id: woId } });
    expect((await handle.result()).status).toBe("completed");
    expect((await pool.query("SELECT status, priority FROM work_orders WHERE id = $1", [woId])).rows[0]).toEqual({ status: "planned", priority: "high" });
    expect((await pool.query("SELECT from_state, to_state FROM entity_state_history WHERE entity_id = $1", [woId])).rows[0]).toEqual({ from_state: "created", to_state: "planned" });
    const bad = { nodes: [node("t", "flow.trigger", {}, true), node("u", "data.entity-update", { entity: "work_orders", id: woId, fields: '{"id":"x"}' })], edges: [edge("t", "u")] };
    const failed = await start(bad);
    await expect(failed.handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
  }, 90_000);

  it("cancels a waiting execution and closes its bookkeeping", async () => {
    const diagram = { nodes: [node("t", "poc/trigger", {}, true), node("a", "poc/approval", {})], edges: [edge("t", "a")] };
    const { executionId, handle } = await start(diagram);
    await until(async () => (await status(executionId)).status === "waiting");
    await handle.cancel();
    await expect(handle.result()).rejects.toBeTruthy();
    await until(async () => (await status(executionId)).status === "cancelled");
    expect((await events(executionId)).some((e) => e.type === "execution_cancelled")).toBe(true);
  });

  it("supports pause, step-through and the live state query", async () => {
    const diagram = { nodes: [node("t", "poc/trigger", {}, true), node("a", "poc/log", { message: "a" }), node("b", "poc/log", { message: "b" })], edges: [edge("t", "a"), edge("a", "b")] };
    const { executionId, handle } = await start(diagram, { simulated: true, stepMode: true });
    await until(async () => (await events(executionId)).some((e) => e.type === "node_step_pending" && e.node_id === "t"));
    await handle.signal(SIGNAL.step, { count: 1 });
    await until(async () => (await events(executionId)).some((e) => e.type === "node_step_pending" && e.node_id === "a"));
    const state = (await handle.query(QUERY.state)) as { status: Props };
    expect(state).toBeTruthy();
    await handle.signal(SIGNAL.step, { count: 5 });
    expect((await handle.result()).status).toBe("completed");
  });

  it("rejects a verdict for an unknown node with the engine failure type", async () => {
    const diagram = { nodes: [node("t", "poc/trigger", {}, true), node("a", "poc/approval", {})], edges: [edge("t", "a")] };
    const { executionId, handle } = await start(diagram);
    await until(async () => (await status(executionId)).status === "waiting");
    const error = await handle.executeUpdate(UPDATE.resolveNode, { args: [{ nodeId: "nope", resolution: { nextPort: "approved" } }] }).catch((e) => e);
    expect(error).toBeInstanceOf(WorkflowUpdateFailedError);
    expect((error.cause as { type?: string }).type).toBe(FAILURE_TYPE.rejected);
    await handle.terminate("test cleanup");
  });

  it("rule node routes and state.transition moves the entity through its published state machine", async () => {
    const machine = {
      entityType: "work_order", initial: "created",
      states: [{ key: "created", label: "Creada" }, { key: "planned", label: "Planificada" }, { key: "in_review", label: "En revisión" }],
      transitions: [{ key: "plan", label: "Planificar", from: "created", to: "planned" }, { key: "review", label: "Revisar", from: "planned", to: "in_review", guard: { logic: { ">": [{ var: "entity.priority_rank" }, 0] } } }],
    };
    // Publish a higher version of the work-order machine (seeded by `seed`, or created here on a bare database).
    const sm = await pool.query<{ id: string }>("INSERT INTO state_machines (key, entity_type, name) VALUES ('work_order', 'work_order', 'Orden') ON CONFLICT (key) DO UPDATE SET name = state_machines.name RETURNING id");
    const version = ((await pool.query<{ v: number | null }>("SELECT max(version) AS v FROM state_machine_versions WHERE state_machine_id = $1", [sm.rows[0]!.id])).rows[0]!.v ?? 0) + 1000;
    await pool.query("INSERT INTO state_machine_versions (state_machine_id, version, state, definition) VALUES ($1, $2, 'published', $3)", [sm.rows[0]!.id, version, JSON.stringify(machine)]);
    try {
      const wo = (await pool.query<{ id: string }>("INSERT INTO work_orders (status) VALUES ('created') RETURNING id")).rows[0]!.id;
      const rules = { kind: "rules", mode: "first", rules: [{ id: "hv", name: "hv", when: { kind: "condition", field: "trigger.voltage", operator: "gte", value: 1000 }, then: {} }] };
      const diagram = {
        nodes: [
          node("t", "flow.trigger", {}, true),
          node("r", "flow.rule", { definition: JSON.stringify(rules) }),
          node("plan", "state.transition", { entityType: "work_order", id: "{{trigger.id}}", to: "planned" }),
          node("skip", "flow.log", { message: "low voltage" }),
        ],
        edges: [edge("t", "r"), edge("r", "plan", "true"), edge("r", "skip", "false")],
      };
      const hv = await start(diagram, { trigger: { id: wo, voltage: 20000 } });
      expect((await hv.handle.result()).status).toBe("completed");
      expect((await pool.query("SELECT status FROM work_orders WHERE id = $1", [wo])).rows[0].status).toBe("planned");
      const hist = await pool.query("SELECT actor, from_state, to_state FROM entity_state_history WHERE entity_id = $1", [wo]);
      expect(hist.rows).toEqual([{ actor: "flow:plan", from_state: "created", to_state: "planned" }]);
      expect((await events(hv.executionId)).some((e) => e.node_id === "skip" && e.type === "node_skipped")).toBe(true);

      // A guard that fails surfaces as a permanent node error: the flow fails and the entity is untouched.
      const guarded = { nodes: [node("t", "flow.trigger", {}, true), node("rev", "state.transition", { entityType: "work_order", id: wo, to: "in_review" })], edges: [edge("t", "rev")] };
      const bad = await start(guarded);
      await expect(bad.handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
      expect((await pool.query("SELECT status FROM work_orders WHERE id = $1", [wo])).rows[0].status).toBe("planned");

      // Simulation never writes.
      const wo2 = (await pool.query<{ id: string }>("INSERT INTO work_orders (status) VALUES ('created') RETURNING id")).rows[0]!.id;
      const sim = await start({ nodes: [node("t", "flow.trigger", {}, true), node("plan", "state.transition", { entityType: "work_order", id: wo2, to: "planned" })], edges: [edge("t", "plan")] }, { simulated: true });
      expect((await sim.handle.result()).status).toBe("completed");
      expect((await pool.query("SELECT status FROM work_orders WHERE id = $1", [wo2])).rows[0].status).toBe("created");
    } finally {
      await pool.query("DELETE FROM state_machine_versions WHERE state_machine_id = $1 AND version = $2", [sm.rows[0]!.id, version]);
    }
  }, 90_000);
  describe("seeded process templates", () => {
    async function harness() {
      const { seedBase, withSystem } = await import("@orchestrador/db");
      const { seedProcessTemplates, deliverEvent, PROCESS_TEMPLATES } = await import("@orchestrador/flowhost");
      await seedBase(pool as never);
      await withSystem(pool, (db) => seedProcessTemplates(db));
      const host = {
        deps: { system: (fn: never) => withSystem(pool, fn), log: console },
        signalExecution: async (id: string, _kind: string, payload: unknown) => client.workflow.getHandle(workflowIdFor(id)).signal(SIGNAL.event, payload as never),
      };
      const diagramOf = (key: string) => PROCESS_TEMPLATES.find((p) => p.key === key)!.diagram;
      const deliver = (event: { name: string; correlations: string[]; payload: Props }) => deliverEvent(host as never, event);
      const workOrder = async (regulation: string, status: string) => {
        const customer = (await pool.query<{ id: string }>("INSERT INTO customers (name, consent_comms) VALUES ('Comunidad Mar', true) RETURNING id")).rows[0]!.id;
        const site = (await pool.query<{ id: string }>("INSERT INTO sites (name) VALUES ('Edificio Mar') RETURNING id")).rows[0]!.id;
        return (await pool.query<{ id: string }>("INSERT INTO work_orders (status, regulation, inspection_type, customer_id, site_id) VALUES ($1, $2, 'periodic', $3, $4) RETURNING id", [status, regulation, customer, site])).rows[0]!.id;
      };
      const waitingOn = (executionId: string, key: string) => until(async () => (await pool.query("SELECT 1 FROM execution_waits WHERE execution_id = $1 AND correlation_key = $2 AND resolved_at IS NULL", [executionId, key])).rows[0]);
      const approve = (handle: Awaited<ReturnType<typeof start>>["handle"], nodeId: string, nextPort = "approved") =>
        until(async () => handle.executeUpdate(UPDATE.resolveNode, { args: [{ nodeId, resolution: { nextPort, output: { by: "e2e" } } }] }).then(() => true, () => false));
      const woStatus = async (id: string) => (await pool.query<{ status: string }>("SELECT status FROM work_orders WHERE id = $1", [id])).rows[0]!.status;
      return { deliver, diagramOf, workOrder, waitingOn, approve, woStatus };
    }

    it("lifts inspection: plan, visit result by event, validation, certificate event, close", async () => {
      const h = await harness();
      const wo = await h.workOrder("RD-203-2021", "planned");
      const { executionId, handle } = await start(h.diagramOf("inspection-lifts-rd203"), { entity: { type: "work_order", id: wo }, trigger: { event: "work_order.planned" } });
      await h.waitingOn(executionId, `visit.result|${wo}`);

      // The event arrives keyed by the visit; the work order id is a secondary correlation.
      expect(await h.deliver({ name: "visit.result", correlations: [randomUUID(), wo], payload: { result: "conditioned", workOrderId: wo } })).toBe(1);
      await h.approve(handle, "validate_task");
      await until(async () => (await h.woStatus(wo)) === "validated");
      await h.waitingOn(executionId, `certificate.distributed|${wo}`);
      expect(await h.deliver({ name: "certificate.distributed", correlations: [randomUUID(), wo], payload: { workOrderId: wo } })).toBe(1);
      expect((await handle.result()).status).toBe("completed");

      expect(await h.woStatus(wo)).toBe("closed");
      const log = await events(executionId);
      expect(log.some((e) => e.node_id === "alert_supervisor" && e.type === "node_completed")).toBe(true); // conditioned result alerts supervision
      expect(log.some((e) => e.node_id === "submit" && e.type === "node_completed")).toBe(true);
      const alert = await pool.query("SELECT to_address, subject FROM messages WHERE execution_id = $1 AND node_id = 'alert_supervisor'", [executionId]);
      expect(alert.rows[0]).toMatchObject({ to_address: "role:supervisor" });
      expect(alert.rows[0].subject).toContain("conditioned");
      const emitted = await pool.query("SELECT type FROM domain_events WHERE entity_id = $1 ORDER BY created_at", [wo]);
      expect(emitted.rows.map((r) => r.type)).toEqual(expect.arrayContaining(["work_order.in_progress", "work_order.pending_validation", "work_order.validated", "work_order.closed"]));
    }, 90_000);

    it("certification: creates the certificate once, signs, distributes and announces it", async () => {
      const h = await harness();
      const wo = await h.workOrder("RD-203-2021", "validated");
      const { executionId, handle } = await start(h.diagramOf("certification"), { entity: { type: "work_order", id: wo }, trigger: { event: "work_order.validated" } });
      await h.approve(handle, "sign_approval");
      expect((await handle.result()).status).toBe("completed");
      const certs = await pool.query("SELECT id, status, number, extra FROM certificates WHERE work_order_id = $1", [wo]);
      expect(certs.rows).toHaveLength(1);
      expect(certs.rows[0]).toMatchObject({ status: "distributed" });
      expect(certs.rows[0].number).toMatch(/^CERT-\d+$/);
      expect(certs.rows[0].extra.createdByExecution).toBe(executionId);
      const announced = await pool.query("SELECT payload FROM domain_events WHERE type = 'certificate.distributed' AND entity_id = $1", [certs.rows[0].id]);
      expect(announced.rows[0].payload.workOrderId).toBe(wo);
    }, 90_000);

    it("certification: a rejected signature sends the certificate back to rejected with a task", async () => {
      const h = await harness();
      const wo = await h.workOrder("RAT-RD-223-2008", "validated");
      const { handle } = await start(h.diagramOf("certification"), { entity: { type: "work_order", id: wo }, trigger: { event: "work_order.validated" } });
      await h.approve(handle, "sign_approval", "rejected");
      await until(async () => (await pool.query("SELECT 1 FROM certificates WHERE work_order_id = $1 AND status = 'rejected'", [wo])).rows[0]);
      await h.approve(handle, "regen_task", "done");
      expect((await handle.result()).status).toBe("completed");
    }, 90_000);

    it("billing: prices the line by regulation when the work order closes", async () => {
      const h = await harness();
      const wo = await h.workOrder("REBT-RD-842-2002", "closed");
      const { handle } = await start(h.diagramOf("billing-on-close"), { entity: { type: "work_order", id: wo }, trigger: { event: "work_order.closed" } });
      expect((await handle.result()).status).toBe("completed");
      const lines = await pool.query("SELECT description, unit_price::float AS unit_price, amount::float AS amount, status FROM billing_lines WHERE work_order_id = $1", [wo]);
      expect(lines.rows).toHaveLength(1);
      expect(lines.rows[0]).toMatchObject({ unit_price: 120, amount: 120, status: "pending" });
      expect(lines.rows[0].description).toContain("Edificio Mar");
    }, 90_000);

    it("qualification alerts: finds qualifications expiring in 30 days and opens subtasks", async () => {
      const h = await harness();
      const tech = (await pool.query<{ id: string }>("INSERT INTO technicians (name) VALUES ($1) RETURNING id", [`Tec ${randomUUID().slice(0, 6)}`])).rows[0]!.id;
      const name = (await pool.query<{ name: string }>("SELECT name FROM technicians WHERE id = $1", [tech])).rows[0]!.name;
      await pool.query("INSERT INTO qualifications (technician_id, kind, reference, valid_to) VALUES ($1, 'REBT', 'IBTE-1', current_date + 30)", [tech]);
      const { executionId, handle } = await start(h.diagramOf("qualification-alerts"), { trigger: { event: "schedule" } });
      const found = await until(async () => (await events(executionId)).find((e) => e.node_id === "find" && e.type === "node_completed"));
      expect(JSON.stringify(found.payload)).toContain(name);
      await until(async () => (await status(executionId)).status === "waiting");
      await handle.terminate("test done");
    }, 90_000);
  });
  describe("integration hub nodes", () => {
    beforeAll(async () => {
      await pool.query("INSERT INTO connectors (key, name, system_kind, mode) VALUES ('e2e-mock', 'E2E mock', 'mock', 'mock') ON CONFLICT (key) DO NOTHING");
      await pool.query("INSERT INTO mapping_registry (key, connector_key, entity, direction) VALUES ('e2e.map', 'e2e-mock', 'order', 'outbound') ON CONFLICT (key) DO NOTHING");
      const id = (await pool.query("SELECT id FROM mapping_registry WHERE key = 'e2e.map'")).rows[0].id;
      await pool.query(
        `INSERT INTO mapping_versions (mapping_id, version, state, fields) VALUES ($1, 1, 'published', $2::jsonb) ON CONFLICT DO NOTHING`,
        [id, JSON.stringify([{ source: "name", target: "customerName", transform: "upper", required: true }])],
      );
    });

    it("maps data, calls a connector synchronously and queues an async call", async () => {
      const key = `e2e-${randomUUID()}`;
      const diagram = {
        nodes: [
          node("t", "poc/trigger", {}, true),
          node("m", "int.map", { mapping: "e2e.map", source: { name: "{{trigger.name}}" }, variable: "mapped" }),
          node("c", "int.call", { connector: "e2e-mock", action: "echo", input: { value: "{{variables.mapped.customerName}}" }, mode: "sync", idempotencyKey: key, variable: "resp" }),
          node("a", "int.call", { connector: "e2e-mock", action: "echo", input: { value: "later" }, mode: "async", idempotencyKey: `${key}-async`, variable: "queued" }),
          node("l", "poc/log", { message: "{{variables.resp.body.echoed.value}}" }),
        ],
        edges: [edge("t", "m"), edge("m", "c"), edge("c", "a"), edge("a", "l")],
      };
      const { executionId, handle } = await start(diagram, { trigger: { name: "acme" } });
      expect((await handle.result()).status).toBe("completed");
      const log = await events(executionId);
      const logged = log.find((e) => e.node_id === "l" && e.type === "node_completed");
      expect(JSON.stringify(logged?.payload)).toContain("ACME");
      const rows = (await pool.query<{ status: string; action: string }>("SELECT status, action FROM outbox_events WHERE idempotency_key = ANY($1) ORDER BY idempotency_key", [[key, `${key}-async`]])).rows;
      expect(rows.map((r) => r.status).sort()).toEqual(["pending", "sent"]);
    }, 60_000);

    it("a permanent connector failure follows the error route and leaves a traceable failed call", async () => {
      const diagram = {
        nodes: [
          node("t", "poc/trigger", {}, true),
          node("c", "int.call", { connector: "e2e-mock", action: "reject", input: {}, mode: "sync", errorPolicy: "errorRoute" }),
          node("ok", "poc/log", { message: "ok" }),
          node("recover", "poc/log", { message: "recovered" }),
        ],
        edges: [edge("t", "c"), edge("c", "ok"), edge("c", "recover", "errorRoute")],
      };
      const { executionId, handle } = await start(diagram);
      expect((await handle.result()).status).toBe("completed");
      expect((await events(executionId)).some((e) => e.node_id === "recover" && e.type === "node_completed")).toBe(true);
      const failed = (await pool.query("SELECT status, last_error FROM outbox_events WHERE execution_id = $1", [executionId])).rows;
      expect(failed).toEqual([{ status: "failed", last_error: "The remote system rejected the request" }]);
    }, 60_000);

    it("simulated runs never touch the connector", async () => {
      const key = `e2e-sim-${randomUUID()}`;
      const diagram = { nodes: [node("t", "poc/trigger", {}, true), node("c", "int.call", { connector: "e2e-mock", action: "echo", input: {}, idempotencyKey: key })], edges: [edge("t", "c")] };
      const { handle } = await start(diagram, { simulated: true });
      expect((await handle.result()).status).toBe("completed");
      expect((await pool.query("SELECT 1 FROM outbox_events WHERE idempotency_key = $1", [key])).rowCount).toBe(0);
    }, 60_000);
  });
});
