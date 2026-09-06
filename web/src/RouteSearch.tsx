import { useEffect, useRef, useState } from "react";
import { DEFAULT_ROUTE_COLOR, type GtfsData } from "./gtfs.js";
import { isExpress, searchRoutes, type RouteMatch } from "./routes.js";

/**
 * The route picker. Holds only its own query text; the chosen route is owned by
 * App, because the map and the pulse panel both need it.
 */
export function RouteSearch({
  gtfs,
  selected,
  liveCount,
  expressOnly,
  onSelect,
  onToggleExpress,
}: {
  gtfs: GtfsData | null;
  selected: RouteMatch | null;
  liveCount: number;
  expressOnly: boolean;
  onSelect: (route: RouteMatch | null) => void;
  onToggleExpress: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" focuses the search, the convention every map and code host shares.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === inputRef.current) {
        setQuery("");
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const matches = gtfs ? searchRoutes(gtfs.routes, query) : [];

  const choose = (match: RouteMatch) => {
    onSelect(match);
    setQuery("");
  };

  return (
    <div className="routesearch">
      <div className="routesearch-controls">
        <input
          ref={inputRef}
          className="routesearch-input"
          type="search"
          value={query}
          placeholder="Search a route, e.g. 99 or Granville"
          aria-label="Search for a route"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className={expressOnly ? "express-toggle on" : "express-toggle"}
          onClick={onToggleExpress}
          aria-pressed={expressOnly}
        >
          Express
        </button>
      </div>

      {matches.length > 0 && (
        <ul className="routesearch-results">
          {matches.map((match) => (
            <li key={match.routeId}>
              <button onClick={() => choose(match)}>
                <span
                  className={isExpress(match.label) ? "route-badge express" : "route-badge"}
                  style={{ background: gtfs?.routeColor(match.routeId) ?? DEFAULT_ROUTE_COLOR }}
                >
                  {match.label}
                </span>
                <span className="routesearch-name">{match.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="routesearch-selected" role="status">
          <span
            className="route-badge"
            style={{ background: gtfs?.routeColor(selected.routeId) ?? DEFAULT_ROUTE_COLOR }}
          >
            {selected.label}
          </span>
          <span className="routesearch-name">{selected.name}</span>
          <span className="routesearch-count">
            {liveCount} {liveCount === 1 ? "bus" : "buses"} running
          </span>
          <button onClick={() => onSelect(null)} aria-label="Clear route filter">
            &times;
          </button>
        </div>
      )}
    </div>
  );
}
