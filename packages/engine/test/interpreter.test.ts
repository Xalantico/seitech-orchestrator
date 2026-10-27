import { describe, expect, it } from "vitest";

import { Interpreter } from "../src/interpreter.js";
import { coreInline } from "../src/inline.js";
import { definition, edge, FakeRuntime, launch, node, start, ContinuedAsNew } from "./helpers.js";

const act = (id: string, extra = {}) => node(id, `act.${id}`, "activity", extra);

describe("graph routing", () => {
  it("runs a linear flow to completion", async () => {
    const { rt, promise, result } = launch(definition([start(), act("a"), act("b")], [edge("start", "a"), edge("a", "b")]));
    await promise;
    expect(result.value).toEqual({ status: "completed" });
    expect(rt.types("a")).toEqual(["node_started", "node_completed"]);
    expect(rt.types()[0]).toBe("execution_started");
    expect(rt.types().at(-1)).toBe("execution_completed");
    expect(rt.statuses.at(-1)).toBe("completed");
  });

  it("follows only the chosen port and skips the other branch", async () => {
    const cond = node("c", "flow.condition", "inline", { config: { left: "{{trigger.n}}", operator: "gt", right: "5" } });
    const def = definition([start(), cond, act("yes"), act("no"), act("after")], [edge("start", "c"), edge("c", "yes", "true"), edge("c", "no", "false"), edge("yes", "after"), edge("no", "after")]);
    const { rt, promise, result } = launch(def, { triggerPayload: { n: 9 } });
    await promise;
    expect(result.value?.status).toBe("completed");
    expect(rt.types("yes")).toContain("node_completed");
    expect(rt.events.find((e) => e.nodeId === "no" && e.type === "node_skipped")?.payload).toEqual({ reason: "branch_not_taken" });
    expect(rt.types("after")).toContain("node_completed");
  });

  it("runs parallel branches concurrently and joins with AND semantics", async () => {
    const order: string[] = [];
    const def = definition(
      [start(), node("split", "flow.parallel", "inline"), act("a"), act("b"), node("join", "flow.join", "inline")],
      [edge("start", "split"), edge("split", "a"), edge("split", "b"), edge("a", "join"), edge("b", "join")],
    );
    const rt = new FakeRuntime();
    rt.activities["act.a"] = async () => { order.push("a:start"); await rt.sleep(1000); order.push("a:end"); return { output: 1 }; };
    rt.activities["act.b"] = async () => { order.push("b:start"); await rt.sleep(500); order.push("b:end"); return { output: 2 }; };
    const { promise, result } = launch(def, {}, rt);
    await rt.idle();
    expect(order).toEqual(["a:start", "b:start"]);
    await rt.advance(500);
    expect(rt.types("join")).toEqual([]);
    await rt.advance(600);
    await promise;
    expect(order).toEqual(["a:start", "b:start", "b:end", "a:end"]);
    expect(result.value?.status).toBe("completed");
  });

  it("OR-join fires once, on the first live predecessor", async () => {
    const def = definition(
      [start(), node("split", "flow.parallel", "inline"), act("fast"), act("slow"), node("any", "flow.join", "inline", { join: "any" })],
      [edge("start", "split"), edge("split", "fast"), edge("split", "slow"), edge("fast", "any"), edge("slow", "any")],
    );
    const rt = new FakeRuntime();
    rt.activities["act.slow"] = async () => { await rt.sleep(5000); return { output: "slow" }; };
    const { promise, result } = launch(def, {}, rt);
    await rt.advance(10_000);
    await promise;
    expect(result.value?.status).toBe("completed");
    expect(rt.types("any").filter((t) => t === "node_started")).toHaveLength(1);
  });

  it("reports a dead end as incomplete", async () => {
    const def = definition([start(), node("c", "flow.condition", "inline", { config: { left: "1", operator: "eq", right: "1" } }), act("never")], [edge("start", "c"), edge("c", "never", "false")]);
    const { promise, result } = launch(def);
    await promise;
    expect(result.value).toMatchObject({ status: "incomplete", deadEnds: [{ nodeId: "c", port: "true" }] });
  });
});

