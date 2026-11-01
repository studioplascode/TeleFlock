import { create } from "zustand";
import { persist } from "zustand/middleware";
import { hasErrors, inspectThemeCss, withThemeName } from "./css";
import {
  type CustomTheme,
  INITIAL_THEME,
  MAX_CUSTOM_THEMES,
  type ThemeData,
  choosePreset,
  customById,
  endTrial,
  keepTrial,
  newThemeId,
  normalizeThemeData,
  putCustom,
  removeCustom,
  resetTheme,
  tryCustom,
  uniqueName,
} from "./model";
import { presetById } from "./presets";

/**
 * localStorage key. Themes are a per-device frontend preference like `tf.motion` and `tf.prefs`,
 * not app Settings: they must apply before the first paint (Settings arrive from the core
 * asynchronously), the Quick capture window reads them without starting the core, a devserver
 * shared by several browsers keeps one theme per browser, and nothing crosses the wire.
 */
export const THEME_STORAGE_KEY = "tf.theme";

export type ThemeResult = { ok: true; id: string } | { ok: false; error: string };

export interface ThemeStore extends ThemeData {
  /** Use a theme: a premade one at once, a custom one on trial (Keep within 15 s). */
  choose(id: string): ThemeResult;
  keep(): void;
  /** End a trial: back to the confirmed theme. */
  goBack(): void;
  /** Adds a custom theme (not applied). The name is made unique and written into the CSS header. */
  create(input: { name: string; css: string; base: string }): ThemeResult;
  /** Saves a custom theme's name and/or CSS; a changed theme that is on screen goes on trial with the new CSS. */
  update(id: string, patch: { name?: string; css?: string }): ThemeResult;
  remove(id: string): void;
  /** Back to the default theme; custom themes stay. */
  reset(): void;
}

function firstError(css: string): string | undefined {
  const issue = inspectThemeCss(css).issues.find((i) => i.severity === "error");
  return issue && `Line ${issue.line}: ${issue.message}`;
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      ...INITIAL_THEME,
      choose(id) {
        const d = get();
        if (presetById(id)) {
          set(choosePreset(d, id));
          return { ok: true, id };
        }
        const theme = customById(d, id);
        if (!theme) return { ok: false, error: "That theme no longer exists." };
        const next = tryCustom(d, id, Date.now());
        if (!next) return { ok: false, error: firstError(theme.css) ?? "This theme can't be applied." };
        set(next);
        return { ok: true, id };
      },
      keep() {
        set(keepTrial(get()));
      },
      goBack() {
        set(endTrial(get()));
      },
      create({ name, css, base }) {
        const d = get();
        if (d.custom.length >= MAX_CUSTOM_THEMES) return { ok: false, error: `You have ${MAX_CUSTOM_THEMES} themes: delete one first.` };
        const error = firstError(css);
        if (error) return { ok: false, error };
        const unique = uniqueName(d, name);
        const theme: CustomTheme = { id: newThemeId(), name: unique, css: withThemeName(css, unique), base, updatedAt: Date.now() };
        set(putCustom(d, theme));
        return { ok: true, id: theme.id };
      },
      update(id, patch) {
        const d = get();
        const theme = customById(d, id);
        if (!theme) return { ok: false, error: "That theme no longer exists." };
        const name = patch.name !== undefined ? uniqueName(d, patch.name, id) : theme.name;
        const css = withThemeName(patch.css ?? theme.css, name);
        const error = firstError(css);
        if (error) return { ok: false, error };
        let next = putCustom(d, { ...theme, name, css, updatedAt: Date.now() });
        const onScreen = (next.trial?.id ?? next.active) === id;
        const shown = next.trial?.id === id ? next.trial.css : next.activeCss;
        if (onScreen && shown !== css && !hasErrors(inspectThemeCss(css))) next = tryCustom(next, id, Date.now()) ?? next;
        set(next);
        return { ok: true, id };
      },
      remove(id) {
        set(removeCustom(get(), id));
      },
      reset() {
        set(resetTheme(get()));
      },
    }),
    {
      name: THEME_STORAGE_KEY,
      version: 1,
      partialize: ({ active, activeCss, custom }) => ({ active, activeCss, custom }),
      merge: (persisted, current) => ({ ...current, ...normalizeThemeData(persisted) }),
    },
  ),
);

// A trial goes back by itself when its time is up.
let trialTimer: ReturnType<typeof setTimeout> | undefined;
useThemeStore.subscribe((s, prev) => {
  if (s.trial === prev.trial) return;
  clearTimeout(trialTimer);
  const trial = s.trial;
  if (!trial) return;
  trialTimer = setTimeout(
    () => {
      if (useThemeStore.getState().trial === trial) useThemeStore.getState().goBack();
    },
    Math.max(0, trial.until - Date.now()),
  );
});
