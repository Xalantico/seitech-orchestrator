import cronParser from "cron-parser";

import { ConnectorError } from "../errors.js";
import { buildContext, loadConnector, resolveAdapter, type HubDeps } from "./connectors.js";
import type { Db } from "./db.js";
import { recordIntegrationError } from "./errors.js";

export type SyncConfig = { cron?: string; timezone?: string; full?: boolean };

async function cursorOf(db: Db, key: string): Promise<string | null> {
  const r = (await db.query<{ value: string | null }>("SELECT value FROM connector_state WHERE connector_key = $1 AND key = 'cursor'", [key])).rows[0];
  return r?.value ?? null;
}

/** Runs one synchronisation of a connector (nightly full sync or incremental pull) and records it (RNF-19: under 4 h). */
export async function runSync(deps: HubDeps, connectorKey: string, opts: { full?: boolean; trigger?: "schedule" | "manual" } = {}): Promise<{ runId: string; status: "succeeded" | "failed"; stats: Record<string, number>; durationMs: number }> {
  const connector = await loadConnector(deps.db, connectorKey);
  if (!connector) throw new ConnectorError(`Connector "${connectorKey}" does not exist`, "connector_missing", false);
  const started = Date.now();
  const full = opts.full ?? false;
  const run = (await deps.db.query<{ id: string }>("INSERT INTO sync_runs (connector_key, kind, trigger) VALUES ($1, $2, $3) RETURNING id", [connectorKey, full ? "full" : "incremental", opts.trigger ?? "manual"])).rows[0]!;
  try {
    const adapter = await resolveAdapter(connector);
    if (!adapter.sync) throw new ConnectorError(`Connector kind "${adapter.kind}" does not support synchronisation`, "sync_unsupported", false);
    const ctx = await buildContext(deps, connector);
    const result = await adapter.sync(ctx, { full, cursor: full ? null : await cursorOf(deps.db, connectorKey) });
    if (result.cursor !== undefined) {
      await deps.db.query(
        `INSERT INTO connector_state (connector_key, key, value) VALUES ($1, 'cursor', $2::jsonb) ON CONFLICT (connector_key, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [connectorKey, JSON.stringify(result.cursor)],
      );
    }
    await deps.db.query("UPDATE sync_runs SET status = 'succeeded', stats = $2::jsonb, finished_at = now() WHERE id = $1", [run.id, JSON.stringify(result.stats)]);
    await deps.db.query("UPDATE connectors SET last_sync_at = now(), last_status = 'ok' WHERE key = $1", [connectorKey]);
    return { runId: run.id, status: "succeeded", stats: result.stats, durationMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.db.query("UPDATE sync_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [run.id, message.slice(0, 2000)]);
    await deps.db.query("UPDATE connectors SET last_status = 'error' WHERE key = $1", [connectorKey]);
    await recordIntegrationError(deps.db, { connectorKey, direction: "sync", action: full ? "full-sync" : "sync", code: error instanceof ConnectorError ? error.code : "sync_failed", message });
    return { runId: run.id, status: "failed", stats: {}, durationMs: Date.now() - started };
  }
}

/**
 * Starts the syncs whose cron (`connectors.config.sync.cron`) came due since their last run. Cheap to call every
 * minute; a connector with a run in progress is skipped, so replicas never overlap.
 */
export async function runDueSyncs(deps: HubDeps, now = new Date()): Promise<number> {
  const connectors = (await deps.db.query<{ key: string; config: { sync?: SyncConfig } }>("SELECT key, config FROM connectors WHERE enabled AND config ? 'sync'")).rows;
  let started = 0;
  for (const c of connectors) {
    const cron = c.config.sync?.cron;
    if (!cron) continue;
    const last = (await deps.db.query<{ started_at: Date; status: string }>("SELECT started_at, status FROM sync_runs WHERE connector_key = $1 ORDER BY started_at DESC LIMIT 1", [c.key])).rows[0];
    if (last?.status === "running" && now.getTime() - last.started_at.getTime() < 6 * 3_600_000) continue;
    let next: Date;
    try {
      next = cronParser.parseExpression(cron, { currentDate: last?.started_at ?? new Date(now.getTime() - 86_400_000), ...(c.config.sync?.timezone ? { tz: c.config.sync.timezone } : {}) }).next().toDate();
    } catch {
      continue;
    }
    if (next.getTime() > now.getTime()) continue;
    // Claim the slot with a row before running, so a second replica sees "running" and skips.
    started++;
    await runSync(deps, c.key, { full: Boolean(c.config.sync?.full), trigger: "schedule" });
  }
  return started;
}