describe("error handling", () => {
  const def = (policy: "fail" | "continue" | "errorRoute") =>
    definition(
      [start(), act("x", { errorPolicy: policy }), act("ok"), ...(policy === "errorRoute" ? [act("recover")] : [])],
      [edge("start", "x"), edge("x", "ok"), ...(policy === "errorRoute" ? [edge("x", "recover", "errorRoute")] : [])],
    );

  it("fails the execution when policy is fail", async () => {
    const rt = new FakeRuntime();
    rt.activities["act.x"] = () => { throw Object.assign(new Error("boom"), { code: "E_BOOM" }); };
    const { promise, result } = launch(def("fail"), {}, rt);
    await promise;
    expect(result.value).toMatchObject({ status: "failed", error: { message: "boom", code: "E_BOOM" } });
    expect(rt.types("ok")).toEqual([]);
  });

  it("continues with the error as output when policy is continue", async () => {
    const rt = new FakeRuntime();
    rt.activities["act.x"] = () => { throw new Error("soft"); };
    const { promise, result } = launch(def("continue"), {}, rt);
    await promise;
    expect(result.value?.status).toBe("completed");
    expect(rt.types("ok")).toContain("node_completed");
  });

  it("routes to the error edge when policy is errorRoute", async () => {
    const rt = new FakeRuntime();
    rt.activities["act.x"] = () => { throw new Error("routed"); };
    const { promise, result } = launch(def("errorRoute"), {}, rt);
    await promise;
    expect(result.value?.status).toBe("completed");
    expect(rt.types("recover")).toContain("node_completed");
    expect(rt.events.find((e) => e.nodeId === "ok" && e.type === "node_skipped")?.payload).toEqual({ reason: "branch_not_taken" });
  });

  it("skips the error route when the node succeeds", async () => {
    const { rt, promise, result } = launch(def("errorRoute"));
    await promise;
    expect(result.value?.status).toBe("completed");
    expect(rt.events.find((e) => e.nodeId === "recover" && e.type === "node_skipped")?.payload).toEqual({ reason: "error_route_not_taken" });
  });
});

describe("waiting for people and systems", () => {
  const waitDef = (cfg: Record<string, unknown> = {}) =>
    definition([start(), node("appr", "task.approval", "wait", { config: cfg }), act("yes"), act("no"), act("late")], [edge("start", "appr"), edge("appr", "yes", "approved"), edge("appr", "no", "rejected"), edge("appr", "late", "timeout")]);

  it("parks, reports waiting, and resumes on a verdict", async () => {
    const { rt, interp, promise, result } = launch(waitDef());
    await rt.idle();
    expect(rt.statuses.at(-1)).toBe("waiting");
    expect(rt.hooks.map((h) => h.name)).toContain("waitRegistered");
    interp.validateResolve("appr", { nextPort: "approved", output: { by: "ana" } });
    interp.resolveNode("appr", { nextPort: "approved", output: { by: "ana" } });
    await promise;
    expect(result.value?.status).toBe("completed");
    expect(rt.types("yes")).toContain("node_completed");
    expect(rt.types("no")).toEqual(["node_skipped"]);
  });

  it("rejects malformed, unknown, duplicate and premature verdicts", async () => {
    const { rt, interp } = launch(waitDef());
    await rt.idle();
    expect(() => interp.validateResolve("", {})).toThrowError(/nodeId/);
    expect(() => interp.validateResolve("appr", { bogus: 1 })).toThrowError(/unknown resolution key/);
    expect(() => interp.validateResolve("appr", { nextPort: "errorRoute" })).toThrowError(/nextPort/);
    expect(() => interp.validateResolve("ghost", {})).toThrowError(/no node/);
    expect(() => interp.validateResolve("yes", {})).toThrowError(/not waiting/);
    interp.resolveNode("appr", { nextPort: "approved" });
    expect(() => interp.validateResolve("appr", { nextPort: "approved" })).toThrowError(/already has a verdict/);
  });

  it("emits SLA warning and breach, then takes the timeout route", async () => {
    const { rt, promise, result } = launch(waitDef({ warnAfter: "1h", breachAfter: "2h", timeout: "3h" }));
    await rt.advance(61 * 60_000);
    expect(rt.types()).toContain("sla_warning");
    await rt.advance(60 * 60_000);
    expect(rt.types()).toContain("sla_breached");
    await rt.advance(60 * 60_000);
    await promise;
    expect(rt.types("late")).toContain("node_completed");
    expect(rt.types()).toContain("wait_timed_out");
    expect(result.value?.status).toBe("completed");
  });

  it("fails a timed-out wait that has no timeout route", async () => {
    const def = definition([start(), node("w", "task.user", "wait", { config: { timeout: "1m" } }), act("next")], [edge("start", "w"), edge("w", "next")]);
    const { rt, promise, result } = launch(def);
    await rt.advance(120_000);
    await promise;
    expect(result.value).toMatchObject({ status: "failed", error: { code: "wait_timeout" } });
  });

  it("delivers external events, buffering the ones that arrive early", async () => {
    const def = definition([start(), node("ev", "flow.wait-event", "wait", { config: { eventName: "certificate.signed", correlation: "{{trigger.otId}}" } }), act("after")], [edge("start", "ev"), edge("ev", "after")]);
    const first = launch(def, { triggerPayload: { otId: "OT-1" } });
    await first.rt.idle();
    expect(first.interp.signalEvent("certificate.signed", { n: 1 }, "OT-OTHER")).toBe(0); // other correlation, buffered
    expect(first.interp.signalEvent("certificate.signed", { n: 2 }, "OT-1")).toBe(1);
    await first.promise;
    expect(first.result.value?.status).toBe("completed");

    // an event that arrives before the wait starts is consumed when it does
    const rt = new FakeRuntime();
    const late = definition([start(), act("slow"), node("ev", "flow.wait-event", "wait", { config: { eventName: "ping" } })], [edge("start", "slow"), edge("slow", "ev")]);
    rt.activities["act.slow"] = async () => { await rt.sleep(1000); return {}; };
    const run = launch(late, {}, rt);
    await rt.idle();
    run.interp.signalEvent("ping", { early: true });
    await rt.advance(2000);
    await run.promise;
    expect(run.result.value?.status).toBe("completed");
  });

  it("sleeps on durable timers, in business hours when asked", async () => {
    const def = definition([start(), node("t", "flow.timer", "timer", { config: { duration: "2h", businessHours: true } }), act("after")], [edge("start", "t"), edge("t", "after")]);
    const rt = new FakeRuntime();
    rt.time = Date.parse("2026-03-06T16:00:00Z"); // Friday 17:00 in Madrid, 1 working hour left
    const { promise, result } = launch(def, {}, rt);
    await rt.advance(60 * 60_000); // Friday's remaining hour
    expect(rt.types("after")).toEqual([]);
    await rt.advance(48 * 3600_000); // weekend
    expect(rt.types("after")).toEqual([]);
    await rt.advance(17 * 3600_000); // Monday 10:00 Madrid (09:00 UTC) is when the second working hour ends
    await promise;
    expect(result.value?.status).toBe("completed");
  });
});

