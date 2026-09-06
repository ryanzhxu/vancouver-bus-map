# Map Exploration Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Vancouver bus map explorable — buses that show their heading, a route you can search for and highlight, express services that stand out, a camera that follows one bus, a bunching detector, and a live system pulse panel.

**Architecture:** Every feature is derived from the snapshot already on the wire and the static GTFS artifacts already in R2. No new TransLink requests, no new server endpoints, no new storage. All decision logic lives in pure functions in `.ts` modules and is unit tested; the `.tsx` components and MapLibre layer definitions stay thin, because the repo has no DOM test harness.

**Tech Stack:** TypeScript (strict, ESM with `.js` import suffixes), React 19, MapLibre GL 5, Vitest 5, Cloudflare Workers.

**Spec:** `docs/superpowers/specs/2026-09-06-map-exploration-features-design.md`

## Global Constraints

- **Do not change the poll budget.** `POLL_SECONDS`, `TRIP_UPDATE_EVERY`, `ALERTS_EVERY`, `SERVICE_START_HOUR`, `SERVICE_END_HOUR` in `src/config.ts` stay exactly as they are. `src/config.test.ts` fails the build if the daily total exceeds 1,000 or leaves under 20 requests of headroom.
- **No new network calls of any kind.** Not to TransLink, not to a new endpoint, not to a third party.
- **Never call TransLink from a test.**
- **Relative TypeScript imports carry a `.js` suffix**, including imports of `.tsx` files (`./App.js`).
- **Tests live beside their source** as `*.test.ts`, run under Node with no DOM.
- **Constants that encode a judgement carry a block comment saying why they hold that value**, matching `LATE_THRESHOLD_SECONDS` and `STALE_FEED_SECONDS` in `web/src/buses.ts`.
- **Express and late must never be distinguished by hue alone.** Route 099's colour is `#d04110`; `LATE_COLOR` is `#e8590c`.
- **Verify with:** `npm run check` (runs `npm run typecheck` then `npm test`) from the repo root.

## Deviation from the spec

The spec specifies SDF icons so `icon-color` can apply the per-route colour. This plan **pre-renders one icon per distinct colour instead**, and does not use SDF. Reason: `addImage(..., {sdf: true})` expects an alpha channel that already encodes a signed distance field, and a plain rasterised shape passed as SDF renders with blocky edges; producing a real SDF needs a distance transform. Only 12 of 245 routes carry a `route_color` and the rest share one default, so the whole system needs about 13 colours. Pre-rendering removes the need for `icon-color`, and therefore for SDF, at the cost of ~26 small canvas draws once at load. The spec's intent — per-route colour preserved, heading shown — is fully met.

## File Structure

| file | responsibility |
| ---- | -------------- |
| `vitest.config.ts` | modify — also collect `web/src/**/*.test.tsx` |
| `web/src/buses.ts` | modify — add marker shape/name helpers and `findBunches` |
| `web/src/buses.test.ts` | modify — cover the above |
| `web/src/icons.ts` | create — build the chevron and bus canvases, and name them |
| `web/src/icons.test.ts` | create |
| `web/src/routes.ts` | create — route search, express test, dimming rule, pulse tallies |
| `web/src/routes.test.ts` | create |
| `web/src/RouteSearch.tsx` | create — the search box |
| `web/src/SystemPulse.tsx` | create — the pulse panel |
| `web/src/BusMap.tsx` | modify — symbol layer, route line, bunch line, follow camera |
| `web/src/App.tsx` | modify — hold highlight/follow state, mount the new panels |
| `web/src/app.css` | modify — styles for search, pulse, legend |

---

### Task 1: Zoom-aware bus markers with heading

**Files:**
- Modify: `vitest.config.ts`
- Create: `web/src/icons.ts`
- Create: `web/src/icons.test.ts`
- Modify: `web/src/buses.ts` (append near the other exported helpers)
- Modify: `web/src/buses.test.ts`
- Modify: `web/src/BusMap.tsx:198-277` (layer setup), `web/src/BusMap.tsx:285-303` (click handler), `web/src/BusMap.tsx:529-553` (`animate`)

**Interfaces:**
- Consumes: `RenderedBus` and `BusField.positionsAt` from `web/src/buses.ts`; `GtfsData.routeColor`, `GtfsData.routeLabel` from `web/src/gtfs.ts`.
- Produces:
  - `markerShapeFor(zoom: number): MarkerShape` where `type MarkerShape = "chevron" | "bus"`
  - `BUS_ICON_MIN_ZOOM: number`
  - `iconName(shape: MarkerShape, color: string): string`
  - `distinctRouteColors(routes: Map<string, RouteInfo>, fallback: string): string[]`
  - `drawMarker(shape: MarkerShape, color: string, pixelRatio: number): ImageData`
  - a map layer named `bus-icons` replacing `bus-dots`

- [ ] **Step 1: Let Vitest see `.test.tsx` files**

This task adds no `.tsx` test, but later tasks add `.tsx` components, and a `.test.tsx` file under the current config is silently never collected — it would look like a passing suite that never ran. Fix it before anything can rely on it.

In `vitest.config.ts`, change the `include` array to:

```ts
    include: [
      "src/**/*.test.ts",
      "scripts/**/*.test.ts",
      "web/src/**/*.test.ts",
      // Without this a component test would be silently skipped, and a skipped
      // suite reads as a passing one.
      "web/src/**/*.test.tsx",
    ],
```

- [ ] **Step 2: Write the failing tests for the marker helpers**

Create `web/src/icons.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { distinctRouteColors, iconName } from "./icons.js";
import type { RouteInfo } from "./gtfs.js";

const route = (over: Partial<RouteInfo> = {}): RouteInfo => ({
  s: "010",
  n: "Granville",
  t: 3,
  c: null,
  x: null,
  ...over,
});

describe("iconName", () => {
  it("names an icon by shape and colour", () => {
    expect(iconName("bus", "#008522")).toBe("bus-008522");
  });

  it("is case insensitive, so one colour never registers twice", () => {
    expect(iconName("chevron", "#D04110")).toBe(iconName("chevron", "#d04110"));
  });
});

describe("distinctRouteColors", () => {
  it("returns the fallback when no route carries a colour", () => {
    const routes = new Map([["1", route()]]);
    expect(distinctRouteColors(routes, "#0b6ea8")).toEqual(["#0b6ea8"]);
  });

  it("collects each route colour once, including the fallback", () => {
    const routes = new Map([
      ["1", route({ c: "008522" })],
      ["2", route({ c: "008522" })],
      ["3", route({ c: "d04110" })],
      ["4", route({ c: null })],
    ]);
    const colors = distinctRouteColors(routes, "#0b6ea8");
    // Sorted on a copy: both tsconfigs set lib to ES2022, and toSorted is ES2023.
    expect([...colors].sort()).toEqual(["#008522", "#0b6ea8", "#d04110"]);
  });
});
```

Append to `web/src/buses.test.ts`, and add `BUS_ICON_MIN_ZOOM` and `markerShapeFor` to the existing import block from `./buses.js`:

```ts
describe("markerShapeFor", () => {
  it("draws a chevron below the bus-icon zoom, where the whole region is on screen", () => {
    expect(markerShapeFor(BUS_ICON_MIN_ZOOM - 0.01)).toBe("chevron");
    expect(markerShapeFor(11)).toBe("chevron");
  });

  it("draws a bus at the threshold and above", () => {
    expect(markerShapeFor(BUS_ICON_MIN_ZOOM)).toBe("bus");
    expect(markerShapeFor(16)).toBe("bus");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `web/src/icons.test.ts` cannot resolve `./icons.js`, and `buses.test.ts` fails on `markerShapeFor` not being exported.

- [ ] **Step 4: Implement the icon module**

Create `web/src/icons.ts`:

```ts
import type { MarkerShape } from "./buses.js";
import type { RouteInfo } from "./gtfs.js";

