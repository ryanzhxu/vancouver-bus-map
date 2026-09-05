import type { Env } from "./types.js";

/**
 * Serve the precomputed static GTFS artifacts out of R2.
 *
 * Two URL shapes, deliberately different:
 *
 *   /api/gtfs/manifest              current version, short cache
 *   /gtfs/{version}/routes.json     the data itself, immutable
 *
 * Because the version is in the path, every data URL can be cached forever by
 * the browser and the edge. A weekly rebuild publishes a new version and the
 * manifest points at it; nothing has to be purged.
 */

const VERSION_KEY = "gtfs_current";
const MANIFEST_CACHE_SECONDS = 300;

/** Cached per isolate. The version changes weekly at most. */
let cachedVersion: { value: string; at: number } | null = null;
const VERSION_TTL_MS = 60_000;

export async function currentVersion(env: Env): Promise<string | null> {
  if (cachedVersion && Date.now() - cachedVersion.at < VERSION_TTL_MS) {
    return cachedVersion.value;
  }
  const value = await env.SNAPSHOT.get(VERSION_KEY);
  if (!value) return null;
  cachedVersion = { value, at: Date.now() };
  return value;
}

export async function handleManifest(env: Env): Promise<Response> {
  const version = await currentVersion(env);
  if (!version) {
    return Response.json({ error: "no GTFS build published yet" }, { status: 503 });
  }

  const object = await env.GTFS.get(`v/${version}/manifest.json`);
  if (!object) {
    return Response.json({ error: `manifest missing for version ${version}` }, { status: 503 });
  }

  return new Response(object.body, {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${MANIFEST_CACHE_SECONDS}`,
      "x-gtfs-version": version,
    },
  });
}

/**
 * Serve /gtfs/{version}/{path}. The path is validated rather than trusted:
 * an R2 key is built from user input, so traversal and stray prefixes must not
 * be able to reach objects outside the published version.
 */
export async function handleAsset(url: URL, env: Env): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["gtfs", version, ...rest]
  const version = parts[1];
  const rest = parts.slice(2);

  if (!version || rest.length === 0) {
    return new Response("not found", { status: 404 });
  }
  if (!isSafeSegment(version) || !rest.every(isSafeSegment)) {
    return new Response("bad request", { status: 400 });
  }

  const key = `v/${version}/${rest.join("/")}`;
  const object = await env.GTFS.get(key);
  if (!object) return new Response("not found", { status: 404 });

  return new Response(object.body, {
    headers: {
      "content-type": "application/json",
      // Versioned path, so this can never go stale.
      "cache-control": "public, max-age=31536000, immutable",
      etag: object.httpEtag,
    },
  });
}

/** Letters, digits, dash, underscore, dot — but never "." or ".." alone. */
function isSafeSegment(segment: string): boolean {
  if (segment === "." || segment === "..") return false;
  return /^[A-Za-z0-9._-]+$/.test(segment);
}
