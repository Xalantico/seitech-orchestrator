import type pg from "pg";

type Db = Pick<pg.PoolClient, "query">;
export type SubjectType = "customer" | "technician";

export type ExportBundle = { subjectType: SubjectType; subjectId: string; generatedAt: string; data: Record<string, unknown> };
export type EraseOutcome = { status: "done" | "refused"; reason?: string; counts: Record<string, number> };

const rows = async (db: Db, sql: string, params: unknown[]) => (await db.query<{ row: Record<string, unknown> }>(sql, params)).rows.map((r) => r.row);

/**
 * Right of access / portability (RNF-013, RNF-024): everything held about one person, as structured JSON. Encrypted
 * columns are decrypted for the data subject; internal bookkeeping columns stay out.
 */
export async function exportSubject(db: Db, piiKey: string, subjectType: SubjectType, subjectId: string): Promise<ExportBundle | null> {
  const data: Record<string, unknown> = {};
  if (subjectType === "customer") {
    const c = (await db.query<{ row: Record<string, unknown>; tax_id: string | null; email: string | null; phone: string | null }>(
      `SELECT to_jsonb(c) - 'tax_id_enc' - 'email_enc' - 'phone_enc' AS row,
              pgp_sym_decrypt(c.tax_id_enc, $2) AS tax_id, pgp_sym_decrypt(c.email_enc, $2) AS email, pgp_sym_decrypt(c.phone_enc, $2) AS phone
         FROM customers c WHERE c.id = $1`,
      [subjectId, piiKey],
    )).rows[0];
    if (!c) return null;
    data.customer = { ...c.row, taxId: c.tax_id, email: c.email, phone: c.phone };
    data.sites = await rows(db, "SELECT to_jsonb(s) AS row FROM sites s WHERE s.customer_id = $1 ORDER BY s.created_at", [subjectId]);
    data.orders = await rows(db, "SELECT to_jsonb(o) AS row FROM orders o WHERE o.customer_id = $1 ORDER BY o.created_at", [subjectId]);
    data.workOrders = await rows(db, "SELECT to_jsonb(w) AS row FROM work_orders w WHERE w.customer_id = $1 ORDER BY w.created_at", [subjectId]);
    data.visits = await rows(db, "SELECT to_jsonb(v) AS row FROM visits v JOIN work_orders w ON w.id = v.work_order_id WHERE w.customer_id = $1 ORDER BY v.created_at", [subjectId]);
    data.certificates = await rows(db, "SELECT to_jsonb(ce) AS row FROM certificates ce JOIN work_orders w ON w.id = ce.work_order_id WHERE w.customer_id = $1 ORDER BY ce.created_at", [subjectId]);
    data.messages = await rows(
      db,
      `SELECT jsonb_build_object('id', m.id, 'channel', m.channel_kind, 'to', m.to_address, 'subject', m.subject, 'status', m.status, 'createdAt', m.created_at) AS row
         FROM messages m WHERE (m.entity_type = 'customer' AND m.entity_id = $1) OR m.to_address = nullif((SELECT pgp_sym_decrypt(email_enc, $2) FROM customers WHERE id = $1), '') ORDER BY m.created_at`,
      [subjectId, piiKey],
    );
    data.consents = await rows(db, "SELECT to_jsonb(k) AS row FROM consents k WHERE k.subject_type = 'customer' AND k.subject_id = $1 ORDER BY k.at", [subjectId]);
    data.documents = await rows(
      db,
      `SELECT jsonb_build_object('id', d.id, 'filename', d.filename, 'kind', d.kind, 'createdAt', d.created_at, 'signed', d.signed) AS row
         FROM documents d WHERE d.deleted_at IS NULL AND ((d.entity_type = 'customer' AND d.entity_id = $1)
           OR (d.entity_type = 'work_order' AND d.entity_id IN (SELECT id FROM work_orders WHERE customer_id = $1))) ORDER BY d.created_at`,
      [subjectId],
    );
  } else {
    const t = (await db.query<{ row: Record<string, unknown> }>("SELECT to_jsonb(t) AS row FROM technicians t WHERE t.id = $1", [subjectId])).rows[0];
    if (!t) return null;
    data.technician = t.row;
    data.qualifications = await rows(db, "SELECT to_jsonb(q) AS row FROM qualifications q WHERE q.technician_id = $1 ORDER BY q.created_at", [subjectId]);
    data.timesheets = await rows(db, "SELECT to_jsonb(ts) AS row FROM timesheets ts WHERE ts.technician_id = $1 ORDER BY ts.created_at", [subjectId]);
    data.visits = await rows(db, "SELECT jsonb_build_object('id', v.id, 'number', v.number, 'status', v.status, 'scheduledStart', v.scheduled_start, 'actualStart', v.actual_start, 'actualEnd', v.actual_end) AS row FROM visits v WHERE v.technician_id = $1 ORDER BY v.created_at", [subjectId]);
    data.messages = await rows(
      db,
      `SELECT jsonb_build_object('id', m.id, 'channel', m.channel_kind, 'subject', m.subject, 'status', m.status, 'createdAt', m.created_at) AS row
         FROM messages m WHERE m.to_address = (SELECT email::text FROM technicians WHERE id = $1) ORDER BY m.created_at`,
      [subjectId],
    );
  }
  return { subjectType, subjectId, generatedAt: new Date().toISOString(), data };
}

