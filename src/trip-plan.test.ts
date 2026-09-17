import { describe, expect, it } from "vitest";
import type { StopSchedule } from "./arrivals.js";
import {
  candidateTransferStops,
  directItineraries,
  MIN_TRANSFER_SECONDS,
  overlayLive,
  planItineraries,
  transferItineraries,
  type Itinerary,
} from "./trip-plan.js";
import { epochFor, type CalendarData } from "./service-day.js";
import type { StopPrediction } from "./types.js";

/** Saturday 2026-09-05, 15:00 Vancouver time — same fixture date as arrivals.test.ts. */
const NOW = new Date("2026-09-05T22:00:00Z");
const TODAY = "20260905";

const calendar: CalendarData = {
  services: {
    saturday: { days: [0, 0, 0, 0, 0, 0, 1], from: "20260101", to: "20261231" },
  },
  exceptions: {},
};

const at = (hours: number, minutes = 0) => hours * 3600 + minutes * 60;

/** One route, one service, departures given as [routeIndex, serviceIndex, seconds, tripId]. */
const schedule = (
  routes: string[],
  departures: Array<[number, number, number, string]>,
): StopSchedule => ({
  r: routes,
  s: ["saturday"],
  d: departures,
});

describe("directItineraries", () => {
  it("joins a trip that departs one stop and later reaches the other", () => {
    const from = schedule(["route-99"], [[0, 0, at(15, 10), "t1"]]);
    const to = schedule(["route-99"], [[0, 0, at(15, 30), "t1"]]);

    const result = directItineraries("A", from, "B", to, calendar, NOW);

    expect(result).toHaveLength(1);
    expect(result[0]!.legs).toEqual([
      {
        routeId: "route-99",
        tripId: "t1",
        fromStopId: "A",
        toStopId: "B",
        departTime: epochFor(TODAY, at(15, 10)),
        arriveTime: epochFor(TODAY, at(15, 30)),
      },
    ]);
  });

  it("ignores a trip that only serves the destination stop", () => {
    const from = schedule(["route-99"], [[0, 0, at(15, 10), "t1"]]);
    const to = schedule(["route-99"], [[0, 0, at(15, 30), "other-trip"]]);

    expect(directItineraries("A", from, "B", to, calendar, NOW)).toEqual([]);
  });

  it("does not join a trip running the other direction", () => {
    // Same trip id at both stops, but B's time is earlier — this trip is
    // headed from B to A, not A to B.
    const from = schedule(["route-99"], [[0, 0, at(15, 30), "t1"]]);
    const to = schedule(["route-99"], [[0, 0, at(15, 10), "t1"]]);

    expect(directItineraries("A", from, "B", to, calendar, NOW)).toEqual([]);
  });

  it("keeps every occurrence when a loop trip visits the destination twice", () => {
    // A regression guard: joining must use arrays of occurrences per tripId,
    // not a last-write-wins map, or the earlier lap would be silently lost.
    // NOW is 15:00, so both laps must be later than that to survive the filter.
    const from = schedule(["route-L"], [[0, 0, at(15, 50), "loop"]]);
    const to = schedule(
      ["route-L"],
      [
        [0, 0, at(16, 0), "loop"],
        [0, 0, at(16, 40), "loop"],
      ],
    );

    const result = directItineraries("A", from, "C", to, calendar, NOW);

    expect(result.map((i) => i.legs[0]!.arriveTime)).toEqual([
      epochFor(TODAY, at(16, 0)),
      epochFor(TODAY, at(16, 40)),
    ]);
  });

  it("excludes an earlier lap of a loop trip that already passed", () => {
    const from = schedule(["route-L"], [[0, 0, at(16, 20), "loop"]]);
    const to = schedule(
      ["route-L"],
      [
        [0, 0, at(16, 0), "loop"],
        [0, 0, at(16, 40), "loop"],
      ],
    );

    const result = directItineraries("A", from, "C", to, calendar, NOW);

    expect(result.map((i) => i.legs[0]!.arriveTime)).toEqual([epochFor(TODAY, at(16, 40))]);
  });

  it("sorts by departure time", () => {
    const from = schedule(
      ["route-99"],
      [
        [0, 0, at(16, 0), "later"],
        [0, 0, at(15, 10), "earlier"],
      ],
    );
    const to = schedule(
      ["route-99"],
      [
        [0, 0, at(15, 30), "earlier"],
        [0, 0, at(16, 20), "later"],
      ],
    );

    const result = directItineraries("A", from, "B", to, calendar, NOW);
    expect(result.map((i) => i.legs[0]!.tripId)).toEqual(["earlier", "later"]);
  });

  it("includes a past-midnight trip from yesterday's service day", () => {
    const lateNight = new Date("2026-09-06T07:30:00Z"); // 00:30 Sunday
    const from = schedule(["route-N"], [[0, 0, at(24, 40), "owl"]]);
    const to = schedule(["route-N"], [[0, 0, at(24, 45), "owl"]]);

    const result = directItineraries("A", from, "B", to, calendar, lateNight);

    expect(result).toHaveLength(1);
    expect(result[0]!.legs[0]!.arriveTime).toBe(epochFor("20260905", at(24, 45)));
  });
});

