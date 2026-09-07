import { describe, expect, it } from "vitest";
import {
  arrivalsErrorText,
  BUS_ICON_MIN_ZOOM,
  BusField,
  bunchesAt,
  countdown,
  DEPARTED_SLACK_SECONDS,
  describeAge,
  describeArrival,
  describeDelay,
  findBunches,
  hasDeparted,
  hintText,
  isFeedStale,
  isLate,
  LATE_THRESHOLD_SECONDS,
  markerShapeFor,
  shouldClearFollow,
  STALE_FEED_SECONDS,
  type RenderedBus,
  type Snapshot,
  type WireVehicle,
} from "./buses.js";
import { buildTrack, type LatLon } from "./geo.js";

const northLine: LatLon[] = [
  [49.28, -123.12],
  [49.29, -123.12],
  [49.3, -123.12],
];

/** An L-shaped route: north then east, so a straight tween would cut the corner. */
const cornerLine: LatLon[] = [
  [49.28, -123.12],
  [49.285, -123.12],
  [49.285, -123.113],
];

const vehicle = (over: Partial<WireVehicle> = {}): WireVehicle => ({
  i: "bus1",
  r: "route1",
  t: "trip1",
  y: 49.28,
  x: -123.12,
  s: 1,
  p: "stop1",
  ...over,
});

const snapshot = (
  vehicles: WireVehicle[],
  pollSeconds = 90,
  previous?: Record<string, [number, number]>,
): Snapshot => ({
  type: "snapshot",
  generatedAt: 0,
  feedTimestamp: null,
  pollSeconds,
  vehicles,
  ...(previous ? { previous } : {}),
});

const noTracks = () => null;
const alwaysTrack = (points: LatLon[]) => () => buildTrack(points);

