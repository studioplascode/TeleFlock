import { describe, expect, test } from "bun:test";
import {
  type CustomTheme,
  INITIAL_THEME,
  MAX_CUSTOM_THEMES,
  type ThemeData,
  TRIAL_MS,
  choosePreset,
  endTrial,
  keepTrial,
  normalizeThemeData,
  putCustom,
  removeCustom,
  resetTheme,
  shownThemeCss,
  shownThemeId,
  tryCustom,
  uniqueName,
} from "./model";
import { presetById } from "./presets";

const theme = (id: string, css: string, name = id): CustomTheme => ({ id, name, css, base: "default", updatedAt: 1 });
const MINE = theme("custom-mine", ":root { --color-bg: #123456; }", "Mine");
const BROKEN = theme("custom-broken", ":root { background: url(https://example.com/a.png); }", "Broken");
const withThemes = (...t: CustomTheme[]): ThemeData => t.reduce(putCustom, INITIAL_THEME);

describe("theme state", () => {
  test("premade themes apply at once; unknown ids change nothing", () => {
    const d = choosePreset(INITIAL_THEME, "nord");
    expect(shownThemeId(d)).toBe("nord");
    expect(shownThemeCss(d)).toBe(presetById("nord")?.css ?? "missing");
    expect(choosePreset(d, "nope")).toBe(d);
  });

  test("a custom theme runs on trial: shown at once, confirmed only by Keep", () => {
    const start = choosePreset(withThemes(MINE), "dracula");
    const trial = tryCustom(start, MINE.id, 1000);
    if (!trial) throw new Error("trial refused");
    expect(shownThemeId(trial)).toBe(MINE.id);
    expect(shownThemeCss(trial)).toBe(MINE.css);
    expect(trial.active).toBe("dracula");
    expect(trial.trial?.until).toBe(1000 + TRIAL_MS);
    // not kept: Dracula is back
    expect(shownThemeId(endTrial(trial))).toBe("dracula");
    // kept: confirmed with a snapshot of its CSS
    const kept = keepTrial(trial);
    expect(kept).toMatchObject({ active: MINE.id, activeCss: MINE.css, trial: null });
  });

  test("what a launch applies is the confirmed snapshot, not the theme's latest text", () => {
    const kept = keepTrial(tryCustom(withThemes(MINE), MINE.id, 0) as ThemeData);
    const edited = putCustom(kept, { ...MINE, css: ":root { --color-bg: #ff0000; }" });
    expect(shownThemeCss(edited)).toBe(MINE.css);
  });

  test("a trial during a trial still goes back to the theme confirmed before both", () => {
    const other = theme("custom-other", ":root { --color-ink: #fff; }");
    const d = choosePreset(withThemes(MINE, other), "gruvbox");
    const second = tryCustom(tryCustom(d, MINE.id, 0) as ThemeData, other.id, 5) as ThemeData;
    expect(second.trial?.previous.active).toBe("gruvbox");
    expect(shownThemeId(endTrial(second))).toBe("gruvbox");
  });

  test("CSS with errors never goes on trial; missing themes neither", () => {
    expect(tryCustom(withThemes(BROKEN), BROKEN.id, 0)).toBeUndefined();
    expect(tryCustom(INITIAL_THEME, "custom-gone", 0)).toBeUndefined();
  });

  test("deleting the theme in use brings the default back", () => {
    const kept = keepTrial(tryCustom(withThemes(MINE), MINE.id, 0) as ThemeData);
    expect(removeCustom(kept, MINE.id)).toMatchObject({ active: "default", activeCss: undefined, custom: [] });
    const onTrial = tryCustom(choosePreset(withThemes(MINE), "nord"), MINE.id, 0) as ThemeData;
    expect(shownThemeId(removeCustom(onTrial, MINE.id))).toBe("nord");
  });

  test("reset keeps custom themes", () => {
    const kept = keepTrial(tryCustom(withThemes(MINE), MINE.id, 0) as ThemeData);
    expect(resetTheme(kept)).toMatchObject({ active: "default", activeCss: undefined, trial: null, custom: [MINE] });
  });

  test("names are unique among custom themes, case-insensitively, except for the theme itself", () => {
    const d = withThemes(MINE, theme("custom-2", "", "Mine 2"));
    expect(uniqueName(d, "mine")).toBe("mine 3");
    expect(uniqueName(d, "Mine", MINE.id)).toBe("Mine");
    expect(uniqueName(d, "  ")).toBe("My theme");
  });
});

describe("normalizeThemeData (what storage gives back)", () => {
  test("keeps valid data", () => {
    expect(normalizeThemeData({ active: MINE.id, activeCss: MINE.css, custom: [MINE] })).toEqual({ active: MINE.id, activeCss: MINE.css, custom: [MINE] });
    expect(normalizeThemeData({ active: "nord", custom: [] })).toEqual({ active: "nord", custom: [] });
  });

  test("drops malformed entries and caps the list", () => {
    const many = Array.from({ length: MAX_CUSTOM_THEMES + 5 }, (_, i) => theme(`custom-${i}`, ""));
    const out = normalizeThemeData({ active: "default", custom: [null, { id: "nord", name: "x", css: "" }, { id: "custom-x" }, ...many] });
    expect(out.custom).toHaveLength(MAX_CUSTOM_THEMES);
    expect(out.custom[0]?.id).toBe("custom-0");
  });

  test("a custom active theme needs its confirmed CSS, without errors; otherwise the default", () => {
    expect(normalizeThemeData({ active: MINE.id, custom: [MINE] }).active).toBe("default");
    expect(normalizeThemeData({ active: BROKEN.id, activeCss: BROKEN.css, custom: [BROKEN] }).active).toBe("default");
    expect(normalizeThemeData({ active: "custom-gone", activeCss: MINE.css, custom: [] }).active).toBe("default");
    expect(normalizeThemeData("garbage")).toEqual({ active: "default", custom: [] });
  });
});
