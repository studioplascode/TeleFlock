import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_STALE_DAYS } from "./classify";
import type { DiskSnooze } from "./disk";

/** How the worktree list is grouped: by the main agent they belong to (hosts ≥ 0.9.0), or by repository. */
export type CleanupGrouping = "agent" | "repo";

/** Device-local Cleanup state: the host last shown, the stale threshold, the grouping, hidden low-disk notices. */
interface CleanupPrefs {
  lastHost: string | null;
  staleDays: number;
  groupBy: CleanupGrouping;
  /** Host id → the low-disk notice hidden at that level until then. */
  diskSnooze: Record<string, DiskSnooze>;
  setLastHost(id: string): void;
  setStaleDays(days: number): void;
  setGroupBy(groupBy: CleanupGrouping): void;
  snoozeDisk(hostId: string, snooze: DiskSnooze): void;
}

export const useCleanupPrefs = create<CleanupPrefs>()(
  persist(
    (set) => ({
      lastHost: null,
      staleDays: DEFAULT_STALE_DAYS,
      groupBy: "agent",
      diskSnooze: {},
      setLastHost: (lastHost) => set({ lastHost }),
      setStaleDays: (staleDays) => set({ staleDays }),
      setGroupBy: (groupBy) => set({ groupBy }),
      snoozeDisk: (hostId, snooze) => set((s) => ({ diskSnooze: { ...s.diskSnooze, [hostId]: snooze } })),
    }),
    { name: "tf.cleanup", partialize: ({ lastHost, staleDays, groupBy, diskSnooze }) => ({ lastHost, staleDays, groupBy, diskSnooze }) },
  ),
);
