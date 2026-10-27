import { createFlowHost } from "@orchestrador/flowhost";
import { metrics } from "@orchestrador/observability";
import { Client, Connection } from "@temporalio/client";
import { withSystem } from "@orchestrador/db";

import { env } from "./env.js";
import { log, pool } from "./services.js";

let connection: Promise<Connection> | undefined;
const clients = new Map<string, Promise<Client>>();
function clientFor(namespace: string): Promise<Client> {
  connection ??= Connection.connect({ address: env.TEMPORAL_ADDRESS });
  let c = clients.get(namespace);
  if (!c) {
    c = connection.then((conn) => new Client({ connection: conn, namespace }));
    clients.set(namespace, c);
  }
  return c;
}

/** Worker-side binding of the flow host: schedulers and the event dispatcher start flows through it. */
export const host = createFlowHost({
  pool,
  system: (fn) =>
    withSystem(pool, async (db) => {
      await db.query("SELECT set_config('app.actor', 'worker-scheduler', true)");
      return fn(db);
    }),
  log,
  temporal: () => clientFor(env.TEMPORAL_NAMESPACE),
  simTemporal: () => clientFor(env.TEMPORAL_SIM_NAMESPACE ?? env.TEMPORAL_NAMESPACE),
  namespace: env.TEMPORAL_NAMESPACE,
  simNamespace: env.TEMPORAL_SIM_NAMESPACE,
  uiOrigin: env.TEMPORAL_UI_ORIGIN,
  isProd: env.APP_ENV === "prod",
  onStarted: (trigger) => metrics.executionsStarted.inc({ trigger }),
});