describe("BusField", () => {
  it("places a bus at its reported position on the first snapshot", () => {
    const field = new BusField(noTracks);
    field.ingest(snapshot([vehicle()]), 1000);

    const [bus] = field.positionsAt(1000);
    expect(bus!.lat).toBeCloseTo(49.28, 6);
    expect(bus!.lon).toBeCloseTo(-123.12, 6);
  });

  it("glides from a seeded prior fix on the very first snapshot, instead of freezing", () => {
    const field = new BusField(noTracks);
    const seeded: Snapshot = {
      type: "snapshot",
      generatedAt: 0,
      feedTimestamp: null,
      pollSeconds: 90,
      vehicles: [vehicle({ y: 49.3 })],
      previous: { bus1: [49.28, -123.12] },
    };

    // now=45_000: this client connected halfway through the glide segment
    // that an already-open tab started tracking back when generatedAt was 0.
    field.ingest(seeded, 45_000);

    const [bus] = field.positionsAt(45_000);
    expect(bus!.lat).toBeCloseTo(49.29, 4);
    expect(bus!.moving).toBe(true);
  });

  it("still freezes a bus absent from the seed map, even when other buses have one", () => {
    const field = new BusField(noTracks);
    const seeded: Snapshot = {
      type: "snapshot",
      generatedAt: 0,
      feedTimestamp: null,
      pollSeconds: 90,
      vehicles: [vehicle({ i: "brand-new", y: 49.3 })],
      previous: { "some-other-bus": [49.28, -123.12] },
    };

    field.ingest(seeded, 45_000);

    const [bus] = field.positionsAt(45_000);
    expect(bus!.lat).toBeCloseTo(49.3, 6);
    expect(bus!.moving).toBe(false);
  });

  it("tracks several buses at once", () => {
    const field = new BusField(noTracks);
    field.ingest(snapshot([vehicle({ i: "a" }), vehicle({ i: "b" }), vehicle({ i: "c" })]), 0);
    expect(field.size).toBe(3);
    expect(field.positionsAt(0)).toHaveLength(3);
  });

  describe("without geometry", () => {
    it("glides in a straight line between samples", () => {
      const field = new BusField(noTracks);
      field.ingest(snapshot([vehicle({ y: 49.28 })]), 0);
      field.ingest(snapshot([vehicle({ y: 49.3 })]), 1000);

      const halfway = field.positionsAt(1000 + 45_000)[0]!;
      expect(halfway.lat).toBeCloseTo(49.29, 4);
    });

    it("arrives exactly at the target by the end of the interval", () => {
      const field = new BusField(noTracks);
      field.ingest(snapshot([vehicle({ y: 49.28 })]), 0);
      field.ingest(snapshot([vehicle({ y: 49.3 })]), 1000);

      expect(field.positionsAt(1000 + 90_000)[0]!.lat).toBeCloseTo(49.3, 6);
    });

    it("snaps to the latest sample instead of gliding when motion is reduced", () => {
      const field = new BusField(noTracks);
      field.ingest(snapshot([vehicle({ y: 49.28 })]), 0);
      field.ingest(snapshot([vehicle({ y: 49.3 })]), 1000);

      // Halfway through the interval the default glide is mid-tween, but a
      // reduced-motion caller sees the bus already at its reported position,
      // so nothing slides between polls.
      const mid = 1000 + 45_000;
      expect(field.positionsAt(mid, true)[0]!.lat).toBeCloseTo(49.29, 4);

      const snapped = field.positionsAt(mid, false)[0]!;
      expect(snapped.lat).toBeCloseTo(49.3, 6);
    });

    it("stops at the target rather than overshooting when a snapshot is late", () => {
      const field = new BusField(noTracks);
      field.ingest(snapshot([vehicle({ y: 49.28 })]), 0);
      field.ingest(snapshot([vehicle({ y: 49.3 })]), 1000);

      const late = field.positionsAt(1000 + 300_000)[0]!;
      expect(late.lat).toBeCloseTo(49.3, 6);
    });
  });

  describe("moving", () => {
    it("reads false for a bus reporting the same spot twice, true for one that displaced", () => {
      const parked = new BusField(noTracks);
      parked.ingest(snapshot([vehicle({ y: 49.28, x: -123.12 })]), 0);
      parked.ingest(snapshot([vehicle({ y: 49.28, x: -123.12 })]), 90_000);
      expect(parked.positionsAt(90_000)[0]!.moving).toBe(false);

      const travelling = new BusField(noTracks);
      travelling.ingest(snapshot([vehicle({ y: 49.28 })]), 0);
      travelling.ingest(snapshot([vehicle({ y: 49.3 })]), 90_000);
      expect(travelling.positionsAt(90_000)[0]!.moving).toBe(true);
    });

    it("reads the same whether or not the caller is gliding", () => {
      // Reduced motion changes how the position tweens, not what "moving"
      // means: it must not flip the flag on its own.
      const field = new BusField(noTracks);
      field.ingest(snapshot([vehicle({ y: 49.28 })]), 0);
      field.ingest(snapshot([vehicle({ y: 49.3 })]), 1000);

      for (const now of [1000 + 45_000, 1000 + 90_000, 1000 + 300_000]) {
        expect(field.positionsAt(now, false)[0]!.moving).toBe(
          field.positionsAt(now, true)[0]!.moving,
        );
      }
    });
  });

  describe("with route geometry", () => {
    it("follows the corner instead of cutting across it", () => {
      const field = new BusField(alwaysTrack(cornerLine));
      field.ingest(snapshot([vehicle({ y: 49.28, x: -123.12 })]), 0);
      field.ingest(snapshot([vehicle({ y: 49.285, x: -123.113 })]), 1000);

      // Halfway by distance along an L sits near the elbow, well off the
      // straight line between the endpoints.
      const mid = field.positionsAt(1000 + 45_000)[0]!;
      const diagonalLat = (49.28 + 49.285) / 2;
      const diagonalLon = (-123.12 + -123.113) / 2;
      const offDiagonal = Math.hypot(mid.lat - diagonalLat, mid.lon - diagonalLon);
      expect(offDiagonal).toBeGreaterThan(0.001);
    });

    it("derives a heading, since TransLink sends none", () => {
      const field = new BusField(alwaysTrack(northLine));
      field.ingest(snapshot([vehicle({ y: 49.28 })]), 0);
      field.ingest(snapshot([vehicle({ y: 49.3 })]), 1000);

      expect(field.positionsAt(1000 + 45_000)[0]!.bearing).toBeCloseTo(0, 0);
    });

    it("faces backwards when the bus runs against the shape direction", () => {
      const field = new BusField(alwaysTrack(northLine));
      field.ingest(snapshot([vehicle({ y: 49.3 })]), 0);
      field.ingest(snapshot([vehicle({ y: 49.28 })]), 1000);

      expect(field.positionsAt(1000 + 45_000)[0]!.bearing).toBeCloseTo(180, 0);
    });

    it("falls back to a straight line when projection implies an impossible jump", () => {
      // Two points 20km apart cannot be one 90-second hop; snapping to a
      // doubled-back leg would teleport the bus.
      const field = new BusField(alwaysTrack(northLine));
      field.ingest(snapshot([vehicle({ y: 49.28 })]), 0);
      field.ingest(snapshot([vehicle({ y: 49.5, x: -123.12 })]), 1000);

      const mid = field.positionsAt(1000 + 45_000)[0]!;
      expect(mid.lat).toBeGreaterThan(49.28);
      expect(mid.lat).toBeLessThan(49.5);
    });
  });

  it("resumes from where a bus is drawn, not from the last sample", () => {
    // A snapshot arriving mid-glide must not snap the bus backwards.
    const field = new BusField(noTracks);
    field.ingest(snapshot([vehicle({ y: 49.28 })]), 0);
    field.ingest(snapshot([vehicle({ y: 49.3 })]), 0);

    const atQuarter = field.positionsAt(22_500)[0]!.lat;
    field.ingest(snapshot([vehicle({ y: 49.32 })]), 22_500);
    const justAfter = field.positionsAt(22_600)[0]!.lat;

    expect(justAfter).toBeGreaterThanOrEqual(atQuarter - 1e-6);
  });

  it("forgets a bus that stops reporting", () => {
    const field = new BusField(noTracks);
    field.ingest(snapshot([vehicle({ i: "gone" }), vehicle({ i: "stays" })]), 0);
    expect(field.size).toBe(2);

    // Seven minutes later, only one bus is still in the feed.
    field.ingest(snapshot([vehicle({ i: "stays" })]), 7 * 60_000);
    expect(field.size).toBe(1);
    expect(field.positionsAt(7 * 60_000)[0]!.id).toBe("stays");
  });

  it("keeps a bus that is merely quiet for one poll", () => {
    const field = new BusField(noTracks);
    field.ingest(snapshot([vehicle({ i: "a" }), vehicle({ i: "b" })]), 0);
    field.ingest(snapshot([vehicle({ i: "a" })]), 90_000);
    expect(field.size).toBe(2);
  });

  it("survives an empty snapshot without throwing", () => {
    const field = new BusField(noTracks);
    expect(() => field.ingest(snapshot([]), 0)).not.toThrow();
    expect(field.positionsAt(0)).toEqual([]);
  });

  it("carries each bus's delay through to the rendered position", () => {
    const field = new BusField(noTracks);
    field.ingest(snapshot([vehicle({ i: "behind", l: 420 }), vehicle({ i: "unknown" })]), 0);

    const byId = new Map(field.positionsAt(0).map((b) => [b.id, b.delay]));
    // A reported delay reaches the map so the late flag can read it.
    expect(byId.get("behind")).toBe(420);
    // No delay on the wire stays null, never a fabricated on-time reading.
    expect(byId.get("unknown")).toBeNull();
  });

  it("reports whether a bus is still on the map", () => {
    const field = new BusField(noTracks);
    field.ingest(snapshot([vehicle({ i: "a" }), vehicle({ i: "b" })]), 0);

    expect(field.has("a")).toBe(true);
    expect(field.has("never-seen")).toBe(false);
  });

  it("still holds a bus missing from one snapshot but not yet stale", () => {
    const field = new BusField(noTracks);
    field.ingest(snapshot([vehicle({ i: "a" }), vehicle({ i: "b" })]), 0);
    // "b" drops out of the feed for two minutes. It is still drawn, gliding on
    // its last sample, so anything keyed off has() must keep showing it.
    field.ingest(snapshot([vehicle({ i: "a" })]), 120_000);

    expect(field.has("b")).toBe(true);
  });

  it("forgets a bus once it has been gone long enough to leave the map", () => {
    const field = new BusField(noTracks);
    field.ingest(snapshot([vehicle({ i: "a" }), vehicle({ i: "b" })]), 0);
    // Past STALE_MS: dropStale removes "b", so it is no longer drawn.
    field.ingest(snapshot([vehicle({ i: "a" })]), 7 * 60_000);

    expect(field.has("b")).toBe(false);
    expect(field.has("a")).toBe(true);
  });
});

