import { permanent, transient } from "./errors.js";
import type { ConnectorRecord } from "./adapter.js";

type Token = { value: string; expiresAt: number };
const tokens = new Map<string, Token>();

export function clearTokenCache(): void {
  tokens.clear();
}

/** Headers that authenticate a call. OAuth2 uses the client-credentials grant with the token cached until shortly before it expires. */
export async function authHeaders(
  connector: Pick<ConnectorRecord, "key" | "auth_type" | "config">,
  secrets: Record<string, string>,
  opts: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<Record<string, string>> {
  const need = (name: string) => {
    const v = secrets[name];
    if (!v) throw permanent("credentials_missing", `Connector "${connector.key}" has no "${name}" secret (check its credentials reference in Vault)`);
    return v;
  };
  switch (connector.auth_type) {
    case "none": return {};
    case "api_key": return { [String(connector.config.apiKeyHeader ?? "x-api-key").toLowerCase()]: need("api_key") };
    case "bearer": return { authorization: `Bearer ${need("token")}` };
    case "basic": return { authorization: `Basic ${Buffer.from(`${need("username")}:${need("password")}`).toString("base64")}` };
    case "oauth2": {
      const now = (opts.now ?? (() => new Date()))().getTime();
      const cached = tokens.get(connector.key);
      if (cached && cached.expiresAt - 30_000 > now) return { authorization: `Bearer ${cached.value}` };
      const tokenUrl = String(connector.config.tokenUrl ?? "");
      if (!/^https?:\/\//.test(tokenUrl)) throw permanent("oauth_token_url_missing", `Connector "${connector.key}" needs config.tokenUrl for OAuth2`);
      const body = new URLSearchParams({ grant_type: "client_credentials", client_id: need("client_id"), client_secret: need("client_secret") });
      if (connector.config.scope) body.set("scope", String(connector.config.scope));
      let res: Response;
      try {
        res = await (opts.fetch ?? fetch)(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        throw transient("oauth_network", error instanceof Error ? error.message : "Token request failed");
      }
      if (!res.ok) throw (res.status >= 500 || res.status === 429 ? transient : permanent)("oauth_token_failed", `Token endpoint answered HTTP ${res.status}`, { status: res.status });
      const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
      if (!json.access_token) throw permanent("oauth_token_missing", "The token endpoint returned no access_token");
      tokens.set(connector.key, { value: json.access_token, expiresAt: now + (json.expires_in ?? 300) * 1000 });
      return { authorization: `Bearer ${json.access_token}` };
    }
  }
}
