/**
 * Detects a deployed build newer than the one currently running in the tab.
 *
 * iOS Safari suspends a backgrounded tab rather than reloading it, so a rider
 * who had the map open before a deploy can sit on old JS indefinitely with no
 * network activity at all — no Cache-Control header reaches code that never
 * re-fetches. The only signal available is comparing index.html's referenced
 * bundle now against the one this tab actually loaded.
 */

/** The `src` of the page's module script tag, or null if none is present. */
export function extractModuleScriptSrc(html: string): string | null {
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    if (!/\btype\s*=\s*["']module["']/.test(tag)) continue;
    const match = /\bsrc\s*=\s*["']([^"']+)["']/.exec(tag);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * True if a freshly fetched index.html points at a different bundle than the
 * one this tab loaded. `baseUrl` resolves both to absolute URLs before
 * comparing, so a dev-mode relative src ("/src/main.tsx") and the browser's
 * already-absolute currentSrc don't read as different when they are not.
 */
export function hasNewModuleScript(
  currentSrc: string,
  fetchedHtml: string,
  baseUrl: string,
): boolean {
  const fetchedSrc = extractModuleScriptSrc(fetchedHtml);
  if (fetchedSrc === null) return false;
  return new URL(fetchedSrc, baseUrl).href !== new URL(currentSrc, baseUrl).href;
}
