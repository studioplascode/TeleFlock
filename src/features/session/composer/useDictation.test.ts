import { describe, expect, test } from "bun:test";
import { type Dictation, engineInUse } from "./useDictation";

describe("which engine the mic uses", () => {
  const engine = (listening: boolean): Dictation => ({ supported: true, listening, interim: "", error: null, openSettings: null, blocked: null, toggle: () => {} });

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
