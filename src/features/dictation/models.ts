import type { DictationModel, DictationState } from "@/core/gen";

/** Each utterance costs this model seconds on a CPU (`speed` 1–5): too slow for live dictation. */
export function isSlow(m: DictationModel): boolean {
  return m.speed <= 2;
}

/** The installed models, the one recommended for this device first, then in catalog order. */
function installedFirstRecommended(state: DictationState, except?: string): DictationModel[] {
  const installed = state.models.filter((m) => m.phase === "installed" && m.id !== except);
  return [...installed.filter((m) => m.recommended), ...installed.filter((m) => !m.recommended)];
}

/** The model "On this device" switches to from the system's recognition: the recommended one when installed, else the first installed. */
export function onDevicePick(state: DictationState): DictationModel | null {
  return installedFirstRecommended(state)[0] ?? null;
}

/** The model that takes over when the chosen one `id` is deleted (as the app core decides it); null: none, the system's recognition. */
export function takeoverAfterRemoving(state: DictationState, id: string): DictationModel | null {
  if (state.selected !== id) return state.models.find((m) => m.id === state.selected) ?? null;
  return installedFirstRecommended(state, id)[0] ?? null;
}

/** How far a download got, 0–100 (downloading, or interrupted and resumable); null: none. */
export function downloadPercent(m: DictationModel): number | null {
  if (m.downloaded == null || m.size <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((m.downloaded / m.size) * 100)));
}

/** The device locale's language (`de-DE` → `de`). */
function localeLanguage(locale: string): string {
  return locale.split(/[-_]/)[0]?.toLowerCase() ?? "";
}

/**
 * The language `model` listens for with the choice `chosen` (`auto` or a code) on a device with `locale`; null: it
 * detects the language itself. Mirrors tf-dictation's `Model::language_for`, for models that take a language.
 */
export function heardLanguage(model: DictationModel, chosen: string, locale: string): string | null {
  const first = model.languageCodes[0] ?? "en";
  if (chosen !== "auto") return model.languageCodes.includes(chosen) ? chosen : model.autoLanguage ? null : first;
  if (model.autoLanguage) return null;
  const device = localeLanguage(locale);
  return model.languageCodes.includes(device) ? device : first;
}

/** The languages Settings offers: for a model that takes a language, the ones it knows (`fits`), plus the current choice when it doesn't (made for another model); otherwise all. */
export function languageOptions(state: DictationState, model: DictationModel | null): { code: string; name: string; fits: boolean }[] {
  const fits = (code: string) => code === "auto" || !model?.takesLanguage || model.languageCodes.includes(code);
  return state.languages.filter((l) => fits(l.code) || l.code === state.language).map((l) => ({ ...l, fits: fits(l.code) }));
}

/** What the language choice does for `model` (Settings' description). `locale`: the device's (`de-DE`). */
export function languageNote(model: DictationModel | null, state: DictationState, locale: string): string {
  if (!model) return "The language you speak, for the models that need it.";
  const name = (code: string) => state.languages.find((l) => l.code === code)?.name ?? code;
  if (!model.takesLanguage) return `${model.name} hears ${model.languageCodes.length > 1 ? "the language you speak by itself and ignores this" : `${name(model.languageCodes[0] ?? "en")} only`}.`;
  const chosen = state.language;
  const heard = heardLanguage(model, chosen, locale);
  if (chosen !== "auto") {
    if (heard === chosen) return `${model.name} listens for ${name(chosen)} only.`;
    return `${model.name} doesn't know ${name(chosen)}: ${heard === null ? "it detects the language by itself" : `it listens for ${name(heard)}`}.`;
  }
  if (heard === null) return `${model.name} detects the language by itself; choose one to keep it from switching mid-sentence.`;
  return heard === localeLanguage(locale)
    ? `${model.name} needs a language: it listens for ${name(heard)}, your device's, unless you choose another.`
    : `${model.name} needs a language: it listens for ${name(heard)}, as it doesn't know your device's.`;
}
