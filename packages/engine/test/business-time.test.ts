import { describe, expect, it } from "vitest";

import { addBusinessTime, DEFAULT_CALENDAR } from "../src/business-time.js";
import { parseDuration } from "../src/duration.js";

const H = 3_600_000;
const cal = { ...DEFAULT_CALENDAR, hours: [["09:00", "14:00"], ["15:00", "18:00"]] as [string, string][] };

describe("addBusinessTime", () => {
  it("stays inside the same window", () => {
    const start = Date.parse("2026-03-02T08:30:00Z"); // Monday 09:30 Madrid
    expect(new Date(addBusinessTime(start, 2 * H, cal)).toISOString()).toBe("2026-03-02T10:30:00.000Z");
  });
  it("skips the lunch gap", () => {
    const start = Date.parse("2026-03-02T12:00:00Z"); // Monday 13:00 Madrid
    expect(new Date(addBusinessTime(start, 2 * H, cal)).toISOString()).toBe("2026-03-02T15:00:00.000Z"); // 13-14 then 15-16 Madrid
  });
  it("skips weekends", () => {
    const start = Date.parse("2026-03-06T16:30:00Z"); // Friday 17:30 Madrid
    expect(new Date(addBusinessTime(start, H, cal)).toISOString()).toBe("2026-03-09T08:30:00.000Z"); // Monday 09:30 Madrid
  });
  it("skips holidays", () => {
    const start = Date.parse("2026-03-02T16:30:00Z");
    const withHoliday = { ...cal, holidays: ["2026-03-03"] };
    expect(new Date(addBusinessTime(start, H, withHoliday)).toISOString()).toBe("2026-03-04T08:30:00.000Z");
  });
  it("respects daylight saving changes", () => {
    const start = Date.parse("2026-03-27T16:30:00Z"); // Friday before the 29 March DST switch
    expect(new Date(addBusinessTime(start, H, cal)).toISOString()).toBe("2026-03-30T07:30:00.000Z"); // Monday 09:30 CEST = 07:30Z
  });
});

describe("parseDuration", () => {
  it.each([
    ["30s", 30_000], ["15m", 900_000], ["2d", 172_800_000], [90, 90_000], ["PT1H30M", 5_400_000], ["P1D", 86_400_000], ["1.5h", 5_400_000],
  ])("%s", (input, expected) => expect(parseDuration(input)).toBe(expected));
  it.each([[""], ["soon"], [null], [-5]])("rejects %s", (input) => expect(parseDuration(input)).toBeNull());
});
