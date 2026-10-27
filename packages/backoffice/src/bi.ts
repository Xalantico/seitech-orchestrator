import { createHmac } from "node:crypto";

const b64 = (v: Buffer | string) => Buffer.from(v).toString("base64url");

export type EmbedInput = { siteUrl: string; secret: string; dashboardId: number; params?: Record<string, string | number | string[]>; ttlMinutes?: number; now?: Date; theme?: "light" | "night" };

/**
 * Metabase "signed embedding": the browser gets a URL that carries a short-lived HS256 token naming one dashboard and its
 * locked parameters, so nobody can walk to another dashboard by editing the link, and no Metabase login is needed.
 */
export function signDashboardEmbed(input: EmbedInput): { url: string; expiresAt: string } {
  const now = input.now ?? new Date();
  const exp = Math.floor(now.getTime() / 1000) + (input.ttlMinutes ?? 10) * 60;
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(JSON.stringify({ resource: { dashboard: input.dashboardId }, params: input.params ?? {}, exp }));
  const sig = createHmac("sha256", input.secret).update(`${header}.${payload}`).digest("base64url");
  const options = ["bordered=true", "titled=true", ...(input.theme ? [`theme=${input.theme}`] : [])].join("&");
  return { url: `${input.siteUrl.replace(/\/+$/, "")}/embed/dashboard/${header}.${payload}.${sig}#${options}`, expiresAt: new Date(exp * 1000).toISOString() };
}
