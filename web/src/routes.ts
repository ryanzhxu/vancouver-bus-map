/**
 * Route-level questions the map asks: which routes are express, which match a
 * search, and how the fleet is distributed across them right now.
 *
 * Kept apart from buses.ts, which is about where an individual vehicle is.
 */

/**
 * True for TransLink's frequent express services: RapidBus R1-R6 and the 99
 * B-Line.
 *
 * These are the routes a rider treats differently — they run every few minutes,
 * skip stops, and are how most people cross the region. TransLink already marks
 * them in the static feed, giving R1-R6 the RapidBus green (008522) and the 99
 * the B-Line orange (d04110); they are 7 of only 12 routes with any colour at
 * all. The map just never made them prominent enough for that to be visible.
 *
 * Accepts both "099" as it appears in routes.json and "99" as routeLabel
 * displays it, because callers have one or the other depending on where they sit.
 */
export function isExpress(shortName: string): boolean {
  const name = shortName.trim().toUpperCase();
  return /^R[1-6]$/.test(name) || /^0*99$/.test(name);
}
