import { describe, expect, it } from "vitest";
import {
  bearingAt,
  bearingBetween,
  buildTrack,
  distance,
  lerp,
  pointAtDistance,
  projectOntoTrack,
  type LatLon,
} from "./geo.js";

/** A straight line heading north from downtown Vancouver. */
const northLine: LatLon[] = [
  [49.28, -123.12],
  [49.29, -123.12],
  [49.3, -123.12],
];

/** An L: north, then a right turn to the east. */
const cornerLine: LatLon[] = [
  [49.28, -123.12],
  [49.29, -123.12],
  [49.29, -123.1],
];

describe("buildTrack", () => {
  it("accumulates distance along the line", () => {
    const track = buildTrack(northLine);
    expect(track.cumulative[0]).toBe(0);
    expect(track.cumulative[1]).toBeCloseTo(0.01, 6);
    expect(track.cumulative[2]).toBeCloseTo(0.02, 6);
    expect(track.length).toBeCloseTo(0.02, 6);
  });

  it("handles a single-point track without dividing by zero", () => {
    const track = buildTrack([[49.28, -123.12]]);
    expect(track.length).toBe(0);
    expect(pointAtDistance(track, 5)).toEqual([49.28, -123.12]);
  });
});

describe("distance", () => {
  it("scales longitude by latitude, so a degree of longitude is shorter", () => {
    const lat = distance([49, -123], [50, -123]);
    const lon = distance([49, -123], [49, -122]);
    expect(lon).toBeLessThan(lat);
    // cos(49.25 degrees) is about 0.653.
    expect(lon / lat).toBeCloseTo(0.653, 2);
  });
});

describe("pointAtDistance", () => {
  const track = buildTrack(northLine);

  it("returns the start at distance zero", () => {
    expect(pointAtDistance(track, 0)).toEqual([49.28, -123.12]);
  });

  it("returns the end at full length", () => {
    const [lat, lon] = pointAtDistance(track, track.length);
    expect(lat).toBeCloseTo(49.3, 6);
    expect(lon).toBeCloseTo(-123.12, 6);
  });

  it("interpolates inside a segment", () => {
    const [lat] = pointAtDistance(track, 0.005);
    expect(lat).toBeCloseTo(49.285, 6);
  });

  it("finds a point in the second segment", () => {
    const [lat] = pointAtDistance(track, 0.015);
    expect(lat).toBeCloseTo(49.295, 6);
  });

  it("clamps rather than extrapolating past either end", () => {
    expect(pointAtDistance(track, -10)[0]).toBeCloseTo(49.28, 6);
    expect(pointAtDistance(track, 999)[0]).toBeCloseTo(49.3, 6);
  });
});

describe("projectOntoTrack", () => {
  const track = buildTrack(northLine);

  it("snaps a point beside the line onto it", () => {
    // Slightly east of the line, halfway up.
    const { distanceAlong, offTrack } = projectOntoTrack(track, [49.29, -123.119]);
    expect(distanceAlong).toBeCloseTo(0.01, 3);
    expect(offTrack).toBeGreaterThan(0);
    expect(offTrack).toBeLessThan(0.001);
  });

  it("reports a point exactly on the line as having no offset", () => {
    expect(projectOntoTrack(track, [49.29, -123.12]).offTrack).toBeCloseTo(0, 9);
  });

  it("clamps a point beyond the end to the end", () => {
    expect(projectOntoTrack(track, [49.35, -123.12]).distanceAlong).toBeCloseTo(track.length, 6);
  });

  it("follows the corner rather than cutting across it", () => {
    const corner = buildTrack(cornerLine);
    // A bus mid-turn should read as past the elbow, not across the diagonal.
    const { distanceAlong } = projectOntoTrack(corner, [49.29, -123.115]);
    expect(distanceAlong).toBeGreaterThan(0.01);
  });

  it("uses the hint to pick the right leg where a route doubles back", () => {
    // Out and back along the same corridor — every point has two candidates.
    const loop = buildTrack([
      [49.28, -123.12],
      [49.3, -123.12],
      [49.28, -123.12],
    ]);
    const probe: LatLon = [49.29, -123.12];

    const outbound = projectOntoTrack(loop, probe, 0.01);
    const inbound = projectOntoTrack(loop, probe, 0.03);

    expect(outbound.distanceAlong).toBeCloseTo(0.01, 3);
    expect(inbound.distanceAlong).toBeCloseTo(0.03, 3);
  });

  it("returns a sane result for an empty track", () => {
    expect(projectOntoTrack(buildTrack([]), [49, -123])).toEqual({
      distanceAlong: 0,
      offTrack: Infinity,
    });
  });
});

describe("bearing", () => {
  it("reads due north as 0", () => {
    expect(bearingBetween([49.28, -123.12], [49.29, -123.12])).toBeCloseTo(0, 3);
  });

  it("reads due east as 90", () => {
    expect(bearingBetween([49.28, -123.12], [49.28, -123.11])).toBeCloseTo(90, 3);
  });

  it("reads due south as 180", () => {
    expect(bearingBetween([49.29, -123.12], [49.28, -123.12])).toBeCloseTo(180, 3);
  });

  it("reads due west as 270", () => {
    expect(bearingBetween([49.28, -123.11], [49.28, -123.12])).toBeCloseTo(270, 3);
  });

  it("returns 0 rather than NaN for a stationary bus", () => {
    expect(bearingBetween([49.28, -123.12], [49.28, -123.12])).toBe(0);
  });

  it("derives heading from the track, since TransLink never sends one", () => {
    expect(bearingAt(buildTrack(northLine), 0.01)).toBeCloseTo(0, 1);
  });

  it("turns through the corner", () => {
    const corner = buildTrack(cornerLine);
    expect(bearingAt(corner, 0.001)).toBeCloseTo(0, 1); // still heading north
    expect(bearingAt(corner, corner.length - 0.001)).toBeCloseTo(90, 1); // now east
  });
});

describe("lerp", () => {
  it("returns the endpoints at 0 and 1", () => {
    expect(lerp([0, 0], [10, 20], 0)).toEqual([0, 0]);
    expect(lerp([0, 0], [10, 20], 1)).toEqual([10, 20]);
  });

  it("clamps out-of-range progress instead of overshooting", () => {
    expect(lerp([0, 0], [10, 20], 2)).toEqual([10, 20]);
    expect(lerp([0, 0], [10, 20], -1)).toEqual([0, 0]);
  });
});
