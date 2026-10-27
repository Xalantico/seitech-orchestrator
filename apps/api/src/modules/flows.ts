import { OpenAPIHono } from "@hono/zod-openapi";
import { bpmnToDiagram, diagramToBpmn, BpmnImportError } from "@orchestrador/bpmn";
import { checkDiagram, contentHash, countIssues, createFlow, insertDraft, publishVersion, validateCron } from "@orchestrador/flowhost";
import { getDiagramGraph } from "@orchestrador/shared";
import { randomBytes } from "node:crypto";

import { run, type Tx } from "../lib/db.js";
import { HttpError, notFound } from "../lib/errors.js";
import { can } from "../lib/principal.js";
import { define, z } from "../lib/route.js";
import type { AppEnv } from "../lib/types.js";
import { startExecution } from "../lib/engine.js";

export const flows = new OpenAPIHono<AppEnv>();
const TAG = "Flows";
const zFlowRef = z.object({ id: z.string().min(1) });
const zVersion = z.object({ id: z.string().min(1), version: z.coerce.number().int().positive() });
const key = z.string().regex(/^[a-z][a-z0-9_.-]{1,80}$/, "lowercase letters, digits, . _ -");
const FLOW_TYPES = ["back_office", "technical", "customer", "integration"] as const;
const diagramSchema = z.record(z.unknown());

const userIdOf = (c: { get(k: "principal"): { kind: string; id: string } | undefined }) => {
  const p = c.get("principal");
  return p?.kind === "user" ? p.id : null;
};

/** Minimal diagram a new flow starts with: trigger → end. */
const starterDiagram = (name: string) => ({
  name,
  nodes: [
    { id: "start", type: "node", position: { x: 0, y: 0 }, data: { type: "flow.trigger", icon: "Lightning", isStartNode: true, properties: { label: "Inicio" } } },
    { id: "end", type: "node", position: { x: 0, y: 160 }, data: { type: "flow.end", icon: "FlagCheckered", properties: { label: "Fin", status: "completed" } } },
  ],
  edges: [{ id: "start-end", source: "start", target: "end" }],
});

async function flowOf(db: Tx, ref: string) {
  const r = await db.query<{ id: string; key: string; name: string; archived_at: Date | null; published_version_id: string | null }>(
    "SELECT id, key, name, archived_at, published_version_id FROM flows WHERE id::text = $1 OR key = $1",
    [ref],
  );
  if (!r.rows[0]) throw notFound("Flow");
  return r.rows[0];
}

async function versionOf(db: Tx, flowId: string, version: number, lock = false) {
  const r = await db.query<{ id: string; flow_id: string; version: number; state: string; diagram: unknown; created_by: string | null }>(
    `SELECT id, flow_id, version, state, diagram, created_by FROM flow_versions WHERE flow_id = $1 AND version = $2 ${lock ? "FOR UPDATE" : ""}`,
    [flowId, version],
  );
  if (!r.rows[0]) throw notFound("Version");
  return r.rows[0];
}

