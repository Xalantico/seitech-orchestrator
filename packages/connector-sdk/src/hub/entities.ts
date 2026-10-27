import { permanent } from "../errors.js";
import type { Db } from "./db.js";

export const INBOUND_ENTITIES = ["customer", "site", "order", "technician", "qualification", "calibration"] as const;
export type InboundEntity = (typeof INBOUND_ENTITIES)[number];

export type UpsertResult = { entity: InboundEntity; id: string; created: boolean; events: { type: string; entityType: string; entityId: string; payload: Record<string, unknown> }[] };

type Data = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
const isObj = (v: unknown): v is Data => typeof v === "object" && v !== null && !Array.isArray(v);

async function byExternal(db: Db, entity: string, connectorKey: string, externalId: string | null): Promise<string | undefined> {
  if (!externalId) return undefined;
  return (await db.query<{ entity_id: string }>("SELECT entity_id FROM external_refs WHERE entity_type = $1 AND connector_key = $2 AND external_id = $3", [entity, connectorKey, externalId])).rows[0]?.entity_id;
}

async function link(db: Db, entity: string, id: string, connectorKey: string, externalId: string | null) {
  if (!externalId) return;
  await db.query(
    `INSERT INTO external_refs (entity_type, entity_id, connector_key, external_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (entity_type, entity_id, connector_key) DO UPDATE SET external_id = EXCLUDED.external_id, synced_at = now()`,
    [entity, id, connectorKey, externalId],
  );
}

async function delegationId(db: Db, d: Data): Promise<string | null> {
  const code = str(d.delegation_code);
  if (!code) return str(d.delegation_id);
  return (await db.query<{ id: string }>("SELECT id FROM delegations WHERE code = $1", [code])).rows[0]?.id ?? null;
}

const mergeExtra = (d: Data) => JSON.stringify(isObj(d.extra) ? d.extra : {});

async function customer(db: Db, d: Data, c: { connectorKey: string; externalId: string | null; piiKey: string }): Promise<UpsertResult> {
  const name = str(d.name);
  const code = str(d.code);
  let id = (await byExternal(db, "customer", c.connectorKey, c.externalId)) ?? (code ? (await db.query<{ id: string }>("SELECT id FROM customers WHERE code = $1", [code])).rows[0]?.id : undefined);
  const enc = (v: unknown) => (str(v) ? [true, String(v)] : [false, null]);
  const [hasEmail, email] = enc(d.email);
  const [hasPhone, phone] = enc(d.phone);
  const [hasTax, tax] = enc(d.tax_id);
  const consent = d.consent_comms === undefined || d.consent_comms === null ? null : Boolean(d.consent_comms);
  if (id) {
    await db.query(
      `UPDATE customers SET name = coalesce($2, name), code = coalesce($3, code), address = coalesce($4, address), consent_comms = coalesce($5, consent_comms),
         email_enc = CASE WHEN $6::boolean THEN pgp_sym_encrypt($7, $12) ELSE email_enc END,
         phone_enc = CASE WHEN $8::boolean THEN pgp_sym_encrypt($9, $12) ELSE phone_enc END,
         tax_id_enc = CASE WHEN $10::boolean THEN pgp_sym_encrypt($11, $12) ELSE tax_id_enc END,
         extra = extra || $13::jsonb, updated_at = now() WHERE id = $1`,
      [id, name, code, str(d.address), consent, hasEmail, email, hasPhone, phone, hasTax, tax, c.piiKey, mergeExtra(d)],
    );
    await link(db, "customer", id, c.connectorKey, c.externalId);
    return { entity: "customer", id, created: false, events: [] };
  }
  if (!name) throw permanent("mapping_incomplete", "A customer needs a name");
  id = (await db.query<{ id: string }>(
    `INSERT INTO customers (code, name, address, consent_comms, email_enc, phone_enc, tax_id_enc, delegation_id, extra)
     VALUES ($1, $2, $3, coalesce($4, false), CASE WHEN $5::boolean THEN pgp_sym_encrypt($6, $11) END, CASE WHEN $7::boolean THEN pgp_sym_encrypt($8, $11) END,
             CASE WHEN $9::boolean THEN pgp_sym_encrypt($10, $11) END, $12, $13::jsonb) RETURNING id`,
    [code, name, str(d.address), consent, hasEmail, email, hasPhone, phone, hasTax, tax, c.piiKey, await delegationId(db, d), mergeExtra(d)],
  )).rows[0]!.id;
  await link(db, "customer", id, c.connectorKey, c.externalId);
  return { entity: "customer", id, created: true, events: [{ type: "customer.created", entityType: "customer", entityId: id, payload: { connector: c.connectorKey } }] };
}

