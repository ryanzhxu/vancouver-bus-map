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
import type { Env, Snapshot, StopPrediction, WireVehicle } from "./types.js";

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

    return {
      type: "snapshot",
      generatedAt: Date.now(),
      feedTimestamp,
      pollSeconds: POLL_SECONDS,
      vehicles: vehicles.map(toWire),
    };
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
      feedTimestamp,
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

/** Trim a decoded vehicle to what the map needs, keeping the payload small. */
function toWire(v: Vehicle): WireVehicle {
  return {
    i: v.id,
    r: v.routeId ?? "",
    t: v.tripId ?? "",
    y: round5(v.lat),
    x: round5(v.lon),
    s: v.stopSequence ?? 0,
    p: v.stopId ?? "",
  };
}

/** Five decimals is about a metre — more precision than a bus position has. */
function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

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
