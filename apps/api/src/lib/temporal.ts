import { Client, Connection } from "@temporalio/client";

import { env } from "../env.js";

let connection: Promise<Connection> | undefined;
let client: Client | undefined;
let simClient: Client | undefined;

export function getTemporal(): Promise<Client> {
  return (async () => {
    connection ??= Connection.connect({ address: env.TEMPORAL_ADDRESS });
    client ??= new Client({ connection: await connection, namespace: env.TEMPORAL_NAMESPACE });
    return client;
  })();
}

/** Simulations may run in their own namespace so they can never touch production workflows. */
export async function getSimTemporal(): Promise<Client> {
  if (!env.TEMPORAL_SIM_NAMESPACE) return getTemporal();
  connection ??= Connection.connect({ address: env.TEMPORAL_ADDRESS });
  simClient ??= new Client({ connection: await connection, namespace: env.TEMPORAL_SIM_NAMESPACE });
  return simClient;
}

export function temporalUiUrl(workflowId: string, namespace = env.TEMPORAL_NAMESPACE): string {
  return `${env.TEMPORAL_UI_ORIGIN.replace(/\/$/, "")}/namespaces/${namespace}/workflows/${encodeURIComponent(workflowId)}`;
}

export function asTemporalWorkflowId(executionId: string): string {
  return `exec-${executionId}`;
}
