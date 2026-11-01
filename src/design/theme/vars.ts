/**
 * Every variable a theme may set, grouped as the theme editor and docs list them. Names only: the
 * default values live in src/design/styles/tokens.css (the default theme) and are read from the
 * stylesheet at runtime (`readThemeDefaults`), so there is one source of truth.
 */

export interface ThemeVar {
  /** Custom property, with the leading `--`. */
  name: string;
  /** What it paints, as the template comments it. */
  hint: string;
}

export interface ThemeVarGroup {
  title: string;
  vars: readonly ThemeVar[];
}

const v = (name: string, hint: string): ThemeVar => ({ name: `--${name}`, hint });

export const THEME_VAR_GROUPS: readonly ThemeVarGroup[] = [
  {
    title: "Surfaces",
    vars: [
      v("color-bg", "app background"),
      v("color-bg-deep", "terminals, deep wells"),
      v("color-chrome", "title bar, phone header and navigation"),
      v("color-tile-1", "tile bottom"),
      v("color-tile-2", "tile top, sidebar"),
      v("color-tile-3", "cards, raised controls"),
      v("color-tile-4", "pressed and selected controls"),
      v("color-tile-5", "hover on tile-4"),
      v("color-well", "inset fields (translucent)"),
      v("color-well-2", "hovered field"),
      v("color-glass", "translucent panels: sidebar, session, inspector (used at 72 %)"),
      v("color-pop-1", "menus, popovers, selects, command palette: top"),
      v("color-pop-2", "menus, popovers, selects, command palette: bottom"),
      v("color-sheet-1", "dialogs and bottom sheets: top"),
      v("color-sheet-2", "dialogs and bottom sheets: bottom"),
      v("color-float", "tooltips and toasts (used at 94–98 %)"),
      v("color-scrim", "behind dialogs and sheets (used at 55–60 %)"),
    ],
  },
  {
    title: "Text and lines",
    vars: [
      v("color-ink", "primary text; hover and selection washes are tints of it"),
      v("color-ink-2", "body text"),
      v("color-mute", "secondary text"),
      v("color-mute-2", "meta text"),
      v("color-line", "hairlines"),
      v("color-line-2", "borders"),
      v("color-line-3", "strong borders"),
    ],
  },
  {
    title: "Accent",
    vars: [
      v("color-accent", "primary actions, selection, focus"),
      v("color-accent-hi", "accent, lighter"),
      v("color-accent-lo", "accent, darker"),
      v("color-accent-ink", "text on accent tints"),
      v("color-on-accent", "text on accent fills and the omp gradient"),
      v("color-omp-pink", "omp gradient: start"),
      v("color-omp-purple", "omp gradient: middle"),
      v("color-omp-blue", "omp gradient: end"),
    ],
  },
  {
    title: "Status",
    vars: [
      v("color-run-1", "running: gradient start"),
      v("color-run-2", "running: gradient end"),
      v("color-run-solid", "running: dots and text"),
      v("color-on-run", "text on running fills"),
      v("color-sun-1", "needs you (the sunset): gradient start"),
      v("color-sun-2", "needs you: gradient end, dots and text"),
      v("color-on-sun", "text on the sunset"),
      v("color-sun-ink", "text on needs-you tints"),
      v("color-review", "review"),
      v("color-review-2", "review: gradient end"),
      v("color-on-review", "text on review fills"),
      v("color-done", "done"),
      v("color-done-2", "done: gradient end"),
      v("color-on-done", "text on done fills"),
      v("color-idle", "idle"),
      v("color-idle-1", "idle: gradient start"),
      v("color-idle-2", "idle: gradient end"),
      v("color-on-idle", "text on idle fills"),
      v("color-error", "error"),
      v("color-error-2", "error: gradient end"),
      v("color-on-error", "text on error fills"),
      v("color-error-ink", "text on error tints"),
      v("color-warn", "warning"),
      v("color-warn-ink", "text on warning tints"),
    ],
  },
  {
    title: "Diffs",
    vars: [v("color-add", "added lines"), v("color-del", "removed lines"), v("color-tool", "tool names")],
  },
  {
    title: "Depth and texture",
    vars: [
      v("shadow-d1", "cards"),
      v("shadow-d2", "tiles and panels"),
      v("shadow-d3", "dialogs, menus, toasts"),
      v("shadow-key", "key caps"),
      v("shadow-hairline", "1px inset outline"),
      v("shadow-glow-accent", "glow under primary buttons"),
      v("shadow-glow-sun", "needs-you glow"),
      v("shadow-glow-run", "running glow"),
      v("shadow-glow-review", "review glow"),
      v("shadow-glow-done", "done glow"),
      v("shadow-glow-error", "error glow"),
      v("tf-grad-omp", "primary buttons and brand fills"),
      v("tf-grad-sun", "needs-you fills"),
      v("tf-grad-run", "running fills"),
      v("tf-noise", "background grain (none to turn it off)"),
    ],
  },
  {
    title: "Terminal",
    vars: [
      v("term-bg", "background"),
      v("term-fg", "text"),
      v("term-cursor", "cursor"),
      v("term-cursor-ink", "text under the cursor"),
      v("term-selection", "selection (translucent)"),
      v("term-black", "black"),
      v("term-red", "red"),
      v("term-green", "green"),
      v("term-yellow", "yellow"),
      v("term-blue", "blue"),
      v("term-magenta", "magenta"),
      v("term-cyan", "cyan"),
      v("term-white", "white"),
      v("term-bright-black", "bright black (dim text, comments)"),
      v("term-bright-red", "bright red"),
      v("term-bright-green", "bright green"),
      v("term-bright-yellow", "bright yellow"),
      v("term-bright-blue", "bright blue"),
      v("term-bright-magenta", "bright magenta"),
      v("term-bright-cyan", "bright cyan"),
      v("term-bright-white", "bright white"),
    ],
  },
  {
    title: "Syntax",
    vars: [
      v("syntax-keyword", "keywords"),
      v("syntax-string", "strings"),
      v("syntax-number", "numbers"),
      v("syntax-comment", "comments"),
      v("syntax-function", "function names"),
      v("syntax-type", "types"),
      v("syntax-operator", "operators"),
      v("syntax-punctuation", "punctuation"),
      v("syntax-property", "properties and keys"),
      v("syntax-attribute", "attributes and decorators"),
      v("syntax-variable", "variables"),
      v("syntax-tag", "markup tags"),
      v("syntax-literal", "true, false, null"),
    ],
  },
];

