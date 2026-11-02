import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ShellsSnooze } from "./idleShells";

/** Device-local idle-shell state: hidden board notices per host, and the Cleanup page's scroll target. */
interface IdleShellsPrefs {
  /** Host id → the idle-shells notice hidden at that count until then (`showShellsNotice`). */
  snooze: Record<string, ShellsSnooze>;
  /** The board's Review: the host whose Cleanup page scrolls to its idle shells once they show (not saved). */
  focus: string | null;
  snoozeShells(hostId: string, snooze: ShellsSnooze): void;
  setFocus(hostId: string | null): void;
}

export const useIdleShellsPrefs = create<IdleShellsPrefs>()(
  persist(
    (set) => ({
      snooze: {},
      focus: null,
      snoozeShells: (hostId, snooze) => set((s) => ({ snooze: { ...s.snooze, [hostId]: snooze } })),
      setFocus: (focus) => set({ focus }),
    }),
    { name: "tf.cleanup.idleShells", partialize: ({ snooze }) => ({ snooze }) },
  ),
);
