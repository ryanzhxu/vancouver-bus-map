/**
 * Pure helpers for the GTFS build. Kept separate from build-gtfs.ts so tests can
 * import them without the script's side effects or Node-only imports running.
 */

/**
 * Parse one CSV line. GTFS permits quoted fields containing commas — both
 * `trip_headsign` and `stop_name` use them — so a naive split corrupts rows.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }

  out.push(field);
  return out;
}

/**
 * GTFS times may exceed 24 hours: "25:14:00" means 01:14 the following day and
 * belongs to the previous service day. Returning raw seconds keeps that intact.
 */
export function toSeconds(hms: string): number | null {
  const parts = hms.split(":");
  if (parts.length !== 3) return null;

  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = Number(parts[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
  if (h < 0 || m < 0 || m > 59 || s < 0 || s > 59) return null;

  return h * 3600 + m * 60 + s;
}

export type LatLon = [number, number];

/**
 * Douglas-Peucker line simplification.
 *
 * Iterative rather than recursive: TransLink's longest shape is 1,812 points,
 * and a degenerate recursion on that depth risks the stack.
 */
export function simplify(line: LatLon[], tolerance: number): LatLon[] {
  if (line.length <= 2) return line.slice();

  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, line.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let index = -1;

    for (let i = first + 1; i < last; i++) {
      const dist = perpendicularDistance(line[i]!, line[first]!, line[last]!);
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }

    if (index !== -1 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  return line.filter((_, i) => keep[i] === 1);
}

/** Distance from point `p` to the segment `a`-`b`, in coordinate units. */
export function perpendicularDistance(p: LatLon, a: LatLon, b: LatLon): number {
  const dy = b[0] - a[0];
  const dx = b[1] - a[1];

  if (dy === 0 && dx === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);

  const t = ((p[0] - a[0]) * dy + (p[1] - a[1]) * dx) / (dy * dy + dx * dx);
  const clamped = Math.max(0, Math.min(1, t));

  return Math.hypot(p[0] - (a[0] + clamped * dy), p[1] - (a[1] + clamped * dx));
}

export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
