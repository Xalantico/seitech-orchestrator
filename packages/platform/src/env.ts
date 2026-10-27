import { z } from "zod";

import { loadVaultIntoEnv } from "./vault.js";

export const APP_ENVS = ["dev", "test", "preprod", "prod"] as const;

/** Variables every service understands. No credential has a default: missing ones fail fast. */
export const baseEnvShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(APP_ENVS).default("dev"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().url(),
  TEMPORAL_ADDRESS: z.string().default("127.0.0.1:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_SIM_NAMESPACE: z.string().optional(),
  TEMPORAL_UI_ORIGIN: z.string().url().default("http://localhost:8233"),
  REDIS_URL: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("eu-west-1"),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET_DOCUMENTS: z.string().default("orquestador-documents"),
  PII_ENCRYPTION_KEY: z.string().min(16).optional(),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("Orquestador <no-reply@orquestador.local>"),
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
};

/**
 * Loads Vault secrets (if configured) then validates the environment. Call with top-level await so
 * every module sees a typed, validated `env`.
 */
export async function loadEnv<S extends z.ZodRawShape>(shape: S): Promise<z.infer<z.ZodObject<S & typeof baseEnvShape>>> {
  await loadVaultIntoEnv();
  const schema = z.object({ ...baseEnvShape, ...shape });
  // Compose passes unset optional settings as empty strings; those mean "not configured".
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data as z.infer<z.ZodObject<S & typeof baseEnvShape>>;
  if (env.APP_ENV === "prod" && !env.PII_ENCRYPTION_KEY) {
    throw new Error("PII_ENCRYPTION_KEY is required when APP_ENV=prod");
  }
  return env;
}

/** Boolean env parsing: "true", "1" and "yes" are true. */
export const envBool = z
  .string()
  .optional()
  .transform((v) => v !== undefined && ["true", "1", "yes", "on"].includes(v.toLowerCase()));
