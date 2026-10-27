import type { DiagramEdge, DiagramNode } from "@orchestrador/shared";

type Props = Record<string, unknown>;

/**
 * Small DSL to author process templates as code. It produces the same diagram JSON the editor stores,
 * so a seeded template can be opened, edited and versioned like any other flow.
 */
export class FlowBuilder {
  private readonly nodes: { id: string; type: string; label: string; props: Props; start: boolean }[] = [];
  private readonly edges: { from: string; to: string; port?: string }[] = [];

  start(id = "trigger", label = "Inicio"): this {
    this.nodes.push({ id, type: "flow.trigger", label, props: {}, start: true });
    return this;
  }

  node(id: string, type: string, label: string, props: Props = {}): this {
    this.nodes.push({ id, type, label, props: { ...props }, start: false });
    return this;
  }

  /** Connects `from` to `to`, optionally through a named output port (`done`, `true`, `timeout`...). */
  link(from: string, to: string, port?: string): this {
    this.edges.push({ from, to, ...(port ? { port } : {}) });
    return this;
  }

  /** `a → b → c` along the default output. */
  chain(...ids: string[]): this {
    for (let i = 0; i < ids.length - 1; i++) this.link(ids[i]!, ids[i + 1]!);
    return this;
  }

  end(id: string, label: string, status: "completed" | "failed" | "cancelled" = "completed", message = ""): this {
    return this.node(id, "flow.end", label, { status, ...(message ? { message } : {}) });
  }

  build(name: string): { name: string; layoutDirection: "RIGHT"; nodes: DiagramNode[]; edges: DiagramEdge[] } {
    // Longest-path layering keeps branches readable without a layout engine.
    const depth = new Map<string, number>(this.nodes.map((n) => [n.id, 0]));
    for (let pass = 0; pass < this.nodes.length; pass++) {
      for (const e of this.edges) depth.set(e.to, Math.max(depth.get(e.to) ?? 0, (depth.get(e.from) ?? 0) + 1));
    }
    const rows = new Map<number, number>();
    const nodes: DiagramNode[] = this.nodes.map((n) => {
      const d = depth.get(n.id) ?? 0;
      const row = rows.get(d) ?? 0;
      rows.set(d, row + 1);
      return {
        id: n.id,
        type: "node",
        position: { x: d * 300, y: row * 170 },
        data: { type: n.type, isStartNode: n.start, properties: { label: n.label, ...n.props } },
      };
    });
    const edges: DiagramEdge[] = this.edges.map((e, i) => ({
      id: `e${i + 1}`,
      source: e.from,
      target: e.to,
      ...(e.port ? { sourceHandle: `source:inner:${e.port}` } : {}),
    }));
    return { name, layoutDirection: "RIGHT", nodes, edges };
  }
}