describe("isLate", () => {
  it("flags a bus at or past the threshold", () => {
    expect(isLate(LATE_THRESHOLD_SECONDS)).toBe(true);
    expect(isLate(LATE_THRESHOLD_SECONDS + 60)).toBe(true);
  });

  it("does not flag a bus only slightly behind", () => {
    // The exact case AUTOPILOT calls out: 40 seconds down is not "late".
    expect(isLate(40)).toBe(false);
    expect(isLate(LATE_THRESHOLD_SECONDS - 1)).toBe(false);
  });

  it("does not flag an early bus or one with no reading", () => {
    expect(isLate(-300)).toBe(false);
    expect(isLate(null)).toBe(false);
    expect(isLate(undefined)).toBe(false);
  });
});

describe("describeDelay", () => {
  it("reports lateness and earliness", () => {
    expect(describeDelay(null)).toBe("live");
    expect(describeDelay(300)).toBe("5 min late");
    expect(describeDelay(-180)).toBe("3 min early");
  });

  it("calls a sub-minute delay on time, per AUTOPILOT's 40-second example", () => {
    expect(describeDelay(40)).toBe("on time");
    expect(describeDelay(-40)).toBe("on time");
    expect(describeDelay(0)).toBe("on time");
  });

  it("never labels a bus '5 min late' unless the map would flag it", () => {
    // The card and the map must agree: a bus the label calls "5 min late"
    // must be one isLate() flags, or the status bar's "5+ min late" count and
    // the map halo silently exclude a bus the rider was just told is 5 min late.
    for (let delay = 0; delay <= 900; delay += 5) {
      const labelledFivePlus = /^([5-9]|\d\d+) min late$/.test(describeDelay(delay));
      expect(labelledFivePlus).toBe(isLate(delay));
    }
  });
});

