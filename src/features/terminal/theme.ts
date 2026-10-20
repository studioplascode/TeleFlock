import type { ITheme } from "@xterm/xterm";
import { color } from "@/design";

/** xterm palette derived from the Bento × omp tokens (dark only). */
export const termTheme: ITheme = {
  background: color.bgDeep,
  foreground: color.ink2,
  cursor: color.accentHi,
  cursorAccent: color.bgDeep,
  selectionBackground: "rgba(163, 92, 240, 0.38)",
  selectionInactiveBackground: "rgba(163, 92, 240, 0.2)",
  selectionForeground: color.ink,
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.08)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.16)",
  scrollbarSliderActiveBackground: "rgba(163, 92, 240, 0.4)",
  black: "#1b1b25",
  red: "#ff5c7a",
  green: "#a3e635",
  yellow: color.warn,
  blue: "#6f9cff",
  magenta: color.accentHi,
  cyan: color.review,
  white: color.ink2,
  brightBlack: color.mute2,
  brightRed: "#ff8aa5",
  brightGreen: "#c4f06b",
  brightYellow: "#fde68a",
  brightBlue: color.ompBlue,
  brightMagenta: color.ompPink,
  brightCyan: "#67e8f9",
  brightWhite: color.ink,
};

export const TERM_FONT_FAMILY = '"JetBrains Mono Variable", ui-monospace, "Cascadia Code", Consolas, monospace';

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 28;
export const DEFAULT_FONT_SIZE = 13;
/** Board tiles: small enough to show a whole pane in a bento tile. */
export const COMPACT_FONT_SIZE = 7;

export function clampFontSize(px: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(px * 2) / 2));
}
