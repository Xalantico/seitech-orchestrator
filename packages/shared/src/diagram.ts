export type DiagramNode = {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data?: {
    type?: string;
    icon?: string;
    isStartNode?: boolean;
    properties?: Record<string, unknown>;
  };
};

export type DiagramEdge = {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  type?: string;
  data?: Record<string, unknown>;
};

export type IntegrationDiagram = {
  name?: string;
  layoutDirection?: "DOWN" | "RIGHT";
  globalVariables?: unknown;
  nodes?: DiagramNode[];
  edges?: DiagramEdge[];
  diagram?: {
    nodes?: DiagramNode[];
    edges?: DiagramEdge[];
    viewport?: unknown;
  };
};

export function getDiagramGraph(raw: unknown): {
  name: string;
  layoutDirection: "DOWN" | "RIGHT";
  globalVariables: unknown;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
} {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid diagram: expected an object");
  }
  const obj = raw as IntegrationDiagram;
  const nested = obj.diagram;
  const nodes = Array.isArray(obj.nodes)
    ? obj.nodes
    : Array.isArray(nested?.nodes)
      ? nested.nodes
      : null;
  const edges = Array.isArray(obj.edges)
    ? obj.edges
    : Array.isArray(nested?.edges)
      ? nested.edges
      : [];
  if (!nodes) {
    throw new Error("Invalid diagram: missing nodes");
  }
  return {
    name: typeof obj.name === "string" && obj.name.length > 0 ? obj.name : "Sin título",
    layoutDirection: obj.layoutDirection === "RIGHT" ? "RIGHT" : "DOWN",
    globalVariables: obj.globalVariables ?? {},
    nodes,
    edges,
  };
}
