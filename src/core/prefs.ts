import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The omp model role Rambler rewrites with: `tiny` is the fastest, `default` the smartest. */
export type RamblerRole = "tiny" | "smol" | "default";

/** Device-local preferences (not synced through the app core): how much the app teaches and assists. */
export interface Prefs {
  /** Short first-use captions beside controls; each retires after a few sightings. */
  hints: boolean;
  /** Name branches, agents and titles and draft commit/PR messages with omp's tiny model role on the host. */
  aiNaming: boolean;
  /** Rambler: dictation is rewritten into a clear prompt by a model on the host (off by default). */
  rambler: boolean;
  ramblerRole: RamblerRole;
  setHints(on: boolean): void;
  setAiNaming(on: boolean): void;
  setRambler(on: boolean): void;
  setRamblerRole(role: RamblerRole): void;
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      hints: true,
      aiNaming: true,
      rambler: false,
      ramblerRole: "tiny",
      setHints: (hints) => set({ hints }),
      setAiNaming: (aiNaming) => set({ aiNaming }),
      setRambler: (rambler) => set({ rambler }),
      setRamblerRole: (ramblerRole) => set({ ramblerRole }),
    }),
    { name: "tf.prefs", partialize: ({ hints, aiNaming, rambler, ramblerRole }) => ({ hints, aiNaming, rambler, ramblerRole }) },
  ),
);
