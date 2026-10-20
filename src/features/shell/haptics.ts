import { invoke } from "@tauri-apps/api/core";
import { isAndroid, isTauri } from "@/design";

/** Haptic feedback flavours (mirrors the Android plugin's kinds). */
export type HapticKind = "tick" | "select" | "success" | "warning" | "heavy";

/** navigator.vibrate patterns (ms) used when the native plugin is unavailable. */
const PATTERNS: Record<HapticKind, number | number[]> = {
  tick: 6,
  select: 10,
  success: [10, 50, 16],
  warning: [18, 70, 18],
  heavy: 28,
};

// The Android plugin is only registered on Android; anywhere else it rejects once and we stop trying.
let plugin = isTauri() && isAndroid;

function vibrate(kind: HapticKind): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  // Browsers block (and warn about) vibration before the first user gesture.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  try {
    navigator.vibrate(PATTERNS[kind]);
  } catch {
    // vibration is best-effort
  }
}

/**
 * Fire a short haptic. Android app: native `View.performHapticFeedback` through the TeleFlock
 * plugin. Mobile browsers: `navigator.vibrate`. Desktop: no-op.
 */
export function haptic(kind: HapticKind = "tick"): void {
  if (plugin) {
    invoke("plugin:teleflock-android|haptic", { kind }).catch(() => {
      plugin = false;
      vibrate(kind);
    });
    return;
  }
  vibrate(kind);
}
