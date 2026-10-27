/** Late-bound link between tasks and the execution engine, set by the executions module. */
export type TaskResolution = { nextPort?: string; output?: unknown; comment?: string };
type Resolver = (task: { executionId: string; nodeId: string }, resolution: TaskResolution) => Promise<{ ok: boolean; error?: string }>;

let resolver: Resolver | undefined;
export const setTaskResolver = (fn: Resolver) => { resolver = fn; };
export const resolveTaskWait: Resolver = async (task, resolution) =>
  resolver ? resolver(task, resolution) : { ok: false, error: "execution engine unavailable" };
