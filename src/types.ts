import type { LiveFeed } from "./live-feed.js";

export interface Env {
  LIVE_FEED: DurableObjectNamespace<LiveFeed>;
  SNAPSHOT: KVNamespace;
  GTFS: R2Bucket;
  ASSETS: Fetcher;
  /** Set with: wrangler secret put TRANSLINK_API_KEY */
  TRANSLINK_API_KEY?: string;
}

/**
 * Wire format for a bus. Single-letter keys because this array carries ~900
 * entries on every tick and the difference is roughly 90KB versus 40KB.
 */
export interface WireVehicle {
  /** entity id */
  i: string;
  /** route id */
  r: string;
  /** trip id */
  t: string;
  /** latitude */
  y: number;
  /** longitude */
  x: number;
  /** stop sequence */
  s: number;
  /** next stop id */
  p: string;
  /** shape id, joined from the static trips index so the client can glide */
  h?: string;
  /** trip headsign, e.g. "UBC" */
  d?: string;
  /** predicted arrival at the next stop, absolute epoch seconds */
  a?: number;
  /** delay against schedule in seconds; negative is early */
  l?: number;
}

/** trip_id -> [routeId, shapeId, headsign, directionId] */
export type TripIndex = Record<string, [string, string, string, number]>;

export interface Snapshot {
  type: "snapshot";
  generatedAt: number;
  feedTimestamp: number | null;
  pollSeconds: number;
  vehicles: WireVehicle[];
}

export interface StopPrediction {
  routeId: string;
  tripId: string;
  /** Absolute epoch seconds, or null when the feed gave only a delay. */
  time: number | null;
  /** Seconds against schedule; negative is early. */
  delay: number | null;
}