// ───────────── library ─────────────
define(flows, { method: "get", path: "/flows", tag: TAG, summary: "Flow library", permission: "flows:read", query: z.object({
  q: z.string().optional(), type: z.enum(FLOW_TYPES).optional(), tag: z.string().optional(), archived: z.enum(["true", "false"]).default("false"),
  published: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }) }, async (c, i) => {
  const q = i.query;
  const where: string[] = [q.archived === "true" ? "f.archived_at IS NOT NULL" : "f.archived_at IS NULL"];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (q.q) add("(f.key ILIKE '%' || ? || '%' OR f.name ILIKE '%' || ? || '%' OR f.description ILIKE '%' || ? || '%')".replaceAll("?", `$${params.length + 1}`), q.q);
  if (q.type) add("f.flow_type = ?", q.type);
  if (q.tag) add("? = ANY(f.tags)", q.tag);
  if (q.published) where.push(q.published === "true" ? "f.published_version_id IS NOT NULL" : "f.published_version_id IS NULL");
  const out = await run(c, async (db) => {
    const list = await db.query(
      `SELECT f.id, f.key, f.name, f.description, f.flow_type, f.tags, f.delegation_id, f.copied_from, f.archived_at, f.created_at, f.updated_at,
              pv.version AS published_version, pv.published_at,
              (SELECT max(version) FROM flow_versions WHERE flow_id = f.id) AS latest_version,
              (SELECT state FROM flow_versions WHERE flow_id = f.id ORDER BY version DESC LIMIT 1) AS latest_state,
              (SELECT count(*)::int FROM flow_triggers WHERE flow_id = f.id AND enabled) AS triggers,
              (SELECT count(*)::int FROM executions e WHERE e.flow_id = f.id AND e.status IN ('running', 'waiting') AND NOT e.simulated) AS running
       FROM flows f LEFT JOIN flow_versions pv ON pv.id = f.published_version_id
       WHERE ${where.join(" AND ")} ORDER BY f.name LIMIT ${q.limit} OFFSET ${q.offset}`,
      params,
    );
    const total = await db.query(`SELECT count(*)::int AS n FROM flows f WHERE ${where.join(" AND ")}`, params);
    const tags = await db.query<{ tag: string; n: number }>("SELECT tag, count(*)::int AS n FROM flows f, unnest(f.tags) AS tag WHERE f.archived_at IS NULL GROUP BY tag ORDER BY tag");
    return { items: list.rows, total: total.rows[0]?.n ?? 0, tags: tags.rows };
  });
  return c.json(out);
});

define(flows, { method: "post", path: "/flows", tag: TAG, summary: "Create a flow with a first draft", status: 201, permission: "flows:write", body: z.object({
  key, name: z.string().min(1).max(200), description: z.string().max(2000).default(""), flowType: z.enum(FLOW_TYPES).default("back_office"),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]), delegationId: z.string().uuid().nullable().optional(), diagram: diagramSchema.optional() }) }, async (c, i) => {
  const b = i.body;
  const out = await run(c, async (db) => {
    const created = await createFlow(db, { key: b.key, name: b.name, description: b.description, flowType: b.flowType, tags: b.tags, delegationId: b.delegationId ?? null, diagram: b.diagram ?? starterDiagram(b.name), userId: userIdOf(c) });
    return created;
  });
  return c.json(out, 201);
});

define(flows, { method: "post", path: "/flows/validate", tag: TAG, summary: "Live validation of a diagram (no saving)", description: "Every structural and reference problem at once, each tied to a node or edge so the editor can highlight it.", permission: "flows:read", body: z.object({ diagram: z.unknown(), flow: z.string().optional() }) }, async (c, i) => {
  const out = await run(c, async (db) => {
    const ref = i.body.flow ? await db.query<{ id: string; key: string }>("SELECT id, key FROM flows WHERE id::text = $1 OR key = $1", [i.body.flow]) : null;
    const flow = ref?.rows[0] ?? { id: null, key: "adhoc" };
    const checked = await checkDiagram(db, i.body.diagram, flow, { allowDraftRefs: true });
    return { valid: checked.definition !== null, ...countIssues(checked.issues), issues: checked.issues, refs: checked.refs };
  });
  return c.json(out);
});