describe("transferItineraries", () => {
  const from = schedule(["route-1"], [[0, 0, at(15, 0), "leg1"]]);
  const to = schedule(["route-2"], [[0, 0, at(15, 40), "leg2"]]);

  it("joins two trips through a candidate stop with enough transfer time", () => {
    const candidate = schedule(
      ["route-1", "route-2"],
      [
        [0, 0, at(15, 15), "leg1"],
        [1, 0, at(15, 20), "leg2"],
      ],
    );

    const result = transferItineraries(
      "A",
      from,
      "B",
      to,
      new Map([["C", candidate]]),
      calendar,
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.legs.map((l) => l.tripId)).toEqual(["leg1", "leg2"]);
  });

  it("rejects a connection tighter than the minimum transfer time", () => {
    const arrive = at(15, 15);
    const tooTight = schedule(
      ["route-1", "route-2"],
      [
        [0, 0, arrive, "leg1"],
        [1, 0, arrive + MIN_TRANSFER_SECONDS - 1, "leg2"],
      ],
    );

    expect(
      transferItineraries("A", from, "B", to, new Map([["C", tooTight]]), calendar, NOW),
    ).toEqual([]);
  });

  it("accepts a connection exactly at the minimum transfer time", () => {
    const arrive = at(15, 15);
    const exact = schedule(
      ["route-1", "route-2"],
      [
        [0, 0, arrive, "leg1"],
        [1, 0, arrive + MIN_TRANSFER_SECONDS, "leg2"],
      ],
    );

    expect(
      transferItineraries("A", from, "B", to, new Map([["C", exact]]), calendar, NOW),
    ).toHaveLength(1);
  });

  it("does not treat riding the same trip through the stop as a transfer", () => {
    const sameTrip = schedule(
      ["route-1"],
      [
        [0, 0, at(15, 15), "leg1"],
        [0, 0, at(15, 45), "leg1"],
      ],
    );

    expect(
      transferItineraries("A", from, "B", to, new Map([["C", sameTrip]]), calendar, NOW),
    ).toEqual([]);
  });
});

describe("candidateTransferStops", () => {
  it("intersects the stops reachable from each side", () => {
    const routeStops = new Map([
      ["route-1", ["A", "X", "Y"]],
      ["route-2", ["Y", "Z", "B"]],
    ]);

    const result = candidateTransferStops({
      fromRoutes: ["route-1"],
      toRoutes: ["route-2"],
      routeStops,
      fromStopId: "A",
      toStopId: "B",
    });

    expect(result).toEqual(["Y"]);
  });

  it("excludes the origin and destination stops themselves", () => {
    const routeStops = new Map([
      ["route-1", ["A", "B"]],
      ["route-2", ["A", "B"]],
    ]);

    const result = candidateTransferStops({
      fromRoutes: ["route-1"],
      toRoutes: ["route-2"],
      routeStops,
      fromStopId: "A",
      toStopId: "B",
    });

    expect(result).toEqual([]);
  });

  it("honours the limit", () => {
    const routeStops = new Map([
      ["route-1", ["A", "P", "Q", "R"]],
      ["route-2", ["P", "Q", "R", "B"]],
    ]);

    const result = candidateTransferStops({
      fromRoutes: ["route-1"],
      toRoutes: ["route-2"],
      routeStops,
      fromStopId: "A",
      toStopId: "B",
      limit: 2,
    });

    expect(result).toHaveLength(2);
  });
});

