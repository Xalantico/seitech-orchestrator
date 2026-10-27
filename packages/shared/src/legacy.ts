import { nodeDefinition } from "./catalog.js";
import "./catalog-core.js";
import { getDiagramGraph, type DiagramEdge, type DiagramNode } from "./diagram.js";

const TYPE_MAP: Record<string, string> = {
  "poc/trigger": "flow.trigger",
  "poc/condition": "flow.condition",
  "poc/decision": "flow.condition",
  "poc/switch": "flow.switch",
  "poc/set-variable": "flow.set-variable",
  "poc/transform": "flow.transform",
  "poc/log": "flow.log",
  "poc/wait": "flow.timer",
  "poc/approval": "human.approval",
  "poc/http-request": "int.http",
  "poc/notify": "comm.notify",
};

const SWITCH_PORTS: Record<string, string> = { one: "c1", two: "c2", three: "c3" };

const CHANNEL_MAP: Record<string, string> = { email: "email", sms: "sms", slack: "internal" };

function migrateNode(node: DiagramNode): DiagramNode {
  const type = node.data?.type;
  const next = type ? TYPE_MAP[type] : undefined;
  if (!next || !node.data) return node;
  const p = { ...(node.data.properties ?? {}) };
  switch (type) {
    case "poc/switch":
      p.case1 = p.caseOne;
      p.case2 = p.caseTwo;
      p.case3 = p.caseThree;
      delete p.caseOne;
      delete p.caseTwo;
      delete p.caseThree;
      break;
    case "poc/wait":
      p.duration = `${Math.max(0, Number(p.seconds ?? 0))}s`;
      delete p.seconds;
      break;
    case "poc/approval":
      p.title = p.prompt ?? "Aprobar";
      delete p.prompt;
      break;
    case "poc/notify":
      p.channel = CHANNEL_MAP[String(p.channel ?? "email")] ?? "email";
      break;
    default:
      break;
  }
  const def = nodeDefinition(next);
  if (def?.ports && def.branching) {
    p.decisionBranches = def.ports.map((id) => ({ id, sourceHandle: `source:inner:${id}`, label: def.portLabels?.[id] ?? id, conditions: [] }));
  } else {
    delete p.decisionBranches;
  }
  return { ...node, data: { ...node.data, type: next, properties: p } };
}

function migrateEdge(edge: DiagramEdge, nodesById: Map<string, DiagramNode>): DiagramEdge {
  const source = nodesById.get(edge.source);
  if (source?.data?.type !== "poc/switch" || !edge.sourceHandle) return edge;
  const handle = edge.sourceHandle.replace(/^(source:inner:)?(.+)$/, (_m, prefix: string | undefined, id: string) => `${prefix ?? ""}${SWITCH_PORTS[id] ?? id}`);
  return { ...edge, sourceHandle: handle };
}

/** True when the diagram still uses proof-of-concept node types. */
export function isLegacyDiagram(raw: unknown): boolean {
  try {
    return getDiagramGraph(raw).nodes.some((n) => n.data?.type?.startsWith("poc/") && n.data.type in TYPE_MAP);
  } catch {
    return false;
  }
}

/** Rewrites `poc/*` nodes (and their ports) to the v2 catalog. Nodes without a v2 equivalent are kept. */
export function migrateLegacyDiagram<T>(raw: T): T {
  const graph = getDiagramGraph(raw);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = graph.nodes.map(migrateNode);
  const edges = graph.edges.map((e) => migrateEdge(e, byId));
  const source = raw as { diagram?: unknown };
  if (source.diagram && typeof source.diagram === "object") {
    return { ...(raw as object), diagram: { ...(source.diagram as object), nodes, edges } } as T;
  }
  return { ...(raw as object), nodes, edges } as T;
}
