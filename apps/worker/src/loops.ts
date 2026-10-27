import { processInbox, runDueSyncs, runOutbox } from "@orchestrador/connector-sdk";
import { dispatchDomainEvents, runSchedules } from "@orchestrador/flowhost";

import { env } from "./env.js";
import { host } from "./host.js";
import { copilotIndex, retention, scheduledExports, thresholdAlerts } from "./jobs.js";
import { hubDeps } from "./hub.js";
import { sendQueuedMessages } from "./messaging.js";
import { log } from "./services.js";

/**
 * Background loops owned by the worker: the domain-event dispatcher (outbox consumer) and the cron scheduler.
 * Both claim rows with SKIP LOCKED, so running several replicas is safe.
 */
export function startLoops(): () => Promise<void> {
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];
  const inflight = new Set<Promise<unknown>>();

  function every(name: string, ms: number, fn: () => Promise<number>) {
    let busy = false;
    const tick = () => {
      if (stopped || busy) return;
      busy = true;
      const p = fn()
        .then((n) => {
          if (n > 0) log.debug({ loop: name, n }, "loop progress");
          // Keep draining while there is backlog.
          if (n > 0 && !stopped) setImmediate(tick);
        })
        .catch((error) => log.error({ loop: name, err: error instanceof Error ? error.message : String(error) }, "loop failed"))
        .finally(() => {
          busy = false;
          inflight.delete(p);
        });
      inflight.add(p);
    };
    timers.push(setInterval(tick, ms));
    tick();
  }

  if (env.WORKER_LOOPS) {
    every("domain-events", 1000, () => dispatchDomainEvents(host, 50));
    every("schedules", 15_000, () => runSchedules(host));
    every("messages", 1000, () => sendQueuedMessages(200));
    every("inbox", 1000, () => processInbox(hubDeps, 20));
    every("outbox", 1000, () => runOutbox(hubDeps, 20));
    every("syncs", 60_000, () => runDueSyncs(hubDeps));
    every("scheduled-exports", 30_000, scheduledExports);
    every("alerts", 60_000, thresholdAlerts);
    every("retention", 10 * 60_000, retention);
    every("copilot-index", 5 * 60_000, copilotIndex);
  }

  return async () => {
    stopped = true;
    for (const t of timers) clearInterval(t);
    await Promise.allSettled([...inflight]);
  };
}
