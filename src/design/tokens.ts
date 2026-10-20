/**
 * TS mirror of src/design/styles/tokens.css for places CSS can't reach (canvas, SVG gradients,
 * motion values). Keep in sync with the CSS.
 */

/** Board/agent status. Columns: running · needs-you · review · done; plus idle and error. */
export type Status = "running" | "needs-you" | "review" | "done" | "idle" | "error";

export const STATUSES: readonly Status[] = ["running", "needs-you", "review", "done", "idle", "error"];

export interface StatusMeta {
  label: string;
  /** Gradient start / end. */
  c1: string;
  c2: string;
  /** Representative solid colour. */
  solid: string;
  /** "r g b" triplet for rgb(var / alpha) use. */
  rgb: string;
  /** Text colour on top of the gradient. */
  ink: string;
  /** Loops forever (orb breath, glow border). */
  live: boolean;
  /** Demands attention (ping, sunset ambient). */
  loud: boolean;
}

export const STATUS: Record<Status, StatusMeta> = {
  running: { label: "Running", c1: "#a35cf0", c2: "#4f8bff", solid: "#9b6cf7", rgb: "155 108 247", ink: "#ffffff", live: true, loud: false },
  "needs-you": { label: "Needs you", c1: "#ff7a18", c2: "#ff3d77", solid: "#ff3d77", rgb: "255 61 119", ink: "#ffffff", live: true, loud: true },
  review: { label: "In review", c1: "#22d3ee", c2: "#0ea5e9", solid: "#22d3ee", rgb: "34 211 238", ink: "#04262c", live: false, loud: false },
  done: { label: "Done", c1: "#a3e635", c2: "#4ade80", solid: "#a3e635", rgb: "163 230 53", ink: "#1a2e05", live: false, loud: false },
  idle: { label: "Idle", c1: "#94a3b8", c2: "#64748b", solid: "#8a94a6", rgb: "138 148 166", ink: "#0b0b10", live: false, loud: false },
  error: { label: "Error", c1: "#ff4d5e", c2: "#e11d48", solid: "#ff4d5e", rgb: "255 77 94", ink: "#ffffff", live: false, loud: true },
};

export const color = {
  bg: "#0b0b10",
  bgDeep: "#07070b",
  chrome: "#0d0d13",
  tile1: "#15151d",
  tile2: "#1b1b25",
  tile3: "#232330",
  tile4: "#2c2c3b",
  ink: "#f5f5f7",
  ink2: "#dcdce4",
  mute: "#9a9aad",
  mute2: "#6e6e82",
  accent: "#a35cf0",
  accentHi: "#b97cf6",
  ompPink: "#f053d0",
  ompPurple: "#a15eef",
  ompBlue: "#7fa2e7",
  sun1: "#ff7a18",
  sun2: "#ff3d77",
  review: "#22d3ee",
  done: "#a3e635",
  error: "#ff4d5e",
  warn: "#fbbf24",
} as const;

export const gradient = {
  omp: "linear-gradient(135deg, #f053d0 0%, #a15eef 50%, #7fa2e7 100%)",
  sun: "linear-gradient(135deg, #ff7a18 0%, #ff3d77 100%)",
  run: "linear-gradient(135deg, #a35cf0 0%, #4f8bff 100%)",
} as const;

/** Mirrors the CSS z-layer utilities (z-titlebar, z-modal …). */
export const z = {
  ambient: -1,
  base: 0,
  raised: 10,
  sticky: 20,
  titlebar: 30,
  drag: 40,
  overlay: 50,
  modal: 60,
  popover: 70,
  toast: 80,
  tooltip: 90,
} as const;

/** px; Tailwind spacing is a 4px grid, so `p-3` = 12px. */
export const radius = { xs: 6, sm: 10, md: 14, lg: 18, xl: 22, tile: 28, sheet: 34 } as const;

/** Breakpoint below which the app uses the phone layout (bottom nav, sheets). Matches Tailwind `md`. */
export const MOBILE_MAX_WIDTH = 767;