define(flows, { method: "post", path: "/flows/import-bpmn", tag: TAG, summary: "Create a flow (or a new draft) from BPMN 2.0 XML", status: 201, permission: "flows:write", body: z.object({
  xml: z.string().min(20), key: key.optional(), name: z.string().min(1).max(200).optional(), flow: z.string().optional() }) }, async (c, i) => {
  let imported;
  try {
    imported = bpmnToDiagram(i.body.xml);
  } catch (error) {
    if (error instanceof BpmnImportError) throw new HttpError(422, error.message, "invalid_bpmn");
    throw error;
  }
  const out = await run(c, async (db) => {
    if (i.body.flow) {
      const f = await flowOf(db, i.body.flow);
      const next = ((await db.query<{ v: number | null }>("SELECT max(version) AS v FROM flow_versions WHERE flow_id = $1", [f.id])).rows[0]?.v ?? 0) + 1;
      await assertNoOpenDraft(db, f.id);
      const versionId = await insertDraft(db, f.id, next, imported.diagram, userIdOf(c), "Imported from BPMN");
      return { flowId: f.id, versionId, version: next };
    }
    if (!i.body.key) throw new HttpError(400, "Provide a key for the new flow", "bad_request");
    const name = i.body.name ?? imported.diagram.name;
    const created = await createFlow(db, { key: i.body.key, name, diagram: imported.diagram, userId: userIdOf(c), changeNote: "Imported from BPMN" });
    return { ...created, version: 1 };
  });
  return c.json({ ...out, warnings: imported.warnings, native: imported.native }, 201);
});

// ───────────── one flow ─────────────
define(flows, { method: "get", path: "/flows/{id}", tag: TAG, summary: "Flow with versions and triggers", permission: "flows:read", params: zFlowRef }, async (c, i) => {
  const out = await run(c, async (db) => {
    const f = (await db.query("SELECT * FROM flows WHERE id::text = $1 OR key = $1", [i.params.id])).rows[0];
    if (!f) return null;
    const versions = (await db.query(
      `SELECT v.id, v.version, v.state, v.change_note, v.content_hash, v.created_at, v.updated_at, v.published_at,
              cu.display_name AS created_by_name, pu.display_name AS published_by_name,
              (SELECT count(*)::int FROM jsonb_array_elements(v.validation) x WHERE x->>'severity' = 'error') AS errors,
              (SELECT count(*)::int FROM jsonb_array_elements(v.validation) x WHERE x->>'severity' = 'warning') AS warnings,
              (SELECT count(*)::int FROM executions e WHERE e.flow_version_id = v.id AND NOT e.simulated) AS executions
       FROM flow_versions v LEFT JOIN users cu ON cu.id = v.created_by LEFT JOIN users pu ON pu.id = v.published_by
       WHERE v.flow_id = $1 ORDER BY v.version DESC`, [f.id])).rows;
    const triggers = (await db.query("SELECT * FROM flow_triggers WHERE flow_id = $1 ORDER BY created_at", [f.id])).rows;
    return { ...f, versions, triggers };
  });
  if (!out) throw notFound("Flow");
  return c.json(out);
});

define(flows, { method: "patch", path: "/flows/{id}", tag: TAG, summary: "Edit flow metadata", permission: "flows:write", params: zFlowRef, body: z.object({
  name: z.string().min(1).max(200).optional(), description: z.string().max(2000).optional(), flowType: z.enum(FLOW_TYPES).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(), delegationId: z.string().uuid().nullable().optional() }) }, async (c, i) => {
  const b = i.body;
  const row = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const r = await db.query(
      `UPDATE flows SET name = coalesce($2, name), description = coalesce($3, description), flow_type = coalesce($4, flow_type), tags = coalesce($5, tags),
                        delegation_id = CASE WHEN $6::boolean THEN $7::uuid ELSE delegation_id END, updated_at = now() WHERE id = $1 RETURNING *`,
      [f.id, b.name ?? null, b.description ?? null, b.flowType ?? null, b.tags ?? null, b.delegationId !== undefined, b.delegationId ?? null]);
    return r.rows[0];
  });
  return c.json(row);
});

define(flows, { method: "delete", path: "/flows/{id}", tag: TAG, summary: "Archive a flow (it stops accepting new executions)", permission: "flows:publish", params: zFlowRef }, async (c, i) => {
  await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    await db.query("UPDATE flows SET archived_at = now(), updated_at = now() WHERE id = $1", [f.id]);
    await db.query("UPDATE flow_triggers SET enabled = false WHERE id IN (SELECT id FROM flow_triggers WHERE flow_id = $1)", [f.id]);
  });
  return c.json({ ok: true });
});

