import { evaluateAlerts, runDueExports, runRetentionIfDue, type ExportDeps, type RetentionDeps } from "@orchestrador/backoffice";
import { createLlm, embedPending, indexBusinessData, seedGuide } from "@orchestrador/copilot";
import { createObjectStore } from "@orchestrador/platform";
import { withSystem } from "@orchestrador/db";

import { env } from "./env.js";
import { documentGateway } from "./gateways.js";
import { log, pool } from "./services.js";

const store = createObjectStore({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY });

const exportDeps: ExportDeps = {
  pool,
  log,
  publicBaseUrl: env.PUBLIC_BASE_URL,
  linkSecret: env.linkSecret,
  maxRows: env.EXPORT_MAX_ROWS,
  saveDocument: (f) => documentGateway.save({ data: f.data, filename: f.filename, mime: f.mime, kind: "export", entityType: "export", entityId: f.entityId, metadata: f.metadata }),
};

const retentionDeps: RetentionDeps = {
  pool,
  log,
  policy: { operationalYears: env.RETENTION_OPERATIONAL_YEARS },
  removeObject: (bucket, key) => store.remove(bucket, key),
};

const llm = createLlm({ url: env.LLM_API_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL, embeddingModel: env.LLM_EMBEDDING_MODEL });

/** Scheduled exports that are due (ORF-042). Returns how many ran so the loop keeps draining a backlog. */
export const scheduledExports = () => runDueExports(exportDeps);

/** Threshold alerts (ORF-040): evaluated every minute; returns 0 so the loop keeps its normal cadence. */
export async function thresholdAlerts(): Promise<number> {
  await evaluateAlerts({ pool, log, publicBaseUrl: env.PUBLIC_BASE_URL });
  return 0;
}

/** Daily retention purge at 03:00 Madrid time (ORF-030). */
export const retention = () => runRetentionIfDue(retentionDeps);

let guideLoaded = false;
/**
 * Keeps the copilot's knowledge current: the platform guide once per start, then work orders and nonconformities changed since the
 * last pass, then embeddings for whatever has none (only when pgvector and a model are available).
 */
export async function copilotIndex(): Promise<number> {
  const result = await withSystem(pool, async (db) => {
    await db.query("SELECT set_config('app.actor', 'copilot-indexer', true)");
    if (!guideLoaded) {
      await seedGuide(db);
      guideLoaded = true;
    }
    const last = (await db.query<{ started_at: Date }>("SELECT started_at FROM maintenance_runs WHERE kind = 'copilot-index' AND status = 'done' ORDER BY started_at DESC LIMIT 1")).rows[0]?.started_at;
    const startedAt = new Date();
    // A small overlap covers rows committed while the previous pass was reading.
    const since = last ? new Date(last.getTime() - 60_000) : new Date(0);
    const indexed = await indexBusinessData(db, since);
    const embedded = await embedPending(db, llm).catch((error) => {
      log.warn({ err: String(error) }, "embedding pass failed");
      return 0;
    });
    await db.query("INSERT INTO maintenance_runs (kind, status, started_at, finished_at, detail) VALUES ('copilot-index', 'done', $1, now(), $2::jsonb)", [startedAt, JSON.stringify({ ...indexed, embedded })]);
    return indexed.workOrders + indexed.nonconformities + embedded;
  });
  return result >= 500 ? result : 0; // a full batch means there is more to do right now
}
