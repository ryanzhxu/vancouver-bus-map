import { useEffect, useState } from "react";
import { hasNewModuleScript } from "./updateCheck.js";

/** Skips a redundant re-check on rapid tab switching. */
const MIN_CHECK_INTERVAL_MS = 60_000;

/**
 * True once a deploy newer than this tab's own bundle is detected.
 *
 * iOS Safari suspends a backgrounded tab rather than reloading it, so a rider
 * who had the map open before a deploy can sit on old JS indefinitely with no
 * network request happening at all. The only moment to catch that is when the
 * tab becomes visible again — visibilitychange covers switching back to the
 * app, pageshow covers a bfcache restore, which does not always fire the
 * former.
 */
export function useUpdateCheck(): boolean {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    if (updateAvailable) return;

    // The [src] requirement matters in dev: Vite's React Fast Refresh preamble
    // injects its own inline type="module" script with no src, ahead of this
    // one, which a plain 'script[type="module"]' selector would match first.
    const currentSrc = document.querySelector<HTMLScriptElement>(
      'script[type="module"][src]',
    )?.src;
    if (!currentSrc) return;

    let lastCheck = 0;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastCheck < MIN_CHECK_INTERVAL_MS) return;
      lastCheck = now;

      fetch("/", { cache: "no-store" })
        .then((res) => (res.ok ? res.text() : null))
        .then((html) => {
          if (html !== null && hasNewModuleScript(currentSrc, html, location.href)) {
            setUpdateAvailable(true);
          }
        })
        .catch(() => {
          // Offline, or the request was blocked — the next visibility or
          // pageshow event tries again.
        });
    };

    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
    };
  }, [updateAvailable]);

  return updateAvailable;
}
