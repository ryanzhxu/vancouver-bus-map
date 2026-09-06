import { describe, expect, it } from "vitest";
import {
  BASEMAP_CHAIN,
  CARTO,
  OPENFREEMAP,
  basemapStyle,
  nextBasemap,
} from "./basemap.js";

describe("basemapStyle", () => {
  it("returns the light url for the light theme", () => {
    expect(basemapStyle(OPENFREEMAP, false)).toBe(OPENFREEMAP.light);
  });

  it("returns the dark url for the dark theme", () => {
    expect(basemapStyle(CARTO, true)).toBe(CARTO.dark);
  });
});

describe("nextBasemap", () => {
  it("defaults to OpenFreeMap and falls back to CARTO", () => {
    expect(BASEMAP_CHAIN[0]).toBe(OPENFREEMAP);
    expect(nextBasemap(OPENFREEMAP)).toBe(CARTO);
  });

  it("stops at the end of the chain so a total outage cannot loop", () => {
    expect(nextBasemap(CARTO)).toBeNull();
  });

  it("returns null for a provider outside the chain", () => {
    expect(nextBasemap({ name: "other", light: "l", dark: "d" })).toBeNull();
  });
});
