import { isLate, type WireVehicle } from "./buses.js";
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

export interface RouteTally {
  routeId: string;
  label: string;
  count: number;
}

/**
 * Routes with the most buses on the road right now, busiest first.
 *
 * Buses with no route id are dropped, not tallied. The wire format sends `r` as
 * `routeId ?? ""`, so a vehicle the feed gave no trip for arrives with an empty
 * string, and every such bus across the network shares it. Left in, they form a
 * single group large enough to top this table and render as a coloured pill with
 * no text in it. findBunches and the map's route prefetch drop them for the same
 * reason.
 */
export function busiestRoutes(
  vehicles: WireVehicle[],
  labelFor: (routeId: string) => string,
  limit = 5,
): RouteTally[] {
  const counts = new Map<string, number>();
  for (const v of vehicles) {
    if (!v.r) continue;
    counts.set(v.r, (counts.get(v.r) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([routeId, count]) => ({ routeId, label: labelFor(routeId), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/**
 * How many buses a route needs before its delay is worth ranking.
 *
 * Without a floor the table is topped by whichever hourly suburban route
 * happens to have one bus stuck in traffic, which says nothing about how the
 * network is running. Three is the smallest number where a mean is not just one
 * bus wearing a disguise.
 */
export const MIN_BUSES_FOR_DELAY_RANKING = 3;

export interface RouteDelay {
  routeId: string;
  label: string;
  /** Mean delay in seconds across the buses reporting one. */
  meanDelay: number;
  /** How many buses that mean is drawn from. */
  count: number;
}

/**
 * Routes running worst against schedule right now, worst first.
 *
 * Only counts buses that actually report a delay, and only reports a route once
 * it is late by the same threshold the map already uses for a single bus, so
 * the panel and the map never disagree about what "late" means.
 */
export function worstDelayedRoutes(
  vehicles: WireVehicle[],
  labelFor: (routeId: string) => string,
  limit = 5,
): RouteDelay[] {
  const totals = new Map<string, { sum: number; count: number }>();

  for (const v of vehicles) {
    if (v.l == null) continue;
    // Route-less buses are dropped here for the same reason as in
    // busiestRoutes: they would all share the empty route id and average
    // together into one unnameable row.
    if (!v.r) continue;
    const entry = totals.get(v.r) ?? { sum: 0, count: 0 };
    entry.sum += v.l;
    entry.count++;
    totals.set(v.r, entry);
  }

  return [...totals.entries()]
    .filter(([, t]) => t.count >= MIN_BUSES_FOR_DELAY_RANKING)
    .map(([routeId, t]) => ({
      routeId,
      label: labelFor(routeId),
      meanDelay: Math.round(t.sum / t.count),
      count: t.count,
    }))
    .filter((r) => isLate(r.meanDelay))
    .sort((a, b) => b.meanDelay - a.meanDelay || a.label.localeCompare(b.label))
    .slice(0, limit);
}
