import type { Vehicle } from "./gtfs-rt.js";
import type { StopPrediction, TripIndex, WireVehicle } from "./types.js";

/**
 * The join that both rider features read from: a vehicle knows the stop it is
 * heading for, and the trip-update feed holds a predicted arrival for that
 * (trip, stop). Match them so the wire carries an arrival time and a delay,
 * and neither the countdown nor the late-bus flag has to reach for them again.
 */
export function findPrediction(
  predictions: Record<string, StopPrediction[]>,
  tripId: string,
  stopId: string,
): StopPrediction | undefined {
  if (!tripId || !stopId) return undefined;
  const list = predictions[stopId];
  if (!list) return undefined;
  return list.find((p) => p.tripId === tripId);
}

/** Trim a decoded vehicle to what the map needs, keeping the payload small. */
export function toWire(
  v: Vehicle,
  trips: TripIndex | null,
  predictions: Record<string, StopPrediction[]>,
): WireVehicle {
  const entry = v.tripId ? trips?.[v.tripId] : undefined;
  const pred = findPrediction(predictions, v.tripId ?? "", v.stopId ?? "");
  return {
    i: v.id,
    r: v.routeId ?? "",
    t: v.tripId ?? "",
    y: round5(v.lat),
    x: round5(v.lon),
    s: v.stopSequence ?? 0,
    p: v.stopId ?? "",
    // Joined from the static index so the client can place the bus on its
    // route's real geometry without downloading 128k trips itself.
    ...(entry?.[1] ? { h: entry[1] } : {}),
    ...(entry?.[2] ? { d: entry[2] } : {}),
    // Joined from the trip-update predictions so the client can say when the
    // bus reaches its next stop and whether it is running behind.
    ...(pred?.time != null ? { a: pred.time } : {}),
    ...(pred?.delay != null ? { l: pred.delay } : {}),
  };
}

/** Five decimals is about a metre — more precision than a bus position has. */
export function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}
