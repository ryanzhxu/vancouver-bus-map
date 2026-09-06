# AUTOPILOT.md — autobuild descriptor for vancouver-bus-map

## Goal

Make this a transit map a Vancouver rider would actually keep on their phone.
Improve correctness, test coverage, mobile experience, and accessibility without
changing the architecture or exceeding TransLink's request budget.

The live feed is currently unavailable: the `TRANSLINK_API_KEY` secret is not
set, so the deployed app runs as a timetable browser. Work on what can be
verified without it. Do not add fake or sample bus data to work around this —
an empty map that says so is correct; a map showing invented buses is not.

## Value ranking (what "highest-value" means here)

1. Fix a reproducible correctness bug. Write the failing test first.
2. Cover an untested path in the GTFS-Realtime decoder, the arrivals merge, or
   the service-day calendar logic. These three decide what riders are told.
3. Fix a mobile or accessibility defect at 320px, 390px, or 430px width, or a
   contrast pair below WCAG AA 4.5:1 in either theme.
4. Handle a failure mode that currently degrades badly: a dropped WebSocket, a
   missing R2 artifact, a stop with no schedule, a feed that returns malformed
   protobuf.
5. Reduce what a phone downloads, measured over the wire with Brotli, without
   removing a feature.
6. Remove dead code or a duplicated helper.

Prefer a small, complete, verified change over a large one.

## Protected paths — NEVER modify

- `wrangler.jsonc` — KV and R2 binding IDs. A wrong value breaks every deploy
  and cannot be caught by the local verify.
- `.github/workflows/**` — CI wiring. The loop's own safety gate depends on it.
- `src/config.ts` — the poll budget and the TransLink attribution string. The
  budget encodes a contractual 1,000 requests/day cap, and the attribution text
  is required verbatim by TransLink's Terms of Use. Both are human decisions.
- `AUTOPILOT.md` — this file.

## Constraints

- Do not add a dependency unless it is the only reasonable option. The
  GTFS-Realtime decoder is deliberately hand-rolled to keep the Worker bundle
  small; do not replace it with protobufjs.
- Never present scheduled times as live, or live times as scheduled. The
  distinction is the product's honesty and is covered by tests.
- Never show a stop as wheelchair accessible when `wheelchair_boarding` is 0.
  Unknown is not the same as accessible.
- Do not reduce any text contrast below 4.5:1 in either theme.
- Do not break layout at 320px width. The attribution must never be covered.
- One logical change per pass. Keep the diff reviewable.
- Deploys are manual (`npm run deploy` needs Cloudflare credentials). Do not
  attempt to deploy; landing on `main` is the end of a pass.
- If a change needs a decision only a human should make, skip it and say why in
  the progress ledger.

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
gate = pr because CI runs on pull_request as well as push. main is currently
unprotected, so a direct push would also work, but PR mode means every landed
change has a green CI run attached to it.

email_cmd is intentionally EMPTY. This Mac has no configured mail relay, and
the two documented senders both need a credential (a Resend API key or a Gmail
App Password) that the human must supply themselves. Milestones therefore
arrive as GitHub issues via `notify`, which GitHub emails on.
-->