/**
 * Right to erasure by anonymisation. Records the law makes us keep (work orders, certificates, billing) stay, but stop
 * pointing at a person: names, contact details, addresses and free-text fields are removed or replaced. Refused while the
 * subject still has open work, because erasing a customer mid-inspection would leave the company unable to fulfil it.
 */
export async function eraseSubject(db: Db, piiKey: string, subjectType: SubjectType, subjectId: string): Promise<EraseOutcome> {
  const counts: Record<string, number> = {};
  const tag = `Anonimizado ${subjectId.slice(0, 8)}`;

  if (subjectType === "customer") {
    const c = (await db.query<{ anonymized_at: Date | null; email: string | null }>(
      "SELECT anonymized_at, CASE WHEN email_enc IS NULL THEN NULL ELSE pgp_sym_decrypt(email_enc, $2) END AS email FROM customers WHERE id = $1 FOR UPDATE",
      [subjectId, piiKey],
    )).rows[0];
    if (!c) return { status: "refused", reason: "not_found", counts };
    if (c.anonymized_at) return { status: "refused", reason: "already_anonymized", counts };
    const open = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM work_orders WHERE customer_id = $1 AND status NOT IN ('closed', 'cancelled')", [subjectId])).rows[0]!.n;
    if (open > 0) return { status: "refused", reason: `open_work_orders:${open}`, counts };

    // Messages to this person: redact the content but keep the delivery record (who/when/status) for audit.
    const msg = await db.query(
      `UPDATE messages SET to_address = 'erased', subject = NULL, body = '[eliminado por solicitud RGPD]', error = NULL
        WHERE (entity_type = 'customer' AND entity_id = $1) OR ($2::text IS NOT NULL AND to_address = $2)`,
      [subjectId, c.email],
    );
    counts.messages = msg.rowCount ?? 0;
    counts.sites = (await db.query("UPDATE sites SET name = $2, address = NULL, municipality = NULL, latitude = NULL, longitude = NULL, extra = '{}'::jsonb, external_refs = '{}'::jsonb WHERE customer_id = $1", [subjectId, `${tag} (instalación)`])).rowCount ?? 0;
    counts.customers = (await db.query(
      `UPDATE customers SET name = $2, code = NULL, tax_id_enc = NULL, email_enc = NULL, phone_enc = NULL, address = NULL, external_refs = '{}'::jsonb, extra = '{}'::jsonb,
                            consent_comms = false, anonymized_at = now(), updated_at = now() WHERE id = $1`,
      [subjectId, tag],
    )).rowCount ?? 0;
    counts.consents = (await db.query("INSERT INTO consents (subject_type, subject_id, purpose, granted, source) SELECT 'customer', $1, purpose, false, 'gdpr_erasure' FROM (SELECT DISTINCT purpose FROM consents WHERE subject_type = 'customer' AND subject_id = $1) p", [subjectId])).rowCount ?? 0;
    counts.documents = (await db.query("UPDATE documents SET metadata = metadata || '{\"anonymized\": true}'::jsonb WHERE entity_type = 'customer' AND entity_id = $1", [subjectId])).rowCount ?? 0;
  } else {
    const t = (await db.query<{ anonymized_at: Date | null; email: string | null }>("SELECT anonymized_at, email::text AS email FROM technicians WHERE id = $1 FOR UPDATE", [subjectId])).rows[0];
    if (!t) return { status: "refused", reason: "not_found", counts };
    if (t.anonymized_at) return { status: "refused", reason: "already_anonymized", counts };
    const open = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM visits WHERE technician_id = $1 AND status NOT IN ('completed', 'cancelled')", [subjectId])).rows[0]!.n;
    if (open > 0) return { status: "refused", reason: `open_visits:${open}`, counts };
    if (t.email) counts.messages = (await db.query("UPDATE messages SET to_address = 'erased', subject = NULL, body = '[eliminado por solicitud RGPD]', error = NULL WHERE to_address = $1", [t.email])).rowCount ?? 0;
    counts.technicians = (await db.query(
      "UPDATE technicians SET name = $2, code = NULL, email = NULL, active = false, home_latitude = NULL, home_longitude = NULL, extra = '{}'::jsonb, external_refs = '{}'::jsonb, user_id = NULL, anonymized_at = now(), updated_at = now() WHERE id = $1",
      [subjectId, tag],
    )).rowCount ?? 0;
  }
  return { status: "done", counts };
}
