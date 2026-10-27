import { describe, expect, it } from "vitest";

import { isLegacyDiagram, migrateLegacyDiagram, compileDiagram, defaultProperties, findCycle, nodeDefinition, parseDuration, toDefinition, validateNodeConfig } from "../src/index.js";

type Props = Record<string, unknown>;
const node = (id: string, type: string, properties: Props = {}, start = false) => ({ id, data: { type, properties, ...(start ? { isStartNode: true } : {}) } });
const edge = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}>${target}${sourceHandle ?? ""}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
const codes = (raw: unknown) => compileDiagram(raw, "t").issues.map((i) => i.code);

describe("compileDiagram", () => {
  const valid = {
    nodes: [node("t", "flow.trigger", {}, true), node("c", "flow.condition", { left: "{{trigger.n}}", operator: "gt", right: "3" }), node("a", "flow.log"), node("b", "flow.log")],
    edges: [edge("t", "c"), edge("c", "a", "true"), edge("c", "b", "false")],
  };

  it("compiles a valid flow with kinds, default ports and exec profiles", () => {
    const { definition, issues } = compileDiagram(valid, "t");
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const cond = definition!.nodes.find((n) => n.id === "c")!;
    expect(cond.kind).toBe("inline");
    expect(cond.defaultPort).toBe("true");
    const task = compileDiagram({ nodes: [node("t", "flow.trigger", {}, true), node("u", "human.user-task", { title: "x" })], edges: [edge("t", "u"), edge("u", "t", "done")] }, "t");
    expect(task.issues.some((i) => i.code === "cycle")).toBe(true);
  });

  it("reports every problem at once, with node ids", () => {
    const bad = {
      nodes: [node("t", "flow.trigger", {}, true), node("h", "int.http", { url: "", method: "FETCH" }), node("x", "does.not.exist"), node("lonely", "flow.log")],
      edges: [edge("t", "h"), edge("h", "ghost")],
    };
    const result = compileDiagram(bad, "t");
    expect(result.definition).toBeNull();
    expect(result.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["invalid_config", "unknown_type", "dangling_edge", "orphan"]));
    expect(result.issues.find((i) => i.code === "unknown_type")?.nodeId).toBe("x");
  });

  it("rejects cycles and names the path", () => {
    const cyc = { nodes: [node("t", "flow.trigger", {}, true), node("a", "flow.log"), node("b", "flow.log")], edges: [edge("t", "a"), edge("a", "b"), edge("b", "a")] };
    expect(codes(cyc)).toContain("cycle");
    expect(findCycle([{ id: "a" }, { id: "b" }], [{ sourceNodeId: "a", targetNodeId: "b" }, { sourceNodeId: "b", targetNodeId: "a" }])).toEqual(["a", "b", "a"]);
    expect(() => toDefinition(cyc, "t")).toThrow(/cycle/);
  });

  it("requires a route for ports that can fire and for configured timeouts", () => {
    const flow = (props: Props, extra: ReturnType<typeof edge>[] = []) => ({
      nodes: [node("t", "flow.trigger", {}, true), node("w", "flow.wait-event", { eventName: "cert.signed", ...props }), node("ok", "flow.log"), node("late", "flow.log")],
      edges: [edge("t", "w"), edge("w", "ok", "received"), ...extra],
    });
    expect(codes(flow({ timeout: "2d" }))).toContain("missing_timeout_route");
    expect(codes(flow({ timeout: "2d" }, [edge("w", "late", "timeout")]))).not.toContain("missing_timeout_route");
    expect(codes(flow({ timeout: "banana" }, [edge("w", "late", "timeout")]))).toContain("invalid_config");
  });

  it("rejects edges that leave through an unknown port or skip the port of a branching node", () => {
    const flow = (handle?: string) => ({ nodes: [node("t", "flow.trigger", {}, true), node("c", "flow.condition", { left: "a", operator: "truthy" }), node("x", "flow.log")], edges: [edge("t", "c"), edge("c", "x", handle)] });
    expect(codes(flow())).toContain("bad_port");
    expect(codes(flow("maybe"))).toContain("bad_port");
    expect(codes(flow("true"))).not.toContain("bad_port");
  });

  it("forbids error policy continue on branching nodes and requires an error edge for errorRoute", () => {
    const f = (policy: string, withEdge: boolean) => ({
      nodes: [node("t", "flow.trigger", {}, true), node("h", "int.http", { url: "http://x", method: "GET", errorPolicy: policy }), node("c", "flow.condition", { left: "a", operator: "truthy", errorPolicy: "continue" }), node("r", "flow.log")],
      edges: [edge("t", "h"), edge("h", "c"), edge("c", "r", "true"), ...(withEdge ? [edge("h", "r", "errorRoute")] : [])],
    });
    expect(codes(f("errorRoute", false))).toContain("missing_error_route");
    expect(codes(f("errorRoute", true))).not.toContain("missing_error_route");
    expect(codes(f("fail", false))).toContain("branching_continue");
  });

  it("still compiles proof-of-concept diagrams", () => {
    const poc = { nodes: [node("t", "poc/trigger", {}, true), node("a", "poc/approval", { prompt: "?" }), node("y", "poc/log", { message: "y" })], edges: [edge("t", "a"), edge("a", "y", "source:inner:approved")] };
    expect(compileDiagram(poc, "t").definition?.nodes.find((n) => n.id === "a")?.kind).toBe("wait");
  });
});

