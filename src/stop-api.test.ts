import { describe, expect, it } from "vitest";
import { parseLimit } from "./stop-api.js";

/**
 * The `limit` query value is untrusted. `Number("abc")` is NaN, and
 * `[...].slice(0, NaN)` returns nothing, so a bad value must fall back to the
 * default rather than hide every departure.
 */
describe("parseLimit", () => {
  it("keeps a positive integer", () => {
    expect(parseLimit("6")).toBe(6);
    expect(parseLimit("1")).toBe(1);
  });

  it("falls back to the default when the value is missing", () => {
    expect(parseLimit(null)).toBe(8);
    expect(parseLimit("")).toBe(8);
  });

  it("falls back to the default instead of emptying the list on a bad value", () => {
    expect(parseLimit("abc")).toBe(8);
  });

  it("rejects zero, negatives, and fractions", () => {
    expect(parseLimit("0")).toBe(8);
    expect(parseLimit("-3")).toBe(8);
    expect(parseLimit("3.5")).toBe(8);
  });
});
