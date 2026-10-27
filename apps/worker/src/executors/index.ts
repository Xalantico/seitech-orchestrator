import { commsExecutors } from "./comms.js";
import { dataExecutors } from "./data.js";
import { loadExecutors } from "./load.js";
import { httpExecutor } from "./http.js";
import { humanExecutors } from "./human.js";
import { integrationExecutors } from "./integration.js";
import { pocExecutors } from "./poc.js";
import { stateExecutors } from "./state.js";
import type { ExecutorRegistry } from "./types.js";

/** Every executable node type. Later phases register their own modules with `registerExecutors`. */
export const executors: ExecutorRegistry = {
  ...pocExecutors,
  ...humanExecutors,
  ...commsExecutors,
  ...dataExecutors,
  ...stateExecutors,
  ...loadExecutors,
  ...integrationExecutors,
  "int.http": httpExecutor,
};

export function registerExecutors(extra: ExecutorRegistry): void {
  Object.assign(executors, extra);
}
export type { Executor, ExecutorDeps, ExecutorRegistry } from "./types.js";
export { PermanentNodeError, TransientNodeError } from "./types.js";
