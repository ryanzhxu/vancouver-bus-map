import { useEffect, useState } from "react";
import type { SelectedStop } from "./BusMap.js";
import {
  arrivalsErrorText,
  countdown,
  describeDelay,
  isLate,
  type ArrivalsFailure,
} from "./buses.js";
import type { GtfsData } from "./gtfs.js";
import { searchStops } from "./stop-search.js";
import { useEscapeToClose } from "./useEscapeToClose.js";

interface LegWire {
  routeId: string;
  tripId: string;
  fromStopId: string;
  toStopId: string;
  departTime: number;
  departLive: boolean;
  departDelay: number | null;
  arriveTime: number;
  arriveLive: boolean;
  arriveDelay: number | null;
}

interface ItineraryWire {
  legs: LegWire[];
}

interface TripPlanResponse {
  itineraries: ItineraryWire[];
}

/** Which endpoint a map tap currently resolves to, or none. */
export type StopPickMode = "from" | "to" | null;

export function TripPlanCard({
  gtfs,
  from,
  to,
  pickMode,
  onSetFrom,
  onSetTo,
  onPickOnMap,
  onClose,
}: {
  gtfs: GtfsData | null;
  from: SelectedStop | null;
  to: SelectedStop | null;
  pickMode: StopPickMode;
  onSetFrom: (stop: SelectedStop | null) => void;
  onSetTo: (stop: SelectedStop | null) => void;
  onPickOnMap: (which: "from" | "to") => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);

  const [itineraries, setItineraries] = useState<ItineraryWire[] | null>(null);
  const [error, setError] = useState<ArrivalsFailure | null>(null);

  useEffect(() => {
    if (!from || !to) {
      setItineraries(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setItineraries(null);
    setError(null);

    const load = async () => {
      let response: Response;
      try {
        response = await fetch(
          `/api/trip-plan?from=${encodeURIComponent(from.id)}&to=${encodeURIComponent(to.id)}`,
        );
      } catch {
        if (!cancelled) setError("offline");
        return;
      }
      if (!response.ok) {
        if (!cancelled) setError("unavailable");
        return;
      }
      try {
        const body = (await response.json()) as TripPlanResponse;
        if (!cancelled) {
          setItineraries(body.itineraries);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("unavailable");
      }
    };

    void load();
    // Matches StopCard's cadence: predictions refresh every 3 minutes
    // upstream, halved so a shown time never quietly goes stale.
    const timer = setInterval(() => void load(), 90_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [from, to]);

  return (
    <div className="buscard tripplancard" role="dialog" aria-label="Plan a trip">
      <div className="buscard-head">
        <div className="buscard-title">
          <strong>Plan a trip</strong>
        </div>
        <button className="buscard-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      <StopPicker
        label="From"
        gtfs={gtfs}
        stop={from}
        picking={pickMode === "from"}
        onPick={onSetFrom}
        onPickOnMap={() => onPickOnMap("from")}
      />
      <StopPicker
        label="To"
        gtfs={gtfs}
        stop={to}
        picking={pickMode === "to"}
        onPick={onSetTo}
        onPickOnMap={() => onPickOnMap("to")}
      />

      {from && to && (
        <>
          {error && <p className="arrivals-empty">{arrivalsErrorText(error)}</p>}
          {!error && itineraries === null && <p className="arrivals-empty">Finding routes…</p>}
          {!error && itineraries !== null && itineraries.length === 0 && (
            <p className="arrivals-empty">No route found between these stops right now.</p>
          )}
          {itineraries && itineraries.length > 0 && (
            <ul className="itineraries">
              {itineraries.map((itinerary, i) => (
                <ItineraryRow key={i} itinerary={itinerary} gtfs={gtfs} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function StopPicker({
  label,
  gtfs,
  stop,
  picking,
  onPick,
  onPickOnMap,
}: {
  label: string;
  gtfs: GtfsData | null;
  stop: SelectedStop | null;
  picking: boolean;
  onPick: (stop: SelectedStop | null) => void;
  onPickOnMap: () => void;
}) {
  const [query, setQuery] = useState("");
  const [stopsReady, setStopsReady] = useState(false);

  useEffect(() => {
    if (!gtfs) return;
    void gtfs.ensureStops().then(() => setStopsReady(true));
  }, [gtfs]);

  if (stop) {
    return (
      <div className="tripplan-row">
        <span className="tripplan-label">{label}</span>
        <span className="tripplan-stop">{stop.name}</span>
        <button
          className="buscard-close"
          onClick={() => onPick(null)}
          aria-label={`Clear ${label.toLowerCase()} stop`}
        >
          &times;
        </button>
      </div>
    );
  }

  const results = stopsReady && gtfs && query.trim() ? searchStops(gtfs.stops, query) : [];

  return (
    <div className="tripplan-row tripplan-row-picking">
      <span className="tripplan-label">{label}</span>
      <div className="tripplan-picker-controls">
        <input
          type="text"
          inputMode="search"
          className="routesearch-input"
          placeholder="Search a stop…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className={picking ? "express-toggle on" : "express-toggle"} onClick={onPickOnMap}>
          {picking ? "Tap the map…" : "Pick on map"}
        </button>
      </div>
      {results.length > 0 && (
        <ul className="routesearch-results">
          {results.map((r) => (
            <li key={r.i}>
              <button
                onClick={() => {
                  onPick({ id: r.i, name: r.n, code: r.c, accessible: r.w });
                  setQuery("");
                }}
              >
                {r.n}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ItineraryRow({ itinerary, gtfs }: { itinerary: ItineraryWire; gtfs: GtfsData | null }) {
  const routeLabel = (routeId: string) => (gtfs ? gtfs.routeLabel(routeId) : routeId);
  const stopName = (stopId: string) => gtfs?.stopName(stopId) ?? stopId;
  const lastLeg = itinerary.legs.at(-1)!;

  return (
    <li className="itinerary">
      {itinerary.legs.map((leg, i) => (
        <div className="itinerary-leg" key={leg.tripId}>
          {i > 0 && <div className="itinerary-transfer">Transfer at {stopName(leg.fromStopId)}</div>}
          <div className="itinerary-step">
            <span className="arrival-route">{routeLabel(leg.routeId)}</span>
            <span className="itinerary-stop">
              {stopName(leg.fromStopId)} &middot; {countdown(leg.departTime)}
            </span>
            <span className={legKindClass(leg.departLive, leg.departDelay)}>
              {leg.departLive ? describeDelay(leg.departDelay) : "scheduled"}
            </span>
          </div>
        </div>
      ))}
      <div className="itinerary-arrive">
        Arrive {stopName(lastLeg.toStopId)} &middot; {countdown(lastLeg.arriveTime)}
      </div>
    </li>
  );
}

function legKindClass(live: boolean, delay: number | null): string {
  if (!live) return "arrival-kind sched";
  return isLate(delay) ? "arrival-kind live late" : "arrival-kind live";
}
