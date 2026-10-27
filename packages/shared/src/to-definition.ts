import { nodeDefinition, validateNodeConfig, type NodeKindName, type QueueFamily, type RetrySpec } from "./catalog.js";
import "./catalog-core.js";
import { ERROR_POLICIES, NODE_TYPES, type ErrorPolicy } from "./node-types.js";
import { getDiagramGraph, type DiagramEdge, type DiagramNode } from "./diagram.js";

export type ExecutionNode = {
  id: string;
  type: string;
  label?: string;
  errorPolicy?: ErrorPolicy;
  role?: "start";
  /** How the interpreter runs the node (from the catalog). */
  kind: NodeKindName;
  join?: "all" | "any";
  /** Port followed when a waiting node is resolved without an explicit one. */
  defaultPort?: string;
  exec?: { queue?: QueueFamily; startToCloseTimeout?: string; heartbeatTimeout?: string; retry?: RetrySpec };
  compensate?: { type: string; config?: Record<string, unknown>; queue?: QueueFamily };
  config: Record<string, unknown>;
};

export type ExecutionEdge = {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceHandle?: string;
};

export type WorkflowDefinition = {
  workflowId: string;
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
  settings?: { saga?: "off" | "failure" | "cancel" | "always"; maxDepth?: number };
};

export class DiagramValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: ValidationIssue[] = [],
  ) {
    super(message);
    this.name = "DiagramValidationError";
  }
}

export type ValidationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};

const INNER_HANDLE = /^(?:source|target):inner:(.+)$/;
export const ERROR_ROUTE = "errorRoute";

export function normalizeHandle(handle?: string | null): string | undefined {
  if (!handle || handle === "source" || handle === "target") return undefined;
  const inner = handle.match(INNER_HANDLE);
  if (inner?.[1]) return inner[1];
  return handle;
}

function asErrorPolicy(value: unknown): ErrorPolicy {
  if (typeof value === "string" && (ERROR_POLICIES as readonly string[]).includes(value)) return value as ErrorPolicy;
  return "fail";
}

const isStartNode = (node: DiagramNode) =>
  node.data?.isStartNode === true || node.data?.type === NODE_TYPES.trigger || node.data?.type === "flow.trigger";

function toExecutionNode(node: DiagramNode, issues: ValidationIssue[]): ExecutionNode | null {
  const type = node.data?.type;
  if (!type) {
    issues.push({ severity: "error", code: "missing_type", nodeId: node.id, message: `Node ${node.id} is missing data.type` });
    return null;
  }
  const spec = nodeDefinition(type);
  if (!spec) {
    issues.push({ severity: "error", code: "unknown_type", nodeId: node.id, message: `Unsupported node type "${type}" on node ${node.id}` });
    return null;
  }
  const properties = { ...(node.data?.properties ?? {}) };
  const label = typeof properties.label === "string" && properties.label.length > 0 ? properties.label : spec.label || type;
  const errorPolicy = spec.noErrorPolicy ? "fail" : asErrorPolicy(properties.errorPolicy);
  const compensate = properties.compensate;
  const joinMode = properties.join === "any" || properties.join === "all" ? properties.join : spec.join;
  for (const key of ["label", "description", "errorPolicy", "decisionBranches", "status_ui", "compensate", "join"]) delete properties[key];
  // `status` is a UI-only property of the POC editor, but flow.end uses it for real.
  if (type !== "flow.end") delete properties.status;

  if (spec.branching && errorPolicy === "continue") {
    issues.push({ severity: "error", code: "branching_continue", nodeId: node.id, message: `${label} (${node.id}) cannot use error policy "continue": several routes would fire` });
  }

  for (const problem of validateNodeConfig(spec, properties)) {
    issues.push({ severity: "error", code: "invalid_config", nodeId: node.id, message: `${label} (${node.id}): ${problem}` });
  }
  for (const key of spec.required ?? []) {
    const value = properties[key];
    const blank = value === undefined || value === null || (typeof value === "string" && value.trim().length === 0);
    if (blank && !spec.fields.some((f) => f.key === key)) {
      issues.push({ severity: "error", code: "invalid_config", nodeId: node.id, message: `${label} (${node.id}): "${key}" is required` });
    }
  }
  if (type === NODE_TYPES.wait) {
    const seconds = Number(properties.seconds ?? 0);
    if (!Number.isFinite(seconds) || seconds < 0) {
      issues.push({ severity: "error", code: "invalid_config", nodeId: node.id, message: `${label} (${node.id}): seconds must be non-negative` });
    }
  }

  const exec = {
    ...(spec.queue ? { queue: spec.queue } : {}),
    ...(spec.startToCloseTimeout ? { startToCloseTimeout: spec.startToCloseTimeout } : {}),
    ...(spec.heartbeatTimeout ? { heartbeatTimeout: spec.heartbeatTimeout } : {}),
    ...(spec.retry ? { retry: spec.retry } : {}),
  };
  return {
    id: node.id,
    type,
    label,
    errorPolicy,
    kind: spec.kind,
    ...(joinMode ? { join: joinMode } : {}),
    ...(spec.ports?.[0] ? { defaultPort: spec.ports[0] } : {}),
    ...(Object.keys(exec).length > 0 ? { exec } : {}),
    ...(compensate && typeof compensate === "object" && typeof (compensate as { type?: unknown }).type === "string"
      ? { compensate: compensate as NonNullable<ExecutionNode["compensate"]> }
      : {}),
    ...(isStartNode(node) ? { role: "start" as const } : {}),
    config: properties,
  };
}

