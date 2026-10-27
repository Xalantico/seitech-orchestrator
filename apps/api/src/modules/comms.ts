import { OpenAPIHono } from "@hono/zod-openapi";
import { compileMjml, extractVariables, previewTemplate, validateTemplate, MAX_TEMPLATE_BYTES } from "@orchestrador/comms";
import { bodyLimit } from "hono/body-limit";

import { crud, zJson, zUuid } from "../lib/crud.js";
import { run, type Tx } from "../lib/db.js";
import { HttpError, conflict, notFound } from "../lib/errors.js";
import { define, z } from "../lib/route.js";
import { requirePermission } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";

export const comms = new OpenAPIHono<AppEnv>();
const TAG = "Communications";
const KIND = z.enum(["email", "sms", "whatsapp", "push", "internal"]);

// ───────────── channels per delegation (ORF-048) ─────────────
comms.route("/", crud({
  permissions: { read: "channels:read", write: "channels:write" }, tag: TAG, table: "channels", basePath: "/channels",
  fields: {
    key: { schema: z.string().regex(/^[a-z][a-z0-9_-]*$/) }, kind: { schema: KIND }, name: { schema: z.string().min(1) }, delegation_id: { schema: zUuid.nullable().optional() },
    sender: { schema: z.string().nullable().optional() }, provider: { schema: z.enum(["mock", "smtp", "postmark", "http", "internal"]).optional() }, config: { schema: zJson.optional(), cast: "jsonb" },
    secret_ref: { schema: z.string().nullable().optional() }, rate_limit_per_min: { schema: z.number().int().min(1).max(100_000).optional() }, max_attempts: { schema: z.number().int().min(1).max(20).optional() },
    enabled: { schema: z.boolean().optional() },
  },
  readonly: ["created_at"], search: ["key", "name"], filters: ["kind", "delegation_id", "enabled"], defaultOrder: "kind, key",
}));

// ───────────── templates with versions, upload and preview (ORF-049, ORF-050) ─────────────
comms.route("/", crud({
  permissions: { read: "templates:read", write: "templates:write" }, tag: TAG, table: "templates", basePath: "/templates-meta",
  fields: { name: { schema: z.string().min(1) }, description: { schema: z.string().optional() }, delegation_id: { schema: zUuid.nullable().optional() }, locale: { schema: z.string().min(2).max(8).optional() } },
  readonly: ["key", "channel_kind", "created_at"], search: ["key", "name"], filters: ["channel_kind", "delegation_id", "locale"], defaultOrder: "key", deletable: false,
}));

const versionBody = z.object({
  subject: z.string().max(300).default(""), bodyHtml: z.string().default(""), bodyText: z.string().default(""),
  editorProject: zJson.nullable().optional(), branding: zJson.default({}), origin: z.enum(["editor", "upload", "seed"]).default("editor"),
  /** MJML source from the WYSIWYG editor. When present it is compiled and replaces `bodyHtml`. */
  mjml: z.string().max(300_000).optional(),
});

async function addVersion(db: Tx, templateId: string, channelKind: string, input: z.infer<typeof versionBody>, userId: string | null) {
  const v = { ...input };
  if (input.mjml) {
    const compiled = compileMjml(input.mjml);
    if (!compiled.html) throw new HttpError(422, compiled.errors.map((e) => e.message).join("; ") || "MJML could not be compiled", "invalid_mjml", { issues: compiled.errors });
    v.bodyHtml = compiled.html;
  }
  const issues = validateTemplate({ channelKind, subject: v.subject, bodyHtml: v.bodyHtml, bodyText: v.bodyText });
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) throw new HttpError(422, errors.map((e) => e.message).join("; "), "invalid_template", { issues });
  const next = (await db.query<{ n: number }>("SELECT coalesce(max(version), 0)::int + 1 AS n FROM template_versions WHERE template_id = $1", [templateId])).rows[0]!.n;
  const row = (await db.query(
    `INSERT INTO template_versions (template_id, version, state, subject, body_html, body_text, variables, editor_project, origin, branding, created_by, mjml)
     VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11) RETURNING id, version, state, variables, origin, created_at`,
    [templateId, next, v.subject, v.bodyHtml, v.bodyText, extractVariables(v.subject, v.bodyHtml, v.bodyText, input.mjml ?? ""), v.editorProject ? JSON.stringify(v.editorProject) : null, v.origin, JSON.stringify(v.branding), userId, input.mjml ?? null],
  )).rows[0];
  return { ...row, warnings: issues.filter((i) => i.severity === "warning").map((i) => i.message) };
}

