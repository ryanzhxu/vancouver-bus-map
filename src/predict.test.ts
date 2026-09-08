import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { confidence, observedSpeed, predictDistance } from "./predict.js";

/**
 * `predict.ts` is hand-duplicated in `web/src/` because the two TypeScript
 * projects cannot import from each other. This fixture is shared by both
 * test files precisely so the two copies cannot silently drift apart — see
 * `fixtures/predict-cases.json`'s own comment.
 */
interface Fix {
  d: number;
  t: number;
}

interface PredictCase {
  name: string;
  input: { last: Fix; prev: Fix | null; now: number; trackLength: number };
  expectedSpeed: number | null;
  expectedDistance: number;
}

interface ConfidenceCase {
  name: string;
  ageMs: number;
  pollMs: number;
  expected: number;
}

interface Fixture {
  predictCases: PredictCase[];
  confidenceCases: ConfidenceCase[];
}

// `new URL(..., import.meta.url)` would work, but @cloudflare/workers-types
// declares its own global `URL` that node:fs's readFileSync does not accept —
// so resolve the path as a plain string instead.
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "predict-cases.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

describe("observedSpeed and predictDistance", () => {
  for (const testCase of fixture.predictCases) {
    it(testCase.name, () => {
      const { last, prev, now, trackLength } = testCase.input;
      expect(observedSpeed(prev, last)).toBe(testCase.expectedSpeed);
      expect(predictDistance({ last, prev, now, trackLength })).toBe(testCase.expectedDistance);
    });
  }
});

describe("confidence", () => {
  for (const testCase of fixture.confidenceCases) {
    it(testCase.name, () => {
      expect(confidence(testCase.ageMs, testCase.pollMs)).toBe(testCase.expected);
    });
  }
});
