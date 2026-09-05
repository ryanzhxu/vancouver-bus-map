/**
 * Turn TransLink's static GTFS into the artifacts the app actually reads.
 *
 * The source zip is 39MB, 208MB open, and stop_times.txt alone is 169MB with
 * 3.7M rows. None of that belongs in a request path, and none of it needs a
 * database: every query the app makes is "everything for one stop" or "the
 * geometry for one route". So we precompute per-stop and per-route objects and
 * put them in R2, where they are immutable and edge-cacheable.
 *
 *   npm run build:gtfs           # build into ./tmp-gtfs/out
 *   npm run build:gtfs -- --push # ...and upload to R2
 */

import { execFile as execFileCb, execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { promisify } from "node:util";

import { parseCsvLine, round6, simplify, toSeconds, type LatLon } from "./gtfs-util.js";

const execFile = promisify(execFileCb);

const GTFS_URL = "https://gtfs-static.translink.ca/gtfs/google_transit.zip";
const WORK = "tmp-gtfs";
const RAW = join(WORK, "raw");
const OUT = join(WORK, "out");
const BUCKET = "vbm-gtfs";
const KV_NAMESPACE_ID = "fa053deab4984aaebd962d7cee979d6a";
const WRANGLER = "node_modules/.bin/wrangler";

/** Douglas-Peucker tolerance in degrees. ~5m at Vancouver's latitude. */
const SIMPLIFY_TOLERANCE = 0.00005;

async function main(): Promise<void> {
  const push = process.argv.includes("--push");
  // stop_times.txt is 3.7M rows and produces 8,945 objects. Only the stop
  // arrivals feature needs it, so it stays behind a flag until then.
  const withSchedules = process.argv.includes("--schedules");
  const version = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  await mkdir(RAW, { recursive: true });
  await mkdir(OUT, { recursive: true });

  await download();
  unzip();

  const routes = await buildRoutes();
  const stops = await buildStops();
  const { trips, shapeIdsByRoute } = await buildTrips();
  const shapeStats = await buildShapes(shapeIdsByRoute);
  await buildCalendar();
  if (withSchedules) await buildSchedules(stops);
  else console.log("  schedules: skipped (pass --schedules)");

  await writeJson("manifest.json", {
    version,
    builtAt: new Date().toISOString(),
    source: GTFS_URL,
    counts: {
      routes: routes,
      stops: stops.size,
      trips: trips,
      shapes: shapeStats.shapes,
      shapePointsBefore: shapeStats.before,
      shapePointsAfter: shapeStats.after,
    },
  });

  console.log(`\nBuilt version ${version} into ${OUT}`);
  if (push) await uploadToR2(version);
  else console.log("Re-run with --push to upload to R2.");
}

/* ------------------------------------------------------------------ */
/* Source                                                              */
/* ------------------------------------------------------------------ */

async function download(): Promise<void> {
  const zip = join(WORK, "google_transit.zip");
  try {
    const existing = await readFile(zip);
    console.log(`Using cached zip (${mb(existing.byteLength)})`);
    return;
  } catch {
    // not cached
  }

  console.log(`Downloading ${GTFS_URL} ...`);
  const response = await fetch(GTFS_URL);
  if (!response.ok) throw new Error(`GTFS download failed: ${response.status}`);
  const buf = Buffer.from(await response.arrayBuffer());
  await writeFile(zip, buf);
  console.log(`  ${mb(buf.byteLength)}`);
}

function unzip(): void {
  console.log("Unzipping ...");
  execFileSync("unzip", ["-o", "-q", join(WORK, "google_transit.zip"), "-d", RAW]);
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Stream a GTFS CSV row by row. GTFS permits quoted fields containing commas
 * (trip_headsign and stop_name both do), so this is a real parser, not a split.
 */
async function* rows(file: string): AsyncGenerator<Record<string, string>> {
  const stream = createReadStream(join(RAW, file), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let header: string[] | null = null;
  for await (const line of lines) {
    if (line === "") continue;
    const fields = parseCsvLine(line);
    if (!header) {
      // Strip a UTF-8 BOM if the file carries one.
      if (fields[0]) fields[0] = fields[0].replace(/^﻿/, "");
      header = fields;
      continue;
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) row[header[i]!] = fields[i] ?? "";
    yield row;
  }
}


/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

async function buildRoutes(): Promise<number> {
  const routes: Record<string, unknown> = {};
  for await (const r of rows("routes.txt")) {
    routes[r["route_id"]!] = {
      s: r["route_short_name"] || "",
      n: r["route_long_name"] || "",
      t: Number(r["route_type"] ?? 3),
      c: r["route_color"] || null,
      x: r["route_text_color"] || null,
    };
  }
  await writeJson("routes.json", routes);
  return Object.keys(routes).length;
}

async function buildStops(): Promise<Map<string, { lat: number; lon: number }>> {
  const list: unknown[] = [];
  const index = new Map<string, { lat: number; lon: number }>();

  for await (const s of rows("stops.txt")) {
    const lat = Number(s["stop_lat"]);
    const lon = Number(s["stop_lon"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const id = s["stop_id"]!;
    index.set(id, { lat, lon });
    list.push({
      i: id,
      c: s["stop_code"] || "",
      n: s["stop_name"] || "",
      y: round6(lat),
      x: round6(lon),
      // 1 = accessible, 2 = not. 0/blank means unknown, which is not the same
      // thing and must not be shown as accessible.
      w: Number(s["wheelchair_boarding"] || 0),
      // 0 stop, 1 station, 2 entrance
      l: Number(s["location_type"] || 0),
    });
  }

  await writeJson("stops.json", list);
  return index;
}

async function buildTrips(): Promise<{ trips: number; shapeIdsByRoute: Map<string, Set<string>> }> {
  // trip_id -> [routeId, shapeId, headsign, directionId]
  // The Durable Object loads this to enrich each vehicle with its shape, so the
  // client never downloads a 128k-entry index.
  const trips: Record<string, [string, string, string, number]> = {};
  const shapeIdsByRoute = new Map<string, Set<string>>();
  let count = 0;

  for await (const t of rows("trips.txt")) {
    const routeId = t["route_id"] ?? "";
    const shapeId = t["shape_id"] ?? "";
    trips[t["trip_id"]!] = [routeId, shapeId, t["trip_headsign"] ?? "", Number(t["direction_id"] || 0)];
    count++;

    if (shapeId) {
      let set = shapeIdsByRoute.get(routeId);
      if (!set) shapeIdsByRoute.set(routeId, (set = new Set()));
      set.add(shapeId);
    }
  }

  await writeJson("trips.json", trips);
  return { trips: count, shapeIdsByRoute };
}

/**
 * Geometry, bundled per route rather than per shape.
 *
 * There are 2,106 shapes across 245 routes. A client showing buses needs the
 * geometry for whichever routes are on screen, so one object per route means a
 * handful of cacheable fetches instead of hundreds.
 */
async function buildShapes(
  shapeIdsByRoute: Map<string, Set<string>>,
): Promise<{ shapes: number; before: number; after: number }> {
  const points = new Map<string, Array<[number, number, number]>>();
  let before = 0;

  for await (const s of rows("shapes.txt")) {
    const id = s["shape_id"]!;
    const lat = Number(s["shape_pt_lat"]);
    const lon = Number(s["shape_pt_lon"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let arr = points.get(id);
    if (!arr) points.set(id, (arr = []));
    arr.push([Number(s["shape_pt_sequence"]), lat, lon]);
    before++;
  }

  const simplified = new Map<string, LatLon[]>();
  let after = 0;

  for (const [id, raw] of points) {
    raw.sort((a, b) => a[0] - b[0]);
    const line = raw.map(([, lat, lon]) => [lat, lon] as [number, number]);
    const thinned = simplify(line, SIMPLIFY_TOLERANCE);
    simplified.set(id, thinned);
    after += thinned.length;
  }

  await mkdir(join(OUT, "shapes"), { recursive: true });
  for (const [routeId, ids] of shapeIdsByRoute) {
    const bundle: Record<string, LatLon[]> = {};
    for (const id of ids) {
      const line = simplified.get(id);
      if (line) bundle[id] = line.map(([lat, lon]) => [round6(lat), round6(lon)]);
    }
    await writeJson(join("shapes", `${routeId}.json`), bundle);
  }

  console.log(
    `  shapes: ${simplified.size} across ${shapeIdsByRoute.size} routes, ` +
      `${before} points -> ${after} (${Math.round((1 - after / before) * 100)}% smaller)`,
  );
  return { shapes: simplified.size, before, after };
}

async function buildCalendar(): Promise<void> {
  const services: Record<string, { days: number[]; from: string; to: string }> = {};
  for await (const c of rows("calendar.txt")) {
    services[c["service_id"]!] = {
      days: [
        Number(c["sunday"] || 0),
        Number(c["monday"] || 0),
        Number(c["tuesday"] || 0),
        Number(c["wednesday"] || 0),
        Number(c["thursday"] || 0),
        Number(c["friday"] || 0),
        Number(c["saturday"] || 0),
      ],
      from: c["start_date"] ?? "",
      to: c["end_date"] ?? "",
    };
  }

  // exception_type 1 = service added on this date, 2 = removed
  const exceptions: Record<string, Array<[string, number]>> = {};
  for await (const e of rows("calendar_dates.txt")) {
    const id = e["service_id"]!;
    (exceptions[id] ??= []).push([e["date"] ?? "", Number(e["exception_type"] || 1)]);
  }

  await writeJson("calendar.json", { services, exceptions });
}

/**
 * Scheduled departures, one object per stop.
 *
 * This is what replaces a database. stop_times.txt is 3.7M rows; grouped by
 * stop it becomes 8,945 small objects that answer "what is scheduled here"
 * with a single R2 get.
 */
async function buildSchedules(stops: Map<string, unknown>): Promise<void> {
  const byStop = new Map<string, Array<[string, number, number]>>();
  let seen = 0;

  for await (const st of rows("stop_times.txt")) {
    const stopId = st["stop_id"];
    if (!stopId) continue;
    const departure = toSeconds(st["departure_time"] ?? st["arrival_time"] ?? "");
    if (departure === null) continue;

    let arr = byStop.get(stopId);
    if (!arr) byStop.set(stopId, (arr = []));
    arr.push([st["trip_id"] ?? "", departure, Number(st["stop_sequence"] || 0)]);
    seen++;

    if (seen % 1_000_000 === 0) console.log(`  stop_times: ${seen / 1_000_000}M rows ...`);
  }

  await mkdir(join(OUT, "sched"), { recursive: true });
  for (const [stopId, list] of byStop) {
    list.sort((a, b) => a[1] - b[1]);
    await writeJson(join("sched", `${stopId}.json`), list);
  }

  const missing = [...byStop.keys()].filter((id) => !stops.has(id)).length;
  console.log(
    `  schedules: ${seen} stop_times -> ${byStop.size} stop objects` +
      (missing ? ` (${missing} reference unknown stops)` : ""),
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */




const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(join(OUT, name), JSON.stringify(value));
}

/**
 * Upload every built file. `wrangler r2 object put` takes one key at a time and
 * each call spawns a process, so we run a bounded pool rather than a loop.
 */
async function uploadToR2(version: string): Promise<void> {
  const files = await listFiles(OUT);
  console.log(`\nUploading ${files.length} objects to r2://${BUCKET}/v/${version}/ ...`);

  // R2 returns transient 500s and drops connections under parallel puts, so
  // every object gets retries and the pool stays modest. Puts are idempotent,
  // which makes both a retry and a re-run of the whole build safe.
  const CONCURRENCY = 4;
  const ATTEMPTS = 4;

  let next = 0;
  let done = 0;
  let retried = 0;
  const failures: string[] = [];

  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++]!;
      const key = `v/${version}/${file.replace(/\\/g, "/")}`;

      let lastError: unknown;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          await execFile(WRANGLER, [
            "r2",
            "object",
            "put",
            `${BUCKET}/${key}`,
            "--file",
            join(OUT, file),
            "--content-type",
            "application/json",
            // Without this wrangler writes to the local simulated bucket in
            // .wrangler/state and reports success, while the deployed Worker
            // sees nothing.
            "--remote",
          ]);
          lastError = undefined;
          if (attempt > 1) retried++;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < ATTEMPTS) {
            await sleep(400 * 2 ** (attempt - 1) + Math.random() * 300);
          }
        }
      }

      if (lastError) {
        failures.push(key);
        console.error(`  FAILED after ${ATTEMPTS} attempts: ${key}`);
      }

      done++;
      if (done % 25 === 0 || done === files.length) {
        console.log(`  ${done}/${files.length}${retried ? ` (${retried} needed a retry)` : ""}`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (failures.length > 0) {
    throw new Error(`${failures.length} uploads failed, pointer not moved: ${failures.join(", ")}`);
  }
  if (retried > 0) console.log(`  ${retried} objects succeeded on retry`);

  // Only flip the pointer once every object is in place, so a half-finished
  // upload can never become the live version.
  await execFile(WRANGLER, [
    "kv",
    "key",
    "put",
    "gtfs_current",
    version,
    "--namespace-id",
    KV_NAMESPACE_ID,
    "--remote",
  ]);
  console.log(`Pointer gtfs_current -> ${version}`);
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

