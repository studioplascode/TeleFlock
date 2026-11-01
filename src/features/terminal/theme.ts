import type { ITheme } from "@xterm/xterm";
import { readThemeColor, TERMINAL_KEYS, withAlpha } from "@/design";

/**
 * The xterm palette of the current theme: the `--term-*` variables (tokens.css for the default,
 * tuned against its background: every normal/bright colour clears 4.5:1 except `black`, which
 * programs use as a background shade). Call again after a theme change (`onThemeChange`).
 */
export function termTheme(): ITheme {
  const theme: Record<string, string> = {};
  for (const [key, name] of TERMINAL_KEYS) theme[key] = readThemeColor(name, key === "background" ? "#07070b" : "#dcdce4");
  const { foreground = "#dcdce4", cursor = foreground, selectionBackground = "rgba(163, 92, 240, 0.38)", brightWhite = "#f5f5f7" } = theme;
  return {
    ...theme,
    selectionInactiveBackground: withAlpha(selectionBackground, 0.55),
    selectionForeground: brightWhite,
    scrollbarSliderBackground: withAlpha(foreground, 0.1),
    scrollbarSliderHoverBackground: withAlpha(foreground, 0.2),
    scrollbarSliderActiveBackground: withAlpha(cursor, 0.45),
  };
}

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
