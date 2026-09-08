import { describe, expect, it } from "vitest";
import {
  ALERTS_EVERY,
  DAILY_LIMIT_PER_KEY,
  POLL_SECONDS,
  TRIP_UPDATE_EVERY,
  dailyRequestBudget,
  inServiceWindow,
  msUntilServiceStart,
  parseApiKeys,
  pollSecondsFor,
  requiredKeyCount,
  vancouverHour,
} from "./config.js";

describe("daily request budget", () => {
  it("stays under TransLink's per-key cap multiplied by the keys we hold", () => {
    const ceiling = DAILY_LIMIT_PER_KEY * requiredKeyCount();
    expect(dailyRequestBudget().total).toBeLessThanOrEqual(ceiling);
  });

  it("keeps headroom for retries rather than spending every request", () => {
    // A failed request still counts against the cap, so running at exactly
    // the ceiling means the first bad afternoon takes the map down. The old
    // single-key budget reserved 20; three keys reserve 20 each.
    const ceiling = DAILY_LIMIT_PER_KEY * requiredKeyCount();
    const headroom = ceiling - dailyRequestBudget().total;
    expect(headroom).toBeGreaterThanOrEqual(20 * requiredKeyCount());
  });

  it("matches the arithmetic documented in config.ts", () => {
    expect(dailyRequestBudget()).toEqual({
      positions: 1920,
      tripUpdates: 960,
      alerts: 16,
      total: 2896,
    });
  });

  it("needs exactly the three keys that are configured", () => {
    expect(requiredKeyCount()).toBe(3);
  });

  it("spends every request on rider-facing feeds and none on training", () => {
    // The prediction model trains on bytes this poller already fetched. If a
    // fourth category ever appears in the budget, something has started
    // calling TransLink on the model's behalf, which is the one thing the
    // design forbids.
    const budget = dailyRequestBudget();
    expect(budget.positions + budget.tripUpdates + budget.alerts).toBe(budget.total);
    expect(Object.keys(budget).sort()).toEqual(["alerts", "positions", "total", "tripUpdates"]);
  });

  it("gives predictions at least every 4 minutes", () => {
    expect(POLL_SECONDS * TRIP_UPDATE_EVERY).toBeLessThanOrEqual(240);
  });

  it("refreshes alerts at least hourly", () => {
    expect(POLL_SECONDS * ALERTS_EVERY).toBeLessThanOrEqual(3600);
  });
});

describe("parseApiKeys", () => {
  it("splits the comma-separated secret", () => {
    expect(parseApiKeys("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("tolerates spacing around the commas", () => {
    expect(parseApiKeys(" a , b ,c ")).toEqual(["a", "b", "c"]);
  });

  it("drops duplicates, which would inflate the per-key ledger", () => {
    expect(parseApiKeys("a,b,a")).toEqual(["a", "b"]);
  });

  it("falls back to the original single-key secret", () => {
    expect(parseApiKeys(undefined, "legacy")).toEqual(["legacy"]);
    expect(parseApiKeys("", "legacy")).toEqual(["legacy"]);
  });

  it("prefers the multi-key secret when both are set", () => {
    expect(parseApiKeys("a,b", "legacy")).toEqual(["a", "b"]);
  });

  it("reports no keys rather than one empty key when nothing is set", () => {
    expect(parseApiKeys()).toEqual([]);
    expect(parseApiKeys("", "")).toEqual([]);
  });
});

describe("pollSecondsFor", () => {
  it("runs at the documented rate once every key is present", () => {
    expect(pollSecondsFor(3)).toBe(POLL_SECONDS);
    expect(pollSecondsFor(4)).toBe(POLL_SECONDS);
  });

  it("slows in proportion when a key is revoked or mistyped", () => {
    // TransLink may terminate a key on ten days' notice. Two keys must not
    // keep spending a three-key budget.
    expect(pollSecondsFor(2)).toBe(45);
    expect(pollSecondsFor(1)).toBe(90);
  });

  it("never returns a rate that would overspend the keys it has", () => {
    const windowSeconds = 16 * 3600;
    for (const keys of [1, 2, 3, 4]) {
      const seconds = pollSecondsFor(keys);
      const ticks = Math.floor(windowSeconds / seconds);
      const spend = ticks + Math.floor(ticks / TRIP_UPDATE_EVERY) + Math.floor(ticks / ALERTS_EVERY);
      expect(spend).toBeLessThanOrEqual(DAILY_LIMIT_PER_KEY * keys);
    }
  });

  it("falls back to the slowest rate when no key is configured at all", () => {
    expect(pollSecondsFor(0)).toBe(90);
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
