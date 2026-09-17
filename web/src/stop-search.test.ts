import { describe, expect, it } from "vitest";
import { searchStops } from "./stop-search.js";
import type { StopInfo } from "./gtfs.js";

const stop = (i: string, c: string, n: string, l = 0): StopInfo => ({
  i,
  c,
  n,
  y: 49.28,
  x: -123.12,
  w: 0,
  l,
});

const stops: StopInfo[] = [
  stop("1", "50001", "Davie St @ Bidwell St"),
  stop("2", "50002", "Westbound Davie St @ Denman St"),
  stop("3", "50003", "Commercial-Broadway Station", 1),
  stop("4", "50004", "Broadway Station Entrance", 2),
];

describe("searchStops", () => {
  it("returns nothing for an empty or blank query", () => {
    expect(searchStops(stops, "")).toEqual([]);
    expect(searchStops(stops, "   ")).toEqual([]);
  });

  it("ranks an exact stop-code match first", () => {
    const first = searchStops(stops, "50002")[0];
    expect(first?.i).toBe("2");
  });

  it("matches a name starting with the query ahead of one merely containing it", () => {
    const ids = searchStops(stops, "davie").map((s) => s.i);
    expect(ids[0]).toBe("1");
    expect(ids).toContain("2");
  });

  it("matches anywhere in the name", () => {
    expect(searchStops(stops, "denman")[0]?.i).toBe("2");
  });

  it("ignores case", () => {
    expect(searchStops(stops, "COMMERCIAL")[0]?.i).toBe("3");
  });

  it("excludes station entrances, which are not somewhere a bus calls", () => {
    expect(searchStops(stops, "broadway").map((s) => s.i)).not.toContain("4");
  });

  it("returns an empty list when nothing matches", () => {
    expect(searchStops(stops, "zzzz")).toEqual([]);
  });

  it("honours the limit", () => {
    expect(searchStops(stops, "station", 1)).toHaveLength(1);
  });
});