define(comms, {
  method: "post", path: "/templates", tag: TAG, summary: "Create a template with its first draft version", permission: "templates:write", status: 201,
  body: versionBody.extend({ key: z.string().regex(/^[a-z][a-z0-9._-]*$/), name: z.string().min(1), channelKind: KIND, delegationId: zUuid.nullable().optional(), locale: z.string().min(2).max(8).default("es"), description: z.string().default("") }),
}, async (c, i) => {
  const p = c.get("principal");
  const out = await run(c, async (db) => {
    const t = (await db.query("INSERT INTO templates (key, name, channel_kind, delegation_id, locale, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, key", [i.body.key, i.body.name, i.body.channelKind, i.body.delegationId ?? null, i.body.locale, i.body.description])).rows[0];
    const version = await addVersion(db, t.id, i.body.channelKind, i.body, p.kind === "user" ? p.id : null);
    return { id: t.id, key: t.key, version };
  });
  return c.json(out, 201);
});

define(comms, {
  method: "get", path: "/templates", tag: TAG, summary: "Templates with their published and latest versions", permission: "templates:read",
  query: z.object({ channel_kind: KIND.optional(), q: z.string().optional(), delegation_id: zUuid.optional() }),
}, async (c, i) => {
  const params: unknown[] = [];
  const where: string[] = [];
  if (i.query.channel_kind) { params.push(i.query.channel_kind); where.push(`t.channel_kind = $${params.length}`); }
  if (i.query.delegation_id) { params.push(i.query.delegation_id); where.push(`(t.delegation_id = $${params.length} OR t.delegation_id IS NULL)`); }
  if (i.query.q) { params.push(`%${i.query.q.replace(/[\\%_]/g, "\\$&")}%`); where.push(`(t.key ILIKE $${params.length} OR t.name ILIKE $${params.length})`); }
  const r = await run(c, (db) => db.query(
    `SELECT t.id, t.key, t.name, t.channel_kind, t.locale, t.description, t.delegation_id, t.created_at,
            (SELECT version FROM template_versions v WHERE v.template_id = t.id AND v.state = 'published') AS published_version,
            (SELECT max(version) FROM template_versions v WHERE v.template_id = t.id) AS latest_version
     FROM templates t ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t.key`, params));
  return c.json({ items: r.rows });
});

define(comms, { method: "get", path: "/templates/{id}", tag: TAG, summary: "A template and all its versions", permission: "templates:read", params: z.object({ id: zUuid }) }, async (c, i) => {
  const out = await run(c, async (db) => {
    const t = (await db.query("SELECT id, key, name, channel_kind, locale, description, delegation_id, created_at FROM templates WHERE id = $1", [i.params.id])).rows[0];
    if (!t) return null;
    const versions = (await db.query("SELECT id, version, state, subject, body_html, body_text, variables, origin, branding, editor_project, mjml, created_at, created_by FROM template_versions WHERE template_id = $1 ORDER BY version DESC", [i.params.id])).rows;
    return { ...t, versions };
  });
  if (!out) throw notFound("Template");
  return c.json(out);
});

