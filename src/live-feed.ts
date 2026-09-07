import { DurableObject } from "cloudflare:workers";
import {
  ALERTS_EVERY,
  FEEDS,
  POLL_SECONDS,
  TRIP_UPDATE_EVERY,
  inServiceWindow,
  msUntilServiceStart,
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
import { round5, toWire } from "./wire.js";

const SNAPSHOT_KEY = "live:snapshot";

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
      // previous rides along only here, not on the periodic broadcast below —
      // it exists so THIS client's first ingest has two real fixes to glide
      // between, not to repeat every ~90s to sockets that already have one.
      const snapshot = await this.currentSnapshot();
      if (snapshot) {
        server.send(JSON.stringify({ ...snapshot, previous: await this.previousPositions() }));
      }

      await this.ensureAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/snapshot")) {
      await this.ensureAlarm();
      const snapshot = await this.currentSnapshot();
      const body = snapshot
        ? { ...snapshot, previous: await this.previousPositions() }
        : { error: "no snapshot yet" };
      return Response.json(body, { status: snapshot ? 200 : 503 });
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
    const apiKey = this.env.TRANSLINK_API_KEY;
    if (!apiKey) {
      await this.ctx.storage.put("lastError", {
        at: Date.now(),
        message: "TRANSLINK_API_KEY secret is not set",
      });
      return;
    }

    const tick = ((await this.ctx.storage.get<number>("tick")) ?? 0) + 1;
    await this.ctx.storage.put("tick", tick);

    const vehicles = await this.fetchFeed(FEEDS.positions, apiKey, decodeVehicles);
    if (vehicles) {
      // Kept only so a client connecting before the next tick can seed a
      // glide from a real prior fix — see previousPositions().
      const previousVehicles = (await this.ctx.storage.get<Vehicle[]>("vehicles")) ?? [];
      await this.ctx.storage.put("previousVehicles", previousVehicles);
      await this.ctx.storage.put("vehicles", vehicles);
    }

    if (tick % TRIP_UPDATE_EVERY === 0) {
      const updates = await this.fetchFeed(FEEDS.tripUpdates, apiKey, decodeTripUpdates);
      if (updates) {
        await this.ctx.storage.put("predictions", indexPredictionsByStop(updates));
      }
    }

    if (tick % ALERTS_EVERY === 1) {
      const alerts = await this.fetchFeed(FEEDS.alerts, apiKey, decodeAlerts);
      if (alerts) {
        await this.ctx.storage.put("alerts", alerts);
      }
    }

    await this.ctx.storage.put("requestsToday", await this.bumpRequestCount());

    const snapshot = await this.buildSnapshot();
    this.snapshot = snapshot;

    await this.env.SNAPSHOT.put(SNAPSHOT_KEY, JSON.stringify(snapshot), {
      expirationTtl: 600,
    });

    this.broadcast(snapshot);
  }

  private async fetchFeed<T>(
    url: string,
    apiKey: string,
    decode: (buf: Uint8Array) => T,
  ): Promise<T | null> {
    const response = await fetch(`${url}?apikey=${apiKey}`, {
      cf: { cacheTtl: 0 },
      headers: { "user-agent": "vancouver-bus-map (+https://github.com/ryanzhxu)" },
    });

    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }

    const buf = new Uint8Array(await response.arrayBuffer());
    const header = decodeHeader(buf);
    await this.ctx.storage.put("feedTimestamp", header.timestamp ?? null);
    return decode(buf);
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
      pollSeconds: POLL_SECONDS,
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

  /**
   * Last tick's real fix per vehicle id, for Snapshot.previous. Real data
   * only — never a guess — which is why this stops at whatever the last poll
   * actually saw rather than trying to fill in a vehicle that is new this
   * tick.
   */
  private async previousPositions(): Promise<Record<string, [number, number]>> {
    const previous = (await this.ctx.storage.get<Vehicle[]>("previousVehicles")) ?? [];
    const out: Record<string, [number, number]> = {};
    for (const v of previous) {
      out[v.id] = [round5(v.lat), round5(v.lon)];
    }
    return out;
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

  /** Rough daily counter, reset on Vancouver-local date change. */
  private async bumpRequestCount(): Promise<number> {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Vancouver",
    }).format(new Date());

    const stored = await this.ctx.storage.get<{ date: string; count: number }>("requests");
    const next =
      stored && stored.date === today
        ? { date: today, count: stored.count + 1 }
        : { date: today, count: 1 };

    await this.ctx.storage.put("requests", next);
    return next.count;
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
      ? POLL_SECONDS * 1000
      : msUntilServiceStart(now);
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  private async status() {
    const [tick, requests, lastError, feedTimestamp, vehicles] = await Promise.all([
      this.ctx.storage.get<number>("tick"),
      this.ctx.storage.get<{ date: string; count: number }>("requests"),
      this.ctx.storage.get<{ at: number; message: string }>("lastError"),
      this.ctx.storage.get<number | null>("feedTimestamp"),
      this.ctx.storage.get<Vehicle[]>("vehicles"),
    ]);

    return {
      tick: tick ?? 0,
      requestsToday: requests?.count ?? 0,
      requestDate: requests?.date ?? null,
      vehicles: vehicles?.length ?? 0,
      // Coerce undefined to null so the key survives JSON.stringify.
      feedTimestamp: feedTimestamp ?? null,
      inServiceWindow: inServiceWindow(new Date()),
      vancouverHour: vancouverHour(new Date()),
      openSockets: this.ctx.getWebSockets().length,
      hasApiKey: Boolean(this.env.TRANSLINK_API_KEY),
      lastError: lastError ?? null,
      nextAlarm: await this.ctx.storage.getAlarm(),
    };
  }
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
