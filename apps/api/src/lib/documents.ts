import { randomUUID } from "node:crypto";

import { env } from "../env.js";
import { scanWithClamav } from "./clamav.js";
import { run, type Tx } from "./db.js";
import { HttpError } from "./errors.js";
import { log, store } from "./services.js";
import type { Context } from "hono";
import type { AppEnv } from "./types.js";

let bucketReady: Promise<void> | undefined;
const ready = () => (bucketReady ??= store.ensureBucket(env.S3_BUCKET_DOCUMENTS));

export type NewDocument = {
  data: Buffer;
  filename: string;
  mime?: string;
  kind?: string;
  entityType?: string | null;
  entityId?: string | null;
  folder?: string | null;
  metadata?: Record<string, unknown>;
  retentionYears?: number;
  delegationId?: string | null;
  signed?: boolean;
  previousVersionId?: string | null;
};

const safeName = (n: string) => n.replace(/[^\w.-]+/g, "_").slice(0, 150) || "file";

/** Stores bytes in object storage and registers them (hash, version, retention, access log). */
export async function saveDocument(db: Tx, doc: NewDocument, actorId: string | null): Promise<Record<string, unknown>> {
  if (doc.data.length > env.MAX_UPLOAD_BYTES) throw new HttpError(400, "File too large", "too_large");
  let scan: "clean" | "skipped" = "skipped";
  if (env.CLAMAV_HOST) {
    const result = await scanWithClamav(env.CLAMAV_HOST, env.CLAMAV_PORT, doc.data);
    if (result.infected) throw new HttpError(400, `File rejected by antivirus (${result.signature})`, "infected");
    scan = "clean";
  }
  await ready();
  const key = `${doc.entityType ?? "misc"}/${doc.entityId ?? "none"}/${randomUUID()}-${safeName(doc.filename)}`;
  const mime = doc.mime ?? "application/octet-stream";
  const { sha256, size } = await store.put(env.S3_BUCKET_DOCUMENTS, key, doc.data, mime);
  let version = 1;
  if (doc.previousVersionId) {
    version = ((await db.query<{ v: number }>("SELECT version AS v FROM documents WHERE id = $1", [doc.previousVersionId])).rows[0]?.v ?? 0) + 1;
  }
  const retention = doc.retentionYears ? new Date(Date.now() + doc.retentionYears * 365.25 * 86_400_000).toISOString().slice(0, 10) : null;
  const row = await db.query(
    `INSERT INTO documents (bucket, object_key, filename, mime, size_bytes, sha256, kind, entity_type, entity_id, folder, metadata,
                            signed, version, previous_version_id, scan_status, retention_until, delegation_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18)
     RETURNING id, filename, mime, size_bytes, sha256, kind, entity_type, entity_id, folder, metadata, signed, version, retention_until, created_at`,
    [env.S3_BUCKET_DOCUMENTS, key, doc.filename, mime, size, sha256, doc.kind ?? "attachment", doc.entityType ?? null, doc.entityId ?? null,
     doc.folder ?? null, JSON.stringify(doc.metadata ?? {}), doc.signed ?? false, version, doc.previousVersionId ?? null, scan, retention, doc.delegationId ?? null, actorId],
  );
  const created = row.rows[0]!;
  await db.query("INSERT INTO document_access_log (document_id, action, actor, ip) VALUES ($1, 'create', nullif(current_setting('app.actor', true), ''), nullif(current_setting('app.ip', true), ''))", [created.id]);
  log.info({ documentId: created.id, kind: doc.kind, size }, "document stored");
  return created;
}

export async function readDocument(c: Context<AppEnv>, id: string, action: "read" | "download" = "download") {
  const doc = await run(c, async (db) => {
    const r = await db.query<{ bucket: string; object_key: string; filename: string; mime: string }>(
      "SELECT bucket, object_key, filename, mime FROM documents WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    if (r.rows[0]) {
      await db.query("INSERT INTO document_access_log (document_id, action, actor, ip) VALUES ($1, $2, nullif(current_setting('app.actor', true), ''), nullif(current_setting('app.ip', true), ''))", [id, action]);
    }
    return r.rows[0];
  });
  if (!doc) throw new HttpError(404, "Document not found", "not_found");
  const object = await store.get(doc.bucket, doc.object_key);
  return { ...doc, body: object.body };
}
