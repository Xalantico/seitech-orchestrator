// Workflow bundle entry. Everything imported here runs in Temporal's deterministic V8 sandbox:
// no Node APIs, no database, no workspace package that touches them. The interpreter is pure.
import {
  Interpreter,
  EngineRejection,
  FAILURE_TYPE,
  QUERY,
  SIGNAL,
  UPDATE,
  coreInline,
  type ChildResult,
  type ChildSpec,
  type CompensationEntry,
  type CompiledNode,
  type EngineSnapshot,
  type EventSignal,
  type ExecStatus,
  type ExecutionInput,
  type ExecutionResult,
  type HookName,
  type NodeContext,
  type NodeResult,
  type ResolveNodeArgs,
  type Runtime,
  type StepSignal,
} from "@orchestrador/engine";
import { taskQueueFor } from "@orchestrador/shared";
import {
  ApplicationFailure,
  CancellationScope,
  ChildWorkflowFailure,
  ParentClosePolicy,
  allHandlersFinished,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  defineUpdate,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";

import type { Activities, EventRow } from "./activities.js";

const EVENT_BATCH = 200;

const housekeeping = proxyActivities<Activities>({
  startToCloseTimeout: "30s",
  retry: { maximumAttempts: 10, initialInterval: "1s", maximumInterval: "30s", backoffCoefficient: 2 },
});

const proxies = new Map<string, ReturnType<typeof proxyActivities<Activities>>>();
function nodeActivities(node: CompiledNode, simulated: boolean) {
  const exec = node.exec ?? {};
  const key = JSON.stringify([exec, simulated]);
  let proxy = proxies.get(key);
  if (!proxy) {
    proxy = proxyActivities<Activities>({
      taskQueue: taskQueueFor(exec.queue, simulated),
      startToCloseTimeout: exec.startToCloseTimeout ?? "30s",
      ...(exec.heartbeatTimeout ? { heartbeatTimeout: exec.heartbeatTimeout } : {}),
      retry: {
        maximumAttempts: exec.retry?.maximumAttempts ?? 3,
        initialInterval: exec.retry?.initialInterval ?? "1s",
        backoffCoefficient: exec.retry?.backoffCoefficient ?? 2,
        maximumInterval: exec.retry?.maximumInterval ?? "1m",
        ...(exec.retry?.nonRetryableErrorTypes ? { nonRetryableErrorTypes: exec.retry.nonRetryableErrorTypes } : {}),
      },
    });
    proxies.set(key, proxy);
  }
  return proxy;
}

class TemporalRuntime implements Runtime {
  private seq: number;
  private buffer: EventRow[] = [];
  private flushing: Promise<void> | null = null;
  private statusTail: Promise<void> = Promise.resolve();
  cancellation: unknown;

  constructor(private readonly input: ExecutionInput) {
    this.seq = input.resume?.seq ?? 0;
  }

  now = () => Date.now();
  uuid = () => uuid4();

  sleep(ms: number) {
    return sleep(ms);
  }

  async waitFor(predicate: () => boolean, timeoutMs?: number): Promise<boolean> {
    if (timeoutMs === undefined) {
      await condition(predicate);
      return true;
    }
    if (timeoutMs <= 0) return predicate();
    return condition(predicate, timeoutMs);
  }

  emit(type: string, payload?: unknown, nodeId?: string): void {
    this.seq += 1;
    this.buffer.push({ sequence: this.seq, type, ...(payload === undefined ? {} : { payload }), ...(nodeId ? { nodeId } : {}) });
    this.kick();
  }

  private kick(): void {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = (async () => {
      try {
        while (this.buffer.length > 0) {
          const batch = this.buffer.splice(0, EVENT_BATCH);
          try {
            await housekeeping.emitEvents(this.input.executionId, batch);
          } catch (error) {
            // Cancelled mid-flight: keep the rows, the non-cancellable final flush delivers them.
            this.buffer.unshift(...batch);
            throw error;
          }
        }
      } catch {
        /* retried by flush() */
      } finally {
        this.flushing = null;
      }
    })();
  }

  async flush(): Promise<void> {
    for (let guard = 0; guard < 1000 && (this.flushing || this.buffer.length > 0); guard += 1) {
      this.kick();
      if (this.flushing) await this.flushing;
      else break;
    }
    if (this.buffer.length > 0) {
      await CancellationScope.nonCancellable(async () => {
        while (this.buffer.length > 0) {
          const batch = this.buffer.splice(0, EVENT_BATCH);
          await housekeeping.emitEvents(this.input.executionId, batch);
        }
      });
    }
  }

  setStatus(status: ExecStatus, error?: string, outcome?: unknown): Promise<void> {
    const terminal = status === "completed" || status === "failed" || status === "cancelled" || status === "incomplete";
    const step = async () => {
      if (terminal) await this.flush();
      await housekeeping.updateExecutionStatus(this.input.executionId, status, error, outcome);
    };
    const run = this.statusTail.then(step);
    this.statusTail = run.catch(() => undefined);
    // Progress statuses are advisory: never let a failed write stop the flow.
    return terminal ? run : run.catch(() => undefined);
  }

  runNode(node: CompiledNode, ctx: NodeContext): Promise<NodeResult> {
    return nodeActivities(node, Boolean(this.input.simulated)).executeNode(node, ctx);
  }

  runCompensation(entry: CompensationEntry, ctx: NodeContext): Promise<void> {
    const node: CompiledNode = { id: entry.nodeId, type: entry.spec.type, kind: "activity", config: {}, exec: { queue: entry.spec.queue ?? "flows", retry: { maximumAttempts: 5 } } };
    return nodeActivities(node, Boolean(this.input.simulated)).executeCompensation(entry, ctx);
  }

  async hook(name: HookName, payload: Record<string, unknown>): Promise<void> {
    try {
      await housekeeping.engineHook(name, { ...payload, executionId: this.input.executionId });
    } catch (error) {
      if (isCancellation(error)) throw error;
      // Bookkeeping must never fail a flow.
    }
  }

  async startChild(spec: ChildSpec): Promise<ChildResult> {
    const prepared = await housekeeping.prepareChild({ ...spec, parentExecutionId: this.input.executionId });
    const detach = spec.mode === "detach";
    const handle = await startChild("interpreterWorkflow", {
      workflowId: `exec-${prepared.executionId}`,
      args: [prepared.input],
      parentClosePolicy: detach ? ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON : ParentClosePolicy.PARENT_CLOSE_POLICY_REQUEST_CANCEL,
    });
    if (detach) return { executionId: prepared.executionId, status: "running" };
    try {
      const result = (await handle.result()) as ExecutionResult;
      return {
        executionId: prepared.executionId,
        status: result.status,
        ...(result.status === "completed" && result.outcome ? { outcome: result.outcome } : {}),
      };
    } catch (error) {
      if (isCancellation(error)) throw error;
      const message = error instanceof ChildWorkflowFailure ? (error.cause?.message ?? error.message) : error instanceof Error ? error.message : String(error);
      return { executionId: prepared.executionId, status: "failed", error: message };
    }
  }

  nonCancellable<T>(fn: () => Promise<T>): Promise<T> {
    return CancellationScope.nonCancellable(fn);
  }

  isCancellation(error: unknown): boolean {
    const cancelled = isCancellation(error);
    if (cancelled) this.cancellation ??= error;
    return cancelled;
  }

  shouldContinueAsNew(): boolean {
    return workflowInfo().continueAsNewSuggested;
  }

  async continueAsNew(snapshot: EngineSnapshot): Promise<never> {
    await this.flush();
    // Let in-flight updates and signals finish so none is lost at the history boundary.
    await condition(allHandlersFinished);
    return continueAsNew<typeof interpreterWorkflow>({ ...this.input, resume: { ...snapshot, seq: this.seq } });
  }
}

const eventSignal = defineSignal<[EventSignal]>(SIGNAL.event);
const pauseSignal = defineSignal(SIGNAL.pause);
const resumeSignal = defineSignal(SIGNAL.resume);
const stepSignal = defineSignal<[StepSignal | undefined]>(SIGNAL.step);
const stopSignal = defineSignal<[string | undefined]>(SIGNAL.stop);
const resolveNodeUpdate = defineUpdate<void, [ResolveNodeArgs]>(UPDATE.resolveNode);
const stateQuery = defineQuery<ReturnType<Interpreter["view"]>>(QUERY.state);

/** The one workflow every flow execution runs as. The diagram is data; this is its interpreter. */
export async function interpreterWorkflow(input: ExecutionInput): Promise<ExecutionResult> {
  const rt = new TemporalRuntime(input);
  const interpreter = new Interpreter(rt, input, coreInline);

  // Handlers are registered before the first await so nothing delivered with the first activation is dropped.
  setHandler(eventSignal, (e) => void interpreter.signalEvent(e.name, e.payload, e.correlation));
  setHandler(pauseSignal, () => interpreter.pause());
  setHandler(resumeSignal, () => interpreter.resume());
  setHandler(stepSignal, (s) => interpreter.step(s?.count ?? 1));
  setHandler(stopSignal, (reason) => interpreter.requestStop(reason));
  setHandler(
    resolveNodeUpdate,
    (args) => interpreter.resolveNode(args.nodeId, args.resolution),
    {
      validator: (args) => {
        try {
          interpreter.validateResolve(args?.nodeId, args?.resolution);
        } catch (error) {
          if (error instanceof EngineRejection) throw ApplicationFailure.nonRetryable(error.message, FAILURE_TYPE.rejected, error.code);
          throw error;
        }
      },
    },
  );
  setHandler(stateQuery, () => interpreter.view());

  const result = await interpreter.run();
  if (result.status === "failed") {
    throw ApplicationFailure.nonRetryable(result.error.message, FAILURE_TYPE.executionFailed, result.error.code ?? null);
  }
  if (result.status === "cancelled" && rt.cancellation) throw rt.cancellation;
  return result;
}
