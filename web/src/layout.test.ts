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

  it("lets the status line wrap whole pieces instead of individual characters", () => {
    // .status sits next to two flex: none buttons that never shrink, and
    // carries overflow-wrap: anywhere for arbitrary long error text. Without
    // flex-wrap, a narrow phone with no room left for buses/age/next-refresh
    // has nowhere to shrink .status except collapsing to overflow-wrap's
    // near-zero automatic minimum — every character on its own line.
    expect(declaration(appCss, ".status", "flex-wrap")).toBe("wrap");
  });

  it("lifts the pulse panel clear of the status bar that opens it", () => {
    // The panel sits at z-index 6 over a bar at 3, so any shortfall here puts it
    // on top of the Pulse and About buttons themselves. .statusbar has no height
    // of its own: it is one --tap-tall button plus its own padding and border.
    // Deriving that here rather than trusting the literal is the point — the
    // 56px this replaced was correct against an older, shorter bar.
    // The bar's only child that sets a height is the button, which takes --tap.
    expect(declaration(appCss, ".about-button", "min-height")).toBe("var(--tap)");
    const buttonHeight = px(declaration(appCss, ":root", "--tap"));
    const paddingTop = px(declaration(appCss, ".statusbar", "padding").split(/\s+/)[0] ?? "");
    // padding-bottom is max(0.5rem, env(...)), so its floor is that 0.5rem.
    const paddingBottom = px(
      /max\(\s*([\d.]+rem)/.exec(declaration(appCss, ".statusbar", "padding-bottom"))?.[1] ?? "",
    );
    const border = px(declaration(appCss, ".statusbar", "border-top").split(/\s+/)[0] ?? "");
    const statusbarHeight = buttonHeight + paddingTop + paddingBottom + border;

    expect(statusbarHeight).toBe(61);

    // .status can wrap to 3 lines (buses/age/next-refresh, then the late-flag
    // and bunched-flag each on their own line), so the panel must clear that
    // worst case too, not just the one-line button-height floor above.
    const statusLineHeight =
      px(declaration(appCss, ".status", "font-size")) * Number(declaration(appCss, "body", "line-height"));
    const statusRowGap = px(declaration(appCss, ".status", "row-gap"));
    const statusThreeLinesHeight = statusLineHeight * 3 + statusRowGap * 2;
    const worstCaseStatusbarHeight =
      Math.max(statusThreeLinesHeight, buttonHeight) + paddingTop + paddingBottom + border;

    // The panel carries the same env() inset the bar does, so clearing it at a
    // zero inset clears it everywhere.
    expect(offsetPx(declaration(appCss, ".pulse", "bottom"))).toBeGreaterThanOrEqual(
      worstCaseStatusbarHeight,
    );
  });

  it("keeps a long headsign from collapsing to one character per line", () => {
    // Same failure mode as .status: overflow-wrap: anywhere on the headsign
    // (below) gives this flex item a near-zero automatic minimum, and its
    // siblings here (the badge, Follow, and close button) are all flex: none.
    // A positive min-width overrides that collapse.
    expect(px(declaration(appCss, ".buscard-title", "min-width"))).toBeGreaterThan(0);
    expect(declaration(appCss, ".buscard-title strong", "overflow-wrap")).toBe("anywhere");
  });

  it("caps the card height so it never overflows above the viewport", () => {
    // .app is overflow:hidden, so a card taller than the space above its bottom
    // anchor loses its header and × button off the top of the screen. The cap
    // must subtract at least the bottom anchor from 100dvh, or the card can
    // still exceed the viewport on a short (landscape) phone.
    const maxHeight = declaration(appCss, ".buscard", "max-height");
    const bottomAnchor = /calc\(\s*([\d.]+rem)\s*\+\s*env\(safe-area-inset-bottom\)\s*\)/.exec(
      declaration(appCss, ".buscard", "bottom"),
    )?.[1];
    const capAnchor = /100dvh\s*-\s*([\d.]+rem)/.exec(maxHeight)?.[1];
    if (!bottomAnchor || !capAnchor) throw new Error("could not read the card anchors");
    // The cap's leading offset must match the bottom anchor, so the two stay in
    // step if either moves, and the card top can never rise past the viewport.
    expect(px(capAnchor)).toBeGreaterThanOrEqual(px(bottomAnchor));
    // And the contents must scroll rather than clip once that cap is reached.
    expect(declaration(appCss, ".buscard", "overflow-y")).toBe("auto");
  });
});