/**
 * Bus markers, pre-rendered once per colour.
 *
 * MapLibre can recolour an icon at draw time only if the image is a signed
 * distance field, and a real SDF needs a distance transform we would have to
 * write. We do not need one: TransLink colours just 12 of 245 routes and every
 * other route shares one fallback, so the entire system needs about a dozen
 * images per shape. Drawing them up front is far less machinery than an SDF for
 * the same result.
 */

/** Icon canvases are square, in CSS pixels before the display scale. */
const SIZE = 18;

export function iconName(shape: MarkerShape, color: string): string {
  return `${shape}-${color.replace("#", "").toLowerCase()}`;
}

/** Every colour the map can draw a bus in, each appearing once. */
export function distinctRouteColors(
  routes: Map<string, RouteInfo>,
  fallback: string,
): string[] {
  const colors = new Set<string>([fallback.toLowerCase()]);
  for (const route of routes.values()) {
    if (route.c) colors.add(`#${route.c}`.toLowerCase());
  }
  return [...colors];
}

/**
 * One marker, drawn into an ImageData ready for map.addImage.
 *
 * Both shapes point north, because MapLibre's icon-rotate turns them clockwise
 * from north and the bearing we store is a compass bearing.
 */
export function drawMarker(
  shape: MarkerShape,
  color: string,
  pixelRatio: number,
): ImageData {
  const size = SIZE * pixelRatio;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");

  ctx.scale(pixelRatio, pixelRatio);
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";

  if (shape === "chevron") {
    // A tapered arrowhead: unmistakably directional at 3-4 px on screen.
    ctx.beginPath();
    ctx.moveTo(9, 2.5);
    ctx.lineTo(14.5, 15);
    ctx.lineTo(9, 11.5);
    ctx.lineTo(3.5, 15);
    ctx.closePath();
  } else {
    // A bus seen from above: a rounded body with a lighter windscreen band at
    // the front, so the heading still reads once the shape is no longer an arrow.
    ctx.beginPath();
    ctx.roundRect(5, 2, 8, 14, 2.5);
  }

  ctx.fill();
  ctx.stroke();

  if (shape === "bus") {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.beginPath();
    ctx.roundRect(6.2, 3.2, 5.6, 3, 1);
    ctx.fill();
  }

  return ctx.getImageData(0, 0, size, size);
}
```

- [ ] **Step 5: Implement the marker shape helper**

Append to `web/src/buses.ts`:

```ts
/** Which silhouette a bus is drawn with at a given zoom. */
export type MarkerShape = "chevron" | "bus";

/**
 * The zoom at which bus markers become bus-shaped.
 *
 * Below this the whole region is on screen and every bus in Metro Vancouver is
 * drawn at once — several hundred on a quiet Saturday, far more at weekday
 * peak. A bus silhouette at that density is a smear, so the marker stays a
 * chevron, which still carries the one thing a smear cannot: which way the bus
 * is going. Matches the zoom at which route labels already appear, so the two
 * changes land together rather than one surprising the reader before the other.
 */
export const BUS_ICON_MIN_ZOOM = 13;

export function markerShapeFor(zoom: number): MarkerShape {
  return zoom >= BUS_ICON_MIN_ZOOM ? "bus" : "chevron";
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, including the new `icons.test.ts` and the two new `markerShapeFor` cases.

Note: `drawMarker` is not unit tested. It needs a real 2D canvas, which the Node test environment does not provide, and the repo deliberately runs one Node environment for every suite. Its correctness is verified visually in Step 9.

- [ ] **Step 7: Replace the circle layer with a symbol layer**

In `web/src/BusMap.tsx`, add to the imports:

```ts
import { BusField, isLate, markerShapeFor, BUS_ICON_MIN_ZOOM, type Snapshot } from "./buses.js";
import { distinctRouteColors, drawMarker, iconName } from "./icons.js";
```

Inside the `map.on("style.load", ...)` handler, replace the whole `map.addLayer({ id: "bus-dots", ... })` block (currently `web/src/BusMap.tsx:205-216`) with:

```ts
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
```

Leave the `bus-late`, `bus-selected` and `bus-labels` layers exactly as they are, but change the two `map.addLayer(..., "bus-dots")` insertion anchors (`web/src/BusMap.tsx:233` and `web/src/BusMap.tsx:248`) to `"bus-icons"`, so the halos still draw beneath the markers.

- [ ] **Step 8: Register the images and feed the icon name per bus**

Still in `web/src/BusMap.tsx`, inside `start()`, immediately after `await gtfs.load()` succeeds and before `connect()`:

```ts
      // Register one image per shape per colour. The set is small — TransLink
      // colours only 12 routes — and doing it once here means animate() can
      // name an icon per bus with no per-frame work.
      const ratio = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
      for (const color of distinctRouteColors(gtfs.routes, gtfs.routeColor("__default__"))) {
        for (const shape of ["chevron", "bus"] as const) {
          const name = iconName(shape, color);
          if (!map.hasImage(name)) {
            map.addImage(name, drawMarker(shape, color, ratio), { pixelRatio: ratio });
          }
        }
      }
```

In `animate()`, replace the `properties` object (`web/src/BusMap.tsx:543-549`) with:

```ts
        properties: {
          id: bus.id,
          label: gtfs.routeLabel(bus.routeId),
          color: gtfs.routeColor(bus.routeId),
          bearing: bus.bearing,
          late: isLate(bus.delay),
          icon: iconName(markerShapeFor(map.getZoom()), gtfs.routeColor(bus.routeId)),
        },
```

- [ ] **Step 9: Point the click handler at the renamed layer**

In `bindInteractions`, `web/src/BusMap.tsx:291` queries `layers: ["bus-dots"]` and `web/src/BusMap.tsx:306-311` binds `mouseenter`/`mouseleave` to `"bus-dots"`. A layer that no longer exists makes every bus untappable, with no error. Change all three occurrences of `"bus-dots"` to `"bus-icons"`.

- [ ] **Step 10: Verify by eye, and measure the frame cost**

Run in two terminals:

```bash
npm run dev
npm --prefix web run dev
```

Open `http://localhost:5173`. Confirm:
- buses appear as chevrons at the opening zoom, each pointing along its route
- zooming past 13 turns them into bus shapes
- the route colours still differ: the 99 and the R-lines are not the default blue
- tapping a bus still opens the bus card

Then measure, because a symbol layer costs far more per frame than the circle layer it replaced. In the browser console:

```js
__vbm.frames = 0; setTimeout(() => console.log("fps", __vbm.frames / 5), 5000);
```

Expected: 50 or better at the opening zoom. **If it comes in under 30**, apply the documented fallback rather than shipping a janky map: give `bus-icons` a `minzoom` of `BUS_ICON_MIN_ZOOM`, and re-add the original `bus-dots` circle layer with a `maxzoom` of `BUS_ICON_MIN_ZOOM`, so the cheap circles cover the zooms where every bus is on screen and symbols only draw when few are. Record which path you took in the commit message.

- [ ] **Step 11: Commit**

```bash
git add vitest.config.ts web/src/icons.ts web/src/icons.test.ts web/src/buses.ts web/src/buses.test.ts web/src/BusMap.tsx
git commit -m "Draw buses as directional markers instead of dots

The bearing was already computed every frame by BusField and written
into the feature properties, and no layer read it. A symbol layer with
icon-rotate uses it: a chevron at region zoom, a bus silhouette from
zoom 13 where the labels already appear.

Icons are pre-rendered once per colour rather than recoloured at draw
time, because per-feature colour needs an SDF image and a real SDF
needs a distance transform. TransLink colours only 12 of 245 routes, so
the whole system needs about a dozen images per shape.

Also lets Vitest collect web/src/**/*.test.tsx, which it did not, so a
component test would have been silently skipped."
```

---

### Task 2: Express prominence for R1-R6 and the 99

**Files:**
- Create: `web/src/routes.ts`
- Create: `web/src/routes.test.ts`
- Modify: `web/src/BusMap.tsx` (`animate`, layer setup)
- Modify: `web/src/app.css`

**Interfaces:**
- Consumes: `iconName`, `markerShapeFor` from Task 1.
- Produces:
  - `isExpress(shortName: string): boolean`
  - a `bus-express` circle layer, and an `express` boolean on every bus feature

- [ ] **Step 1: Write the failing test**

Create `web/src/routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isExpress } from "./routes.js";

describe("isExpress", () => {
  it("counts every RapidBus line", () => {
    for (const name of ["R1", "R2", "R3", "R4", "R5", "R6"]) {
      expect(isExpress(name)).toBe(true);
    }
  });

  it("counts the 99 B-Line in both the raw and the displayed form", () => {
    // routes.json carries "099"; routeLabel strips the leading zero for display.
    expect(isExpress("099")).toBe(true);
    expect(isExpress("99")).toBe(true);
  });

  it("does not count a local that merely starts with the same digits", () => {
    expect(isExpress("991")).toBe(false);
    expect(isExpress("9")).toBe(false);
    expect(isExpress("199")).toBe(false);
  });

  it("does not count an R-line that does not exist, or a NightBus", () => {
    expect(isExpress("R7")).toBe(false);
    expect(isExpress("R")).toBe(false);
    expect(isExpress("N9")).toBe(false);
  });

  it("ignores case and surrounding space", () => {
    expect(isExpress(" r4 ")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test web/src/routes.test.ts`
Expected: FAIL — cannot resolve `./routes.js`.

- [ ] **Step 3: Implement `isExpress`**

Create `web/src/routes.ts`:

```ts
/**
 * Route-level questions the map asks: which routes are express, which match a
 * search, and how the fleet is distributed across them right now.
 *
 * Kept apart from buses.ts, which is about where an individual vehicle is.
 */

/**
 * True for TransLink's frequent express services: RapidBus R1-R6 and the 99
 * B-Line.
 *
 * These are the routes a rider treats differently — they run every few minutes,
 * skip stops, and are how most people cross the region. TransLink already marks
 * them in the static feed, giving R1-R6 the RapidBus green (008522) and the 99
 * the B-Line orange (d04110); they are 7 of only 12 routes with any colour at
 * all. The map just never made them prominent enough for that to be visible.
 *
 * Accepts both "099" as it appears in routes.json and "99" as routeLabel
 * displays it, because callers have one or the other depending on where they sit.
 */
export function isExpress(shortName: string): boolean {
  const name = shortName.trim().toUpperCase();
  return /^R[1-6]$/.test(name) || /^0*99$/.test(name);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test web/src/routes.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mark express buses on the map**

In `web/src/BusMap.tsx`, add the import:

```ts
import { isExpress } from "./routes.js";
```

In `animate()`, add to the `properties` object built in Task 1:

```ts
          express: isExpress(gtfs.routeLabel(bus.routeId)),
```

Also add a sort key to the `bus-icons` layout so express markers draw above locals:

```ts
          "symbol-sort-key": ["case", ["get", "express"], 0, 1],
```

- [ ] **Step 6: Add the express ring**

In the `style.load` handler, after the `bus-late` layer and before `bus-selected`, add:

```ts
      // Express services get a ring, not a colour. Route 099's own colour
      // (#d04110) sits close to LATE_COLOR (#e8590c), so distinguishing express
      // from late by hue would collide exactly on the busiest express route in
      // the system. A ring is a different shape, readable against either.
      map.addLayer({
        id: "bus-express",
        type: "circle",
        source: "buses",
        filter: ["==", ["get", "express"], true],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 6, 12, 9, 15, 14],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-opacity": 0.75,
        },
      }, "bus-icons");