define(flows, { method: "post", path: "/flows/{id}/restore", tag: TAG, summary: "Restore an archived flow", permission: "flows:publish", params: zFlowRef }, async (c, i) => {
  await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    await db.query("UPDATE flows SET archived_at = NULL, updated_at = now() WHERE id = $1", [f.id]);
  });
  return c.json({ ok: true });
});

define(flows, { method: "post", path: "/flows/{id}/copy", tag: TAG, summary: "Copy a flow (latest version becomes the first draft of the copy)", status: 201, permission: "flows:write", params: zFlowRef, body: z.object({ key, name: z.string().min(1).max(200) }) }, async (c, i) => {
  const out = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const src = (await db.query<{ diagram: unknown }>("SELECT diagram FROM flow_versions WHERE flow_id = $1 ORDER BY (state = 'published') DESC, version DESC LIMIT 1", [f.id])).rows[0];
    if (!src) throw notFound("Version");
    const meta = (await db.query<{ description: string; flow_type: string; tags: string[]; delegation_id: string | null }>("SELECT description, flow_type, tags, delegation_id FROM flows WHERE id = $1", [f.id])).rows[0]!;
    return createFlow(db, { key: i.body.key, name: i.body.name, description: meta.description, flowType: meta.flow_type, tags: meta.tags, delegationId: meta.delegation_id, diagram: { ...(src.diagram as object), name: i.body.name }, userId: userIdOf(c), copiedFrom: f.id, changeNote: `Copy of ${f.name}` });
  });
  return c.json(out, 201);
});

// ───────────── versions ─────────────
async function assertNoOpenDraft(db: Tx, flowId: string) {
  const open = await db.query("SELECT version, state FROM flow_versions WHERE flow_id = $1 AND state IN ('draft', 'in_review', 'approved', 'rejected') LIMIT 1", [flowId]);
  if (open.rows[0]) throw new HttpError(409, `Version ${open.rows[0].version} is still ${open.rows[0].state}: publish or discard it before starting another`, "open_version");
}

define(flows, { method: "get", path: "/flows/{id}/versions/{version}", tag: TAG, summary: "A version with its diagram, compiled definition and validation", permission: "flows:read", params: zVersion }, async (c, i) => {
  const out = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const v = (await db.query("SELECT * FROM flow_versions WHERE flow_id = $1 AND version = $2", [f.id, i.params.version])).rows[0];
    if (!v) throw notFound("Version");
    const approvals = (await db.query(
      `SELECT a.id, a.decision, a.comment, a.created_at, a.decided_at, ru.display_name AS requested_by_name, du.display_name AS decided_by_name
       FROM flow_approvals a LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by WHERE a.flow_version_id = $1 ORDER BY a.created_at`, [v.id])).rows;
    return { flow: { id: f.id, key: f.key, name: f.name }, ...v, approvals };
  });
  return c.json(out);
});

define(flows, { method: "post", path: "/flows/{id}/versions", tag: TAG, summary: "Start a new draft from the published (or a given) version", status: 201, permission: "flows:write", params: zFlowRef, body: z.object({ from: z.number().int().positive().optional(), changeNote: z.string().max(500).default("") }) }, async (c, i) => {
  const out = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    await db.query("SELECT 1 FROM flows WHERE id = $1 FOR UPDATE", [f.id]);
    await assertNoOpenDraft(db, f.id);
    const src = (await db.query<{ diagram: unknown }>(
      `SELECT diagram FROM flow_versions WHERE flow_id = $1 ${i.body.from ? "AND version = $2" : ""} ORDER BY (state = 'published') DESC, version DESC LIMIT 1`,
      i.body.from ? [f.id, i.body.from] : [f.id])).rows[0];
    if (!src) throw notFound("Version");
    const next = ((await db.query<{ v: number }>("SELECT max(version) AS v FROM flow_versions WHERE flow_id = $1", [f.id])).rows[0]?.v ?? 0) + 1;
    const versionId = await insertDraft(db, f.id, next, src.diagram, userIdOf(c), i.body.changeNote);
    return { versionId, version: next };
  });
  return c.json(out, 201);
});

