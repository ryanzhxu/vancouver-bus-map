# CLAUDE.md

`README.md` explains the architecture and *why* it is shaped that way — read it
first; this file does not repeat it. `AUTOPILOT.md` holds the autobuild
descriptor, the protected paths and the product constraints, and is
authoritative where the two overlap.

## Commands

Two npm projects. The root is the Cloudflare Worker, `web/` is the browser app,
and each has its own `node_modules` and `package-lock.json`.

```sh
npm install && npm --prefix web install   # both, or nothing typechecks

npm test                  # vitest run — 12 files, 179 tests, ~0.3s
npm run test:watch
npm run typecheck         # worker tsc --noEmit, then web tsc -b --force
npm run check             # typecheck && test
npm run build             # web only: tsc -b && vite build -> web/dist

npm run dev               # wrangler dev on :8787 (serves web/dist as assets)
npm --prefix web run dev  # vite on :5173, proxies /api and /ws to :8787

npm run deploy            # build, then wrangler deploy
npm run build:gtfs -- --schedules --push   # rebuild static data into R2
```

For UI work run both dev servers and use :5173. `wrangler dev` serves the
built `web/dist`, so on its own it shows the last `npm run build`.

`npm run build:gtfs` with no flags builds into `./tmp-gtfs/out` and uploads
nothing. `--schedules` adds the 3.7M-row stop_times pass, `--push` uploads.

Verification gate used by CI and autobuild:
`npm run typecheck && npm test && npm run build`.

## Architecture in short

- `src/` is the Worker (Node/workerd, no DOM). `web/src/` is the React client
  (DOM, no Worker types). They are separate tsconfig projects and **cannot
  import from each other** — shared shapes are duplicated by hand.
- `src/index.ts` routes: `/api/health`, `/api/gtfs/manifest`, `/gtfs/*`,
  `/api/stop/*`, `/api/live/*`, `/ws`, else static assets.
- One Durable Object, `LiveFeed` (name `metro-vancouver`), owns every TransLink
  request. Its clock is a self-rescheduling **alarm**, not a Cron Trigger.
- Clients get snapshots over a hibernatable WebSocket, or read the KV mirror
  (`live:snapshot`, 600s TTL) via `/api/live/snapshot`.
- Static GTFS lives in R2 (`vbm-gtfs`) under `v/{version}/...`, served at the
  public path `/gtfs/{version}/...` as immutable. KV key `gtfs_current` is the
  live-version pointer; `scripts/build-gtfs.ts` moves it only after every
  object uploads.
- `src/gtfs-rt.ts` is a hand-rolled GTFS-Realtime protobuf decoder. It exists
  to keep the Worker bundle small. Do not replace it with a library.

## Hard constraints

- **1,000 TransLink requests/day, all feeds, one key.** `src/config.ts` spends
  976 and `src/config.test.ts` fails the build above the cap or below 20
  requests of headroom. Do not raise `POLL_SECONDS` frequency, lower
  `TRIP_UPDATE_EVERY`/`ALERTS_EVERY`, or widen the window.
- **Service window is 07:00–23:00 Pacific** (`SERVICE_START_HOUR` /
  `SERVICE_END_HOUR`). Outside it the alarm sleeps. The deployed app therefore
  shows the last evening poll overnight — that is correct, never fake buses.
- **Never call `gtfsapi.translink.ca` from a test or a dev loop.** Those
  requests come out of the live site's budget. Use synthetic protobuf fixtures;
  `src/gtfs-rt.test.ts` already builds them.
- **The TransLink attribution string is mandated verbatim** by their Terms of
  Use and must stay visible wherever data is shown. It is declared twice —
  `TRANSLINK_ATTRIBUTION` in `src/config.ts` and `ATTRIBUTION` in
  `web/src/App.tsx` — because the two projects cannot share a module. Change
  both or neither.
- `src/config.ts`, `wrangler.jsonc`, `.github/workflows/**` and `AUTOPILOT.md`
  are protected paths. Do not edit them.
- Never present scheduled times as live or live times as scheduled. Never show
  a stop as accessible when `wheelchair_boarding` is 0.

## Conventions

- ESM everywhere (`"type": "module"`). Relative imports carry a **`.js`
  suffix** even for `.ts` and `.tsx` sources: `from "./config.js"`,
  `from "./App.js"`. Follow this — it is consistent in all 30-odd files.
- Strict TS plus `noUncheckedIndexedAccess`, `noUnusedLocals`,
  `noUnusedParameters`. Indexed reads come back possibly-undefined; the code
  handles that with `??`, `?.` and `!` at proven-safe sites.
- Tests sit beside their source as `name.test.ts`. Vitest only collects
  `src/**/*.test.ts`, `scripts/**/*.test.ts` and `web/src/**/*.test.ts` — a
  `.test.tsx` file is silently not run.
- **There is no DOM harness.** Node is the only environment. To test UI logic,
  move the pure function out of the component into a plain module first
  (`web/src/buses.ts` is where `countdown`, `isLate`, `describeAge` and friends
  ended up for exactly this reason). `web/src/layout.test.ts` shows the other
  trick: assert CSS geometry by parsing `app.css` and MapLibre's stylesheet.
- Comment style is the distinctive thing here. A constant or module gets a
  block comment that says **why the value is what it is**, usually with the
  arithmetic or the failure it prevents — see `src/config.ts`,
  `src/types.ts` (single-letter wire keys), `--remote` in
  `scripts/build-gtfs.ts`. Match that; do not write comments that restate code.
- Wire payloads use single-letter keys (`i r t y x s p h d a l`) because the
  vehicle array carries ~900 entries per tick; each is documented in place.
- Test names read as sentences about behaviour ("stays under TransLink's 1,000
  request per day cap"), not as function names.
- Double quotes, semicolons, ~100 columns. No linter or formatter is
  configured; match the surrounding file.

## Easy to get wrong

- Root `npm test` does cover `web/src/**/*.test.ts`, but web *types* are only
  checked by `npm run typecheck` or `npm run build`.
- Forgetting `npm --prefix web install`. A missing `web/node_modules` breaks
  typecheck, build, and `layout.test.ts` (it reads MapLibre's CSS from there).
- `WireVehicle` exists in both `src/types.ts` and `web/src/buses.ts`. They must
  agree; nothing enforces it.
- `wrangler r2 object put` without `--remote` writes to the local simulated
  bucket in `.wrangler/state` and reports success while production sees
  nothing.
- Local `wrangler dev` has no `TRANSLINK_API_KEY` unless you put one in
  `.dev.vars` (gitignored). Without it the app is a timetable browser — that is
  a supported state, not a bug.
- `.autobuild/` is ignored through `.git/info/exclude`, not `.gitignore`, so it
  is invisible locally but not ignored for anyone else who clones.
- Deploys are manual. CI (`.github/workflows/ci.yml`) runs install, worker
  typecheck, tests, web build and a `wrangler deploy --dry-run` on pushes to
  `main` and on every PR. Landing on `main` is the end of a change.
