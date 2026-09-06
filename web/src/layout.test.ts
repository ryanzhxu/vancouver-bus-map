import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * AUTOPILOT's layout constraint — "the map attribution must never be covered" —
 * is a geometric relationship between two stylesheets: ours positions MapLibre's
 * attribution container, and MapLibre's own CSS sizes the compact control inside
 * it. Nothing in the app can assert that at runtime (there is no DOM harness and
 * jsdom computes no layout), so measure it from the stylesheets instead. The
 * MapLibre numbers are read from the vendored file rather than hardcoded, so an
 * upgrade that changes the control's size is caught here instead of on a phone.
 */

const ROOT_FONT_PX = 16;

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const appCss = stripComments(readFileSync(new URL("./app.css", import.meta.url), "utf8"));
const maplibreCss = stripComments(
  readFileSync(
    new URL("../node_modules/maplibre-gl/dist/maplibre-gl.css", import.meta.url),
    "utf8",
  ),
);

/** The declarations of the last rule whose selector list contains `selector`. */
function declarations(css: string, selector: string): string {
  let found: string | undefined;
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1] ?? "";
    if (selectors.split(",").some((one) => one.trim() === selector)) found = match[2];
  }
  if (found === undefined) throw new Error(`no rule for ${selector}`);
  return found;
}

function declaration(css: string, selector: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(
    declarations(css, selector),
  );
  if (!match?.[1]) throw new Error(`no ${property} on ${selector}`);
  return match[1].trim();
}

const px = (value: string): number => {
  const match = /^(-?[\d.]+)(px|rem)$/.exec(value.trim());
  if (!match) throw new Error(`not a length: ${value}`);
  return Number(match[1]) * (match[2] === "rem" ? ROOT_FONT_PX : 1);
};

/** Reads `calc(<length> + env(safe-area-inset-bottom))` as its length in px. */
const offsetPx = (value: string): number => {
  const match = /^calc\(\s*([\d.]+(?:px|rem))\s*\+\s*env\(safe-area-inset-bottom\)\s*\)$/.exec(
    value,
  );
  if (!match?.[1]) throw new Error(`not an inset-aware bottom offset: ${value}`);
  return px(match[1]);
};

/**
 * Top edge of MapLibre's compact attribution button, in px above the bottom of
 * the viewport: where we place its container, plus the control's own margin and
 * height. The control is box-sizing: content-box, so its padding adds to
 * min-height.
 */
function attributionTopPx(): number {
  const compact = ".maplibregl-ctrl-attrib.maplibregl-compact";
  const containerBottom = offsetPx(
    declaration(appCss, ".maplibregl-ctrl-bottom-right", "bottom"),
  );
  const margin = px(declaration(maplibreCss, compact, "margin"));
  const minHeight = px(declaration(maplibreCss, compact, "min-height"));
  const padding = declaration(maplibreCss, compact, "padding").split(/\s+/);
  const paddingTop = px(padding[0] ?? "0px");
  const paddingBottom = px(padding[2] ?? padding[0] ?? "0px");
  return containerBottom + margin + minHeight + paddingTop + paddingBottom;
}

describe("bottom-of-screen layout", () => {
  it("keeps the map attribution clear of the selected bus and stop cards", () => {
    // Both cards use the .buscard box; .stopcard only widens it.
    const cardBottom = offsetPx(declaration(appCss, ".buscard", "bottom"));
    expect(cardBottom).toBeGreaterThanOrEqual(attributionTopPx());
  });

  it("measures the attribution box where MapLibre actually draws it", () => {
    // Guards the parser itself: if MapLibre restyles the control, this changes
    // and the developer sees why the clearance above moved.
    expect(attributionTopPx()).toBe(86);
  });
});
