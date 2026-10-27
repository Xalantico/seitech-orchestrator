import { randomUUID } from "node:crypto";
import { withSystem } from "@orchestrador/db";
import type { DocumentGateway, ObjectGateway } from "@orchestrador/connector-sdk";
import type { ObjectStore } from "@orchestrador/platform";
import type pg from "pg";

export type GatewayOptions = {
  pool: pg.Pool;
  store: ObjectStore;
  bucket: string;
  log: { info: (o: object, m?: string) => void };
  maxBytes?: number;
};

/**
 * Documents and raw objects the connectors read and write. Used by the worker (inbound events, outbox) and the API
 * (manual actions and syncs), so both behave the same.
 */
export function createGateways({ pool, store, bucket: BUCKET, log, maxBytes = 50 * 1024 * 1024 }: GatewayOptions): { documents: DocumentGateway; objects: ObjectGateway } {
/** Raw objects written by the MinIO flavour of the document-manager driver live in their own bucket. */
const DMS_BUCKET = `${BUCKET}-dms`;

let ready: Promise<void> | undefined;
const ensure = () => (ready ??= Promise.all([store.ensureBucket(BUCKET), store.ensureBucket(DMS_BUCKET)]).then(() => undefined));


const safeName = (n: string) => n.replace(/[^\w.-]+/g, "_").slice(0, 150) || "file";

/**
 * Documents the connectors read and write (offers coming from the CRM, certificates, signed PDFs).
 * Bytes go to object storage first; the row (hash, version, access log) is written in its own system transaction.
 */
const documents: DocumentGateway = {
  async read(id) {
    const row = await withSystem(pool, async (db) => {
      const r = await db.query<{ id: string; bucket: string; object_key: string; filename: string; mime: string; kind: string; entity_type: string | null; entity_id: string | null; metadata: Record<string, unknown>; signed: boolean }>(
        "SELECT id, bucket, object_key, filename, mime, kind, entity_type, entity_id, metadata, signed FROM documents WHERE id = $1 AND deleted_at IS NULL",
        [id],
      );
      if (r.rows[0]) {
        await db.query("SELECT set_config('app.actor', 'integration-hub', true)");
        await db.query("INSERT INTO document_access_log (document_id, action, actor) VALUES ($1, 'read', 'integration-hub')", [id]);
      }
      return r.rows[0];
    });
    if (!row) throw new Error(`document ${id} not found`);
    const object = await store.get(row.bucket, row.object_key);
    return { id: row.id, filename: row.filename, mime: row.mime, data: object.body, kind: row.kind, entityType: row.entity_type, entityId: row.entity_id, metadata: row.metadata, signed: row.signed };
  },

  async save(doc) {
    if (doc.data.length > maxBytes) throw new Error("document too large");
    await ensure();
    const key = `${doc.entityType ?? "misc"}/${doc.entityId ?? "none"}/${randomUUID()}-${safeName(doc.filename)}`;
    const mime = doc.mime ?? "application/octet-stream";
    const { sha256, size } = await store.put(BUCKET, key, doc.data, mime);
    const created = await withSystem(pool, async (db) => {
      await db.query("SELECT set_config('app.actor', 'integration-hub', true)");
      let version = 1;
      if (doc.previousVersionId) {
        version = ((await db.query<{ v: number }>("SELECT version AS v FROM documents WHERE id = $1", [doc.previousVersionId])).rows[0]?.v ?? 0) + 1;
      }
      const row = await db.query<{ id: string; filename: string }>(
        `INSERT INTO documents (bucket, object_key, filename, mime, size_bytes, sha256, kind, entity_type, entity_id, folder, metadata, signed, version, previous_version_id, scan_status, dms_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, 'skipped', $15) RETURNING id, filename`,
        [BUCKET, key, doc.filename, mime, size, sha256, doc.kind ?? "attachment", doc.entityType ?? null, doc.entityId ?? null, doc.folder ?? null, JSON.stringify(doc.metadata ?? {}), doc.signed ?? false, version, doc.previousVersionId ?? null, doc.dmsRef ?? null],
      );
      const id = row.rows[0]!.id;
      await db.query("INSERT INTO document_access_log (document_id, action, actor) VALUES ($1, 'create', 'integration-hub')", [id]);
      return row.rows[0]!;
    });
    log.info({ documentId: created.id, kind: doc.kind, size }, "document stored by connector");
    return created;
  },
};

const objects: ObjectGateway = {
  async put(key, data, mime, metadata) {
    await ensure();
    await store.put(DMS_BUCKET, key, data, mime, metadata);
  },
  async get(key) {
    await ensure();
    try {
      const o = await store.get(DMS_BUCKET, key);
      return { data: o.body, mime: o.mime ?? "application/octet-stream", metadata: o.metadata };
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey") return undefined;
      throw e;
    }
  },
  async remove(key) {
    await ensure();
    await store.remove(DMS_BUCKET, key);
  },
  async list(prefix) {
    await ensure();
    return store.list(DMS_BUCKET, prefix);
  },
};

return { documents, objects };
}