describe("saga, sub-processes and termination", () => {
  it("compensates completed steps in reverse order when a later step fails", async () => {
    const def = definition(
      [start(), act("a", { compensate: { type: "undo.a" } }), act("b", { compensate: { type: "undo.b" } }), act("c")],
      [edge("start", "a"), edge("a", "b"), edge("b", "c")],
      { saga: "failure" },
    );
    const rt = new FakeRuntime();
    rt.activities["act.c"] = () => { throw new Error("cannot book"); };
    const { promise, result } = launch(def, {}, rt);
    await promise;
    expect(result.value).toMatchObject({ status: "failed", compensated: true });
    expect(rt.compensated).toEqual(["b", "a"]);
  });

  it("keeps compensating when one compensation fails", async () => {
    const def = definition([start(), act("a", { compensate: { type: "undo.a" } }), act("b", { compensate: { type: "boom" } }), act("c")], [edge("start", "a"), edge("a", "b"), edge("b", "c")]);
    const rt = new FakeRuntime();
    rt.activities["act.c"] = () => { throw new Error("x"); };
    const { promise } = launch(def, {}, rt);
    await promise;
    expect(rt.types()).toContain("compensation_failed");
    expect(rt.compensated).toEqual(["a"]);
  });

  it("waits for a sub-process and fails when it fails", async () => {
    const def = definition([start(), node("sub", "flow.subprocess", "subprocess", { config: { flowId: "child", input: { x: "{{trigger.x}}" } } }), act("after")], [edge("start", "sub"), edge("sub", "after")]);
    const rt = new FakeRuntime();
    let seen: unknown;
    rt.children.child = (spec) => { seen = spec.input; return { executionId: "c1", status: "completed", outcome: { value: "ok" } }; };
    const ok = launch(def, { triggerPayload: { x: 7 } }, rt);
    await ok.promise;
    expect(seen).toEqual({ x: 7 });
    expect(ok.result.value?.status).toBe("completed");

    const rt2 = new FakeRuntime();
    rt2.children.child = () => ({ executionId: "c2", status: "failed", error: "child exploded" });
    const bad = launch(def, {}, rt2);
    await bad.promise;
    expect(bad.result.value).toMatchObject({ status: "failed", error: { message: "child exploded" } });
  });

  it("refuses runaway sub-process nesting", async () => {
    const def = definition([start(), node("sub", "flow.subprocess", "subprocess", { config: { flowId: "self" } })], [edge("start", "sub")]);
    const { promise, result } = launch(def, { depth: 6 });
    await promise;
    expect(result.value).toMatchObject({ status: "failed", error: { code: "max_depth" } });
  });

  it("a terminating end node stops the other branches", async () => {
    const def = definition(
      [start(), node("split", "flow.parallel", "inline"), node("end", "flow.end", "end", { config: { terminate: true, outcomeValue: "done", resolvedBy: "end" } }), node("slow", "task.user", "wait"), act("never")],
      [edge("start", "split"), edge("split", "end"), edge("split", "slow"), edge("slow", "never")],
    );
    const { rt, promise, result } = launch(def);
    await promise;
    expect(result.value).toMatchObject({ status: "completed", outcome: { value: "done" } });
    expect(rt.events.find((e) => e.nodeId === "slow" && e.type === "node_skipped")).toBeTruthy();
  });

  it("handles cancellation: compensates and ends cancelled", async () => {
    const def = definition([start(), act("a", { compensate: { type: "undo.a" } }), node("w", "task.user", "wait")], [edge("start", "a"), edge("a", "w")], { saga: "cancel" });
    const { rt, promise, result } = launch(def);
    await rt.idle();
    rt.cancel();
    await promise;
    expect(result.value).toEqual({ status: "cancelled" });
    expect(rt.compensated).toEqual(["a"]);
    expect(rt.statuses.at(-1)).toBe("cancelled");
  });
});

