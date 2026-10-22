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

/**
 * html[data-motion]: "reduced" (nothing loops), "calm" (default: only needs-you and changes move;
 * running things hold still) or "full" (Settings → Motion → Lively: every glow, breath and orbit).
 */
export function motionAttribute(preference: MotionPreference, systemReduced: boolean): "reduced" | "calm" | "full" {
  if (resolveReduced(preference, systemReduced)) return "reduced";
  return preference === "full" ? "full" : "calm";
}

/** Sets html[data-motion] before first paint so CSS loops respect the preference immediately. */
export function applyInitialMotionAttribute(): void {
  const systemReduced = window.matchMedia(REDUCED_QUERY).matches;
  document.documentElement.dataset.motion = motionAttribute(useMotionPreference.getState().preference, systemReduced);
}

export { REDUCED_QUERY };