define(flows, { method: "put", path: "/flows/{id}/versions/{version}", tag: TAG, summary: "Save the diagram of a draft (validates on save)", permission: "flows:write", params: zVersion, body: z.object({ diagram: diagramSchema, changeNote: z.string().max(500).optional() }) }, async (c, i) => {
  const out = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const v = await versionOf(db, f.id, i.params.version, true);
    if (!["draft", "rejected"].includes(v.state)) throw new HttpError(409, `A ${v.state.replace("_", " ")} version cannot be edited: start a new draft`, "not_editable");
    const checked = await checkDiagram(db, i.body.diagram, f, { allowDraftRefs: true });
    await db.query(
      `UPDATE flow_versions SET diagram = $2::jsonb, validation = $3::jsonb, content_hash = $4, state = 'draft', definition = NULL, change_note = coalesce($5, change_note), updated_at = now() WHERE id = $1`,
      [v.id, JSON.stringify(i.body.diagram), JSON.stringify(checked.issues), contentHash(i.body.diagram), i.body.changeNote ?? null]);
    await db.query("UPDATE flows SET updated_at = now() WHERE id = $1", [f.id]);
    return { version: v.version, state: "draft", valid: checked.definition !== null, ...countIssues(checked.issues), issues: checked.issues };
  });
  return c.json(out);
});

define(flows, { method: "delete", path: "/flows/{id}/versions/{version}", tag: TAG, summary: "Discard an unpublished version", permission: "flows:write", params: zVersion }, async (c, i) => {
  await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const v = await versionOf(db, f.id, i.params.version, true);
    if (["published", "retired"].includes(v.state)) throw new HttpError(409, "Published and retired versions are kept for the audit trail", "not_discardable");
    const used = await db.query("SELECT 1 FROM executions WHERE flow_version_id = $1 LIMIT 1", [v.id]);
    if (used.rowCount) throw new HttpError(409, "Executions already reference this version", "in_use");
    await db.query("DELETE FROM flow_versions WHERE id = $1", [v.id]);
  });
  return c.json({ ok: true });
});

define(flows, { method: "get", path: "/flows/{id}/versions/{version}/compare", tag: TAG, summary: "What changed between two versions (for review)", permission: "flows:read", params: zVersion, query: z.object({ to: z.coerce.number().int().positive() }) }, async (c, i) => {
  const out = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const [a, b] = await Promise.all([versionOf(db, f.id, i.params.version), versionOf(db, f.id, i.query.to)]);
    return diffDiagrams(a.diagram, b.diagram);
  });
  return c.json({ from: i.params.version, to: i.query.to, ...out });
});

export function diffDiagrams(before: unknown, after: unknown) {
  const g1 = getDiagramGraph(before);
  const g2 = getDiagramGraph(after);
  const sig = (n: { data?: { type?: string; properties?: unknown } }) => contentHash({ t: n.data?.type, p: n.data?.properties ?? {} });
  const m1 = new Map(g1.nodes.map((n) => [n.id, n]));
  const m2 = new Map(g2.nodes.map((n) => [n.id, n]));
  const label = (n: { id: string; data?: { type?: string; properties?: Record<string, unknown> } }) => String(n.data?.properties?.label ?? n.data?.type ?? n.id);
  const nodes = {
    added: g2.nodes.filter((n) => !m1.has(n.id)).map((n) => ({ id: n.id, type: n.data?.type, label: label(n) })),
    removed: g1.nodes.filter((n) => !m2.has(n.id)).map((n) => ({ id: n.id, type: n.data?.type, label: label(n) })),
    changed: g2.nodes.filter((n) => m1.has(n.id) && sig(m1.get(n.id)!) !== sig(n)).map((n) => {
      const p1 = (m1.get(n.id)!.data?.properties ?? {}) as Record<string, unknown>;
      const p2 = (n.data?.properties ?? {}) as Record<string, unknown>;
      const fields = [...new Set([...Object.keys(p1), ...Object.keys(p2)])].filter((k) => JSON.stringify(p1[k]) !== JSON.stringify(p2[k]));
      return { id: n.id, type: n.data?.type, label: label(n), fields };
    }),
  };
  const ek = (e: { source: string; target: string; sourceHandle?: string | null }) => `${e.source}|${e.sourceHandle ?? ""}|${e.target}`;
  const k1 = new Set(g1.edges.map(ek));
  const k2 = new Set(g2.edges.map(ek));
  const edges = { added: g2.edges.filter((e) => !k1.has(ek(e))).map(ek), removed: g1.edges.filter((e) => !k2.has(ek(e))).map(ek) };
  return { nodes, edges, identical: nodes.added.length + nodes.removed.length + nodes.changed.length + edges.added.length + edges.removed.length === 0 };
}

