import {
  activeWindows,
  epochFor,
  servicesOn,
  type CalendarData,
} from "./service-day.js";
import type { StopPrediction } from "./types.js";

/** The per-stop artifact written by scripts/build-gtfs.ts. */
export interface StopSchedule {
  /** interned route ids */
  r: string[];
  /** interned service ids */
  s: string[];
  /** [routeIndex, serviceIndex, gtfsSeconds, tripId], sorted by seconds */
  d: Array<[number, number, number, string]>;
}

export interface Arrival {
  routeId: string;
  tripId: string;
  /** Epoch seconds. */
  time: number;
  /** True when this came from the realtime feed rather than the timetable. */
  live: boolean;
  /** Seconds against schedule; negative is early. Only set for live arrivals. */
  delay: number | null;
}

/**
 * Merge the timetable with whatever the realtime feed knows.
 *
 * Trip updates only cover roughly 20 stops ahead of each bus, so a stop far
 * down a line has no live prediction even while the route is running normally.
 * Those departures still appear, marked as scheduled — showing nothing would
 * imply no service, and inventing a live time would be a lie.
 */
export function mergeArrivals(options: {
  schedule: StopSchedule | null;
  predictions: StopPrediction[];
  calendar: CalendarData | null;
  now: Date;
  limit?: number;
}): Arrival[] {
  const { schedule, predictions, calendar, now } = options;
  const limit = options.limit ?? 8;
  const nowEpoch = Math.floor(now.getTime() / 1000);

  const byTrip = new Map<string, Arrival>();

  // Live first — these win wherever they exist.
  for (const prediction of predictions) {
    if (prediction.time === null) continue;
    if (prediction.time < nowEpoch - 60) continue;
    byTrip.set(prediction.tripId, {
      routeId: prediction.routeId,
      tripId: prediction.tripId,
      time: prediction.time,
      live: true,
      delay: prediction.delay,
    });
  }

  if (schedule && calendar) {
    for (const window of activeWindows(now)) {
      const active = servicesOn(calendar, window.date);

      for (const [routeIndex, serviceIndex, seconds, tripId] of schedule.d) {
        // The list is sorted, so anything already past is behind us. Keep a
        // minute of slack so a bus that just left is still listed.
        if (seconds < window.nowSeconds - 60) continue;

        const serviceId = schedule.s[serviceIndex];
        if (serviceId === undefined || !active.has(serviceId)) continue;

        const routeId = schedule.r[routeIndex];
        if (routeId === undefined) continue;

        const time = epochFor(window.date, seconds);
        const existing = byTrip.get(tripId);
        if (existing) {
          // A live prediction always wins. Among two scheduled runs of the same
          // trip — a daily after-midnight departure is active on both service-day
          // windows — keep the sooner one, which is the run actually arriving.
          if (existing.live || existing.time <= time) continue;
        }

        byTrip.set(tripId, {
          routeId,
          tripId,
          time,
          live: false,
          delay: null,
        });
      }
    }
  }

  return [...byTrip.values()]
    .filter((arrival) => arrival.time >= nowEpoch - 60)
    .sort((a, b) => a.time - b.time)
    .slice(0, limit);
}
