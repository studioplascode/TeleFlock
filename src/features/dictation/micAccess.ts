import type { DictationMicrophoneAccess } from "@/core/gen";

/*
 * What keeps the microphone from TeleFlock, said plainly, with the one button that undoes it from here
 * (docs/architecture.md §6.16). The system decides for the app (Windows' and macOS' privacy settings, Android's
 * permission): none of them asks again once refused, and no app may change the answer, so the button opens the
 * system's page. The window's own Block (WebView2's prompt, raised by the window's speech recognition) is
 * TeleFlock's to lift. A Linux desktop keeps no such setting: a device's refusal is shown as its error.
 */

/** Android's RECORD_AUDIO as the TeleFlock plugin reports it (`microphone_permission`, `request_microphone_permission`). */
export type AndroidMicPermission = "granted" | "denied" | "prompt" | "prompt-with-rationale";

export interface MicBlock {
  /** `system`: the system's privacy setting (or Android's permission); `window`: the window's own remembered Block. */
  by: "system" | "window";
  /** Who blocks it: "Windows blocks the microphone for TeleFlock." */
  title: string;
  /** Where it is undone, step by step. */
  detail: string;
  /** The button: opens the system's microphone settings (Android: the app's), or allows the window's microphone. Null: nothing here can open them (the detail says where). */
  action: { label: string; run: "settings" | "allowWindow" } | null;
}

/** Which blocks matter: the app core's engine records itself (the system's setting only); the window's speech recognition records through the window (both). */
export type MicScope = "engine" | "window";

const SYSTEM: Record<string, { title: string; detail: string; label: string }> = {
  windows: {
    title: "Windows blocks the microphone for TeleFlock.",
    detail: "Turn on Let desktop apps access your microphone, and TeleFlock where it is listed, in Settings → Privacy & security → Microphone.",
    label: "Open Windows settings",
  },
  macos: {
    title: "macOS blocks the microphone for TeleFlock.",
    detail: "Turn on TeleFlock in System Settings → Privacy & Security → Microphone.",
    label: "Open System Settings",
  },
};

/** The block `access` reports for `scope`; null when nothing blocks the microphone or nothing is known (Linux, a refusal the system's setting doesn't explain). */
export function micBlock(access: DictationMicrophoneAccess, scope: MicScope): MicBlock | null {
  const system = SYSTEM[access.system];
  if (access.access === "denied" && system) return { by: "system", title: system.title, detail: system.detail, action: access.settings ? { label: system.label, run: "settings" } : null };
  if (scope === "window" && access.windowBlocked) {
    return {
      by: "window",
      title: "TeleFlock's window blocks the microphone.",
      detail: "It was refused when the window asked, and the window doesn't ask again. Windows' own setting stays as it is.",
      action: { label: "Allow the microphone", run: "allowWindow" },
    };
  }
  return null;
}

/** A start the system refused (`permission`): blocked by the system even when its setting couldn't be read. Null where it keeps no setting (Linux: the device's error says why). */
export function refusedBlock(access: DictationMicrophoneAccess): MicBlock | null {
  return micBlock({ ...access, access: "denied" }, "engine");
}

/** Android: blocked for good (the prompt no longer shows) once RECORD_AUDIO is `denied`; the app's settings grant it. */
export function androidMicBlock(state: AndroidMicPermission): MicBlock | null {
  if (state !== "denied") return null;
  return {
    by: "system",
    title: "Android blocks the microphone for TeleFlock.",
    detail: "Allow it under Permissions → Microphone in TeleFlock's app info.",
    action: { label: "Open Android settings", run: "settings" },
  };
}

/** Android refused once (or the prompt was dismissed): the next tap asks again. */
export const ANDROID_ASKS_AGAIN = "Dictation needs the microphone. Tap the mic to allow it.";
