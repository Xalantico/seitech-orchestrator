import type { Logger } from "@orchestrador/observability";
import type { CompiledNode, NodeContext, NodeResult } from "@orchestrador/engine";
import type pg from "pg";

export class PermanentNodeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PermanentNodeError";
  }
}
export class TransientNodeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TransientNodeError";
  }
}

export type ExecutorDeps = {
  log: Logger;
  /** Runs `fn` in a system transaction. */
  sys<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T>;
  heartbeat(details?: unknown): void;
};

export type Executor = {
  run(node: CompiledNode, ctx: NodeContext, deps: ExecutorDeps): Promise<NodeResult>;
  /** Anything that touches the outside world. Simulated runs replace it with `simulate` (or a generic stub). */
  sideEffects?: boolean;
  simulate?(node: CompiledNode, ctx: NodeContext): NodeResult;
};

export type ExecutorRegistry = Record<string, Executor>;

export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