```

- [ ] **Step 7: Explain the ring in the About sheet**

There is no separate legend component. What `web/src/app.css:163` calls "the map legend" is the `.late-note` phrase inside `StatusPill` — the dot plus "N buses 5+ min late" at `web/src/App.tsx:319-324`. That line is already the whole of it, and the status bar gains a bunching count in Task 5, so the express explanation goes in the About sheet rather than crowding it further.

In `web/src/App.tsx`, in `AboutSheet`, add a paragraph after the existing "Buses only" note:

```tsx
        <p className="note">
          RapidBus (R1&ndash;R6) and the 99 B-Line are ringed in their own colour.
          They are TransLink's frequent express services, and the only bus routes
          the agency gives a colour of its own.
        </p>
```

No new CSS: `.note` already exists and is the class the neighbouring paragraph uses.

- [ ] **Step 8: Verify by eye**

Run the two dev servers. Confirm an R-line or the 99 shows a coloured ring, that the ring is visibly a different *shape* from the orange late halo rather than just a different colour, and that an express bus draws above a local it overlaps.

- [ ] **Step 9: Run the whole suite and commit**

Run: `npm run check`
Expected: typecheck clean, all tests pass.

```bash
git add web/src/routes.ts web/src/routes.test.ts web/src/BusMap.tsx web/src/app.css
git commit -m "Make the express services visible

R1-R6 and the 99 already carried their official colours: TransLink
gives them route_color in the static feed, and they are 7 of only 12
routes with any colour at all. At 4px nobody could see it. They now
take a ring and draw above the locals they overlap.

The ring is a shape difference, not a colour one. Route 099's #d04110
sits close to LATE_COLOR #e8590c, so telling express from late by hue
would collide on the busiest express route in the system."
```

---

### Task 3: Route search and highlight

**Files:**
- Modify: `web/src/routes.ts`
- Modify: `web/src/routes.test.ts`
- Create: `web/src/RouteSearch.tsx`
- Modify: `web/src/BusMap.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/app.css`

**Interfaces:**
- Consumes: `isExpress` from Task 2; `GtfsData.routes`, `GtfsData.ensureRoute`, `GtfsData.trackFor` from `web/src/gtfs.ts`.
- Produces:
  - `interface RouteMatch { routeId: string; label: string; name: string }`
  - `searchRoutes(routes: Map<string, RouteInfo>, query: string, limit?: number): RouteMatch[]`
  - `interface Highlight { routeId: string | null; expressOnly: boolean }`
  - `shouldDim(highlight: Highlight, routeId: string, express: boolean): boolean`
  - `BusMap` gains a `highlight: Highlight` prop

- [ ] **Step 1: Write the failing tests**

Append to `web/src/routes.test.ts`, extending the import to `{ isExpress, searchRoutes, shouldDim }`:

```ts
import type { RouteInfo } from "./gtfs.js";

const route = (s: string, n: string): RouteInfo => ({ s, n, t: 3, c: null, x: null });

const routes = new Map<string, RouteInfo>([
  ["6641", route("099", "Broadway B-Line")],
  ["6642", route("991", "Nowhere Special")],
  ["6643", route("199", "Also Not It")],
  ["6644", route("010", "Granville")],
  ["37808", route("R1", "King George Blvd")],
]);

describe("searchRoutes", () => {
  it("returns nothing for an empty or blank query", () => {
    expect(searchRoutes(routes, "")).toEqual([]);
    expect(searchRoutes(routes, "   ")).toEqual([]);
  });

  it("ranks an exact short-name match first", () => {
    // "99" must find the B-Line, not 991 or 199, however the map stores it.
    const first = searchRoutes(routes, "99")[0];
    expect(first?.routeId).toBe("6641");
    expect(first?.label).toBe("99");
  });

  it("still returns the near misses, after the exact match", () => {
    const ids = searchRoutes(routes, "99").map((m) => m.routeId);
    expect(ids).toContain("6642");
    expect(ids).toContain("6643");
    expect(ids[0]).toBe("6641");
  });

  it("matches on the long name too", () => {
    expect(searchRoutes(routes, "granville")[0]?.routeId).toBe("6644");
  });

  it("ignores case", () => {
    expect(searchRoutes(routes, "r1")[0]?.routeId).toBe("37808");
  });

  it("returns an empty list when nothing matches", () => {
    expect(searchRoutes(routes, "zzzz")).toEqual([]);
  });

  it("honours the limit", () => {
    expect(searchRoutes(routes, "9", 2)).toHaveLength(2);
  });
});

