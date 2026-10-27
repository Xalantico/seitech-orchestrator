const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const CONTAINS = ["apikey", "secret", "password", "passwd", "credential", "authorization", "accesskey", "privatekey", "connectionstring"];
const EQUALS = ["auth", "bearer", "cookie", "setcookie", "pwd", "iban", "nif", "dni"];

function sensitive(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, "");
  return CONTAINS.some((r) => k.includes(r)) || k.endsWith("token") || EQUALS.includes(k);
}

/** Masks credential-like keys before anything is persisted in the event log (RNF-30). */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 32) return TRUNCATED;
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sensitive(k) ? REDACTED : redactSensitive(v, depth + 1);
    return out;
  }
  return value;
}
