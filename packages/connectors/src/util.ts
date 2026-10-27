import { permanent, type ConnectorContext, type DocumentGateway, type FieldSpec } from "@orchestrador/connector-sdk";

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const asObj = (v: unknown): Obj => (isObj(v) ? v : {});
export const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function need(input: Obj, key: string): string {
  const v = str(input[key]);
  if (!v) throw permanent("input_invalid", `"${key}" is required`);
  return v;
}

/** Checks the action input against its field list so a bad call fails once, clearly, instead of at the remote end. */
export function checkInput(fields: FieldSpec[], input: Obj): void {
  for (const f of fields) {
    const v = input[f.key];
    if (f.required && (v === undefined || v === null || v === "")) throw permanent("input_invalid", `"${f.key}" is required`);
    if (v !== undefined && v !== null && f.type === "number" && !Number.isFinite(Number(v))) throw permanent("input_invalid", `"${f.key}" must be a number`);
    if (v !== undefined && v !== null && f.type === "select" && f.options && !f.options.some(([o]) => o === String(v))) throw permanent("input_invalid", `"${f.key}" must be one of: ${f.options.map(([o]) => o).join(", ")}`);
  }
}

/** `/orders/{id}` + { id: "A 1" } -> `/orders/A%201`. A missing value is a permanent input error. */
export function fillPath(path: string, input: Obj): string {
  return path.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = str(input[key]);
    if (!v) throw permanent("input_invalid", `"${key}" is required`);
    return encodeURIComponent(v);
  });
}

export const pathKeys = (path: string): string[] => [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);

export const toB64 = (data: Buffer) => data.toString("base64");
export const fromB64 = (value: string) => Buffer.from(value, "base64");

export function documentsOf(ctx: ConnectorContext): DocumentGateway {
  if (!ctx.documents) throw permanent("documents_unavailable", "This runtime has no document storage; run the action from the worker");
  return ctx.documents;
}

export type IncomingDocument = { contentBase64?: unknown; filename?: unknown; mime?: unknown; kind: string; entityType?: string | null; entityId?: string | null; metadata?: Obj; signed?: boolean; previousVersionId?: string | null; dmsRef?: string | null; folder?: string | null };

/** Stores a document a remote system delivered (base64 in JSON). */
export async function saveIncoming(ctx: ConnectorContext, d: IncomingDocument): Promise<{ id: string; filename: string }> {
  const content = str(d.contentBase64);
  if (!content) throw permanent("document_empty", "The remote system sent a document without content");
  const filename = str(d.filename) ?? `${d.kind}-${Date.now()}`;
  return documentsOf(ctx).save({
    data: fromB64(content), filename, mime: str(d.mime) ?? "application/octet-stream", kind: d.kind, entityType: d.entityType ?? null, entityId: d.entityId ?? null,
    folder: d.folder ?? null, metadata: { ...(d.metadata ?? {}), source: ctx.connector.key }, signed: d.signed ?? false, previousVersionId: d.previousVersionId ?? null, dmsRef: d.dmsRef ?? null,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

type VisitRow = { id: string; work_order_id: string; status: string; delegation_id: string | null; technician_id: string | null };

/** A visit by its id, its number or the reference the remote system holds. */
export async function findVisit(ctx: ConnectorContext, ref: unknown): Promise<VisitRow | undefined> {
  const v = str(ref);
  if (!v) return undefined;
  const sql = "SELECT id, work_order_id, status, delegation_id, technician_id FROM visits";
  if (isUuid(v)) return (await ctx.db.query<VisitRow>(`${sql} WHERE id = $1`, [v])).rows[0];
  const byExternal = (await ctx.db.query<VisitRow>(`${sql} WHERE external_ref = $1`, [v])).rows[0];
  if (byExternal) return byExternal;
  const viaRef = (await ctx.db.query<VisitRow>(`${sql} WHERE id = (SELECT entity_id FROM external_refs WHERE entity_type = 'visit' AND connector_key = $1 AND external_id = $2)`, [ctx.connector.key, v])).rows[0];
  if (viaRef) return viaRef;
  return /^\d+$/.test(v) ? (await ctx.db.query<VisitRow>(`${sql} WHERE number = $1`, [v])).rows[0] : undefined;
}

export async function linkExternal(ctx: ConnectorContext, entityType: string, entityId: string, externalId: string): Promise<void> {
  await ctx.db.query(
    `INSERT INTO external_refs (entity_type, entity_id, connector_key, external_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (entity_type, entity_id, connector_key) DO UPDATE SET external_id = EXCLUDED.external_id, synced_at = now()`,
    [entityType, entityId, ctx.connector.key, externalId],
  );
}

export async function externalIdOf(ctx: ConnectorContext, entityType: string, entityId: string): Promise<string | null> {
  return (await ctx.db.query<{ external_id: string }>("SELECT external_id FROM external_refs WHERE entity_type = $1 AND entity_id = $2 AND connector_key = $3", [entityType, entityId, ctx.connector.key])).rows[0]?.external_id ?? null;
}

export const SYSTEM_ACTOR = { label: "integration-hub", system: true as const };