describe("shouldDim", () => {
  const none: Highlight = { routeId: null, expressOnly: false };

  it("dims nothing when no highlight is active", () => {
    expect(shouldDim(none, "6641", true)).toBe(false);
    expect(shouldDim(none, "6644", false)).toBe(false);
  });

  it("dims every route but the selected one", () => {
    const only99: Highlight = { routeId: "6641", expressOnly: false };
    expect(shouldDim(only99, "6641", true)).toBe(false);
    expect(shouldDim(only99, "6644", false)).toBe(true);
  });

  it("dims the locals when express only is on", () => {
    const express: Highlight = { routeId: null, expressOnly: true };
    expect(shouldDim(express, "37808", true)).toBe(false);
    expect(shouldDim(express, "6644", false)).toBe(true);
  });

  it("keeps a selected local visible even when express only is on", () => {
    // An explicit choice beats a broad filter, or selecting the 10 while the
    // express filter is on would dim the very route the user just picked.
    const both: Highlight = { routeId: "6644", expressOnly: true };
    expect(shouldDim(both, "6644", false)).toBe(false);
  });
});
```

Add `type Highlight` to the import list at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test web/src/routes.test.ts`
Expected: FAIL — `searchRoutes`, `shouldDim` and `Highlight` are not exported.

- [ ] **Step 3: Implement search and dimming**

Append to `web/src/routes.ts`:

```ts
import type { RouteInfo } from "./gtfs.js";

export interface RouteMatch {
  routeId: string;
  /** The short name as a rider reads it, e.g. "99", "R4". */
  label: string;
  name: string;
}

/** How the label is written for display: "099" is the 99 on every sign in the city. */
function labelOf(route: RouteInfo): string {
  return route.s ? route.s.replace(/^0+(?=\d)/, "") : route.n;
}

/**
 * Routes matching a typed query, best match first.
 *
 * An exact short-name match always ranks first. Typing "99" must find the
 * B-Line rather than the 991 or the 199, and the comparison is made on the
 * displayed label so that "99" matches the stored "099".
 */
export function searchRoutes(
  routes: Map<string, RouteInfo>,
  query: string,
  limit = 8,
): RouteMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: { match: RouteMatch; score: number }[] = [];

  for (const [routeId, route] of routes) {
    const label = labelOf(route);
    const lowerLabel = label.toLowerCase();
    const lowerName = route.n.toLowerCase();

    let score: number;
    if (lowerLabel === q) score = 0;
    else if (lowerLabel.startsWith(q)) score = 1;
    else if (lowerName.startsWith(q)) score = 2;
    else if (lowerLabel.includes(q) || lowerName.includes(q)) score = 3;
    else continue;

    scored.push({ match: { routeId, label, name: route.n }, score });
  }

  scored.sort((a, b) => a.score - b.score || a.match.label.localeCompare(b.match.label));
  return scored.slice(0, limit).map((s) => s.match);
}

/** What the map is currently emphasising. Both parts can be active at once. */
export interface Highlight {
  /** A single route the rider picked, or null. */
  routeId: string | null;
  /** True while the express-only filter is on. */
  expressOnly: boolean;
}

/**
 * True when a bus should be drawn faded rather than at full strength.
 *
 * Dimming rather than hiding is deliberate: the reason to look at this map is
 * the shape of the whole network, and a route highlighted against an empty city
 * loses the context that makes it worth seeing.
 *
 * An explicitly selected route always stays lit, even when the express filter
 * would otherwise fade it. Otherwise picking the 10 while the filter was on
 * would fade the very route just chosen.
 */
export function shouldDim(highlight: Highlight, routeId: string, express: boolean): boolean {
  if (highlight.routeId) return routeId !== highlight.routeId;
  if (highlight.expressOnly) return !express;
  return false;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test web/src/routes.test.ts`
Expected: PASS, 16 tests across the three describes.

- [ ] **Step 5: Build the search component**

Create `web/src/RouteSearch.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { GtfsData } from "./gtfs.js";
import { isExpress, searchRoutes, type RouteMatch } from "./routes.js";

/**
 * The route picker. Holds only its own query text; the chosen route is owned by
 * App, because the map and the pulse panel both need it.
 */
export function RouteSearch({
  gtfs,
  selected,
  liveCount,
  expressOnly,
  onSelect,
  onToggleExpress,
}: {
  gtfs: GtfsData | null;
  selected: RouteMatch | null;
  liveCount: number;
  expressOnly: boolean;
  onSelect: (route: RouteMatch | null) => void;
  onToggleExpress: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses the search, the convention every map and code host shares.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === inputRef.current) {
        setQuery("");
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const matches = gtfs ? searchRoutes(gtfs.routes, query) : [];

  const choose = (match: RouteMatch) => {
    onSelect(match);
    setQuery("");
  };

  return (
    <div className="routesearch">
      <div className="routesearch-controls">
        <input
          ref={inputRef}
          className="routesearch-input"
          type="search"
          value={query}
          placeholder="Search a route, e.g. 99 or Granville"
          aria-label="Search for a route"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className={expressOnly ? "express-toggle on" : "express-toggle"}
          onClick={onToggleExpress}
          aria-pressed={expressOnly}
        >
          Express
        </button>
      </div>

      {matches.length > 0 && (
        <ul className="routesearch-results">
          {matches.map((match) => (
            <li key={match.routeId}>
              <button onClick={() => choose(match)}>
                <span className={isExpress(match.label) ? "route-badge express" : "route-badge"}>
                  {match.label}
                </span>
                <span className="routesearch-name">{match.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="routesearch-selected" role="status">
          <span className="route-badge">{selected.label}</span>
          <span className="routesearch-name">{selected.name}</span>
          <span className="routesearch-count">
            {liveCount} {liveCount === 1 ? "bus" : "buses"} running
          </span>
          <button onClick={() => onSelect(null)} aria-label="Clear route filter">
            &times;
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Apply the highlight on the map**

In `web/src/BusMap.tsx`:

Add `highlight` to the props and keep it in a ref, following the pattern the other callbacks already use (`web/src/BusMap.tsx:88-97`):

```ts
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
```

In `animate()`, add to the `properties` object:

```ts
          dim: shouldDim(highlightRef.current, bus.routeId, isExpress(gtfs.routeLabel(bus.routeId))),
```

Add the opacity rules to the `bus-icons` layer. Put them in a `paint` block beside the existing `layout`:

```ts
        paint: {
          "icon-opacity": ["case", ["get", "dim"], 0.2, 0.95],
        },
```

Add the same dimming to `bus-express` by changing its `circle-stroke-opacity` to:

```ts
          "circle-stroke-opacity": ["case", ["get", "dim"], 0.15, 0.75],
```

- [ ] **Step 7: Draw the selected route's line**

In the `style.load` handler, add an empty source and a line layer beneath every bus layer:

```ts
      map.addSource("route-line", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route-line",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, 5],
          "line-opacity": 0.55,
        },
      }, "bus-express");
