import { DurableObject } from "cloudflare:workers";
import {
  ALERTS_EVERY,
  DAILY_LIMIT_PER_KEY,
  FEEDS,
  TRIP_UPDATE_EVERY,
  inServiceWindow,
  msUntilServiceStart,
  parseApiKeys,
  pollSecondsFor,
  vancouverHour,
} from "./config.js";
import {
  decodeAlerts,
  decodeHeader,
  decodeTripUpdates,
  decodeVehicles,
  type Alert,
  type Vehicle,
} from "./gtfs-rt.js";
import type { Env, Snapshot, StopPrediction, TripIndex } from "./types.js";
import { toWire } from "./wire.js";

/**
 * Single instance that owns every TransLink request the system makes.
 *
 * A self-rescheduling alarm is the only clock. Cron Triggers floor at one
 * minute and cannot express a 90-second cadence; Durable Object alarms take a
 * millisecond timestamp, so the poll interval is exactly what config says.
 *
 * Clients never talk to TransLink. They connect here over a hibernatable
 * WebSocket, or read the KV mirror if a socket is not available.
 */
export class LiveFeed extends DurableObject<Env> {
  private snapshot: Snapshot | null = null;
  private trips: TripIndex | null = null;
  private tripsVersion: string | null = null;

  /** Called by the Worker for any client request routed to this object. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/ws")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      // Hibernation API: the object may sleep while this socket stays open.
      this.ctx.acceptWebSocket(server);

      // Send the current state immediately so the map is populated on connect.
      const snapshot = await this.currentSnapshot();
      if (snapshot) {
        server.send(JSON.stringify(snapshot));
      }

      await this.ensureAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/snapshot")) {
      await this.ensureAlarm();
      const snapshot = await this.currentSnapshot();
      return Response.json(snapshot ?? { error: "no snapshot yet" }, {
        status: snapshot ? 200 : 503,
      });
    }

    if (url.pathname.endsWith("/predictions")) {
      const stopId = url.searchParams.get("stop");
      if (!stopId) return Response.json({ error: "stop parameter required" }, { status: 400 });

      await this.ensureAlarm();
      const byStop =
        (await this.ctx.storage.get<Record<string, StopPrediction[]>>("predictions")) ?? {};
      return Response.json({ stopId, predictions: byStop[stopId] ?? [] });
    }

    if (url.pathname.endsWith("/status")) {
      await this.ensureAlarm();
      return Response.json(await this.status());
    }

    return new Response("not found", { status: 404 });
  }

  /** Poll tick. Reschedules itself, always. */
  override async alarm(): Promise<void> {
    try {
      await this.poll();
    } catch (error) {
      // Never let a bad tick kill the loop.
      await this.ctx.storage.put("lastError", {
        at: Date.now(),
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await this.scheduleNext();
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Codes below 1000 are not valid to echo back.
    ws.close(code >= 1000 ? code : 1011, reason);
  }

  /* ---------------------------------------------------------------- */

  private async poll(): Promise<void> {
    const keys = this.apiKeys();
    if (keys.length === 0) {
      await this.ctx.storage.put("lastError", {
        at: Date.now(),
        message: "neither TRANSLINK_API_KEYS nor TRANSLINK_API_KEY is set",
      });
      return;
    }

    const tick = ((await this.ctx.storage.get<number>("tick")) ?? 0) + 1;
    await this.ctx.storage.put("tick", tick);

    const vehicles = await this.fetchFeed(FEEDS.positions, keys, decodeVehicles);
    if (vehicles) {
      await this.ctx.storage.put("vehicles", vehicles);
    }

    if (tick % TRIP_UPDATE_EVERY === 0) {
      const updates = await this.fetchFeed(FEEDS.tripUpdates, keys, decodeTripUpdates);
      if (updates) {
        await this.ctx.storage.put("predictions", indexPredictionsByStop(updates));
      }
    }

    if (tick % ALERTS_EVERY === 1) {
      const alerts = await this.fetchFeed(FEEDS.alerts, keys, decodeAlerts);
      if (alerts) {
        await this.ctx.storage.put("alerts", alerts);
      }
    }

    const snapshot = await this.buildSnapshot();
    this.snapshot = snapshot;

    this.broadcast(snapshot);
  }

  private async fetchFeed<T>(
    url: string,
    keys: string[],
    decode: (buf: Uint8Array) => T,
  ): Promise<T | null> {
    const key = await this.spendKey(keys);

    const response = await fetch(`${url}?apikey=${key}`, {
      cf: { cacheTtl: 0 },
      headers: { "user-agent": "vancouver-bus-map (+https://github.com/ryanzhxu)" },
    });

    if (!response.ok) {
      // The key never appears here. A 401 from a revoked key would otherwise
      // put a live credential into stored error text and /api/live/status.
      throw new Error(`${url} returned ${response.status}`);
    }

    const buf = new Uint8Array(await response.arrayBuffer());
    const header = decodeHeader(buf);
    await this.ctx.storage.put("feedTimestamp", header.timestamp ?? null);

    if (url === FEEDS.positions) {
      await this.recordFeedRefresh(header.timestamp ?? null);
    }

    return decode(buf);
  }

  /** Keys currently configured, newest secret format first. */
  private apiKeys(): string[] {
    return parseApiKeys(this.env.TRANSLINK_API_KEYS, this.env.TRANSLINK_API_KEY);
  }

  /**
   * Charge one request to the least-spent key that still has budget.
   *
   * Least-spent rather than round-robin because retries do not distribute
   * evenly: a feed that fails and is retried would walk the rotation forward,
   * and over a day the drift is enough to exhaust one key while another sits
   * unused. The counter increments before the request goes out, since a failed
   * request still counts against TransLink's cap.
   */
  private async spendKey(keys: string[]): Promise<string> {
    const today = this.vancouverDate();
    const stored = await this.ctx.storage.get<KeyLedger>("keyLedger");

    // A changed key count invalidates the positional counts entirely — index 1
    // is a different key than it was yesterday — so the ledger starts over.
    const counts =
      stored && stored.date === today && stored.counts.length === keys.length
        ? [...stored.counts]
        : new Array<number>(keys.length).fill(0);

    let chosen = -1;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i]! >= DAILY_LIMIT_PER_KEY) continue;
      if (chosen === -1 || counts[i]! < counts[chosen]!) chosen = i;
    }

    if (chosen === -1) {
      throw new Error(`all ${keys.length} keys have spent their daily cap`);
    }

    counts[chosen] = counts[chosen]! + 1;
    await this.ctx.storage.put("keyLedger", { date: today, counts });
    return keys[chosen]!;
  }

