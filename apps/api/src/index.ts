import { serve } from "@hono/node-server";
import { metrics, startTracing, stopTracing } from "@orchestrador/observability";
import { migrate, seedBase, withSystem } from "@orchestrador/db";
import { seedConnectors } from "@orchestrador/connectors";
import { seedGuide } from "@orchestrador/copilot";
import { seedProcessTemplates } from "@orchestrador/flowhost";

import { buildApp } from "./app.js";
import { env } from "./env.js";
import { pool } from "./lib/db.js";
import { closeEventBus } from "./lib/event-bus.js";
import { log, redis } from "./lib/services.js";
import { flushUsage, startUsageFlusher } from "./lib/usage.js";

await startTracing("orq-api");
metrics.startDefaultMetrics("api");

if (env.runMigrationsOnStart) {
  const url = process.env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
  const result = await migrate(url, {
    ...(env.APP_DB_ROLE ? { appRole: { name: env.APP_DB_ROLE, password: process.env.APP_DB_PASSWORD } } : {}),
    ...(process.env.BI_DB_ROLE ? { biRole: { name: process.env.BI_DB_ROLE, password: process.env.BI_DB_PASSWORD } } : {}),
  });
  log.info({ applied: result.applied }, "migrations checked");
  await seedBase(pool, { bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL });
  const processes = await withSystem(pool, (db) => seedProcessTemplates(db));
  if (processes.created.length > 0) log.info({ created: processes.created }, "process templates installed");
  await withSystem(pool, (db) => seedGuide(db));
  if (env.MOCK_CONNECTORS_URL) {
    const installed = await withSystem(pool, (db) => seedConnectors(db as never, { baseUrl: env.MOCK_CONNECTORS_URL! }));
    if (installed.connectors.length > 0) log.info(installed, "connectors installed");
  }
}

const app = buildApp();
const stopFlusher = startUsageFlusher();

const server = serve({ fetch: app.fetch, hostname: env.API_HOST, port: env.API_PORT }, (info) => {
  log.info({ port: info.port, env: env.APP_ENV, auth: env.AUTH_MODE }, "API listening");
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  server.close();
  stopFlusher();
  await flushUsage();
  await Promise.allSettled([closeEventBus(), pool.end(), redis?.quit(), stopTracing()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
