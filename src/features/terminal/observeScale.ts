export interface BoxSize {
  width: number;
  height: number;
}

/**
 * How an observer's grid (the driver's size) maps onto its box:
 * - `contain`: the whole grid, one uniform scale, spare axis centred (full views);
 * - `tail`: the grid's width fills the box and, when it is then taller than the box, its top is
 *   cut so the bottom rows (latest output, an agent's editor and status line) stay in view
 *   (board tiles: a glance at a live pane, never a small block in a large empty tile).
 */
export type ObserveFit = "contain" | "tail";

/**
 * CSS transform (origin top-left) placing an observer's drawn grid (`screen`, CSS px at scale 1)
 * in its `box`, scaled uniformly by at most `maxScale`. `""` when the grid already fills the box
 * exactly, or when either size is not measurable (collapsed box, no screen yet), so a transient
 * zero size never leaves a stale zoom.
 */
export function observeTransform(box: BoxSize, screen: BoxSize, maxScale: number, fit: ObserveFit): string {
  if (!(box.width > 0 && box.height > 0 && screen.width > 0 && screen.height > 0)) return "";
  const byWidth = box.width / screen.width;
  const s = Math.min(fit === "tail" ? byWidth : Math.min(byWidth, box.height / screen.height), maxScale);
  const x = Math.max(0, Math.round((box.width - screen.width * s) / 2));
  const spare = box.height - screen.height * s;
  // A negative offset cuts the top (the frame clips overflow).
  const y = Math.round(spare >= 0 ? spare / 2 : spare);
  if (Math.abs(s - 1) < 0.001 && x === 0 && y === 0) return "";
  return `translate(${x}px, ${y}px) scale(${Number(s.toFixed(4))})`;
}
