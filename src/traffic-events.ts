/**
 * GET /api/traffic/events — active DriveBC road events over Metro Vancouver.
 *
 * DriveBC publishes construction, closures and incidents for BC's highways
 * as free, keyless Open511 data. Its own guidance asks production clients to
 * poll no more than once a minute; this is a side project with no dedicated
 * cache infrastructure, so one in-memory slot per isolate at a slightly
 * longer interval is plenty, and far cheaper than re-fetching per visitor.
 */

const OPEN511_URL = "https://api.open511.gov.bc.ca/events";

/**
 * Matches web/src/BusMap.tsx's BOUNDS. Duplicated by hand like every other
 * shape src/ and web/src/ both need — the two projects cannot share a module.
 */
const VANCOUVER_BBOX = "-123.55,48.95,-122.4,49.45";

const CACHE_MS = 90_000;

export interface TrafficEvent {
  id: string;
  headline: string;
  /** "MAJOR" | "MODERATE" | "MINOR" | "UNKNOWN" per the Open511 spec. */
  severity: string;
  /** e.g. "CONSTRUCTION", "INCIDENT", "SPECIAL_EVENT". */
  eventType: string;
  geometry: { type: "Point" | "LineString"; coordinates: unknown };
}

interface Open511Response {
  events: {
    id: string;
    headline: string;
    severity: string;
    event_type: string;
    geography: { type: "Point" | "LineString"; coordinates: unknown };
  }[];
}

/** Cached per isolate. DriveBC's own guidance is to poll no more than once a minute. */
let cache: { at: number; events: TrafficEvent[] } | null = null;

export async function handleTrafficEvents(): Promise<Response> {
  const events = await loadEvents();
  return Response.json(
    { generatedAt: Date.now(), events },
    // Browser-side cache too, so a rider re-opening the tab doesn't refetch
    // instantly; the content is at most CACHE_MS stale regardless.
    { headers: { "cache-control": `public, max-age=${CACHE_MS / 1000}` } },
  );
}

async function loadEvents(): Promise<TrafficEvent[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.events;

  const url = `${OPEN511_URL}?bbox=${VANCOUVER_BBOX}&status=ACTIVE&limit=500`;
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) return cache?.events ?? [];

    const events = mapOpen511Events((await response.json()) as Open511Response);
    cache = { at: Date.now(), events };
    return events;
  } catch {
    // DriveBC being unreachable is not worth failing the whole map over —
    // keep serving whatever was cached last, stale or not.
    return cache?.events ?? [];
  }
}

export function mapOpen511Events(body: Open511Response): TrafficEvent[] {
  return body.events.map((e) => ({
    id: e.id,
    headline: e.headline,
    severity: e.severity,
    eventType: e.event_type,
    geometry: e.geography,
  }));
}
