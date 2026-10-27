import type { BusinessCalendar } from "./types.js";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Offset of `timeZone` from UTC at instant `ms`, in minutes (positive east of Greenwich). */
export function tzOffsetMinutes(ms: number, timeZone: string): number {
  if (timeZone === "UTC") return 0;
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

type LocalDay = { y: number; m: number; d: number; isoWeekday: number; key: string };

function localDay(ms: number, tz: string): LocalDay {
  const local = new Date(ms + tzOffsetMinutes(ms, tz) * 60_000);
  return dayFromUtcDate(local);
}

function dayFromUtcDate(date: Date): LocalDay {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  const wd = date.getUTCDay();
  return { y, m, d, isoWeekday: wd === 0 ? 7 : wd, key: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

function nextDay(day: LocalDay): LocalDay {
  return dayFromUtcDate(new Date(Date.UTC(day.y, day.m - 1, day.d + 1)));
}

/** UTC instant of local wall-clock `minutes` after midnight on `day` (DST-safe to the minute). */
function localToUtc(day: LocalDay, minutes: number, tz: string): number {
  const naive = Date.UTC(day.y, day.m - 1, day.d, 0, minutes);
  let guess = naive - tzOffsetMinutes(naive, tz) * 60_000;
  guess = naive - tzOffsetMinutes(guess, tz) * 60_000;
  return guess;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m ?? 0);
}

export const DEFAULT_CALENDAR: BusinessCalendar = {
  timeZone: "Europe/Madrid",
  workdays: [1, 2, 3, 4, 5],
  hours: [["09:00", "18:00"]],
  holidays: [],
};

/**
 * Adds `durationMs` of *working* time to `startMs` following the calendar: only workdays, only inside the
 * working windows, skipping holidays. Pure and deterministic, safe to call from workflow code.
 */
export function addBusinessTime(startMs: number, durationMs: number, cal: BusinessCalendar = DEFAULT_CALENDAR): number {
  const windows = cal.hours.map(([a, b]) => [toMinutes(a), toMinutes(b)] as const).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  if (windows.length === 0 || cal.workdays.length === 0) return startMs + durationMs;
  const holidays = new Set(cal.holidays);
  let remaining = durationMs;
  let day = localDay(startMs, cal.timeZone);
  let cursor = startMs;
  for (let i = 0; i < 3660; i += 1) {
    if (cal.workdays.includes(day.isoWeekday) && !holidays.has(day.key)) {
      for (const [a, b] of windows) {
        const from = Math.max(cursor, localToUtc(day, a, cal.timeZone));
        const to = localToUtc(day, b, cal.timeZone);
        if (to <= from) continue;
        const available = to - from;
        if (remaining <= available) return from + remaining;
        remaining -= available;
      }
    }
    day = nextDay(day);
    cursor = 0; // later days start from their own window opening
  }
  return startMs + durationMs;
}
