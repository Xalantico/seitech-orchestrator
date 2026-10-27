/**
 * Contracts shared by the compiler, the interpreter (workflow sandbox) and the activities (worker).
 * Everything here must stay JSON-serialisable: it crosses the Temporal data converter.
 */

export type ErrorPolicy = "fail" | "continue" | "errorRoute";

/** How the interpreter executes a node. Decided by the node catalog at compile time. */
export type NodeKind =
  | "inline" // evaluated inside the workflow (pure): conditions, variables, gateways
  | "activity" // executed by a worker activity (integrations, notifications, database writes)
  | "wait" // parks until a person or an external event resolves it (user task, approval, wait-event)
  | "timer" // durable timer, optionally in business hours
  | "subprocess" // child workflow running another published flow
  | "end"; // terminal node

export type RetryPolicy = {
  maximumAttempts?: number;
  initialInterval?: string;
  backoffCoefficient?: number;
  maximumInterval?: string;
  nonRetryableErrorTypes?: string[];
};

export type ExecProfile = {
  /** Task queue family; the worker runs one queue per family so a burst never starves the others. */
  queue?: "flows" | "integrations" | "notifications" | "batch";
  startToCloseTimeout?: string;
  heartbeatTimeout?: string;
  retry?: RetryPolicy;
};

export type CompensationSpec = { type: string; config?: Record<string, unknown>; queue?: ExecProfile["queue"] };

export type CompiledNode = {
  id: string;
  type: string;
  label?: string;
  kind: NodeKind;
  errorPolicy?: ErrorPolicy;
  role?: "start";
  /** "all" waits for every live predecessor (AND-join); "any" fires on the first one (OR-join). */
  join?: "all" | "any";
  /** Port followed when a waiting node is resolved without an explicit one. */
  defaultPort?: string;
  exec?: ExecProfile;
  compensate?: CompensationSpec;
  config: Record<string, unknown>;
};

export type CompiledEdge = { id: string; sourceNodeId: string; targetNodeId: string; sourceHandle?: string };

export type SagaMode = "off" | "failure" | "cancel" | "always";

export type CompiledDefinition = {
  workflowId: string;
  nodes: CompiledNode[];
  edges: CompiledEdge[];
  settings?: {
    saga?: SagaMode;
    /** Maximum nesting of subprocess calls. */
    maxDepth?: number;
  };
};

/** Working calendar for business-hour timers and SLAs (RNF/ORF "plazos hábiles"). */
export type BusinessCalendar = {
  timeZone: string;
  /** ISO weekdays that are worked, 1 = Monday ... 7 = Sunday. */
  workdays: number[];
  /** Working windows as "HH:MM" pairs, e.g. [["09:00","14:00"],["15:00","18:00"]]. */
  hours: [string, string][];
  /** Non-working dates (YYYY-MM-DD). */
  holidays: string[];
};

export type EntityRef = { type: string; id: string };
export type ScopeRef = { delegationId?: string | null; zoneId?: string | null; projectId?: string | null };

export type ExecutionInput = {
  executionId: string;
  flowId?: string | null;
  flowVersionId?: string | null;
  flowName?: string;
  definition: CompiledDefinition;
  triggerPayload: Record<string, unknown>;
  variables: Record<string, unknown>;
  global: Record<string, unknown>;
  entity?: EntityRef | null;
  scope?: ScopeRef;
  /** Simulation: activities must not produce real side effects. */
  simulated?: boolean;
  /** Simulation step-through: wait for a `step` signal before each node. */
  stepMode?: boolean;
  parent?: { executionId: string; nodeId: string } | null;
  depth?: number;
  calendar?: BusinessCalendar | null;
  /** Present when this run continues a previous one (continue-as-new). */
  resume?: EngineSnapshot | null;
};

/** What every node execution sees. */
export type NodeContext = {
  workflowId: string;
  executionId: string;
  flowId?: string | null;
  triggerPayload: Record<string, unknown>;
  nodeOutputs: Record<string, unknown>;
  variables: Record<string, unknown>;
  global: Record<string, unknown>;
  entity?: EntityRef | null;
  scope?: ScopeRef;
  simulated?: boolean;
  /** Attempt of the current activity (activities only). */
  attempt?: number;
};

export type Outcome = { value: string; resolvedBy: string };

