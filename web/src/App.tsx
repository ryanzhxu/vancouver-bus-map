import { useEffect, useState } from "react";
import { BusMap, type FeedState, type SelectedBus, type SelectedStop } from "./BusMap.js";
import {
  arrivalsErrorText,
  countdown,
  describeAge,
  describeArrival,
  describeDelay,
  hasDeparted,
  hintText,
  isFeedStale,
  isLate,
  type ArrivalsFailure,
} from "./buses.js";
import type { GtfsData } from "./gtfs.js";

/** Matches the stop layer's minzoom in BusMap. */
const STOP_MIN_ZOOM = 14;

interface Arrival {
  routeId: string;
  tripId: string;
  time: number;
  live: boolean;
  delay: number | null;
}

const ATTRIBUTION =
  "Some of the data used in this product or service is provided by permission of " +
  "TransLink. TransLink assumes no responsibility for the accuracy or currency of " +
  "the Data used in this product or service.";

export function App() {
  const [feed, setFeed] = useState<FeedState>({ kind: "connecting" });
  const [showAbout, setShowAbout] = useState(false);
  const [bus, setBus] = useState<SelectedBus | null>(null);
  const [stop, setStop] = useState<SelectedStop | null>(null);
  const [gtfs, setGtfs] = useState<GtfsData | null>(null);
  const [zoom, setZoom] = useState(11);

  return (
    <div className="app">
      <BusMap
        onState={setFeed}
        onSelect={setBus}
        onSelectStop={setStop}
        onReady={setGtfs}
        onZoom={setZoom}
      />

      {!bus && !stop && <Hint feed={feed} zoom={zoom} />}

      {bus && <BusCard bus={bus} onClose={() => setBus(null)} />}
      {stop && <StopCard stop={stop} gtfs={gtfs} onClose={() => setStop(null)} />}

      <div className="statusbar">
        <StatusPill feed={feed} />
        <button
          className="about-button"
          onClick={() => setShowAbout(true)}
          aria-label="About this map"
        >
          About
        </button>
      </div>

      {showAbout && <AboutSheet onClose={() => setShowAbout(false)} />}
    </div>
  );
}

/**
 * Dismiss an open card or sheet when the user presses Escape.
 *
 * Every card is a role="dialog", but the map behind it has no keyboard exit, so
 * without this a keyboard or switch user who opens the bus card or the stop card
 * can close it only by finding the small × button. The About sheet already
 * closed on Escape; this shares one handler so all three behave the same.
 */
function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

