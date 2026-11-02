import { describe, expect, test } from "bun:test";
import { type Dictation, engineInUse, micPermissionNotice } from "./useDictation";

describe("Android microphone refusal", () => {
  test("denied for good: offers the app's settings, the only place left to grant it", () => {
    expect(micPermissionNotice("denied")).toEqual({ message: "Microphone access is blocked.", settings: true });
  });

  test("denied once (or the prompt dismissed): explains, and the next tap asks again", () => {
    for (const state of ["prompt-with-rationale", "prompt"] as const) {
      expect(micPermissionNotice(state)).toEqual({ message: "Dictation needs the microphone. Tap the mic to allow it.", settings: false });
    }
  });
});

describe("which engine the mic uses", () => {
  const engine = (listening: boolean): Dictation => ({ supported: true, listening, interim: "", error: null, openSettings: null, toggle: () => {} });

  test("the app core's engine once a speech model is chosen, the platform's (Web Speech, Android's recognizer) otherwise", () => {
    const device = { ...engine(false), active: true };
    const platform = engine(false);
    expect(engineInUse(device, platform)).toBe(device);
    expect(engineInUse({ ...device, active: false }, platform)).toBe(platform);
  });

  test("a session keeps its engine until it ends: choosing or deleting a model meanwhile doesn't cut it off", () => {
    // A model was chosen while the platform's recognizer was listening.
    const platform = engine(true);
    expect(engineInUse({ ...engine(false), active: true }, platform)).toBe(platform);
    // The chosen model was deleted while the app core's engine was listening.
    const device = { ...engine(true), active: false };
    expect(engineInUse(device, engine(false))).toBe(device);
  });
});
