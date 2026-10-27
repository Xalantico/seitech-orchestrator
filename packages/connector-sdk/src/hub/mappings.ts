import { applyMapping, type MappingField, type MappingResult } from "../mapping.js";
import { permanent } from "../errors.js";
import type { Db } from "./db.js";

export type PublishedMapping = { key: string; version: number; direction: "inbound" | "outbound"; entity: string; fields: MappingField[] };

export async function loadPublishedMapping(db: Db, key: string): Promise<PublishedMapping> {
  const r = (await db.query<{ key: string; entity: string; direction: "inbound" | "outbound"; version: number; fields: MappingField[] }>(
    `SELECT m.key, m.entity, m.direction, v.version, v.fields FROM mapping_registry m JOIN mapping_versions v ON v.mapping_id = m.id AND v.state = 'published' WHERE m.key = $1`,
    [key],
  )).rows[0];
  if (!r) throw permanent("mapping_not_published", `Mapping "${key}" has no published version`);
  return r;
}

/** Applies a published mapping; a mapping that reports errors is a permanent failure (retrying cannot fix the data). */
export async function mapWith(db: Db, key: string, source: unknown, opts: { passthroughExtra?: boolean; passthroughFrom?: string } = {}): Promise<MappingResult & { mapping: PublishedMapping }> {
  const mapping = await loadPublishedMapping(db, key);
  const result = applyMapping(mapping.fields, source, { passthroughExtra: opts.passthroughExtra ?? true, ...(opts.passthroughFrom ? { passthroughFrom: opts.passthroughFrom } : {}) });
  if (result.errors.length > 0) {
    throw permanent("mapping_failed", `Mapping "${key}" v${mapping.version}: ${result.errors.map((e) => `${e.target}: ${e.message}`).join("; ")}`, { body: result.errors });
  }
  return { ...result, mapping };
}
