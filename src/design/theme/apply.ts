import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useSyncExternalStore } from "react";
import { isAndroid, isTauri } from "../lib/platform";
import { toast } from "../ui/Toast";
import { parseColor } from "./color";
import { hasErrors, inspectThemeCss, scopeThemeCss } from "./css";
import { shownThemeCss, shownThemeId } from "./model";
import { presetById } from "./presets";
import { THEME_STORAGE_KEY, useThemeStore } from "./store";
import { watchThemeTrials } from "./trial";
import { THEME_VAR_NAMES } from "./vars";

/** The theme's own <style>: always the last element of <head>, after every app stylesheet. */
const STYLE_ID = "tf-theme";
/** Marks preview <style> elements (picker cards, the editor), which `readThemeDefaults` skips. */
export const PREVIEW_STYLE_ATTR = "data-theme-preview-style";

let version = 0;
const listeners = new Set<() => void>();

/**
 * Puts a theme's CSS on the page. CSS with errors (network loads, broken blocks) is never applied:
 * the page falls back to the default theme instead.
 */
function applyTheme(css: string, id: string): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
  }
  const text = css && !hasErrors(inspectThemeCss(css)) ? css : "";
  if (style.textContent !== text) style.textContent = text;
  if (document.head.lastElementChild !== style) document.head.appendChild(style);
  document.documentElement.dataset.theme = id;
  const root = getComputedStyle(document.documentElement);
  const scheme = root.colorScheme.includes("light") ? "light" : "dark";
  setMeta("color-scheme", scheme);
  setMeta("theme-color", root.getPropertyValue("--color-chrome").trim() || root.getPropertyValue("--color-bg").trim());
  syncNativeBackground();
  version++;
  for (const l of listeners) l();
}

function setMeta(name: string, content: string): void {
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (meta && content && meta.content !== content) meta.content = content;
}

let nativeBackground = "";

/**
 * Desktop app: the native window and webview background (what shows before the page paints and in
 * areas a resize exposes) takes the theme's `--color-bg`, so a light theme doesn't flash dark on a
 * reload or resize. A new window still opens with tauri.conf.json's colour until the page runs.
 */
function syncNativeBackground(): void {
  if (!isTauri() || isAndroid) return;
  const c = parseColor(readThemeColor("--color-bg", "#0b0b10"));
  if (!c) return;
  const rgba: [number, number, number, number] = [Math.round(c.r), Math.round(c.g), Math.round(c.b), 255];
  const key = rgba.join(",");
  if (key === nativeBackground) return;
  nativeBackground = key;
  void getCurrentWebviewWindow()
    .setBackgroundColor(rgba)
    .catch(() => {});
}

/** Ctrl+Alt+Shift+T (⌘⌥⇧T): the default theme, whatever the current one hides. */
function isEscapeChord(e: KeyboardEvent): boolean {
  return e.code === "KeyT" && e.altKey && e.shiftKey && (e.ctrlKey || e.metaKey);
}

export const THEME_ESCAPE_KEYS = "Ctrl+Alt+Shift+T";

function resetToDefault(why: string): void {
  useThemeStore.getState().reset();
  toast({ title: `Theme reset to ${presetById("default")?.name ?? "the default"}`, description: `${why}. Your themes are still in Settings → Appearance.`, status: "done" });
}

/**
 * Applies the theme before the first paint and keeps it applied. Call once per page, before
 * rendering. `owner` (the main window) also handles the escapes: `?theme=default` in the address
 * resets to the default theme at start, and Ctrl+Alt+Shift+T does at any time. Every page follows
 * changes another window or tab writes to storage (the Quick capture window follows the main window).
 */
export function startTheme({ owner }: { owner: boolean }): void {
  if (owner && new URLSearchParams(window.location.search).get("theme") === "default") resetToDefault("Started with ?theme=default");
  const apply = () => {
    const s = useThemeStore.getState();
    applyTheme(shownThemeCss(s), shownThemeId(s));
  };
  apply();
  useThemeStore.subscribe((s, prev) => {
    if (shownThemeCss(s) !== shownThemeCss(prev) || shownThemeId(s) !== shownThemeId(prev)) apply();
  });
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_STORAGE_KEY) void useThemeStore.persist.rehydrate();
  });
  if (!owner) return;
  watchThemeTrials();
  window.addEventListener(
    "keydown",
    (e) => {
      if (!isEscapeChord(e)) return;
      e.preventDefault();
      e.stopPropagation();
      resetToDefault(`${THEME_ESCAPE_KEYS} pressed`);
    },
    true,
  );
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Changes whenever the applied theme does; for components that read theme variables in JS. */
export function useThemeVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

/** Calls `cb` after every theme change. Returns the unsubscribe. */
export function onThemeChange(cb: () => void): () => void {
  return subscribe(cb);
}

/** A theme variable's current value (`--term-bg` → `#07070b`), for canvas, SVG and xterm. */
export function readThemeVar(name: string, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

let probe: CanvasRenderingContext2D | null | undefined;

/** A theme variable as `rgba(r, g, b, a)`, the one format every consumer parses (xterm takes only hex and comma rgba). */
export function readThemeColor(name: string, fallback: string): string {
  return resolveColor(readThemeVar(name), fallback);
}

/**
 * Any CSS colour as `rgba(r, g, b, a)`. Forms we don't parse (`oklch()`, names) go through a 1×1
 * canvas; a value that isn't a colour gives `fallback`.
 */
export function resolveColor(value: string, fallback: string): string {
  value = value || fallback;
  const c = parseColor(value);
  if (c) return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+c.a.toFixed(3)})`;
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return fallback;
  probe.fillStyle = fallback;
  probe.fillStyle = value; // an invalid colour leaves the fallback
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 255] = probe.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
}

/**
 * The default theme's value of every theme variable, as written in the app's stylesheets
 * (tokens.css): derived ones stay derived (`--term-bg: var(--color-bg-deep)`). Read from the CSSOM,
 * skipping the applied theme and previews, so it is right whatever theme is on screen.
 */
export function readThemeDefaults(): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        if (!rule.selectorText.split(",").some((s) => s.trim() === ":root")) continue;
        for (let i = 0; i < rule.style.length; i++) {
          const prop = rule.style.item(i);
          if (THEME_VAR_NAMES.has(prop)) out.set(prop, rule.style.getPropertyValue(prop).trim());
        }
      } else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    const node = sheet.ownerNode;
    if (node instanceof Element && (node.id === STYLE_ID || node.hasAttribute(PREVIEW_STYLE_ATTR))) continue;
    try {
      visit(sheet.cssRules);
    } catch {
      // a cross-origin sheet: never one of ours
    }
  }
  return out;
}

/**
 * CSS that shows `css` (a theme) inside the element matching `scope`, which must also carry
 * `.tf-theme-scope`: every variable starts from the default theme, then the theme's own rules
 * apply, confined to the element. "" when the theme has errors.
 */
export function previewCss(css: string, scope: string, defaults: ReadonlyMap<string, string>): string {
  const scoped = css ? scopeThemeCss(css, scope) : "";
  if (css && !scoped) return "";
  const base = [...defaults].map(([k, v]) => `${k}: ${v};`).join(" ");
  return `${scope} { color-scheme: dark; ${base} }\n${scoped}`;
}
