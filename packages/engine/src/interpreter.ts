import { interpolateValue, type TemplateContext } from "@orchestrador/shared";

import { addBusinessTime, DEFAULT_CALENDAR } from "./business-time.js";
import { parseDuration } from "./duration.js";
import { AbortedError, describeError, NodeError } from "./errors.js";
import { ERROR_HANDLE, Graph } from "./graph.js";
import { redactSensitive } from "./redact.js";
import {
  EngineRejection,
  type CompensationEntry,
  type CompiledNode,
  type EngineSnapshot,
  type ExecStatus,
  type ExecutionInput,
  type ExecutionResult,
  type InlineRegistry,
  type NodeContext,
  type NodeResult,
  type ParkedWait,
  type Resolution,
  type Runtime,
} from "./types.js";

type Abort =
  | { kind: "failure"; message: string; code?: string }
  | { kind: "cancelled" }
  | { kind: "terminated" };

type TaskDone =
  | { node: CompiledNode; type: "ok"; result: NodeResult }
  | { node: CompiledNode; type: "error"; message: string; code?: string; fatal: boolean }
  | { node: CompiledNode; type: "aborted" };

const MAX_EVENT_BUFFER = 200;

/**
 * The flow interpreter. It is a plain, deterministic state machine: every side effect goes through the injected
 * {@link Runtime}, which is Temporal in production and a virtual-time double in tests.
 */
export class Interpreter {
  readonly graph: Graph;
  private readonly rt: Runtime;
  private readonly input: ExecutionInput;
  private readonly inline: InlineRegistry;

  private outputs: Record<string, unknown> = {};
  private variables: Record<string, unknown>;
  private readonly running = new Map<string, Promise<TaskDone>>();
  private readonly active = new Set<string>();
  private readonly parked = new Map<string, ParkedWait>();
  private readonly waits = new Map<string, { status: "waiting" | "resolved"; resolution?: Resolution }>();
  private resolvedHistory: Record<string, Resolution> = {};
  private eventBuffer: EngineSnapshot["eventBuffer"] = [];
  private compensations: CompensationEntry[] = [];
  private deadEnds: { nodeId: string; port: string }[] = [];
  private outcome?: { value: string; resolvedBy: string; nodeId: string };
  private abort: Abort | null = null;
  private paused = false;
  private stepTokens = 0;
  private lastStatus: ExecStatus | null = null;
  private readonly startedAt: number;
  private generation: number;

  constructor(rt: Runtime, input: ExecutionInput, inline: InlineRegistry = {}) {
    this.rt = rt;
    this.input = input;
    this.inline = inline;
    this.graph = new Graph(input.definition);
    this.variables = { ...input.variables };
    this.startedAt = input.resume?.startedAt ?? rt.now();
    this.generation = (input.resume?.generation ?? 0) + (input.resume ? 1 : 0);
    if (input.resume) this.restore(input.resume);
  }

  // ───────────────────────────── public surface (signals, updates, queries) ─────────────────────────────

  /** Throws {@link EngineRejection}; used as the Temporal update validator so bad verdicts never enter history. */
  validateResolve(nodeId: unknown, resolution: unknown): void {
    if (typeof nodeId !== "string" || nodeId.length === 0) throw new EngineRejection("verdict_malformed", "nodeId must be a non-empty string");
    if (typeof resolution !== "object" || resolution === null || Array.isArray(resolution)) {
      throw new EngineRejection("verdict_malformed", "resolution must be an object");
    }
    for (const key of Object.keys(resolution)) {
      if (key !== "output" && key !== "nextPort" && key !== "outcome") throw new EngineRejection("verdict_malformed", `unknown resolution key '${key}'`);
    }
    const { nextPort, outcome } = resolution as Resolution;
    if (nextPort !== undefined && (typeof nextPort !== "string" || nextPort.length === 0 || nextPort === ERROR_HANDLE)) {
      throw new EngineRejection("verdict_malformed", "nextPort must be a non-empty string other than the reserved 'errorRoute'");
    }
    if (outcome !== undefined) {
      const ok = typeof outcome === "object" && outcome !== null && Object.keys(outcome).length === 2 && [outcome.value, outcome.resolvedBy].every((x) => typeof x === "string" && x.trim());
      if (!ok) throw new EngineRejection("verdict_malformed", "outcome must be an object carrying exactly value and resolvedBy, both non-empty strings");
    }
    if (!this.graph.nodes.has(nodeId)) throw new EngineRejection("verdict_for_unknown_node", `no node '${nodeId}' in this run`);
    const state = this.waits.get(nodeId);
    if (state?.status === "resolved") throw new EngineRejection("verdict_already_delivered", `node '${nodeId}' already has a verdict`);
    if (state === undefined) throw new EngineRejection("node_not_waiting", `node '${nodeId}' is not waiting for a verdict`);
  }