describe("hasDeparted", () => {
  const now = 1_700_000_000;

  it("keeps a future or arriving-now departure", () => {
    expect(hasDeparted(now + 300, now)).toBe(false);
    expect(hasDeparted(now, now)).toBe(false);
  });

  it("keeps a bus within the just-left slack, matching the server", () => {
    // mergeArrivals keeps time >= now - 60, so the slack edge must still show.
    expect(hasDeparted(now - DEPARTED_SLACK_SECONDS, now)).toBe(false);
  });

  it("drops a bus past the slack instead of reading 'now' forever", () => {
    expect(hasDeparted(now - DEPARTED_SLACK_SECONDS - 1, now)).toBe(true);
    expect(hasDeparted(now - 150, now)).toBe(true);
  });
});

describe("hintText", () => {
  it("stays quiet while still connecting, even zoomed in", () => {
    // The status pill already says "Connecting…"; the hint must not race ahead
    // and declare live buses unavailable before the feed has resolved. The old
    // inline logic returned the "unavailable" message here, contradicting the
    // pill on the same screen.
    expect(hintText("connecting", true)).toBeNull();
  });

  it("guides a zoomed-out rider to zoom in, whatever the feed is doing", () => {
    expect(hintText("connecting", false)).toBe("Zoom in to see stops and departure times");
    expect(hintText("live", false)).toBe("Zoom in to see stops and departure times");
    expect(hintText("schedules-only", false)).toBe(
      "Zoom in to see stops and departure times",
    );
  });

  it("says buses are unavailable only once the feed has settled on schedules-only", () => {
    expect(hintText("schedules-only", true)).toBe(
      "Live buses are unavailable right now. Tap any stop for its timetable.",
    );
  });

  it("stays quiet when buses and stops are both showing", () => {
    expect(hintText("live", true)).toBeNull();
  });

  it("defers to the status pill for an error", () => {
    expect(hintText("error", true)).toBeNull();
    expect(hintText("error", false)).toBeNull();
  });
});

