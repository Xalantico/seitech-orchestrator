import type { CompiledDefinition, CompiledNode, NodeStatus } from "./types.js";

export const ERROR_HANDLE = "errorRoute";

type Edge = { node: CompiledNode; sourceHandle?: string };

export type SkipNote = { id: string; reason: "branch_not_taken" | "error_route_not_taken" | "upstream_skipped" };

/**
 * Dead-path-eliminating token propagation over the flow graph:
 *  - a node is ready when every predecessor is resolved and at least one incoming edge was live (AND-join), or
 *    on the first live edge when it is an OR-join (`join: "any"`);
 *  - a node whose incoming edges are all dead is skipped and the skip propagates.
 */
export class Graph {
  readonly nodes: Map<string, CompiledNode>;
  readonly adjacency = new Map<string, Edge[]>();
  readonly inDegree = new Map<string, number>();
  pending = new Map<string, number>();
  liveIncoming = new Map<string, number>();
  status = new Map<string, NodeStatus>();
  pruneKind = new Map<string, "error" | "branch">();

  constructor(definition: CompiledDefinition) {
    this.nodes = new Map(definition.nodes.map((n) => [n.id, n]));
    for (const n of definition.nodes) {
      this.inDegree.set(n.id, 0);
      this.liveIncoming.set(n.id, 0);
      this.status.set(n.id, "pending");
    }
    for (const e of definition.edges) {
      const target = this.nodes.get(e.targetNodeId);
      if (!target || !this.nodes.has(e.sourceNodeId)) continue;
      const list = this.adjacency.get(e.sourceNodeId) ?? [];
      list.push({ node: target, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}) });
      this.adjacency.set(e.sourceNodeId, list);
      this.inDegree.set(e.targetNodeId, (this.inDegree.get(e.targetNodeId) ?? 0) + 1);
    }
    this.pending = new Map(this.inDegree);
  }

  hasHandle(nodeId: string, handle: string): boolean {
    return (this.adjacency.get(nodeId) ?? []).some((e) => e.sourceHandle === handle);
  }

  /** Exactly one start node, without incoming edges, and no orphans. */
  resolveStart(): { start: CompiledNode } | { error: string } {
    const starts = [...this.nodes.values()].filter((n) => n.role === "start");
    if (starts.length === 0) return { error: "Workflow has no start node: exactly one node must be marked as the start node" };
    if (starts.length > 1) return { error: `Workflow has ${starts.length} start nodes, but exactly one is allowed: ${starts.map((n) => n.id).join(", ")}` };
    const start = starts[0]!;
    if ((this.inDegree.get(start.id) ?? 0) > 0) return { error: `Start node "${start.id}" has incoming edges: the start node must have none` };
    const orphans = [...this.nodes.values()].filter((n) => n.id !== start.id && (this.inDegree.get(n.id) ?? 0) === 0);
    if (orphans.length > 0) return { error: `Workflow has orphaned nodes (no incoming edge and not a start node): ${orphans.map((n) => n.id).join(", ")}` };
    return { start };
  }

  private edgeLive(sourceLive: boolean, nextPort: string | undefined, handle: string | undefined): boolean {
    if (!sourceLive) return false;
    const isErrorEdge = handle === ERROR_HANDLE;
    if (nextPort === ERROR_HANDLE) return isErrorEdge;
    if (isErrorEdge) return false;
    return !nextPort || handle === nextPort;
  }

  /**
   * Resolves `rootId` (completed, or failed with an error route) and returns the nodes that became ready, the nodes
   * that were skipped, and a dead end when the chosen port leads nowhere.
   */
  propagate(rootId: string, rootPort: string | undefined): { ready: CompiledNode[]; skipped: SkipNote[]; deadEnd?: { nodeId: string; port: string } } {
    const ready: CompiledNode[] = [];
    const skipped: SkipNote[] = [];
    const routed = (this.adjacency.get(rootId) ?? []).some((e) => this.edgeLive(true, rootPort, e.sourceHandle));
    const queue: { from: string; port: string | undefined; live: boolean }[] = [{ from: rootId, port: rootPort, live: true }];
    while (queue.length > 0) {
      const { from, port, live } = queue.shift()!;
      for (const { node: target, sourceHandle } of this.adjacency.get(from) ?? []) {
        const edgeLive = this.edgeLive(live, port, sourceHandle);
        this.pending.set(target.id, (this.pending.get(target.id) ?? 0) - 1);
        if (edgeLive) {
          this.liveIncoming.set(target.id, (this.liveIncoming.get(target.id) ?? 0) + 1);
        } else if (live) {
          const kind = sourceHandle === ERROR_HANDLE ? "error" : "branch";
          if (this.pruneKind.get(target.id) !== "branch") this.pruneKind.set(target.id, kind);
        }
        const state = this.status.get(target.id);
        if (state !== "pending") continue;
        if (edgeLive && target.join === "any") {
          this.status.set(target.id, "ready");
          ready.push(target);
        } else if ((this.pending.get(target.id) ?? 0) === 0) {
          if ((this.liveIncoming.get(target.id) ?? 0) > 0) {
            this.status.set(target.id, "ready");
            ready.push(target);
          } else {
            this.status.set(target.id, "skipped");
            const kind = this.pruneKind.get(target.id);
            skipped.push({ id: target.id, reason: kind === undefined ? "upstream_skipped" : kind === "error" ? "error_route_not_taken" : "branch_not_taken" });
            queue.push({ from: target.id, port: undefined, live: false });
          }
        }
      }
    }
    return { ready, skipped, ...(rootPort && !routed ? { deadEnd: { nodeId: rootId, port: rootPort } } : {}) };
  }

  /** Nodes that never became ready although nothing is running. */
  stalled(): string[] {
    return [...this.pending].filter(([id, n]) => n > 0 && this.status.get(id) === "pending").map(([id]) => id);
  }
}
