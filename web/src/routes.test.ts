import { describe, expect, it } from "vitest";
import { isExpress } from "./routes.js";

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
