/**
 * Pure zoom/pan math for the image lightbox.
 *
 * Coordinates: the image is laid out at its natural size with its center on the stage center, then
 * transformed by `translate(x, y) scale(scale)` (origin = image center). Points passed in are relative
 * to the stage center, in CSS px.
 */

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface ZoomLimits {
  /** Scale that fits the whole image in the stage (the resting view). */
  fit: number;
  min: number;
  max: number;
}

/** Fit never upscales beyond this, so tiny images don't fill the screen as a blur. */
export const FIT_MAX_UPSCALE = 2;
/** Zoom-in ceiling: at least 4× actual size, and at least 8× the fit scale. */
export const MAX_ZOOM_ACTUAL = 4;
export const MAX_ZOOM_FIT = 8;
/** Scales within this ratio of `fit` count as "not zoomed" (gallery swipes and ←/→ apply). */
const FIT_EPSILON = 1.01;

/** Scale that fits `image` inside `stage` minus `pad` px on every side, capped at FIT_MAX_UPSCALE. */
export function fitScale(image: Size, stage: Size, pad = 0): number {
  if (image.w <= 0 || image.h <= 0) return 1;
  const w = Math.max(1, stage.w - pad * 2);
  const h = Math.max(1, stage.h - pad * 2);
  return Math.min(w / image.w, h / image.h, FIT_MAX_UPSCALE);
}

/** Zoom floor is the fit scale, or actual size for images that fit upscaled (so 1:1 stays reachable). */
export function zoomLimits(image: Size, stage: Size, pad = 0): ZoomLimits {
  const fit = fitScale(image, stage, pad);
  return { fit, min: Math.min(fit, 1), max: Math.max(fit * MAX_ZOOM_FIT, MAX_ZOOM_ACTUAL) };
}

export function clampScale(scale: number, limits: ZoomLimits): number {
  return Math.min(limits.max, Math.max(limits.min, scale));
}

export function isZoomed(view: View, limits: ZoomLimits): boolean {
  return view.scale > limits.fit * FIT_EPSILON;
}

/** The resting view: fitted and centered. */
export function fitView(limits: ZoomLimits): View {
  return { scale: limits.fit, x: 0, y: 0 };
}

/**
 * Keeps the image covering the stage on any axis where it is larger than the stage, and centered on
 * any axis where it is smaller, so it can never be panned off-screen.
 */
export function clampPan(view: View, image: Size, stage: Size): View {
  const clampAxis = (offset: number, extent: number, room: number) => {
    const slack = (extent - room) / 2;
    return slack <= 0 ? 0 : Math.min(slack, Math.max(-slack, offset));
  };
  return {
    scale: view.scale,
    x: clampAxis(view.x, image.w * view.scale, stage.w),
    y: clampAxis(view.y, image.h * view.scale, stage.h),
  };
}

/** Scales to `scale` (clamped) keeping the image point under `at` fixed, then clamps the pan. */
export function zoomTo(view: View, scale: number, at: Point, image: Size, stage: Size, limits: ZoomLimits): View {
  const next = clampScale(scale, limits);
  const k = next / view.scale;
  return clampPan({ scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }, image, stage);
}

/** Multiplies the scale by `factor` around `at`. */
export function zoomBy(view: View, factor: number, at: Point, image: Size, stage: Size, limits: ZoomLimits): View {
  return zoomTo(view, view.scale * factor, at, image, stage, limits);
}

/**
 * Wheel → zoom factor. Trackpad pinch arrives as ctrl+wheel with small deltas and wants a steeper
 * curve; `deltaMode` 1 (lines) is normalised to px.
 */
export function wheelFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const k = pinch ? 0.01 : 0.0025;
  return Math.exp(-Math.max(-100, Math.min(100, px)) * k);
}

/**
 * Two-finger gesture: scales by `ratio` (current / start finger distance) and moves with the
 * midpoint, keeping the image point under the starting midpoint under the current midpoint.
 */
export function pinchView(start: View, startMid: Point, mid: Point, ratio: number, image: Size, stage: Size, limits: ZoomLimits): View {
  const scale = clampScale(start.scale * ratio, limits);
  const k = scale / start.scale;
  return clampPan({ scale, x: mid.x - (startMid.x - start.x) * k, y: mid.y - (startMid.y - start.y) * k }, image, stage);
}

/** Double-click / double-tap: fitted → max(2× fit, actual size) at `at`; zoomed → fit. */
export function toggleZoom(view: View, at: Point, image: Size, stage: Size, limits: ZoomLimits): View {
  if (isZoomed(view, limits)) return fitView(limits);
  return zoomTo(view, Math.max(limits.fit * 2, 1), at, image, stage, limits);
}