  resolveNode(nodeId: string, resolution: Resolution): void {
    this.waits.set(nodeId, { status: "resolved", resolution });
    this.resolvedHistory[nodeId] = resolution;
  }

  /** Delivers an external event to every matching wait; unmatched events are buffered for later waits. */
  signalEvent(name: string, payload: unknown, correlation?: string): number {
    let delivered = 0;
    for (const spec of this.parked.values()) {
      if (spec.kind !== "external_event" || spec.eventName !== name) continue;
      if (spec.correlation && spec.correlation !== correlation) continue;
      if (this.waits.get(spec.nodeId)?.status !== "waiting") continue;
      this.resolveNode(spec.nodeId, { output: payload });
      delivered += 1;
    }
    if (delivered === 0) {
      this.eventBuffer.push({ name, payload, ...(correlation ? { correlation } : {}) });
      if (this.eventBuffer.length > MAX_EVENT_BUFFER) this.eventBuffer.shift();
    }
    return delivered;
  }

  pause(): void {
    if (this.paused || this.abort) return;
    this.paused = true;
    this.emit("execution_paused");
    this.refreshStatus();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.emit("execution_resumed");
    this.refreshStatus();
  }

  /** Simulation step-through: lets `count` more nodes start. */
  step(count = 1): void {
    this.stepTokens += Math.max(1, count);
  }

  /** Cooperative stop used by the API "terminate" action (cancellation proper arrives via Temporal). */
  requestStop(message = "stopped by operator"): void {
    this.setAbort({ kind: "failure", message, code: "stopped" });
  }

  view() {
    return {
      status: this.currentStatus(),
      paused: this.paused,
      nodes: Object.fromEntries(this.graph.status),
      waiting: [...this.parked.values()],
      stepTokens: this.stepTokens,
      deadEnds: this.deadEnds,
    };
  }

  // ───────────────────────────── main loop ─────────────────────────────

  async run(): Promise<ExecutionResult> {
    const resuming = Boolean(this.input.resume);
    if (!resuming) {
      this.emit("execution_started", {
        workflowId: this.input.definition.workflowId,
        flowId: this.input.flowId ?? null,
        flowVersionId: this.input.flowVersionId ?? null,
        simulated: Boolean(this.input.simulated),
        entity: this.input.entity ?? null,
      });
    } else {
      this.emit("execution_resumed_from_snapshot", { generation: this.generation });
    }

    const queue: CompiledNode[] = [];
    if (resuming) {
      for (const [id, status] of this.graph.status) if (status === "ready") queue.push(this.graph.nodes.get(id)!);
    } else {
      const entry = this.graph.resolveStart();
      if ("error" in entry) return this.finishFailed({ message: entry.error, code: "invalid_definition" });
      this.graph.status.set(entry.start.id, "ready");
      queue.push(entry.start);
    }

    try {
      if (resuming) this.rearmParked();
      return await this.loop(queue);
    } catch (error) {
      if (this.rt.isCancellation(error)) return this.finishCancelled();
      throw error;
    }
  }

  private async loop(queue: CompiledNode[]): Promise<ExecutionResult> {
    for (;;) {
      while (queue.length > 0 && !this.stopping()) this.launch(queue.shift()!);
      if (this.stopping()) {
        // Ready-but-unstarted nodes will never run.
        for (const node of queue.splice(0)) {
          this.graph.status.set(node.id, "skipped");
          this.emit("node_skipped", { reason: "execution_aborted" }, node.id);
        }
      }
      if (this.running.size === 0) break;

      const done = await Promise.race(this.running.values());
      this.running.delete(done.node.id);
      queue.push(...this.settle(done));

      if (!this.abort && this.active.size === 0 && this.parked.size > 0 && queue.length === 0 && this.rt.shouldContinueAsNew()) {
        await this.rt.flush();
        await this.rt.continueAsNew(this.snapshot());
      }
    }
    return this.finish();
  }

