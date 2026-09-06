import type { MarkerShape } from "./buses.js";
import type { RouteInfo } from "./gtfs.js";

/**
 * Bus markers, pre-rendered once per colour.
 *
 * MapLibre can recolour an icon at draw time only if the image is a signed
 * distance field, and a real SDF needs a distance transform we would have to
 * write. We do not need one: TransLink colours just 12 of 245 routes and every
 * other route shares one fallback, so the entire system needs about a dozen
 * images per shape. Drawing them up front is far less machinery than an SDF for
 * the same result.
 */

/** Icon canvases are square, in CSS pixels before the display scale. */
const SIZE = 18;

export function iconName(shape: MarkerShape, color: string): string {
  return `${shape}-${color.replace("#", "").toLowerCase()}`;
}

/** Every colour the map can draw a bus in, each appearing once. */
export function distinctRouteColors(
  routes: Map<string, RouteInfo>,
  fallback: string,
): string[] {
  const colors = new Set<string>([fallback.toLowerCase()]);
  for (const route of routes.values()) {
    if (route.c) colors.add(`#${route.c}`.toLowerCase());
  }
  return [...colors];
}

/**
 * One marker, drawn into an ImageData ready for map.addImage.
 *
 * Both shapes point north, because MapLibre's icon-rotate turns them clockwise
 * from north and the bearing we store is a compass bearing.
 */
export function drawMarker(
  shape: MarkerShape,
  color: string,
  pixelRatio: number,
): ImageData {
  const size = SIZE * pixelRatio;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");

  ctx.scale(pixelRatio, pixelRatio);
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";

  if (shape === "chevron") {
    // A tapered arrowhead: unmistakably directional at 3-4 px on screen.
    ctx.beginPath();
    ctx.moveTo(9, 2.5);
    ctx.lineTo(14.5, 15);
    ctx.lineTo(9, 11.5);
    ctx.lineTo(3.5, 15);
    ctx.closePath();
  } else {
    // A bus seen from above: a rounded body with a lighter windscreen band at
    // the front, so the heading still reads once the shape is no longer an arrow.
    ctx.beginPath();
    ctx.roundRect(5, 2, 8, 14, 2.5);
  }

  ctx.fill();
  ctx.stroke();

  if (shape === "bus") {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.beginPath();
    ctx.roundRect(6.2, 3.2, 5.6, 3, 1);
    ctx.fill();
  }

  return ctx.getImageData(0, 0, size, size);
}
