import { describe, expect, test } from "bun:test";
import { clampPan, fitScale, isZoomed, pinchView, toggleZoom, wheelFactor, zoomLimits, zoomTo } from "./zoom";

const stage = { w: 1000, h: 800 };
const image = { w: 2000, h: 1000 };
const limits = zoomLimits(image, stage);

/** Stage-center-relative screen position of an image point (relative to the image center). */
const screen = (v: { scale: number; x: number; y: number }, p: { x: number; y: number }) => ({ x: v.x + p.x * v.scale, y: v.y + p.y * v.scale });

describe("lightbox zoom math", () => {
  test("fit contains the image and never upscales: small images open at actual size", () => {
    expect(fitScale(image, stage)).toBe(0.5);
    expect(fitScale(image, stage, 100)).toBe(0.4);
    expect(fitScale({ w: 10, h: 10 }, stage)).toBe(1);
    expect(fitScale({ w: 0, h: 0 }, stage)).toBe(1);
  });

  test("zooming keeps the image point under the cursor fixed", () => {
    const at = { x: 200, y: -100 };
    const start = { scale: 0.5, x: 0, y: 0 };
    const under = { x: (at.x - start.x) / start.scale, y: (at.y - start.y) / start.scale };
    const next = zoomTo(start, 2, at, image, stage, limits);
    expect(next.scale).toBe(2);
    expect(screen(next, under).x).toBeCloseTo(at.x);
    expect(screen(next, under).y).toBeCloseTo(at.y);
  });

  test("scale is clamped to [min, max]; the floor is the fit", () => {
    expect(zoomTo({ scale: 1, x: 0, y: 0 }, 0.01, { x: 0, y: 0 }, image, stage, limits).scale).toBe(limits.fit);
    expect(zoomTo({ scale: 1, x: 0, y: 0 }, 1e6, { x: 0, y: 0 }, image, stage, limits).scale).toBe(limits.max);
    expect(zoomLimits({ w: 100, h: 100 }, stage)).toMatchObject({ fit: 1, min: 1 });
  });

  test("pan can't push the image off-screen, and centers a smaller-than-stage axis", () => {
    // 2× → 4000×2000: slack (4000-1000)/2 = 1500 horizontally, (2000-800)/2 = 600 vertically
    expect(clampPan({ scale: 2, x: 9999, y: -9999 }, image, stage)).toEqual({ scale: 2, x: 1500, y: -600 });
    // fitted (0.5 → 1000×500): fits both axes → centered
    expect(clampPan({ scale: 0.5, x: 40, y: 40 }, image, stage)).toEqual({ scale: 0.5, x: 0, y: 0 });
  });

  test("pinch scales by the finger ratio and follows the midpoint", () => {
    const start = { scale: 1, x: 0, y: 0 };
    const v = pinchView(start, { x: 0, y: 0 }, { x: 30, y: 20 }, 2, image, stage, limits);
    expect(v).toEqual({ scale: 2, x: 30, y: 20 });
  });

  test("double-click toggles fit ↔ zoomed at the pointer", () => {
    const fitted = { scale: limits.fit, x: 0, y: 0 };
    const zoomed = toggleZoom(fitted, { x: 100, y: 50 }, image, stage, limits);
    expect(zoomed.scale).toBe(1);
    expect(isZoomed(zoomed, limits)).toBe(true);
    expect(toggleZoom(zoomed, { x: 0, y: 0 }, image, stage, limits)).toEqual(fitted);
  });

  test("wheel down zooms out, up zooms in; line deltas are normalised", () => {
    expect(wheelFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelFactor(3, 1, false)).toBeCloseTo(wheelFactor(48, 0, false));
  });
});
