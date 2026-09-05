/**
 * Which GTFS services run right now, and what "now" is in GTFS terms.
 *
 * Two things make this less obvious than it looks:
 *
 * 1. GTFS times can exceed 24 hours. A trip listed at 25:14:00 belongs to the
 *    previous service day. At 01:14 on Saturday, the bus you are waiting for is
 *    Friday's 25:14 departure, so both service days must be considered.
 *
 * 2. calendar.txt gives a weekly pattern and calendar_dates.txt overrides it
 *    per date. A holiday removes the weekday service and adds a Sunday one.
 */

export interface CalendarService {
  /** Sunday-first, matching GTFS column order. */
  days: number[];
  from: string;
  to: string;
}

export interface CalendarData {
  services: Record<string, CalendarService>;
  /** serviceId -> [[YYYYMMDD, 1 add | 2 remove], ...] */
  exceptions: Record<string, Array<[string, number]>>;
}

/** A service day plus the offset to add to its GTFS seconds. */
export interface ServiceWindow {
  /** YYYYMMDD in Vancouver local time. */
  date: string;
  /** Seconds since midnight of `date`, may exceed 86400. */
  nowSeconds: number;
}

const DAY_SECONDS = 86_400;

/** Vancouver-local date as YYYYMMDD. */
export function vancouverDate(now: Date, offsetDays = 0): string {
  const shifted = new Date(now.getTime() + offsetDays * DAY_SECONDS * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

/** Seconds since Vancouver-local midnight. */
export function vancouverSeconds(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // en-CA renders midnight as 24; normalise so 24:00:15 becomes 15 seconds.
  return (get("hour") % 24) * 3600 + get("minute") * 60 + get("second");
}

/** GTFS weekday index, Sunday = 0, for a YYYYMMDD string. */
export function weekdayOf(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Service ids running on `date`, honouring calendar_dates overrides. */
export function servicesOn(calendar: CalendarData, date: string): Set<string> {
  const active = new Set<string>();
  const weekday = weekdayOf(date);

  for (const [id, service] of Object.entries(calendar.services)) {
    const inRange =
      (!service.from || date >= service.from) && (!service.to || date <= service.to);
    if (inRange && service.days[weekday] === 1) active.add(id);
  }

  for (const [id, entries] of Object.entries(calendar.exceptions)) {
    for (const [exceptionDate, type] of entries) {
      if (exceptionDate !== date) continue;
      if (type === 1) active.add(id);
      else if (type === 2) active.delete(id);
    }
  }

  return active;
}

/**
 * The service days a departure could belong to right now.
 *
 * Today is always included. Yesterday is included too, because its trips after
 * midnight are expressed as 24:00:00 and later and are still running.
 */
export function activeWindows(now: Date): ServiceWindow[] {
  const today = vancouverDate(now);
  const yesterday = vancouverDate(now, -1);
  const seconds = vancouverSeconds(now);

  return [
    { date: today, nowSeconds: seconds },
    // Same instant, expressed against yesterday's midnight.
    { date: yesterday, nowSeconds: seconds + DAY_SECONDS },
  ];
}

/** Absolute epoch seconds for a GTFS time on a given service date. */
export function epochFor(date: string, gtfsSeconds: number): number {
  return vancouverMidnightEpoch(date) + gtfsSeconds;
}

/**
 * Epoch seconds of Vancouver-local midnight for `date`.
 *
 * The zone offset is measured at midday on that date. Midday is deliberate: it
 * is never inside either clock change, so the offset is unambiguous even on the
 * two switch days of the year.
 */
export function vancouverMidnightEpoch(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));

  const middayUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const offsetMinutes = zoneOffsetMinutes(middayUtc);

  // Vancouver is behind UTC, so its offset is negative and local midnight
  // falls *after* UTC midnight. Subtracting a negative adds the hours back.
  return Math.floor(Date.UTC(year, month - 1, day) / 1000) - offsetMinutes * 60;
}

/**
 * Vancouver's UTC offset in minutes at `at`.
 * Returns -420 during PDT and -480 during PST.
 */
export function zoneOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Vancouver",
    timeZoneName: "longOffset",
  }).formatToParts(at);

  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-08:00";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return -480;

  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}
