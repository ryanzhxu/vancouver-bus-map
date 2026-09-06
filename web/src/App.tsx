import { useEffect, useState } from "react";
import { BusMap, type FeedState, type SelectedBus, type SelectedStop } from "./BusMap.js";
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

function BusCard({ bus, onClose }: { bus: SelectedBus; onClose: () => void }) {
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
        <div>
          <dt>Stop number</dt>
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
  const stopsVisible = zoom >= STOP_MIN_ZOOM;
  const noBuses = feed.kind !== "live";

  if (!noBuses && stopsVisible) return null;
  if (feed.kind === "error") return null;

  const message = !stopsVisible
    ? "Zoom in to see stops and departure times"
    : "Live buses are unavailable right now. Tap any stop for its timetable.";

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
  const [arrivals, setArrivals] = useState<Arrival[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setArrivals(null);
    setError(null);

    const load = async () => {
      try {
        const response = await fetch(`/api/stop/${encodeURIComponent(stop.id)}?limit=6`);
        if (!response.ok) throw new Error(`responded ${response.status}`);
        const body = (await response.json()) as { arrivals: Arrival[] };
        if (!cancelled) setArrivals(body.arrivals);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "could not load");
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

      {error && <p className="arrivals-empty">{error}</p>}
      {!error && arrivals === null && <p className="arrivals-empty">Loading arrivals…</p>}
      {!error && arrivals?.length === 0 && (
        <p className="arrivals-empty">Nothing scheduled from here right now.</p>
      )}

      {arrivals && arrivals.length > 0 && (
        <ul className="arrivals">
          {arrivals.map((arrival) => (
            <li key={arrival.tripId}>
              <span
                className="arrival-route"
                style={gtfs ? { color: gtfs.routeColor(arrival.routeId) } : undefined}
              >
                {gtfs ? gtfs.routeLabel(arrival.routeId) : arrival.routeId}
              </span>
              <span className="arrival-when">{countdown(arrival.time)}</span>
              <span className={`arrival-kind ${arrival.live ? "live" : "sched"}`}>
                {arrival.live ? describeDelay(arrival.delay) : "scheduled"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function countdown(epochSeconds: number): string {
  const seconds = epochSeconds - Math.floor(Date.now() / 1000);
  if (seconds < 30) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return new Date(epochSeconds * 1000).toLocaleTimeString("en-CA", {
    timeZone: "America/Vancouver",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Live prediction for a selected bus, e.g. "arriving in 4 min". */
function describeArrival(epochSeconds: number): string {
  const when = countdown(epochSeconds);
  if (when === "now") return "arriving now";
  if (when.endsWith("min")) return `arriving in ${when}`;
  return `arriving at ${when}`;
}

function describeDelay(delay: number | null): string {
  if (delay === null) return "live";
  const minutes = Math.round(delay / 60);
  if (minutes <= -1) return `${Math.abs(minutes)} min early`;
  if (minutes >= 1) return `${minutes} min late`;
  return "on time";
}

function StatusPill({ feed }: { feed: FeedState }) {
  const [, setTick] = useState(0);
  // Re-render once a second so "12s ago" stays honest.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (feed.kind === "live") {
    return (
      <div className="status">
        <span className="dot live" aria-hidden="true" />
        <strong>{feed.buses}</strong> buses
        <span className="age">{describeAge(feed.feedTime)}</span>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

function describeAge(feedTime: number | null): string {
  if (!feedTime) return "";
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - feedTime));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min ago`;
}