  private stopping(): boolean {
    return this.abort !== null;
  }

  private launch(node: CompiledNode, parked?: ParkedWait): void {
    const promise = this.runTask(node, parked);
    this.running.set(node.id, promise);
  }

  // ───────────────────────────── one node ─────────────────────────────

  private async runTask(node: CompiledNode, parked?: ParkedWait): Promise<TaskDone> {
    try {
      if (!parked) {
        await this.gate(node);
        if (this.stopping()) {
          this.graph.status.set(node.id, "skipped");
          this.emit("node_skipped", { reason: "execution_aborted" }, node.id);
          return { node, type: "aborted" };
        }
        this.graph.status.set(node.id, "running");
        this.emit("node_started", { config: node.config, visibleNodeIds: Object.keys(this.outputs) }, node.id);
      }
      this.active.add(node.id);
      this.refreshStatus();
      const result = await this.execute(node, parked);
      this.emit("node_completed", { output: result.output }, node.id);
      return { node, type: "ok", result };
    } catch (error) {
      if (error instanceof AbortedError) {
        this.graph.status.set(node.id, "skipped");
        this.emit("node_skipped", { reason: "execution_aborted" }, node.id);
        return { node, type: "aborted" };
      }
      if (this.rt.isCancellation(error)) {
        this.setAbort({ kind: "cancelled" });
        return { node, type: "aborted" };
      }
      const described = error instanceof NodeError ? { message: error.message, code: error.code } : describeError(error);
      this.emit("node_failed", { error: { message: described.message, ...(described.code ? { code: described.code } : {}), ...("attempt" in described && described.attempt !== undefined ? { attempt: described.attempt } : {}) } }, node.id);
      return { node, type: "error", message: described.message, ...(described.code ? { code: described.code } : {}), fatal: error instanceof NodeError && error.fatal };
    } finally {
      this.active.delete(node.id);
      this.parked.delete(node.id);
      this.refreshStatus();
    }
  }

  /** Pause and step-through gates, evaluated before a node starts. */
  private async gate(node: CompiledNode): Promise<void> {
    if (this.paused) await this.rt.waitFor(() => !this.paused || this.stopping());
    if (this.input.stepMode && !this.stopping()) {
      this.emit("node_step_pending", {}, node.id);
      await this.rt.waitFor(() => this.stepTokens > 0 || this.stopping());
      if (this.stepTokens > 0) this.stepTokens -= 1;
    }
  }

  private async execute(node: CompiledNode, parked?: ParkedWait): Promise<NodeResult> {
    if (parked) return this.park(node, parked);
    switch (node.kind) {
      case "inline": {
        const fn = this.inline[node.type];
        if (!fn) throw new NodeError("unsupported_node", `No inline executor for node type "${node.type}"`, true);
        return fn(node, this.nodeContext());
      }
      case "activity": {
        const result = await this.rt.runNode(node, this.nodeContext());
        return result.waiting ? this.park(node) : result;
      }
      case "wait": {
        if (node.exec) {
          const result = await this.rt.runNode(node, this.nodeContext());
          if (result.waiting === false) return result;
        }
        return this.park(node);
      }
      case "timer":
        return this.timer(node);
      case "subprocess":
        return this.subprocess(node);
      case "end":
        return this.end(node);
      default:
        throw new NodeError("unsupported_node", `Unknown node kind "${String(node.kind)}"`, true);
    }
  }

  private templateContext(): TemplateContext {
    return {
      triggerPayload: this.input.triggerPayload,
      nodeOutputs: this.outputs,
      variables: this.variables,
      global: this.input.global,
      entity: { ...(this.input.entity ?? {}), ...((this.variables.entity as Record<string, unknown> | undefined) ?? {}) },
      execution: { id: this.input.executionId, flowId: this.input.flowId ?? null, simulated: Boolean(this.input.simulated) },
    };
  }

  private resolveConfig(node: CompiledNode): Record<string, unknown> {
    return interpolateValue(node.config, this.templateContext()) as Record<string, unknown>;
  }

