import type { StopSchedule } from "./arrivals.js";
import { currentVersion } from "./gtfs-assets.js";
import type { CalendarData } from "./service-day.js";
import {
  candidateTransferStops,
  overlayLive,
  planItineraries,
  type ItineraryView,
} from "./trip-plan.js";
import type { Env, StopPrediction } from "./types.js";

const STOP_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Cached per isolate; the calendar changes only when a new build is published. */
let calendarCache: { version: string; data: CalendarData } | null = null;

/**
 * GET /api/trip-plan?from={stopId}&to={stopId} — direct and one-transfer
 * itineraries between two stops.
 *
 * Runs entirely on data already in R2 (sched/*.json, route-stops/*.json,
 * calendar.json) plus the Durable Object's already-polled live predictions —
 * see src/trip-plan.ts for why no per-trip stop sequence needs to be fetched
 * or precomputed. This never calls TransLink.
 */
export async function handleTripPlan(
  url: URL,
  env: Env,
  feedStub: { fetch: (request: Request) => Promise<Response> },
): Promise<Response> {
  const fromStopId = url.searchParams.get("from");
  const toStopId = url.searchParams.get("to");
  if (!fromStopId || !toStopId || !STOP_ID_PATTERN.test(fromStopId) || !STOP_ID_PATTERN.test(toStopId)) {
    return Response.json({ error: "from and to stop ids are required" }, { status: 400 });
  }
  if (fromStopId === toStopId) {
    return Response.json({ error: "from and to must be different stops" }, { status: 400 });
  }

  const version = await currentVersion(env);
  if (!version) {
    return Response.json({ error: "no GTFS build published yet" }, { status: 503 });
  }

  const [from, to, calendar] = await Promise.all([
    loadSchedule(env, version, fromStopId),
    loadSchedule(env, version, toStopId),
    loadCalendar(env, version),
  ]);

  if (!from || !to || !calendar) {
    return Response.json(
      {
        fromStopId,
        toStopId,
        generatedAt: Math.floor(Date.now() / 1000),
        hasFromSchedule: from !== null,
        hasToSchedule: to !== null,
        itineraries: [],
      },
      { headers: { "cache-control": "public, max-age=20" } },
    );
  }

  const routeIds = [...new Set([...from.r, ...to.r])];
  const routeStops = new Map(
    (
      await Promise.all(
        routeIds.map(async (routeId) => [routeId, await loadRouteStops(env, version, routeId)] as const),
      )
    ).filter((entry): entry is [string, string[]] => entry[1] !== null),
  );

  const candidateIds = candidateTransferStops({
    fromRoutes: from.r,
    toRoutes: to.r,
    routeStops,
    fromStopId,
    toStopId,
  });

  const candidateSchedules = await Promise.all(
    candidateIds.map(async (stopId) => [stopId, await loadSchedule(env, version, stopId)] as const),
  );
  const candidates = new Map(
    candidateSchedules.filter(
      (entry): entry is [string, StopSchedule] => entry[1] !== null,
    ),
  );

  const now = new Date();
  const itineraries = planItineraries({
    fromStopId,
    from,
    toStopId,
    to,
    candidates,
    calendar,
    now,
  });

  const stopsUsed = new Set<string>([fromStopId, toStopId]);
  for (const itinerary of itineraries) {
    for (const leg of itinerary.legs) {
      stopsUsed.add(leg.fromStopId);
      stopsUsed.add(leg.toStopId);
    }
  }

  const predictionsByStop = await loadPredictions(feedStub, url, [...stopsUsed]);
  const withLive: ItineraryView[] = overlayLive(itineraries, predictionsByStop);

  return Response.json(
    {
      fromStopId,
      toStopId,
      generatedAt: Math.floor(Date.now() / 1000),
      hasFromSchedule: true,
      hasToSchedule: true,
      itineraries: withLive,
    },
    // Short cache, same reasoning as /api/stop/{id}: live predictions move
    // every few minutes, and a stale itinerary is worse than one more request.
    { headers: { "cache-control": "public, max-age=20" } },
  );
}

async function loadSchedule(env: Env, version: string, stopId: string): Promise<StopSchedule | null> {
  const object = await env.GTFS.get(`v/${version}/sched/${stopId}.json`);
  if (!object) return null;
  return (await object.json()) as StopSchedule;
}

async function loadRouteStops(env: Env, version: string, routeId: string): Promise<string[] | null> {
  const object = await env.GTFS.get(`v/${version}/route-stops/${routeId}.json`);
  if (!object) return null;
  return (await object.json()) as string[];
}

async function loadCalendar(env: Env, version: string): Promise<CalendarData | null> {
  if (calendarCache && calendarCache.version === version) return calendarCache.data;

  const object = await env.GTFS.get(`v/${version}/calendar.json`);
  if (!object) return null;

  const data = (await object.json()) as CalendarData;
  calendarCache = { version, data };
  return data;
}

async function loadPredictions(
  feedStub: { fetch: (request: Request) => Promise<Response> },
  url: URL,
  stopIds: string[],
): Promise<Map<string, StopPrediction[]>> {
  const entries = await Promise.all(
    stopIds.map(async (stopId): Promise<[string, StopPrediction[]]> => {
      try {
        const target = new URL("/predictions", url.origin);
        target.searchParams.set("stop", stopId);
        const response = await feedStub.fetch(new Request(target));
        if (!response.ok) return [stopId, []];
        const body = (await response.json()) as { predictions?: StopPrediction[] };
        return [stopId, body.predictions ?? []];
      } catch {
        // The schedule-only itinerary is still worth returning.
        return [stopId, []];
      }
    }),
  );
  return new Map(entries);
}