define(comms, {
  method: "post", path: "/templates/mjml/compile", tag: TAG, summary: "Compile MJML from the visual editor into e-mail HTML and check it", permission: "templates:write",
  body: z.object({ mjml: z.string().min(1).max(300_000), sample: zJson.optional() }),
}, async (c, i) => {
  const out = compileMjml(i.body.mjml);
  const issues = out.html ? validateTemplate({ channelKind: "email", subject: "-", bodyHtml: out.html, bodyText: "-" }).filter((x) => x.message !== "Add a plain-text version for clients that cannot show HTML") : [];
  const preview = out.html && i.body.sample ? previewTemplate({ subject: "", bodyHtml: out.html, bodyText: "" }, i.body.sample).html : undefined;
  return c.json({ html: out.html, variables: extractVariables(i.body.mjml), errors: out.errors, issues, ...(preview ? { preview } : {}) });
});

define(comms, { method: "post", path: "/templates/{id}/versions", tag: TAG, summary: "Add a new draft version (validated: no scripts or active content)", permission: "templates:write", params: z.object({ id: zUuid }), body: versionBody, status: 201 }, async (c, i) => {
  const p = c.get("principal");
  const out = await run(c, async (db) => {
    const t = (await db.query<{ channel_kind: string }>("SELECT channel_kind FROM templates WHERE id = $1", [i.params.id])).rows[0];
    if (!t) throw notFound("Template");
    return addVersion(db, i.params.id, t.channel_kind, i.body, p.kind === "user" ? p.id : null);
  });
  return c.json(out, 201);
});

/** Template upload (ORF-050): an .html (or .txt) file becomes a new version; the subject and plain text can come along as fields. */
comms.post("/templates/:id/upload", requirePermission("templates:write"), bodyLimit({ maxSize: MAX_TEMPLATE_BYTES + 100_000, onError: (c) => c.json({ error: "Template too large", code: "too_large" }, 413) }), async (c) => {
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) throw new HttpError(400, "Multipart field 'file' is required", "bad_request");
  if (!/\.(html?|txt)$/i.test(file.name)) throw new HttpError(400, "Only .html, .htm or .txt files can be uploaded", "bad_request");
  const text = await file.text();
  const isHtml = /\.html?$/i.test(file.name);
  const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  const p = c.get("principal");
  const out = await run(c, async (db) => {
    const t = (await db.query<{ channel_kind: string }>("SELECT channel_kind FROM templates WHERE id = $1", [c.req.param("id")])).rows[0];
    if (!t) throw notFound("Template");
    return addVersion(db, c.req.param("id"), t.channel_kind, versionBody.parse({
      subject: str("subject") || (/<title>([^<]*)<\/title>/i.exec(text)?.[1] ?? ""), bodyHtml: isHtml ? text : "", bodyText: isHtml ? str("bodyText") : text, origin: "upload", branding: { filename: file.name },
    }), p.kind === "user" ? p.id : null);
  });
  return c.json(out, 201);
});

define(comms, { method: "post", path: "/templates/{id}/versions/{version}/publish", tag: TAG, summary: "Publish a version; the previous published one is retired", permission: "templates:write", params: z.object({ id: zUuid, version: z.coerce.number().int() }) }, async (c, i) => {
  await run(c, async (db) => {
    const v = (await db.query<{ id: string; state: string }>("SELECT id, state FROM template_versions WHERE template_id = $1 AND version = $2 FOR UPDATE", [i.params.id, i.params.version])).rows[0];
    if (!v) throw notFound("Template version");
    if (v.state === "published") throw conflict("Already published", "already_published");
    await db.query("UPDATE template_versions SET state = 'retired' WHERE template_id = $1 AND state = 'published'", [i.params.id]);
    await db.query("UPDATE template_versions SET state = 'published' WHERE id = $1", [v.id]);
    await db.query("SELECT audit_event('template.publish', 'template', $1, $2::jsonb)", [i.params.id, JSON.stringify({ version: i.params.version })]);
  });
  return c.json({ ok: true });
});

