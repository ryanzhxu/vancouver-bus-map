import { describeDelay } from "./buses.js";
import type { RouteDelay, RouteTally } from "./routes.js";
import { useEscapeToClose } from "./useEscapeToClose.js";

/**
 * Two live leaderboards over the snapshot already on screen: where the fleet is,
 * and which routes are having a bad afternoon. No new data of any kind.
 */
export function SystemPulse({
  busiest,
  worst,
  colorFor,
  onSelectRoute,
  onClose,
}: {
  busiest: RouteTally[];
  worst: RouteDelay[];
  colorFor: (routeId: string) => string;
  onSelectRoute: (routeId: string) => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);

  return (
    <div className="pulse" role="dialog" aria-label="System pulse">
      <div className="pulse-head">
        <strong>Right now</strong>
        <button onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      <h3>Most buses running</h3>
      {busiest.length === 0 ? (
        <p className="pulse-empty">No live buses.</p>
      ) : (
        <ul className="pulse-list">
          {busiest.map((row) => (
            <li key={row.routeId}>
              <button onClick={() => onSelectRoute(row.routeId)}>
                <span className="route-badge" style={{ background: colorFor(row.routeId) }}>
                  {row.label}
                </span>
                <span className="pulse-value">{row.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Running latest</h3>
      {worst.length === 0 ? (
        <p className="pulse-empty">Every route is running to time.</p>
      ) : (
        <ul className="pulse-list">
          {worst.map((row) => (
            <li key={row.routeId}>
              <button onClick={() => onSelectRoute(row.routeId)}>
                <span className="route-badge" style={{ background: colorFor(row.routeId) }}>
                  {row.label}
                </span>
                <span className="pulse-value">{describeDelay(row.meanDelay)}</span>
                <span className="pulse-sub">{row.count} buses</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
