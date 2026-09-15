import { describe, expect, it } from "vitest";
import { extractModuleScriptSrc, hasNewModuleScript } from "./updateCheck.js";

const BASE = "https://vanbus.ryanxu.dev/";

describe("extractModuleScriptSrc", () => {
  it("finds the src on a built page's module script", () => {
    const html = '<script type="module" crossorigin src="/assets/index-ABC123.js"></script>';
    expect(extractModuleScriptSrc(html)).toBe("/assets/index-ABC123.js");
  });

  it("finds the src regardless of attribute order", () => {
    const html = '<script src="/assets/index-ABC123.js" type="module"></script>';
    expect(extractModuleScriptSrc(html)).toBe("/assets/index-ABC123.js");
  });

  it("ignores a script tag that is not type=module", () => {
    const html = '<script src="/some-analytics.js"></script>';
    expect(extractModuleScriptSrc(html)).toBeNull();
  });

  it("returns null when the page has no script tags at all", () => {
    expect(extractModuleScriptSrc("<html><body>Down for maintenance</body></html>")).toBeNull();
  });
});

describe("hasNewModuleScript", () => {
  it("is false when the fetched page points at the same bundle", () => {
    const html = '<script type="module" src="/assets/index-ABC123.js"></script>';
    expect(hasNewModuleScript("https://vanbus.ryanxu.dev/assets/index-ABC123.js", html, BASE)).toBe(
      false,
    );
  });

  it("is true when a deploy changed the bundle's hashed filename", () => {
    const html = '<script type="module" src="/assets/index-XYZ789.js"></script>';
    expect(hasNewModuleScript("https://vanbus.ryanxu.dev/assets/index-ABC123.js", html, BASE)).toBe(
      true,
    );
  });

  it("treats a dev-mode relative src as equal to the already-absolute current one", () => {
    // In `vite dev` the script tag reads src="/src/main.tsx", but the running
    // tab's script.src property is already resolved to an absolute URL — so a
    // naive string compare would misfire on every check in dev.
    const html = '<script type="module" src="/src/main.tsx"></script>';
    expect(hasNewModuleScript("https://vanbus.ryanxu.dev/src/main.tsx", html, BASE)).toBe(false);
  });

  it("is false when the fetch came back malformed rather than falsely flagging an update", () => {
    expect(hasNewModuleScript("https://vanbus.ryanxu.dev/assets/index-ABC123.js", "", BASE)).toBe(
      false,
    );
  });
});
