import { create } from "zustand";
import { persist } from "zustand/middleware";

export type MotionPreference = "system" | "full" | "reduced";

interface MotionPreferenceState {
  preference: MotionPreference;
  setPreference: (p: MotionPreference) => void;
}

/** User motion preference (persisted). "system" follows prefers-reduced-motion. */
export const useMotionPreference = create<MotionPreferenceState>()(
  persist(
    (set) => ({
      preference: "system",
      setPreference: (preference) => set({ preference }),
    }),
    { name: "tf.motion" },
  ),
);

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

export function resolveReduced(preference: MotionPreference, systemReduced: boolean): boolean {
  return preference === "reduced" || (preference === "system" && systemReduced);
}

/** Resolved level; the value of html[data-motion]. */
export type MotionLevel = "reduced" | "calm" | "full";

/**
 * html[data-motion]: "reduced" (nothing loops), "calm" (default: the screen holds still; what needs
 * you pulses briefly when it arrives, changes animate once) or "full" (Settings → Motion → Lively:
 * every glow, breath, orbit and the drifting ambient background).
 */
export function motionAttribute(preference: MotionPreference, systemReduced: boolean): MotionLevel {
  if (resolveReduced(preference, systemReduced)) return "reduced";
  return preference === "full" ? "full" : "calm";
}

/** Sets html[data-motion] before first paint so CSS loops respect the preference immediately. */
export function applyInitialMotionAttribute(): void {
  const systemReduced = window.matchMedia(REDUCED_QUERY).matches;
  document.documentElement.dataset.motion = motionAttribute(useMotionPreference.getState().preference, systemReduced);
}

export { REDUCED_QUERY };
