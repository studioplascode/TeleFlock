import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Device-local Automations state: the host last shown (when the route names none). */
interface AutomationsPrefs {
  lastHost: string | null;
  setLastHost(id: string): void;
}

export const useAutomationsPrefs = create<AutomationsPrefs>()(
  persist(
    (set) => ({
      lastHost: null,
      setLastHost: (lastHost) => set({ lastHost }),
    }),
    { name: "tf.automations", partialize: ({ lastHost }) => ({ lastHost }) },
  ),
);