async function resolveCustomer(db: Db, d: Data, connectorKey: string): Promise<string | null> {
  return (await byExternal(db, "customer", connectorKey, str(d.customer_external_id))) ?? (str(d.customer_code) ? (await db.query<{ id: string }>("SELECT id FROM customers WHERE code = $1", [str(d.customer_code)])).rows[0]?.id ?? null : null) ?? str(d.customer_id);
}

async function site(db: Db, d: Data, c: { connectorKey: string; externalId: string | null }): Promise<UpsertResult> {
  const name = str(d.name);
  let id = await byExternal(db, "site", c.connectorKey, c.externalId);
  const customerId = await resolveCustomer(db, d, c.connectorKey);
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  const args = [name, customerId, str(d.address), str(d.municipality), str(d.autonomous_community), num(d.latitude), num(d.longitude), str(d.installation_type), mergeExtra(d)];
  if (id) {
    await db.query(
      `UPDATE sites SET name = coalesce($2, name), customer_id = coalesce($3, customer_id), address = coalesce($4, address), municipality = coalesce($5, municipality),
         autonomous_community = coalesce($6, autonomous_community), latitude = coalesce($7, latitude), longitude = coalesce($8, longitude),
         installation_type = coalesce($9, installation_type), extra = extra || $10::jsonb, updated_at = now() WHERE id = $1`,
      [id, ...args],
    );
    return { entity: "site", id, created: false, events: [] };
  }
  if (!name) throw permanent("mapping_incomplete", "A site needs a name");
  id = (await db.query<{ id: string }>(
    `INSERT INTO sites (name, customer_id, address, municipality, autonomous_community, latitude, longitude, installation_type, extra) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING id`,
    args,
  )).rows[0]!.id;
  await link(db, "site", id, c.connectorKey, c.externalId);
  return { entity: "site", id, created: true, events: [] };
}

async function order(db: Db, d: Data, c: { connectorKey: string; externalId: string | null; piiKey: string }): Promise<UpsertResult> {
  const events: UpsertResult["events"] = [];
  // Nested customer / site objects are upserted first, so one mapped payload can create the whole chain.
  let customerId = await resolveCustomer(db, d, c.connectorKey);
  if (isObj(d.customer)) {
    const r = await customer(db, d.customer, { connectorKey: c.connectorKey, externalId: str(d.customer.external_id) ?? str(d.customer_external_id), piiKey: c.piiKey });
    customerId = r.id;
    events.push(...r.events);
  }
  let siteId = await byExternal(db, "site", c.connectorKey, str(d.site_external_id));
  if (isObj(d.site)) {
    const r = await site(db, { ...d.site, customer_id: customerId }, { connectorKey: c.connectorKey, externalId: str(d.site.external_id) ?? str(d.site_external_id) });
    siteId = r.id;
  }
  const externalRef = str(d.external_ref) ?? c.externalId;
  const existing = (await byExternal(db, "order", c.connectorKey, c.externalId)) ?? (externalRef ? (await db.query<{ id: string }>("SELECT id FROM orders WHERE external_ref = $1", [externalRef])).rows[0]?.id : undefined);
  const amount = d.amount === undefined || d.amount === null || d.amount === "" ? null : Number(d.amount);
  if (existing) {
    await db.query(
      `UPDATE orders SET customer_id = coalesce($2, customer_id), site_id = coalesce($3, site_id), service_code = coalesce($4, service_code), amount = coalesce($5, amount),
         currency = coalesce($6, currency), extra = extra || $7::jsonb, updated_at = now() WHERE id = $1`,
      [existing, customerId, siteId, str(d.service_code), amount, str(d.currency), mergeExtra(d)],
    );
    return { entity: "order", id: existing, created: false, events };
  }
  const id = (await db.query<{ id: string }>(
    `INSERT INTO orders (external_ref, customer_id, site_id, service_code, amount, currency, source, delegation_id, extra) VALUES ($1, $2, $3, $4, $5, coalesce($6, 'EUR'), $7, $8, $9::jsonb) RETURNING id`,
    [externalRef, customerId, siteId, str(d.service_code), amount, str(d.currency), c.connectorKey, await delegationId(db, d), mergeExtra(d)],
  )).rows[0]!.id;
  await link(db, "order", id, c.connectorKey, c.externalId ?? externalRef);
  events.push({ type: "order.received", entityType: "order", entityId: id, payload: { connector: c.connectorKey, serviceCode: str(d.service_code) } });
  return { entity: "order", id, created: true, events };
}