```

Then add an effect in the component body that redraws it when the highlighted route changes:

```ts
  useEffect(() => {
    const map = mapRef.current;
    const gtfs = gtfsRef.current;
    const source = map?.getSource("route-line") as maplibregl.GeoJSONSource | undefined;
    if (!map || !gtfs || !source) return;

    const routeId = highlight.routeId;
    if (!routeId) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    let cancelled = false;
    // The geometry bundle may not be loaded yet. ensureRoute is idempotent and
    // swallows a failed fetch, so a route whose shapes never arrive simply
    // highlights its buses with no line, rather than blocking on the fetch.
    void gtfs.ensureRoute(routeId).then(() => {
      if (cancelled) return;
      const color = gtfs.routeColor(routeId);
      const features = gtfs.shapesFor(routeId).map((points) => ({
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: points.map(([lat, lon]) => [lon, lat]),
        },
        properties: { color },
      }));
      source.setData({ type: "FeatureCollection", features });
    });

    return () => {
      cancelled = true;
    };
  }, [highlight.routeId]);
```

This needs a new accessor on `GtfsData`, because `tracks` is private and keyed by shape id, not route id. In `web/src/gtfs.ts`, record the shape ids per route inside `ensureRoute` and expose them. Add a field:

```ts
  /** routeId -> the shape ids in its bundle, filled by ensureRoute. */
  private routeShapes = new Map<string, string[]>();
```

Inside `ensureRoute`'s `try` block, after the `for` loop that fills `this.tracks`:

```ts
        this.routeShapes.set(routeId, Object.keys(bundle));
```

And add the accessor:

```ts
  /** Every loaded shape for a route, as point arrays. Empty until ensureRoute resolves. */
  shapesFor(routeId: string): LatLon[][] {
    const shapeIds = this.routeShapes.get(routeId) ?? [];
    return shapeIds
      .map((id) => this.tracks.get(id))
      .filter((track): track is Track => track !== undefined)
      .map((track) => track.points);
  }
```

- [ ] **Step 8: Wire it into App**

In `web/src/App.tsx`, add state and pass it down:

```tsx
  const [route, setRoute] = useState<RouteMatch | null>(null);
  const [expressOnly, setExpressOnly] = useState(false);
  const [liveByRoute, setLiveByRoute] = useState<Map<string, number>>(new Map());

  const highlight: Highlight = { routeId: route?.routeId ?? null, expressOnly };
```

Pass `highlight` to `<BusMap>`, and render the search above the status bar:

```tsx
      <RouteSearch
        gtfs={gtfs}
        selected={route}
        liveCount={route ? (liveByRoute.get(route.routeId) ?? 0) : 0}
        expressOnly={expressOnly}
        onSelect={setRoute}
        onToggleExpress={() => setExpressOnly((on) => !on)}
      />
```

`liveByRoute` is filled in Task 6, which builds the same tally for the pulse panel. Until then it stays empty and the count reads 0. Add `onCounts` to `BusMap`'s props now so Task 6 only has to fill it:

```ts
  onCounts: (byRoute: Map<string, number>) => void;
```

and call it from `apply()`:

```ts
      const byRoute = new Map<string, number>();
      for (const v of snapshot.vehicles) byRoute.set(v.r, (byRoute.get(v.r) ?? 0) + 1);
      onCountsRef.current(byRoute);
