import { getAdapter, type Adapter, type ConnectorContext, type ConnectorRecord, type DocumentGateway, type Logger, type ObjectGateway } from "../adapter.js";
import { permanent } from "../errors.js";
import type { Db } from "./db.js";

export type HubDeps = {
  db: Db;
  log: Logger;
  /** Reads a Vault secret by reference. Injected so the SDK has no platform dependency. */
  readSecret: (ref: string) => Promise<Record<string, string>>;
  /** Key for the encrypted customer columns (email, phone, tax id). */
  piiKey?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  documents?: DocumentGateway;
  objects?: ObjectGateway;
  /** Runs `fn` in one database transaction. Without it every statement commits on its own (fine for tests). */
  transaction?: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
};

const COLUMNS = "id, key, name, system_kind, base_url, auth_type, credentials_ref, webhook_secret_ref, config, enabled, mode";

export async function loadConnector(db: Db, key: string): Promise<ConnectorRecord | undefined> {
  return (await db.query<ConnectorRecord>(`SELECT ${COLUMNS} FROM connectors WHERE key = $1`, [key])).rows[0];
}

export async function resolveAdapter(connector: ConnectorRecord): Promise<Adapter> {
  const adapter = getAdapter(connector.system_kind);
  if (!adapter) throw permanent("adapter_missing", `No adapter is registered for system kind "${connector.system_kind}"`);
  return adapter;
}

export async function buildContext(deps: HubDeps, connector: ConnectorRecord, extra: Partial<Pick<ConnectorContext, "correlationId" | "executionId" | "idempotencyKey">> = {}): Promise<ConnectorContext> {
  let secrets: Record<string, string> = {};
  if (connector.credentials_ref) {
    try {
      secrets = await deps.readSecret(connector.credentials_ref);
    } catch (error) {
      throw permanent("credentials_unreadable", `Cannot read credentials "${connector.credentials_ref}": ${error instanceof Error ? error.message : "error"}`);
    }
  }
  return { connector, secrets, db: deps.db, log: deps.log, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.documents ? { documents: deps.documents } : {}), ...(deps.objects ? { objects: deps.objects } : {}), ...extra };
}

/** Secrets that may sign this connector's webhooks (current and, during rotation, previous). */
export async function webhookSecrets(deps: Pick<HubDeps, "readSecret">, connector: ConnectorRecord): Promise<string[]> {
  if (!connector.webhook_secret_ref) return [];
  const s = await deps.readSecret(connector.webhook_secret_ref);
  return [s.secret, s.webhook_secret, s.previous_secret].filter((v): v is string => Boolean(v));
}
