import { createFlow, publishVersion } from "../lifecycle.js";
import type { Tx } from "../types.js";
import { SEED_TEMPLATES } from "./messages.js";
import { PROCESS_TEMPLATES } from "./templates.js";

const variablesOf = (...sources: string[]) => [...new Set(sources.flatMap((s) => [...s.matchAll(/\{\{\s*([\w.[\]-]+)\s*\}\}/g)].map((m) => m[1]!)))].sort();

export type SeedProcessResult = { templates: string[]; created: string[]; skipped: string[] };

/**
 * Installs the notification templates and the process templates (published, with their triggers).
 * Idempotent: anything that already exists is left alone, so administrators' edits are never overwritten.
 */
export async function seedProcessTemplates(db: Tx): Promise<SeedProcessResult> {
  const result: SeedProcessResult = { templates: [], created: [], skipped: [] };

  for (const t of SEED_TEMPLATES) {
    const row = await db.query<{ id: string }>(
      `INSERT INTO templates (key, name, channel_kind, description, locale) VALUES ($1, $2, $3, $4, 'es')
       ON CONFLICT (key) DO NOTHING RETURNING id`,
      [t.key, t.name, t.channel, t.description],
    );
    if (!row.rows[0]) continue;
    await db.query(
      `INSERT INTO template_versions (template_id, version, state, subject, body_html, body_text, variables, origin)
       VALUES ($1, 1, 'published', $2, $3, $4, $5, 'seed')`,
      [row.rows[0].id, t.subject, t.html ?? "", t.text, variablesOf(t.subject, t.text, t.html ?? "")],
    );
    result.templates.push(t.key);
  }

  for (const p of PROCESS_TEMPLATES) {
    const exists = await db.query("SELECT 1 FROM flows WHERE key = $1", [p.key]);
    if (exists.rows.length > 0) {
      result.skipped.push(p.key);
      continue;
    }
    const { flowId } = await createFlow(db, { key: p.key, name: p.name, description: p.description, flowType: "back_office", tags: ["plantilla", ...p.tags], diagram: p.diagram, changeNote: "Plantilla de proceso inicial" });
    await publishVersion(db, { flowId, version: 1, skipApproval: true });
    for (const [i, trigger] of p.triggers.entries()) {
      await db.query("INSERT INTO flow_triggers (flow_id, kind, config, name) VALUES ($1, $2, $3::jsonb, $4)", [flowId, trigger.kind, JSON.stringify(trigger.config), i === 0 ? p.name : `${p.name} (${i + 1})`]);
    }
    result.created.push(p.key);
  }
  return result;
}
