import { readFileSync } from "node:fs";
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

const fixture = JSON.parse(
  readFileSync(new URL("../../fixtures/predict-cases.json", import.meta.url), "utf8"),
) as Fixture;

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
