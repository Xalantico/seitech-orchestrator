import pg from "pg";

import { env } from "../env.js";
import { log } from "./services.js";

type Listener = () => void;

/**
 * Fan-out of `pg_notify('orq_exec', executionId)` to in-process subscribers (SSE streams).
 * One dedicated LISTEN connection per API instance, reconnecting on failure.
 */
const listeners = new Map<string, Set<Listener>>();
let client: pg.Client | undefined;
let connecting = false;

async function connect(): Promise<void> {
  if (client || connecting) return;
  connecting = true;
  try {
    const next = new pg.Client({ connectionString: process.env.LISTEN_DATABASE_URL ?? env.DATABASE_URL, application_name: "orq-api-listen" });
    next.on("error", (error) => {
      log.warn({ err: error.message }, "event bus connection lost");
      client = undefined;
      setTimeout(() => void connect(), 2000);
    });
    next.on("notification", (msg) => {
      for (const l of listeners.get(msg.payload ?? "") ?? []) l();
    });
    await next.connect();
    await next.query("LISTEN orq_exec");
    client = next;
  } catch (error) {
    log.warn({ err: error instanceof Error ? error.message : String(error) }, "event bus unavailable, streams fall back to polling");
    setTimeout(() => void connect(), 5000);
  } finally {
    connecting = false;
  }
}

export function subscribe(executionId: string, listener: Listener): () => void {
  void connect();
  let set = listeners.get(executionId);
  if (!set) listeners.set(executionId, (set = new Set()));
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(executionId);
  };
}

export async function closeEventBus(): Promise<void> {
  const c = client;
  client = undefined;
  await c?.end().catch(() => undefined);
}
