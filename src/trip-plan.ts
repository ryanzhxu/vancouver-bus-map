import type { StopSchedule } from "./arrivals.js";
import { activeWindows, epochFor, servicesOn, type CalendarData } from "./service-day.js";
import type { StopPrediction } from "./types.js";

/**
 * Direct and one-transfer journeys between two stops, built entirely from the
 * same per-stop schedule objects the stop card already reads.
 *
 * The key trick: sched/{stopId}.json keys every departure by tripId, and the
 * same tripId appears in the file of every stop that trip actually visits. So
 * whether trip T travels from stop A to stop B, and exactly when, is answered
 * by loading both stops' schedules and joining on tripId — no per-trip stop
 * sequence ("pattern") ever needs to be precomputed or stored.
 */

/** No transfers.txt exists in this GTFS feed, so this is an estimate for
 * walking across a stop and catching the next bus, not a published minimum. */
export const MIN_TRANSFER_SECONDS = 90;

/** Matches arrivals.ts's slack: a trip that just left is still offered. */
const LATE_SLACK_SECONDS = 60;

/** Bounds the R2 fetches a single request makes hunting for a transfer stop. */
export const MAX_TRANSFER_CANDIDATES = 15;

/** How many itineraries a rider actually needs to choose between. */
export const MAX_ITINERARIES = 4;

export interface Leg {
  routeId: string;
  tripId: string;
  fromStopId: string;
  toStopId: string;
  /** Epoch seconds. */
  departTime: number;
  /** Epoch seconds. */
  arriveTime: number;
}

export interface Itinerary {
  legs: Leg[];
}

/**
 * Every (tripId, departTime, arriveTime) pair where a trip visits `from`
 * before visiting `to`, across both service-day windows service-day.ts
 * considers active right now.
 *
 * A trip may visit the same physical stop twice on a loop, so `to`'s
 * departures are grouped into arrays keyed by tripId rather than a
 * last-write-wins map — otherwise a loop could join against the wrong lap.
 */
function legsBetween(
  fromStopId: string,
  from: StopSchedule,
  toStopId: string,
  to: StopSchedule,
  calendar: CalendarData,
  now: Date,
  notBefore: number,
): Leg[] {
  const legs: Leg[] = [];

  for (const window of activeWindows(now)) {
    const active = servicesOn(calendar, window.date);

    const arrivalsByTrip = new Map<string, number[]>();
    for (const [, serviceIndex, seconds, tripId] of to.d) {
      const serviceId = to.s[serviceIndex];
      if (serviceId === undefined || !active.has(serviceId)) continue;
      let occurrences = arrivalsByTrip.get(tripId);
      if (!occurrences) arrivalsByTrip.set(tripId, (occurrences = []));
      occurrences.push(seconds);
    }
    if (arrivalsByTrip.size === 0) continue;

    for (const [routeIndex, serviceIndex, seconds, tripId] of from.d) {
      const serviceId = from.s[serviceIndex];
      if (serviceId === undefined || !active.has(serviceId)) continue;

      const arrivalOptions = arrivalsByTrip.get(tripId);
      if (!arrivalOptions) continue;

      const routeId = from.r[routeIndex];
      if (routeId === undefined) continue;

      const departTime = epochFor(window.date, seconds);
      if (departTime < notBefore) continue;

      for (const arriveSeconds of arrivalOptions) {
        // Only a later occurrence counts — a loop trip must not join against
        // a lap it already passed.
        if (arriveSeconds <= seconds) continue;
        legs.push({
          routeId,
          tripId,
          fromStopId,
          toStopId,
          departTime,
          arriveTime: epochFor(window.date, arriveSeconds),
        });
      }
    }
  }

  return legs;
}

/** Single-trip journeys from `from` straight to `to`. */
export function directItineraries(
  fromStopId: string,
  from: StopSchedule,
  toStopId: string,
  to: StopSchedule,
  calendar: CalendarData,
  now: Date,
): Itinerary[] {
  const notBefore = Math.floor(now.getTime() / 1000) - LATE_SLACK_SECONDS;
  return legsBetween(fromStopId, from, toStopId, to, calendar, now, notBefore)
    .sort((a, b) => a.departTime - b.departTime)
    .map((leg) => ({ legs: [leg] }));
}

/**
 * Two-trip journeys via each candidate transfer stop, requiring at least
 * MIN_TRANSFER_SECONDS between arriving and the connecting departure.
 */
