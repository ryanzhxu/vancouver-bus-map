import { routeLabelOf, type RouteInfo } from "./gtfs.js";

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

export interface RouteMatch {
  routeId: string;
  /** The short name as a rider reads it, e.g. "99", "R4". */
  label: string;
  name: string;
}

/**
 * Routes matching a typed query, best match first.
 *
 * An exact short-name match always ranks first. Typing "99" must find the
 * B-Line rather than the 991 or the 199, and the comparison is made on the
 * displayed label so that "99" matches the stored "099".
 */
export function searchRoutes(
  routes: Map<string, RouteInfo>,
  query: string,
  limit = 8,
): RouteMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: { match: RouteMatch; score: number }[] = [];

  for (const [routeId, route] of routes) {
    const label = routeLabelOf(route);
    const lowerLabel = label.toLowerCase();
    const lowerName = route.n.toLowerCase();

    let score: number;
    if (lowerLabel === q) score = 0;
    else if (lowerLabel.startsWith(q)) score = 1;
    else if (lowerName.startsWith(q)) score = 2;
    else if (lowerLabel.includes(q) || lowerName.includes(q)) score = 3;
    else continue;

    scored.push({ match: { routeId, label, name: route.n }, score });
  }

  scored.sort((a, b) => a.score - b.score || a.match.label.localeCompare(b.match.label));
  return scored.slice(0, limit).map((s) => s.match);
}

/** What the map is currently emphasising. Both parts can be active at once. */
export interface Highlight {
  /** A single route the rider picked, or null. */
  routeId: string | null;
  /** True while the express-only filter is on. */
  expressOnly: boolean;
}

/**
 * True when a bus should be drawn faded rather than at full strength.
 *
 * Dimming rather than hiding is deliberate: the reason to look at this map is
 * the shape of the whole network, and a route highlighted against an empty city
 * loses the context that makes it worth seeing.
 *
 * An explicitly selected route always stays lit, even when the express filter
 * would otherwise fade it. Otherwise picking the 10 while the filter was on
 * would fade the very route just chosen.
 */
export function shouldDim(highlight: Highlight, routeId: string, express: boolean): boolean {
  if (highlight.routeId) return routeId !== highlight.routeId;
  if (highlight.expressOnly) return !express;
  return false;
}
