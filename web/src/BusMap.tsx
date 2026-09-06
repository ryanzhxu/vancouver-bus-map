import maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_BASEMAP,
  basemapStyle,
  nextBasemap,
  type BasemapProvider,
} from "./basemap.js";
import { BusField, isLate, markerShapeFor, type Snapshot } from "./buses.js";
import { DEFAULT_ROUTE_COLOR, GtfsData } from "./gtfs.js";
import { distinctRouteColors, drawMarker, iconName } from "./icons.js";
import "maplibre-gl/dist/maplibre-gl.css";

/** Metro Vancouver, framed to hold Richmond through North Van. */
const INITIAL_VIEW = { center: [-123.1, 49.25] as [number, number], zoom: 11 };
const BOUNDS: [number, number, number, number] = [-123.55, 48.95, -122.4, 49.45];

/**
 * The halo drawn around a bus running behind schedule. One warm orange reads on
 * both the light and the dark basemap, and it is distinct from the blue halo of
 * a selected bus. Kept in step with the --late token the legend swatch uses.
 */
const LATE_COLOR = "#e8590c";

const darkQuery =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

// A rider who asks the OS for reduced motion should not see buses sliding
// across the map every frame. The glide is a requestAnimationFrame loop, not a
// CSS transition, so app.css's prefers-reduced-motion rule cannot stop it; the
// animate loop reads this and snaps to the latest sample instead.
const reduceMotionQuery =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

export type FeedState =
  | { kind: "connecting" }
  | { kind: "live"; buses: number; late: number; feedTime: number | null }
  /** Static timetables work; the realtime feed does not. */
  | { kind: "schedules-only" }
  | { kind: "error"; message: string };

export interface SelectedStop {
  id: string;
  name: string;
  code: string;
  accessible: number;
}

export interface SelectedBus {
  id: string;
  routeLabel: string;
  routeName: string;
  headsign: string;
  nextStopName: string | null;
  nextStopAccessible: number;
  stopSequence: number;
  color: string;
  /** Predicted arrival at the next stop, epoch seconds, or null when unknown. */
  arrivalTime: number | null;
  /** Delay against schedule in seconds; negative is early, null is unknown. */
  delay: number | null;
}

