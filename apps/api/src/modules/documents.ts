import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";

import { env } from "../env.js";
import { run } from "../lib/db.js";
import { readDocument, saveDocument } from "../lib/documents.js";
import { HttpError, notFound } from "../lib/errors.js";
import { define, z } from "../lib/route.js";
import { requirePermission } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";

export const documents = new OpenAPIHono<AppEnv>();
const TAG = "Documents";

documents.post(
  "/documents",
  requirePermission("documents:write"),
  bodyLimit({ maxSize: env.MAX_UPLOAD_BYTES + 1_000_000, onError: (c) => c.json({ error: "File too large", code: "too_large" }, 413) }),
  async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(400, "Multipart field 'file' is required", "bad_request");
    let metadata: Record<string, unknown> = {};
    if (typeof form.metadata === "string" && form.metadata) {
      try { metadata = JSON.parse(form.metadata) as Record<string, unknown>; } catch { throw new HttpError(400, "metadata must be JSON", "bad_request"); }
    }
    const str = (k: string) => (typeof form[k] === "string" && form[k] ? (form[k] as string) : null);
    const principal = c.get("principal");
    const created = await run(c, async (db) =>
      saveDocument(db, {
        data: Buffer.from(await file.arrayBuffer()), filename: file.name, mime: file.type || undefined,
        kind: str("kind") ?? "attachment", entityType: str("entityType"), entityId: str("entityId"), folder: str("folder"),
        metadata, previousVersionId: str("previousVersionId"),
      }, principal.kind === "user" ? principal.id : null),
    );
    return c.json(created, 201);
  },
);

define(documents, { method: "get", path: "/documents", tag: TAG, summary: "Search documents by entity or indexed metadata (ORF-057)", permission: "documents:read", query: z.object({ entity_type: z.string().optional(), entity_id: z.string().uuid().optional(), kind: z.string().optional(), q: z.string().optional(), meta: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }, async (c, i) => {
  const where = ["deleted_at IS NULL"];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (i.query.entity_type) add("entity_type = ?", i.query.entity_type);
  if (i.query.entity_id) add("entity_id = ?", i.query.entity_id);
  if (i.query.kind) add("kind = ?", i.query.kind);
  if (i.query.q) add("filename ILIKE ?", `%${i.query.q}%`);
  if (i.query.meta) {
    try { add("metadata @> ?::jsonb", JSON.stringify(JSON.parse(i.query.meta))); } catch { throw new HttpError(400, "meta must be a JSON object", "bad_request"); }
  }
  const r = await run(c, (db) =>
    db.query(`SELECT id, filename, mime, size_bytes, sha256, kind, entity_type, entity_id, folder, metadata, signed, version, scan_status, retention_until, created_at FROM documents WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${i.query.limit}`, params),
  );
  return c.json({ items: r.rows });
});

documents.get("/documents/:id/download", requirePermission("documents:read"), async (c) => {
  const doc = await readDocument(c, c.req.param("id"), "download");
  c.header("content-type", doc.mime);
  c.header("content-disposition", `attachment; filename="${encodeURIComponent(doc.filename)}"`);
  return c.body(new Uint8Array(doc.body));
});

define(documents, { method: "delete", path: "/documents/{id}", tag: TAG, summary: "Soft-delete a document (kept for audit)", permission: "documents:write", params: z.object({ id: z.string().uuid() }) }, async (c, i) => {
  const r = await run(c, async (db) => {
    const x = await db.query("UPDATE documents SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL AND (retention_until IS NULL OR retention_until < current_date) RETURNING id", [i.params.id]);
    if (x.rows[0]) await db.query("INSERT INTO document_access_log (document_id, action, actor) VALUES ($1, 'delete', nullif(current_setting('app.actor', true), ''))", [i.params.id]);
    return x;
  });
  if (!r.rows[0]) throw notFound("Document (or still under legal retention)");
  return c.json({ ok: true });
});

define(documents, { method: "get", path: "/documents/{id}/access-log", tag: TAG, summary: "Who accessed or changed a document, when and from where (ORF-055)", permission: "documents:audit", params: z.object({ id: z.string().uuid() }) }, async (c, i) => {
  const r = await run(c, (db) => db.query("SELECT action, actor, ip, at FROM document_access_log WHERE document_id = $1 ORDER BY at DESC", [i.params.id]));
  return c.json({ items: r.rows });
});

define(documents, { method: "get", path: "/documents/{id}/versions", tag: TAG, summary: "Version chain of a document", permission: "documents:read", params: z.object({ id: z.string().uuid() }) }, async (c, i) => {
  const r = await run(c, (db) =>
    db.query(
      `WITH RECURSIVE chain AS (
         SELECT id, previous_version_id, version, filename, sha256, created_at FROM documents WHERE id = $1
         UNION ALL SELECT d.id, d.previous_version_id, d.version, d.filename, d.sha256, d.created_at FROM documents d JOIN chain c ON d.id = c.previous_version_id)
       SELECT * FROM chain ORDER BY version DESC`,
      [i.params.id],
    ),
  );
  return c.json({ items: r.rows });
});

define(documents, { method: "get", path: "/document-access-log", tag: TAG, summary: "Central document access log", permission: "documents:audit", query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }) }, async (c, i) => {
  const r = await run(c, (db) =>
    db.query(`SELECT l.id, l.document_id, d.filename, l.action, l.actor, l.ip, l.at FROM document_access_log l JOIN documents d ON d.id = l.document_id ORDER BY l.at DESC LIMIT ${i.query.limit}`),
  );
  return c.json({ items: r.rows });
});
