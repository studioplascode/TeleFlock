/*
 * Free space on a host's home file system (`HostHealth.diskFree` / `diskTotal`: where omp keeps its
 * sessions and herdr its worktrees): when the board warns about it.
 */

const GIB = 1024 ** 3;

/** Below this much free space a host is critical, whatever its size. */
export const CRITICAL_BYTES = 2 * GIB;
/** Below this much, and below {@link LOW_FRACTION} of the disk, it is low. */
export const LOW_BYTES = 10 * GIB;
export const LOW_FRACTION = 0.15;

export type DiskLevel = "ok" | "low" | "critical";

/**
 * `critical` under 2 GiB free; `low` under 10 GiB that is also under 15 % of the disk (a small disk with
 * 9 GiB of 32 free is fine; a 4 TB one with 9 GiB left is not); else `ok`. Unknown sizes are `ok`.
 */
export function diskLevel(free: number, total: number): DiskLevel {
  if (!(total > 0) || !(free >= 0)) return "ok";
  if (free < CRITICAL_BYTES) return "critical";
  if (free < LOW_BYTES && free / total < LOW_FRACTION) return "low";
  return "ok";
}

const RANK: Record<DiskLevel, number> = { ok: 0, low: 1, critical: 2 };

/** How long a hidden low-disk notice stays hidden (unless it gets worse). */
export const SNOOZE_MS = 24 * 3600_000;

/** A hidden notice: at which level, until when. */
export interface DiskSnooze {
  level: DiskLevel;
  until: number;
}

/** Whether the notice shows: the disk is low, and it wasn't hidden at this level (or better) within a day. */
export function showDiskNotice(level: DiskLevel, snooze: DiskSnooze | undefined, now: number): boolean {
  if (level === "ok") return false;
  if (!snooze || now >= snooze.until) return true;
  return RANK[level] > RANK[snooze.level];
}
