import { AsyncLocalStorage } from "node:async_hooks";

/** Per-request / per-activity correlation data, attached to every log line (RNF-034). */
export type CorrelationContext = {
  requestId?: string;
  /** End-to-end trace key of an inspection: the work order or execution id (RNF-016, RNF-036). */
  correlationId?: string;
  executionId?: string;
  userId?: string;
};

const storage = new AsyncLocalStorage<CorrelationContext>();

export function runWithContext<T>(ctx: CorrelationContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

export function currentContext(): CorrelationContext {
  return storage.getStore() ?? {};
}

export function annotateContext(patch: CorrelationContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}
