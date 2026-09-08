# AUTOPILOT.md — autobuild descriptor for vancouver-bus-map

## Goal

Refine the rider-facing UI. Two features come first, in this order:

1. **Countdown to the next stop.** A selected bus should say how long until it
   reaches the stop it is heading for — "arriving in 4 min", not just the stop's
   name. The enabling change is server-side: `LiveFeed.buildSnapshot()` already
   holds both the vehicle list and the trip-update predictions indexed by stop.
   Join them on `(tripId, stopId)` and put the predicted arrival and the delay
   on each `WireVehicle`. Do that once; both features below then read from it.

2. **Flag late buses on the map.** With a per-vehicle delay available, colour or
   mark buses running behind schedule so they stand out, and make it obvious
   which ones they are without tapping. Pick a threshold that means something to
   a rider (a bus 40 seconds down is not "late"), and say what the threshold is
   in the UI rather than leaving the colour unexplained.

After those, general UI refinement: clarity, legibility, and touch ergonomics on
a phone.

A live TransLink key is now configured. The poller sleeps 23:00–07:00 Pacific,
so between those hours the deployed app has vehicle data only from the last
evening poll. Never fabricate bus data to work around that — an empty map that
says so is correct, a map showing invented buses is not.

## Value ranking (what "highest-value" means here)

1. The two numbered features above, smallest useful slice first.
2. Fix a reproducible correctness bug. Write the failing test first.
3. Fix a mobile or accessibility defect at 320px, 390px or 430px, or a contrast
   pair below WCAG AA 4.5:1 in either theme — including text on a *filled*
   control, not just text on a surface.
4. Handle a failure mode that degrades badly: a dropped WebSocket, a missing R2
   artifact, a stop with no schedule, malformed protobuf.
5. Make the basemap provider swappable, with CARTO (`positron` /
   `dark-matter`) as a configured fallback to OpenFreeMap. Both are keyless and
   their light/dark styles already match this app's two themes. This matters
   because OpenFreeMap is a single free service with no SLA, and its style
   already shipped one source (`ne2_shaded`) that never finishes loading.
6. Reduce what a phone downloads, measured over the wire with Brotli.
7. Remove dead code or a duplicated helper.

Prefer a small, complete, verified change over a large one.

## Protected paths — NEVER modify

- `wrangler.jsonc` — KV and R2 binding IDs. A wrong value breaks every deploy
  and a local verify cannot catch it.
- `.github/workflows/**` — CI wiring. The loop's own safety gate depends on it.
- `src/config.ts` — the poll budget and the TransLink attribution string. The
  budget encodes a contractual 1,000 requests/day cap **per key**, and the
  attribution text is required verbatim by TransLink's Terms of Use. Both are
  human decisions.
- `AUTOPILOT.md` — this file.

## Constraints

- **Never call `gtfsapi.translink.ca` from a pass.** Every request there counts
  against a hard 1,000/day-per-key cap shared with the live site. Tests must use
  synthetic protobuf fixtures, which `src/gtfs-rt.test.ts` already builds. If a
  change cannot be verified without a live call, it cannot be verified — say so
  and pick something else.
- Do not raise the poll rate or widen the service window. Three keys are
  configured and the budget already spends 2,896 of the 3,000 they permit, so
  there is nothing left to raise it with. Adding a key does not change this:
  `pollSecondsFor()` derives the rate from the key count, so the cadence
  follows the secret without anyone editing a constant. A human decides how
  many keys exist; nothing in a pass may decide to spend them faster.
- **The prediction model may never issue a TransLink request.** It trains on
  bytes the poller already fetched for the map. There is deliberately no code
  path from training to the API, and `src/config.test.ts` asserts the budget
  contains only rider-facing feeds. Rider-facing accuracy always has first
  claim on every request; training is a passenger on data already paid for.
- Do not add a dependency unless it is the only reasonable option. The
  GTFS-Realtime decoder is deliberately hand-rolled to keep the Worker bundle
  small; do not replace it with protobufjs.
- Never present scheduled times as live, or live times as scheduled.
- Never show a stop as wheelchair accessible when `wheelchair_boarding` is 0.
  Unknown is not the same as accessible.
- Do not reduce any text contrast below 4.5:1 in either theme.
- Do not break layout at 320px. The map attribution must never be covered.
- One logical change per pass. Keep the diff reviewable.
- Deploys are manual. Landing on `main` is the end of a pass.

## Machine config (read by autobuild.sh — keep exact key = value format)

```autobuild
verify = npm run typecheck && npm test && npm run build
gate = pr
notify = gh issue create --title "{title}" --body "{body}"
branch_prefix = autobuild
email_to = ryanxu.dev@gmail.com
email_cmd =
```

<!--
gate = pr because CI runs on pull_request as well as push, so every landed
change carries a green run.

NOTE: autobuild.sh had a race that closed good PRs three seconds after opening
them — `gh pr checks` exits non-zero both for "failed" and for "none registered
yet". Fixed 2026-09-06 by waiting for a check to appear first. If PRs start
being discarded as "CI red" seconds after opening, that regression is back.

email_cmd is intentionally EMPTY. Both documented senders need a credential the
human must supply, so milestones arrive as GitHub issues, which GitHub emails on.
-->