async function technician(db: Db, d: Data, c: { connectorKey: string; externalId: string | null }): Promise<UpsertResult> {
  const code = str(d.code);
  let id = (await byExternal(db, "technician", c.connectorKey, c.externalId)) ?? (code ? (await db.query<{ id: string }>("SELECT id FROM technicians WHERE code = $1", [code])).rows[0]?.id : undefined);
  const active = d.active === undefined || d.active === null ? null : Boolean(d.active);
  if (id) {
    const before = (await db.query<{ active: boolean }>("SELECT active FROM technicians WHERE id = $1", [id])).rows[0];
    await db.query("UPDATE technicians SET name = coalesce($2, name), email = coalesce($3, email), active = coalesce($4, active), extra = extra || $5::jsonb, updated_at = now() WHERE id = $1", [id, str(d.name), str(d.email), active, mergeExtra(d)]);
    await link(db, "technician", id, c.connectorKey, c.externalId);
    const events = before?.active && active === false ? [{ type: "technician.unavailable", entityType: "technician", entityId: id, payload: { technicianId: id, technicianName: str(d.name) } }] : [];
    return { entity: "technician", id, created: false, events };
  }
  const name = str(d.name);
  if (!name) throw permanent("mapping_incomplete", "A technician needs a name");
  id = (await db.query<{ id: string }>("INSERT INTO technicians (code, name, email, active, delegation_id, extra) VALUES ($1, $2, $3, coalesce($4, true), $5, $6::jsonb) RETURNING id", [code, name, str(d.email), active, await delegationId(db, d), mergeExtra(d)])).rows[0]!.id;
  await link(db, "technician", id, c.connectorKey, c.externalId);
  return { entity: "technician", id, created: true, events: [] };
}

async function qualification(db: Db, d: Data, c: { connectorKey: string; now: Date; alertDays: number }): Promise<UpsertResult> {
  const techId =
    (await byExternal(db, "technician", c.connectorKey, str(d.technician_external_id))) ??
    (str(d.technician_code) ? (await db.query<{ id: string }>("SELECT id FROM technicians WHERE code = $1", [str(d.technician_code)])).rows[0]?.id : undefined);
  if (!techId) throw permanent("technician_not_found", `Technician "${str(d.technician_code) ?? str(d.technician_external_id) ?? "?"}" is not known`);
  const kind = str(d.kind);
  if (!kind) throw permanent("mapping_incomplete", "A qualification needs a kind");
  const validTo = str(d.valid_to);
  const left = validTo ? Math.floor((Date.parse(validTo) - c.now.getTime()) / 86_400_000) : null;
  const status = str(d.status) === "revoked" ? "revoked" : left === null ? "valid" : left < 0 ? "expired" : left <= c.alertDays ? "expiring" : "valid";
  const found = (await db.query<{ id: string }>("SELECT id FROM qualifications WHERE technician_id = $1 AND kind = $2 AND coalesce(reference, '') = coalesce($3, '')", [techId, kind, str(d.reference)])).rows[0];
  if (found) {
    await db.query("UPDATE qualifications SET valid_from = coalesce($2, valid_from), valid_to = coalesce($3, valid_to), status = $4, source = $5, updated_at = now() WHERE id = $1", [found.id, str(d.valid_from), validTo, status, c.connectorKey]);
    return { entity: "qualification", id: found.id, created: false, events: [] };
  }
  const id = (await db.query<{ id: string }>("INSERT INTO qualifications (technician_id, kind, reference, valid_from, valid_to, status, source) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id", [techId, kind, str(d.reference), str(d.valid_from), validTo, status, c.connectorKey])).rows[0]!.id;
  return { entity: "qualification", id, created: true, events: [] };
}

