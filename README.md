# Vancouver Bus Map

A live map of every bus in Metro Vancouver, plus the timetable for any stop,
running entirely on Cloudflare.

**Live:** https://vancouver-bus-map.rxlab.workers.dev

Buses glide along their real route geometry between updates, rather than
teleporting every 90 seconds. Tap a bus for its destination and next stop; tap a
stop for the next departures, with live predictions layered over the timetable
and clearly marked as one or the other.

## Why it is shaped this way

TransLink's Open API allows **1,000 requests per day per key, across all feeds**.
That single number decides the architecture:

- No client ever calls TransLink. One Durable Object owns every request.
- Cron Triggers floor at one minute and cannot express a 90-second cadence, so
  the poller is a Durable Object **alarm**, which takes a millisecond timestamp.
- Polling runs 07:00–23:00 Pacific only. Outside that window the alarm sleeps
  until morning.

At 90 seconds over a 16-hour day:

| feed              | cadence    | requests |
| ----------------- | ---------- | -------- |
| vehicle positions | every tick | 640      |
| trip updates      | every 2nd  | 320      |
| service alerts    | every 40th | 16       |
| **total**         |            | **976**  |

The remaining 24 requests are deliberate headroom — a failed request still
counts against the cap. `src/config.test.ts` fails the build if a change pushes
the total over the limit.

## What the feeds actually contain

Verified against live payloads, not documentation:

- **Vehicle positions and trip updates are bus only.** There is no live
  SkyTrain, SeaBus, or West Coast Express tracking in the public API. Rail
  appears in the alerts feed and nowhere else. SkyTrain timetables do work,
  because those come from the static feed.
- Positions carry `stop_id`, `current_stop_sequence`, and status, so "next stop"
  needs no extra call.
- **Position is all you get.** No bearing, no speed, no odometer, no occupancy
  and no congestion level are populated on any vehicle — verified against a
  live payload of 579 vehicles, not assumed. `current_status` is the exception:
  every vehicle in that sample carried one, and it is decoded into
  `Vehicle.status` (`src/gtfs-rt.ts`), though the wire format sent to the
  browser does not carry it. Treat it as the one field that does come through,
  not as guaranteed — GTFS-Realtime declares it `[default = IN_TRANSIT_TO]`, so
  a vehicle in that state may legitimately omit it. Heading is derived from the
  route geometry.
- Trip updates reach roughly **20 stops ahead** of each bus, so a stop further
  down a line has no live prediction even while the route runs normally.
- A handful of buses report position exactly `(0, 0)` when they lose GPS. The
  decoder drops them; left in, they render off West Africa.

## Static data

No database. Every query the app makes is "everything for one stop" or "the
geometry for one route", which is object storage, not SQL. A weekly job turns
the 39 MB GTFS zip into immutable R2 artifacts:

| artifact             | contents                                     |
| -------------------- | -------------------------------------------- |
| `routes.json`        | 245 routes                                   |
| `stops.json`         | 8,945 stops, 7,507 wheelchair accessible     |
| `trips.json`         | 128,393 trips — read by the DO, not by phones |
| `shapes/{route}.json`| 2,106 shapes in 245 per-route bundles        |
| `sched/{stop}.json`  | 3.7M stop_times as 8,758 per-stop objects    |
| `calendar.json`      | service patterns and exceptions              |

Douglas-Peucker at ~5 m takes 441,805 shape points to 104,255 — a 76% cut.

URLs are versioned (`/gtfs/{version}/...`) and immutable, so they cache for a
year. A rebuild publishes a new version and moves a KV pointer; nothing is ever
purged. **The pointer only moves after every object lands**, so a partial upload
cannot become the live version.

## Payload, measured over the wire

| asset                | Brotli |
| -------------------- | ------ |
| JS bundle (MapLibre) | 351 KB |
| `stops.json`         | 202 KB — loaded after first paint |
| `routes.json`        | 3.7 KB |
| entire Expo Line     | 3.2 KB |
| one stop's arrivals  | 199 B  |

Critical path is manifest plus routes, about 270 ms.

## Layout

```
src/
  config.ts            poll budget and service window — the numbers that matter
  types.ts             Env bindings and wire shapes: WireVehicle, Snapshot, StopPrediction
  gtfs-rt.ts           dependency-free GTFS-Realtime decoder
  wire.ts              join live predictions onto a vehicle, trimmed to WireVehicle
  live-feed.ts         the Durable Object that owns all polling
  service-day.ts       GTFS calendars, past-midnight times, DST
  arrivals.ts          merge live predictions with the timetable
  gtfs-assets.ts       serve R2 artifacts
  stop-api.ts          GET /api/stop/{id}
  index.ts             Worker routes
web/src/
  App.tsx              the shell: shared state, status bar, and the dialog cards
  BusMap.tsx           MapLibre, layers, interaction
  basemap.ts           keyless vector basemap providers, with a CARTO fallback
  geo.ts               polyline projection and interpolation
  buses.ts             per-vehicle glide state
  icons.ts             bus marker icons, pre-rendered once per colour
  gtfs.ts              static data loading
  routes.ts            express, search match, and fleet distribution per route
  RouteSearch.tsx      the route picker
  SystemPulse.tsx      two live leaderboards over the current snapshot
  useEscapeToClose.ts  Escape-to-close handler shared by every dialog card
scripts/
  build-gtfs.ts        weekly static build into R2
  gtfs-util.ts         pure GTFS/CSV helpers, tested apart from the build script
```

## Develop

```sh
npm install && npm --prefix web install

npm test           # 228 tests
npm run typecheck
npm run dev              # wrangler on :8787
npm --prefix web run dev # Vite on :5173, proxies /api

npm run build:gtfs -- --schedules --push   # rebuild static data
```

## Deploy

```sh
npx wrangler secret put TRANSLINK_API_KEY   # key from developer.translink.ca
npm run deploy
```

Without the secret the map still works as a timetable browser; only live buses
and predictions are missing. CI runs typecheck, tests, and a deploy dry-run on
every push. Deploys are manual — wiring CI to deploy needs a Cloudflare API
token in repository secrets.

## Attribution

Some of the data used in this product or service is provided by permission of
TransLink. TransLink assumes no responsibility for the accuracy or currency of
the Data used in this product or service.

Not affiliated with or endorsed by TransLink. Basemap © OpenFreeMap or, as a
keyless fallback when OpenFreeMap is unreachable, © CARTO — both © OpenMapTiles,
data from OpenStreetMap. The on-map attribution names whichever is in use.

## Licence

MIT
