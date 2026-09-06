import { buildTrack, type LatLon, type Track } from "./geo.js";

/**
 * Loads the static GTFS artifacts the map needs.
 *
 * Everything under /gtfs/{version}/ is immutable and cached for a year, so a
 * fetch here happens once per browser per weekly build. Route geometry is
 * loaded lazily — a client showing downtown does not need the geometry for
 * every suburban route.
 */

export interface RouteInfo {
  /** short name, e.g. "099" */
  s: string;
  /** long name, e.g. "Commercial-Broadway/UBC" */
  n: string;
  /** GTFS route_type: 1 SkyTrain, 2 rail, 3 bus, 4 ferry */
  t: number;
  /** hex colour without the hash, when TransLink supplies one */
  c: string | null;
  x: string | null;
}

export interface StopInfo {
  i: string;
  c: string;
  n: string;
  y: number;
  x: number;
  /** 1 accessible, 2 not, 0 unknown */
  w: number;
  /** 0 stop, 1 station, 2 entrance */
  l: number;
}

export interface Manifest {
  version: string;
  builtAt: string;
  counts: Record<string, number>;
}

/**
 * The colour a bus is drawn in when its route carries none of its own.
 *
 * TransLink colours only the rail lines; buses get one consistent colour
 * rather than a random one per route, which would read as meaningful.
 */
export const DEFAULT_ROUTE_COLOR = "#0b6ea8";

export class GtfsData {
  private version: string | null = null;
  routes = new Map<string, RouteInfo>();
  stops: StopInfo[] = [];
  private stopById = new Map<string, StopInfo>();
  private stopLoad: Promise<void> | null = null;

  /** shapeId -> track, filled in as routes are requested. */
  private tracks = new Map<string, Track>();
  /** routeId -> in-flight or completed load, so we fetch each bundle once. */
  private routeLoads = new Map<string, Promise<void>>();

  /**
   * Fetch only what the first paint needs.
   *
   * routes.json is 3.7KB over the wire; stops.json is 202KB and is not needed
   * until the user zooms in far enough to see stops. Blocking the map on it
   * costs a third of the initial download for something most sessions never
   * look at, so it loads in the background instead.
   */
  async load(): Promise<Manifest> {
    const manifest = (await getJson("/api/gtfs/manifest")) as Manifest;
    this.version = manifest.version;

    const routes = (await getJson(this.url("routes.json"))) as Record<string, RouteInfo>;
    this.routes = new Map(Object.entries(routes));
    return manifest;
  }

  /** Load the stop index. Safe to call repeatedly; the first call wins. */
  ensureStops(): Promise<void> {
    if (this.stopLoad) return this.stopLoad;

    this.stopLoad = (async () => {
      const stops = (await getJson(this.url("stops.json"))) as StopInfo[];
      this.stops = stops;
      this.stopById = new Map(stops.map((stop) => [stop.i, stop]));
    })();

    return this.stopLoad;
  }

  /** Geometry for a trip, if its route bundle has been loaded. */
  trackFor(shapeId: string): Track | null {
    return this.tracks.get(shapeId) ?? null;
  }

  /**
   * Fetch the geometry bundle for a route. Safe to call repeatedly — the first
   * call wins and later callers await the same promise.
   */
  ensureRoute(routeId: string): Promise<void> {
    const existing = this.routeLoads.get(routeId);
    if (existing) return existing;

    const load = (async () => {
      try {
        const bundle = (await getJson(this.url(`shapes/${routeId}.json`))) as Record<
          string,
          LatLon[]
        >;
        for (const [shapeId, points] of Object.entries(bundle)) {
          this.tracks.set(shapeId, buildTrack(points));
        }
      } catch {
        // A failed load is not fatal: those buses fall back to straight-line
        // movement rather than disappearing from the map. But it must not be
        // cached as done — a dropped fetch on a flaky phone connection would
        // otherwise strand this route on straight lines for the life of the
        // tab. Forget it so the next snapshot retries once the network recovers.
        this.routeLoads.delete(routeId);
      }
    })();

    this.routeLoads.set(routeId, load);
    return load;
  }

  stop(stopId: string): StopInfo | null {
    return this.stopById.get(stopId) ?? null;
  }

  /** Stop names arrive as "Westbound Davie St @ Bidwell St". */
  stopName(stopId: string): string | null {
    return this.stopById.get(stopId)?.n ?? null;
  }

  routeName(routeId: string): string {
    const route = this.routes.get(routeId);
    return route?.n || "";
  }

  routeLabel(routeId: string): string {
    const route = this.routes.get(routeId);
    if (!route) return routeId;
    if (route.s) return route.s.replace(/^0+(?=\d)/, "");
    return route.n || routeId;
  }

  routeColor(routeId: string): string {
    const route = this.routes.get(routeId);
    if (route?.c) return `#${route.c}`;
    return DEFAULT_ROUTE_COLOR;
  }

  private url(path: string): string {
    if (!this.version) throw new Error("GtfsData.load() must run before fetching artifacts");
    return `/gtfs/${this.version}/${path}`;
  }
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}
