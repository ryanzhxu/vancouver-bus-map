# Map exploration features — design

Date: 2026-09-06
Status: approved, ready for an implementation plan
Ships as: one branch, one pull request

## Why

The map is accurate but hard to explore. Every bus is a 4px dot in one of two
colours, there is no way to ask about a single route, and the express services
are indistinguishable from a local at any zoom a rider actually uses. This adds
six features that make the network legible, all of them driven by data the app
already receives.

## What this does not change

Nothing here spends a single extra TransLink request. Every feature is derived
from the snapshot already on the wire or from the static GTFS artifacts already
in R2. The poll budget in `src/config.ts` is untouched, and
`src/config.test.ts` continues to guard it.

## Two findings that shape the design

**The bearing is already computed and thrown away.** `BusField.positionOf`
returns a bearing for every bus (`web/src/buses.ts:368`), `animate()` writes it
into the feature properties (`web/src/BusMap.tsx:547`), and no layer reads it.
The comment above the `bus-dots` layer (`web/src/BusMap.tsx:204`) even describes
a triangle that shows heading; the layer beneath it is a `circle`. Direction is
free.

**The express routes already carry their official colours.** Only 12 of 245
routes have a `route_color`. R1–R6 all carry `008522` (RapidBus green) and route
099 carries `d04110` (B-Line orange), and `GtfsData.routeColor`
(`web/src/gtfs.ts:141`) already returns them. The express services are already
colour-coded; at 4px nobody can see it. Item 6 is a prominence problem, not a
colour problem.

A hazard follows from that: 099's `d04110` is close to
`LATE_COLOR = "#e8590c"` (`web/src/BusMap.tsx:22`). Express and late must never
be distinguished by hue alone.

## Out of scope

- **Replay the last hour.** Deferred by decision. It is the only feature needing
  new Durable Object storage, a new R2 write path, a retention policy and a
  payload-scoping decision. Recorded in "Deferred work" below so the reasoning
  is not lost.
- **Live road traffic.** Still an open question. The cheapest possible answer —
  that TransLink already sends a speed or congestion field — was probed and
  ruled out (see "Open questions"). What remains is either an external traffic
  provider, or deriving congestion from the buses themselves. The second is
  more tractable here than it looks: `projectOntoTrack` (`web/src/geo.ts`)
  already converts a position into a distance along the route polyline, so two
  consecutive samples give a true along-route speed rather than a straight-line
  approximation that would be wrong on every curve. That is the hard part of a
  transit-probe congestion estimate, and it is already written.
- **A full stop ladder for ride-along.** The static schedule artifacts are keyed
  by stop (`sched/{stop}.json`), not by trip, so the ordered stop list for a trip
  is not available on the client. Serving one would need a new GTFS artifact,
  which is too much weight for this feature. Ride-along ships with the next stop
  and ETA that the bus card already shows.

## Design

### 1. Zoom-aware bus markers

Replace the `bus-dots` circle layer with a MapLibre **symbol** layer using SDF
icons, registered at runtime with `map.addImage(name, data, { sdf: true })`. SDF
is required because `icon-color` only applies to SDF images, and the per-route
colour must survive.

- `icon-image`: a `step` expression on zoom — a chevron below 13, a bus
  silhouette at 13 and above. 13 matches the zoom at which `bus-labels` already
  appears.
- `icon-rotate`: `["get", "bearing"]`, with `icon-rotation-alignment: "map"`.
- `icon-allow-overlap: true` and `icon-ignore-placement: true`, so ~1,500 points
  skip collision detection. Without this a symbol layer is markedly slower than
  the circle layer it replaces.
- `icon-color`: `["get", "color"]`, unchanged from today's `circle-color`.

The `bus-late` and `bus-selected` circle layers stay exactly as they are,
beneath the symbols, so the halos keep reading as halos.

Reduced motion is unaffected: it is handled in `positionsAt`, upstream of
rendering.

**Testable seam:** `markerIconFor(zoom)` and the icon-size ramp move into
`web/src/buses.ts` as pure functions. The repo has no DOM test harness, so
anything that must be tested cannot live in the layer definition.

