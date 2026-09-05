import { describe, expect, it } from "vitest";
import { parseCsvLine, simplify, toSeconds, type LatLon } from "./gtfs-util.js";

describe("parseCsvLine", () => {
  it("splits a plain row", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("keeps commas inside quotes, which real headsigns contain", () => {
    // From trips.txt: headsigns like "Downtown, Robson" would split naively.
    expect(parseCsvLine('1,"Downtown, Robson",3')).toEqual(["1", "Downtown, Robson", "3"]);
  });

  it("unescapes a doubled quote", () => {
    expect(parseCsvLine('a,"say ""hi""",c')).toEqual(["a", 'say "hi"', "c"]);
  });

  it("preserves empty fields, including a trailing one", () => {
    expect(parseCsvLine("a,,c,")).toEqual(["a", "", "c", ""]);
  });

  it("handles a quoted empty field", () => {
    expect(parseCsvLine('a,"",c')).toEqual(["a", "", "c"]);
  });

  it("returns a single field when there are no commas", () => {
    expect(parseCsvLine("solo")).toEqual(["solo"]);
  });
});

describe("toSeconds", () => {
  it("converts a normal time", () => {
    expect(toSeconds("07:30:00")).toBe(7 * 3600 + 30 * 60);
  });

  it("keeps hours past midnight, which GTFS uses for late-night trips", () => {
    // 25:14:00 is 01:14 the next day but belongs to the previous service day.
    expect(toSeconds("25:14:00")).toBe(25 * 3600 + 14 * 60);
  });

  it("handles midnight", () => {
    expect(toSeconds("00:00:00")).toBe(0);
  });

  it("rejects malformed values rather than returning NaN", () => {
    for (const bad of ["", "7:30", "aa:bb:cc", "07:30:00:00", "07:99:00"]) {
      expect(toSeconds(bad)).toBeNull();
    }
  });
});

describe("simplify", () => {
  const line = (...pts: Array<[number, number]>): LatLon[] => pts;

  it("returns short lines untouched", () => {
    expect(simplify(line([0, 0], [1, 1]), 0.1)).toHaveLength(2);
  });

  it("collapses collinear points to the two endpoints", () => {
    const straight = line([0, 0], [0, 1], [0, 2], [0, 3], [0, 4]);
    expect(simplify(straight, 0.0001)).toEqual([
      [0, 0],
      [0, 4],
    ]);
  });

  it("keeps a corner that exceeds the tolerance", () => {
    const corner = line([0, 0], [0, 1], [1, 1]);
    expect(simplify(corner, 0.1)).toHaveLength(3);
  });

  it("drops a wobble smaller than the tolerance", () => {
    const wobble = line([0, 0], [0.00001, 1], [0, 2]);
    expect(simplify(wobble, 0.001)).toEqual([
      [0, 0],
      [0, 2],
    ]);
  });

  it("always preserves the first and last point", () => {
    const pts: LatLon[] = Array.from({ length: 200 }, (_, i) => [Math.sin(i) * 0.001, i * 0.001]);
    const out = simplify(pts, 0.0005);
    expect(out[0]).toEqual(pts[0]);
    expect(out.at(-1)).toEqual(pts.at(-1));
    expect(out.length).toBeLessThan(pts.length);
  });

  it("handles a long line without blowing the stack", () => {
    // TransLink's longest shape is 1,812 points.
    const pts: LatLon[] = Array.from({ length: 2000 }, (_, i) => [i * 1e-6, i * 1e-6]);
    expect(() => simplify(pts, 1e-9)).not.toThrow();
  });

  it("does not mutate its input", () => {
    const pts = line([0, 0], [0, 1], [0, 2]);
    const before = JSON.stringify(pts);
    simplify(pts, 0.5);
    expect(JSON.stringify(pts)).toBe(before);
  });
});
