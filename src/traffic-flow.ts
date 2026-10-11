import type { Env } from "./types.js";

/**
 * GET /api/traffic/flow-tile/{z}/{x}/{y}.pbf — a live traffic-speed vector
 * tile, proxied from TomTom.
 *
 * Unlike DriveBC's handful of events, tile coordinates are effectively
 * unbounded (every zoom/x/y a rider's viewport ever requests), so a hand-
 * rolled in-memory cache would grow without limit over an isolate's life.
 * The platform's own edge cache already solves bounded, shared caching for
 * exactly this shape of request, so this is the one route in the Worker that
 * reaches for it instead of the cached-per-isolate pattern used elsewhere.
 *
 * TomTom's free tier is 50,000 tile requests per day for the whole account,
 * shared across every visitor — not per key, per domain. Serving tiles
 * through the Worker (rather than straight from the browser) means they can
 * be cached here, and overage is blocked rather than billed, so a traffic
 * spike degrades to "layer stops updating" rather than a surprise charge.
 */

const TOMTOM_TILE_URL = "https://api.tomtom.com/traffic/map/4/tile/flow/relative";

// TomTom's flow data refreshes about once a minute; caching much longer than
// that would show a rider a stale jam that has already cleared.
const CACHE_SECONDS = 90;

const TILE_PATH = /^\/api\/traffic\/flow-tile\/(\d+)\/(\d+)\/(\d+)\.pbf$/;

export async function handleFlowTile(
  url: URL,
  env: Env,
  // Injectable so tests can pass a plain in-memory stand-in: Node has no
  // Workers runtime and so no real `caches` global to exercise.
  cache: Cache = caches.default,
): Promise<Response> {
  if (!env.TOMTOM_API_KEY) {
    return Response.json({ error: "traffic flow is not configured" }, { status: 503 });
  }

  const match = TILE_PATH.exec(url.pathname);
  if (!match) return Response.json({ error: "bad tile path" }, { status: 400 });

  const [, z, x, y] = match;
  const zoom = Number(z);
  // A tile's x/y must sit on that zoom level's grid — a stray value can't
  // correspond to a real tile, let alone one worth asking TomTom for.
  const span = 2 ** zoom;
  if (zoom > 22 || Number(x) >= span || Number(y) >= span) {
    return Response.json({ error: "tile out of range" }, { status: 400 });
  }

  const cacheKey = new Request(url.toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstream = new URL(`${TOMTOM_TILE_URL}/${z}/${x}/${y}.pbf`);
  upstream.searchParams.set("key", env.TOMTOM_API_KEY);

  const response = await fetch(upstream);
  if (!response.ok) {
    return Response.json({ error: "upstream traffic request failed" }, { status: 502 });
  }

  const tile = new Response(response.body, {
    headers: {
      "content-type": "application/x-protobuf",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });

  // Cloudflare rejects storing a response whose body has already been
  // consumed, hence the clone — the one returned to this request and the one
  // handed to the cache must be independent streams.
  await cache.put(cacheKey, tile.clone());
  return tile;
}
