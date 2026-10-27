import type { CompiledDefinition } from "@orchestrador/engine";
import { compileDiagram, type ValidationIssue } from "@orchestrador/shared";
import { createHash } from "node:crypto";

import { bakeRefs, type BakedRefs } from "./bake.js";
import { FlowError } from "./errors.js";
import type { Tx } from "./types.js";

export type CheckResult = { definition: CompiledDefinition | null; refs: BakedRefs; issues: ValidationIssue[] };

/** Stable hash of a diagram: identical content gives an identical hash regardless of key order. */
export function contentHash(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canon(value))).digest("hex");
}

/**
 * Everything the editor shows live and the publish gate enforces: structure (compiler) plus references that only the
 * database can answer (rule sets, sub-flows, forms, queues).
 */
export async function checkDiagram(db: Tx, diagram: unknown, flow: { id?: string | null; key: string }, opts: { allowDraftRefs?: boolean } = {}): Promise<CheckResult> {
  const compiled = compileDiagram(diagram, flow.id ?? flow.key);
  const issues = [...compiled.issues];
  const empty: BakedRefs = { rule_sets: {}, missing: [] };
  if (!compiled.definition) return { definition: null, refs: empty, issues };

  const baked = await bakeRefs(db, compiled.definition as unknown as CompiledDefinition, { allowDraft: opts.allowDraftRefs ?? false });
  const nodeLabel = (id: string) => baked.definition.nodes.find((n) => n.id === id)?.label ?? id;
  for (const node of baked.definition.nodes) {
    const key = node.type === "flow.rule" ? node.config.ruleSet : node.type === "flow.decision-table" ? node.config.table : undefined;
    if (typeof key === "string" && baked.refs.missing.includes(key.trim())) {
      issues.push({ severity: "error", code: "unknown_rule_set", nodeId: node.id, message: `${nodeLabel(node.id)} (${node.id}): there is no published rule set or table "${key}"` });
    }
    if ((node.type === "flow.rule" || node.type === "flow.decision-table") && !node.config.__resolved && !node.config.definition && !(typeof key === "string" && key.trim())) {
      issues.push({ severity: "error", code: "invalid_config", nodeId: node.id, message: `${nodeLabel(node.id)} (${node.id}): choose a rule set or define the rules inline` });
    }
    if (node.type === "flow.subprocess") {
      const ref = String(node.config.flowId ?? "").trim();
      if (ref) {
        if (ref === flow.key || ref === flow.id) {
          issues.push({ severity: "error", code: "recursive_subflow", nodeId: node.id, message: `${nodeLabel(node.id)} (${node.id}): a flow cannot call itself` });
        } else {
          const r = await db.query<{ published: boolean }>("SELECT published_version_id IS NOT NULL AS published FROM flows WHERE (id::text = $1 OR key = $1) AND archived_at IS NULL", [ref]);
          if (!r.rows[0]) issues.push({ severity: "error", code: "unknown_subflow", nodeId: node.id, message: `${nodeLabel(node.id)} (${node.id}): the flow "${ref}" does not exist` });
          else if (!r.rows[0].published) issues.push({ severity: "warning", code: "subflow_unpublished", nodeId: node.id, message: `${nodeLabel(node.id)} (${node.id}): the flow "${ref}" has no published version yet` });
        }
      }
    }
    const form = typeof node.config.formKey === "string" ? node.config.formKey.trim() : "";
    if (form) {
      const r = await db.query("SELECT 1 FROM forms WHERE key = $1", [form]);
      if (r.rowCount === 0) issues.push({ severity: "warning", code: "unknown_form", nodeId: node.id, message: `${nodeLabel(node.id)} (${node.id}): form "${form}" does not exist` });
    }
    const queue = typeof node.config.queue === "string" ? node.config.queue.trim() : "";
    if (queue && node.type.startsWith("human.") && !queue.includes("{{")) {
      const r = await db.query("SELECT 1 FROM queues WHERE key = $1 AND active", [queue]);
      if (r.rowCount === 0) issues.push({ severity: "warning", code: "unknown_queue", nodeId: node.id, message: `${nodeLabel(node.id)} (${node.id}): work queue "${queue}" does not exist or is inactive` });
    }
  }
  const hasErrors = issues.some((i) => i.severity === "error");
  return { definition: hasErrors ? null : baked.definition, refs: baked.refs, issues };
}

export const countIssues = (issues: ValidationIssue[]) => ({ errors: issues.filter((i) => i.severity === "error").length, warnings: issues.filter((i) => i.severity === "warning").length });

type VersionRow = { id: string; flow_id: string; version: number; state: string; diagram: unknown; created_by: string | null };

export async function requireApproval(db: Tx): Promise<boolean> {
  const r = await db.query<{ value: unknown }>("SELECT value FROM parameters WHERE key = 'flows.require_approval' AND delegation_id IS NULL");
  const v = r.rows[0]?.value;
  return v === undefined ? true : !(v === false || v === "false");
}