### 2. Route search and highlight

New module `web/src/routes.ts` holding the pure logic:

- `searchRoutes(routes, query)` — matches short name or long name, ranks an
  exact short-name match first so "99" returns 099 before 199 or 991. Handles
  the leading-zero form, since `routeLabel` strips it for display
  (`web/src/gtfs.ts:137`) while the underlying data keeps it.

New component `web/src/RouteSearch.tsx`. It goes in its own file rather than
into `App.tsx`, which is already 388 lines and is one of the two largest files
in the repo.

Selecting a route:

- **Dims** the other buses rather than hiding them, via a `case` expression on
  `icon-opacity`. Hiding them would throw away the sense of the whole network,
  which is the reason to look at this map at all.
- Draws that route's shape as a new `route-line` layer, from the geometry
  `GtfsData.ensureRoute` already fetches lazily.
- Reports how many of its buses are live right now.

Clearing the search restores the default paint. Selection state lives in `App`
and is passed to `BusMap` as a prop.

**Error handling:** `ensureRoute` already swallows a failed geometry fetch and
lets those buses fall back to straight-line movement
(`web/src/gtfs.ts:106`). A route selected while its geometry is still loading
highlights its buses immediately and draws the line when it arrives; it never
blocks on the fetch.

### 3. Express prominence

`isExpress(shortName)` in `web/src/routes.ts` — true for `/^R[1-6]$/` and for
route 099 in either the `099` or `99` form.

Express buses get a larger icon and an outer ring, and are drawn above ordinary
buses using `symbol-sort-key`. The ring is a **shape** difference, never a hue
difference, because of the 099/late-colour collision noted above. The legend
gains an entry naming what the ring means, matching how the existing legend
already names the five-minute late threshold.

An "Express only" filter toggle reuses the same dimming expression as route
selection, so the two features share one mechanism rather than fighting for the
same paint properties.

### 4. Ride along

A "Follow" toggle on the bus card. While following:

- `animate()` re-centres the map on the followed bus each frame. It uses
  `map.setCenter`, not `easeTo`, because an eased camera fights a 60fps update.
- A `dragstart` listener cancels following, so the map never wrestles the user
  for control.
- Following ends when the bus leaves the field. `apply()` already closes the
  card for a bus `BusField` has given up on (`web/src/BusMap.tsx:524`); the
  follow flag clears on the same path.

No new data, no new network calls.

### 5. Bunching detector

`findBunches(buses, metres)` in `web/src/buses.ts`. Groups by `routeId`, then
compares pairwise within each group — cheap, because per-route groups are small
even at 1,500 buses.

Two corrections stop it crying wolf:

- Both buses must be `moving`. `RenderedBus` already carries this flag
  (`web/src/buses.ts:47`).
- Both must be heading the same way, compared on the bearing that feature 1
  makes available, within a tolerance.

Without these, every terminus and layover reads as bunching, which is not what
the word means to a rider.

Default threshold 200 m, named as a constant with a comment explaining the
value, matching the house style of `LATE_THRESHOLD_SECONDS` and
`STALE_FEED_SECONDS`. Bunched buses get a connecting line; the status bar gains
a count.

### 6. System pulse

Pure functions over the snapshot, in `web/src/routes.ts`:

- `busiestRoutes(vehicles, limit)` — most live buses running right now.
- `worstDelayedRoutes(vehicles, limit)` — worst mean delay right now, over
  routes with enough buses to be meaningful, so one late bus on an hourly
  suburban route cannot top the table.

Rendered in a panel toggled from the status bar, beside the existing About
button. Zero new network traffic.

## File plan

| file | change |
| ---- | ------ |
| `web/src/buses.ts` | add `markerIconFor`, icon size ramp, `findBunches` |
| `web/src/routes.ts` | new — `searchRoutes`, `isExpress`, `busiestRoutes`, `worstDelayedRoutes` |
| `web/src/routes.test.ts` | new |
| `web/src/buses.test.ts` | extend |
| `web/src/RouteSearch.tsx` | new component |
| `web/src/SystemPulse.tsx` | new component |
| `web/src/BusMap.tsx` | symbol layer, route line, dim expressions, follow camera |
| `web/src/App.tsx` | wire the new panels and selection state |
| `web/src/app.css` | styles for search, pulse panel, legend entry |