// ───────────── review & publication ─────────────
define(flows, { method: "post", path: "/flows/{id}/versions/{version}/submit", tag: TAG, summary: "Send a draft for review", permission: "flows:write", params: zVersion, body: z.object({ comment: z.string().max(1000).default("") }) }, async (c, i) => {
  const out = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const v = await versionOf(db, f.id, i.params.version, true);
    if (v.state !== "draft") throw new HttpError(409, `Only drafts can be submitted (this one is ${v.state})`, "bad_state");
    const checked = await checkDiagram(db, v.diagram, f);
    if (!checked.definition) throw new HttpError(422, "Fix the errors before sending the flow for review", "invalid_flow", { issues: checked.issues });
    await db.query("UPDATE flow_versions SET state = 'in_review', validation = $2::jsonb, updated_at = now() WHERE id = $1", [v.id, JSON.stringify(checked.issues)]);
    await db.query("INSERT INTO flow_approvals (flow_version_id, requested_by, comment) VALUES ($1, $2, $3)", [v.id, userIdOf(c), i.body.comment]);
    return { version: v.version, state: "in_review", ...countIssues(checked.issues) };
  });
  return c.json(out);
});

define(flows, { method: "post", path: "/flows/{id}/versions/{version}/withdraw", tag: TAG, summary: "Pull a version back from review", permission: "flows:write", params: zVersion }, async (c, i) => {
  await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const v = await versionOf(db, f.id, i.params.version, true);
    if (!["in_review", "approved"].includes(v.state)) throw new HttpError(409, "Only versions in review or approved can be withdrawn", "bad_state");
    await db.query("UPDATE flow_versions SET state = 'draft', updated_at = now() WHERE id = $1", [v.id]);
    await db.query("UPDATE flow_approvals SET decision = 'rejected', decided_at = now(), comment = comment || ' (withdrawn)' WHERE flow_version_id = $1 AND decision IS NULL", [v.id]);
  });
  return c.json({ ok: true });
});

for (const decision of ["approve", "reject"] as const) {
  define(flows, { method: "post", path: `/flows/{id}/versions/{version}/${decision}`, tag: TAG, summary: `${decision === "approve" ? "Approve" : "Reject"} a version in review`, description: "Four-eyes: the reviewer cannot be the person who requested the review.", permission: "flows:approve", params: zVersion, body: z.object({ comment: z.string().max(1000).default("") }) }, async (c, i) => {
    if (decision === "reject" && i.body.comment.trim().length === 0) throw new HttpError(400, "Say why the version is rejected", "comment_required");
    const me = userIdOf(c);
    const out = await run(c, async (db) => {
      const f = await flowOf(db, i.params.id);
      const v = await versionOf(db, f.id, i.params.version, true);
      if (v.state !== "in_review") throw new HttpError(409, `Only versions in review can be ${decision}d`, "bad_state");
      const pending = (await db.query<{ id: string; requested_by: string | null }>("SELECT id, requested_by FROM flow_approvals WHERE flow_version_id = $1 AND decision IS NULL ORDER BY created_at DESC LIMIT 1", [v.id])).rows[0];
      if (!pending) throw new HttpError(409, "There is no pending review request", "bad_state");
      if (pending.requested_by && pending.requested_by === me) throw new HttpError(403, "You cannot review your own request", "four_eyes");
      const state = decision === "approve" ? "approved" : "rejected";
      await db.query("UPDATE flow_approvals SET decision = $2, decided_by = $3, comment = $4, decided_at = now() WHERE id = $1", [pending.id, state, me, i.body.comment]);
      await db.query("UPDATE flow_versions SET state = $2, updated_at = now() WHERE id = $1", [v.id, state]);
      return { version: v.version, state };
    });
    return c.json(out);
  });
}