/**
 * Creates or updates a platform entity from mapped data. The remote id is kept in `external_refs`, so a repeated
 * delivery updates instead of duplicating (idempotent), and `extra` is merged so open fields are never lost.
 */
export async function upsertEntity(
  db: Db,
  entity: InboundEntity,
  data: Data,
  ctx: { connectorKey: string; externalId?: string | null; piiKey?: string; now?: Date; qualificationAlertDays?: number },
): Promise<UpsertResult> {
  const c = { connectorKey: ctx.connectorKey, externalId: ctx.externalId ?? str(data.external_id), piiKey: ctx.piiKey ?? "" };
  if (entity === "customer" && (str(data.email) || str(data.phone) || str(data.tax_id)) && !c.piiKey) throw permanent("pii_key_missing", "No PII encryption key is configured");
  switch (entity) {
    case "customer": return customer(db, data, c);
    case "site": return site(db, data, c);
    case "order": return order(db, data, c);
    case "technician": return technician(db, data, c);
    case "calibration": return calibration(db, data, { connectorKey: c.connectorKey, now: ctx.now ?? new Date(), alertDays: ctx.qualificationAlertDays ?? 30 });
    case "qualification": return qualification(db, data, { connectorKey: c.connectorKey, now: ctx.now ?? new Date(), alertDays: ctx.qualificationAlertDays ?? 30 });
    default: throw permanent("entity_not_supported", `Entity "${String(entity)}" cannot be received from a connector`);
  }
}

async function calibration(db: Db, d: Data, c: { connectorKey: string; now: Date; alertDays: number }): Promise<UpsertResult> {
  const code = str(d.equipment_code);
  if (!code) throw permanent("mapping_incomplete", "A calibration needs an equipment code");
  const techId =
    (await byExternal(db, "technician", c.connectorKey, str(d.technician_external_id))) ??
    (str(d.technician_code) ? (await db.query<{ id: string }>("SELECT id FROM technicians WHERE code = $1", [str(d.technician_code)])).rows[0]?.id : undefined) ?? null;
  const validTo = str(d.valid_to);
  const left = validTo ? Math.floor((Date.parse(validTo) - c.now.getTime()) / 86_400_000) : null;
  const status = left === null ? "valid" : left < 0 ? "expired" : left <= c.alertDays ? "expiring" : "valid";
  const calibratedAt = str(d.calibrated_at);
  const found = (await db.query<{ id: string }>("SELECT id FROM equipment_calibrations WHERE equipment_code = $1 AND calibrated_at IS NOT DISTINCT FROM $2::date", [code, calibratedAt])).rows[0];
  if (found) {
    await db.query("UPDATE equipment_calibrations SET name = coalesce($2, name), valid_to = coalesce($3, valid_to), technician_id = coalesce($4, technician_id), status = $5, source = $6, extra = extra || $7::jsonb, updated_at = now() WHERE id = $1",
      [found.id, str(d.name), validTo, techId, status, c.connectorKey, mergeExtra(d)]);
    return { entity: "calibration", id: found.id, created: false, events: [] };
  }
  const id = (await db.query<{ id: string }>("INSERT INTO equipment_calibrations (equipment_code, name, calibrated_at, valid_to, technician_id, status, source, extra) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id",
    [code, str(d.name) ?? code, calibratedAt, validTo, techId, status, c.connectorKey, mergeExtra(d)])).rows[0]!.id;
  return { entity: "calibration", id, created: true, events: [] };
}

export async function emitEvents(db: Db, events: UpsertResult["events"], correlationId?: string | null): Promise<void> {
  for (const e of events) {
    await db.query("INSERT INTO domain_events (type, entity_type, entity_id, payload, correlation_id) VALUES ($1, $2, $3, $4::jsonb, $5)", [e.type, e.entityType, e.entityId, JSON.stringify(e.payload), correlationId ?? null]);
  }
}