  nodeContext(): NodeContext {
    return {
      workflowId: this.input.definition.workflowId,
      executionId: this.input.executionId,
      flowId: this.input.flowId ?? null,
      triggerPayload: this.input.triggerPayload,
      nodeOutputs: { ...this.outputs },
      variables: { ...this.variables },
      global: this.input.global,
      entity: this.input.entity ?? null,
      scope: this.input.scope ?? {},
      simulated: Boolean(this.input.simulated),
    };
  }

  // ───────────────────────────── node kinds ─────────────────────────────

  private calendar() {
    return this.input.calendar ?? DEFAULT_CALENDAR;
  }

  private target(from: number, spec: unknown, business: boolean): number | null {
    const ms = parseDuration(spec);
    if (ms === null) return null;
    return business ? addBusinessTime(from, ms, this.calendar()) : from + ms;
  }

  private async timer(node: CompiledNode): Promise<NodeResult> {
    const cfg = this.resolveConfig(node);
    const now = this.rt.now();
    let until: number | null = null;
    if (cfg.until !== undefined && cfg.until !== "") {
      until = Date.parse(String(cfg.until));
      if (Number.isNaN(until)) throw new NodeError("timer_invalid", `Timer "until" is not a date: ${String(cfg.until)}`);
    } else {
      until = this.target(now, cfg.duration ?? cfg.seconds, cfg.businessHours === true);
      if (until === null) throw new NodeError("timer_invalid", `Timer needs a duration (got ${JSON.stringify(cfg.duration ?? cfg.seconds)})`);
    }
    const spec: ParkedWait = { nodeId: node.id, kind: "timer", timerUntil: until, startedAt: now };
    return this.sleepUntil(node, spec, true);
  }

  private async sleepUntil(node: CompiledNode, spec: ParkedWait, announce: boolean): Promise<NodeResult> {
    this.parked.set(node.id, spec);
    this.active.delete(node.id);
    this.graph.status.set(node.id, "waiting");
    if (announce) this.emit("node_waiting", { kind: "timer", until: new Date(spec.timerUntil!).toISOString() }, node.id);
    this.refreshStatus();
    const aborted = await this.rt.waitFor(() => this.stopping(), Math.max(0, spec.timerUntil! - this.rt.now()));
    this.graph.status.set(node.id, "running");
    this.active.add(node.id);
    if (aborted) throw new AbortedError();
    return { output: { waitedMs: this.rt.now() - spec.startedAt, until: new Date(spec.timerUntil!).toISOString() } };
  }

  private buildWait(node: CompiledNode): ParkedWait {
    const cfg = this.resolveConfig(node);
    const now = this.rt.now();
    const business = cfg.businessHours === true;
    const eventName = typeof cfg.eventName === "string" && cfg.eventName ? cfg.eventName : undefined;
    const spec: ParkedWait = { nodeId: node.id, kind: eventName ? "external_event" : "human", startedAt: now };
    if (eventName) spec.eventName = eventName;
    if (typeof cfg.correlation === "string" && cfg.correlation) spec.correlation = cfg.correlation;
    const warn = this.target(now, cfg.warnAfter, business);
    const breach = this.target(now, cfg.breachAfter, business);
    const timeout = this.target(now, cfg.timeout, business);
    if (warn !== null) spec.warnAt = warn;
    if (breach !== null) spec.breachAt = breach;
    if (timeout !== null) {
      spec.timeoutAt = timeout;
      spec.timeoutPort = typeof cfg.timeoutPort === "string" && cfg.timeoutPort ? cfg.timeoutPort : "timeout";
    }
    return spec;
  }