```

- [ ] **Step 9: Style it**

Add to `web/src/app.css`, matching the existing card and status bar conventions — follow whatever custom properties the file already defines for surface, text and border colours rather than introducing new literals:

```css
.routesearch {
  position: absolute;
  top: 12px;
  left: 12px;
  width: min(320px, calc(100vw - 24px));
  z-index: 5;
}
.routesearch-controls { display: flex; gap: 6px; }
.routesearch-input { flex: 1; min-width: 0; }
.routesearch-results { list-style: none; margin: 4px 0 0; padding: 0; }
.routesearch-results button { display: flex; gap: 8px; width: 100%; text-align: left; }
.routesearch-selected { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.route-badge.express { font-weight: 700; }
```

- [ ] **Step 10: Verify by eye**

Run the dev servers. Confirm: typing `99` lists the B-Line first; choosing it dims every other bus and draws the route line; the count reads 0 for now (Task 6 fills it); the `Express` button dims all locals; pressing `/` focuses the box and `Escape` clears it.

- [ ] **Step 11: Run the whole suite and commit**

Run: `npm run check`

```bash
git add web/src/routes.ts web/src/routes.test.ts web/src/RouteSearch.tsx web/src/BusMap.tsx web/src/App.tsx web/src/gtfs.ts web/src/app.css
git commit -m "Add route search, and dim the rest when one is chosen

Choosing a route fades the others rather than hiding them: the reason
to look at this map is the shape of the whole network, and one route
against an empty city loses the context that makes it worth seeing.

An exact short-name match always ranks first, compared on the displayed
label, so typing 99 finds the B-Line rather than the 991 or the 199."
```

---

### Task 4: Ride along with a bus

**Files:**
- Modify: `web/src/BusMap.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/app.css`

**Interfaces:**
- Consumes: `SelectedBus` and the `animate` loop from Task 1.
- Produces: `BusMap` gains `followId: string | null` and `onStopFollowing: () => void` props.

- [ ] **Step 1: Hold the follow target in a ref**

In `web/src/BusMap.tsx`, add the two props and mirror `followId` into a ref beside the others:

```ts
  const followRef = useRef(followId);
  followRef.current = followId;
```

- [ ] **Step 2: Re-centre the camera each frame**

At the end of `animate()`, after `source.setData(...)`:

```ts
      // Follow the selected bus. setCenter, not easeTo: an eased camera has its
      // own animation clock and would fight a target that moves every frame.
      const following = followRef.current;
      if (following) {
        const bus = field.positionsAt(Date.now(), glide).find((b) => b.id === following);
        if (bus) map.setCenter([bus.lon, bus.lat]);
      }
```

- [ ] **Step 3: Let a drag cancel it**

In `bindInteractions`, add:

```ts
      // Panning is an unambiguous request to look somewhere else. Without this
      // the camera would drag the map back on the next frame.
      map.on("dragstart", () => {
        if (followRef.current) onStopFollowingRef.current();
      });
```

- [ ] **Step 4: Stop following a bus that leaves the feed**

In `apply()`, the block at `web/src/BusMap.tsx:524` already closes the card for a bus `BusField` has dropped. Extend it:

```ts
      if (selectedId.current) {
        const stillHere = field.has(selectedId.current);
        select(stillHere ? selectedId.current : undefined);
        // A bus that has ended its trip will never move again. Following it
        // would pin the camera to a corner of the map for good.
        if (!stillHere && followRef.current) onStopFollowingRef.current();
      }
```

- [ ] **Step 5: Add the toggle to the bus card**

In `web/src/App.tsx`, add `following` and `onToggleFollow` props to `BusCard`, and render the button in `buscard-head` beside the close button:

```tsx
        <button
          className={following ? "follow-button on" : "follow-button"}
          onClick={onToggleFollow}
          aria-pressed={following}
        >
          {following ? "Following" : "Follow"}
        </button>
```

In `App`, hold the state and clear it whenever the selection changes:

```tsx
  const [followId, setFollowId] = useState<string | null>(null);
```

Pass `followId` and `onStopFollowing={() => setFollowId(null)}` to `<BusMap>`. When `BusCard` closes, clear `followId` alongside `bus`:

```tsx
      {bus && (
        <BusCard
          bus={bus}
          following={followId === bus.id}
          onToggleFollow={() => setFollowId((id) => (id === bus.id ? null : bus.id))}
          onClose={() => {
            setFollowId(null);
            setBus(null);
          }}
        />
      )}
```

- [ ] **Step 6: Style the toggle**

Add to `web/src/app.css`:

```css
.follow-button { font-size: 12px; padding: 2px 8px; border-radius: 999px; }
.follow-button.on { font-weight: 600; }
```

- [ ] **Step 7: Verify by eye**

Run the dev servers. Tap a moving bus, press **Follow**, and confirm the map tracks it smoothly rather than stepping. Drag the map and confirm following stops. Confirm the button reads `Following` while active.

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm run check`

```bash
git add web/src/BusMap.tsx web/src/App.tsx web/src/app.css
git commit -m "Follow a bus as it moves

The camera re-centres on the followed bus each frame, reusing the glide
that already runs. Panning cancels it, because a drag is an unambiguous
request to look somewhere else, and a bus that leaves the feed cancels
it too, or the camera would pin to a corner for good."
```

---

### Task 5: Bunching detector

**Files:**
- Modify: `web/src/buses.ts`
- Modify: `web/src/buses.test.ts`
- Modify: `web/src/BusMap.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `RenderedBus` (`id`, `routeId`, `lat`, `lon`, `bearing`, `moving`); `distance` from `web/src/geo.ts`.
- Produces:
  - `interface Bunch { routeId: string; busIds: string[]; center: LatLon }`
  - `BUNCH_METRES: number`, `BUNCH_BEARING_TOLERANCE: number`
  - `findBunches(buses: RenderedBus[], metres?: number): Bunch[]`

- [ ] **Step 1: Write the failing tests**

Append to `web/src/buses.test.ts`, adding `findBunches` and `BUNCH_METRES` to the import from `./buses.js`:

```ts
const rendered = (over: Partial<RenderedBus> = {}): RenderedBus => ({
  id: "a",
  routeId: "route1",
  tripId: "trip1",
  lat: 49.28,
  lon: -123.12,
  bearing: 0,
  moving: true,
  delay: null,
  ...over,
});

/** Roughly north by `metres`, at Vancouver's latitude. */
const northOf = (lat: number, metres: number) => lat + metres / 111_320;

describe("findBunches", () => {
  it("finds two buses on one route sitting on top of each other", () => {
    const bunches = findBunches([
      rendered({ id: "a" }),
      rendered({ id: "b", lat: northOf(49.28, 80) }),
    ]);
    expect(bunches).toHaveLength(1);
    expect([...(bunches[0]?.busIds ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("leaves the same two alone once they are properly spaced", () => {
    expect(
      findBunches([rendered({ id: "a" }), rendered({ id: "b", lat: northOf(49.28, 900) })]),
    ).toEqual([]);
  });

  it("does not bunch buses on different routes", () => {
    expect(
      findBunches([
        rendered({ id: "a", routeId: "route1" }),
        rendered({ id: "b", routeId: "route2", lat: northOf(49.28, 50) }),
      ]),
    ).toEqual([]);
  });

  it("does not bunch buses going opposite ways", () => {
    // Two buses passing on the same street are the timetable working, not
    // bunching. Only the same direction counts.
    expect(
      findBunches([
        rendered({ id: "a", bearing: 0 }),
        rendered({ id: "b", bearing: 180, lat: northOf(49.28, 50) }),
      ]),
    ).toEqual([]);
  });

  it("does not bunch buses parked at a terminus", () => {
    expect(
      findBunches([
        rendered({ id: "a", moving: false }),
        rendered({ id: "b", moving: false, lat: northOf(49.28, 30) }),
      ]),
    ).toEqual([]);
  });

  it("groups three close buses as one bunch, not three pairs", () => {
    const bunches = findBunches([
      rendered({ id: "a" }),
      rendered({ id: "b", lat: northOf(49.28, 60) }),
      rendered({ id: "c", lat: northOf(49.28, 120) }),
    ]);
    expect(bunches).toHaveLength(1);
    expect(bunches[0]?.busIds).toHaveLength(3);
  });

  it("returns nothing for an empty field or a single bus", () => {
    expect(findBunches([])).toEqual([]);
    expect(findBunches([rendered()])).toEqual([]);
  });

  it("treats bearings either side of north as the same direction", () => {
    const bunches = findBunches([
      rendered({ id: "a", bearing: 350 }),
      rendered({ id: "b", bearing: 10, lat: northOf(49.28, 50) }),
    ]);
    expect(bunches).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test web/src/buses.test.ts`
Expected: FAIL — `findBunches` is not exported.

- [ ] **Step 3: Implement the detector**

Append to `web/src/buses.ts`, importing `distance` from `./geo.js` alongside the existing imports:

```ts
/** Two buses on one route closer than this, going the same way, are bunched. */
export const BUNCH_METRES = 200;

/**
 * How far two headings may differ and still count as the same direction.
 *
 * Generous on purpose. The bearing is derived from route geometry rather than
 * reported, so two buses a block apart on a curve genuinely differ by more than
 * a few degrees. Ninety degrees would admit a bus turning off the route;
 * forty-five separates "following each other" from "passing each other", which
 * is the distinction that matters.
 */
export const BUNCH_BEARING_TOLERANCE = 45;

/**
 * geo.ts measures in equivalent degrees of latitude. One degree of latitude is
 * about 111.32 km, which is what converts BUNCH_METRES into those units.
 */
const METRES_PER_DEGREE = 111_320;

export interface Bunch {
  routeId: string;
  busIds: string[];
}

/** The smaller angle between two compass bearings, 0-180. */
export function bearingDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Groups of buses on the same route that have closed up on each other — the
 * "nothing for twenty minutes, then three at once" every rider knows.
 *
 * Two corrections stop it crying wolf. Both buses must be moving, because a
 * terminus or a layover parks several buses together by design and that is not
 * bunching. And both must be heading the same way, because two buses passing in
 * opposite directions on the same street is the timetable working correctly.
 *
 * Grouping is transitive: three buses in a line form one bunch of three, not
 * three overlapping pairs, which is how a rider would describe it.
 */
export function findBunches(buses: RenderedBus[], metres = BUNCH_METRES): Bunch[] {
  const threshold = metres / METRES_PER_DEGREE;

  const byRoute = new Map<string, RenderedBus[]>();
  for (const bus of buses) {
    if (!bus.moving) continue;
    const fleet = byRoute.get(bus.routeId);
    if (fleet) fleet.push(bus);
    else byRoute.set(bus.routeId, [bus]);
  }

  const bunches: Bunch[] = [];

  for (const [routeId, fleet] of byRoute) {
    if (fleet.length < 2) continue;

    // Union-find by repeated merging: fleets on one route are small enough that
    // the simple form is faster to read and fast enough to run every frame.
    const groups: RenderedBus[][] = [];

    for (const bus of fleet) {
      const near = groups.filter((group) =>
        group.some(
          (other) =>
            distance([bus.lat, bus.lon], [other.lat, other.lon]) <= threshold &&
            bearingDelta(bus.bearing, other.bearing) <= BUNCH_BEARING_TOLERANCE,
        ),
      );

      if (near.length === 0) {
        groups.push([bus]);
        continue;
      }

      // Joining two existing groups merges them, so a chain stays one bunch.
      const merged = near.flat();
      merged.push(bus);
      for (const group of near) groups.splice(groups.indexOf(group), 1);
      groups.push(merged);
    }

    for (const group of groups) {
      if (group.length < 2) continue;
      bunches.push({ routeId, busIds: group.map((bus) => bus.id) });
    }
  }

  return bunches;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test web/src/buses.test.ts`
Expected: PASS, 8 new tests.

- [ ] **Step 5: Mark bunched buses on the map**

In `web/src/BusMap.tsx`, add `findBunches` to the existing import from `./buses.js` (`noUnusedLocals` is on, so import exactly what you use), then compute bunches inside `animate()` before building the features:

```ts
      const positions = field.positionsAt(Date.now(), glide);
      const bunched = new Set(findBunches(positions).flatMap((b) => b.busIds));
```

Use `positions` for the feature map rather than calling `positionsAt` a second time, and add to `properties`:

```ts
          bunched: bunched.has(bus.id),
```

Add a layer beneath `bus-icons`, after `bus-express`:

```ts
      // A second ring, dashed, for a bus that has closed up on another on its
      // own route. Distinct from the express ring by pattern rather than colour,
      // for the same reason the express ring avoids hue.
      map.addLayer({
        id: "bus-bunched",
        type: "circle",
        source: "buses",
        filter: ["==", ["get", "bunched"], true],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 4, 12, 6, 15, 10],
          "circle-color": "#9b59b6",
          "circle-opacity": 0.22,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#9b59b6",
        },
      }, "bus-icons");
```

- [ ] **Step 6: Report the count in the status bar**

Extend `FeedState`'s `live` variant with `bunched: number`, set it in `apply()` from `findBunches(field.positionsAt(Date.now()))`, and render it in `StatusPill` beside the late note:

```tsx
        {feed.bunched > 0 && (
          <span className="bunch-note">
            <span className="dot bunched" aria-hidden="true" />
            <strong>{feed.bunched}</strong> bunched
          </span>
        )}
```

Add a `.dot.bunched { background: #9b59b6; }` rule to `web/src/app.css` beside the other dot colours.

- [ ] **Step 7: Verify by eye**

Run the dev servers at a busy time of day. Confirm dashed rings appear on genuinely adjacent same-route buses, and that a terminus with several parked buses does **not** light up. If every terminus lights up anyway, the `moving` flag is not behaving as expected — investigate before shipping rather than widening the threshold.

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm run check`

```bash
git add web/src/buses.ts web/src/buses.test.ts web/src/BusMap.tsx web/src/App.tsx web/src/app.css
git commit -m "Show where buses have bunched up

Two corrections keep it honest. Both buses must be moving, because a
terminus parks several together by design and that is not bunching. And
both must head the same way, because two buses passing in opposite
directions on one street is the timetable working.

Grouping is transitive, so three buses in a line read as one bunch of
three rather than three overlapping pairs."
```

---

### Task 6: System pulse panel

**Files:**
- Modify: `web/src/routes.ts`
- Modify: `web/src/routes.test.ts`
- Create: `web/src/SystemPulse.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/BusMap.tsx`
- Modify: `web/src/app.css`

**Interfaces:**
- Consumes: `WireVehicle` from `web/src/buses.ts`; `GtfsData.routeLabel`; the `onCounts` prop added in Task 3.
- Produces:
  - `interface RouteTally { routeId: string; label: string; count: number }`
  - `interface RouteDelay { routeId: string; label: string; meanDelay: number; count: number }`
  - `MIN_BUSES_FOR_DELAY_RANKING: number`
  - `busiestRoutes(vehicles, labelFor, limit?): RouteTally[]`
  - `worstDelayedRoutes(vehicles, labelFor, limit?): RouteDelay[]`

- [ ] **Step 1: Write the failing tests**

Append to `web/src/routes.test.ts`:

```ts
import { busiestRoutes, worstDelayedRoutes, MIN_BUSES_FOR_DELAY_RANKING } from "./routes.js";
import type { WireVehicle } from "./buses.js";

const wire = (r: string, l?: number): WireVehicle => ({
  i: `${r}-${Math.random()}`,
  r,
  t: "trip",
  y: 49.28,
  x: -123.12,
  s: 1,
  p: "stop",
  ...(l === undefined ? {} : { l }),
});

const label = (id: string) => (id === "6641" ? "99" : id === "37808" ? "R1" : id);

describe("busiestRoutes", () => {
  it("ranks routes by how many buses are running", () => {
    const result = busiestRoutes(
      [wire("6641"), wire("6641"), wire("6641"), wire("37808"), wire("37808"), wire("10")],
      label,
    );
    expect(result[0]).toMatchObject({ routeId: "6641", label: "99", count: 3 });
    expect(result[1]).toMatchObject({ routeId: "37808", count: 2 });
    expect(result[2]).toMatchObject({ routeId: "10", count: 1 });
  });

  it("honours the limit", () => {
    expect(busiestRoutes([wire("a"), wire("b"), wire("c")], label, 2)).toHaveLength(2);
  });

  it("returns nothing for an empty snapshot", () => {
    expect(busiestRoutes([], label)).toEqual([]);
  });
});

describe("worstDelayedRoutes", () => {
  it("ranks by mean delay, worst first", () => {
    const vehicles = [
      ...Array.from({ length: 3 }, () => wire("slow", 600)),
      ...Array.from({ length: 3 }, () => wire("ok", 60)),
    ];
    const result = worstDelayedRoutes(vehicles, label);
    expect(result[0]?.routeId).toBe("slow");
    expect(result[0]?.meanDelay).toBe(600);
  });

  it("ignores a route with too few buses to mean anything", () => {
    // One very late bus on an hourly suburban route must not top a table about
    // how the network is running.
    const vehicles = [wire("lonely", 3000), ...Array.from({ length: 3 }, () => wire("busy", 400))];
    const result = worstDelayedRoutes(vehicles, label);
    expect(result.map((r) => r.routeId)).not.toContain("lonely");
    expect(result[0]?.routeId).toBe("busy");
  });

  it("ignores buses with no delay reading", () => {
    const vehicles = [
      wire("mixed", 300),
      wire("mixed", 300),
      wire("mixed", 300),
      wire("mixed"),
    ];
    expect(worstDelayedRoutes(vehicles, label)[0]?.count).toBe(3);
  });

  it("leaves out routes running to time", () => {
    const vehicles = Array.from({ length: 4 }, () => wire("punctual", -30));
    expect(worstDelayedRoutes(vehicles, label)).toEqual([]);
  });

  it("names the floor it applies", () => {
    expect(MIN_BUSES_FOR_DELAY_RANKING).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test web/src/routes.test.ts`
Expected: FAIL — `busiestRoutes` and `worstDelayedRoutes` are not exported.

- [ ] **Step 3: Implement the tallies**

Append to `web/src/routes.ts`, importing `WireVehicle` and `isLate` from `./buses.js`:

```ts
export interface RouteTally {
  routeId: string;
  label: string;
  count: number;
}

/** Routes with the most buses on the road right now, busiest first. */
export function busiestRoutes(
  vehicles: WireVehicle[],
  labelFor: (routeId: string) => string,
  limit = 5,
): RouteTally[] {
  const counts = new Map<string, number>();
  for (const v of vehicles) counts.set(v.r, (counts.get(v.r) ?? 0) + 1);

  return [...counts.entries()]
    .map(([routeId, count]) => ({ routeId, label: labelFor(routeId), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/**
 * How many buses a route needs before its delay is worth ranking.
 *
 * Without a floor the table is topped by whichever hourly suburban route
 * happens to have one bus stuck in traffic, which says nothing about how the
 * network is running. Three is the smallest number where a mean is not just one
 * bus wearing a disguise.
 */
export const MIN_BUSES_FOR_DELAY_RANKING = 3;

export interface RouteDelay {
  routeId: string;
  label: string;
  /** Mean delay in seconds across the buses reporting one. */
  meanDelay: number;
  /** How many buses that mean is drawn from. */
  count: number;
}

/**
 * Routes running worst against schedule right now, worst first.
 *
 * Only counts buses that actually report a delay, and only reports a route once
 * it is late by the same threshold the map already uses for a single bus, so
 * the panel and the map never disagree about what "late" means.
 */
export function worstDelayedRoutes(
  vehicles: WireVehicle[],
  labelFor: (routeId: string) => string,
  limit = 5,
): RouteDelay[] {
  const totals = new Map<string, { sum: number; count: number }>();

  for (const v of vehicles) {
    if (v.l == null) continue;
    const entry = totals.get(v.r) ?? { sum: 0, count: 0 };
    entry.sum += v.l;
    entry.count++;
    totals.set(v.r, entry);
  }

  return [...totals.entries()]
    .filter(([, t]) => t.count >= MIN_BUSES_FOR_DELAY_RANKING)
    .map(([routeId, t]) => ({
      routeId,
      label: labelFor(routeId),
      meanDelay: Math.round(t.sum / t.count),
      count: t.count,
    }))
    .filter((r) => isLate(r.meanDelay))
    .sort((a, b) => b.meanDelay - a.meanDelay || a.label.localeCompare(b.label))
    .slice(0, limit);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test web/src/routes.test.ts`
Expected: PASS, 8 new tests.

- [ ] **Step 5: Build the panel**

Create `web/src/SystemPulse.tsx`:

```tsx
import { describeDelay } from "./buses.js";
import type { RouteDelay, RouteTally } from "./routes.js";

/**
 * Two live leaderboards over the snapshot already on screen: where the fleet is,
 * and which routes are having a bad afternoon. No new data of any kind.
 */
export function SystemPulse({
  busiest,
  worst,
  onSelectRoute,
  onClose,
}: {
  busiest: RouteTally[];
  worst: RouteDelay[];
  onSelectRoute: (routeId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="pulse" role="dialog" aria-label="System pulse">
      <div className="pulse-head">
        <strong>Right now</strong>
        <button onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      <h3>Most buses running</h3>
      {busiest.length === 0 ? (
        <p className="pulse-empty">No live buses.</p>
      ) : (
        <ul className="pulse-list">
          {busiest.map((row) => (
            <li key={row.routeId}>
              <button onClick={() => onSelectRoute(row.routeId)}>
                <span className="route-badge">{row.label}</span>
                <span className="pulse-value">{row.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Running latest</h3>
      {worst.length === 0 ? (
        <p className="pulse-empty">Every route is running to time.</p>
      ) : (
        <ul className="pulse-list">
          {worst.map((row) => (
            <li key={row.routeId}>
              <button onClick={() => onSelectRoute(row.routeId)}>
                <span className="route-badge">{row.label}</span>
                <span className="pulse-value">{describeDelay(row.meanDelay)}</span>
                <span className="pulse-sub">{row.count} buses</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Feed it the snapshot**

`SystemPulse` needs the raw vehicles, which currently never leave `BusMap`. Extend the `onCounts` prop added in Task 3 to carry the snapshot instead. In `web/src/BusMap.tsx`, change the prop to:

```ts
  onSnapshot: (vehicles: WireVehicle[]) => void;
```

and call `onSnapshotRef.current(snapshot.vehicles)` at the end of `apply()`. Remove the `byRoute` tally added in Task 3 — `busiestRoutes` now computes it, so keeping both would be two sources of the same number.

In `web/src/App.tsx`:

```tsx
  const [vehicles, setVehicles] = useState<WireVehicle[]>([]);
  const [showPulse, setShowPulse] = useState(false);

  const labelFor = (routeId: string) => gtfs?.routeLabel(routeId) ?? routeId;
  const busiest = busiestRoutes(vehicles, labelFor);
  const worst = worstDelayedRoutes(vehicles, labelFor);
```

Pass `onSnapshot={setVehicles}` to `<BusMap>`. Replace the Task 3 `liveCount` expression with one derived from the same source:

```tsx
        liveCount={route ? vehicles.filter((v) => v.r === route.routeId).length : 0}
```

Add a Pulse button to the status bar beside About, and render the panel:

```tsx
      {showPulse && (
        <SystemPulse
          busiest={busiest}
          worst={worst}
          onSelectRoute={(routeId) => {
            const info = gtfs?.routes.get(routeId);
            if (info) setRoute({ routeId, label: labelFor(routeId), name: info.n });
            setShowPulse(false);
          }}
          onClose={() => setShowPulse(false)}
        />
      )}
```

- [ ] **Step 7: Style it**

Add to `web/src/app.css`, reusing the existing card surface conventions:

```css
.pulse {
  position: absolute;
  right: 12px;
  bottom: 56px;
  width: min(280px, calc(100vw - 24px));
  z-index: 6;
}
.pulse-head { display: flex; justify-content: space-between; align-items: center; }
.pulse h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin: 10px 0 4px; }
.pulse-list { list-style: none; margin: 0; padding: 0; }
.pulse-list button { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; }
.pulse-value { margin-left: auto; font-variant-numeric: tabular-nums; }
.pulse-sub { opacity: 0.65; font-size: 11px; }
```

- [ ] **Step 8: Verify by eye**

Run the dev servers. Open the panel and confirm the busiest list is plausible for the time of day (the 99 and the R-lines should be near the top at peak), that clicking a row selects that route and highlights it on the map, and that the route search count now reads a real number rather than 0.

- [ ] **Step 9: Run the whole suite and commit**

Run: `npm run check`

```bash
git add web/src/routes.ts web/src/routes.test.ts web/src/SystemPulse.tsx web/src/App.tsx web/src/BusMap.tsx web/src/app.css
git commit -m "Add a live system pulse panel

Two leaderboards over the snapshot already on screen: which routes have
the most buses running, and which are running latest. No new requests.

The delay table needs at least three buses on a route before it ranks
it, or the top of the table is whichever hourly suburban route has one
bus stuck in traffic, which says nothing about the network. It reuses
the map's own late threshold so the panel and the map never disagree
about what late means."
```

---

### Task 7: Update the documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Correct the stale facts in README.md**

Three things in `README.md` are now wrong:

1. It says `npm test` runs **120 tests**. Run `npm test` and use the real number.
2. The **Layout** block omits `src/types.ts`, `src/wire.ts`, `web/src/basemap.ts` and `scripts/gtfs-util.ts`, and does not mention the files this plan added. Bring it up to date, adding `web/src/routes.ts`, `web/src/icons.ts`, `web/src/RouteSearch.tsx` and `web/src/SystemPulse.tsx`.
3. The **"What the feeds actually contain"** section says "No bearing and no occupancy are populated on any vehicle." A probe on 2026-09-06 across 579 vehicles showed `Position` carries only latitude and longitude. Widen the claim:

```markdown
- **Position is all you get.** No bearing, no speed, no odometer, no occupancy
  and no congestion level are populated on any vehicle — verified against a live
  payload, not assumed. Heading is derived from the route geometry.
```

- [ ] **Step 2: Note the new modules in CLAUDE.md**

Add `web/src/routes.ts` and `web/src/icons.ts` to the architecture summary, and record the convention this work follows: **decision logic goes in a `.ts` module with tests; `.tsx` files stay thin, because the suite runs under Node with no DOM.**

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "Bring the docs back in line with the code

The test count was stale, the Layout block had drifted from the tree,
and the feed section understated what TransLink omits: a probe of one
live payload across 579 vehicles found Position carries only latitude
and longitude."
```

---

## Verification

After every task: `npm run check` from the repo root — typecheck plus the full suite.

After Task 7, before opening the pull request:

```bash
npm run check
npm run build          # the web build also typechecks the client
npx wrangler deploy --dry-run
```

The deploy dry run matters because CI runs one, and nothing in this plan touches the Worker — a failure there means something was changed that should not have been.

## Notes for the executor

- **Do not change `src/config.ts`.** Nothing in this plan needs to, and `src/config.test.ts` will fail the build if the poll budget moves.
- **`web/src/BusMap.tsx` is touched by five of the seven tasks.** Its `useEffect` runs once with an empty dependency array and holds everything in closures and refs. Follow that pattern: new values from props go into a ref mirrored on every render, not into the dependency array, or the map is torn down and rebuilt on every change.
- **The feature `properties` object in `animate()` accumulates across tasks.** By Task 6 it carries `id`, `label`, `color`, `bearing`, `late`, `icon`, `express`, `dim` and `bunched`. If a property is missing, its layer silently draws nothing rather than erroring.
- **If a step's code does not fit the file as you find it,** the file changed in an earlier task. Read it before editing rather than pattern-matching on the plan.
