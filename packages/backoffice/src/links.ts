import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring download links for scheduled exports. The e-mail carries a link, never the data, so a forwarded or
 * archived message exposes nothing once the link expires, and every download is still logged against the document.
 */
const b64 = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export function signDownloadToken(secret: string, input: { documentId: string; expiresAt: Date }): string {
  const payload = b64(JSON.stringify({ d: input.documentId, e: Math.floor(input.expiresAt.getTime() / 1000) }));
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyDownloadToken(secret: string, token: string, now = new Date()): { documentId: string } | null {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as { d?: unknown; e?: unknown };
    if (typeof parsed.d !== "string" || typeof parsed.e !== "number" || parsed.e * 1000 < now.getTime()) return null;
    return { documentId: parsed.d };
  } catch {
    return null;
  }
}
