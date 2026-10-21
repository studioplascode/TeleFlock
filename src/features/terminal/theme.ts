import type { ITheme } from "@xterm/xterm";
import { color } from "@/design";

/**
 * xterm palette derived from the Bento × omp tokens (dark only). Tuned against `bg-deep`: every
 * normal/bright colour clears 4.5:1 except `black`, which programs use as a background shade.
 */
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
  // mute-2 (#6e6e82) is ~4:1 on bg-deep; this is ~5.2:1 so dim/comment text stays readable.
  brightBlack: "#80809a",
  brightRed: "#ff8aa5",
  brightGreen: "#c4f06b",
  brightYellow: "#fde68a",
  brightBlue: color.ompBlue,
  brightMagenta: color.ompPink,
  brightCyan: "#67e8f9",
  brightWhite: color.ink,
};

/** Bundled terminal text font (`@fontsource-variable/fira-code`, imported by src/design/styles/index.css). */
export const TERM_FONT = "Fira Code Variable";
/**
 * Bundled icon font (src/assets/fonts/symbols-nerd-font): its unicode-range is only the Nerd Font
 * Private Use Area, so it supplies omp's `symbolPreset: nerd` icons and nothing else.
 */
export const TERM_ICON_FONT = "Symbols Nerd Font Mono";

/**
 * Fira Code, then the Nerd Font icons, then system symbol fonts before the generic fallback so
 * glyphs like ⏺ ✻ ⎿ render as text, not colour emoji.
 */
export const TERM_FONT_FAMILY = `"${TERM_FONT}", "${TERM_ICON_FONT}", ui-monospace, "Cascadia Code", Consolas, "Segoe UI Symbol", "Noto Sans Symbols 2", "Noto Sans Symbols", "Apple Symbols", "DejaVu Sans Mono", monospace`;

const TERM_FONTS: readonly string[] = [TERM_FONT, TERM_ICON_FONT];

/** Is this `FontFace` one of the bundled terminal fonts? (`family` may come back quoted.) */
export function isTermFontFace(face: FontFace): boolean {
  return TERM_FONTS.includes(face.family.replace(/["']/g, ""));
}

let termFontsLoad: Promise<void> | null = null;

/**
 * Starts loading every face of the terminal fonts (all Fira Code subsets, the Nerd Font icons) and
 * resolves once all have settled. CSS only fetches unicode-range faces when the DOM uses one of
 * their characters, which a WebGL canvas never reports, so the terminal asks for them up front.
 */
export function loadTermFonts(): Promise<void> {
  if (termFontsLoad) return termFontsLoad;
  const loads: Promise<unknown>[] = [];
  document.fonts.forEach((face) => {
    if (isTermFontFace(face)) loads.push(face.load());
  });
  const all = Promise.allSettled(loads).then(() => undefined);
  // Stylesheet not applied yet (no faces registered): try again on the next terminal.
  if (loads.length > 0) termFontsLoad = all;
  return all;
}

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 28;
export const DEFAULT_FONT_SIZE = 13;
/** Board tiles: small enough to show a whole pane in a bento tile. */
export const COMPACT_FONT_SIZE = 7;

export function clampFontSize(px: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(px * 2) / 2));
}