## Testing

Follows the repo's existing shape: `*.test.ts` beside the source, `vitest`, no
network and no live TransLink calls.

Because there is no DOM test harness, every piece of logic worth testing is
extracted into a plain `.ts` module before it is used by a component. This is
already the established pattern — `countdown` and `describeArrival` were moved
out of `App.tsx` into `buses.ts` for exactly this reason (commit 55713d5).

Coverage to add:

- `searchRoutes`: exact short-name match ranks first; leading-zero forms; long
  name match; empty query; no match.
- `isExpress`: R1–R6 true; 099 and 99 true; 991, 99A, R7, N9 false.
- `findBunches`: two buses within the threshold bunch; the same two beyond it do
  not; stationary buses at a terminus do not; opposite-direction buses do not;
  three buses form one group, not three pairs.
- `busiestRoutes` / `worstDelayedRoutes`: ordering, tie-breaks, the minimum-bus
  floor, and an empty snapshot.
- `markerIconFor`: the boundary at zoom 13 exactly.

**One repo defect to fix as part of this work:** `vitest.config.ts` includes
only `.test.ts`, so any `web/src/**/*.test.tsx` file is silently never
collected — it would appear to pass by never running. This work adds `.tsx`
components, so the include list must be corrected before a component test can be
trusted.

## Risks

- **Symbol layers are slower than circle layers.** Mitigated by disabling
  collision detection. If 1,500 rotating symbols still cost too much on a mid
  phone, the fallback is to keep circles below zoom 13 and add symbols only
  above it, where far fewer buses are on screen.
- **Feature interaction on paint properties.** Route selection, express
  filtering and bunching all want to alter bus appearance. They must compose
  through one expression built in a single place, not three `setPaintProperty`
  calls racing each other.
- **The 099 / late-colour collision** described above.

## Open questions

- ~~Does TransLink populate `Position.speed` or
  `VehiclePosition.congestion_level`?~~ **Answered 2026-09-06: no.** A probe of
  one live `gtfsposition` payload (579 vehicles) found `Position` carries only
  `latitude` and `longitude` — no `speed`, no `bearing`, no `odometer` — and
  `VehiclePosition` carries no `congestion_level` and no `occupancy_status`.
  `src/gtfs-rt.ts` is therefore not leaving anything on the table. The README
  should be extended: it currently records bearing and occupancy as unpopulated,
  and speed and congestion level belong in the same sentence.
- **Which Cloudflare plan is this Worker on?** Not answerable from
  `wrangler whoami`, and not inferable from Durable Object use, since
  SQLite-backed Durable Objects are available on the free plan. Only matters if
  replay is revived.

## Deferred work

**Replay the last hour.** Recorded so the analysis is not repeated:

- The Durable Object overwrites `vehicles` every tick (`src/live-feed.ts:127`),
  so no history exists.
- A single Durable Object storage value caps at 128 KB. One snapshot is roughly
  180 KB, so it cannot go in one key.
- KV is the wrong home. The app already spends 640 KV writes/day on the current
  snapshot; a second write per tick reaches 1,280/day, over the free plan's
  1,000/day.
- R2 is the right home: 640 writes/day is about 19K/month against a 1M/month
  free allowance for class-A operations, and the bucket is already bound.
- Frames must be reduced (id, lat, lon, route — roughly 40 bytes per bus) and
  **scoped to a route or the viewport**, not the whole fleet. An hour of the
  full system is several megabytes, which is not sendable to a phone.

## Related

- `README.md` — architecture and the reasoning behind the poll budget.
- `CLAUDE.md` — commands, conventions and hard constraints.
- TransLink filtering research, 2026-09-06: the v3 endpoints accept only
  `apikey`; the RTTI API that offered `routeNo` / `lat` / `long` / `radius`
  filtering was retired on 2024-12-03 and its host no longer resolves; the
  Terms of Use meter the key per **request**, with no byte or record clause, so
  a smaller response would not save quota.
