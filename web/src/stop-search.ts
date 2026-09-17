import type { StopInfo } from "./gtfs.js";

/**
 * Stops matching a typed query, best match first.
 *
 * Mirrors routes.ts's searchRoutes scoring: an exact stop-code match ranks
 * first (riders often read the code off the pole), then a name starting with
 * the query, then anywhere in the name.
 */
export function searchStops(stops: StopInfo[], query: string, limit = 8): StopInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: { stop: StopInfo; score: number }[] = [];

  for (const stop of stops) {
    if (stop.l === 2) continue; // a station entrance, not somewhere a bus calls

    const code = stop.c.toLowerCase();
    const name = stop.n.toLowerCase();

    let score: number;
    if (code === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else continue;

    scored.push({ stop, score });
  }

  scored.sort((a, b) => a.score - b.score || a.stop.n.localeCompare(b.stop.n));
  return scored.slice(0, limit).map((s) => s.stop);
}
