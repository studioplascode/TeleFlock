import type { AgentStateId } from "@/features/shell/vocab";
import { formatAge } from "@/design";

/** Orb diameter bounds (px): readable across a room, never a wall of giant blobs. */
export const ORB_MIN = 28;
export const ORB_MAX = 168;

export interface OrbGrid {
  cols: number;
  rows: number;
  /** Orb diameter (px). */
  orb: number;
}

/**
 * Columns and orb size for `n` agents in a `width`×`height` field: the arrangement with the
 * biggest orbs that still fits every agent with its label (`labelPx` tall under each orb), so the
 * whole flock is on screen without scrolling.
 */
export function fitOrbs(n: number, width: number, height: number, labelPx: number): OrbGrid {
  if (n <= 0 || width <= 0 || height <= 0) return { cols: Math.max(1, n), rows: n > 0 ? 1 : 0, orb: ORB_MIN };
  let best: OrbGrid = { cols: n, rows: 1, orb: Number.NEGATIVE_INFINITY };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    // an orb takes about half its cell's width (room for the name) and most of what the label leaves
    const orb = Math.min((width / cols) * 0.56, (height / rows - labelPx) * 0.78);
    if (orb > best.orb) best = { cols, rows, orb };
  }
  return { ...best, orb: Math.round(Math.max(ORB_MIN, Math.min(ORB_MAX, best.orb))) };
}

/** "<1m", "6m", "1h 04m": minutes are precise enough from across the room. */
function minutes(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * The state's time in minutes, with the verb the board uses ("waiting 6m", "turn 1h 04m",
 * "finished 25m ago"; "quiet 3m" since the last event of a working agent gone silent): an ambient
 * display redraws its times every 15 s, not every second.
 */
export function ambientTime(state: AgentStateId | "quiet", since: number | undefined, now: number): string | null {
  if (since === undefined) return null;
  const ms = now - since;
  switch (state) {
    case "needs":
      return `waiting ${minutes(ms)}`;
    case "running":
      return `turn ${minutes(ms)}`;
    case "quiet":
      return `quiet ${minutes(ms)}`;
    case "review":
      return `finished ${formatAge(ms)}`;
    case "fresh":
    case "done":
      return formatAge(ms);
  }
}
