/**
 * HashiCorp Vault KV v2 access (RNF-30). Secrets never live in the repo: the process reads them at
 * start-up (`loadVaultIntoEnv`) and connector credentials are fetched on demand (`readSecret`).
 */
type VaultConfig = { addr: string; token: string; mount: string; basePath: string };

function config(): VaultConfig | null {
  const addr = process.env.VAULT_ADDR;
  const token = process.env.VAULT_TOKEN;
  if (!addr || !token) return null;
  return {
    addr: addr.replace(/\/$/, ""),
    token,
    mount: process.env.VAULT_MOUNT ?? "secret",
    basePath: process.env.VAULT_BASE_PATH ?? `orquestador/${process.env.APP_ENV ?? "dev"}`,
  };
}

async function kvRead(cfg: VaultConfig, path: string): Promise<Record<string, string> | null> {
  const response = await fetch(`${cfg.addr}/v1/${cfg.mount}/data/${path}`, {
    headers: { "X-Vault-Token": cfg.token },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Vault read ${path} failed: ${response.status}`);
  const body = (await response.json()) as { data?: { data?: Record<string, string> } };
  return body.data?.data ?? null;
}

/** Copies every key of `<base>/app` into process.env unless already set explicitly. */
export async function loadVaultIntoEnv(): Promise<number> {
  const cfg = config();
  if (!cfg) return 0;
  const data = await kvRead(cfg, `${cfg.basePath}/app`);
  let count = 0;
  for (const [key, value] of Object.entries(data ?? {})) {
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
      count += 1;
    }
  }
  return count;
}

const cache = new Map<string, { at: number; value: Record<string, string> }>();

/** Reads a named secret (e.g. `connectors/hubspot`). Cached 60 s. Returns {} when Vault is off. */
export async function readSecret(ref: string | null | undefined): Promise<Record<string, string>> {
  if (!ref) return {};
  const cfg = config();
  if (!cfg) {
    // Local fallback: SECRET__CONNECTORS_HUBSPOT__TOKEN=...
    const prefix = `SECRET__${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}__`;
    return Object.fromEntries(
      Object.entries(process.env)
        .filter(([k, v]) => k.startsWith(prefix) && v)
        .map(([k, v]) => [k.slice(prefix.length).toLowerCase(), v as string]),
    );
  }
  const hit = cache.get(ref);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = (await kvRead(cfg, `${cfg.basePath}/${ref}`)) ?? {};
  cache.set(ref, { at: Date.now(), value });
  return value;
}