describe("operator controls", () => {
  it("pauses before the next node and resumes", async () => {
    const def = definition([start(), act("a"), act("b")], [edge("start", "a"), edge("a", "b")]);
    const rt = new FakeRuntime();
    rt.activities["act.a"] = async () => { await rt.sleep(1000); return {}; };
    const { interp, promise, result } = launch(def, {}, rt);
    await rt.idle();
    interp.pause();
    await rt.advance(2000);
    expect(rt.types("a")).toContain("node_completed");
    expect(rt.types("b")).toEqual([]);
    expect(rt.statuses).toContain("paused");
    interp.resume();
    await promise;
    expect(result.value?.status).toBe("completed");
  });

  it("step mode advances one node per step", async () => {
    const def = definition([start(), act("a"), act("b")], [edge("start", "a"), edge("a", "b")]);
    const { rt, interp, promise, result } = launch(def, { stepMode: true });
    await rt.idle();
    expect(rt.types("start")).toEqual(["node_step_pending"]);
    interp.step();
    await rt.idle();
    expect(rt.types("a")).toEqual(["node_step_pending"]);
    interp.step(2);
    await promise;
    expect(result.value?.status).toBe("completed");
  });
});

describe("continue-as-new", () => {
  it("snapshots parked waits and finishes in the next run", async () => {
    const def = definition([start(), node("w", "task.user", "wait", { config: { timeout: "10d" } }), act("after")], [edge("start", "w"), edge("w", "after", "approved"), edge("w", "after", "timeout")]);
    const rt = new FakeRuntime();
    rt.cnaSuggested = true;
    const first = launch(def, {}, rt);
    await rt.idle();
    // the loop only re-checks after a task settles; force it through a resolved sibling by resolving later
    const snapshotFromQuery = first.interp.snapshot();
    expect(snapshotFromQuery.parked.map((p) => p.nodeId)).toEqual(["w"]);

    const rt2 = new FakeRuntime();
    rt2.time = rt.time + 3 * 86_400_000;
    const second = new Interpreter(rt2, { executionId: "exec-1", definition: def, triggerPayload: {}, variables: {}, global: {}, resume: snapshotFromQuery }, coreInline);
    const done = second.run();
    await rt2.idle();
    second.resolveNode("w", { nextPort: "approved" });
    expect(await done).toMatchObject({ status: "completed" });
    expect(rt2.types()).not.toContain("execution_started");
    expect(rt2.types("w")).not.toContain("node_started");
  });

  it("triggers continueAsNew at a safe point", async () => {
    const def = definition(
      [start(), node("split", "flow.parallel", "inline"), node("w", "task.user", "wait"), act("quick"), act("tail")],
      [edge("start", "split"), edge("split", "w"), edge("split", "quick"), edge("quick", "tail")],
    );
    const rt = new FakeRuntime();
    rt.cnaSuggested = true;
    const run = launch(def, {}, rt);
    await run.promise;
    expect(run.result.error).toBeInstanceOf(ContinuedAsNew);
    const snap = (run.result.error as ContinuedAsNew).snapshot;
    expect(snap.parked.map((p) => p.nodeId)).toEqual(["w"]);
    expect(snap.status.tail).toBe("completed");
  });
});
