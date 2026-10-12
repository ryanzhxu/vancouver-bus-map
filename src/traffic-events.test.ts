import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTrafficEvents, mapOpen511Events } from "./traffic-events.js";

describe("mapOpen511Events", () => {
  it("keeps only the fields the map needs, renaming the wire's snake_case", () => {
    const events = mapOpen511Events({
      events: [
        {
          id: "drivebc.ca/RIDE-1",
          headline: "CONSTRUCTION",
          severity: "MINOR",
          event_type: "CONSTRUCTION",
          geography: { type: "Point", coordinates: [-123.1, 49.2] },
        },
      ],
    });

    expect(events).toEqual([
      {
        id: "drivebc.ca/RIDE-1",
        headline: "CONSTRUCTION",
        severity: "MINOR",
        eventType: "CONSTRUCTION",
        geometry: { type: "Point", coordinates: [-123.1, 49.2] },
      },
    ]);
  });

  it("returns an empty list for no events", () => {
    expect(mapOpen511Events({ events: [] })).toEqual([]);
  });
});

describe("handleTrafficEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves DriveBC's events mapped to the map's slim shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            events: [
              {
                id: "drivebc.ca/RIDE-2",
                headline: "INCIDENT",
                severity: "MAJOR",
                event_type: "INCIDENT",
                geography: { type: "LineString", coordinates: [[-123, 49], [-122.9, 49.1]] },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const response = await handleTrafficEvents();
    const body = (await response.json()) as { events: unknown[] };

    expect(body.events).toEqual([
      {
        id: "drivebc.ca/RIDE-2",
        headline: "INCIDENT",
        severity: "MAJOR",
        eventType: "INCIDENT",
        geometry: { type: "LineString", coordinates: [[-123, 49], [-122.9, 49.1]] },
      },
    ]);
  });
});
