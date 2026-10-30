import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChimeKind } from "./chimes";

/** Ambient mode's settings, per device: the tablet on the shelf chimes, the laptop doesn't. */
export interface AmbientPrefs {
  /** Chimes on state changes (off until turned on: it is a display first). */
  chime: boolean;
  /** Which entered states chime. */
  chimeOn: Record<ChimeKind, boolean>;
  /** Hold a screen wake lock while ambient mode is open (where the browser offers one). */
  keepAwake: boolean;
  /** Show done agents too (dimmed). */
  showDone: boolean;
  setChime(on: boolean): void;
  setChimeOn(kind: ChimeKind, on: boolean): void;
  setKeepAwake(on: boolean): void;
  setShowDone(on: boolean): void;
}

export const useAmbientPrefs = create<AmbientPrefs>()(
  persist(
    (set) => ({
      chime: false,
      chimeOn: { needs: true, review: true, running: false, done: false },
      keepAwake: true,
      showDone: false,
      setChime: (chime) => set({ chime }),
      setChimeOn: (kind, on) => set((s) => ({ chimeOn: { ...s.chimeOn, [kind]: on } })),
      setKeepAwake: (keepAwake) => set({ keepAwake }),
      setShowDone: (showDone) => set({ showDone }),
    }),
    {
      name: "tf.ambient",
      version: 1,
      partialize: ({ chime, chimeOn, keepAwake, showDone }) => ({ chime, chimeOn, keepAwake, showDone }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AmbientPrefs>;
        return {
          ...current,
          chime: p.chime === true,
          chimeOn: { ...current.chimeOn, ...(p.chimeOn ?? {}) },
          keepAwake: p.keepAwake !== false,
          showDone: p.showDone === true,
        };
      },
    },
  ),
);
