import { mergeArrivals, type StopSchedule } from "./arrivals.js";
import { currentVersion } from "./gtfs-assets.js";
import type { CalendarData } from "./service-day.js";
import type { Env, StopPrediction } from "./types.js";

/** Cached per isolate; the calendar changes only when a new build is published. */
let calendarCache: { version: string; data: CalendarData } | null = null;

/**
 * GET /api/stop/{id} — the next departures from one stop.
 *
 * Live predictions from the realtime feed are layered over the published
 * timetable. Each arrival says which it is, because "3 min" from a prediction
 * and "3 min" from a timetable are not the same promise.
 */
export async function handleStop(
  url: URL,
  env: Env,
  feedStub: { fetch: (request: Request) => Promise<Response> },
): Promise<Response> {
  const stopId = url.pathname.split("/").filter(Boolean)[2];
  if (!stopId || !/^[A-Za-z0-9._-]+$/.test(stopId)) {
    return Response.json({ error: "bad stop id" }, { status: 400 });
  }

  const version = await currentVersion(env);
  if (!version) {
    return Response.json({ error: "no GTFS build published yet" }, { status: 503 });
  }

  const [schedule, calendar, predictions] = await Promise.all([
    loadSchedule(env, version, stopId),
    loadCalendar(env, version),
    loadPredictions(feedStub, url, stopId),
  ]);

  const arrivals = mergeArrivals({
    schedule,
    predictions,
    calendar,
    now: new Date(),
    limit: parseLimit(url.searchParams.get("limit")),
  });

  return Response.json(
    {
      stopId,
      generatedAt: Math.floor(Date.now() / 1000),
      hasSchedule: schedule !== null,
      arrivals,
    },
    {
      // Short cache: live predictions change every few minutes, and a stale
      // arrival time is worse than a slightly slower request.
      headers: { "cache-control": "public, max-age=20" },
    },
  );
}

/**
 * A stop's arrival count from the untrusted `limit` query value. A missing,
 * empty, or non-numeric value falls back to the default. `Number("abc")` is
 * NaN, and `mergeArrivals` ends with `slice(0, limit)`, so a bad value would
 * otherwise return zero departures and hide the whole timetable.
 */
export function parseLimit(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 8;
}

async function loadSchedule(
  env: Env,
  version: string,
  stopId: string,
): Promise<StopSchedule | null> {
  const object = await env.GTFS.get(`v/${version}/sched/${stopId}.json`);
  if (!object) return null;
  return (await object.json()) as StopSchedule;
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
  stopId: string,
): Promise<StopPrediction[]> {
  try {
    const target = new URL("/predictions", url.origin);
    target.searchParams.set("stop", stopId);
    const response = await feedStub.fetch(new Request(target));
    if (!response.ok) return [];
    const body = (await response.json()) as { predictions?: StopPrediction[] };
    return body.predictions ?? [];
  } catch {
    // The timetable alone is still worth returning.
    return [];
  }
}
