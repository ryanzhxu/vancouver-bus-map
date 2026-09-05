import { useCallback, useEffect, useState, type ReactNode } from "react";

interface Health {
  ok: boolean;
  budget: {
    positions: number;
    tripUpdates: number;
    alerts: number;
    total: number;
    limit: number;
    headroom: number;
  };
  attribution: string;
}

interface Status {
  tick: number;
  requestsToday: number;
  requestDate: string | null;
  vehicles: number;
  feedTimestamp: number | null;
  inServiceWindow: boolean;
  vancouverHour: number;
  openSockets: number;
  hasApiKey: boolean;
  lastError: { at: number; message: string } | null;
  nextAlarm: number | null;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} responded ${response.status}`);
  return (await response.json()) as T;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [h, s] = await Promise.all([
        getJson<Health>("/api/health"),
        getJson<Status>("/api/live/status"),
      ]);
      setHealth(h);
      setStatus(s);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="wrap">
      <header>
        <h1>Vancouver Bus Map</h1>
        <p className="tagline">
          Every bus in Metro Vancouver, live. The map is still being built — this page
          reports what the backend is doing right now.
        </p>
      </header>

      {error && (
        <div className="card">
          <h2>Could not reach the API</h2>
          <p style={{ margin: 0, color: "var(--stop)" }}>{error}</p>
        </div>
      )}

      {status && <FeedCard status={status} />}
      {health && <BudgetCard budget={health.budget} />}

      <button className="refresh" onClick={() => void load()} disabled={loading}>
        {loading ? "Checking…" : "Refresh"}
      </button>

      <footer>
        <p>{health?.attribution ?? ""}</p>
        <p>
          Built with TransLink open data. Not affiliated with TransLink.{" "}
          <a href="https://github.com/ryanzhxu/vancouver-bus-map">Source</a>
        </p>
      </footer>
    </div>
  );
}

function FeedCard({ status }: { status: Status }) {
  const state = !status.hasApiKey
    ? { cls: "stop", label: "No API key" }
    : status.lastError
      ? { cls: "warn", label: "Degraded" }
      : status.inServiceWindow
        ? { cls: "ok", label: "Polling" }
        : { cls: "warn", label: "Asleep" };

  return (
    <section className="card">
      <h2>Live feed</h2>
      <dl className="rows">
        <Row label="Status">
          <span className={`pill ${state.cls}`}>{state.label}</span>
        </Row>
        <Row label="Buses tracked">{status.vehicles || "—"}</Row>
        <Row label="Feed time">{formatFeedTime(status.feedTimestamp)}</Row>
        <Row label="Poll ticks today">{status.tick}</Row>
        <Row label="Open connections">{status.openSockets}</Row>
        <Row label="Next poll">{formatRelative(status.nextAlarm)}</Row>
      </dl>
      {status.lastError && (
        <p style={{ marginTop: "0.75rem", color: "var(--warn)", fontSize: "0.85rem" }}>
          {status.lastError.message}
        </p>
      )}
    </section>
  );
}

function BudgetCard({ budget }: { budget: Health["budget"] }) {
  const pct = Math.min(100, (budget.total / budget.limit) * 100);

  return (
    <section className="card">
      <h2>Daily request budget</h2>
      <dl className="rows">
        <Row label="Vehicle positions">{budget.positions}</Row>
        <Row label="Trip updates">{budget.tripUpdates}</Row>
        <Row label="Service alerts">{budget.alerts}</Row>
        <Row label="Planned total">
          <strong>
            {budget.total} / {budget.limit}
          </strong>
        </Row>
      </dl>
      <div className="bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", color: "var(--ink-3)" }}>
        {budget.headroom} requests held back for retries. TransLink caps one key at{" "}
        {budget.limit} per day.
      </p>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function formatFeedTime(epochSeconds: number | null): string {
  if (!epochSeconds) return "—";
  return new Date(epochSeconds * 1000).toLocaleTimeString("en-CA", {
    timeZone: "America/Vancouver",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatRelative(epochMs: number | null): string {
  if (!epochMs) return "not scheduled";
  const seconds = Math.round((epochMs - Date.now()) / 1000);
  if (seconds <= 0) return "due now";
  if (seconds < 90) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in ${minutes} min`;
  return `in ${Math.round(minutes / 60)} h`;
}
