import { createFlowHost, type StartOptions, type Started } from "@orchestrador/flowhost";
import { metrics } from "@orchestrador/observability";

import { env } from "../env.js";
import { pool, runSystem } from "./db.js";
import { log } from "./services.js";
import { getSimTemporal, getTemporal } from "./temporal.js";

export type { StartOptions, Started };
export { loadCalendar } from "@orchestrador/flowhost";

/** The API's binding of the shared flow host: same engine calls the worker's schedulers use. */
export const host = createFlowHost({
  pool,
  system: runSystem,
  log,
  temporal: getTemporal,
  simTemporal: getSimTemporal,
  namespace: env.TEMPORAL_NAMESPACE,
  simNamespace: env.TEMPORAL_SIM_NAMESPACE,
  uiOrigin: env.TEMPORAL_UI_ORIGIN,
  isProd: env.isProd,
  onStarted: (trigger) => metrics.executionsStarted.inc({ trigger }),
});

export const startExecution = host.startExecution;
export const resolveNode = host.resolveNode;
export const signalExecution = host.signalExecution;
export const cancelExecution = host.cancelExecution;
export const queryExecution = host.queryExecution;
