/**
 * Basemap providers. Both host keyless vector tiles whose light/dark styles
 * already match this app's two themes, so a swap needs no other change.
 *
 * OpenFreeMap is the default. CARTO is the fallback because OpenFreeMap is a
 * single free service with no SLA: when its style will not load, the map is
 * blank and every bus loses its context. The runtime picks the next provider in
 * the chain when a style fails to load, so a rider still gets a map.
 */
export interface BasemapProvider {
  /** Stable id, used to find a provider's place in the chain. */
  name: string;
  /** Style URL for the light theme. */
  light: string;
  /** Style URL for the dark theme. */
  dark: string;
}

export const OPENFREEMAP: BasemapProvider = {
  name: "openfreemap",
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

export const CARTO: BasemapProvider = {
  name: "carto",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};

/** Tried in order, starting from DEFAULT_BASEMAP. */
export const BASEMAP_CHAIN: readonly BasemapProvider[] = [OPENFREEMAP, CARTO];

/** The provider the map opens with. */
export const DEFAULT_BASEMAP: BasemapProvider = OPENFREEMAP;

/** The style URL a provider serves for the current theme. */
export const basemapStyle = (provider: BasemapProvider, dark: boolean): string =>
  dark ? provider.dark : provider.light;

/**
 * The next provider to try after `current`, or null when the chain is spent.
 * A spent chain stops the fallback, so a total outage cannot loop forever.
 */
export const nextBasemap = (current: BasemapProvider): BasemapProvider | null => {
  const i = BASEMAP_CHAIN.findIndex((p) => p.name === current.name);
  return i < 0 ? null : (BASEMAP_CHAIN[i + 1] ?? null);
};