define(comms, { method: "post", path: "/templates/{id}/versions/{version}/preview", tag: TAG, summary: "Render a version with sample data", permission: "templates:read", params: z.object({ id: zUuid, version: z.coerce.number().int() }), body: z.object({ data: zJson.default({}) }) }, async (c, i) => {
  const v = (await run(c, (db) => db.query("SELECT subject, body_html, body_text, variables FROM template_versions WHERE template_id = $1 AND version = $2", [i.params.id, i.params.version]))).rows[0];
  if (!v) throw notFound("Template version");
  const rendered = previewTemplate({ subject: v.subject, bodyHtml: v.body_html, bodyText: v.body_text }, i.body.data);
  const missing = (v.variables as string[]).filter((name) => name.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), i.body.data) === undefined);
  return c.json({ ...rendered, variables: v.variables, missing });
});

// ───────────── messages ─────────────
const MSG_COLS = "m.id, m.channel_kind, m.to_address, m.subject, m.status, m.attempts, m.error, m.provider_id, m.entity_type, m.entity_id, m.execution_id, m.created_at, m.sent_at, m.next_attempt_at";

define(comms, {
  method: "get", path: "/messages", tag: TAG, summary: "Sent and queued messages", permission: "messages:read",
  query: z.object({ status: z.string().optional(), channel_kind: KIND.optional(), entity_type: z.string().optional(), entity_id: zUuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }),
}, async (c, i) => {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (i.query.status) add("m.status = ANY(string_to_array(?, ','))", i.query.status);
  if (i.query.channel_kind) add("m.channel_kind = ?", i.query.channel_kind);
  if (i.query.entity_type) add("m.entity_type = ?", i.query.entity_type);
  if (i.query.entity_id) add("m.entity_id = ?", i.query.entity_id);
  const out = await run(c, async (db) => {
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const items = await db.query(`SELECT ${MSG_COLS} FROM messages m ${w} ORDER BY m.created_at DESC LIMIT ${i.query.limit} OFFSET ${i.query.offset}`, params);
    const stats = await db.query("SELECT status, count(*)::int AS n FROM messages GROUP BY status");
    return { items: items.rows, stats: Object.fromEntries(stats.rows.map((r) => [r.status, r.n])) };
  });
  return c.json(out);
});

define(comms, { method: "get", path: "/messages/{id}", tag: TAG, summary: "One message with its body", permission: "messages:read", params: z.object({ id: zUuid }) }, async (c, i) => {
  const r = (await run(c, (db) => db.query(`SELECT ${MSG_COLS}, m.body, m.html, m.channel_id, m.template_version_id FROM messages m WHERE m.id = $1`, [i.params.id]))).rows[0];
  if (!r) throw notFound("Message");
  return c.json(r);
});

define(comms, { method: "post", path: "/messages/{id}/retry", tag: TAG, summary: "Send a failed message again", permission: "messages:send", params: z.object({ id: zUuid }) }, async (c, i) => {
  const r = await run(c, (db) => db.query("UPDATE messages SET status = 'queued', attempts = 0, error = NULL, next_attempt_at = now() WHERE id = $1 AND status IN ('failed', 'bounced') RETURNING id", [i.params.id]));
  if (!r.rows[0]) throw conflict("Only failed messages can be retried", "not_failed");
  return c.json({ ok: true });
});

define(comms, { method: "post", path: "/messages/{id}/cancel", tag: TAG, summary: "Cancel a queued message", permission: "messages:send", params: z.object({ id: zUuid }) }, async (c, i) => {
  const r = await run(c, (db) => db.query("UPDATE messages SET status = 'failed', error = 'cancelled by user' WHERE id = $1 AND status = 'queued' RETURNING id", [i.params.id]));
  if (!r.rows[0]) throw conflict("Only queued messages can be cancelled", "not_queued");
  return c.json({ ok: true });
});