export function BusMap({
  onState,
  onSelect,
  onSelectStop,
  onReady,
  onZoom,
}: {
  onState: (state: FeedState) => void;
  onSelect: (bus: SelectedBus | null) => void;
  onSelectStop: (stop: SelectedStop | null) => void;
  onReady: (gtfs: GtfsData) => void;
  onZoom: (zoom: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  // Kept in refs because the animation loop must not re-run on every render.
  const mapRef = useRef<maplibregl.Map | null>(null);
  const gtfsRef = useRef<GtfsData | null>(null);
  const fieldRef = useRef<BusField | null>(null);
  const tripShapes = useRef(new Map<string, string>());
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onSelectStopRef = useRef(onSelectStop);
  onSelectStopRef.current = onSelectStop;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;
  /** Latest wire record per bus, for the detail sheet. */
  const wireById = useRef(
    new Map<string, { r: string; d?: string; p: string; s: number; a?: number; l?: number }>(),
  );
  const selectedId = useRef<string | null>(null);

  useEffect(() => {
    if (!container.current) return;

    // The provider currently drawing the basemap. It moves down BASEMAP_CHAIN
    // when a style fails to load, so a rider keeps a map even if the default
    // provider is down.
    let provider: BasemapProvider = DEFAULT_BASEMAP;
    const styleFor = (dark: boolean) => basemapStyle(provider, dark);

    const map = new maplibregl.Map({
      container: container.current,
      style: styleFor(darkQuery?.matches ?? false),
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
    map.on("zoomend", () => onZoomRef.current(map.getZoom()));

    // A style that will not load (the provider is down, and OpenFreeMap has no
    // SLA) leaves the map blank. Fall through to the next keyless provider, but
    // only before style.load has fired: once layers are added the style loaded,
    // so any later error is a single tile or source, not a dead basemap. A spent
    // chain returns null, so a total outage cannot loop.
    map.on("error", () => {
      if (stopped || layersAdded) return;
      const fallback = nextBasemap(provider);
      if (!fallback) return;
      provider = fallback;
      map.setStyle(styleFor(darkQuery?.matches ?? false));
    });

    // setStyle discards every layer we added, so the style.load handler has to
    // run again. Bus positions live in BusField, not the source, so they
    // reappear on the next animation frame.
    const onThemeChange = (event: MediaQueryListEvent): void => {
      layersAdded = false;
      map.setStyle(styleFor(event.matches));
    };
    darkQuery?.addEventListener("change", onThemeChange);
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(container.current);

    // Exposed for debugging a live page: `__vbm` in the console tells you
    // whether the render loop is running and what the feed has delivered.
    const diagnostics: {
      frames: number;
      snapshots: number;
      buses: number;
      mapPainted: boolean;
      map: maplibregl.Map;
    } = { frames: 0, snapshots: 0, buses: 0, mapPainted: false, map };
    (window as unknown as Record<string, unknown>).__vbm = diagnostics;

    let stopped = false;
    let layersAdded = false;
    // Interaction handlers live on the map, not the style, so they survive a
    // setStyle and must only ever be bound once.
    let handlersBound = false;
    let frame = 0;
    let socket: WebSocket | null = null;
    let pollTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let reconnectDelay = 2000;

    // Not "load". OpenFreeMap's style carries an ne2_shaded raster source that
    // never finishes loading, so isStyleLoaded() stays false forever and "load"
    // never fires. "style.load" only needs the style parsed, which is all that
    // addSource and addLayer require.
    map.on("style.load", () => {
      if (stopped || layersAdded) return;
      layersAdded = true;

      map.addSource("buses", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "bus-icons",
        type: "symbol",
        source: "buses",
        layout: {
          "icon-image": ["get", "icon"],
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.45, 12, 0.7, 15, 1],
          // ~1,500 symbols cannot afford collision detection, and a bus hidden
          // because a neighbour got there first would be a lie about the fleet.
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });

      // A warm ring around any bus more than five minutes behind schedule, so a
      // rider sees which buses are late without tapping. Drawn beneath the dots
      // so it reads as a halo; the status bar names the five-minute threshold.
      map.addLayer({
        id: "bus-late",
        type: "circle",
        source: "buses",
        filter: ["==", ["get", "late"], true],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 5, 12, 7.5, 15, 12],
          "circle-color": LATE_COLOR,
          "circle-opacity": 0.28,
          "circle-stroke-width": 2,
          "circle-stroke-color": LATE_COLOR,
        },
      }, "bus-icons");

      // Drawn beneath the dots so the ring reads as a halo, not a badge.
      map.addLayer({
        id: "bus-selected",
        type: "circle",
        source: "buses",
        filter: ["==", ["get", "id"], "__none__"],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 8, 15, 18],
          "circle-color": "#0b6ea8",
          "circle-opacity": 0.25,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#0b6ea8",
        },
      }, "bus-icons");

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
          // Read against whichever basemap is showing, not just the light one.
          "text-color": darkQuery?.matches ? "#e7ebef" : "#1a2530",
          "text-halo-color": darkQuery?.matches ? "#10151b" : "#ffffff",
          "text-halo-width": 1.2,
        },
      });

      bindInteractions();

      // After a theme swap the map is already running; re-add stops and
      // bus icons directly, since setStyle discarded both along with the
      // layers.
      const existing = gtfsRef.current;
      if (existing) registerBusIcons(existing);
      if (existing && existing.stops.length > 0) addStopsLayer(existing);

      if (!fieldRef.current) void start();
    });

    function bindInteractions(): void {
      if (handlersBound) return;
      handlersBound = true;

      // A 4px dot is a hard target on a phone, so query a box around the tap
      // rather than the exact pixel.
      map.on("click", (event) => {
        const box: [maplibregl.PointLike, maplibregl.PointLike] = [
          [event.point.x - 12, event.point.y - 12],
          [event.point.x + 12, event.point.y + 12],
        ];
        // Buses win ties: they are smaller targets and the more likely intent.
        const busHits = map.queryRenderedFeatures(box, { layers: ["bus-icons"] });
        if (busHits.length > 0) {
          selectStop(undefined);
          select(busHits[0]?.properties?.["id"] as string | undefined);
          return;
        }

        const stopLayer = map.getLayer("stop-dots") ? ["stop-dots"] : [];
        const stopHits =
          stopLayer.length > 0 ? map.queryRenderedFeatures(box, { layers: stopLayer }) : [];
        select(undefined);
        selectStop(stopHits[0]?.properties?.["id"] as string | undefined);
      });

      map.getCanvas().style.cursor = "";
      map.on("mouseenter", "bus-icons", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "bus-icons", () => {
        map.getCanvas().style.cursor = "";
      });
    }

    /**
     * Register one bus-icon image per shape per colour, so animate() can name
     * an icon per bus with no per-frame work. The set is small — TransLink
     * colours only 12 routes.
     *
     * Called from both start() and style.load. setStyle() throws away every
     * image added with addImage, exactly as it throws away every layer, so a
     * theme swap needs this re-run just as the style.load handler re-adds
     * stops — do not collapse this back down to a single call from start().
     */
    function registerBusIcons(gtfs: GtfsData): void {
      const ratio = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
      for (const color of distinctRouteColors(gtfs.routes, DEFAULT_ROUTE_COLOR)) {
        for (const shape of ["chevron", "bus"] as const) {
          const name = iconName(shape, color);
          if (!map.hasImage(name)) {
            map.addImage(name, drawMarker(shape, color, ratio), { pixelRatio: ratio });
          }
        }
      }
    }

    /**
     * Stops only appear from zoom 14. There are 8,945 of them and at city zoom
     * they would bury the buses, which are the point of the map.
     */
    function addStopsLayer(gtfs: GtfsData): void {
      if (map.getSource("stops")) return;

      map.addSource("stops", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: gtfs.stops
            // location_type 2 is a station entrance, not somewhere a bus calls.
            .filter((stop) => stop.l !== 2)
            .map((stop) => ({
              type: "Feature" as const,
              geometry: { type: "Point" as const, coordinates: [stop.x, stop.y] },
              properties: { id: stop.i, name: stop.n, code: stop.c, w: stop.w },
            })),
        },
      });

      map.addLayer(
        {
          id: "stop-dots",
          type: "circle",
          source: "stops",
          minzoom: 14,
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 2.5, 17, 5],
            "circle-color": darkQuery?.matches ? "#10151b" : "#ffffff",
            "circle-stroke-width": 1.5,
            "circle-stroke-color": "#8a97a3",
          },
        },
        "bus-selected",
      );
    }

    function selectStop(id: string | undefined): void {
      const gtfs = gtfsRef.current;
      if (!id || !gtfs) {
        onSelectStopRef.current(null);
        return;
      }
      const stop = gtfs.stop(id);
      if (!stop) {
        onSelectStopRef.current(null);
        return;
      }
      onSelectStopRef.current({ id: stop.i, name: stop.n, code: stop.c, accessible: stop.w });
    }

    function select(id: string | undefined): void {
      const gtfs = gtfsRef.current;
      selectedId.current = id ?? null;
      if (map.getLayer("bus-selected")) {
        map.setFilter("bus-selected", ["==", ["get", "id"], id ?? "__none__"]);
      }

      if (!id || !gtfs) {
        onSelectRef.current(null);
        return;
      }

      const wire = wireById.current.get(id);
      if (!wire) {
        onSelectRef.current(null);
        return;
      }

      const stop = wire.p ? gtfs.stop(wire.p) : null;
      onSelectRef.current({
        id,
        routeLabel: gtfs.routeLabel(wire.r),
        routeName: gtfs.routeName(wire.r),
        headsign: wire.d ?? "",
        nextStopName: stop?.n ?? null,
        nextStopAccessible: stop?.w ?? 0,
        stopSequence: wire.s,
        color: gtfs.routeColor(wire.r),
        arrivalTime: wire.a ?? null,
        delay: wire.l ?? null,
      });
    }

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

      registerBusIcons(gtfs);

      fieldRef.current = new BusField((tripId) => {
        const shapeId = tripShapes.current.get(tripId);
        return shapeId ? gtfs.trackFor(shapeId) : null;
      });

      onReadyRef.current(gtfs);
      setReady(true);
      connect();
      animate();

      // 202KB that only matters from zoom 14. Fetch it once the map is up so
      // it never delays the first paint.
      void gtfs.ensureStops().then(() => {
        if (!stopped) addStopsLayer(gtfs);
      });
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
      // A dropped socket runs connect() again to reconnect. Clear the previous
      // interval first, or every reconnect would leave another 60s poll running
      // for the life of the tab.
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = window.setInterval(() => void pollOnce(), 60_000);
    }

    async function pollOnce(): Promise<void> {
      try {
        const response = await fetch("/api/live/snapshot");
        if (response.status === 503) {
          // No snapshot yet. Stops and timetables still work, so say that
          // rather than implying the whole map is broken.
          onStateRef.current({ kind: "schedules-only" });
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
        wireById.current.set(v.i, { r: v.r, d: v.d, p: v.p, s: v.s, a: v.a, l: v.l });
      }
      for (const routeId of routes) void gtfs.ensureRoute(routeId);

      diagnostics.snapshots++;
      diagnostics.buses = snapshot.vehicles.length;
      field.ingest(snapshot);
      onStateRef.current({
        kind: "live",
        buses: snapshot.vehicles.length,
        late: snapshot.vehicles.filter((v) => isLate(v.l)).length,
        feedTime: snapshot.feedTimestamp,
      });

      // Forget the wire record of any bus BusField has given up on. A bus that
      // ends its trip leaves the feed, and after STALE_MS its dot leaves the
      // map — but this map kept its last record for the life of the tab, so it
      // also grew without bound.
      for (const id of wireById.current.keys()) {
        if (!field.has(id)) wireById.current.delete(id);
      }

      // Refresh the open bus card from the new wire data. Without this the card
      // freezes at the values it held when tapped: the countdown keeps ticking
      // down toward a stale prediction, and the next stop, delay, and sequence
      // never update as the bus advances through later polls.
      //
      // If the bus is gone from the map entirely, close the card instead of
      // re-showing a record nothing will ever update again: its countdown would
      // run down on the client clock and sit at "arriving now" for good, beside
      // a dot the rider can no longer see.
      if (selectedId.current) {
        select(field.has(selectedId.current) ? selectedId.current : undefined);
      }
    }

    function animate(): void {
      frame = requestAnimationFrame(animate);
      diagnostics.frames++;
      const field = fieldRef.current;
      const gtfs = gtfsRef.current;
      const source = map.getSource("buses") as maplibregl.GeoJSONSource | undefined;
      if (!field || !gtfs || !source) return;

      // Read the preference live each frame so toggling it in the OS takes
      // effect without a reload; the check is a cheap boolean.
      const glide = !(reduceMotionQuery?.matches ?? false);
      const features = field.positionsAt(Date.now(), glide).map((bus) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [bus.lon, bus.lat] },
        properties: {
          id: bus.id,
          label: gtfs.routeLabel(bus.routeId),
          color: gtfs.routeColor(bus.routeId),
          bearing: bus.bearing,
          late: isLate(bus.delay),
          icon: iconName(markerShapeFor(map.getZoom()), gtfs.routeColor(bus.routeId)),
        },
      }));

      source.setData({ type: "FeatureCollection", features });
    }

    return () => {
      stopped = true;
      darkQuery?.removeEventListener("change", onThemeChange);
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
