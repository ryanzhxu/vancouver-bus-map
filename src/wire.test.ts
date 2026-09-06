import { describe, expect, it } from "vitest";
import type { Vehicle } from "./gtfs-rt.js";
import type { StopPrediction } from "./types.js";
import { findPrediction, toWire } from "./wire.js";

const vehicle = (over: Partial<Vehicle> = {}): Vehicle => ({
  id: "v1",
  routeId: "099",
  tripId: "t1",
  lat: 49.26,
  lon: -123.12,
  stopSequence: 5,
  stopId: "s1",
  ...over,
});

const preds = (list: StopPrediction[]): Record<string, StopPrediction[]> => ({ s1: list });

describe("findPrediction", () => {
  it("matches on both trip id and stop id", () => {
    const found = findPrediction(
      preds([
        { routeId: "099", tripId: "other", time: 100, delay: 0 },
        { routeId: "099", tripId: "t1", time: 200, delay: 60 },
      ]),
      "t1",
      "s1",
    );
    expect(found?.time).toBe(200);
  });

  it("returns undefined when the stop has no prediction for this trip", () => {
    expect(findPrediction(preds([{ routeId: "099", tripId: "z", time: 1, delay: 0 }]), "t1", "s1")).toBeUndefined();
    expect(findPrediction({}, "t1", "s1")).toBeUndefined();
    expect(findPrediction(preds([]), "", "s1")).toBeUndefined();
  });
});

describe("toWire prediction join", () => {
  it("puts the predicted arrival and delay on the wire vehicle", () => {
    const wire = toWire(vehicle(), null, preds([{ routeId: "099", tripId: "t1", time: 1788679800, delay: 120 }]));
    expect(wire.a).toBe(1788679800);
    expect(wire.l).toBe(120);
  });

  it("keeps a negative (early) delay", () => {
    const wire = toWire(vehicle(), null, preds([{ routeId: "099", tripId: "t1", time: 5, delay: -45 }]));
    expect(wire.l).toBe(-45);
  });

  it("omits both fields when no prediction matches", () => {
    const wire = toWire(vehicle(), null, {});
    expect(wire.a).toBeUndefined();
    expect(wire.l).toBeUndefined();
  });

  it("omits arrival when the feed gave only a delay", () => {
    const wire = toWire(vehicle(), null, preds([{ routeId: "099", tripId: "t1", time: null, delay: 30 }]));
    expect(wire.a).toBeUndefined();
    expect(wire.l).toBe(30);
  });
});
