import { describe, expect, test } from "bun:test";
import type { DictationModel, DictationState } from "@/core/gen";
import { downloadPercent, heardLanguage, languageNote, languageOptions, onDevicePick, takeoverAfterRemoving } from "./models";

function model(id: string, extra: Partial<DictationModel> = {}): DictationModel {
  return { id, name: id, summary: "", languages: "", languageCodes: ["en"], autoLanguage: true, takesLanguage: false, size: 1000, ramMb: 300, speed: 4, accuracy: 4, notes: "", recommended: false, phase: "available", ...extra };
}

function state(models: DictationModel[], selected?: string, language = "auto"): DictationState {
  return {
    supported: true,
    device: "desktop",
    models,
    ...(selected ? { selected } : {}),
    language,
    languages: [
      { code: "auto", name: "Detect automatically" },
      { code: "en", name: "English" },
      { code: "de", name: "German" },
      { code: "fr", name: "French" },
      { code: "it", name: "Italian" },
      { code: "ja", name: "Japanese" },
    ],
    engine: "sherpa-onnx 2.0.1",
  };
}

const installed = { phase: "installed" } as const;

describe("which model dictates", () => {
  test("On this device picks the recommended model when it is installed, else the first installed one in catalog order", () => {
    const parakeet = model("parakeet", { recommended: true });
    expect(onDevicePick(state([parakeet, model("canary", installed), model("whisper", installed)]))?.id).toBe("canary");
    expect(onDevicePick(state([{ ...parakeet, ...installed }, model("canary", installed)]))?.id).toBe("parakeet");
    expect(onDevicePick(state([parakeet, model("canary", { phase: "downloading", downloaded: 10 })]))).toBeNull();
  });

  test("deleting the chosen model hands over as the app core does: the recommended installed one, else the first, else none", () => {
    const models = [model("parakeet", { recommended: true, ...installed }), model("canary", installed), model("whisper", installed)];
    expect(takeoverAfterRemoving(state(models, "whisper"), "whisper")?.id).toBe("parakeet");
    expect(takeoverAfterRemoving(state(models, "parakeet"), "parakeet")?.id).toBe("canary");
    expect(takeoverAfterRemoving(state([model("canary", installed)], "canary"), "canary")).toBeNull();
    // Deleting another one keeps the choice.
    expect(takeoverAfterRemoving(state(models, "whisper"), "canary")?.id).toBe("whisper");
  });
});

describe("Settings → Dictation", () => {
  test("download progress: none without bytes on disk, never 100 % before the last byte", () => {
    expect(downloadPercent(model("m"))).toBeNull();
    expect(downloadPercent(model("m", { phase: "downloading", downloaded: 0 }))).toBe(0);
    expect(downloadPercent(model("m", { phase: "downloading", downloaded: 999 }))).toBe(99);
    // An interrupted download shows where it resumes.
    expect(downloadPercent(model("m", { downloaded: 250 }))).toBe(25);
    expect(downloadPercent(model("m", { downloaded: 5, size: 0 }))).toBeNull();
  });

  test("the language a model hears follows tf-dictation's rule: a model that needs one gets the device's, else its first", () => {
    const canary = model("canary", { languageCodes: ["en", "de", "fr", "es"], autoLanguage: false, takesLanguage: true });
    const whisper = model("whisper", { languageCodes: ["en", "de", "fr", "it", "ja"], takesLanguage: true });
    expect(["de-AT", "fr_CA", "ja-JP"].map((locale) => heardLanguage(canary, "auto", locale))).toEqual(["de", "fr", "en"]);
    expect([heardLanguage(canary, "fr", "de-DE"), heardLanguage(canary, "it", "de-DE")]).toEqual(["fr", "en"]);
    expect([heardLanguage(whisper, "auto", "de-DE"), heardLanguage(whisper, "it", "de-DE"), heardLanguage(whisper, "es", "de-DE")]).toEqual([null, "it", null]);
  });

  test("the language list holds what the chosen model can be told; a choice it doesn't know stays, marked, and the note says what it hears instead", () => {
    const canary = model("canary", { name: "Canary", languageCodes: ["en", "de", "fr", "es"], autoLanguage: false, takesLanguage: true });
    const codes = (s: DictationState, m: DictationModel | null) => languageOptions(s, m).map((l) => (l.fits ? l.code : `${l.code}?`));
    expect(codes(state([canary]), canary)).toEqual(["auto", "en", "de", "fr"]);
    // Italian was chosen for Whisper: Canary can't be told it and listens for English.
    const italian = state([canary], undefined, "it");
    expect(codes(italian, canary)).toEqual(["auto", "en", "de", "fr", "it?"]);
    expect(languageNote(canary, italian, "de-DE")).toBe("Canary doesn't know Italian: it listens for English.");
    expect(languageNote(canary, state([canary], undefined, "fr"), "de-DE")).toBe("Canary listens for French only.");
    expect(languageNote(canary, state([canary]), "de-AT")).toBe("Canary needs a language: it listens for German, your device's, unless you choose another.");
    expect(languageNote(canary, state([canary]), "ja-JP")).toBe("Canary needs a language: it listens for English, as it doesn't know your device's.");
    // Models that ignore the choice list everything (the choice is the device's, for the next model) and say so.
    const parakeet = model("parakeet", { name: "Parakeet", languageCodes: ["en", "de"] });
    expect(codes(italian, parakeet)).toEqual(["auto", "en", "de", "fr", "it", "ja"]);
    expect(languageNote(parakeet, italian, "de-DE")).toBe("Parakeet hears the language you speak by itself and ignores this.");
    expect(languageNote(model("moonshine", { name: "Moonshine" }), italian, "de-DE")).toBe("Moonshine hears English only.");
    // Whisper detects unless told; told a language it keeps to it.
    const whisper = model("whisper", { name: "Whisper", languageCodes: ["en", "de", "fr", "it", "ja"], takesLanguage: true });
    expect(languageNote(whisper, state([whisper]), "de-DE")).toBe("Whisper detects the language by itself; choose one to keep it from switching mid-sentence.");
    expect(languageNote(whisper, italian, "de-DE")).toBe("Whisper listens for Italian only.");
  });
});
