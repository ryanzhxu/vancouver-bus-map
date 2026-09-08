import {
  bearingAt,
  bearingBetween,
  buildTrack,
  distance,
  pointAtDistance,
  projectOntoTrack,
  type LatLon,
  type Track,
} from "./geo.js";
import {
  MAX_SPEED_DEGREES_PER_MS,
  confidence,
  observedSpeed,
  predictDistance,
  type Fix,
} from "./predict.js";

/** A vehicle as it arrives on the wire. Keys are short to keep payloads small. */
export interface WireVehicle {
  i: string;
  r: string;
  t: string;
  y: number;
  x: number;
  s: number;
  p: string;
  /** shape id, joined server-side from the static trips index */
  h?: string;
  /** trip headsign */
  d?: string;
  /** predicted arrival at the next stop, absolute epoch seconds */
  a?: number;
  /** delay against schedule in seconds; negative is early */
  l?: number;
}

export interface Snapshot {
  type: "snapshot";
  generatedAt: number;
  feedTimestamp: number | null;
  pollSeconds: number;
  vehicles: WireVehicle[];
  /**
   * Each vehicle's [lat, lon] from the tick before this one, keyed by entity
   * id. Only present on the snapshot a client gets on first connect — see
   * BusField.ingest, which uses it to seed a bus this client has never seen
   * from a real prior fix instead of freezing it until the next live update.
   */
  previous?: Record<string, [number, number]>;
}

export interface RenderedBus {
  id: string;
  routeId: string;
  tripId: string;
  lat: number;
  lon: number;
  bearing: number;
  /**
   * True when the bus displaced between its last two reported fixes by more
   * than the jitter threshold. Measured on the fixes themselves, never on the
   * drawn position, so a prediction can never invent movement.
   */
  moving: boolean;
  /** Delay against schedule in seconds, or null when the feed gave none. */
  delay: number | null;
  /**
   * 0-1, how much of this position is measured rather than predicted. Full on
   * the tick a fix lands and decaying until the next one. The map fades the
   * marker with it, so a bus the feed has not confirmed lately looks less
   * certain instead of looking like fact.
   */
  confidence: number;
}

/**
 * A bus this many seconds behind schedule is flagged "late" on the map.
 *
 * Five minutes, not forty seconds: a rider waiting for the next bus does not
 * feel a bus that is barely behind, and TransLink's own predictions drift by a
 * minute or two between polls. Below this, a flag would cry wolf. The map's
 * legend names this number so the colour is never unexplained.
 */
export const LATE_THRESHOLD_SECONDS = 300;

/** True when a bus is late enough to flag. A missing or early delay is not. */
export function isLate(delay: number | null | undefined): boolean {
  return delay != null && delay >= LATE_THRESHOLD_SECONDS;
}

/**
 * In words how far a bus is off schedule, e.g. "5 min late", "2 min early".
 *
 * The figure is completed minutes (truncated toward zero), not rounded, for two
 * reasons. First, "N min late" must agree with the map flag: isLate() fires at
 * LATE_THRESHOLD_SECONDS (5 min exactly), so rounding would let a bus 4.5 min
 * behind read "5 min late" on the card while the map halo and the status bar's
 * "5+ min late" count silently excluded it. Truncating makes "5 min late" mean
 * delay >= 300, matching the flag. Second, a sub-minute delay reads "on time",
 * per AUTOPILOT's own example that "a bus 40 seconds down is not late" — where
 * rounding would have called a 40-second bus "1 min late".
 */
export function describeDelay(delay: number | null): string {
  if (delay === null) return "live";
  const minutes = Math.trunc(delay / 60);
  if (minutes <= -1) return `${Math.abs(minutes)} min early`;
  if (minutes >= 1) return `${minutes} min late`;
  return "on time";
}

/**
 * How long ago the feed last reported, in words, e.g. "12s ago", "3 min ago".
 *
 * Past an hour the figure switches to hours. The poller sleeps 23:00–07:00
 * Pacific, so overnight the map carries the last evening poll and this age
 * climbs into the hundreds of minutes — "480 min ago" is unreadable, while
 * "8 hr ago" tells a rider at a glance the buses are from last night. `now` is
 * a parameter so the reading is deterministic under test.
 */
