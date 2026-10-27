import { hmacSha256, readSecret } from "@orchestrador/platform";

import { httpCall } from "./http.js";
import { render, renderJson, renderString } from "./template.js";
import { asRecord, PermanentNodeError, type ExecutorRegistry } from "./types.js";

const CHANNELS = ["email", "sms", "whatsapp", "push", "internal"];

export const commsExecutors: ExecutorRegistry = {
  /**
   * Queues a message. The dispatcher (worker loop) sends it through the channel of the delegation,
   * so a 1000-message burst is absorbed by the queue instead of blocking the flow.
   */
  "comm.notify": {
    sideEffects: true,
    simulate: (node) => ({ output: { simulated: true, channel: String(asRecord(node.config).channel ?? "email"), queued: false } }),
    async run(node, ctx, deps) {
      const cfg = asRecord(node.config);
      const channel = renderString(ctx, cfg.channel || "email");
      if (!CHANNELS.includes(channel)) throw new PermanentNodeError("channel_invalid", `Unknown channel "${channel}"`);
      const to = renderString(ctx, cfg.to).trim();
      if (!to) throw new PermanentNodeError("recipient_missing", "The notification has no recipient");
      const variables = asRecord(renderJson(ctx, cfg.variables, {}));
      const language = renderString(ctx, cfg.language).trim() || String(ctx.variables?.language ?? "es");
      const templateKey = renderString(ctx, cfg.templateKey).trim();

      return deps.sys(async (db) => {
        let subject = renderString(ctx, cfg.subject);
        let body = renderString(ctx, cfg.body);
        let templateVersionId: string | null = null;
        let html = false;
        if (templateKey) {
          const t = await db.query<{ id: string; subject: string; body_html: string; body_text: string }>(
            `SELECT v.id, v.subject, v.body_html, v.body_text
             FROM templates t JOIN template_versions v ON v.template_id = t.id AND v.state = 'published'
             WHERE t.key = $1 OR t.key = $1 || '.' || $2
             ORDER BY (t.key = $1 || '.' || $2) DESC, v.version DESC LIMIT 1`,
            [templateKey, language],
          );
          const row = t.rows[0];
          if (!row) throw new PermanentNodeError("template_not_found", `Template "${templateKey}" has no published version`);
          templateVersionId = row.id;
          const scoped = { ...ctx, variables: { ...ctx.variables, ...variables } };
          subject = String(render(scoped, row.subject));
          html = channel === "email" && Boolean(row.body_html);
          body = String(render(scoped, channel === "email" ? row.body_html || row.body_text : row.body_text || row.body_html));
        }
        const channelRow = (
          await db.query<{ id: string }>(
            `SELECT id FROM channels WHERE kind = $1 AND enabled AND (delegation_id = $2 OR delegation_id IS NULL)
             ORDER BY delegation_id NULLS LAST LIMIT 1`,
            [channel, ctx.scope?.delegationId ?? null],
          )
        ).rows[0];
        const r = await db.query<{ id: string }>(
          `INSERT INTO messages (channel_id, channel_kind, template_version_id, to_address, subject, body, execution_id, node_id, entity_type, entity_id, delegation_id, html, priority)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (execution_id, node_id, to_address) WHERE execution_id IS NOT NULL DO UPDATE SET attempts = messages.attempts
           RETURNING id`,
          [channelRow?.id ?? null, channel, templateVersionId, to, subject || null, body, ctx.executionId, node.id, ctx.entity?.type ?? null, ctx.entity?.id ?? null, ctx.scope?.delegationId ?? null, html, Number(cfg.priority ?? 0) || 0],
        );
        await db.query("SELECT pg_notify('orq_outbox', 'message')");
        return { output: { messageId: r.rows[0]!.id, channel, to, queued: true, template: templateKey || null } };
      });
    },
  },

  "comm.webhook": {
    sideEffects: true,
    simulate: (node) => ({ output: { simulated: true, url: String(asRecord(node.config).url ?? ""), status: 202 } }),
    async run(node, ctx) {
      const cfg = asRecord(node.config);
      const url = renderString(ctx, cfg.url);
      if (!/^https?:\/\//i.test(url)) throw new PermanentNodeError("http_url_invalid", `"${url}" is not an http(s) URL`);
      const body = renderString(ctx, cfg.body || "{}");
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-orq-event-id": `${ctx.executionId}:${node.id}`,
        "x-orq-timestamp": timestamp,
      };
      const secretRef = renderString(ctx, cfg.secretRef).trim();
      if (secretRef) {
        const secret = (await readSecret(secretRef)).secret ?? (await readSecret(secretRef)).webhook_secret;
        if (!secret) throw new PermanentNodeError("secret_missing", `No signing secret found for "${secretRef}"`);
        headers["x-orq-signature"] = `sha256=${hmacSha256(secret, `${timestamp}.${body}`)}`;
      }
      const output = await httpCall({ url, method: String(cfg.method ?? "POST").toUpperCase(), headers, body });
      return { output };
    },
  },
};
