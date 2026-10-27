import type { Resolution } from "./types.js";

/** Names and payloads shared by the Temporal workflow (worker) and its clients (API). */
export const INTERPRETER_WORKFLOW = "interpreterWorkflow";

export const SIGNAL = {
  event: "orq.event",
  pause: "orq.pause",
  resume: "orq.resume",
  step: "orq.step",
  stop: "orq.stop",
} as const;

export const UPDATE = { resolveNode: "orq.resolveNode" } as const;
export const QUERY = { state: "orq.state" } as const;

export type EventSignal = { name: string; payload?: unknown; correlation?: string };
export type StepSignal = { count?: number };
export type ResolveNodeArgs = { nodeId: string; resolution: Resolution };

/** Failure types the workflow raises so clients can map them to HTTP errors. */
export const FAILURE_TYPE = {
  rejected: "orq.rejected",
  executionFailed: "orq.execution_failed",
} as const;

export const WORKFLOW_ID_PREFIX = "exec-";
export const workflowIdFor = (executionId: string) => `${WORKFLOW_ID_PREFIX}${executionId}`;