describe("catalog", () => {
  it("validates field types, ranges, options, JSON and durations; ignores templates", () => {
    const def = nodeDefinition("comm.notify")!;
    expect(validateNodeConfig(def, { channel: "email", to: "a@b.c", variables: "{not json" })).toEqual(['"Variables de plantilla (JSON)" is not valid JSON']);
    expect(validateNodeConfig(def, { channel: "pigeon", to: "x" })[0]).toMatch(/unknown value/);
    expect(validateNodeConfig(def, { channel: "email", to: "{{entity.email}}", variables: "{{variables.v}}" })).toEqual([]);
    expect(validateNodeConfig(nodeDefinition("flow.timer")!, { duration: "soon" })[0]).toMatch(/valid duration/);
  });

  it("builds default properties for the palette", () => {
    expect(defaultProperties(nodeDefinition("flow.timer")!)).toMatchObject({ label: "Temporizador", duration: "1h", businessHours: false });
  });

  it("parses durations", () => {
    expect([parseDuration("90s"), parseDuration("2h"), parseDuration("PT1H30M"), parseDuration("P2D"), parseDuration(5), parseDuration("x")]).toEqual([90_000, 7_200_000, 5_400_000, 172_800_000, 5000, null]);
  });
});

describe("legacy migration", () => {
  it("moves a POC diagram to the v2 catalog and keeps it compilable", () => {
    const poc = {
      nodes: [
        node("t", "poc/trigger", {}, true),
        node("w", "poc/wait", { seconds: 5 }),
        node("s", "poc/switch", { value: "{{trigger.k}}", caseOne: "a", caseTwo: "b", caseThree: "c" }),
        node("x", "poc/log"),
        node("y", "poc/log"),
        node("ap", "poc/approval", { prompt: "¿OK?" }),
        node("z", "poc/log"),
      ],
      edges: [edge("t", "w"), edge("w", "s"), edge("s", "x", "source:inner:one"), edge("s", "y", "source:inner:default"), edge("s", "ap", "source:inner:two"), edge("ap", "z", "source:inner:approved")],
    };
    expect(isLegacyDiagram(poc)).toBe(true);
    const migrated = migrateLegacyDiagram(poc);
    expect(isLegacyDiagram(migrated)).toBe(false);
    const { definition, issues } = compileDiagram(migrated, "t");
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(definition!.nodes.map((n) => n.type)).toEqual(["flow.trigger", "flow.timer", "flow.switch", "flow.log", "flow.log", "human.approval", "flow.log"]);
    expect(definition!.nodes.find((n) => n.id === "w")!.config.duration).toBe("5s");
    expect(definition!.edges.find((e) => e.targetNodeId === "x")!.sourceHandle).toBe("c1");
  });
});