describe("describeAge", () => {
  const now = 1_700_000_000_000;
  const nowSeconds = Math.floor(now / 1000);

  it("reads seconds then minutes for a fresh feed", () => {
    expect(describeAge(nowSeconds - 12, now)).toBe("12s ago");
    expect(describeAge(nowSeconds - 90, now)).toBe("2 min ago");
    expect(describeAge(nowSeconds - 30 * 60, now)).toBe("30 min ago");
  });

  it("switches to hours so the overnight stale feed stays legible", () => {
    // The poller sleeps 23:00-07:00, so the map carries the last evening poll
    // and the age climbs past an hour. Minutes alone print "480 min ago".
    expect(describeAge(nowSeconds - 8 * 3600, now)).toBe("8 hr ago");
    expect(describeAge(nowSeconds - 60 * 60, now)).toBe("1 hr ago");
  });

  it("returns nothing when the feed has no timestamp", () => {
    expect(describeAge(null, now)).toBe("");
    expect(describeAge(0, now)).toBe("");
  });

  it("never reads negative when the client clock lags the feed", () => {
    expect(describeAge(nowSeconds + 5, now)).toBe("0s ago");
  });
});

describe("isFeedStale", () => {
  const now = 1_700_000_000_000;
  const nowSeconds = Math.floor(now / 1000);

  it("treats a fresh feed as current", () => {
    expect(isFeedStale(nowSeconds - 30, now)).toBe(false);
    expect(isFeedStale(nowSeconds - 3 * 60, now)).toBe(false);
  });

  it("flags the overnight snapshot the poller left behind", () => {
    // 23:00-07:00 the poller sleeps and the map carries the last evening poll,
    // so a green "live" dot would tell a rider hours-old positions are current.
    expect(isFeedStale(nowSeconds - 8 * 3600, now)).toBe(true);
  });

  it("switches exactly at the threshold, not before", () => {
    expect(isFeedStale(nowSeconds - STALE_FEED_SECONDS, now)).toBe(false);
    expect(isFeedStale(nowSeconds - STALE_FEED_SECONDS - 1, now)).toBe(true);
  });

  it("is not stale when the feed has no timestamp", () => {
    // "connecting" and "schedules-only" own the no-timestamp case, not "live".
    expect(isFeedStale(null, now)).toBe(false);
    expect(isFeedStale(0, now)).toBe(false);
  });
});

describe("arrivalsErrorText", () => {
  it("tells an offline rider to check the connection, not a raw fetch error", () => {
    const text = arrivalsErrorText("offline");
    expect(text).toBe("Cannot reach the network. Check your connection.");
    // Never leak the developer-facing cause to a rider.
    expect(text).not.toMatch(/fetch|responded|\d{3}/);
  });

  it("tells a rider a server failure is temporary, not a broken stop", () => {
    const text = arrivalsErrorText("unavailable");
    expect(text).toBe("Arrivals are unavailable right now. Try again shortly.");
    expect(text).not.toMatch(/fetch|responded|\d{3}/);
  });
});

