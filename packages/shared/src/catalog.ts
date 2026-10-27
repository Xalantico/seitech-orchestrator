/**
 * The node catalog: ONE definition per node type drives the editor palette and property forms, the compiler's
 * validation, the interpreter's execution kind, the worker's queue / retry profile and the BPMN mapping.
 * Later phases extend it with `registerNodeDefinitions` (state machines, operations, documents, connectors...).
 */
import { parseDuration } from "./duration.js";

export type NodeKindName = "inline" | "activity" | "wait" | "timer" | "subprocess" | "end";
export type QueueFamily = "flows" | "integrations" | "notifications" | "batch";

export type RetrySpec = {
  maximumAttempts?: number;
  initialInterval?: string;
  backoffCoefficient?: number;
  maximumInterval?: string;
  nonRetryableErrorTypes?: string[];
};

/** Runtime part: what the interpreter and the worker need. */
export type NodeSpec = {
  kind: NodeKindName;
  /** Output ports (source handles). The first one is the default. Empty = single default port. */
  ports?: string[];
  /** Node produces exactly one port per run (branching): `errorPolicy: continue` is rejected. */
  branching?: boolean;
  queue?: QueueFamily;
  startToCloseTimeout?: string;
  heartbeatTimeout?: string;
  retry?: RetrySpec;
  /** Fires on the first live predecessor instead of waiting for all of them. */
  join?: "all" | "any";
  /** Required configuration keys; the compiler reports the missing ones. */
  required?: string[];
};

export type FieldType = "string" | "text" | "number" | "boolean" | "select" | "duration" | "json" | "expression";

export type FieldDef = {
  key: string;
  type: FieldType;
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  default?: unknown;
  options?: { label: string; value: string }[];
  min?: number;
  max?: number;
  rows?: number;
  /** Only shown (and validated) when another field has this value. */
  showWhen?: { key: string; equals: unknown };
};

export type NodeGroup = "start" | "control" | "human" | "time" | "comms" | "integration" | "data" | "state" | "ops" | "docs" | "legacy";

/** Editor part: how the node is presented and configured. */
export type NodeDefinition = NodeSpec & {
  type: string;
  label: string;
  description: string;
  icon: string;
  group: NodeGroup;
  start?: boolean;
  fields: FieldDef[];
  /** Labels of the ports shown on the canvas. */
  portLabels?: Record<string, string>;
  /** Hidden from the palette (kept for stored diagrams). */
  hidden?: boolean;
  /** Error policies the editor offers; defaults to all (minus `continue` for branching nodes). */
  noErrorPolicy?: boolean;
  /** Permission needed to place this node in a flow. */
  requires?: string;
};

export const NODE_DEFS: Record<string, NodeDefinition> = {};
/** Runtime lookup used by the compiler and the engine hosts. */
export const NODE_SPECS: Record<string, NodeSpec> = {};

export function registerNodeDefinitions(defs: NodeDefinition[]): void {
  for (const def of defs) {
    NODE_DEFS[def.type] = def;
    NODE_SPECS[def.type] = def;
  }
}

export function nodeSpec(type: string): NodeSpec | undefined {
  return NODE_SPECS[type];
}
export function nodeDefinition(type: string): NodeDefinition | undefined {
  return NODE_DEFS[type];
}

/** Legacy `registerNodeSpecs` for runtime-only registrations. */
export function registerNodeSpecs(specs: Record<string, NodeSpec>): void {
  Object.assign(NODE_SPECS, specs);
}

const TEMPLATE = /\{\{.*\}\}/;
const hasTemplate = (v: unknown) => typeof v === "string" && TEMPLATE.test(v);

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Returns human-readable problems with a node's configuration (empty = valid). Template values are not evaluated. */
export function validateNodeConfig(def: NodeDefinition, config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const field of def.fields) {
    if (field.showWhen && config[field.showWhen.key] !== field.showWhen.equals) continue;
    const value = config[field.key];
    if (isBlank(value)) {
      if (field.required) problems.push(`"${field.label}" is required`);
      continue;
    }
    if (hasTemplate(value)) continue;
    switch (field.type) {
      case "number": {
        const n = Number(value);
        if (!Number.isFinite(n)) problems.push(`"${field.label}" must be a number`);
        else if (field.min !== undefined && n < field.min) problems.push(`"${field.label}" must be at least ${field.min}`);
        else if (field.max !== undefined && n > field.max) problems.push(`"${field.label}" must be at most ${field.max}`);
        break;
      }
      case "duration":
        if (parseDuration(value) === null) problems.push(`"${field.label}" is not a valid duration (use 30m, 2h, 3d or ISO-8601)`);
        break;
      case "select":
        if (field.options && !field.options.some((o) => o.value === String(value))) problems.push(`"${field.label}" has an unknown value "${String(value)}"`);
        break;
      case "json":
        if (typeof value === "string") {
          try {
            JSON.parse(value);
          } catch {
            problems.push(`"${field.label}" is not valid JSON`);
          }
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") problems.push(`"${field.label}" must be true or false`);
        break;
      default:
        break;
    }
  }
  return problems;
}

/** Initial `properties` for a node dropped from the palette. */
export function defaultProperties(def: NodeDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = { label: def.label, description: "" };
  for (const field of def.fields) if (field.default !== undefined) out[field.key] = field.default;
  return out;
}

/** Base task queue names; simulations append `-sim` so they run on isolated workers. */
export const TASK_QUEUES: Record<QueueFamily, string> = {
  flows: "orq-flows",
  integrations: "orq-integrations",
  notifications: "orq-notifications",
  batch: "orq-batch",
};
export const SIM_SUFFIX = "-sim";
export function taskQueueFor(family: QueueFamily | undefined, simulated: boolean | undefined): string {
  const base = TASK_QUEUES[family ?? "flows"];
  return simulated ? `${base}${SIM_SUFFIX}` : base;
}
