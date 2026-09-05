/**
 * Poll budget.
 *
 * TransLink's Open API Terms of Use cap one API key at 1,000 requests per day,
 * across all feeds. Everything here exists to stay under that ceiling while
 * keeping the map feeling live. Changing any constant changes the daily spend,
 * so `dailyRequestBudget()` below is asserted in tests.
 *
 * Service window 07:00-23:00 Pacific = 16h = 57,600s, so 640 ticks at 90s.
 *
 *   positions  every tick        = 640 requests
 *   trips      every 2nd tick    = 320 requests   (3 min predictions)
 *   alerts     every 40th tick   =  16 requests   (hourly)
 *                                  ------------
 *                                    976 of 1,000
 *
 * That leaves 24 requests of headroom for retries and manual pokes. Do not
 * spend it on a faster poll: a failed request still counts against the cap.
 */

export const POLL_SECONDS = 90;

/** Fetch trip updates every Nth tick. 90s * 2 = 3 min predictions. */
export const TRIP_UPDATE_EVERY = 2;

/** Fetch alerts every Nth tick. 90s * 40 = 60 min. */
export const ALERTS_EVERY = 40;

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

/** Requests spent per service day at the current settings. */
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

export const DAILY_LIMIT = 1000;

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