describe("countdown", () => {
  const now = 1_700_000_000_000;
  const nowSeconds = Math.floor(now / 1000);

  it("reads 'now' inside the last half-minute", () => {
    // Under 30s the bus is right there; "0 min" would help nobody.
    expect(countdown(nowSeconds + 10, now)).toBe("now");
    expect(countdown(nowSeconds + 29, now)).toBe("now");
    // A time already past still reads "now", not a negative count.
    expect(countdown(nowSeconds - 40, now)).toBe("now");
  });

  it("counts whole minutes within the hour", () => {
    expect(countdown(nowSeconds + 30, now)).toBe("1 min");
    expect(countdown(nowSeconds + 4 * 60, now)).toBe("4 min");
    expect(countdown(nowSeconds + 59 * 60, now)).toBe("59 min");
  });

  it("switches to a clock time past an hour", () => {
    // "73 min" is harder to act on than a wall-clock time.
    const at = countdown(nowSeconds + 90 * 60, now);
    expect(at).not.toMatch(/\bmin\b/);
    expect(at).toMatch(/\d/);
  });
});

describe("describeArrival", () => {
  const now = 1_700_000_000_000;
  const nowSeconds = Math.floor(now / 1000);

  it("names the arrival with the right verb for each countdown shape", () => {
    expect(describeArrival(nowSeconds + 10, now)).toBe("arriving now");
    expect(describeArrival(nowSeconds + 4 * 60, now)).toBe("arriving in 4 min");
  });

  it("says 'arriving at' a clock time past an hour, never 'in'", () => {
    // The " min" branch must not swallow a clock time like "5:12 p.m.".
    const text = describeArrival(nowSeconds + 90 * 60, now);
    expect(text).toMatch(/^arriving at /);
    expect(text).not.toContain(" min");
  });
});

describe("markerShapeFor", () => {
  it("draws a chevron below the bus-icon zoom, where the whole region is on screen", () => {
    expect(markerShapeFor(BUS_ICON_MIN_ZOOM - 0.01)).toBe("chevron");
    expect(markerShapeFor(11)).toBe("chevron");
  });

  it("draws a bus at the threshold and above", () => {
    expect(markerShapeFor(BUS_ICON_MIN_ZOOM)).toBe("bus");
    expect(markerShapeFor(16)).toBe("bus");
  });
});

describe("shouldClearFollow", () => {
  it("keeps following when the same bus is reselected", () => {
    // This is the 90-second-refresh case: apply() re-selects the followed
    // bus on every snapshot, and that must not cancel the follow.
    expect(shouldClearFollow({ id: "bus-1" }, "bus-1")).toBe(false);
  });

  it("clears when a different bus is selected", () => {
    expect(shouldClearFollow({ id: "bus-2" }, "bus-1")).toBe(true);
  });

  it("clears when the selection is cleared entirely", () => {
    expect(shouldClearFollow(null, "bus-1")).toBe(true);
  });

  it("stays cleared when nothing was being followed", () => {
    expect(shouldClearFollow({ id: "bus-1" }, null)).toBe(false);
  });
});

const rendered = (over: Partial<RenderedBus> = {}): RenderedBus => ({
  id: "a",
  routeId: "route1",
  tripId: "trip1",
  lat: 49.28,
  lon: -123.12,
  bearing: 0,
  moving: true,
  delay: null,
  ...over,
});

/** Roughly north by `metres`, at Vancouver's latitude. */
const northOf = (lat: number, metres: number) => lat + metres / 111_320;

