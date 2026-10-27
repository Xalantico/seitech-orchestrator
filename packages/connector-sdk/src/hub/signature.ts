import { createHmac, timingSafeEqual } from "node:crypto";

/** `HMAC-SHA256(secret, "<timestamp>.<body>")` as hex: the same scheme `comm.webhook` uses when we call out. */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

const safe = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type VerifyResult = { ok: true } | { ok: false; reason: "missing_signature" | "bad_timestamp" | "stale_timestamp" | "bad_signature" | "no_secret" };

/**
 * Verifies a webhook. The signature header may carry several comma-separated values (`sha256=…,sha256=…`) so a
 * secret can be rotated without downtime. Replays are bounded by the timestamp tolerance; exact duplicates are
 * absorbed by the inbox unique key.
 */
export function verifyWebhook(input: { secrets: string[]; signature: string | undefined; timestamp: string | undefined; rawBody: string; now?: Date; toleranceSec?: number }): VerifyResult {
  if (input.secrets.length === 0) return { ok: false, reason: "no_secret" };
  if (!input.signature) return { ok: false, reason: "missing_signature" };
  if (!input.timestamp || !/^\d{9,13}$/.test(input.timestamp)) return { ok: false, reason: "bad_timestamp" };
  const ts = Number(input.timestamp);
  const seconds = ts > 1e11 ? ts / 1000 : ts;
  const skew = Math.abs((input.now ?? new Date()).getTime() / 1000 - seconds);
  if (skew > (input.toleranceSec ?? 300)) return { ok: false, reason: "stale_timestamp" };
  const given = input.signature.split(",").map((s) => s.trim().replace(/^(sha256|v1)=/, "").toLowerCase()).filter(Boolean);
  for (const secret of input.secrets) {
    const expected = signPayload(secret, input.timestamp, input.rawBody);
    if (given.some((g) => safe(g, expected))) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}