  /** Parks a node until a person/system resolves it, a deadline passes, or the execution is aborted. */
  private async park(node: CompiledNode, restored?: ParkedWait): Promise<NodeResult> {
    if (restored?.kind === "timer") return this.sleepUntil(node, restored, false);
    const spec = restored ?? this.buildWait(node);
    this.parked.set(node.id, spec);
    this.active.delete(node.id);
    this.graph.status.set(node.id, "waiting");
    if (!this.waits.has(node.id)) this.waits.set(node.id, { status: "waiting" });
    if (!restored) {
      this.emit("node_waiting", { kind: spec.kind, eventName: spec.eventName ?? null, timeoutAt: spec.timeoutAt ? new Date(spec.timeoutAt).toISOString() : null }, node.id);
      await this.rt.hook("waitRegistered", { nodeId: node.id, kind: spec.kind, eventName: spec.eventName ?? null, correlation: spec.correlation ?? null, dueAt: spec.timeoutAt ?? spec.breachAt ?? null });
    }
    this.refreshStatus();

    if (spec.kind === "external_event") {
      const index = this.eventBuffer.findIndex((e) => e.name === spec.eventName && (!spec.correlation || spec.correlation === e.correlation));
      if (index >= 0) {
        const [hit] = this.eventBuffer.splice(index, 1);
        this.resolveNode(node.id, { output: hit!.payload });
      }
    }

    let timedOut = false;
    const done = () => this.waits.get(node.id)?.status === "resolved" || this.stopping();
    for (;;) {
      const upcoming = [
        spec.warnAt !== undefined ? ({ at: spec.warnAt, what: "warn" } as const) : null,
        spec.breachAt !== undefined ? ({ at: spec.breachAt, what: "breach" } as const) : null,
        spec.timeoutAt !== undefined ? ({ at: spec.timeoutAt, what: "timeout" } as const) : null,
      ]
        .filter((x): x is { at: number; what: "warn" | "breach" | "timeout" } => x !== null)
        .sort((a, b) => a.at - b.at)[0];
      const finished = await this.rt.waitFor(done, upcoming ? Math.max(0, upcoming.at - this.rt.now()) : undefined);
      if (finished) break;
      if (!upcoming) continue;
      if (upcoming.what === "warn") {
        delete spec.warnAt;
        this.emit("sla_warning", { nodeId: node.id }, node.id);
        await this.rt.hook("slaWarning", { nodeId: node.id });
      } else if (upcoming.what === "breach") {
        delete spec.breachAt;
        this.emit("sla_breached", { nodeId: node.id }, node.id);
        await this.rt.hook("slaBreached", { nodeId: node.id });
      } else {
        timedOut = true;
        break;
      }
    }
    this.graph.status.set(node.id, "running");
    this.active.add(node.id);

    const state = this.waits.get(node.id);
    if (state?.status !== "resolved") {
      if (this.stopping()) throw new AbortedError();
      if (timedOut) {
        const port = spec.timeoutPort ?? "timeout";
        this.waits.delete(node.id);
        this.emit("wait_timed_out", { port }, node.id);
        await this.rt.hook("waitTimedOut", { nodeId: node.id });
        if (!this.graph.hasHandle(node.id, port)) throw new NodeError("wait_timeout", `Node "${node.id}" timed out and has no "${port}" route`);
        return { output: { timedOut: true, waitedMs: this.rt.now() - spec.startedAt }, nextPort: port };
      }
    }
    const resolution = state?.resolution ?? {};
    this.waits.delete(node.id);
    await this.rt.hook("waitResolved", { nodeId: node.id });
    const nextPort = resolution.nextPort ?? node.defaultPort;
    return { output: resolution.output, ...(nextPort ? { nextPort } : {}), ...(resolution.outcome ? { outcome: resolution.outcome } : {}) };
  }

  private async subprocess(node: CompiledNode): Promise<NodeResult> {
    const cfg = this.resolveConfig(node);
    const flowId = typeof cfg.flowId === "string" ? cfg.flowId : "";
    if (!flowId) throw new NodeError("subprocess_invalid", "Subprocess node needs a flowId");
    const depth = (this.input.depth ?? 0) + 1;
    const max = this.input.definition.settings?.maxDepth ?? 6;
    if (depth > max) throw new NodeError("max_depth", `Subprocess nesting exceeds ${max} levels`, true);
    const mode = cfg.mode === "detach" ? "detach" : "wait";
    this.emit("subprocess_started", { flowId, mode }, node.id);
    const result = await this.rt.startChild({
      nodeId: node.id,
      flowId,
      version: (cfg.version as string | number | null | undefined) ?? null,
      input: (cfg.input as Record<string, unknown> | undefined) ?? {},
      mode,
      context: this.nodeContext(),
      depth,
    });
    this.emit("subprocess_completed", { executionId: result.executionId, status: result.status }, node.id);
    if (mode === "wait" && result.status !== "completed") {
      throw new NodeError("subprocess_failed", result.error ?? `Subprocess ended as ${result.status}`);
    }
    return { output: { executionId: result.executionId, status: result.status, outcome: result.outcome ?? null, output: result.output ?? null } };
  }