function BusCard({ bus, onClose }: { bus: SelectedBus; onClose: () => void }) {
  useEscapeToClose(onClose);

  // Re-render once a second so the countdown keeps ticking down while the card
  // is open, instead of freezing at the value it had when the bus was tapped.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="buscard" role="dialog" aria-label={`Route ${bus.routeLabel}`}>
      <div className="buscard-head">
        <span className="route-badge" style={{ background: bus.color }}>
          {bus.routeLabel}
        </span>
        <div className="buscard-title">
          <strong>{bus.headsign || bus.routeName || "In service"}</strong>
          {bus.routeName && bus.headsign && <span className="sub">{bus.routeName}</span>}
        </div>
        <button className="buscard-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      <dl className="buscard-rows">
        <div>
          <dt>Next stop</dt>
          <dd>
            {bus.nextStopName ?? "Unknown"}
            {bus.nextStopAccessible === 1 && (
              <span
                className="wheelchair"
                role="img"
                aria-label="Wheelchair accessible"
                title="Wheelchair accessible"
              >
                {" "}
                &#9855;
              </span>
            )}
            {bus.arrivalTime !== null && (
              <span className="arrival-eta">{describeArrival(bus.arrivalTime)}</span>
            )}
          </dd>
        </div>
        {bus.delay !== null && (
          <div>
            <dt>Schedule</dt>
            <dd>
              <span className={isLate(bus.delay) ? "delay late" : "delay"}>
                {describeDelay(bus.delay)}
              </span>
            </dd>
          </div>
        )}
        <div>
          <dt>Stop sequence</dt>
          <dd>{bus.stopSequence || "—"}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Tells the reader what they can actually do right now.
 *
 * Stops only draw from zoom 14, so at the opening view an empty map with no
 * buses gives no hint that anything is tappable.
 */
function Hint({ feed, zoom }: { feed: FeedState; zoom: number }) {
  const message = hintText(feed.kind, zoom >= STOP_MIN_ZOOM);
  if (!message) return null;

  return (
    <div className="hint" role="status">
      {message}
    </div>
  );
}

function StopCard({
  stop,
  gtfs,
  onClose,
}: {
  stop: SelectedStop;
  gtfs: GtfsData | null;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);

  const [arrivals, setArrivals] = useState<Arrival[] | null>(null);
  const [error, setError] = useState<ArrivalsFailure | null>(null);

  // Re-render once a second so every countdown in the list keeps counting down
  // between fetches. Each row's "3 min" is computed from the client clock at
  // render time, but this card only re-fetched every 90 seconds — so without a
  // tick a row read "3 min" while the bus was 90 seconds away, and a bus that
  // had already gone still read as coming. The bus card and the status bar
  // already tick for the same reason.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setArrivals(null);
    setError(null);

    const load = async () => {
      let response: Response;
      try {
        response = await fetch(`/api/stop/${encodeURIComponent(stop.id)}?limit=6`);
      } catch {
        // The fetch itself failed: the phone is offline or lost the connection.
        if (!cancelled) setError("offline");
        return;
      }
      if (!response.ok) {
        // The server answered but could not build the list — e.g. no GTFS build
        // is published yet (503). A rider needs guidance, not the status code.
        if (!cancelled) setError("unavailable");
        return;
      }
      try {
        const body = (await response.json()) as { arrivals: Arrival[] };
        // Clear any error a previous background refresh left set, or a
        // transient failure would keep the banner up and hide these arrivals.
        if (!cancelled) {
          setArrivals(body.arrivals);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("unavailable");
      }
    };

    void load();
    // Predictions refresh every 3 minutes upstream; halve that so the card
    // never shows a time that has quietly expired.
    const timer = setInterval(() => void load(), 90_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [stop.id]);

  // Drop rows the bus has already left by, re-checked on every one-second tick,
  // so a departure never lingers as "now" past the server's freshness window.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const visible = arrivals?.filter((arrival) => !hasDeparted(arrival.time, nowSeconds)) ?? null;

  return (
    <div className="buscard stopcard" role="dialog" aria-label={stop.name}>
      <div className="buscard-head">
        <div className="buscard-title">
          <strong>{stop.name}</strong>
          <span className="sub">
            {stop.code && `Stop ${stop.code}`}
            {stop.accessible === 1 && (
              <span
                className="wheelchair"
                role="img"
                aria-label="Wheelchair accessible"
                title="Wheelchair accessible"
              >
                {" "}
                &#9855;
              </span>
            )}
          </span>
        </div>
        <button className="buscard-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      {error && <p className="arrivals-empty">{arrivalsErrorText(error)}</p>}
      {!error && arrivals === null && <p className="arrivals-empty">Loading arrivals…</p>}
      {!error && visible !== null && visible.length === 0 && (
        <p className="arrivals-empty">Nothing scheduled from here right now.</p>
      )}

      {visible && visible.length > 0 && (
        <ul className="arrivals">
          {visible.map((arrival) => (
            <li key={arrival.tripId}>
              <span className="arrival-route">
                {gtfs ? gtfs.routeLabel(arrival.routeId) : arrival.routeId}
              </span>
              <span className="arrival-when">{countdown(arrival.time)}</span>
              <span
                className={`arrival-kind ${
                  arrival.live ? (isLate(arrival.delay) ? "live late" : "live") : "sched"
                }`}
              >
                {arrival.live ? describeDelay(arrival.delay) : "scheduled"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusPill({ feed }: { feed: FeedState }) {
  const [, setTick] = useState(0);
  // Re-render once a second so "12s ago" stays honest.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (feed.kind === "live") {
    // A green "live" dot next to "8 hr ago" would tell a rider the overnight
    // snapshot is current. Once the feed is stale the dot reads amber, matching
    // the age beside it.
    const stale = isFeedStale(feed.feedTime);
    return (
      <div className="status">
        <span className={`dot ${stale ? "warn" : "live"}`} aria-hidden="true" />
        <strong>{feed.buses}</strong> buses
        <span className="age">{describeAge(feed.feedTime)}</span>
        {feed.late > 0 && (
          <span className="late-note">
            <span className="dot late" aria-hidden="true" />
            <strong>{feed.late}</strong> {feed.late === 1 ? "bus" : "buses"} 5+ min late
          </span>
        )}
      </div>
    );
  }

  if (feed.kind === "schedules-only") {
    return (
      <div className="status">
        <span className="dot warn" aria-hidden="true" />
        Timetables only &middot; no live buses
      </div>
    );
  }

  if (feed.kind === "error") {
    return (
      <div className="status">
        <span className="dot stop" aria-hidden="true" />
        {feed.message}
      </div>
    );
  }

  return (
    <div className="status">
      <span className="dot warn" aria-hidden="true" />
      Connecting…
    </div>
  );
}

function AboutSheet({ onClose }: { onClose: () => void }) {
  useEscapeToClose(onClose);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="About this map"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <h2>Vancouver Bus Map</h2>
        <p>
          Every bus in Metro Vancouver, updated every 90 seconds. Between updates each
          bus glides along its real route, so the map moves the way traffic does.
        </p>
        <p className="note">
          Buses only. TransLink publishes no live positions for SkyTrain, SeaBus, or the
          West Coast Express, so they are not shown.
        </p>
        <p className="note">
          RapidBus (R1&ndash;R6) and the 99 B-Line are ringed in their own colour.
          They are TransLink's frequent express services, and the only bus routes
          the agency gives a colour of its own.
        </p>
        <p className="fine">{ATTRIBUTION}</p>
        <p className="fine">
          Not affiliated with TransLink.{" "}
          <a href="https://github.com/ryanzhxu/vancouver-bus-map">Source on GitHub</a>
        </p>
        <button className="sheet-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
