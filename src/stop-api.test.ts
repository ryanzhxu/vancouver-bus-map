import { describe, expect, it } from "vitest";
import { parseLimit } from "./stop-api.js";

describe("parseLimit", () => {
  it("keeps a positive integer", () => {
    expect(parseLimit("5")).toBe(5);
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("100")).toBe(100);
  });

  it("defaults to 8 when the parameter is absent", () => {
    expect(parseLimit(null)).toBe(8);
  });

  it("defaults to 8 for a non-numeric value, so ?limit=abc never hides the timetable", () => {
    // Number("abc") is NaN, and slice(0, NaN) returns an empty array.
    expect(parseLimit("abc")).toBe(8);
  });

  it("defaults to 8 for an empty value, so ?limit= never hides the timetable", () => {
    // Number("") is 0, and slice(0, 0) returns an empty array.
    expect(parseLimit("")).toBe(8);
  });

  it("defaults to 8 for zero and negative values", () => {
    expect(parseLimit("0")).toBe(8);
    expect(parseLimit("-3")).toBe(8);
  });

  it("rejects a fractional value rather than passing a float to slice", () => {
    expect(parseLimit("5.5")).toBe(8);
  });
});
