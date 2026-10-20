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

/** Sets html[data-motion] before first paint so CSS loops respect the preference immediately. */
export function applyInitialMotionAttribute(): void {
  const systemReduced = window.matchMedia(REDUCED_QUERY).matches;
  const reduced = resolveReduced(useMotionPreference.getState().preference, systemReduced);
  document.documentElement.dataset.motion = reduced ? "reduced" : "full";
}

export { REDUCED_QUERY };
