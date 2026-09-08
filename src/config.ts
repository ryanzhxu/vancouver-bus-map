/**
 * Poll budget.
 *
 * TransLink's Open API Terms of Use cap one API key at 1,000 requests per day,
 * across all feeds. Everything here exists to stay under that ceiling while
 * keeping the map feeling live. Changing any constant changes the daily spend,
 * so `dailyRequestBudget()` below is asserted in tests.
 *
 * Three keys are configured, so the ceiling is 3,000. The whole of it buys
 * rider-facing freshness: the model that predicts positions between ticks
 * trains on bytes this poller already fetched and never issues a request of
 * its own. There is deliberately no code path from training to TransLink.
 *
 * Service window 07:00-23:00 Pacific = 16h = 57,600s, so 1,920 ticks at 30s.
 *
 *   positions  every tick        = 1,920 requests
 *   trips      every 2nd tick    =   960 requests   (60s predictions)
 *   alerts     every 120th tick  =    16 requests   (hourly)
 *                                  ------------
 *                                    2,896 of 3,000
 *
 * That leaves 104 requests of headroom for retries and manual pokes. Do not
 * spend it on a faster poll: a failed request still counts against the cap.
 *
 * ALERTS_EVERY tripled from 40 to 120 when the tick tripled in rate. That is
 * the point: alerts describe elevator outages and detours, which do not change
 * three times faster because we look three times more often. Holding them at
 * hourly returned 32 requests to headroom.
 */

export const POLL_SECONDS = 30;

/** Fetch trip updates every Nth tick. 30s * 2 = 60s predictions. */
export const TRIP_UPDATE_EVERY = 2;

/** Fetch alerts every Nth tick. 30s * 120 = 60 min. */
export const ALERTS_EVERY = 120;

/** Local Vancouver hours during which we poll at all. */
export const SERVICE_START_HOUR = 7;
export const SERVICE_END_HOUR = 23;

export const FEEDS = {
  positions: "https://gtfsapi.translink.ca/v3/gtfsposition",
  tripUpdates: "https://gtfsapi.translink.ca/v3/gtfsrealtime",
  alerts: "https://gtfsapi.translink.ca/v3/gtfsalerts",
} as const;

/** Mandated by TransLink's Terms of Use. Must be visible wherever data is shown. */
export const TRANSLINK_ATTRIBUTION =
  "Some of the data used in this product or service is provided by permission of " +
  "TransLink. TransLink assumes no responsibility for the accuracy or currency of " +
  "the Data used in this product or service.";

/**
 * The cap is per key, not per account or per app — TransLink's terms read
 * "Your API Key will authorize you to offer a maximum of 1,000 requests per
 * day". Spend is therefore tracked per key, never as one pooled total: an
 * uneven split could drain one key to 1,000 while the others sat idle, and
 * only the per-key ledger catches that.
 */
export const DAILY_LIMIT_PER_KEY = 1000;

/** Requests spent per service day at the current settings, across all keys. */
export function dailyRequestBudget(): {
  positions: number;
  tripUpdates: number;
  alerts: number;
  total: number;
} {
  const windowSeconds = (SERVICE_END_HOUR - SERVICE_START_HOUR) * 3600;
  const ticks = Math.floor(windowSeconds / POLL_SECONDS);

  const positions = ticks;
  const tripUpdates = Math.floor(ticks / TRIP_UPDATE_EVERY);
  const alerts = Math.floor(ticks / ALERTS_EVERY);

  return { positions, tripUpdates, alerts, total: positions + tripUpdates + alerts };
}

/** How many keys the cadence above actually needs to stay legal. */
export function requiredKeyCount(): number {
  return Math.ceil(dailyRequestBudget().total / DAILY_LIMIT_PER_KEY);
}

/**
 * Keys, newest format first.
 *
 * TRANSLINK_API_KEYS holds them comma-separated so a fourth key is a secret
 * update rather than a deploy. TRANSLINK_API_KEY is the original single-key
 * secret, kept as a fallback so a rollback to the previous Worker version
 * still has something to poll with.
 *
 * Duplicates are dropped because two entries pointing at the same key would
 * make the per-key ledger believe it had twice the budget it really has.
 */
export function parseApiKeys(keys?: string, legacy?: string): string[] {
  const raw = keys && keys.trim() !== "" ? keys : (legacy ?? "");
  return [...new Set(raw.split(",").map((k) => k.trim()).filter((k) => k !== ""))];
}

/**
 * Poll interval for the number of keys actually configured.
 *
 * TransLink may terminate a key on ten days' written notice, and a revoked or
 * mistyped key must not translate into three times the legal request rate on
 * the keys that remain. Fewer keys therefore stretch the interval in exact
 * proportion: 3 keys give 30s, 2 give 45s, 1 gives the original 90s. The map
 * gets slower, never illegal.
 */
export function pollSecondsFor(keyCount: number): number {
  if (keyCount >= requiredKeyCount()) return POLL_SECONDS;
  if (keyCount <= 0) return POLL_SECONDS * requiredKeyCount();
  return (POLL_SECONDS * requiredKeyCount()) / keyCount;
}

/** Vancouver-local hour (0-23), correct across the PST/PDT boundary. */
export function vancouverHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    hour: "numeric",
    hour12: false,
  }).format(now);
  return Number(hour) % 24;
}

export function inServiceWindow(now: Date): boolean {
  const hour = vancouverHour(now);
  return hour >= SERVICE_START_HOUR && hour < SERVICE_END_HOUR;
}

/**
 * Milliseconds to sleep when we are outside the service window.
 * Always positive, so an alarm can never be scheduled in the past.
 */
export function msUntilServiceStart(now: Date): number {
  const hour = vancouverHour(now);
  const hoursAway =
    hour < SERVICE_START_HOUR ? SERVICE_START_HOUR - hour : 24 - hour + SERVICE_START_HOUR;

  // Land shortly after the hour turns rather than exactly on it.
  const ms = hoursAway * 3600_000 - now.getMinutes() * 60_000 + 30_000;
  return Math.max(ms, 60_000);
}
