import { type CustomTheme, inspectThemeCss, isAndroid, isTauri, MAX_THEME_LENGTH, presetById, themeFileName, themeTemplate, withThemeName } from "@/design";
import { themeDefaults } from "./ThemePreview";

/** The Android app's WebView has no downloads: themes leave it through the clipboard. */
export const canDownloadThemes = !(isTauri() && isAndroid);

/**
 * The CSS a new theme starts with. From a premade theme: every variable TeleFlock reads with that
 * theme's value (the template). From a custom theme: its own CSS, renamed.
 */
export function startingCss(baseId: string, name: string, custom: readonly CustomTheme[]): string {
  const preset = presetById(baseId);
  if (!preset) {
    const theme = custom.find((t) => t.id === baseId);
    return withThemeName(theme?.css ?? "", name);
  }
  const values = new Map(themeDefaults());
  const info = inspectThemeCss(preset.css);
  for (const [k, v] of info.vars) values.set(k, v);
  return themeTemplate({ name, base: preset.name, scheme: info.colorScheme ?? preset.scheme, values });
}

/** Saves the theme as `<name>.css` through a download (browsers; desktop webviews save to Downloads). */
export function downloadTheme(name: string, css: string): string {
  const file = themeFileName(name);
  const url = URL.createObjectURL(new Blob([css], { type: "text/css" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking at once can cancel a download that has not started reading yet.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return file;
}

/** Lets the user pick a `.css` file; resolves with its name and text, or null when cancelled. */
export function pickThemeFile(): Promise<{ name: string; text: string } | null> {
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".css,text/css";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      if (file.size > MAX_THEME_LENGTH * 4) return reject(new Error(`${file.name} is ${Math.round(file.size / 1024)} KB; themes can be up to ${MAX_THEME_LENGTH / 1024} KB.`));
      file.text().then((text) => resolve({ name: file.name, text }), reject);
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    document.body.append(input);
    input.click();
  });
}

/** The clipboard's text, or null when the platform refuses to read it (the user pastes by hand then). */
export async function readClipboardText(): Promise<string | null> {
  try {
    return (await navigator.clipboard?.readText?.()) ?? null;
  } catch {
    return null;
  }
}