function toExecutionEdge(edge: DiagramEdge, index: number): ExecutionEdge {
  const sourceHandle = normalizeHandle(edge.sourceHandle);
  return {
    id: edge.id ?? `e-${index}`,
    sourceNodeId: edge.source,
    targetNodeId: edge.target,
    ...(sourceHandle ? { sourceHandle } : {}),
  };
}

export type CompileResult = { definition: WorkflowDefinition | null; issues: ValidationIssue[] };

/**
 * Compiles a diagram and reports EVERY problem (live validation in the editor, publish gate, simulation start).
 * `definition` is null when any error-level issue exists.
 */
export function compileDiagram(raw: unknown, workflowId: string): CompileResult {
  const issues: ValidationIssue[] = [];
  let graph;
  try {
    graph = getDiagramGraph(raw);
  } catch (error) {
    return { definition: null, issues: [{ severity: "error", code: "invalid_diagram", message: error instanceof Error ? error.message : "Invalid diagram" }] };
  }
  const { nodes, edges } = graph;
  if (nodes.length === 0) {
    return { definition: null, issues: [{ severity: "error", code: "empty", message: "Diagram has no nodes" }] };
  }
  if (!nodes.some(isStartNode)) issues.push({ severity: "error", code: "no_start", message: "Diagram needs a Trigger (start) node" });

  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) issues.push({ severity: "error", code: "duplicate_node", nodeId: node.id, message: `Duplicate node id ${node.id}` });
    seen.add(node.id);
  }

  const mappedNodes = nodes.map((n) => toExecutionNode(n, issues)).filter((n): n is ExecutionNode => n !== null);
  const nodeById = new Map(mappedNodes.map((n) => [n.id, n]));
  const mappedEdges = edges.map(toExecutionEdge);

  const incoming = new Map<string, number>();
  for (const edge of mappedEdges) {
    if (!seen.has(edge.sourceNodeId) || !seen.has(edge.targetNodeId)) {
      issues.push({ severity: "error", code: "dangling_edge", edgeId: edge.id, message: `Edge ${edge.sourceNodeId} -> ${edge.targetNodeId} references a missing node` });
      continue;
    }
    incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) ?? 0) + 1);
    const source = nodeById.get(edge.sourceNodeId);
    if (!source) continue;
    const def = nodeDefinition(source.type);
    const ports = def?.ports ?? [];
    const handle = edge.sourceHandle;
    if (handle === ERROR_ROUTE) {
      if (source.errorPolicy !== "errorRoute") {
        issues.push({ severity: "warning", code: "error_edge_unused", edgeId: edge.id, nodeId: source.id, message: `${source.label} (${source.id}) has an error route but its error policy is not "errorRoute"` });
      }
    } else if (ports.length > 0) {
      if (!handle || !ports.includes(handle)) {
        issues.push({ severity: "error", code: "bad_port", edgeId: edge.id, nodeId: source.id, message: `${source.label} (${source.id}) must leave through one of: ${ports.join(", ")}` });
      }
    } else if (handle) {
      issues.push({ severity: "error", code: "bad_port", edgeId: edge.id, nodeId: source.id, message: `${source.label} (${source.id}) has no output port "${handle}"` });
    }
  }

  for (const node of mappedNodes) {
    const outgoing = mappedEdges.filter((e) => e.sourceNodeId === node.id);
    if (node.errorPolicy === "errorRoute" && !outgoing.some((e) => e.sourceHandle === ERROR_ROUTE)) {
      issues.push({ severity: "error", code: "missing_error_route", nodeId: node.id, message: `${node.label} (${node.id}) uses error policy "errorRoute" but has no error route edge` });
    }
    const ports = nodeDefinition(node.type)?.ports ?? [];
    const timeout = node.config.timeout;
    if (ports.includes("timeout") && timeout !== undefined && String(timeout).trim() !== "" && !outgoing.some((e) => e.sourceHandle === "timeout")) {
      issues.push({ severity: "error", code: "missing_timeout_route", nodeId: node.id, message: `${node.label} (${node.id}) expires after ${String(timeout)} but has no "timeout" route` });
    }
    if (node.role !== "start" && !incoming.get(node.id)) {
      issues.push({ severity: "error", code: "orphan", nodeId: node.id, message: `${node.label} (${node.id}) is not connected to the flow` });
    }
    const unconnected = ports.filter((p) => p !== "timeout" && !outgoing.some((e) => e.sourceHandle === p));
    if (ports.length > 0 && unconnected.length > 0 && unconnected.length < ports.length) {
      issues.push({ severity: "warning", code: "dead_end_port", nodeId: node.id, message: `${node.label} (${node.id}) has no route for: ${unconnected.join(", ")}; the flow ends there when that port is taken` });
    }
  }

  const cycle = findCycle(mappedNodes, mappedEdges.filter((e) => seen.has(e.sourceNodeId) && seen.has(e.targetNodeId)));
  if (cycle) {
    issues.push({ severity: "error", code: "cycle", nodeId: cycle[0], message: `The flow has a cycle (${cycle.join(" -> ")}); flows must be acyclic. Use a sub-process to repeat work.` });
  }

  const hasErrors = issues.some((i) => i.severity === "error");
  return { definition: hasErrors ? null : { workflowId, nodes: mappedNodes, edges: mappedEdges }, issues };
}

export function toDefinition(raw: unknown, workflowId: string): WorkflowDefinition {
  const { definition, issues } = compileDiagram(raw, workflowId);
  if (!definition) {
    const errors = issues.filter((i) => i.severity === "error");
    throw new DiagramValidationError(errors.map((e) => e.message).join("; "), issues);
  }
  return definition;
}

/** Returns one cycle as a node id path, or null when the graph is a DAG. */
export function findCycle(nodes: { id: string }[], edges: { sourceNodeId: string; targetNodeId: string }[]): string[] | null {
  const next = new Map<string, string[]>();
  for (const node of nodes) next.set(node.id, []);
  for (const edge of edges) next.get(edge.sourceNodeId)?.push(edge.targetNodeId);
  const color = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    path.push(id);
    for (const target of next.get(id) ?? []) {
      if (color.get(target) === 1) return [...path.slice(path.indexOf(target)), target];
      if (!color.has(target)) {
        const found = visit(target);
        if (found) return found;
      }
    }
    path.pop();
    color.set(id, 2);
    return null;
  };
  for (const node of nodes) {
    if (!color.has(node.id)) {
      const found = visit(node.id);
      if (found) return found;
    }
  }
  return null;
}
