import { envBool, loadEnv } from "@orchestrador/platform";
import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Local development convenience only; containers get their environment from compose + Vault.
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const raw = await loadEnv({
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().default(3001),
  WEB_ORIGIN: z.string().url().default("http://localhost:6001"),
  PUBLIC_API_URL: z.string().url().optional(),
  DB_POOL_MAX: z.coerce.number().default(20),
  APP_DB_ROLE: z.string().optional(),
  AUTH_MODE: z.enum(["otp", "oidc"]).default("otp"),
  SESSION_TTL_DAYS: z.coerce.number().default(7),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_DISCOVERY_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_AUDIENCE: z.string().optional(),
  OIDC_ASSUME_MFA: z.string().optional(),
  OIDC_AUTO_PROVISION: z.string().optional(),
  KEYCLOAK_ADMIN_URL: z.string().url().optional(),
  KEYCLOAK_ADMIN_CLIENT_ID: z.string().optional(),
  KEYCLOAK_ADMIN_CLIENT_SECRET: z.string().optional(),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(1200),
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().default(20),
  REQUIRE_MFA_FOR_PII: z.string().optional(),
  RUN_MIGRATIONS_ON_START: z.string().optional(),
  PII_ENCRYPTION_KEY: z.string().min(16).optional(),
  EXPORT_MAX_ROWS: z.coerce.number().default(100_000),
  WEBHOOK_MAX_BODY_BYTES: z.coerce.number().default(2_000_000),
  /** Where the simulated external systems listen. When set, the connectors are installed pointing at them. */
  MOCK_CONNECTORS_URL: z.string().url().optional(),
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().default(3310),
  MAX_UPLOAD_BYTES: z.coerce.number().default(50_000_000),
  LLM_API_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  /** Signs download links mailed by scheduled exports. */
  DOWNLOAD_LINK_SECRET: z.string().min(16).optional(),
  /** Public address of the web app, used in links inside e-mails. */
  PUBLIC_BASE_URL: z.string().url().optional(),
  METABASE_SITE_URL: z.string().url().optional(),
  METABASE_EMBEDDING_SECRET: z.string().min(16).optional(),
  /** `id:Name,id:Name` of the Metabase dashboards offered in the app. */
  METABASE_DASHBOARDS: z.string().optional(),
  RETENTION_OPERATIONAL_YEARS: z.coerce.number().int().min(1).max(30).default(5),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  LLM_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
});

const flag = (v: string | undefined, fallback = false) => (v === undefined ? fallback : envBool.parse(v));

export const env = {
  ...raw,
  isProd: raw.APP_ENV === "prod",
  piiKey: raw.PII_ENCRYPTION_KEY ?? "demo-only-key",
  oidcAssumeMfa: flag(raw.OIDC_ASSUME_MFA),
  oidcAutoProvision: flag(raw.OIDC_AUTO_PROVISION, true),
  requireMfaForPii: flag(raw.REQUIRE_MFA_FOR_PII, raw.APP_ENV === "prod"),
  runMigrationsOnStart: flag(raw.RUN_MIGRATIONS_ON_START),
  secureCookies: raw.WEB_ORIGIN.startsWith("https://"),
  publicApiUrl: raw.PUBLIC_API_URL ?? raw.WEB_ORIGIN,
  publicBaseUrl: raw.PUBLIC_BASE_URL ?? raw.WEB_ORIGIN,
  linkSecret: raw.DOWNLOAD_LINK_SECRET ?? `${raw.PII_ENCRYPTION_KEY ?? "demo-only-key"}:download-links`,
  dashboards: (raw.METABASE_DASHBOARDS ?? "").split(",").map((d) => d.trim()).filter(Boolean).map((d) => {
    const [id, ...name] = d.split(":");
    return { id: Number(id), name: name.join(":").trim() || `Dashboard ${id}` };
  }).filter((d) => Number.isInteger(d.id) && d.id > 0),
};

if (env.isProd && !raw.PII_ENCRYPTION_KEY) throw new Error("PII_ENCRYPTION_KEY is required in production");
if (env.isProd && !raw.DOWNLOAD_LINK_SECRET) throw new Error("DOWNLOAD_LINK_SECRET is required in production");

if (env.AUTH_MODE === "oidc") {
  for (const key of ["OIDC_ISSUER", "OIDC_CLIENT_ID"] as const) {
    if (!env[key]) throw new Error(`${key} is required when AUTH_MODE=oidc`);
  }
}