describe("planItineraries", () => {
  it("combines direct and transfer options, earliest arrival first", () => {
    const from = schedule(
      ["route-1"],
      [
        [0, 0, at(15, 0), "direct"],
        [0, 0, at(15, 0), "leg1"],
      ],
    );
    const to = schedule(
      ["route-1", "route-2"],
      [
        [0, 0, at(16, 0), "direct"],
        [1, 0, at(15, 45), "leg2"],
      ],
    );
    const candidate = schedule(["route-1", "route-2"], [
      [0, 0, at(15, 10), "leg1"],
      [1, 0, at(15, 20), "leg2"],
    ]);

    const result = planItineraries({
      fromStopId: "A",
      from,
      toStopId: "B",
      to,
      candidates: new Map([["C", candidate]]),
      calendar,
      now: NOW,
    });

    expect(result.map((i) => i.legs.length)).toEqual([2, 1]);
  });

  it("honours the limit across both kinds of itinerary", () => {
    const from = schedule(
      ["route-1"],
      Array.from({ length: 5 }, (_, i) => [0, 0, at(15, i), `t${i}`] as [number, number, number, string]),
    );
    const to = schedule(
      ["route-1"],
      Array.from({ length: 5 }, (_, i) => [0, 0, at(15, 30 + i), `t${i}`] as [number, number, number, string]),
    );

    const result = planItineraries({
      fromStopId: "A",
      from,
      toStopId: "B",
      to,
      candidates: new Map(),
      calendar,
      now: NOW,
      limit: 2,
    });

    expect(result).toHaveLength(2);
  });
});

describe("overlayLive", () => {
  const itinerary: Itinerary = {
    legs: [
      {
        routeId: "route-1",
        tripId: "t1",
        fromStopId: "A",
        toStopId: "B",
        departTime: epochFor(TODAY, at(15, 0)),
        arriveTime: epochFor(TODAY, at(15, 20)),
      },
    ],
  };

  it("prefers a live prediction over the scheduled time at each endpoint", () => {
    const predictions = new Map<string, StopPrediction[]>([
      ["A", [{ routeId: "route-1", tripId: "t1", time: epochFor(TODAY, at(15, 3)), delay: 180 }]],
    ]);

    const [result] = overlayLive([itinerary], predictions);

    expect(result!.legs[0]).toMatchObject({
      departTime: epochFor(TODAY, at(15, 3)),
      departLive: true,
      departDelay: 180,
      arriveTime: epochFor(TODAY, at(15, 20)),
      arriveLive: false,
      arriveDelay: null,
    });
  });

  it("falls back to the scheduled time when no live prediction exists", () => {
    const [result] = overlayLive([itinerary], new Map());

    expect(result!.legs[0]).toMatchObject({
      departTime: epochFor(TODAY, at(15, 0)),
      departLive: false,
      arriveTime: epochFor(TODAY, at(15, 20)),
      arriveLive: false,
    });
  });

  it("ignores a prediction for a different trip at the same stop", () => {
    const predictions = new Map<string, StopPrediction[]>([
      ["A", [{ routeId: "route-1", tripId: "other-trip", time: epochFor(TODAY, at(15, 3)), delay: 180 }]],
    ]);

    const [result] = overlayLive([itinerary], predictions);
    expect(result!.legs[0]!.departLive).toBe(false);
  });
});
