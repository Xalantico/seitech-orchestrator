import type { Db } from "./hub/db.js";

export type FieldSpec = {
  key: string;
  label: string;
  type: "string" | "text" | "number" | "boolean" | "json" | "select";
  required?: boolean;
  options?: [string, string][];
  help?: string;
  default?: unknown;
};

export type ConnectorRecord = {
  id?: string;
  key: string;
  name: string;
  system_kind: string;
  base_url: string | null;
  auth_type: "none" | "api_key" | "basic" | "bearer" | "oauth2";
  credentials_ref: string | null;
  webhook_secret_ref: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  mode: "mock" | "live";
};

export type Logger = { debug: (o: object, m?: string) => void; info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

/** A stored platform document, as adapters see it. */
export type StoredDocument = { id: string; filename: string; mime: string; data: Buffer; kind: string; entityType: string | null; entityId: string | null; metadata: Record<string, unknown>; signed: boolean };

/** Reads and writes platform documents (object storage + the `documents` table). Injected by the API/worker. */
export type DocumentGateway = {
  read(id: string): Promise<StoredDocument>;
  save(doc: { data: Buffer; filename: string; mime?: string; kind?: string; entityType?: string | null; entityId?: string | null; folder?: string | null; metadata?: Record<string, unknown>; signed?: boolean; previousVersionId?: string | null; dmsRef?: string | null }): Promise<{ id: string; filename: string }>;
};

/** Raw object storage for the MinIO flavour of the document manager driver. */
export type ObjectGateway = {
  put(key: string, data: Buffer, mime: string, metadata?: Record<string, string>): Promise<void>;
  get(key: string): Promise<{ data: Buffer; mime: string; metadata: Record<string, string> } | undefined>;
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<{ key: string; size: number; modifiedAt: string }[]>;
};

/** Everything an adapter needs for one call. The hub builds it; adapters never read env or Vault themselves. */
export type ConnectorContext = {
  connector: ConnectorRecord;
  /** Resolved secrets (api key, password, client secret...). Never logged or stored. */
  secrets: Record<string, string>;
  db: Db;
  log: Logger;
  correlationId?: string;
  executionId?: string;
  /** Stable per logical call: adapters pass it to the remote system (`Idempotency-Key`) so a retry never duplicates. */
  idempotencyKey?: string;
  fetch?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => Date;
  documents?: DocumentGateway;
  objects?: ObjectGateway;
};

export type ActionResult = {
  output: unknown;
  /** Id the remote system assigned; saved in `external_refs` when the action names an entity. */
  externalId?: string;
};

export type ActionSpec = {
  key: string;
  label: string;
  description?: string;
  /** `push` writes to the remote system, `pull` reads. */
  direction: "push" | "pull";
  input: FieldSpec[];
  /** Safe to repeat without `idempotencyKey` (reads, PUT upserts). */
  idempotent?: boolean;
  run(ctx: ConnectorContext, input: Record<string, unknown>): Promise<ActionResult>;
};

export type InboundOutcome = {
  /** Short text for the inbox row (`created order 123`). */
  summary?: string;
  /** Domain events to raise so flows can react (stored in the same transaction). */
  events?: { type: string; entityType?: string; entityId?: string; payload?: Record<string, unknown> }[];
};

export type InboundHandler = (ctx: ConnectorContext, payload: unknown, meta: { eventId: string; eventType: string }) => Promise<InboundOutcome>;

export type Adapter = {
  /** Matches `connectors.system_kind`. */
  kind: string;
  label: string;
  description: string;
  /** Extra settings shown in the connector form (`connectors.config`). */
  configSchema?: FieldSpec[];
  actions: ActionSpec[];
  /** Inbound events by `event_type` (webhooks and polled changes). */
  inbound?: Record<string, InboundHandler>;
  /** Reads the event id / type from a webhook (defaults: `x-event-id` header, `type` field). */
  eventIdOf?: (payload: unknown, headers: Record<string, string>) => string | null;
  eventTypeOf?: (payload: unknown, headers: Record<string, string>) => string | null;
  /** Health check used by "Test connection". */
  ping?(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }>;
  /** Nightly or on-demand full synchronisation. Returns counters for the sync run record. */
  sync?(ctx: ConnectorContext, opts: { full: boolean; cursor?: string | null }): Promise<{ stats: Record<string, number>; cursor?: string | null }>;
};

const registry = new Map<string, Adapter>();

export function registerAdapter(adapter: Adapter): void {
  registry.set(adapter.kind, adapter);
}

export function getAdapter(kind: string): Adapter | undefined {
  return registry.get(kind);
}

export function listAdapters(): Adapter[] {
  return [...registry.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

export function findAction(adapter: Adapter, key: string): ActionSpec | undefined {
  return adapter.actions.find((a) => a.key === key);
}
