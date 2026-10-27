import type { Logger } from "@orchestrador/observability";
import type pg from "pg";

import { PermanentSendError, type ChannelRow, type OutgoingMessage, type Provider } from "./providers.js";

export type DispatcherDeps = {
  pool: pg.Pool;
  system: <T>(fn: (db: pg.PoolClient) => Promise<T>) => Promise<T>;
  providers: Record<string, Provider>;
  log: Logger;
  /** Used for email messages whose delegation has no channel configured. */
  defaultEmailProvider?: string;
  concurrency?: number;
  leaseSeconds?: number;
  onSent?: (kind: string) => void;
  onFailed?: (kind: string) => void;
};

type Claimed = {
  id: string; channel_id: string | null; channel_kind: string; to_address: string; subject: string | null; body: string; html: boolean; attempts: number;
  entity_type: string | null; entity_id: string | null; template_version_id: string | null;
};

const backoffSeconds = (attempt: number) => Math.min(3600, 15 * 2 ** Math.max(0, attempt - 1));

/**
 * Sends queued messages. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease, so any number of workers can run;
 * a crashed worker's messages return to the queue when the lease expires. Each channel has its own per-minute budget
 * (`rate_limit_per_min`), failures retry with exponential backoff up to `max_attempts`, and customers without
 * communications consent never receive a message.
 */
export async function dispatchMessages(deps: DispatcherDeps, batch = 200): Promise<number> {
  const lease = deps.leaseSeconds ?? 120;

  const claimed = await deps.system(async (db) => {
    await db.query("UPDATE messages SET status = 'queued', locked_until = NULL WHERE status = 'sending' AND locked_until < now()");
    const channels = (await db.query<{ id: string; budget: number }>(
      `SELECT c.id, greatest(0, c.rate_limit_per_min - (SELECT count(*) FROM messages m WHERE m.channel_id = c.id
                                                          AND (m.sent_at > now() - interval '1 minute' OR m.status = 'sending')))::int AS budget
       FROM channels c WHERE c.enabled`,
    )).rows;
    const rows: Claimed[] = [];
    const take = async (channelId: string | null, limit: number) => {
      if (limit <= 0) return;
      const r = await db.query<Claimed>(
        `UPDATE messages SET status = 'sending', attempts = attempts + 1, locked_until = now() + make_interval(secs => $3)
         WHERE id IN (SELECT id FROM messages WHERE status = 'queued' AND next_attempt_at <= now() AND channel_id IS NOT DISTINCT FROM $1
                      ORDER BY priority DESC, created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
         RETURNING id, channel_id, channel_kind, to_address, subject, body, html, attempts, entity_type, entity_id, template_version_id`,
        [channelId, limit, lease],
      );
      rows.push(...r.rows);
    };
    for (const ch of channels) {
      if (rows.length >= batch) break;
      await take(ch.id, Math.min(ch.budget, batch - rows.length));
    }
    if (rows.length < batch) await take(null, batch - rows.length); // messages with no channel: default email or fail below
    return rows;
  });
  if (claimed.length === 0) return 0;

  const channelRows = new Map<string, ChannelRow & { max_attempts: number }>();
  await deps.system(async (db) => {
    const ids = [...new Set(claimed.map((m) => m.channel_id).filter((x): x is string => Boolean(x)))];
    if (ids.length === 0) return;
    for (const r of (await db.query<ChannelRow & { max_attempts: number }>("SELECT id, kind, provider, sender, config, secret_ref, max_attempts FROM channels WHERE id = ANY($1)", [ids])).rows) channelRows.set(r.id, r);
  });

  const queue = [...claimed];
  const workers = Array.from({ length: Math.min(deps.concurrency ?? 20, queue.length) }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) await deliver(m);
  });
  await Promise.all(workers);
  return claimed.length;

  async function settle(m: Claimed, outcome: { ok: true; providerId: string | null } | { ok: false; error: string; permanent: boolean; max: number }) {
    await deps.system(async (db) => {
      if (outcome.ok) {
        await db.query("UPDATE messages SET status = 'sent', provider_id = $2, sent_at = now(), error = NULL, locked_until = NULL WHERE id = $1", [m.id, outcome.providerId]);
      } else if (outcome.permanent || m.attempts >= outcome.max) {
        await db.query("UPDATE messages SET status = 'failed', error = $2, locked_until = NULL WHERE id = $1", [m.id, outcome.error.slice(0, 500)]);
      } else {
        await db.query("UPDATE messages SET status = 'queued', error = $2, locked_until = NULL, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1", [m.id, outcome.error.slice(0, 500), backoffSeconds(m.attempts)]);
      }
    });
    if (outcome.ok) deps.onSent?.(m.channel_kind);
    else if (outcome.permanent || m.attempts >= outcome.max) deps.onFailed?.(m.channel_kind);
  }

  async function deliver(m: Claimed) {
    const channel = m.channel_id ? channelRows.get(m.channel_id) : undefined;
    const max = channel?.max_attempts ?? 5;
    try {
      if (m.entity_type === "customer" && m.entity_id && m.channel_kind !== "internal") {
        const ok = await deps.system(async (db) => (await db.query<{ consent_comms: boolean }>("SELECT consent_comms FROM customers WHERE id = $1", [m.entity_id])).rows[0]?.consent_comms);
        if (ok === false) throw new PermanentSendError("no_consent", "The customer has not given consent to receive communications");
      }
      const providerName = channel?.provider ?? (m.channel_kind === "email" ? deps.defaultEmailProvider : undefined);
      if (!providerName) throw new PermanentSendError("no_channel", `No enabled ${m.channel_kind} channel for this delegation`);
      const provider = deps.providers[providerName];
      if (!provider) throw new PermanentSendError("provider_unknown", `Unknown provider "${providerName}"`);
      const out: OutgoingMessage = { id: m.id, kind: m.channel_kind, to: m.to_address, subject: m.subject, body: m.body, html: m.html };
      const sent = await provider(out, channel ?? { id: "", kind: m.channel_kind, provider: providerName, sender: null, config: {}, secret_ref: null });
      await settle(m, { ok: true, providerId: sent.providerId });
    } catch (error) {
      const permanent = error instanceof PermanentSendError;
      const message = error instanceof Error ? error.message : String(error);
      deps.log.warn({ messageId: m.id, attempt: m.attempts, permanent, err: message }, "message not sent");
      await settle(m, { ok: false, error: permanent ? `${(error as PermanentSendError).code}: ${message}` : message, permanent, max });
    }
  }
}
