import { afterEach, describe, expect, it, vi } from "vitest";
import { GtfsData } from "./gtfs.js";

/** A minimal ok/not-ok Response stand-in for the global fetch mock. */
function json(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data } as unknown as Response;
}

const MANIFEST = { version: "v1", builtAt: "now", counts: {} };

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Route geometry loads lazily and is meant to fetch each bundle once. But a
 * dropped fetch on a flaky phone connection must not be cached as "done": if it
 * were, the route would glide on straight lines for the life of the tab, never
 * retrying even after the network recovers.
 */
describe("GtfsData.ensureRoute", () => {
  it("retries a bundle whose first fetch failed, once the network recovers", async () => {
    let shapesCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/gtfs/manifest") return json(MANIFEST);
      if (url.endsWith("routes.json")) return json({});
      if (url.endsWith("shapes/R1.json")) {
        shapesCalls++;
        if (shapesCalls === 1) throw new TypeError("network down");
        return json({ shapeA: [[49, -123], [49.001, -123]] });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const gtfs = new GtfsData();
    await gtfs.load();

    await gtfs.ensureRoute("R1");
    expect(gtfs.trackFor("shapeA")).toBeNull();

    await gtfs.ensureRoute("R1");
    expect(gtfs.trackFor("shapeA")).not.toBeNull();
    expect(shapesCalls).toBe(2);
  });

  it("fetches a bundle only once when the first load succeeds", async () => {
    let shapesCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/gtfs/manifest") return json(MANIFEST);
      if (url.endsWith("routes.json")) return json({});
      if (url.endsWith("shapes/R1.json")) {
        shapesCalls++;
        return json({ shapeA: [[49, -123], [49.001, -123]] });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const gtfs = new GtfsData();
    await gtfs.load();

    await gtfs.ensureRoute("R1");
    await gtfs.ensureRoute("R1");
    expect(shapesCalls).toBe(1);
    expect(gtfs.trackFor("shapeA")).not.toBeNull();
  });
});
