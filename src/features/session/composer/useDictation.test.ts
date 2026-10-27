import { describe, expect, test } from "bun:test";
import { micPermissionNotice } from "./useDictation";

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
