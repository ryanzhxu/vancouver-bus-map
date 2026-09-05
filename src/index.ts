import { DAILY_LIMIT, TRANSLINK_ATTRIBUTION, dailyRequestBudget } from "./config.js";
import type { Env } from "./types.js";

export { LiveFeed } from "./live-feed.js";

/** One instance owns the whole region's feed, so the name is a constant. */
const FEED_ID = "metro-vancouver";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      const budget = dailyRequestBudget();
      return Response.json({
        ok: true,
        service: "vancouver-bus-map",
        budget: { ...budget, limit: DAILY_LIMIT, headroom: DAILY_LIMIT - budget.total },
        attribution: TRANSLINK_ATTRIBUTION,
      });
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