define(flows, { method: "post", path: "/flows/{id}/versions/{version}/publish", tag: TAG, summary: "Publish a version (hot: running executions are not affected)", permission: "flows:publish", params: zVersion, body: z.object({ skipApproval: z.boolean().default(false) }).default({}) }, async (c, i) => {
  const p = c.get("principal")!;
  if (i.body.skipApproval && !can(p, "system:admin")) throw new HttpError(403, "Only administrators can publish without approval", "forbidden");
  const out = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const result = await publishVersion(db, { flowId: f.id, version: i.params.version, userId: userIdOf(c), skipApproval: i.body.skipApproval });
    return { flow: f.key, ...result };
  });
  return c.json(out);
});

define(flows, { method: "post", path: "/flows/{id}/versions/{version}/rollback", tag: TAG, summary: "Make an older version live again", description: "Creates a new draft with the older diagram so the change goes through the same review as any other.", status: 201, permission: "flows:write", params: zVersion }, async (c, i) => {
  const out = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const v = await versionOf(db, f.id, i.params.version);
    await assertNoOpenDraft(db, f.id);
    const next = ((await db.query<{ v: number }>("SELECT max(version) AS v FROM flow_versions WHERE flow_id = $1", [f.id])).rows[0]?.v ?? 0) + 1;
    const versionId = await insertDraft(db, f.id, next, v.diagram, userIdOf(c), `Rollback to version ${v.version}`);
    return { versionId, version: next };
  });
  return c.json(out, 201);
});

// ───────────── simulation ─────────────
define(flows, { method: "post", path: "/flows/{id}/versions/{version}/simulate", tag: TAG, summary: "Simulate a version (isolated workers, no real side effects)", status: 202, permission: "flows:simulate", params: zVersion, body: z.object({
  input: z.record(z.unknown()).default({}), variables: z.record(z.unknown()).default({}), stepMode: z.boolean().default(false), entity: z.object({ type: z.string(), id: z.string().uuid() }).optional() }).default({}) }, async (c, i) => {
  const started = await startExecution({
    flow: i.params.id, version: i.params.version, triggerPayload: i.body.input, variables: i.body.variables, simulated: true, stepMode: i.body.stepMode,
    triggerKind: "simulation", entity: i.body.entity ?? null, userId: userIdOf(c),
  });
  return c.json(started, 202);
});

// ───────────── BPMN ─────────────
define(flows, { method: "get", path: "/flows/{id}/versions/{version}/bpmn", tag: TAG, summary: "Export a version as BPMN 2.0 XML", permission: "flows:read", params: zVersion }, async (c, i) => {
  const out = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const v = await versionOf(db, f.id, i.params.version);
    return { name: f.name, key: f.key, version: v.version, diagram: v.diagram };
  });
  const xml = diagramToBpmn(out.diagram, { name: out.name, processId: `Process_${out.key.replace(/[^A-Za-z0-9_]/g, "_")}` });
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${out.key}-v${out.version}.bpmn"` } });
});

// ───────────── triggers ─────────────
const triggerBody = z.object({
  kind: z.enum(["event", "webhook", "schedule", "entity_transition", "manual"]),
  name: z.string().max(120).default(""),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
});