  private end(node: CompiledNode): NodeResult {
    const cfg = this.resolveConfig(node);
    const status = cfg.status === "failed" || cfg.status === "cancelled" ? cfg.status : "completed";
    const message = typeof cfg.message === "string" ? cfg.message : undefined;
    const outcome = typeof cfg.outcomeValue === "string" && cfg.outcomeValue.trim() ? { value: cfg.outcomeValue, resolvedBy: String(cfg.resolvedBy || node.id) } : undefined;
    return {
      output: { status, message: message ?? null },
      ...(outcome ? { outcome } : {}),
      ...(status !== "completed" || cfg.terminate === true ? { terminate: { status, ...(message ? { message } : {}), code: "flow_terminated" } } : {}),
    };
  }

  // ───────────────────────────── settle / propagate ─────────────────────────────

  private settle(done: TaskDone): CompiledNode[] {
    const { node } = done;
    if (done.type === "aborted") return [];

    if (done.type === "error") {
      const policy = node.errorPolicy ?? "fail";
      if (policy === "fail" || done.fatal) {
        this.graph.status.set(node.id, "failed");
        this.setAbort({ kind: "failure", message: done.message, ...(done.code ? { code: done.code } : {}) });
        return [];
      }
      this.outputs[node.id] = { error: { message: done.message, ...(done.code ? { code: done.code } : {}) } };
      this.graph.status.set(node.id, "completed");
      return this.advance(node.id, policy === "errorRoute" ? ERROR_HANDLE : undefined);
    }

    const { result } = done;
    this.outputs[node.id] = result.output;
    this.graph.status.set(node.id, "completed");
    if (result.setVariables) {
      Object.assign(this.variables, result.setVariables);
      this.emit("variables_changed", { names: Object.keys(result.setVariables) }, node.id);
    }
    if (node.compensate) this.compensations.push({ nodeId: node.id, spec: node.compensate, output: result.output });
    if (result.outcome) this.outcome ??= { ...result.outcome, nodeId: node.id };
    if (result.terminate) {
      const t = result.terminate;
      if (t.status === "failed") this.setAbort({ kind: "failure", message: t.message ?? "Flow ended in failure", ...(t.code ? { code: t.code } : {}) });
      else if (t.status === "cancelled") this.setAbort({ kind: "cancelled" });
      else this.setAbort({ kind: "terminated" });
      return [];
    }
    return this.advance(node.id, result.nextPort, Boolean(result.outcome));
  }

  private advance(nodeId: string, port: string | undefined, declaredOutcome = false): CompiledNode[] {
    const { ready, skipped, deadEnd } = this.graph.propagate(nodeId, port);
    for (const s of skipped) this.emit("node_skipped", { reason: s.reason }, s.id);
    if (deadEnd && !declaredOutcome) this.deadEnds.push(deadEnd);
    return ready;
  }

  private setAbort(next: Abort): void {
    if (this.abort && !(this.abort.kind === "terminated" && next.kind !== "terminated")) return;
    this.abort = next;
    this.refreshStatus();
  }

  // ───────────────────────────── finishing ─────────────────────────────

  private async finish(): Promise<ExecutionResult> {
    const abort = this.abort as Abort | null;
    if (abort?.kind === "failure") return this.finishFailed(abort);
    if (abort?.kind === "cancelled") return this.finishCancelled();
    const stalled = this.graph.stalled();
    if (abort?.kind !== "terminated" && stalled.length > 0) {
      return this.finishFailed({ message: `Workflow stalled: nodes never became ready: ${stalled.join(", ")}`, code: "stalled" });
    }
    if (abort?.kind !== "terminated" && this.deadEnds.length > 0 && !this.outcome) {
      this.emit("execution_incomplete", { deadEnds: this.deadEnds });
      await this.rt.setStatus("incomplete");
      await this.closeOut("incomplete");
      return { status: "incomplete", deadEnds: this.deadEnds };
    }
    this.emit("execution_completed", this.outcome ? { outcome: this.outcome } : undefined);
    await this.rt.setStatus("completed", undefined, this.outcome ? { value: this.outcome.value, resolvedBy: this.outcome.resolvedBy } : undefined);
    await this.closeOut("completed");
    return { status: "completed", ...(this.outcome ? { outcome: this.outcome } : {}) };
  }