export type NodeResult = {
  output?: unknown;
  /** Selects the outgoing edge by handle name. Undefined follows every default edge. */
  nextPort?: string;
  /** The activity started something a person/system must finish. */
  waiting?: boolean;
  outcome?: Outcome;
  /** Merged into the flow variables. */
  setVariables?: Record<string, unknown>;
  /** Execution-level instruction raised by the node. */
  terminate?: { status: "completed" | "failed" | "cancelled"; message?: string; code?: string };
};

export type Resolution = { output?: unknown; nextPort?: string; outcome?: Outcome };

export type NodeStatus = "pending" | "ready" | "running" | "waiting" | "completed" | "skipped" | "failed";
export type ExecStatus = "running" | "waiting" | "paused" | "completed" | "failed" | "cancelled" | "incomplete";
export const TERMINAL_STATUSES: readonly ExecStatus[] = ["completed", "failed", "cancelled", "incomplete"];

export type ExecutionResult =
  | { status: "completed"; outcome?: unknown }
  | { status: "incomplete"; deadEnds: { nodeId: string; port: string }[] }
  | { status: "failed"; error: { message: string; code?: string }; compensated?: boolean }
  | { status: "cancelled" };

export type ParkedWait = {
  nodeId: string;
  kind: "human" | "external_event" | "timer" | "pause" | "sla";
  eventName?: string;
  correlation?: string;
  /** Epoch ms deadlines, absolute so they survive continue-as-new. */
  warnAt?: number;
  breachAt?: number;
  timeoutAt?: number;
  timeoutPort?: string;
  timerUntil?: number;
  startedAt: number;
};

export type CompensationEntry = { nodeId: string; spec: CompensationSpec; output: unknown };

export type EngineSnapshot = {
  seq: number;
  startedAt: number;
  status: Record<string, NodeStatus>;
  pending: Record<string, number>;
  liveIncoming: Record<string, number>;
  pruneKind: Record<string, "error" | "branch">;
  outputs: Record<string, unknown>;
  variables: Record<string, unknown>;
  parked: ParkedWait[];
  resolved: Record<string, Resolution>;
  eventBuffer: { name: string; payload: unknown; correlation?: string }[];
  compensations: CompensationEntry[];
  deadEnds: { nodeId: string; port: string }[];
  outcome?: { value: string; resolvedBy: string; nodeId: string };
  paused: boolean;
  stepTokens: number;
  generation: number;
};

export type HookName =
  | "waitRegistered"
  | "waitResolved"
  | "waitTimedOut"
  | "slaWarning"
  | "slaBreached"
  | "executionFinished";

export type ChildSpec = {
  nodeId: string;
  flowId: string;
  version?: string | number | null;
  input: Record<string, unknown>;
  mode: "wait" | "detach";
  context: NodeContext;
  depth: number;
};

export type ChildResult = { executionId: string; status: string; outcome?: unknown; output?: unknown; error?: string };

/** Everything the interpreter needs from its host (Temporal workflow runtime or a test double). */
export interface Runtime {
  now(): number;
  uuid(): string;
  sleep(ms: number): Promise<void>;
  /** Resolves true when `predicate()` holds, false when `timeoutMs` elapsed first. Re-evaluated on every state change. */
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<boolean>;
  /** Fire-and-forget (ordered): the host batches writes. */
  emit(type: string, payload?: unknown, nodeId?: string): void;
  flush(): Promise<void>;
  setStatus(status: ExecStatus, error?: string, outcome?: unknown): Promise<void>;
  runNode(node: CompiledNode, ctx: NodeContext): Promise<NodeResult>;
  runCompensation(entry: CompensationEntry, ctx: NodeContext): Promise<void>;
  hook(name: HookName, payload: Record<string, unknown>): Promise<void>;
  startChild(spec: ChildSpec): Promise<ChildResult>;
  nonCancellable<T>(fn: () => Promise<T>): Promise<T>;
  isCancellation(error: unknown): boolean;
  /** True when the host recommends starting a fresh history. */
  shouldContinueAsNew(): boolean;
  continueAsNew(snapshot: EngineSnapshot): Promise<never>;
}

export class EngineRejection extends Error {
  constructor(
    public readonly code:
      | "verdict_malformed"
      | "verdict_for_unknown_node"
      | "verdict_already_delivered"
      | "node_not_waiting",
    message: string,
  ) {
    super(message);
    this.name = "EngineRejection";
  }
}

/** Raised by inline/activity code for failures that must not be retried. */
export type InlineExecutor = (node: CompiledNode, ctx: NodeContext) => NodeResult;
export type InlineRegistry = Record<string, InlineExecutor>;
