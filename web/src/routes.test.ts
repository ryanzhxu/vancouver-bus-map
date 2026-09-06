import { describe, expect, it } from "vitest";
import { isExpress, searchRoutes, shouldDim, type Highlight } from "./routes.js";
import type { RouteInfo } from "./gtfs.js";

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