export const THEME_VARS: readonly ThemeVar[] = THEME_VAR_GROUPS.flatMap((g) => g.vars);

export const THEME_VAR_NAMES: ReadonlySet<string> = new Set(THEME_VARS.map((t) => t.name));

/** Variables that hold a single colour (the editor checks their values parse as one). */
export function isColorVar(name: string): boolean {
  return name.startsWith("--color-") || name.startsWith("--term-") || name.startsWith("--syntax-");
}

/** Prefixes TeleFlock owns: an unknown name under one of these is almost certainly a typo. */
export const THEME_VAR_PREFIXES: readonly string[] = ["--color-", "--shadow-", "--term-", "--syntax-", "--tf-", "--st-"];

/** xterm `ITheme` keys, in ANSI order after the surface entries. */
export const TERMINAL_KEYS = [
  ["background", "--term-bg"],
  ["foreground", "--term-fg"],
  ["cursor", "--term-cursor"],
  ["cursorAccent", "--term-cursor-ink"],
  ["selectionBackground", "--term-selection"],
  ["black", "--term-black"],
  ["red", "--term-red"],
  ["green", "--term-green"],
  ["yellow", "--term-yellow"],
  ["blue", "--term-blue"],
  ["magenta", "--term-magenta"],
  ["cyan", "--term-cyan"],
  ["white", "--term-white"],
  ["brightBlack", "--term-bright-black"],
  ["brightRed", "--term-bright-red"],
  ["brightGreen", "--term-bright-green"],
  ["brightYellow", "--term-bright-yellow"],
  ["brightBlue", "--term-bright-blue"],
  ["brightMagenta", "--term-bright-magenta"],
  ["brightCyan", "--term-bright-cyan"],
  ["brightWhite", "--term-bright-white"],
] as const;

/** The 16 ANSI colours (normal 0–7, bright 8–15) as CSS variables, for HTML renderings of ANSI output. */
export const ANSI_VARS: readonly string[] = TERMINAL_KEYS.slice(5).map(([, name]) => `var(${name})`);
