import { runSystem } from "./db.js";
import { log } from "./services.js";

/** Counts requests per user per day in memory and flushes every 30 s (RNF-03 licence report). */
const pending = new Map<string, number>();

export function trackUsage(userId: string): void {
  pending.set(userId, (pending.get(userId) ?? 0) + 1);
}

export async function flushUsage(): Promise<void> {
  if (pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();
  try {
    await runSystem((db) =>
      db.query(
        `INSERT INTO usage_daily (day, user_id, requests)
         SELECT current_date, u::uuid, c FROM unnest($1::text[], $2::int[]) AS t(u, c)
         ON CONFLICT (day, user_id) DO UPDATE SET requests = usage_daily.requests + EXCLUDED.requests, last_seen = now()`,
        [batch.map(([u]) => u), batch.map(([, c]) => c)],
      ),
    );
  } catch (error) {
    for (const [u, c] of batch) pending.set(u, (pending.get(u) ?? 0) + c);
    log.warn({ err: (error as Error).message }, "usage flush failed");
  }
}

export function startUsageFlusher(): () => void {
  const timer = setInterval(() => void flushUsage(), 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