  /**
   * Count how often a poll returns a feed we have already seen.
   *
   * TransLink does not publish how often the positions feed is regenerated,
   * and polling faster than it refreshes spends quota on identical bytes. A
   * duplicate rate near zero means 30s is inside the feed's own cadence; a
   * rate near half would mean the feed moves at 60s and the third key is
   * buying nothing. This measures that for free, out of polls already made.
   */
  private async recordFeedRefresh(timestamp: number | null): Promise<void> {
    const today = this.vancouverDate();
    const stored = await this.ctx.storage.get<FeedRefresh>("feedRefresh");
    const fresh = stored && stored.date === today ? stored : { date: today, samples: 0, duplicates: 0, last: null };

    const duplicate = timestamp !== null && timestamp === fresh.last;
    await this.ctx.storage.put("feedRefresh", {
      date: today,
      samples: fresh.samples + 1,
      duplicates: fresh.duplicates + (duplicate ? 1 : 0),
      last: timestamp,
    });
  }

  /** Calendar date in Vancouver, the boundary every daily counter resets on. */
  private vancouverDate(): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(new Date());
  }

  private async buildSnapshot(): Promise<Snapshot> {
    const vehicles = (await this.ctx.storage.get<Vehicle[]>("vehicles")) ?? [];
    const feedTimestamp = (await this.ctx.storage.get<number | null>("feedTimestamp")) ?? null;
    const trips = await this.tripIndex();
    const predictions =
      (await this.ctx.storage.get<Record<string, StopPrediction[]>>("predictions")) ?? {};

    return {
      type: "snapshot",
      generatedAt: Date.now(),
      feedTimestamp,
      // The client sizes its extrapolation horizon from this, so it has to be
      // the rate we are really polling at, not the rate config aims for. They
      // differ whenever a key is missing.
      pollSeconds: pollSecondsFor(this.apiKeys().length),
      vehicles: vehicles.map((v) => toWire(v, trips, predictions)),
    };
  }

  /**
   * The static trip index, held in memory.
   *
   * 128k entries is roughly 7MB against a 128MB limit, and it saves shipping
   * the same index to every phone. Loaded once per isolate and refreshed only
   * when a new GTFS build is published.
   */
  private async tripIndex(): Promise<TripIndex | null> {
    const version = await this.env.SNAPSHOT.get("gtfs_current");
    if (!version) return null;
    if (this.trips && this.tripsVersion === version) return this.trips;

    const object = await this.env.GTFS.get(`v/${version}/trips.json`);
    if (!object) return null;

    this.trips = (await object.json()) as TripIndex;
    this.tripsVersion = version;
    return this.trips;
  }

  private async currentSnapshot(): Promise<Snapshot | null> {
    if (this.snapshot) return this.snapshot;
    const vehicles = await this.ctx.storage.get<Vehicle[]>("vehicles");
    if (!vehicles) return null;
    this.snapshot = await this.buildSnapshot();
    return this.snapshot;
  }

  private broadcast(snapshot: Snapshot): void {
    const payload = JSON.stringify(snapshot);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // A dead socket must not stop the others.
      }
    }
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.scheduleNext();
    }
  }

  /** Next tick inside the window, or the start of the next service day. */
  private async scheduleNext(): Promise<void> {
    const now = new Date();
    const delayMs = inServiceWindow(now)
      ? pollSecondsFor(this.apiKeys().length) * 1000
      : msUntilServiceStart(now);
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  private async status() {
    const [tick, ledger, refresh, lastError, feedTimestamp, vehicles] = await Promise.all([
      this.ctx.storage.get<number>("tick"),
      this.ctx.storage.get<KeyLedger>("keyLedger"),
      this.ctx.storage.get<FeedRefresh>("feedRefresh"),
      this.ctx.storage.get<{ at: number; message: string }>("lastError"),
      this.ctx.storage.get<number | null>("feedTimestamp"),
      this.ctx.storage.get<Vehicle[]>("vehicles"),
    ]);

    const counts = ledger?.counts ?? [];
    const keyCount = this.apiKeys().length;

    return {
      tick: tick ?? 0,
      requestsToday: counts.reduce((sum, n) => sum + n, 0),
      // Per key, not just the total: the cap is per key, so one exhausted key
      // among three is the failure that a pooled number would hide.
      requestsByKey: counts,
      requestDate: ledger?.date ?? null,
      keys: keyCount,
      pollSeconds: pollSecondsFor(keyCount),
      vehicles: vehicles?.length ?? 0,
      // Coerce undefined to null so the key survives JSON.stringify.
      feedTimestamp: feedTimestamp ?? null,
      // Non-zero means we are polling faster than TransLink regenerates the
      // feed, and the surplus keys are buying identical bytes.
      feedRefresh: refresh
        ? { samples: refresh.samples, duplicates: refresh.duplicates, date: refresh.date }
        : null,
      inServiceWindow: inServiceWindow(new Date()),
      vancouverHour: vancouverHour(new Date()),
      openSockets: this.ctx.getWebSockets().length,
      hasApiKey: keyCount > 0,
      lastError: lastError ?? null,
      nextAlarm: await this.ctx.storage.getAlarm(),
    };
  }
}

/** Requests charged to each key today, positional against the parsed key list. */
interface KeyLedger {
  date: string;
  counts: number[];
}

/** How many position polls returned a feed timestamp we had already seen. */
interface FeedRefresh {
  date: string;
  samples: number;
  duplicates: number;
  last: number | null;
}

/* ------------------------------------------------------------------ */

function indexPredictionsByStop(
  updates: ReturnType<typeof decodeTripUpdates>,
): Record<string, StopPrediction[]> {
  const byStop: Record<string, StopPrediction[]> = {};

  for (const trip of updates) {
    for (const stu of trip.stopTimeUpdates) {
      if (!stu.stopId) continue;
      (byStop[stu.stopId] ??= []).push({
        routeId: trip.routeId ?? "",
        tripId: trip.tripId ?? "",
        time: stu.time ?? null,
        delay: stu.delay ?? null,
      });
    }
  }

  for (const list of Object.values(byStop)) {
    list.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
  }

  return byStop;
}


export type { Alert };
