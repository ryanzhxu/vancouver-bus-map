import { describe, expect, it } from "vitest";
import {
  ALERTS_EVERY,
  DAILY_LIMIT,
  POLL_SECONDS,
  TRIP_UPDATE_EVERY,
  dailyRequestBudget,
  inServiceWindow,
  msUntilServiceStart,
  vancouverHour,
} from "./config.js";

describe("daily request budget", () => {
  it("stays under TransLink's 1,000 request per day cap", () => {
    expect(dailyRequestBudget().total).toBeLessThanOrEqual(DAILY_LIMIT);
  });

  it("keeps headroom for retries rather than spending every request", () => {
    // A failed request still counts against the cap, so running at exactly
    // 1,000 means the first bad afternoon takes the map down.
    const headroom = DAILY_LIMIT - dailyRequestBudget().total;
    expect(headroom).toBeGreaterThanOrEqual(20);
  });

  it("matches the arithmetic documented in config.ts", () => {
    expect(dailyRequestBudget()).toEqual({
      positions: 640,
      tripUpdates: 320,
      alerts: 16,
      total: 976,
    });
  });

  it("gives predictions at least every 4 minutes", () => {
    expect(POLL_SECONDS * TRIP_UPDATE_EVERY).toBeLessThanOrEqual(240);
  });

  it("refreshes alerts at least hourly", () => {
    expect(POLL_SECONDS * ALERTS_EVERY).toBeLessThanOrEqual(3600);
  });
});

describe("vancouverHour", () => {
  it("converts UTC to Pacific daylight time in summer", () => {
    // 2026-09-05 14:00 UTC is 07:00 PDT (UTC-7).
    expect(vancouverHour(new Date("2026-09-05T14:00:00Z"))).toBe(7);
  });

  it("converts UTC to Pacific standard time in winter", () => {
    // 2026-01-15 15:00 UTC is 07:00 PST (UTC-8).
    expect(vancouverHour(new Date("2026-01-15T15:00:00Z"))).toBe(7);
  });

  it("reports midnight as hour 0, not 24", () => {
    expect(vancouverHour(new Date("2026-09-05T07:00:00Z"))).toBe(0);
  });
});

describe("inServiceWindow", () => {
  const cases: Array<[string, boolean, string]> = [
    ["2026-09-05T13:59:00Z", false, "06:59 PDT, just before service"],
    ["2026-09-05T14:00:00Z", true, "07:00 PDT, first tick"],
    ["2026-09-05T22:00:00Z", true, "15:00 PDT, mid afternoon"],
    ["2026-09-06T05:59:00Z", true, "22:59 PDT, last minutes"],
    ["2026-09-06T06:00:00Z", false, "23:00 PDT, service ends"],
    ["2026-09-06T09:00:00Z", false, "02:00 PDT, overnight"],
  ];

  for (const [iso, expected, label] of cases) {
    it(`${expected ? "polls" : "sleeps"} at ${label}`, () => {
      expect(inServiceWindow(new Date(iso))).toBe(expected);
    });
  }
});

describe("msUntilServiceStart", () => {
  it("waits until the same morning when called overnight", () => {
    // 02:00 PDT -> 5 hours until 07:00.
    const ms = msUntilServiceStart(new Date("2026-09-06T09:00:00Z"));
    expect(ms / 3_600_000).toBeGreaterThan(4.5);
    expect(ms / 3_600_000).toBeLessThan(5.5);
  });

  it("waits until the next morning when called after service ends", () => {
    // 23:30 PDT -> about 7.5 hours until 07:00.
    const ms = msUntilServiceStart(new Date("2026-09-06T06:30:00Z"));
    expect(ms / 3_600_000).toBeGreaterThan(7);
    expect(ms / 3_600_000).toBeLessThan(8.5);
  });

  it("always returns a positive delay so the alarm never fires in the past", () => {
    for (let h = 0; h < 24; h++) {
      const iso = `2026-09-06T${String(h).padStart(2, "0")}:15:00Z`;
      expect(msUntilServiceStart(new Date(iso))).toBeGreaterThan(0);
    }
  });
});
