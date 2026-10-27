import { envBool, loadEnv } from "@orchestrador/platform";
import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Local development convenience only; containers get their environment from compose + Vault.
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const raw = await loadEnv({
  DB_POOL_MAX: z.coerce.number().default(20),
  METRICS_PORT: z.coerce.number().default(9464),
  /** Comma separated queue families this process serves (default: all). */
  WORKER_QUEUES: z.string().default("flows,integrations,notifications,batch"),
  WORKER_SIMULATION: z.string().optional(),
  /** Run the domain-event dispatcher and cron scheduler in this process. */
  WORKER_LOOPS: envBool.default("true"),
  WORKER_MAX_CONCURRENT_ACTIVITIES: z.coerce.number().default(100),
  WORKER_MAX_CONCURRENT_WORKFLOW_TASKS: z.coerce.number().default(100),
  MESSAGE_CONCURRENCY: z.coerce.number().default(20),
  DOWNLOAD_LINK_SECRET: z.string().min(16).optional(),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:6001"),
  EXPORT_MAX_ROWS: z.coerce.number().default(100_000),
  RETENTION_OPERATIONAL_YEARS: z.coerce.number().int().min(1).max(30).default(5),
  LLM_API_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  LLM_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().default(3310),
});

export const env = {
  ...raw,
  piiKey: raw.PII_ENCRYPTION_KEY ?? "demo-only-key",
  linkSecret: raw.DOWNLOAD_LINK_SECRET ?? `${raw.PII_ENCRYPTION_KEY ?? "demo-only-key"}:download-links`,
  queues: raw.WORKER_QUEUES.split(",").map((q) => q.trim()).filter(Boolean),
  serveSimulation: raw.WORKER_SIMULATION === undefined ? true : envBool.parse(raw.WORKER_SIMULATION),
};