define(comms, {
  method: "post", path: "/messages", tag: TAG, summary: "Send a message manually (queued; the dispatcher delivers it through the delegation's channel)", permission: "messages:send", status: 201,
  body: z.object({
    channel: KIND, to: z.string().min(3).max(320), subject: z.string().max(300).optional(), body: z.string().max(100_000).optional(), templateKey: z.string().optional(), variables: zJson.default({}),
    delegationId: zUuid.nullable().optional(), entityType: z.string().optional(), entityId: zUuid.optional(),
  }).refine((b) => b.body || b.templateKey, "Provide body or templateKey"),
}, async (c, i) => {
  const b = i.body;
  const out = await run(c, async (db) => {
    let subject = b.subject ?? null;
    let body = b.body ?? "";
    let tv: string | null = null;
    let html = false;
    if (b.templateKey) {
      const t = (await db.query("SELECT v.id, v.subject, v.body_html, v.body_text FROM templates t JOIN template_versions v ON v.template_id = t.id AND v.state = 'published' WHERE t.key = $1 AND t.channel_kind = $2", [b.templateKey, b.channel])).rows[0];
      if (!t) throw new HttpError(422, `Template "${b.templateKey}" has no published version for ${b.channel}`, "template_not_found");
      const r = previewTemplate({ subject: t.subject, bodyHtml: t.body_html, bodyText: t.body_text }, b.variables);
      tv = t.id;
      subject = r.subject;
      html = b.channel === "email" && Boolean(t.body_html);
      body = html ? r.html : r.text || r.html;
    }
    const ch = (await db.query("SELECT id FROM channels WHERE kind = $1 AND enabled AND (delegation_id = $2 OR delegation_id IS NULL) ORDER BY delegation_id NULLS LAST LIMIT 1", [b.channel, b.delegationId ?? null])).rows[0];
    const m = (await db.query(
      "INSERT INTO messages (channel_id, channel_kind, template_version_id, to_address, subject, body, html, entity_type, entity_id, delegation_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, status",
      [ch?.id ?? null, b.channel, tv, b.to, subject, body, html, b.entityType ?? null, b.entityId ?? null, b.delegationId ?? null],
    )).rows[0];
    await db.query("SELECT pg_notify('orq_outbox', 'message')");
    return { id: m.id, status: m.status, channelConfigured: Boolean(ch) };
  });
  return c.json(out, 201);
});

// ───────────── consents (RGPD) ─────────────
define(comms, {
  method: "post", path: "/customers/{id}/consent", tag: TAG, summary: "Record a customer's consent or withdrawal for communications", permission: "customers:write", params: z.object({ id: zUuid }),
  body: z.object({ purpose: z.string().default("communications"), granted: z.boolean(), source: z.string().default("manual") }),
}, async (c, i) => {
  await run(c, async (db) => {
    const r = await db.query("UPDATE customers SET consent_comms = $2 WHERE id = $1 AND anonymized_at IS NULL RETURNING id", [i.params.id, i.body.granted]);
    if (!r.rows[0]) throw notFound("Customer");
    await db.query("INSERT INTO consents (subject_type, subject_id, purpose, granted, source) VALUES ('customer', $1, $2, $3, $4)", [i.params.id, i.body.purpose, i.body.granted, i.body.source]);
    if (!i.body.granted) await db.query("UPDATE messages SET status = 'failed', error = 'consent withdrawn' WHERE entity_type = 'customer' AND entity_id = $1 AND status = 'queued'", [i.params.id]);
  });
  return c.json({ ok: true });
});

define(comms, { method: "get", path: "/customers/{id}/consents", tag: TAG, summary: "Consent history of a customer", permission: "customers:read", params: z.object({ id: zUuid }) }, async (c, i) => {
  const r = await run(c, (db) => db.query("SELECT purpose, granted, source, at FROM consents WHERE subject_type = 'customer' AND subject_id = $1 ORDER BY at DESC", [i.params.id]));
  return c.json({ items: r.rows });
});
