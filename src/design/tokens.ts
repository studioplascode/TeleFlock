/**
 * Design values CSS can't hold: status names and behaviour, z-layers, radii, the phone breakpoint.
 * Colours live in src/design/styles/tokens.css only (themes override them there); canvas, SVG and
 * xterm read them at runtime with `readThemeVar` / `getComputedStyle`.
 */

/** Board/agent status. Columns: running · needs-you · review · done; plus idle and error. */
export type Status = "running" | "needs-you" | "review" | "done" | "idle" | "error";

export const STATUSES: readonly Status[] = ["running", "needs-you", "review", "done", "idle", "error"];

export interface StatusMeta {
  label: string;
  /** Loops forever (orb breath, glow border). */
  live: boolean;
  /** Demands attention (ping, sunset ambient). */
  loud: boolean;
}

/** Colours: `data-status` on an element gives its subtree --st-1, --st-2, --st-solid, --st-ink, --st-grad, --st-glow (tokens.css). */
export const STATUS: Record<Status, StatusMeta> = {
  running: { label: "Running", live: true, loud: false },
  "needs-you": { label: "Needs you", live: true, loud: true },
  review: { label: "Review", live: false, loud: false },
  done: { label: "Done", live: false, loud: false },
  idle: { label: "Idle", live: false, loud: false },
  error: { label: "Error", live: false, loud: true },
};

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
