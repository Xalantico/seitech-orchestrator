import { Interpreter } from "../src/interpreter.js";
import { coreInline } from "../src/inline.js";
import type {
  ChildResult,
  ChildSpec,
  CompensationEntry,
  CompiledDefinition,
  CompiledEdge,
  CompiledNode,
  EngineSnapshot,
  ExecStatus,
  ExecutionInput,
  ExecutionResult,
  NodeContext,
  NodeResult,
  Runtime,
} from "../src/types.js";

export class Cancelled extends Error {}
export class ContinuedAsNew extends Error {
  constructor(public snapshot: EngineSnapshot) {
    super("continued as new");
  }
}

type Waiter = { pred: () => boolean; resolve: (v: boolean) => void; reject: (e: unknown) => void; deadline?: number };

/** Virtual-time runtime: no real timers, fully deterministic. */
export class FakeRuntime implements Runtime {
  time = Date.parse("2026-03-02T08:00:00Z"); // a Monday
  events: { type: string; payload?: unknown; nodeId?: string }[] = [];
  statuses: ExecStatus[] = [];
  hooks: { name: string; payload: Record<string, unknown> }[] = [];
  compensated: string[] = [];
  activities: Record<string, (node: CompiledNode, ctx: NodeContext) => NodeResult | Promise<NodeResult>> = {};
  children: Record<string, (spec: ChildSpec) => ChildResult | Promise<ChildResult>> = {};
  cancelled = false;
  cnaSuggested = false;
  private waiters = new Set<Waiter>();
  private counter = 0;

  now() {
    return this.time;
  }
  uuid() {
    return `uuid-${++this.counter}`;
  }
  sleep(ms: number) {
    return this.waitFor(() => false, ms).then(() => undefined);
  }
  waitFor(pred: () => boolean, timeoutMs?: number): Promise<boolean> {
    if (this.cancelled) return Promise.reject(new Cancelled());
    if (pred()) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      this.waiters.add({ pred, resolve, reject, deadline: timeoutMs === undefined ? undefined : this.time + timeoutMs });
      this.startPolling();
    });
  }

  private polling = false;
  /** Temporal re-evaluates `condition()` predicates on every activation; emulate that. */
  private startPolling() {
    if (this.polling) return;
    this.polling = true;
    const tick = () => {
      for (const w of [...this.waiters]) {
        if (w.pred()) {
          this.waiters.delete(w);
          w.resolve(true);
        }
      }
      if (this.waiters.size === 0) {
        this.polling = false;
        return;
      }
      setImmediate(tick);
    };
    setImmediate(tick);
  }
  emit(type: string, payload?: unknown, nodeId?: string) {
    this.events.push({ type, payload, nodeId });
  }
  async flush() {}
  async setStatus(status: ExecStatus) {
    this.statuses.push(status);
  }
  async runNode(node: CompiledNode, ctx: NodeContext): Promise<NodeResult> {
    const fn = this.activities[node.type];
    if (!fn) return { output: { ran: node.id } };
    return fn(node, ctx);
  }
  async runCompensation(entry: CompensationEntry) {
    if (entry.spec.type === "boom") throw new Error("compensation failed");
    this.compensated.push(entry.nodeId);
  }
  async hook(name: string, payload: Record<string, unknown>) {
    this.hooks.push({ name, payload });
  }
  async startChild(spec: ChildSpec): Promise<ChildResult> {
    const fn = this.children[spec.flowId];
    if (!fn) return { executionId: `child-${spec.flowId}`, status: "completed", outcome: null };
    return fn(spec);
  }
  async nonCancellable<T>(fn: () => Promise<T>): Promise<T> {
    const was = this.cancelled;
    this.cancelled = false;
    try {
      return await fn();
    } finally {
      this.cancelled = was;
    }
  }
  isCancellation(e: unknown) {
    return e instanceof Cancelled;
  }
  shouldContinueAsNew() {
    return this.cnaSuggested;
  }
  async continueAsNew(snapshot: EngineSnapshot): Promise<never> {
    throw new ContinuedAsNew(snapshot);
  }

  cancel() {
    this.cancelled = true;
    for (const w of [...this.waiters]) {
      this.waiters.delete(w);
      w.reject(new Cancelled());
    }
  }

  /** Re-evaluate waiters and let microtasks run until nothing changes. */
  async idle() {
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setImmediate(r));
      let changed = false;
      for (const w of [...this.waiters]) {
        if (w.pred()) {
          this.waiters.delete(w);
          w.resolve(true);
          changed = true;
        }
      }
      if (!changed && i > 3) return;
    }
  }

  /** Advance virtual time, firing deadlines in order. */
  async advance(ms: number) {
    const end = this.time + ms;
    await this.idle();
    for (;;) {
      const next = [...this.waiters].filter((w) => w.deadline !== undefined && w.deadline <= end).sort((a, b) => a.deadline! - b.deadline!)[0];
      if (!next) break;
      this.time = Math.max(this.time, next.deadline!);
      this.waiters.delete(next);
      next.resolve(next.pred());
      await this.idle();
    }
    this.time = end;
    await this.idle();
  }

  types(nodeId?: string) {
    return this.events.filter((e) => nodeId === undefined || e.nodeId === nodeId).map((e) => e.type);
  }
}

export const node = (id: string, type: string, kind: CompiledNode["kind"], extra: Partial<CompiledNode> = {}): CompiledNode => ({ id, type, kind, config: {}, ...extra });
export const edge = (from: string, to: string, handle?: string): CompiledEdge => ({ id: `${from}->${to}${handle ? `:${handle}` : ""}`, sourceNodeId: from, targetNodeId: to, ...(handle ? { sourceHandle: handle } : {}) });
export const start = () => node("start", "flow.trigger", "inline", { role: "start" });

export function definition(nodes: CompiledNode[], edges: CompiledEdge[], settings?: CompiledDefinition["settings"]): CompiledDefinition {
  return { workflowId: "test", nodes, edges, settings };
}

export function launch(def: CompiledDefinition, opts: Partial<ExecutionInput> = {}, rt = new FakeRuntime()) {
  const input: ExecutionInput = { executionId: "exec-1", definition: def, triggerPayload: {}, variables: {}, global: {}, ...opts };
  const interp = new Interpreter(rt, input, coreInline);
  const result: { value?: ExecutionResult; error?: unknown } = {};
  const promise = interp.run().then(
    (v) => (result.value = v),
    (e) => (result.error = e),
  );
  return { rt, interp, promise, result, input };
}
