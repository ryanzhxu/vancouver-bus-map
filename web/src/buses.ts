import {
  bearingAt,
  bearingBetween,
  buildTrack,
  lerp,
  pointAtDistance,
  projectOntoTrack,
  type LatLon,
  type Track,
} from "./geo.js";

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
}

export interface RenderedBus {
  id: string;
  routeId: string;
  tripId: string;
  lat: number;
  lon: number;
  bearing: number;
  /** True while gliding between two real samples. */
  moving: boolean;
  /** Delay against schedule in seconds, or null when the feed gave none. */
  delay: number | null;
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

interface BusState {
  id: string;
  routeId: string;
  tripId: string;
  from: LatLon;
  to: LatLon;
  /** Distances along the track, when we have geometry for this trip. */
  fromDistance: number | null;
  toDistance: number | null;
  track: Track | null;
  startedAt: number;
  durationMs: number;
  lastSeen: number;
  delay: number | null;
}

/** Drop a bus that has not appeared in this many milliseconds. */
const STALE_MS = 6 * 60_000;

/**
 * Holds every bus and answers "where is each one right now".
 *
 * Positions arrive every 90 seconds. Between samples each bus glides along its
 * route's polyline, so the map moves continuously instead of stepping. A bus
 * with no geometry falls back to a straight line, which is visibly worse but
 * never wrong enough to matter for a single sample.
 */
export class BusField {
  private buses = new Map<string, BusState>();
  private tracks: (tripId: string, routeId: string) => Track | null;

  constructor(trackLookup: (tripId: string, routeId: string) => Track | null) {
    this.tracks = trackLookup;
  }

  get size(): number {
    return this.buses.size;
  }

  /**
   * True while this bus is still drawn on the map.
   *
   * A bus missing from one snapshot is still here — it keeps gliding on its
   * last sample until dropStale gives up on it. Callers that hold their own
   * per-bus record use this to tell "briefly absent" from "gone".
   */
  has(id: string): boolean {
    return this.buses.has(id);
  }

  /** Fold a new snapshot in, starting a fresh glide for every bus that moved. */
  ingest(snapshot: Snapshot, now = Date.now()): void {
    const durationMs = Math.max(1000, snapshot.pollSeconds * 1000);

    for (const v of snapshot.vehicles) {
      const target: LatLon = [v.y, v.x];
      const existing = this.buses.get(v.i);
      const track = this.tracks(v.t, v.r);

      // Start the glide from wherever the bus is being drawn right now, not
      // from the previous sample. Otherwise a late snapshot makes it jump back.
      const from = existing ? this.positionOf(existing, now).point : target;

      const fromDistance = track ? projectOntoTrack(track, from, existing?.toDistance ?? undefined).distanceAlong : null;
      const toDistance = track
        ? projectOntoTrack(track, target, fromDistance ?? undefined).distanceAlong
        : null;

      this.buses.set(v.i, {
        id: v.i,
        routeId: v.r,
        tripId: v.t,
        from,
        to: target,
        fromDistance,
        toDistance,
        track,
        startedAt: now,
        durationMs,
        lastSeen: now,
        delay: v.l ?? null,
      });
    }

    this.dropStale(now);
  }

  /**
   * Every bus, positioned for this instant.
   *
   * When `glide` is false, each bus snaps to its latest reported sample instead
   * of tweening toward it, so nothing moves between snapshots. The map reads
   * `prefers-reduced-motion` and passes false there: the buses then step to a
   * new position on each poll rather than sliding, which the animation itself
   * must honor because the glide is driven by requestAnimationFrame, not CSS —
   * the stylesheet's reduced-motion rule cannot reach it.
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
      });
    }

    return out;
  }

  private positionOf(
    bus: BusState,
    now: number,
    glide = true,
  ): { point: LatLon; bearing: number; moving: boolean } {
    // Snapping (reduced motion) shows the latest sample outright, so progress
    // is pinned to 1 and the bus never reads as moving between polls.
    const progress = glide ? clamp01((now - bus.startedAt) / bus.durationMs) : 1;
    const moving = progress < 1;

    if (bus.track && bus.fromDistance !== null && bus.toDistance !== null) {
      // Guard against a bad projection sending the bus backwards along the
      // route. Buses do reverse at termini, but not 2km in 90 seconds.
      const delta = bus.toDistance - bus.fromDistance;
      if (Math.abs(delta) < MAX_GLIDE_DEGREES) {
        const along = bus.fromDistance + delta * progress;
        const heading = bearingAt(bus.track, along);
        return {
          point: pointAtDistance(bus.track, along),
          // Travelling backwards along the shape means the bus faces the other way.
          bearing: delta < 0 ? (heading + 180) % 360 : heading,
          moving,
        };
      }
    }

    return {
      point: lerp(bus.from, bus.to, progress),
      bearing: bearingBetween(bus.from, bus.to),
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
 * About 3.3km in equivalent latitude degrees, or roughly 130km/h over a
 * 90-second poll. Past that, the projection has almost certainly snapped to the
 * wrong leg of a route that doubles back, so we fall back to a straight line.
 *
 * Do not tighten this to "normal bus speed". Highway coaches on the 555 and the
 * 620 to the ferry genuinely cover 2.5km between polls, and clipping them would
 * make the express routes the ones that look broken.
 */
const MAX_GLIDE_DEGREES = 0.03;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Convenience for callers holding raw shape arrays. */
export function trackFromPoints(points: LatLon[]): Track {
  return buildTrack(points);
}
