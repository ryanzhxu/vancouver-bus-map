import { afterEach, describe, expect, it, vi } from "vitest";
import { handleFlowTile } from "./traffic-flow.js";
import type { Env } from "./types.js";

const env = (key?: string): Env => ({ TOMTOM_API_KEY: key }) as Env;

/** A plain in-memory stand-in for the Workers runtime's `caches.default`. */
function fakeCache(): Cache {
  const store = new Map<string, Response>();
  return {
    match: async (request: Request) => store.get(request.url),
    put: async (request: Request, response: Response) => {
      store.set(request.url, response);
    },
  } as unknown as Cache;
}

describe("handleFlowTile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("503s when no TomTom key has been configured yet", async () => {
    const response = await handleFlowTile(
      new URL("https://example.com/api/traffic/flow-tile/10/163/396.pbf"),
      env(undefined),
      fakeCache(),
    );
    expect(response.status).toBe(503);
  });

  it("rejects a path that is not a tile request", async () => {
    const response = await handleFlowTile(
      new URL("https://example.com/api/traffic/flow-tile/not-a-tile"),
      env("key"),
      fakeCache(),
    );
    expect(response.status).toBe(400);
  });

  it("rejects an x/y outside that zoom level's grid", async () => {
    // Zoom 2 only has a 4x4 grid (0..3); 99 cannot be a real tile.
    const response = await handleFlowTile(
      new URL("https://example.com/api/traffic/flow-tile/2/99/0.pbf"),
      env("key"),
      fakeCache(),
    );
    expect(response.status).toBe(400);
  });

  it("proxies a valid tile to TomTom with the key attached, and caches it", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cache = fakeCache();

    const url = new URL("https://example.com/api/traffic/flow-tile/10/163/396.pbf");
    const first = await handleFlowTile(url, env("secret-key"), cache);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/x-protobuf");

    const requested = new URL(fetchMock.mock.calls[0]![0] as unknown as string);
    expect(requested.pathname).toBe("/traffic/map/4/tile/flow/relative/10/163/396.pbf");
    expect(requested.searchParams.get("key")).toBe("secret-key");

    // A second request for the same tile must be served from cache, not refetched.
    const second = await handleFlowTile(url, env("secret-key"), cache);
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("502s when TomTom's own request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));

    const response = await handleFlowTile(
      new URL("https://example.com/api/traffic/flow-tile/10/163/396.pbf"),
      env("key"),
      fakeCache(),
    );
    expect(response.status).toBe(502);
  });
});