  private async finishFailed(error: { message: string; code?: string }): Promise<ExecutionResult> {
    const compensated = await this.compensate("failure");
    this.emit("execution_failed", { error: { message: error.message, ...(error.code ? { code: error.code } : {}) }, compensated });
    await this.rt.setStatus("failed", error.message, compensated ? { compensated: true } : undefined);
    await this.closeOut("failed");
    return { status: "failed", error, ...(compensated ? { compensated } : {}) };
  }

  private async finishCancelled(): Promise<ExecutionResult> {
    await this.rt.nonCancellable(async () => {
      await this.compensate("cancel");
      this.emit("execution_cancelled", { reason: "user_request" });
      await this.rt.setStatus("cancelled");
      await this.closeOut("cancelled");
    });
    return { status: "cancelled" };
  }

  private async closeOut(status: string): Promise<void> {
    await this.rt.hook("executionFinished", { status });
    await this.rt.flush();
  }

  /** Saga: undo completed side effects in reverse order. Returns true when at least one step ran. */
  private async compensate(reason: "failure" | "cancel"): Promise<boolean> {
    const mode = this.input.definition.settings?.saga ?? "failure";
    const wanted = mode === "always" || mode === reason;
    if (!wanted || this.compensations.length === 0) return false;
    const run = async () => {
      for (const entry of [...this.compensations].reverse()) {
        this.emit("compensation_started", { type: entry.spec.type }, entry.nodeId);
        try {
          await this.rt.runCompensation(entry, this.nodeContext());
          this.emit("compensation_completed", { type: entry.spec.type }, entry.nodeId);
        } catch (error) {
          this.emit("compensation_failed", { type: entry.spec.type, error: { message: describeError(error).message } }, entry.nodeId);
        }
      }
    };
    await this.rt.nonCancellable(run);
    this.compensations = [];
    return true;
  }

  // ───────────────────────────── status, events, snapshot ─────────────────────────────

  private emit(type: string, payload?: unknown, nodeId?: string): void {
    this.rt.emit(type, payload === undefined ? undefined : redactSensitive(payload), nodeId);
  }

  private currentStatus(): ExecStatus {
    if (this.paused) return "paused";
    if (this.active.size === 0 && this.parked.size > 0) return "waiting";
    return "running";
  }

  private refreshStatus(): void {
    if (this.abort) return;
    const next = this.currentStatus();
    if (next === this.lastStatus) return;
    this.lastStatus = next;
    void this.rt.setStatus(next);
  }

  snapshot(): EngineSnapshot {
    return {
      seq: 0,
      startedAt: this.startedAt,
      status: Object.fromEntries(this.graph.status),
      pending: Object.fromEntries(this.graph.pending),
      liveIncoming: Object.fromEntries(this.graph.liveIncoming),
      pruneKind: Object.fromEntries(this.graph.pruneKind),
      outputs: this.outputs,
      variables: this.variables,
      parked: [...this.parked.values()],
      resolved: this.resolvedHistory,
      eventBuffer: this.eventBuffer,
      compensations: this.compensations,
      deadEnds: this.deadEnds,
      ...(this.outcome ? { outcome: this.outcome } : {}),
      paused: this.paused,
      stepTokens: this.stepTokens,
      generation: this.generation,
    };
  }

  private restore(s: EngineSnapshot): void {
    this.graph.status = new Map(Object.entries(s.status) as [string, never][]);
    this.graph.pending = new Map(Object.entries(s.pending));
    this.graph.liveIncoming = new Map(Object.entries(s.liveIncoming));
    this.graph.pruneKind = new Map(Object.entries(s.pruneKind));
    this.outputs = s.outputs;
    this.variables = s.variables;
    this.resolvedHistory = s.resolved;
    this.eventBuffer = s.eventBuffer;
    this.compensations = s.compensations;
    this.deadEnds = s.deadEnds;
    this.outcome = s.outcome;
    this.paused = s.paused;
    this.stepTokens = s.stepTokens;
    for (const p of s.parked) {
      const resolved = s.resolved[p.nodeId];
      this.waits.set(p.nodeId, resolved ? { status: "resolved", resolution: resolved } : { status: "waiting" });
    }
  }

  private rearmParked(): void {
    for (const spec of this.input.resume?.parked ?? []) {
      const node = this.graph.nodes.get(spec.nodeId);
      if (node) this.launch(node, spec);
    }
  }
}
