import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Device-local preferences (not synced through the app core): how much the app teaches and assists. */
export interface Prefs {
  /** Short first-use captions beside controls; each retires after a few sightings. */
  hints: boolean;
  /** Name branches, agents and titles and draft commit/PR messages with omp's tiny model role on the host. */
  aiNaming: boolean;
  setHints(on: boolean): void;
  setAiNaming(on: boolean): void;
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      hints: true,
      aiNaming: true,
      setHints: (hints) => set({ hints }),
      setAiNaming: (aiNaming) => set({ aiNaming }),
    }),
    { name: "tf.prefs", partialize: ({ hints, aiNaming }) => ({ hints, aiNaming }) },
  ),
);
