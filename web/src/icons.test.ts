import { describe, expect, it } from "vitest";
import { distinctRouteColors, iconName } from "./icons.js";
import type { RouteInfo } from "./gtfs.js";

const route = (over: Partial<RouteInfo> = {}): RouteInfo => ({
  s: "010",
  n: "Granville",
  t: 3,
  c: null,
  x: null,
  ...over,
});

describe("iconName", () => {
  it("names an icon by shape and colour", () => {
    expect(iconName("bus", "#008522")).toBe("bus-008522");
  });

  it("is case insensitive, so one colour never registers twice", () => {
    expect(iconName("chevron", "#D04110")).toBe(iconName("chevron", "#d04110"));
  });
});

describe("distinctRouteColors", () => {
  it("returns the fallback when no route carries a colour", () => {
    const routes = new Map([["1", route()]]);
    expect(distinctRouteColors(routes, "#0b6ea8")).toEqual(["#0b6ea8"]);
  });

  it("collects each route colour once, including the fallback", () => {
    const routes = new Map([
      ["1", route({ c: "008522" })],
      ["2", route({ c: "008522" })],
      ["3", route({ c: "d04110" })],
      ["4", route({ c: null })],
    ]);
    const colors = distinctRouteColors(routes, "#0b6ea8");
    // Sorted on a copy: both tsconfigs set lib to ES2022, and toSorted is ES2023.
    expect([...colors].sort()).toEqual(["#008522", "#0b6ea8", "#d04110"]);
  });
});