export function describeAge(feedTime: number | null, now = Date.now()): string {
  if (!feedTime) return "";
  const seconds = Math.max(0, Math.round(now / 1000 - feedTime));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(seconds / 3600);
  return `${hours} hr ago`;
}

/**
 * How old the live feed may be before its indicator reads stale, in seconds.
 *
 * The poller updates every 30 seconds, so a healthy feed's age stays well under
 * a minute even with the feed's own build lag. Past this the feed is not
 * updating: the poller sleeps 23:00–07:00 Pacific and the map then carries the
 * last evening poll, and a daytime feed outage ages the same way. Five minutes
 * clears normal jitter (about two poll cycles) yet still catches both cases.
 */
export const STALE_FEED_SECONDS = 300;

/**
 * "next update in Ns", or "updating…" once the moment has arrived.
 *
 * `nextRefreshAt` is the snapshot's own `generatedAt` plus the feed's poll
 * cadence — the server's clock, not this client's. A fresh connect is
 * usually answered from the Durable Object's cached last tick (see
 * BusField.ingest's `seed` branch), generated anywhere up to one poll
 * interval ago; timing the countdown from THIS client's receipt of that
 * stale snapshot would show a full cadence's worth of "next update" every
 * single page load, whether or not a tick is actually imminent. describeAge
 * already mixes a server epoch into a client `now` the same way for the
 * same reason — display text tolerates the clock-skew risk BusField.ingest's
 * position math cannot. Network and processing lag can still carry this a
 * little past due before the next snapshot lands, so a non-positive
 * remainder reads "updating…" rather than counting into negative seconds.
 */
export function nextRefreshText(nextRefreshAt: number, now = Date.now()): string {
  const seconds = Math.round((nextRefreshAt - now) / 1000);
  if (seconds <= 0) return "updating…";
  return `next update in ${seconds}s`;
}

/**
 * True when the live feed is old enough that its positions are no longer
 * current. The status dot then reads amber instead of the green of a fresh
 * feed, so a rider is never told hours-old overnight positions are live beside
 * a green light. A missing feedTime is not stale: the "connecting" and
 * "schedules-only" states own that case, not "live".
 */
export function isFeedStale(feedTime: number | null, now = Date.now()): boolean {
  if (!feedTime) return false;
  return now / 1000 - feedTime > STALE_FEED_SECONDS;
}

/**
 * How long a departure keeps showing after its time passes, in seconds.
 *
 * Mirrors the "keep a minute of slack so a bus that just left is still listed"
 * rule mergeArrivals applies server-side (src/arrivals.ts). A bus that left
 * within this window still reads "now", which is honest — it is right there.
 */
export const DEPARTED_SLACK_SECONDS = 60;

/**
 * True once a departure is far enough past that it is gone, not "now".
 *
 * The stop card fetches every 90 seconds but ticks the client clock every
 * second, and its countdown() prints "now" for any past time. Without this a
 * departure that was already at the server's 60-second slack edge when fetched
 * kept reading "now" for the rest of the fetch window — up to ~150 seconds
 * after the bus actually left. Re-applying the server's own freshness rule on
 * every tick drops such a row instead. It can only remove a row the next fetch
 * would drop too, so it never hides a still-valid arrival.
 */
export function hasDeparted(timeSeconds: number, nowSeconds: number): boolean {
  return nowSeconds - timeSeconds > DEPARTED_SLACK_SECONDS;
}

/** The feed states the map reports to the UI. Mirrors FeedState["kind"]. */
export type FeedKind = "connecting" | "live" | "schedules-only" | "error";

/**
 * The one-line guidance shown over the map, or null when none is needed.
 *
 * `stopsVisible` is true once the map is zoomed far enough to draw stops
 * (zoom 14). The message tells a rider what they can do right now: zoom in for
 * timetables, or that live buses are unavailable but stops still work.
 *
 * "Live buses are unavailable" is only honest once the feed has actually
 * settled on schedules-only. While still "connecting" we do not yet know, and
 * the status pill already says "Connecting…", so claiming buses are gone would
 * contradict it on the same screen. An error surfaces its own message in the
 * status pill, so the hint stays quiet there too.
 */
