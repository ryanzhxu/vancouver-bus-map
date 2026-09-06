import { describe, expect, it } from "vitest";
import {
  busiestRoutes,
  isExpress,
  MIN_BUSES_FOR_DELAY_RANKING,
  searchRoutes,
  shouldDim,
  worstDelayedRoutes,
  type Highlight,
} from "./routes.js";
import type { RouteInfo } from "./gtfs.js";
import type { WireVehicle } from "./buses.js";

describe("isExpress", () => {
  it("counts every RapidBus line", () => {
    for (const name of ["R1", "R2", "R3", "R4", "R5", "R6"]) {
      expect(isExpress(name)).toBe(true);
    }
  });

  it("counts the 99 B-Line in both the raw and the displayed form", () => {
    // routes.json carries "099"; routeLabel strips the leading zero for display.
    expect(isExpress("099")).toBe(true);
    expect(isExpress("99")).toBe(true);
  });

  it("does not count a local that merely starts with the same digits", () => {
    expect(isExpress("991")).toBe(false);
    expect(isExpress("9")).toBe(false);
    expect(isExpress("199")).toBe(false);
  });

  it("does not count an R-line that does not exist, or a NightBus", () => {
    expect(isExpress("R7")).toBe(false);
    expect(isExpress("R")).toBe(false);
    expect(isExpress("N9")).toBe(false);
  });

  it("ignores case and surrounding space", () => {
    expect(isExpress(" r4 ")).toBe(true);
  });
});

const route = (s: string, n: string): RouteInfo => ({ s, n, t: 3, c: null, x: null });

const routes = new Map<string, RouteInfo>([
  ["6641", route("099", "Broadway B-Line")],
  ["6642", route("991", "Nowhere Special")],
  ["6643", route("199", "Also Not It")],
  ["6644", route("010", "Granville")],
  ["37808", route("R1", "King George Blvd")],
]);

describe("searchRoutes", () => {
  it("returns nothing for an empty or blank query", () => {
    expect(searchRoutes(routes, "")).toEqual([]);
    expect(searchRoutes(routes, "   ")).toEqual([]);
  });

  it("ranks an exact short-name match first", () => {
    // "99" must find the B-Line, not 991 or 199, however the map stores it.
    const first = searchRoutes(routes, "99")[0];
    expect(first?.routeId).toBe("6641");
    expect(first?.label).toBe("99");
  });

  it("still returns the near misses, after the exact match", () => {
    const ids = searchRoutes(routes, "99").map((m) => m.routeId);
    expect(ids).toContain("6642");
    expect(ids).toContain("6643");
    expect(ids[0]).toBe("6641");
  });

  it("matches on the long name too", () => {
    expect(searchRoutes(routes, "granville")[0]?.routeId).toBe("6644");
  });

  it("ignores case", () => {
    expect(searchRoutes(routes, "r1")[0]?.routeId).toBe("37808");
  });

  it("returns an empty list when nothing matches", () => {
    expect(searchRoutes(routes, "zzzz")).toEqual([]);
  });

  it("honours the limit", () => {
    expect(searchRoutes(routes, "9", 2)).toHaveLength(2);
  });
});

describe("shouldDim", () => {
  const none: Highlight = { routeId: null, expressOnly: false };

  it("dims nothing when no highlight is active", () => {
    expect(shouldDim(none, "6641", true)).toBe(false);
    expect(shouldDim(none, "6644", false)).toBe(false);
  });

  it("dims every route but the selected one", () => {
    const only99: Highlight = { routeId: "6641", expressOnly: false };
    expect(shouldDim(only99, "6641", true)).toBe(false);
    expect(shouldDim(only99, "6644", false)).toBe(true);
  });

  it("dims the locals when express only is on", () => {
    const express: Highlight = { routeId: null, expressOnly: true };
    expect(shouldDim(express, "37808", true)).toBe(false);
    expect(shouldDim(express, "6644", false)).toBe(true);
  });

  it("keeps a selected local visible even when express only is on", () => {
    // An explicit choice beats a broad filter, or selecting the 10 while the
    // express filter is on would dim the very route the user just picked.
    const both: Highlight = { routeId: "6644", expressOnly: true };
    expect(shouldDim(both, "6644", false)).toBe(false);
  });
});

const wire = (r: string, l?: number): WireVehicle => ({
  i: `${r}-${Math.random()}`,
  r,
  t: "trip",
  y: 49.28,
  x: -123.12,
  s: 1,
  p: "stop",
  ...(l === undefined ? {} : { l }),
});

const label = (id: string) => (id === "6641" ? "99" : id === "37808" ? "R1" : id);

describe("busiestRoutes", () => {
  it("ranks routes by how many buses are running", () => {
    const result = busiestRoutes(
      [wire("6641"), wire("6641"), wire("6641"), wire("37808"), wire("37808"), wire("10")],
      label,
    );
    expect(result[0]).toMatchObject({ routeId: "6641", label: "99", count: 3 });
    expect(result[1]).toMatchObject({ routeId: "37808", count: 2 });
    expect(result[2]).toMatchObject({ routeId: "10", count: 1 });
  });

  it("honours the limit", () => {
    expect(busiestRoutes([wire("a"), wire("b"), wire("c")], label, 2)).toHaveLength(2);
  });

  it("returns nothing for an empty snapshot", () => {
    expect(busiestRoutes([], label)).toEqual([]);
  });
});

describe("worstDelayedRoutes", () => {
  it("ranks by mean delay, worst first", () => {
    const vehicles = [
      ...Array.from({ length: 3 }, () => wire("slow", 600)),
      ...Array.from({ length: 3 }, () => wire("ok", 60)),
    ];
    const result = worstDelayedRoutes(vehicles, label);
    expect(result[0]?.routeId).toBe("slow");
    expect(result[0]?.meanDelay).toBe(600);
  });

  it("ignores a route with too few buses to mean anything", () => {
    // One very late bus on an hourly suburban route must not top a table about
    // how the network is running.
    const vehicles = [wire("lonely", 3000), ...Array.from({ length: 3 }, () => wire("busy", 400))];
    const result = worstDelayedRoutes(vehicles, label);
    expect(result.map((r) => r.routeId)).not.toContain("lonely");
    expect(result[0]?.routeId).toBe("busy");
  });

  it("ignores buses with no delay reading", () => {
    const vehicles = [
      wire("mixed", 300),
      wire("mixed", 300),
      wire("mixed", 300),
      wire("mixed"),
    ];
    expect(worstDelayedRoutes(vehicles, label)[0]?.count).toBe(3);
  });

  it("leaves out routes running to time", () => {
    const vehicles = Array.from({ length: 4 }, () => wire("punctual", -30));
    expect(worstDelayedRoutes(vehicles, label)).toEqual([]);
  });

  it("names the floor it applies", () => {
    expect(MIN_BUSES_FOR_DELAY_RANKING).toBeGreaterThan(1);
  });
});
