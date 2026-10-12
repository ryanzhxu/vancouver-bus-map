/**
 * Decision logic for the two optional traffic overlays: DriveBC's road
 * events and TomTom's live flow tiles. Kept in its own .ts module, tested
 * directly, with BusMap.tsx staying a thin view over it — the same split
 * buses.ts and routes.ts already use.
 */

/** Mirrors src/traffic-events.ts's TrafficEvent. Duplicated by hand like every
 * other shape src/ and web/src/ both need. */
export interface TrafficEvent {
  id: string;
  headline: string;
  severity: string;
  eventType: string;
  geometry: { type: "Point" | "LineString"; coordinates: unknown };
}

/**
 * Red for a closure-grade event, amber for anything else active. DriveBC's
 * own "MAJOR"/"MODERATE"/"MINOR" distinction is finer than a rider waiting
 * for a bus needs — the real question is just "does this block my route."
 */
export function severityColor(severity: string): string {
  return severity === "MAJOR" ? "#c0392b" : "#e8590c";
}

export interface TrafficEventFeature {
  type: "Feature";
  geometry: { type: "Point" | "LineString"; coordinates: unknown };
  properties: { id: string; headline: string; severity: string; color: string };
}

/** One GeoJSON feature per event, split by geometry so each can get its own layer. */
export function trafficEventsToFeatures(events: TrafficEvent[]): TrafficEventFeature[] {
  return events.map((e) => ({
    type: "Feature",
    geometry: e.geometry,
    properties: {
      id: e.id,
      headline: e.headline,
      severity: e.severity,
      color: severityColor(e.severity),
    },
  }));
}
