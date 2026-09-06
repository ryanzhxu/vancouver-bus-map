import { describe, expect, it } from "vitest";
import { mergeArrivals, type StopSchedule } from "./arrivals.js";
import { epochFor, type CalendarData } from "./service-day.js";
import type { StopPrediction } from "./types.js";

/** Saturday 2026-09-05, 15:00 Vancouver time. */
const NOW = new Date("2026-09-05T22:00:00Z");
const TODAY = "20260905";

const calendar: CalendarData = {
  services: {
    saturday: { days: [0, 0, 0, 0, 0, 0, 1], from: "20260101", to: "20261231" },
    weekday: { days: [0, 1, 1, 1, 1, 1, 0], from: "20260101", to: "20261231" },
  },
  exceptions: {},
};

/** Two routes, two services, departures given as seconds after midnight. */
const schedule = (departures: Array<[number, number, number, string]>): StopSchedule => ({
  r: ["route-99", "route-4"],
  s: ["saturday", "weekday"],
  d: departures,
});

const at = (hours: number, minutes = 0) => hours * 3600 + minutes * 60;

describe("mergeArrivals", () => {
  it("returns scheduled departures still to come", () => {
    const result = mergeArrivals({
      schedule: schedule([
        [0, 0, at(15, 10), "t1"],
        [1, 0, at(15, 25), "t2"],
      ]),
      predictions: [],
      calendar,
      now: NOW,
    });

    expect(result.map((a) => a.tripId)).toEqual(["t1", "t2"]);
    expect(result.every((a) => a.live === false)).toBe(true);
  });

  it("drops departures that have already gone", () => {
    const result = mergeArrivals({
      schedule: schedule([
        [0, 0, at(9), "past"],
        [0, 0, at(16), "future"],
      ]),
      predictions: [],
      calendar,
      now: NOW,
    });

    expect(result.map((a) => a.tripId)).toEqual(["future"]);
  });

  it("ignores services that do not run today", () => {
    // Saturday, so the weekday-only trip must not appear.
    const result = mergeArrivals({
      schedule: schedule([
        [0, 1, at(15, 10), "weekday-only"],
        [0, 0, at(15, 20), "saturday-one"],
      ]),
      predictions: [],
      calendar,
      now: NOW,
    });

    expect(result.map((a) => a.tripId)).toEqual(["saturday-one"]);
  });

  it("prefers a live prediction over the timetable for the same trip", () => {
    const scheduled = epochFor(TODAY, at(15, 10));
    const predictions: StopPrediction[] = [
      { routeId: "route-99", tripId: "t1", time: scheduled + 180, delay: 180 },
    ];

    const result = mergeArrivals({
      schedule: schedule([[0, 0, at(15, 10), "t1"]]),
      predictions,
      calendar,
      now: NOW,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.live).toBe(true);
    expect(result[0]!.time).toBe(scheduled + 180);
    expect(result[0]!.delay).toBe(180);
  });

  it("keeps scheduled departures the realtime feed has not reached", () => {
    // Trip updates only cover ~20 stops ahead, so distant departures stay
    // scheduled rather than vanishing.
    const result = mergeArrivals({
      schedule: schedule([
        [0, 0, at(15, 10), "near"],
        [0, 0, at(16, 30), "far"],
      ]),
      predictions: [
        { routeId: "route-99", tripId: "near", time: epochFor(TODAY, at(15, 12)), delay: 120 },
      ],
      calendar,
      now: NOW,
    });

    expect(result.map((a) => [a.tripId, a.live])).toEqual([
      ["near", true],
      ["far", false],
    ]);
  });

  it("sorts live and scheduled together by time", () => {
    const result = mergeArrivals({
      schedule: schedule([
        [0, 0, at(15, 5), "a"],
        [0, 0, at(15, 30), "c"],
      ]),
      predictions: [
        { routeId: "route-4", tripId: "b", time: epochFor(TODAY, at(15, 15)), delay: 0 },
      ],
      calendar,
      now: NOW,
    });

    expect(result.map((a) => a.tripId)).toEqual(["a", "b", "c"]);
  });

  it("honours the limit", () => {
    const many: Array<[number, number, number, string]> = Array.from({ length: 30 }, (_, i) => [
      0,
      0,
      at(15, 5 + i),
      `t${i}`,
    ]);

    expect(mergeArrivals({ schedule: schedule(many), predictions: [], calendar, now: NOW, limit: 5 })).toHaveLength(5);
  });

  it("works with live data only, when no schedule has been published", () => {
    const result = mergeArrivals({
      schedule: null,
      predictions: [
        { routeId: "route-99", tripId: "t1", time: epochFor(TODAY, at(15, 4)), delay: -30 },
      ],
      calendar: null,
      now: NOW,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.live).toBe(true);
  });

  it("returns nothing rather than throwing when both sources are empty", () => {
    expect(
      mergeArrivals({ schedule: null, predictions: [], calendar: null, now: NOW }),
    ).toEqual([]);
  });

  it("skips predictions carrying no absolute time", () => {
    const result = mergeArrivals({
      schedule: null,
      predictions: [{ routeId: "route-99", tripId: "t1", time: null, delay: 60 }],
      calendar: null,
      now: NOW,
    });

    expect(result).toEqual([]);
  });

  it("includes a past-midnight departure from yesterday's service day", () => {
    // 00:30 Sunday. Saturday's 24:30 trip is the one actually arriving.
    const lateNight = new Date("2026-09-06T07:30:00Z");
    const result = mergeArrivals({
      schedule: schedule([[0, 0, at(24, 45), "owl"]]),
      predictions: [],
      calendar,
      now: lateNight,
    });

    expect(result.map((a) => a.tripId)).toEqual(["owl"]);
    expect(result[0]!.time).toBe(epochFor("20260905", at(24, 45)));
  });

  it("shows tonight's run of a daily after-midnight trip, not tomorrow's", () => {
    // A daily 24:30 owl is active on both service-day windows. At 00:30 Sunday
    // the arriving-now run is Saturday's 24:30. Trip-id dedup must not pin
    // Sunday's 24:30 (a whole day away) just because that window iterates first.
    const daily: CalendarData = {
      services: {
        daily: { days: [1, 1, 1, 1, 1, 1, 1], from: "20260101", to: "20261231" },
      },
      exceptions: {},
    };
    const dailySchedule: StopSchedule = {
      r: ["route-n9"],
      s: ["daily"],
      d: [[0, 0, at(24, 30), "owl"]],
    };
    const lateNight = new Date("2026-09-06T07:30:00Z"); // 00:30 Sunday Vancouver

    const result = mergeArrivals({
      schedule: dailySchedule,
      predictions: [],
      calendar: daily,
      now: lateNight,
    });

    expect(result.map((a) => a.tripId)).toEqual(["owl"]);
    expect(result[0]!.time).toBe(epochFor("20260905", at(24, 30)));
  });
});
