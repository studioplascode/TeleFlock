import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_STALE_DAYS } from "./classify";
import type { DiskSnooze } from "./disk";

/** Device-local Cleanup state: the host last shown, the stale threshold, hidden low-disk notices. */
interface CleanupPrefs {
  lastHost: string | null;
  staleDays: number;
  /** Host id → the low-disk notice hidden at that level until then. */
  diskSnooze: Record<string, DiskSnooze>;
  setLastHost(id: string): void;
  setStaleDays(days: number): void;
  snoozeDisk(hostId: string, snooze: DiskSnooze): void;
}

export const useCleanupPrefs = create<CleanupPrefs>()(
  persist(
    (set) => ({
      lastHost: null,
      staleDays: DEFAULT_STALE_DAYS,
      diskSnooze: {},
      setLastHost: (lastHost) => set({ lastHost }),
      setStaleDays: (staleDays) => set({ staleDays }),
      snoozeDisk: (hostId, snooze) => set((s) => ({ diskSnooze: { ...s.diskSnooze, [hostId]: snooze } })),
    }),
    { name: "tf.cleanup", partialize: ({ lastHost, staleDays, diskSnooze }) => ({ lastHost, staleDays, diskSnooze }) },
  ),
);
