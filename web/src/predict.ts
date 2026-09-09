/**
 * Small kinematics helpers `BusField` (`buses.ts`) builds a bus's on-map
 * position and freshness from.
 *
 * `observedSpeed` turns a bus's last two real fixes into a signed speed along
 * its route, used only to tell which way it is facing — never to project a
 * position beyond a fix TransLink actually reported. `confidence` says how
 * much to trust that a bus's last real fix still holds, fading as it ages.
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

/**
 * Speeds faster than this are treated as a bad fix, not a fast bus.
 *
 * The 555 and the 620 to the ferry genuinely travel highway speed, so this
 * must not be tightened to "normal bus speed". Converted to degrees per
 * millisecond using the same ~111km/degree figure `geo.ts` uses for this unit:
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
  // usable observation rather than trusting its direction.
  if (Math.abs(speed) > MAX_SPEED_DEGREES_PER_MS) return null;

  return speed;
}

/**
 * Trust decays as a bus's last real fix ages.
 *
 * Full trust (1) while a fix is fresh. From there it fades linearly to 0.6 by
 * one poll interval old — the feed missing a single tick for this bus is
 * still probably fine — then keeps fading to 0.35 by two poll intervals old,
 * and holds at 0.35 beyond that rather than reaching zero: a bus still on the
 * map, however stale, beats one that vanishes.
 */
export function confidence(ageMs: number, pollMs: number): number {
  if (pollMs <= 0) return 1;
  if (ageMs <= 0) return 1;

  if (ageMs <= pollMs) return 1 - 0.4 * (ageMs / pollMs);
  if (ageMs <= 2 * pollMs) return 0.6 - 0.25 * ((ageMs - pollMs) / pollMs);

  return 0.35;
}
