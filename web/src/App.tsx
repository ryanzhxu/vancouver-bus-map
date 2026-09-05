import { useEffect, useState } from "react";
import { BusMap, type FeedState, type SelectedBus } from "./BusMap.js";

const ATTRIBUTION =
  "Some of the data used in this product or service is provided by permission of " +
  "TransLink. TransLink assumes no responsibility for the accuracy or currency of " +
  "the Data used in this product or service.";

export function App() {
  const [feed, setFeed] = useState<FeedState>({ kind: "connecting" });
  const [showAbout, setShowAbout] = useState(false);
  const [bus, setBus] = useState<SelectedBus | null>(null);

  return (
    <div className="app">
      <BusMap onState={setFeed} onSelect={setBus} />

      {bus && <BusCard bus={bus} onClose={() => setBus(null)} />}

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
              <span className="wheelchair" title="Wheelchair accessible">
                {" "}
                &#9855;
              </span>
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

  if (feed.kind === "waiting") {
    return (
      <div className="status">
        <span className="dot warn" aria-hidden="true" />
        {feed.reason}
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
