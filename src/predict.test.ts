import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { confidence, observedSpeed } from "./predict.js";

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

interface SpeedCase {
  name: string;
  prev: Fix | null;
  last: Fix;
  expected: number | null;
}

interface ConfidenceCase {
  name: string;
  ageMs: number;
  pollMs: number;
  expected: number;
}

interface Fixture {
  speedCases: SpeedCase[];
  confidenceCases: ConfidenceCase[];
}

// `new URL(..., import.meta.url)` would work, but @cloudflare/workers-types
// declares its own global `URL` that node:fs's readFileSync does not accept —
// so resolve the path as a plain string instead.
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "predict-cases.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

describe("observedSpeed", () => {
  for (const testCase of fixture.speedCases) {
    it(testCase.name, () => {
      expect(observedSpeed(testCase.prev, testCase.last)).toBe(testCase.expected);
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
