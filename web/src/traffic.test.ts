import { describe, expect, it } from "vitest";
import { severityColor, trafficEventsToFeatures, type TrafficEvent } from "./traffic.js";

describe("severityColor", () => {
  it("reads MAJOR events as red", () => {
    expect(severityColor("MAJOR")).toBe("#c0392b");
  });

  it("reads anything else active as amber, not just MINOR specifically", () => {
    expect(severityColor("MODERATE")).toBe("#e8590c");
    expect(severityColor("MINOR")).toBe("#e8590c");
    expect(severityColor("UNKNOWN")).toBe("#e8590c");
  });
});

describe("trafficEventsToFeatures", () => {
  const event = (over: Partial<TrafficEvent> = {}): TrafficEvent => ({
    id: "drivebc.ca/1",
    headline: "CONSTRUCTION",
    severity: "MINOR",
    eventType: "CONSTRUCTION",
    geometry: { type: "Point", coordinates: [-123.1, 49.2] },
    ...over,
  });

  it("carries the event's own geometry through untouched", () => {
    const [feature] = trafficEventsToFeatures([
      event({ geometry: { type: "LineString", coordinates: [[-123, 49], [-122.9, 49.1]] } }),
    ]);
    expect(feature!.geometry).toEqual({
      type: "LineString",
      coordinates: [[-123, 49], [-122.9, 49.1]],
    });
  });

  it("tags each feature with the color its severity implies", () => {
    const [feature] = trafficEventsToFeatures([event({ severity: "MAJOR" })]);
    expect(feature!.properties.color).toBe("#c0392b");
  });

  it("returns one feature per event, in order", () => {
    const features = trafficEventsToFeatures([event({ id: "a" }), event({ id: "b" })]);
    expect(features.map((f) => f.properties.id)).toEqual(["a", "b"]);
  });
});
