import { metrics, startTracing, stopTracing } from "@orchestrador/observability";
import { SIM_SUFFIX, TASK_QUEUES, type QueueFamily } from "@orchestrador/shared";
import { NativeConnection, Runtime, Worker, bundleWorkflowCode } from "@temporalio/worker";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createActivities } from "./activities.js";
import { env } from "./env.js";
import { startLoops } from "./loops.js";
import { log, pool } from "./services.js";

async function connectTemporal(address: string) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await NativeConnection.connect({ address });
    } catch (error) {
      log.warn({ attempt, err: error instanceof Error ? error.message : String(error) }, "Temporal not ready");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

await startTracing("orq-worker");
metrics.startDefaultMetrics("worker");
Runtime.install({
  telemetryOptions: { metrics: { prometheus: { bindAddress: `0.0.0.0:${env.METRICS_PORT + 1}` } } },
});

const metricsServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  void metrics.registry.metrics().then((body) => res.writeHead(200, { "content-type": metrics.registry.contentType }).end(body));
}).listen(env.METRICS_PORT, "0.0.0.0");

const connection = await connectTemporal(env.TEMPORAL_ADDRESS);
const workflowBundle = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL("workflows.ts", import.meta.url)),
  // Sources use NodeNext-style ".js" specifiers for ".ts" files.
  webpackConfigHook: (config) => {
    config.resolve = { ...config.resolve, extensionAlias: { ".js": [".ts", ".js"] } };
    return config;
  },
});

const activities = createActivities();
const maxActivities = env.WORKER_MAX_CONCURRENT_ACTIVITIES;
const maxWorkflowTasks = env.WORKER_MAX_CONCURRENT_WORKFLOW_TASKS;

const workers: Worker[] = [];
const families = env.queues.filter((q): q is QueueFamily => q in TASK_QUEUES);

for (const family of families) {
  workers.push(
    await Worker.create({
      connection,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: TASK_QUEUES[family],
      // Only the flows queue hosts the interpreter workflow; the other queues are activity pools,
      // so a burst of notifications can never starve flow progress.
      ...(family === "flows" ? { workflowBundle, maxConcurrentWorkflowTaskExecutions: maxWorkflowTasks } : {}),
      activities,
      maxConcurrentActivityTaskExecutions: maxActivities,
      shutdownGraceTime: "30s",
    }),
  );
}

if (env.serveSimulation) {
  // Simulations run on their own queues (and namespace when configured) so they can never compete with production work.
  for (const family of families) {
    workers.push(
      await Worker.create({
        connection,
        namespace: env.TEMPORAL_SIM_NAMESPACE ?? env.TEMPORAL_NAMESPACE,
        taskQueue: `${TASK_QUEUES[family]}${SIM_SUFFIX}`,
        ...(family === "flows" ? { workflowBundle } : {}),
        activities,
        maxConcurrentActivityTaskExecutions: Math.max(5, Math.floor(maxActivities / 4)),
        shutdownGraceTime: "30s",
      }),
    );
  }
}

log.info({ queues: workers.map((w) => w.options.taskQueue), namespace: env.TEMPORAL_NAMESPACE }, "worker started");

const stopLoops = startLoops();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "worker shutting down");
  await stopLoops();
  for (const w of workers) w.shutdown();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await Promise.all(workers.map((w) => w.run()));
metricsServer.close();
await Promise.allSettled([pool.end(), stopTracing()]);
