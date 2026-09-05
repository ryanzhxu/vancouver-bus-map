/**
 * Polyline maths for gliding buses along their real route geometry.
 *
 * The position feed samples every 90 seconds, which is 400-600m of travel. A
 * straight tween between samples cuts corners and drives buses through
 * buildings. Instead we project each sample onto the route's own polyline and
 * animate along that line, so a bus turning a corner actually turns.
 *
 * Coordinates are [lat, lon] degrees, matching the shape artifacts. Longitude
 * degrees are narrower than latitude degrees away from the equator, so every
 * distance here scales longitude by cos(latitude). That makes the units
 * "equivalent degrees of latitude" — consistent, and close enough to metres
 * (1 degree ~ 111km) for projection and interpolation.
 */

export type LatLon = [number, number];

/** Vancouver sits near 49.25 degrees north. */
const REFERENCE_LAT_RAD = (49.25 * Math.PI) / 180;
const LON_SCALE = Math.cos(REFERENCE_LAT_RAD);

/** A polyline with cumulative distances precomputed for fast lookup. */
export interface Track {
  points: LatLon[];
  /** cumulative[i] is the distance from points[0] to points[i]. */
  cumulative: number[];
  length: number;
}

export function buildTrack(points: LatLon[]): Track {
  const cumulative: number[] = new Array(points.length);
  cumulative[0] = 0;

  for (let i = 1; i < points.length; i++) {
    cumulative[i] = cumulative[i - 1]! + distance(points[i - 1]!, points[i]!);
  }

  return {
    points,
    cumulative,
    length: points.length > 0 ? cumulative[points.length - 1]! : 0,
  };
}

export function distance(a: LatLon, b: LatLon): number {
  const dLat = b[0] - a[0];
  const dLon = (b[1] - a[1]) * LON_SCALE;
  return Math.hypot(dLat, dLon);
}

/**
 * Nearest point on the track to `p`, as a distance along the track.
 *
 * `hintDistance` biases the search when we already know roughly where the bus
 * is. Routes that double back on themselves — the 99 at UBC loop, most SkyTrain
 * lines at their termini — pass within metres of themselves, and without a hint
 * a bus can snap to the wrong leg and appear to teleport backwards.
 */
export function projectOntoTrack(
  track: Track,
  p: LatLon,
  hintDistance?: number,
): { distanceAlong: number; offTrack: number } {
  if (track.points.length === 0) return { distanceAlong: 0, offTrack: Infinity };
  if (track.points.length === 1) {
    return { distanceAlong: 0, offTrack: distance(track.points[0]!, p) };
  }

  let best = { distanceAlong: 0, offTrack: Infinity };
  let bestScore = Infinity;

  for (let i = 0; i < track.points.length - 1; i++) {
    const a = track.points[i]!;
    const b = track.points[i + 1]!;
    const segmentLength = track.cumulative[i + 1]! - track.cumulative[i]!;
    if (segmentLength === 0) continue;

    const t = clamp01(projectionParameter(p, a, b));
    const closest: LatLon = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const offTrack = distance(closest, p);
    const distanceAlong = track.cumulative[i]! + segmentLength * t;

    // Prefer a slightly worse fit that is near where we expect the bus to be
    // over a perfect fit half a route away.
    const penalty =
      hintDistance === undefined ? 0 : Math.abs(distanceAlong - hintDistance) * 0.02;
    const score = offTrack + penalty;

    if (score < bestScore) {
      bestScore = score;
      best = { distanceAlong, offTrack };
    }
  }

  return best;
}

/** The point at `target` distance along the track. */
export function pointAtDistance(track: Track, target: number): LatLon {
  if (track.points.length === 0) return [0, 0];
  if (track.points.length === 1) return track.points[0]!;

  const clamped = Math.max(0, Math.min(track.length, target));

  // Binary search for the segment containing `clamped`.
  let lo = 0;
  let hi = track.cumulative.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (track.cumulative[mid]! <= clamped) lo = mid;
    else hi = mid;
  }

  const a = track.points[lo]!;
  const b = track.points[lo + 1] ?? a;
  const segmentLength = (track.cumulative[lo + 1] ?? track.length) - track.cumulative[lo]!;
  const t = segmentLength === 0 ? 0 : (clamped - track.cumulative[lo]!) / segmentLength;

  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Compass bearing in degrees, for pointing the bus marker.
 *
 * TransLink does not populate the bearing field on any vehicle, so heading has
 * to be derived from where the bus came from and where it is going.
 */
export function bearingAt(track: Track, target: number): number {
  const ahead = pointAtDistance(track, Math.min(track.length, target + 0.0002));
  const behind = pointAtDistance(track, Math.max(0, target - 0.0002));
  return bearingBetween(behind, ahead);
}

export function bearingBetween(from: LatLon, to: LatLon): number {
  const dLat = to[0] - from[0];
  const dLon = (to[1] - from[1]) * LON_SCALE;
  if (dLat === 0 && dLon === 0) return 0;
  const degrees = (Math.atan2(dLon, dLat) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** Straight-line fallback for buses whose shape we do not have. */
export function lerp(a: LatLon, b: LatLon, t: number): LatLon {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}

function projectionParameter(p: LatLon, a: LatLon, b: LatLon): number {
  const dLat = b[0] - a[0];
  const dLon = (b[1] - a[1]) * LON_SCALE;
  const denominator = dLat * dLat + dLon * dLon;
  if (denominator === 0) return 0;
  return ((p[0] - a[0]) * dLat + (p[1] - a[1]) * LON_SCALE * dLon) / denominator;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
