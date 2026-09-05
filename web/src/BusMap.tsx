import maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { BusField, type Snapshot } from "./buses.js";
import { GtfsData } from "./gtfs.js";
import "maplibre-gl/dist/maplibre-gl.css";

/** Metro Vancouver, framed to hold Richmond through North Van. */
const INITIAL_VIEW = { center: [-123.1, 49.25] as [number, number], zoom: 11 };
const BOUNDS: [number, number, number, number] = [-123.55, 48.95, -122.4, 49.45];

/** OpenFreeMap serves vector tiles with no key and no quota. */
const BASEMAP = "https://tiles.openfreemap.org/styles/positron";

export type FeedState =
  | { kind: "connecting" }
  | { kind: "live"; buses: number; feedTime: number | null }
  | { kind: "waiting"; reason: string }
  | { kind: "error"; message: string };

export function BusMap({ onState }: { onState: (state: FeedState) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  // Kept in refs because the animation loop must not re-run on every render.
  const mapRef = useRef<maplibregl.Map | null>(null);
  const gtfsRef = useRef<GtfsData | null>(null);
  const fieldRef = useRef<BusField | null>(null);
  const tripShapes = useRef(new Map<string, string>());
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    if (!container.current) return;

    const map = new maplibregl.Map({
      container: container.current,
      style: BASEMAP,
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      maxBounds: [
        [BOUNDS[0] - 0.6, BOUNDS[1] - 0.6],
        [BOUNDS[2] + 0.6, BOUNDS[3] + 0.6],
      ],
      attributionControl: false,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      "top-right",
    );

    // The container is sized by CSS after MapLibre reads it, so the first frame
    // can be painted against a stale size and the map stays blank until the user
    // pans. Watching the element makes it paint on load instead.
    map.on("render", () => {
      diagnostics.mapPainted = true;
    });
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(container.current);

    // Exposed for debugging a live page: `__vbm` in the console tells you
    // whether the render loop is running and what the feed has delivered.
    const diagnostics = { frames: 0, snapshots: 0, buses: 0, mapPainted: false };
    (window as unknown as Record<string, unknown>).__vbm = diagnostics;

    let stopped = false;
    let frame = 0;
    let socket: WebSocket | null = null;
    let pollTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let reconnectDelay = 2000;

    // Not "load". OpenFreeMap's style carries an ne2_shaded raster source that
    // never finishes loading, so isStyleLoaded() stays false forever and "load"
    // never fires. "style.load" only needs the style parsed, which is all that
    // addSource and addLayer require.
    let layersAdded = false;
    map.on("style.load", () => {
      if (stopped || layersAdded) return;
      layersAdded = true;

      map.addSource("buses", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // A triangle reads as "heading somewhere" in a way a dot does not, and
      // TransLink sends no bearing, so this is the only cue of direction.
      map.addLayer({
        id: "bus-dots",
        type: "circle",
        source: "buses",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2.5, 12, 4.5, 15, 8],
          "circle-color": ["get", "color"],
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 0.5, 15, 1.5],
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.92,
        },
      });

      map.addLayer({
        id: "bus-labels",
        type: "symbol",
        source: "buses",
        minzoom: 13,
        layout: {
          "text-field": ["get", "label"],
          "text-size": 10,
          "text-offset": [0, 1.1],
          "text-allow-overlap": false,
          "text-font": ["Noto Sans Regular"],
        },
        paint: {
          "text-color": "#1a2530",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2,
        },
      });

      void start();
    });

    async function start(): Promise<void> {
      const gtfs = new GtfsData();
      gtfsRef.current = gtfs;

      try {
        await gtfs.load();
      } catch (error) {
        onStateRef.current({
          kind: "error",
          message: error instanceof Error ? error.message : "could not load route data",
        });
        return;
      }
      if (stopped) return;

      fieldRef.current = new BusField((tripId) => {
        const shapeId = tripShapes.current.get(tripId);
        return shapeId ? gtfs.trackFor(shapeId) : null;
      });

      setReady(true);
      connect();
      animate();
    }

    function connect(): void {
      if (stopped) return;
      onStateRef.current({ kind: "connecting" });

      const scheme = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${location.host}/ws`);

      socket.addEventListener("message", (event) => {
        reconnectDelay = 2000;
        try {
          apply(JSON.parse(event.data as string) as Snapshot);
        } catch {
          // Ignore a malformed frame rather than tearing down the socket.
        }
      });

      socket.addEventListener("close", () => {
        if (stopped) return;
        // Back off, but keep the last positions on screen while we retry.
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      });

      socket.addEventListener("error", () => socket?.close());

      // The socket only pushes on a poll tick, so pull once immediately to
      // avoid an empty map for up to 90 seconds after load.
      void pollOnce();
      pollTimer = window.setInterval(() => void pollOnce(), 60_000);
    }

    async function pollOnce(): Promise<void> {
      try {
        const response = await fetch("/api/live/snapshot");
        if (response.status === 503) {
          onStateRef.current({ kind: "waiting", reason: "waiting for the first poll" });
          return;
        }
        if (!response.ok) return;
        apply((await response.json()) as Snapshot);
      } catch {
        // Offline or transient; the socket or the next poll will recover.
      }
    }

    function apply(snapshot: Snapshot): void {
      const field = fieldRef.current;
      const gtfs = gtfsRef.current;
      if (!field || !gtfs || snapshot.type !== "snapshot") return;

      // Pull geometry for any route now on screen that we have not loaded.
      const routes = new Set<string>();
      for (const v of snapshot.vehicles) {
        if (v.r) routes.add(v.r);
        if (v.h) tripShapes.current.set(v.t, v.h);
      }
      for (const routeId of routes) void gtfs.ensureRoute(routeId);

      diagnostics.snapshots++;
      diagnostics.buses = snapshot.vehicles.length;
      field.ingest(snapshot);
      onStateRef.current({
        kind: "live",
        buses: snapshot.vehicles.length,
        feedTime: snapshot.feedTimestamp,
      });
    }

    function animate(): void {
      frame = requestAnimationFrame(animate);
      diagnostics.frames++;
      const field = fieldRef.current;
      const gtfs = gtfsRef.current;
      const source = map.getSource("buses") as maplibregl.GeoJSONSource | undefined;
      if (!field || !gtfs || !source) return;

      const features = field.positionsAt().map((bus) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [bus.lon, bus.lat] },
        properties: {
          id: bus.id,
          label: gtfs.routeLabel(bus.routeId),
          color: gtfs.routeColor(bus.routeId),
          bearing: bus.bearing,
        },
      }));

      source.setData({ type: "FeatureCollection", features });
    }

    return () => {
      stopped = true;
      resizeObserver.disconnect();
      cancelAnimationFrame(frame);
      if (pollTimer) clearInterval(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div className="map-shell">
      <div ref={container} className="map" />
      {!ready && <div className="map-loading">Loading route data…</div>}
    </div>
  );
}