function normalizeTrigger(kind: string, config: Record<string, unknown>): Record<string, unknown> {
  switch (kind) {
    case "event":
      if (typeof config.event !== "string" || !config.event.trim()) throw new HttpError(400, "An event trigger needs config.event (e.g. work_order.planned or work_order.*)", "bad_trigger");
      return config;
    case "entity_transition":
      if (typeof config.entityType !== "string") throw new HttpError(400, "A transition trigger needs config.entityType", "bad_trigger");
      return config;
    case "schedule": {
      if (typeof config.cron !== "string") throw new HttpError(400, "A schedule needs config.cron (5 fields, e.g. 0 7 * * 1-5)", "bad_trigger");
      const problem = validateCron(config.cron, typeof config.timezone === "string" ? config.timezone : "Europe/Madrid");
      if (problem) throw new HttpError(400, `Invalid cron expression: ${problem}`, "bad_trigger");
      return { timezone: "Europe/Madrid", ...config };
    }
    case "webhook":
      return { ...config, slug: typeof config.slug === "string" && config.slug ? config.slug : randomBytes(18).toString("base64url") };
    default:
      return config;
  }
}

define(flows, { method: "get", path: "/flows/{id}/triggers", tag: TAG, summary: "Triggers of a flow", permission: "flows:read", params: zFlowRef }, async (c, i) => {
  const rows = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    return (await db.query("SELECT * FROM flow_triggers WHERE flow_id = $1 ORDER BY created_at", [f.id])).rows;
  });
  return c.json({ items: rows });
});

define(flows, { method: "post", path: "/flows/{id}/triggers", tag: TAG, summary: "Add a trigger (event, schedule, entity transition, webhook)", status: 201, permission: "flows:write", params: zFlowRef, body: triggerBody }, async (c, i) => {
  const row = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const config = normalizeTrigger(i.body.kind, i.body.config);
    return (await db.query("INSERT INTO flow_triggers (flow_id, kind, name, config, enabled) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *", [f.id, i.body.kind, i.body.name, JSON.stringify(config), i.body.enabled])).rows[0];
  });
  return c.json(row, 201);
});

define(flows, { method: "patch", path: "/flows/{id}/triggers/{triggerId}", tag: TAG, summary: "Edit or pause a trigger", permission: "flows:write", params: z.object({ id: z.string().min(1), triggerId: z.string().uuid() }), body: z.object({
  name: z.string().max(120).optional(), enabled: z.boolean().optional(), config: z.record(z.unknown()).optional() }) }, async (c, i) => {
  const row = await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const cur = (await db.query<{ kind: string }>("SELECT kind FROM flow_triggers WHERE id = $1 AND flow_id = $2", [i.params.triggerId, f.id])).rows[0];
    if (!cur) throw notFound("Trigger");
    const config = i.body.config ? normalizeTrigger(cur.kind, i.body.config) : null;
    return (await db.query(
      // A changed schedule is re-armed from "now" by the scheduler.
      `UPDATE flow_triggers SET name = coalesce($3, name), enabled = coalesce($4, enabled), config = coalesce($5::jsonb, config),
              next_run_at = CASE WHEN $5::jsonb IS NOT NULL OR $4 IS TRUE THEN NULL ELSE next_run_at END WHERE id = $1 AND flow_id = $2 RETURNING *`,
      [i.params.triggerId, f.id, i.body.name ?? null, i.body.enabled ?? null, config ? JSON.stringify(config) : null])).rows[0];
  });
  return c.json(row);
});

define(flows, { method: "delete", path: "/flows/{id}/triggers/{triggerId}", tag: TAG, summary: "Remove a trigger", permission: "flows:write", params: z.object({ id: z.string().min(1), triggerId: z.string().uuid() }) }, async (c, i) => {
  await run(c, async (db) => {
    const f = await flowOf(db, i.params.id);
    const r = await db.query("DELETE FROM flow_triggers WHERE id = $1 AND flow_id = $2", [i.params.triggerId, f.id]);
    if (r.rowCount === 0) throw notFound("Trigger");
  });
  return c.json({ ok: true });
});