describe("findBunches", () => {
  it("finds two buses on one route sitting on top of each other", () => {
    const bunches = findBunches([
      rendered({ id: "a" }),
      rendered({ id: "b", lat: northOf(49.28, 80) }),
    ]);
    expect(bunches).toHaveLength(1);
    expect([...(bunches[0]?.busIds ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("leaves the same two alone once they are properly spaced", () => {
    expect(
      findBunches([rendered({ id: "a" }), rendered({ id: "b", lat: northOf(49.28, 900) })]),
    ).toEqual([]);
  });

  it("does not bunch buses on different routes", () => {
    expect(
      findBunches([
        rendered({ id: "a", routeId: "route1" }),
        rendered({ id: "b", routeId: "route2", lat: northOf(49.28, 50) }),
      ]),
    ).toEqual([]);
  });

  it("does not bunch buses going opposite ways", () => {
    // Two buses passing on the same street are the timetable working, not
    // bunching. Only the same direction counts.
    expect(
      findBunches([
        rendered({ id: "a", bearing: 0 }),
        rendered({ id: "b", bearing: 180, lat: northOf(49.28, 50) }),
      ]),
    ).toEqual([]);
  });

  it("does not bunch buses parked at a terminus", () => {
    // Exercises the real mechanism behind "moving", not a hand-set flag: two
    // buses that keep transmitting but report the same spot on both polls.
    const field = new BusField(noTracks);
    const a = vehicle({ i: "a", y: 49.28, x: -123.12 });
    const b = vehicle({ i: "b", y: northOf(49.28, 30), x: -123.12 });
    field.ingest(snapshot([a, b]), 0);
    field.ingest(snapshot([a, b]), 90_000);

    expect(findBunches(field.positionsAt(90_000))).toEqual([]);
  });

  it("does not bunch buses the feed gave no route for", () => {
    // Two route-less buses share the empty route id, so without a guard they
    // group together and the map draws a line between buses that have no route
    // in common. The status bar's bunched count inflates with them.
    expect(
      findBunches([
        rendered({ id: "a", routeId: "" }),
        rendered({ id: "b", routeId: "", lat: northOf(49.28, 50) }),
      ]),
    ).toEqual([]);
  });

  it("detects a bunch from the sample just ingested, not the last drawn frame", () => {
    // The reason BusMap passes glide=false here. ingest() resets startedAt for
    // every bus in the snapshot, so a gliding read at that instant returns where
    // each bus was being DRAWN a moment earlier — a whole poll interval stale.
    // These two close from 800m apart to 100m, which straddles BUNCH_METRES, so
    // the gliding read misses the bunch entirely.
    const field = new BusField(noTracks);
    field.ingest(
      snapshot([
        vehicle({ i: "a", y: 49.28 }),
        vehicle({ i: "b", y: northOf(49.28, 800) }),
      ]),
      0,
    );
    field.ingest(
      snapshot([
        vehicle({ i: "a", y: northOf(49.28, 900) }),
        vehicle({ i: "b", y: northOf(49.28, 1000) }),
      ]),
      90_000,
    );

    expect(bunchesAt(field, 90_000)).toHaveLength(1);
    // What the call would have found without the rule bunchesAt carries.
    expect(findBunches(field.positionsAt(90_000))).toEqual([]);
  });

  it("groups three close buses as one bunch, not three pairs", () => {
    // a-b and b-c are each within BUNCH_METRES, but a-c (300m) is not: a naive
    // all-pairs clique would split this into two overlapping pairs or none.
    // The chain has to merge transitively through b to read as one bunch.
    const bunches = findBunches([
      rendered({ id: "a" }),
      rendered({ id: "b", lat: northOf(49.28, 150) }),
      rendered({ id: "c", lat: northOf(49.28, 300) }),
    ]);
    expect(bunches).toHaveLength(1);
    expect(bunches[0]?.busIds).toHaveLength(3);
  });

  it("returns nothing for an empty field or a single bus", () => {
    expect(findBunches([])).toEqual([]);
    expect(findBunches([rendered()])).toEqual([]);
  });

  it("treats bearings either side of north as the same direction", () => {
    const bunches = findBunches([
      rendered({ id: "a", bearing: 350 }),
      rendered({ id: "b", bearing: 10, lat: northOf(49.28, 50) }),
    ]);
    expect(bunches).toHaveLength(1);
  });
});