export function hintText(kind: FeedKind, stopsVisible: boolean): string | null {
  if (kind === "error") return null;
  if (kind === "live" && stopsVisible) return null;
  if (!stopsVisible) return "Zoom in to see stops and departure times";
  if (kind === "schedules-only") {
    return "Live buses are unavailable right now. Tap any stop for its timetable.";
  }
  // Zoomed in but still connecting: not concluded yet, so say nothing.
  return null;
}

/** Why a stop's arrivals could not load. */
export type ArrivalsFailure = "offline" | "unavailable";

/**
 * A rider-facing reason the arrivals did not load, in words a rider can act on.
 *
 * The stop card fetches /api/stop over the network, which fails two ways: the
 * phone lost its connection ("offline"), or the server answered but could not
 * build the list ("unavailable" — e.g. no GTFS build is published yet). Either
 * way the raw cause is a developer string ("responded 503", "Failed to fetch")
 * that means nothing to a rider, so map it to plain guidance instead.
 */
export function arrivalsErrorText(failure: ArrivalsFailure): string {
  if (failure === "offline") {
    return "Cannot reach the network. Check your connection.";
  }
  return "Arrivals are unavailable right now. Try again shortly.";
}

/**
 * A departure time in words, counting down, e.g. "now", "4 min", "5:12 p.m.".
 *
 * Under 30 seconds reads "now": the bus is right there, and a rider does not
 * benefit from "0 min". Within the hour it counts whole minutes. Past an hour
 * it switches to a clock time, since "73 min" is harder to act on than "5:12".
 * `now` is a parameter so the reading is deterministic under test.
 */
