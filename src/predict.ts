/**
 * Forward extrapolation of a bus's position along its route.
 *
 * `web/src/buses.ts` tweens backwards: it slides a bus from where it was
 * drawn towards the latest *reported* fix, reaching it exactly as the next
 * poll lands. The animation is smooth, but the position is never current —
 * the marker is a full poll behind reality at every instant, not just at the
 * end. At 30s and a typical 7 m/s that is about 210m of standing error, and
 * it was 630m at the old 90s cadence.
 *
 * This module projects forward from the last fix instead, so the drawn
 * position is where the bus most likely is now rather than where it was
 * confirmed to be. The error stops being guaranteed lag and becomes
 * prediction error, which is both smaller and improvable.
 *
 * This is Phase 2: kinematics only, constant-velocity extrapolation from the
 * last two fixes. `PredictInput` stays narrow on purpose (no history array,
 * no per-route context) so a learned speed prior — for example a per-route
 * median speed used when the two-fix estimate is missing or implausible —
 * can slot in later as an alternative source for `speed`, without changing
 * this module's shape.
 *
 * Units match `geo.ts`: distance is "equivalent degrees of latitude"
 * (longitude scaled by cos(49.25 degrees)), time is epoch milliseconds.
 */

/** A single position sample along a route's track. */
export interface Fix {
  /** Distance along the route track, in equivalent degrees of latitude. */
  d: number;
  /** Epoch milliseconds of the fix. */
  t: number;
}

export interface PredictInput {
  last: Fix;
  prev: Fix | null;
  now: number;
  trackLength: number;
}

/**
 * Speeds faster than this are treated as a bad fix, not a fast bus.
 *
 * This is the same highway-coach ceiling `web/src/buses.ts` documents for
 * `MAX_GLIDE_DEGREES` (0.03 degrees over a 90-second poll, ~130km/h) — the
 * 555 and the 620 to the ferry genuinely travel that fast, so this must not
 * be tightened to "normal bus speed". Converted to degrees per millisecond
 * using the same ~111km/degree figure `geo.ts` uses for this unit:
 *
 *   130 km/h = 130 / 111 degrees/h ~= 1.1712 degrees/h
 *            = 1.1712 / 3,600,000 degrees/ms ~= 3.253e-7 degrees/ms
 */
const KM_PER_DEGREE = 111;
const MAX_SPEED_KMH = 130;
export const MAX_SPEED_DEGREES_PER_MS = MAX_SPEED_KMH / KM_PER_DEGREE / 3_600_000;

/** Speed in degrees per millisecond, or null when it cannot be established. */
export function observedSpeed(prev: Fix | null, last: Fix): number | null {
  if (prev === null || last.t <= prev.t) return null;

  const speed = (last.d - prev.d) / (last.t - prev.t);
  // A projection glitch or a route that doubles back can produce a jump no
  // real bus made — see MAX_SPEED_DEGREES_PER_MS above. Treat it as no
  // usable observation rather than extrapolating from it.
  if (Math.abs(speed) > MAX_SPEED_DEGREES_PER_MS) return null;

  return speed;
}

/** Distance along the track where the bus is predicted to be at `now`. */
export function predictDistance(input: PredictInput): number {
  const { last, prev, now, trackLength } = input;

  // Clock skew: a `now` before the last fix has no meaningful forward
  // distance to project, so hold the last known position.
  if (now < last.t) return last.d;

  const speed = observedSpeed(prev, last);
  if (speed === null) return last.d;

  const predicted = last.d + speed * (now - last.t);
  return Math.max(0, Math.min(trackLength, predicted));
}

/**
 * Trust decays as a predicted position ages past the last real fix.
 *
 * Full trust (1) while a prediction is no older than the fix itself. From
 * there it fades linearly to 0.6 by one poll interval old — a prediction
 * standing in for a single missed sample is still probably fine, since a
 * bus's speed rarely changes much over 90 seconds — then keeps fading to
 * 0.35 by two poll intervals old, and holds at 0.35 beyond that rather than
 * reaching zero: even a stale prediction beats snapping back to a fix that
 * is now minutes old.
 */
export function confidence(ageMs: number, pollMs: number): number {
  if (pollMs <= 0) return 1;
  if (ageMs <= 0) return 1;

  if (ageMs <= pollMs) return 1 - 0.4 * (ageMs / pollMs);
  if (ageMs <= 2 * pollMs) return 0.6 - 0.25 * ((ageMs - pollMs) / pollMs);

  return 0.35;
}
