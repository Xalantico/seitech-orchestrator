import { readSecret, type Mailer } from "@orchestrador/platform";

export class PermanentSendError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export type OutgoingMessage = { id: string; kind: string; to: string; subject: string | null; body: string; html: boolean };
export type ChannelRow = { id: string; kind: string; provider: string; sender: string | null; config: Record<string, unknown>; secret_ref: string | null };
export type Provider = (message: OutgoingMessage, channel: ChannelRow) => Promise<{ providerId: string | null }>;

export type ProviderDeps = { mailer: Mailer; fetch?: typeof fetch; secret?: (ref: string) => Promise<Record<string, string>> };

const stripHtml = (html: string) => html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Providers by `channels.provider`. `mock` only records, `smtp`/`postmark` use the platform mailer, `http` posts to any gateway. */
export function createProviders(deps: ProviderDeps): Record<string, Provider> {
  const doFetch = deps.fetch ?? fetch;
  const secret = deps.secret ?? readSecret;
  const mail: Provider = async (m) => {
    const r = await deps.mailer.send({ to: m.to, subject: m.subject ?? "", ...(m.html ? { html: m.body, text: stripHtml(m.body) } : { text: m.body }) });
    return { providerId: r.id };
  };
  const http: Provider = async (m, ch) => {
    const cfg = ch.config;
    const url = String(cfg.url ?? "");
    if (!/^https?:\/\//i.test(url)) throw new PermanentSendError("channel_misconfigured", `Channel ${ch.kind} has no valid gateway url`);
    const headers: Record<string, string> = { "content-type": "application/json", "idempotency-key": m.id };
    if (ch.secret_ref) {
      const s = await secret(ch.secret_ref);
      const token = s.token ?? s.api_key ?? s.secret;
      if (!token) throw new PermanentSendError("secret_missing", `No credential found for ${ch.secret_ref}`);
      headers.authorization = `Bearer ${token}`;
    }
    let response: Response;
    try {
      response = await doFetch(url, { method: "POST", headers, signal: AbortSignal.timeout(Number(cfg.timeoutMs ?? 10_000)), body: JSON.stringify({ messageId: m.id, channel: m.kind, from: ch.sender, to: m.to, subject: m.subject, body: m.body, html: m.html }) });
    } catch (error) {
      throw new Error(`Gateway unreachable: ${error instanceof Error ? error.message : String(error)}`); // transient: retried
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 408) {
      throw new PermanentSendError(`gateway_${response.status}`, `Gateway rejected the message (${response.status}): ${(await response.text()).slice(0, 200)}`);
    }
    if (!response.ok) throw new Error(`Gateway answered ${response.status}`);
    const json = (await response.json().catch(() => ({}))) as { id?: string; messageId?: string; sid?: string };
    return { providerId: json.id ?? json.messageId ?? json.sid ?? null };
  };
  return {
    mock: async (m) => ({ providerId: `mock-${m.id}` }),
    smtp: mail,
    postmark: mail,
    http,
    internal: async (m) => ({ providerId: `internal-${m.id}` }),
  };
}