export function countdown(epochSeconds: number, now = Date.now()): string {
  const seconds = epochSeconds - Math.floor(now / 1000);
  if (seconds < 30) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return new Date(epochSeconds * 1000).toLocaleTimeString("en-CA", {
    timeZone: "America/Vancouver",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The selected bus's live prediction as a sentence, e.g. "arriving in 4 min".
 *
 * Wraps countdown() with the verb a rider reads on the bus card: "now" becomes
 * "arriving now", a minute count becomes "arriving in N min", and a clock time
 * becomes "arriving at TIME". The branch keys on countdown's " min" suffix,
 * which only its minute reading carries — "now" is caught first and a clock
 * time never ends that way.
 */
export function describeArrival(epochSeconds: number, now = Date.now()): string {
  const when = countdown(epochSeconds, now);
  if (when === "now") return "arriving now";
  if (when.endsWith(" min")) return `arriving in ${when}`;
  return `arriving at ${when}`;
}

interface BusState {
  id: string;
  routeId: string;
  tripId: string;
  track: Track | null;
  /**
   * The two most recent fixes as distances along the track. `prev.d` is 0 and
   * unused when there is no geometry; only `prev.t` matters in that case.
   */
  last: Fix;
  prev: Fix | null;
  /** The same two fixes as raw points, for buses with no geometry. */
  lastPoint: LatLon;
  prevPoint: LatLon | null;
  /**
   * How far along the track the previous prediction was from the fix that
   * just landed. Added to the new prediction and decayed to zero, so a wrong
   * guess is corrected by sliding rather than by teleporting.
   */
  correction: number;
  correctedAt: number;
  lastSeen: number;
  delay: number | null;
}

/**
 * The minimum time a bus takes to absorb the error in its last prediction.
 *
 * Extrapolation is a guess, so every fix arrives disagreeing with the marker
 * on screen by some tens of metres. Snapping to the truth would make 900
 * markers twitch in unison on every poll, which reads as a broken map even
 * though each individual correction is small and correct.
 *
 * Instead the error is carried forward and bled off over at least 1.5
 * seconds — short enough that the marker is honest again long before the
 * next fix, and far shorter than the poll interval, so this adds no
 * systematic lag the way the old poll-length tween did. distanceAt stretches
 * this floor for a correction too large to absorb at a plausible bus speed —
 * see MAX_CORRECTION_DEGREES_PER_MS.
 */
const CORRECTION_MS = 1500;

/**
 * The fastest a correction is ever allowed to visually travel.
 *
 * A seeded bus (BusField.ingest's `seed` branch) stamps its fix with the
 * client's connect time, not the true time the fix was taken — a client
 * connecting mid-cycle can be seeded from data already stale by up to one
 * poll interval. The glide quietly falls behind during that stretch, so the
 * next real fix can disagree with the drawn position by far more than the
 * "tens of metres" CORRECTION_MS was sized for. Bleeding a correction that
 * large off in a fixed 1.5s reads as the bus teleporting. Capping the rate
 * instead of the duration — at the same ceiling `observedSpeed` uses to
 * reject an impossible fix — makes a big correction take proportionally
 * longer, but never look like it is moving faster than a bus can.
 */
const MAX_CORRECTION_DEGREES_PER_MS = MAX_SPEED_DEGREES_PER_MS;

/** Drop a bus that has not appeared in this many milliseconds. */
const STALE_MS = 6 * 60_000;

/**
 * Holds every bus and answers "where is each one right now".
 *
 * Positions arrive on a fixed poll, and between them each bus is projected
 * forward along its route's polyline at its own observed speed — so the
 * marker shows where the bus most likely is, not where it was last confirmed
 * to be. A bus with no geometry falls back to a straight line, which is
 * visibly worse but never wrong enough to matter for a single sample.
 */
export class BusField {
  private buses = new Map<string, BusState>();
  private tracks: (tripId: string, routeId: string) => Track | null;
  /** Poll cadence from the most recent snapshot, for confidence decay. */
  private pollMs = 30_000;
  /**
   * generatedAt of the last snapshot actually folded in, to spot a redundant
   * delivery of a poll already ingested.
   *
   * BusMap.connect() opens the WebSocket and fires an immediate REST poll in
   * the same breath, and the DO answers both from the same cached snapshot
   * when no real tick landed in between — so a client's very first bus is
   * typically ingested twice within milliseconds of each other. Without this
   * guard the second call sees the first call's fix as "existing" and rebases
   * prev/last on it with almost no elapsed time, computing a near-zero
   * velocity that permanently overwrites the real one the first call just
   * established — every bus glides once, then freezes until the next actual
   * poll (which, outside the service window, never comes).
   */
  private lastGeneratedAt: number | null = null;

  constructor(trackLookup: (tripId: string, routeId: string) => Track | null) {
    this.tracks = trackLookup;
  }

  get size(): number {
    return this.buses.size;
  }

  /**
   * True while this bus is still drawn on the map.
   *
   * A bus missing from one snapshot is still here — it keeps being projected
   * forward from its last fix until dropStale gives up on it. Callers that
   * hold their own per-bus record use this to tell "briefly absent" from
   * "gone".
   */
  has(id: string): boolean {
    return this.buses.has(id);
  }

  /**
   * Fold a new snapshot in, re-basing every bus on the fix it just reported.
   * Returns false for a redundant re-delivery of a poll already ingested (see
   * lastGeneratedAt) — callers that schedule off the poll cadence, such as the
   * "next update in Ns" countdown, must skip those rather than restart it.
   */
  ingest(snapshot: Snapshot, now = Date.now()): boolean {
    // Same poll as last time: the eager REST pollOnce() and the WebSocket's
    // own "send current state on connect" both answer from this one cached
    // snapshot, so a fresh client typically gets it twice. Nothing has
    // actually moved, so there is nothing to fold in — see lastGeneratedAt.
    if (this.lastGeneratedAt !== null && snapshot.generatedAt === this.lastGeneratedAt) return false;
    this.lastGeneratedAt = snapshot.generatedAt;

    this.pollMs = Math.max(1000, snapshot.pollSeconds * 1000);
    // Every vehicle in a snapshot was sampled together, so they share one
    // timestamp — and that timestamp is when THIS client received it, not
    // snapshot.generatedAt. Extrapolation multiplies (now - fix time) by a
    // speed, and `now` is the browser's clock: mixing in a server timestamp
    // would multiply the clock skew between them by that speed too. A browser
    // several minutes out would fling every bus off the map. Transit latency
    // is small and roughly constant, so it cancels out of the speed estimate.
    const t = now;

    for (const v of snapshot.vehicles) {
      const point: LatLon = [v.y, v.x];
      const existing = this.buses.get(v.i);
      const track = this.tracks(v.t, v.r);
      // A bus this client has never seen: the server's first snapshot carries
      // its real prior fix (see Snapshot.previous) so it can be projected
      // forward immediately instead of sitting still until the next poll.
      const seed = existing ? undefined : snapshot.previous?.[v.i];

      // Where the marker is being drawn at this instant, before the new fix
      // replaces the basis of the prediction. Captured first, because the
      // correction below is measured against it.
      const drawn = existing && track ? this.distanceAt(existing, now) : null;

      const lastDistance = track
        ? projectOntoTrack(track, point, existing?.last.d).distanceAlong
        : 0;

      let prev: Fix | null = null;
      let prevPoint: LatLon | null = null;
      if (existing) {
        prev = existing.last;
        prevPoint = existing.lastPoint;
      } else if (seed) {
        prevPoint = seed;
        prev = {
          d: track ? projectOntoTrack(track, seed, lastDistance).distanceAlong : 0,
          t: t - this.pollMs,
        };
      }

      this.buses.set(v.i, {
        id: v.i,
        routeId: v.r,
        tripId: v.t,
        track,
        last: { d: lastDistance, t },
        prev,
        lastPoint: point,
        prevPoint,
        correction: drawn === null ? 0 : drawn - lastDistance,
        correctedAt: now,
        lastSeen: now,
        delay: v.l ?? null,
      });
    }

    this.dropStale(now);
    return true;
  }

  /**
   * Every bus, positioned for this instant.
   *
   * When `glide` is false, each bus sits on its latest reported fix instead of
   * being projected forward, so nothing moves between snapshots. The map reads
   * `prefers-reduced-motion` and passes false there, which the animation must
   * honor itself because it is driven by requestAnimationFrame, not CSS — the
   * stylesheet's reduced-motion rule cannot reach it.
   */
  positionsAt(now = Date.now(), glide = true): RenderedBus[] {
    const out: RenderedBus[] = [];

    for (const bus of this.buses.values()) {
      const { point, bearing, moving } = this.positionOf(bus, now, glide);
      out.push({
        id: bus.id,
        routeId: bus.routeId,
        tripId: bus.tripId,
        lat: point[0],
        lon: point[1],
        bearing,
        moving,
        delay: bus.delay,
        confidence: confidence(now - bus.last.t, this.pollMs),
      });
    }

    return out;
  }

  /**
   * Predicted distance along the track, with any outstanding correction.
   *
   * The horizon is capped at one poll interval: past that the next fix is
   * overdue, and a constant-velocity guess extended indefinitely is how a
   * missed poll turns into a bus in the ocean. Holding instead makes a stalled
   * feed look stalled, which — with the confidence fade — is the truth.
   */
  private distanceAt(bus: BusState, now: number): number {
    if (!bus.track) return 0;

    const base = predictDistance({
      last: bus.last,
      prev: bus.prev,
      now: Math.min(now, bus.last.t + this.pollMs),
      trackLength: bus.track.length,
    });

    if (bus.correction === 0) return base;

    // A correction bigger than CORRECTION_MS can bleed off at the capped
    // rate gets a longer window instead — see MAX_CORRECTION_DEGREES_PER_MS.
    const duration = Math.max(
      CORRECTION_MS,
      Math.abs(bus.correction) / MAX_CORRECTION_DEGREES_PER_MS,
    );
    const age = now - bus.correctedAt;
    if (age >= duration) return base;

    const remaining = 1 - Math.max(0, age) / duration;
    const corrected = base + bus.correction * remaining;
    return Math.max(0, Math.min(bus.track.length, corrected));
  }

  private positionOf(
    bus: BusState,
    now: number,
    glide = true,
  ): { point: LatLon; bearing: number; moving: boolean } {
    // A fact about the feed, not the animation: whether the bus displaced
    // between its last two fixes. Independent of `glide` on purpose — a parked
    // bus that keeps transmitting the same fix is re-ingested every snapshot
    // regardless, and reduced motion must not change what "moving" means.
    const moving =
      bus.prevPoint !== null &&
      distance(bus.prevPoint, bus.lastPoint) > MOVEMENT_THRESHOLD_METRES / METRES_PER_DEGREE;

    if (bus.track) {
      const along = glide ? this.distanceAt(bus, now) : bus.last.d;
      const heading = bearingAt(bus.track, along);
      const speed = observedSpeed(bus.prev, bus.last);
      return {
        point: pointAtDistance(bus.track, along),
        // Travelling backwards along the shape means the bus faces the other way.
        bearing: speed !== null && speed < 0 ? (heading + 180) % 360 : heading,
        moving,
      };
    }

    // No geometry: extrapolate the straight line between the last two fixes.
    if (!glide || bus.prev === null || bus.prevPoint === null || bus.last.t <= bus.prev.t) {
      return {
        point: bus.lastPoint,
        bearing: bus.prevPoint ? bearingBetween(bus.prevPoint, bus.lastPoint) : 0,
        moving,
      };
    }

    const interval = bus.last.t - bus.prev.t;
    // Two fixes arriving close together — a reconnect, or the first broadcast
    // right after the initial snapshot — imply a speed no bus reaches. The
    // track branch gets this guard from observedSpeed; here it has to be
    // applied to the straight line directly.
    if (distance(bus.prevPoint, bus.lastPoint) / interval > MAX_SPEED_DEGREES_PER_MS) {
      return { point: bus.lastPoint, bearing: bearingBetween(bus.prevPoint, bus.lastPoint), moving };
    }

    // Deliberately not geo.lerp: that clamps t to [0,1] for interpolation
    // between two known points, and this needs the opposite — a value past 1,
    // continuing the line beyond the newest fix. Capped at one poll interval
    // for the same reason distanceAt caps its horizon.
    const elapsed = Math.min(Math.max(0, now - bus.last.t), this.pollMs);
    const step = 1 + elapsed / interval;
    const [fromLat, fromLon] = bus.prevPoint;
    const [toLat, toLon] = bus.lastPoint;
    return {
      point: [fromLat + (toLat - fromLat) * step, fromLon + (toLon - fromLon) * step],
      bearing: bearingBetween(bus.prevPoint, bus.lastPoint),
      moving,
    };
  }

  private dropStale(now: number): void {
    for (const [id, bus] of this.buses) {
      if (now - bus.lastSeen > STALE_MS) this.buses.delete(id);
    }
  }
}


/**
 * A bus displaced less than this between its last two samples counts as
 * parked, not moving. A terminus or a layover holds several buses that keep
 * transmitting a GPS fix that wanders by a few metres of receiver jitter each
 * poll, and that jitter must not read as travel. Twenty metres over a
 * 30-second poll is about 2.4 km/h — comfortably clear of the jitter, and
 * still slower than walking, so nothing actually moving is called parked.
 */
const MOVEMENT_THRESHOLD_METRES = 20;

/** Convenience for callers holding raw shape arrays. */
export function trackFromPoints(points: LatLon[]): Track {
  return buildTrack(points);
}

/** Which silhouette a bus is drawn with at a given zoom. */
export type MarkerShape = "chevron" | "bus";

/**
 * The zoom at which bus markers become bus-shaped.
 *
 * Below this the whole region is on screen and every bus in Metro Vancouver is
 * drawn at once — several hundred on a quiet Saturday, far more at weekday
 * peak. A bus silhouette at that density is a smear, so the marker stays a
 * chevron, which still carries the one thing a smear cannot: which way the bus
 * is going. Matches the zoom at which route labels already appear, so the two
 * changes land together rather than one surprising the reader before the other.
 */
export const BUS_ICON_MIN_ZOOM = 13;

export function markerShapeFor(zoom: number): MarkerShape {
  return zoom >= BUS_ICON_MIN_ZOOM ? "bus" : "chevron";
}

/**
 * Whether a new selection should cancel an in-progress "follow this bus".
 *
 * The map's snapshot handler re-selects the same bus on every poll to
 * refresh the open card, which reaches this exact call path with a freshly
 * built object carrying the same id. Comparing ids rather than object
 * identity is what keeps that periodic refresh from silently ending a follow
 * that is otherwise still valid — get this backwards and following dies on
 * every poll with no test failure to catch it.
 *
 * When nothing is being followed there is nothing to clear, regardless of
 * what got selected.
 */
export function shouldClearFollow(
  next: { id: string } | null,
  followId: string | null,
): boolean {
  if (followId === null) return false;
  return !next || next.id !== followId;
}

/**
 * Two buses on one route closer than this, going the same way, are bunched.
 *
 * Roughly a city block. Closer than that and two buses on the same route read
 * as visibly together to a rider on the sidewalk; farther apart and they are
 * merely both somewhere on the same street.
 */
export const BUNCH_METRES = 200;

/**
 * How far two headings may differ and still count as the same direction.
 *
 * Generous on purpose. The bearing is derived from route geometry rather than
 * reported, so two buses a block apart on a curve genuinely differ by more than
 * a few degrees. Ninety degrees would admit a bus turning off the route;
 * forty-five separates "following each other" from "passing each other", which
 * is the distinction that matters.
 */
export const BUNCH_BEARING_TOLERANCE = 45;

/**
 * geo.ts measures in equivalent degrees of latitude. One degree of latitude is
 * about 111.32 km, which is what converts a metre threshold — BUNCH_METRES,
 * MOVEMENT_THRESHOLD_METRES — into those units.
 */
const METRES_PER_DEGREE = 111_320;

export interface Bunch {
  routeId: string;
  busIds: string[];
}

/** The smaller angle between two compass bearings, 0-180. */
export function bearingDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Groups of buses on the same route that have closed up on each other — the
 * "nothing for twenty minutes, then three at once" every rider knows.
 *
 * Two corrections stop it crying wolf. Both buses must be moving, because a
 * terminus or a layover parks several buses together by design and that is not
 * bunching. And both must be heading the same way, because two buses passing in
 * opposite directions on the same street is the timetable working correctly.
 *
 * Grouping is transitive: three buses in a line form one bunch of three, not
 * three overlapping pairs, which is how a rider would describe it.
 */
/**
 * The bunches in `field` at `now`, detected from the samples just ingested.
 *
 * Exists so the glide argument below is not a decision buried in a .tsx file
 * that no test can reach. It is load-bearing: a gliding read returns predicted
 * positions, which carry tens of metres of extrapolation error each, against
 * BUNCH_METRES's 200m — enough to invent a bunch or hide one. false returns the
 * fixes TransLink actually reported, so bunching is detected from measurements
 * only. The drawn lines still move between polls, because animate() does its
 * own gliding read.
 */
export function bunchesAt(field: BusField, now: number): Bunch[] {
  return findBunches(field.positionsAt(now, false));
}

export function findBunches(buses: RenderedBus[], metres = BUNCH_METRES): Bunch[] {
  const threshold = metres / METRES_PER_DEGREE;

  const byRoute = new Map<string, RenderedBus[]>();
  for (const bus of buses) {
    if (!bus.moving) continue;
    // A bus the feed gave no trip for arrives with routeId "" — the wire format
    // sends routeId ?? "" — and every such bus in the region shares it. Left in,
    // they group as one enormous "route" and any two of them that happen to pass
    // within BUNCH_METRES on similar bearings draw a line claiming a bunch
    // between buses that are not on the same route at all.
    if (!bus.routeId) continue;
    const fleet = byRoute.get(bus.routeId);
    if (fleet) fleet.push(bus);
    else byRoute.set(bus.routeId, [bus]);
  }

  const bunches: Bunch[] = [];

  for (const [routeId, fleet] of byRoute) {
    if (fleet.length < 2) continue;

    // Union-find by repeated merging: fleets on one route are small enough that
    // the simple form is faster to read than a proper union-find structure.
    const groups: RenderedBus[][] = [];

    for (const bus of fleet) {
      const near = groups.filter((group) =>
        group.some(
          (other) =>
            distance([bus.lat, bus.lon], [other.lat, other.lon]) <= threshold &&
            bearingDelta(bus.bearing, other.bearing) <= BUNCH_BEARING_TOLERANCE,
        ),
      );

      if (near.length === 0) {
        groups.push([bus]);
        continue;
      }

      // Joining two existing groups merges them, so a chain stays one bunch.
      const merged = near.flat();
      merged.push(bus);
      for (const group of near) groups.splice(groups.indexOf(group), 1);
      groups.push(merged);
    }

    for (const group of groups) {
      if (group.length < 2) continue;
      bunches.push({ routeId, busIds: group.map((bus) => bus.id) });
    }
  }

  return bunches;
}
