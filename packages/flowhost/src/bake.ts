import type { CompiledDefinition } from "@orchestrador/engine";

import type { Tx } from "./types.js";

export type BakedRefs = { rule_sets: Record<string, number>; missing: string[] };

/**
 * Pins referenced rule sets and decision tables into the node configuration (`config.__resolved`) so that the
 * interpreter, which must stay pure, never touches the database and a running execution can never see a rule
 * change halfway (ORF-013). Published flows are baked at publish time; simulations bake the latest draft.
 */
export async function bakeRefs(db: Tx, definition: CompiledDefinition, opts: { allowDraft?: boolean } = {}): Promise<{ definition: CompiledDefinition; refs: BakedRefs }> {
  const refs: BakedRefs = { rule_sets: {}, missing: [] };
  const cache = new Map<string, { version: number; definition: unknown } | null>();

  async function load(key: string) {
    if (cache.has(key)) return cache.get(key)!;
    const states = opts.allowDraft ? ["published", "draft"] : ["published"];
    const r = await db.query<{ version: number; definition: unknown }>(
      `SELECT v.version, v.definition FROM rule_set_versions v JOIN rule_sets s ON s.id = v.rule_set_id
       WHERE s.key = $1 AND v.state = ANY($2::text[])
       ORDER BY (v.state = 'published') DESC, v.version DESC LIMIT 1`,
      [key, states],
    );
    const row = r.rows[0] ?? null;
    cache.set(key, row);
    return row;
  }

  const nodes = [];
  for (const node of definition.nodes) {
    const ref = node.type === "flow.rule" ? node.config.ruleSet : node.type === "flow.decision-table" ? node.config.table : undefined;
    if (typeof ref === "string" && ref.trim() !== "") {
      const key = ref.trim();
      const found = await load(key);
      if (!found) {
        refs.missing.push(key);
        nodes.push(node);
        continue;
      }
      refs.rule_sets[key] = found.version;
      nodes.push({ ...node, config: { ...node.config, __resolved: found.definition } });
    } else {
      nodes.push(node);
    }
  }
  return { definition: { ...definition, nodes }, refs };
}
