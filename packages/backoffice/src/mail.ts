import type pg from "pg";

type Db = Pick<pg.PoolClient, "query">;

export type OutgoingMail = { to: string; subject: string; text: string; html?: string; entityType?: string; entityId?: string | null; delegationId?: string | null };

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** Puts an e-mail in the message queue; the dispatcher sends it with retries and records delivery status. */
export async function queueEmail(db: Db, mail: OutgoingMail): Promise<string> {
  const channel = (await db.query<{ id: string }>(
    "SELECT id FROM channels WHERE kind = 'email' AND enabled AND (delegation_id = $1 OR delegation_id IS NULL) ORDER BY delegation_id NULLS LAST LIMIT 1",
    [mail.delegationId ?? null],
  )).rows[0];
  const html = mail.html ?? `<p>${escapeHtml(mail.text).replace(/\n/g, "<br>")}</p>`;
  const row = await db.query<{ id: string }>(
    `INSERT INTO messages (channel_id, channel_kind, to_address, subject, body, html, entity_type, entity_id, delegation_id)
     VALUES ($1, 'email', $2, $3, $4, true, $5, $6, $7) RETURNING id`,
    [channel?.id ?? null, mail.to, mail.subject, html, mail.entityType ?? null, mail.entityId ?? null, mail.delegationId ?? null],
  );
  await db.query("SELECT pg_notify('orq_outbox', 'message')");
  return row.rows[0]!.id;
}
