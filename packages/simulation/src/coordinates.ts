import type { WallSurface } from "./level.js";

declare const canvasUnitBrand: unique symbol;
export type CanvasUnit = number & { readonly [canvasUnitBrand]: "CanvasUnit" };
export type CanvasUv = { u: CanvasUnit; v: CanvasUnit };

function canvasUnit(value: number): CanvasUnit {
  return Math.max(0, Math.min(1, value)) as CanvasUnit;
}

export function groundPointToCanvasUv(
  point: { x: number; z: number },
  halfSize: number
): CanvasUv {
  return {
    u: canvasUnit((point.x + halfSize) / (halfSize * 2)),
    v: canvasUnit(1 - (point.z + halfSize) / (halfSize * 2))
  };
}

export function wallPointToCanvasUv(
  surface: WallSurface,
  point: { x: number; y: number; z: number }
): CanvasUv {
  const along = surface.axis === "x" ? point.z : point.x;
  const alongAmount = (along - surface.minAlong) / (surface.maxAlong - surface.minAlong);
  const invertAlong = surface.axis === "x" ? surface.normalX < 0 : surface.normalZ > 0;
  return {
    u: canvasUnit(invertAlong ? 1 - alongAmount : alongAmount),
    v: canvasUnit(1 - point.y / surface.height)
  };
}
