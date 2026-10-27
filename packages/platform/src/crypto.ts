import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const hmacSha256 = (secret: string, payload: string | Buffer): string =>
  createHmac("sha256", secret).update(payload).digest("hex");

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** Verifies `sha256=<hex>` style signatures, constant time. */
export function verifySignature(secret: string, payload: string | Buffer, header: string | undefined | null): boolean {
  if (!header) return false;
  const provided = header.replace(/^sha256=/i, "").trim();
  return safeEqual(hmacSha256(secret, payload), provided);
}