export type PublishResult = { versionId: string; version: number; previousVersion: number | null; inFlight: number; refs: BakedRefs; issues: ValidationIssue[] };

/**
 * Publishes a version: compiles, pins referenced rule sets, stores the compiled definition and swaps the flow's
 * published pointer in one transaction. "Hot" because nothing is stopped: executions already running keep the
 * definition they started with, new ones use this version immediately (ORF-013).
 */
export async function publishVersion(db: Tx, input: { flowId: string; version: number; userId?: string | null; skipApproval?: boolean }): Promise<PublishResult> {
  const flow = (await db.query<{ id: string; key: string; archived_at: Date | null; published_version_id: string | null }>("SELECT id, key, archived_at, published_version_id FROM flows WHERE id = $1 FOR UPDATE", [input.flowId])).rows[0];
  if (!flow) throw new FlowError(404, "Flow not found", "not_found");
  if (flow.archived_at) throw new FlowError(409, "The flow is archived", "archived");
  const v = (await db.query<VersionRow>("SELECT id, flow_id, version, state, diagram, created_by FROM flow_versions WHERE flow_id = $1 AND version = $2 FOR UPDATE", [input.flowId, input.version])).rows[0];
  if (!v) throw new FlowError(404, "Version not found", "not_found");
  if (v.state === "published") throw new FlowError(409, "This version is already published", "already_published");
  const needsApproval = !input.skipApproval && (await requireApproval(db));
  if (needsApproval ? v.state !== "approved" : !["approved", "draft"].includes(v.state)) {
    throw new FlowError(409, needsApproval ? "The version must be approved before it can be published" : `A ${v.state} version cannot be published`, "not_approved");
  }

  const checked = await checkDiagram(db, v.diagram, { id: flow.id, key: flow.key });
  if (!checked.definition) throw new FlowError(422, "The flow has errors and cannot be published", "invalid_flow", { issues: checked.issues });

  const previous = flow.published_version_id ? (await db.query<{ version: number }>("SELECT version FROM flow_versions WHERE id = $1", [flow.published_version_id])).rows[0] : undefined;
  await db.query("UPDATE flow_versions SET state = 'retired', updated_at = now() WHERE flow_id = $1 AND state = 'published'", [flow.id]);
  await db.query(
    `UPDATE flow_versions SET state = 'published', definition = $2::jsonb, refs = $3::jsonb, validation = $4::jsonb, content_hash = $5, published_by = $6, published_at = now(), updated_at = now()
     WHERE id = $1`,
    [v.id, JSON.stringify(checked.definition), JSON.stringify(checked.refs), JSON.stringify(checked.issues), contentHash(v.diagram), input.userId ?? null],
  );
  await db.query("UPDATE flows SET published_version_id = $2, updated_at = now() WHERE id = $1", [flow.id, v.id]);
  const inFlight = flow.published_version_id
    ? (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM executions WHERE flow_version_id = $1 AND status IN ('running', 'waiting', 'paused') AND NOT simulated", [flow.published_version_id])).rows[0]?.n ?? 0
    : 0;
  return { versionId: v.id, version: v.version, previousVersion: previous?.version ?? null, inFlight, refs: checked.refs, issues: checked.issues };
}

/** Creates a flow with a first draft: used by the API, imports, and the seed of process templates. */
export async function createFlow(
  db: Tx,
  input: { key: string; name: string; description?: string; flowType?: string; tags?: string[]; delegationId?: string | null; diagram: unknown; userId?: string | null; copiedFrom?: string | null; changeNote?: string },
): Promise<{ flowId: string; versionId: string }> {
  const flow = await db.query<{ id: string }>(
    `INSERT INTO flows (key, name, description, flow_type, tags, delegation_id, copied_from, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [input.key, input.name, input.description ?? "", input.flowType ?? "back_office", input.tags ?? [], input.delegationId ?? null, input.copiedFrom ?? null, input.userId ?? null],
  );
  const flowId = flow.rows[0]!.id;
  const versionId = await insertDraft(db, flowId, 1, input.diagram, input.userId ?? null, input.changeNote ?? "");
  return { flowId, versionId };
}

export async function insertDraft(db: Tx, flowId: string, version: number, diagram: unknown, userId: string | null, changeNote = ""): Promise<string> {
  const flow = (await db.query<{ key: string }>("SELECT key FROM flows WHERE id = $1", [flowId])).rows[0];
  const checked = await checkDiagram(db, diagram, { id: flowId, key: flow?.key ?? flowId }, { allowDraftRefs: true });
  const r = await db.query<{ id: string }>(
    `INSERT INTO flow_versions (flow_id, version, state, diagram, validation, content_hash, change_note, created_by) VALUES ($1, $2, 'draft', $3::jsonb, $4::jsonb, $5, $6, $7) RETURNING id`,
    [flowId, version, JSON.stringify(diagram), JSON.stringify(checked.issues), contentHash(diagram), changeNote, userId],
  );
  return r.rows[0]!.id;
}