export function transferItineraries(
  fromStopId: string,
  from: StopSchedule,
  toStopId: string,
  to: StopSchedule,
  candidates: Map<string, StopSchedule>,
  calendar: CalendarData,
  now: Date,
): Itinerary[] {
  const notBefore = Math.floor(now.getTime() / 1000) - LATE_SLACK_SECONDS;
  const itineraries: Itinerary[] = [];

  for (const [stopId, candidateSchedule] of candidates) {
    const firstLegs = legsBetween(fromStopId, from, stopId, candidateSchedule, calendar, now, notBefore);
    if (firstLegs.length === 0) continue;

    const secondLegs = legsBetween(stopId, candidateSchedule, toStopId, to, calendar, now, notBefore);
    if (secondLegs.length === 0) continue;

    for (const firstLeg of firstLegs) {
      const earliestTransfer = firstLeg.arriveTime + MIN_TRANSFER_SECONDS;
      for (const secondLeg of secondLegs) {
        // Riding the same trip through the transfer stop is a direct trip,
        // already found by directItineraries — not a real transfer.
        if (secondLeg.tripId === firstLeg.tripId) continue;
        if (secondLeg.departTime < earliestTransfer) continue;
        itineraries.push({ legs: [firstLeg, secondLeg] });
      }
    }
  }

  return itineraries.sort((a, b) => arriveTimeOf(a) - arriveTimeOf(b));
}

function arriveTimeOf(itinerary: Itinerary): number {
  return itinerary.legs.at(-1)!.arriveTime;
}

/**
 * Candidate transfer stops: served by a route that also serves `from`, and by
 * a (possibly different) route that also serves `to`.
 *
 * `routeStops` only needs entries for the routes actually serving `from` and
 * `to` — the caller fetches exactly those route-stops/{routeId}.json bundles,
 * not the whole system.
 */
export function candidateTransferStops(options: {
  fromRoutes: string[];
  toRoutes: string[];
  routeStops: Map<string, string[]>;
  fromStopId: string;
  toStopId: string;
  limit?: number;
}): string[] {
  const { fromRoutes, toRoutes, routeStops, fromStopId, toStopId } = options;
  const limit = options.limit ?? MAX_TRANSFER_CANDIDATES;

  const reachableFromOrigin = new Set<string>();
  for (const routeId of fromRoutes) {
    for (const stopId of routeStops.get(routeId) ?? []) reachableFromOrigin.add(stopId);
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const routeId of toRoutes) {
    for (const stopId of routeStops.get(routeId) ?? []) {
      if (stopId === fromStopId || stopId === toStopId) continue;
      if (!reachableFromOrigin.has(stopId) || seen.has(stopId)) continue;
      seen.add(stopId);
      candidates.push(stopId);
      if (candidates.length >= limit) return candidates;
    }
  }
  return candidates;
}

/** Direct and transfer itineraries together, earliest arrival first. */
export function planItineraries(options: {
  fromStopId: string;
  from: StopSchedule;
  toStopId: string;
  to: StopSchedule;
  candidates: Map<string, StopSchedule>;
  calendar: CalendarData;
  now: Date;
  limit?: number;
}): Itinerary[] {
  const { fromStopId, from, toStopId, to, candidates, calendar, now } = options;
  const limit = options.limit ?? MAX_ITINERARIES;

  const direct = directItineraries(fromStopId, from, toStopId, to, calendar, now);
  const transfers = transferItineraries(fromStopId, from, toStopId, to, candidates, calendar, now);

  return [...direct, ...transfers].sort((a, b) => arriveTimeOf(a) - arriveTimeOf(b)).slice(0, limit);
}

export interface LegView extends Leg {
  departLive: boolean;
  departDelay: number | null;
  arriveLive: boolean;
  arriveDelay: number | null;
}

export interface ItineraryView {
  legs: LegView[];
}

/**
 * Layer live predictions onto schedule-only itineraries, one stop's
 * predictions at a time — the same live-wins-when-present rule mergeArrivals
 * uses for the stop card, applied per leg endpoint instead of per departure.
 */
export function overlayLive(
  itineraries: Itinerary[],
  predictionsByStop: Map<string, StopPrediction[]>,
): ItineraryView[] {
  return itineraries.map((itinerary) => ({
    legs: itinerary.legs.map((leg) => {
      const depart = findPrediction(predictionsByStop.get(leg.fromStopId), leg.tripId);
      const arrive = findPrediction(predictionsByStop.get(leg.toStopId), leg.tripId);

      return {
        ...leg,
        departTime: depart?.time ?? leg.departTime,
        departLive: depart !== null,
        departDelay: depart?.delay ?? null,
        arriveTime: arrive?.time ?? leg.arriveTime,
        arriveLive: arrive !== null,
        arriveDelay: arrive?.delay ?? null,
      };
    }),
  }));
}

function findPrediction(
  predictions: StopPrediction[] | undefined,
  tripId: string,
): StopPrediction | null {
  if (!predictions) return null;
  return predictions.find((p) => p.tripId === tripId && p.time !== null) ?? null;
}
