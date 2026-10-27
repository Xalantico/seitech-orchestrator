const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * Parses "90s", "15m", "2d", "1.5h", plain numbers (seconds) and ISO-8601 durations (PT1H30M, P2D).
 * Returns milliseconds or null when the value is not a duration.
 */
export function parseDuration(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const short = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i.exec(text);
  if (short) return Math.round(Number(short[1]) * UNIT_MS[short[2]!.toLowerCase()]!);
  const iso = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(text);
  if (iso && text.length > 1) {
    const [, w, d, h, m, s] = iso;
    return Math.round(
      (Number(w ?? 0) * 7 + Number(d ?? 0)) * UNIT_MS.d! + Number(h ?? 0) * UNIT_MS.h! + Number(m ?? 0) * UNIT_MS.m! + Number(s ?? 0) * 1000,
    );
  }
  return null;
}
