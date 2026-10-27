import { randomInt } from "node:crypto";
import { safeEqual, sha256 } from "@orchestrador/platform";

import { runSystem } from "../lib/db.js";
import { mailer } from "../lib/services.js";

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_PER_HOUR = 5;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

const otpHash = (email: string, code: string) => sha256(`${email}:${code}`);

/** Development / fallback sign-in. Resolves quietly so callers cannot enumerate accounts. */
export async function requestOtp(email: string): Promise<void> {
  const issue = await runSystem(async (db) => {
    const user = await db.query("SELECT 1 FROM users WHERE email = $1 AND status = 'active'", [email]);
    if (!user.rows[0]) return null;
    const recent = await db.query<{ last: Date | null; hourly: string }>(
      `SELECT max(created_at) AS last, count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hourly
       FROM login_otps WHERE email = $1`,
      [email],
    );
    const { last, hourly } = recent.rows[0] ?? { last: null, hourly: "0" };
    if (last && Date.now() - new Date(last).getTime() < OTP_COOLDOWN_MS) return null;
    if (Number(hourly) >= OTP_MAX_PER_HOUR) return null;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await db.query(`INSERT INTO login_otps (email, code_hash, expires_at) VALUES ($1, $2, $3)`, [
      email,
      otpHash(email, code),
      new Date(Date.now() + OTP_TTL_MS),
    ]);
    return code;
  });
  if (!issue) return;
  await mailer.send({
    to: email,
    subject: "Tu código de acceso al Orquestador",
    text: `Tu código es ${issue}. Caduca en 10 minutos.`,
    html: `<p>Tu código es <strong style="font-size:20px">${issue}</strong>.</p><p>Caduca en 10 minutos.</p>`,
  });
}

export async function verifyOtp(email: string, code: string): Promise<string | null> {
  return runSystem(async (db) => {
    const otp = await db.query<{ id: string; code_hash: string }>(
      `SELECT id, code_hash FROM login_otps
       WHERE email = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < $2
       ORDER BY created_at DESC LIMIT 1`,
      [email, OTP_MAX_ATTEMPTS],
    );
    const row = otp.rows[0];
    if (!row) return null;
    if (!safeEqual(row.code_hash, otpHash(email, code))) {
      await db.query("UPDATE login_otps SET attempts = attempts + 1 WHERE id = $1", [row.id]);
      return null;
    }
    const consumed = await db.query("UPDATE login_otps SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL", [row.id]);
    if (consumed.rowCount === 0) return null;
    const user = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1 AND status = 'active'", [email]);
    return user.rows[0]?.id ?? null;
  });
}
