import { describe, expect, it } from "vitest";
import {
  activeWindows,
  epochFor,
  servicesOn,
  vancouverDate,
  vancouverMidnightEpoch,
  vancouverSeconds,
  weekdayOf,
  zoneOffsetMinutes,
  type CalendarData,
} from "./service-day.js";

describe("vancouverDate", () => {
  it("uses Vancouver's date, not UTC's", () => {
    // 2026-09-06 05:00 UTC is still 2026-09-05 22:00 in Vancouver.
    expect(vancouverDate(new Date("2026-09-06T05:00:00Z"))).toBe("20260905");
  });

  it("rolls over at Vancouver midnight", () => {
    expect(vancouverDate(new Date("2026-09-06T07:00:00Z"))).toBe("20260906");
  });

  it("steps back a day on request", () => {
    expect(vancouverDate(new Date("2026-09-06T20:00:00Z"), -1)).toBe("20260905");
  });

  it("steps back across the spring-forward boundary", () => {
    // DST begins 2026-03-08, a 23-hour day. Just after midnight on the 9th,
    // yesterday is still the 8th — not the 7th, which a fixed 24-hour shift
    // would land on because the 8th was an hour short.
    expect(vancouverDate(new Date("2026-03-09T07:30:00Z"), -1)).toBe("20260308");
  });
});

describe("vancouverSeconds", () => {
  it("counts seconds from Vancouver midnight", () => {
    // 22:00 PDT
    expect(vancouverSeconds(new Date("2026-09-06T05:00:00Z"))).toBe(22 * 3600);
  });

  it("reports midnight as 0, not 86400", () => {
    expect(vancouverSeconds(new Date("2026-09-06T07:00:00Z"))).toBe(0);
  });
});

describe("zoneOffsetMinutes", () => {
  it("is -420 during daylight time", () => {
    expect(zoneOffsetMinutes(new Date("2026-09-05T20:00:00Z"))).toBe(-420);
  });

  it("is -480 during standard time", () => {
    expect(zoneOffsetMinutes(new Date("2026-01-15T20:00:00Z"))).toBe(-480);
  });
});

describe("vancouverMidnightEpoch", () => {
  it("resolves summer midnight to 07:00 UTC", () => {
    expect(vancouverMidnightEpoch("20260905")).toBe(
      Math.floor(Date.parse("2026-09-05T07:00:00Z") / 1000),
    );
  });

  it("resolves winter midnight to 08:00 UTC", () => {
    expect(vancouverMidnightEpoch("20260115")).toBe(
      Math.floor(Date.parse("2026-01-15T08:00:00Z") / 1000),
    );
  });
});

describe("epochFor", () => {
  it("places a normal departure correctly", () => {
    // 07:30 on 2026-09-05 PDT is 14:30 UTC.
    expect(epochFor("20260905", 7 * 3600 + 30 * 60)).toBe(
      Math.floor(Date.parse("2026-09-05T14:30:00Z") / 1000),
    );
  });

  it("places a past-midnight departure on the following calendar day", () => {
    // 25:14 on 2026-09-05 is 01:14 on 2026-09-06 local, 08:14 UTC.
    expect(epochFor("20260905", 25 * 3600 + 14 * 60)).toBe(
      Math.floor(Date.parse("2026-09-06T08:14:00Z") / 1000),
    );
  });
});

describe("weekdayOf", () => {
  it("uses Sunday as 0, matching GTFS column order", () => {
    expect(weekdayOf("20260906")).toBe(0); // a Sunday
    expect(weekdayOf("20260907")).toBe(1); // Monday
    expect(weekdayOf("20260905")).toBe(6); // Saturday
  });
});

describe("servicesOn", () => {
  const calendar: CalendarData = {
    services: {
      weekday: { days: [0, 1, 1, 1, 1, 1, 0], from: "20260101", to: "20261231" },
      saturday: { days: [0, 0, 0, 0, 0, 0, 1], from: "20260101", to: "20261231" },
      sunday: { days: [1, 0, 0, 0, 0, 0, 0], from: "20260101", to: "20261231" },
      expired: { days: [1, 1, 1, 1, 1, 1, 1], from: "20250101", to: "20250601" },
    },
    exceptions: {
      // A Monday holiday: weekday service removed, Sunday service added.
      weekday: [["20260907", 2]],
      sunday: [["20260907", 1]],
    },
  };

  it("picks the weekday pattern on an ordinary Tuesday", () => {
    expect([...servicesOn(calendar, "20260908")]).toEqual(["weekday"]);
  });

  it("picks Saturday service on a Saturday", () => {
    expect([...servicesOn(calendar, "20260905")]).toEqual(["saturday"]);
  });

  it("applies a holiday override, swapping weekday for Sunday service", () => {
    const active = servicesOn(calendar, "20260907");
    expect(active.has("weekday")).toBe(false);
    expect(active.has("sunday")).toBe(true);
  });

  it("ignores services whose date range has passed", () => {
    expect(servicesOn(calendar, "20260908").has("expired")).toBe(false);
  });
});

describe("activeWindows", () => {
  it("offers today and yesterday, so post-midnight trips still resolve", () => {
    // 01:00 Sunday in Vancouver. Saturday's 25:00 bus is still running.
    const windows = activeWindows(new Date("2026-09-06T08:00:00Z"));

    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({ date: "20260906", nowSeconds: 3600 });
    expect(windows[1]).toEqual({ date: "20260905", nowSeconds: 3600 + 86_400 });
  });

  it("expresses the same instant in both windows", () => {
    const [today, yesterday] = activeWindows(new Date("2026-09-05T22:00:00Z"));
    expect(yesterday!.nowSeconds - today!.nowSeconds).toBe(86_400);
  });
});
