import {
  DAILY_LIMIT_PER_KEY,
  TRANSLINK_ATTRIBUTION,
  dailyRequestBudget,
  parseApiKeys,
  pollSecondsFor,
} from "./config.js";
import { handleAsset, handleManifest } from "./gtfs-assets.js";
import { handleStop } from "./stop-api.js";
import type { Env } from "./types.js";

export { LiveFeed } from "./live-feed.js";

/** One instance owns the whole region's feed, so the name is a constant. */
const FEED_ID = "metro-vancouver";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      const budget = dailyRequestBudget();
      // The ceiling is per key, so it moves with how many are configured.
      // Reported rather than assumed: a key removed from the secret silently
      // changes both the legal limit and the poll rate, and health is where
      // that becomes visible without reading storage.
      const keyCount = parseApiKeys(env.TRANSLINK_API_KEYS, env.TRANSLINK_API_KEY).length;
      const limit = DAILY_LIMIT_PER_KEY * keyCount;
      return Response.json({
        ok: true,
        service: "vancouver-bus-map",
        keys: keyCount,
        pollSeconds: pollSecondsFor(keyCount),
        budget: { ...budget, limit, headroom: limit - budget.total },
        attribution: TRANSLINK_ATTRIBUTION,
      });
    }

    if (url.pathname === "/api/gtfs/manifest") {
      return handleManifest(env);
    }

    if (url.pathname.startsWith("/gtfs/")) {
      return handleAsset(url, env);
    }

    if (url.pathname.startsWith("/api/stop/")) {
      return handleStop(url, env, env.LIVE_FEED.getByName(FEED_ID));
    }

    // Everything under /api/live is served by the Durable Object.
    if (url.pathname.startsWith("/api/live")) {
      const stub = env.LIVE_FEED.getByName(FEED_ID);
      return stub.fetch(request);
    }

    if (url.pathname === "/ws") {
      const stub = env.LIVE_FEED.getByName(FEED_ID);
      return stub.fetch(new Request(new URL("/ws", url), request));
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
