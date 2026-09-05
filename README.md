# Vancouver Bus Map

A live map of every bus in Metro Vancouver, built on TransLink open data and
running entirely on Cloudflare.

## Why this is shaped the way it is

TransLink's Open API allows **1,000 requests per day per key, across all feeds**.
That single number decides the architecture:

- No client ever calls TransLink. One Durable Object owns every request.
- Cron Triggers floor at one minute and cannot express a 90-second cadence, so
  the poller is a Durable Object **alarm**, which takes a millisecond timestamp.
- Polling runs 07:00-23:00 Pacific only. Outside that window the alarm sleeps
  until morning.

At 90 seconds, over a 16-hour day:

| feed              | cadence      | requests |
| ----------------- | ------------ | -------- |
| vehicle positions | every tick   | 640      |
| trip updates      | every 2nd    | 320      |
| service alerts    | every 40th   | 16       |
| **total**         |              | **976**  |

The remaining 24 requests are deliberate headroom — a failed request still
counts against the cap. `src/config.test.ts` fails the build if a change pushes
the total over the limit.

## What the feeds actually contain

Verified against live payloads, not documentation:

- **Vehicle positions and trip updates are bus only.** There is no live SkyTrain,
  SeaBus, or West Coast Express tracking in the public API. Rail appears in the
  alerts feed and nowhere else.
- Positions carry `stop_id`, `current_stop_sequence`, and status, so "next stop"
  needs no extra call.
- **No bearing and no occupancy** are populated. Heading must be derived from
  consecutive positions.
- A handful of buses report position exactly `(0, 0)` when they lose GPS. The
  decoder drops them; left in, they render off West Africa.

## Layout

```
src/
  config.ts      poll budget, service window — the numbers that matter
  gtfs-rt.ts     dependency-free GTFS-Realtime decoder
  live-feed.ts   the Durable Object that owns all polling
  index.ts       Worker routes
web/             Vite + React + MapLibre client
scripts/         weekly static GTFS build into R2
```

## Develop

```sh
npm install
npm --prefix web install

npm test           # decoder and budget tests
npm run typecheck
npm run dev        # wrangler dev on :8787
npm --prefix web run dev   # Vite on :5173, proxies /api to wrangler
```

## Deploy

```sh
npx wrangler secret put TRANSLINK_API_KEY   # get a key at developer.translink.ca
npm run deploy
```

## Attribution

Some of the data used in this product or service is provided by permission of
TransLink. TransLink assumes no responsibility for the accuracy or currency of
the Data used in this product or service.

Not affiliated with or endorsed by TransLink.

## Licence

MIT
