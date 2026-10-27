import type { Db } from "@orchestrador/connector-sdk";

import { CONNECTOR_DEFAULTS, MAPPING_DEFAULTS } from "./defaults.js";

export type SeedConnectorsOptions = {
  /** Where the simulators listen, e.g. `http://mock-systems:4010`. Connectors are created pointing at it. */
  baseUrl: string;
  /** Start them enabled (demo) or disabled (an operator reviews them first). */
  enabled?: boolean;
};

/**
 * Installs the connectors and their first mapping versions. Existing rows are never touched, so what an administrator
 * changed stays changed; running it on every start is safe.
 */
export async function seedConnectors(db: Db, options: SeedConnectorsOptions): Promise<{ connectors: string[]; mappings: string[] }> {
  const base = options.baseUrl.replace(/\/+$/, "");
  const connectors: string[] = [];
  for (const c of CONNECTOR_DEFAULTS) {
    const r = await db.query(
      `INSERT INTO connectors (key, name, system_kind, base_url, auth_type, credentials_ref, webhook_secret_ref, config, enabled, mode)
       VALUES ($1, $2, $3, $4, 'bearer', $5, $5, $6::jsonb, $7, 'mock') ON CONFLICT (key) DO NOTHING`,
      [c.key, c.name, c.kind, `${base}${c.path}`, `connectors/${c.key}`, JSON.stringify(c.config), options.enabled ?? true],
    );
    if (r.rowCount) connectors.push(c.key);
  }
  const mappings: string[] = [];
  for (const m of MAPPING_DEFAULTS) {
    const reg = await db.query<{ id: string }>(
      `INSERT INTO mapping_registry (key, connector_key, entity, direction, description) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING RETURNING id`,
      [m.key, m.connectorKey, m.entity, m.direction, m.description],
    );
    const id = reg.rows[0]?.id;
    if (!id) continue;
    await db.query("INSERT INTO mapping_versions (mapping_id, version, state, fields, change_note) VALUES ($1, 1, 'published', $2::jsonb, 'Versión inicial')", [id, JSON.stringify(m.fields)]);
    mappings.push(m.key);
  }
  return { connectors, mappings };
}
