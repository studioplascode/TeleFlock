/**
 * Theme state, pure: which theme is in use, the user's custom themes, and the trial a newly
 * applied custom theme runs before it sticks. The zustand store (store.ts) persists `active`,
 * `activeCss` and `custom`; a trial is never persisted, so a restart during one starts with the
 * theme that was confirmed before it.
 */

import { hasErrors, inspectThemeCss } from "./css";
import { DEFAULT_THEME_ID, presetById } from "./presets";

export interface CustomTheme {
  /** `custom-…`; never a preset id. */
  id: string;
  name: string;
  css: string;
  /** Preset id it started from. */
  base: string;
  updatedAt: number;
}

export interface ThemeTrial {
  id: string;
  /** The CSS on trial (a custom theme's text at the moment it was applied). */
  css: string;
  /** The confirmed theme that comes back unless the trial is kept. */
  previous: { active: string; activeCss?: string };
  /** Epoch ms when it goes back by itself. */
  until: number;
}

export interface ThemeData {
  /** Confirmed theme: a preset id or a custom theme id. */
  active: string;
  /** For a custom `active`: the CSS confirmed with Keep. What a launch applies, whatever the theme's text says now. */
  activeCss?: string;
  custom: CustomTheme[];
  trial: ThemeTrial | null;
}

/** How long a newly applied custom theme waits for Keep before it goes back. */
export const TRIAL_MS = 15_000;
/** Keeps localStorage well under its ~5 MB quota (each theme is at most 64 KB). */
export const MAX_CUSTOM_THEMES = 30;

export const INITIAL_THEME: ThemeData = { active: DEFAULT_THEME_ID, custom: [], trial: null };

/** The theme on screen: the one on trial, else the confirmed one. */
export function shownThemeId(d: ThemeData): string {
  return d.trial?.id ?? d.active;
}

/** The CSS on screen. A confirmed custom theme applies its confirmed snapshot. */
export function shownThemeCss(d: ThemeData): string {
  if (d.trial) return d.trial.css;
  const preset = presetById(d.active);
  if (preset) return preset.css;
  return d.activeCss ?? "";
}

export function customById(d: ThemeData, id: string): CustomTheme | undefined {
  return d.custom.find((t) => t.id === id);
}

/** A premade theme, at once and for good (they are curated, so no trial). */
export function choosePreset(d: ThemeData, id: string): ThemeData {
  if (!presetById(id)) return d;
  return { ...d, active: id, activeCss: undefined, trial: null };
}

/**
 * Puts a custom theme on trial with its current text. Undefined when it doesn't exist or its CSS
 * has errors. A trial started during another keeps the original confirmed theme to go back to.
 */
export function tryCustom(d: ThemeData, id: string, now: number): ThemeData | undefined {
  const theme = customById(d, id);
  if (!theme || hasErrors(inspectThemeCss(theme.css))) return undefined;
  const previous = d.trial ? d.trial.previous : { active: d.active, activeCss: d.activeCss };
  return { ...d, trial: { id, css: theme.css, previous, until: now + TRIAL_MS } };
}

/** Keep: the trial becomes the confirmed theme. */
export function keepTrial(d: ThemeData): ThemeData {
  if (!d.trial) return d;
  return { ...d, active: d.trial.id, activeCss: d.trial.css, trial: null };
}

/** Go back to the confirmed theme. */
export function endTrial(d: ThemeData): ThemeData {
  return d.trial ? { ...d, trial: null } : d;
}

/** The default theme, confirmed; any trial ends. Custom themes stay. */
export function resetTheme(d: ThemeData): ThemeData {
  return { ...d, active: DEFAULT_THEME_ID, activeCss: undefined, trial: null };
}

/** `name`, or `name 2`, `name 3`… when another custom theme (other than `exceptId`) has it. */
export function uniqueName(d: ThemeData, name: string, exceptId?: string): string {
  const base = name.trim() || "My theme";
  const taken = new Set(d.custom.filter((t) => t.id !== exceptId).map((t) => t.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Adds or updates a custom theme (by `theme.id`), newest first. */
export function putCustom(d: ThemeData, theme: CustomTheme): ThemeData {
  const rest = d.custom.filter((t) => t.id !== theme.id);
  return { ...d, custom: [theme, ...rest] };
}

/** Removes a custom theme; if it was in use (confirmed or on trial) the default comes back. */
export function removeCustom(d: ThemeData, id: string): ThemeData {
  const custom = d.custom.filter((t) => t.id !== id);
  const trial = d.trial?.id === id ? null : d.trial;
  if (d.active === id) return { ...d, custom, active: DEFAULT_THEME_ID, activeCss: undefined, trial };
  const previous = trial?.previous.active === id ? { active: DEFAULT_THEME_ID } : trial?.previous;
  return { ...d, custom, trial: trial && previous ? { ...trial, previous } : trial };
}

/** Persisted fields read back from storage, with anything malformed dropped. */
export function normalizeThemeData(raw: unknown): Pick<ThemeData, "active" | "activeCss" | "custom"> {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const custom = (Array.isArray(obj.custom) ? obj.custom : [])
    .filter((t): t is CustomTheme => {
      if (typeof t !== "object" || t === null) return false;
      const c = t as Record<string, unknown>;
      return typeof c.id === "string" && c.id.startsWith("custom-") && typeof c.name === "string" && typeof c.css === "string";
    })
    .map((t) => ({ id: t.id, name: t.name, css: t.css, base: typeof t.base === "string" ? t.base : DEFAULT_THEME_ID, updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : 0 }))
    .slice(0, MAX_CUSTOM_THEMES);
  const active = typeof obj.active === "string" ? obj.active : DEFAULT_THEME_ID;
  if (presetById(active)) return { active, custom };
  const activeCss = typeof obj.activeCss === "string" ? obj.activeCss : undefined;
  if (custom.some((t) => t.id === active) && activeCss !== undefined && !hasErrors(inspectThemeCss(activeCss))) return { active, activeCss, custom };
  return { active: DEFAULT_THEME_ID, custom };
}

export function newThemeId(): string {
  return `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
