import { describe, expect, test } from "bun:test";
import type { DictationMicrophoneAccess } from "@/core/gen";
import { androidMicBlock, micBlock, refusedBlock } from "./micAccess";

const access = (over: Partial<DictationMicrophoneAccess>): DictationMicrophoneAccess => ({ access: "granted", system: "windows", settings: true, windowBlocked: false, ...over });

describe("what blocks the microphone", () => {
  test("the system's privacy setting: says which system, and the button opens its microphone page", () => {
    expect(micBlock(access({ access: "denied" }), "engine")).toEqual({
      by: "system",
      title: "Windows blocks the microphone for TeleFlock.",
      detail: "Turn on Let desktop apps access your microphone, and TeleFlock where it is listed, in Settings → Privacy & security → Microphone.",
      action: { label: "Open Windows settings", run: "settings" },
    });
    expect(micBlock(access({ access: "denied", system: "macos" }), "engine")).toMatchObject({ title: "macOS blocks the microphone for TeleFlock.", action: { label: "Open System Settings", run: "settings" } });
    // A core that can't open the page (a devserver) still says where it is undone.
    expect(micBlock(access({ access: "denied", settings: false }), "engine")?.action).toBeNull();
  });

  test("nothing while the system allows it, will ask, or keeps no such setting", () => {
    for (const a of ["granted", "prompt", "unknown"] as const) expect(micBlock(access({ access: a }), "window")).toBeNull();
    expect(micBlock(access({ access: "denied", system: "linux", settings: false }), "window")).toBeNull();
  });

  test("the window's own Block matters only to the window's speech recognition, and comes after the system's", () => {
    const window = access({ windowBlocked: true });
    expect(micBlock(window, "window")).toMatchObject({ by: "window", action: { label: "Allow the microphone", run: "allowWindow" } });
    // The app core's engine records itself: WebView2's Block doesn't keep it from the microphone.
    expect(micBlock(window, "engine")).toBeNull();
    // Both: the system's first (allowing the window would change nothing yet); the next check finds the window's.
    expect(micBlock({ ...window, access: "denied" }, "window")?.by).toBe("system");
  });

  test("a start the system refused is its block even when the setting couldn't be read; a Linux device's refusal stays its error", () => {
    expect(refusedBlock(access({ access: "unknown" }))?.title).toBe("Windows blocks the microphone for TeleFlock.");
    expect(refusedBlock(access({ access: "granted", system: "macos" }))?.by).toBe("system");
    expect(refusedBlock(access({ access: "unknown", system: "linux", settings: false }))).toBeNull();
  });

  test("Android: blocked for good only once the prompt no longer shows; the button opens the app's info", () => {
    expect(androidMicBlock("denied")).toMatchObject({ title: "Android blocks the microphone for TeleFlock.", action: { label: "Open Android settings", run: "settings" } });
    // Denied once, or the prompt dismissed: the next tap asks again.
    for (const state of ["prompt", "prompt-with-rationale", "granted"] as const) expect(androidMicBlock(state)).toBeNull();
  });
});
