import type { CleanupReport, CleanupWorktree } from "@/core/gen";

/*
 * What the Cleanup page makes of a worktree hostd reported (`cleanup.worktrees`): one word for what it
 * is, and whether each bulk action takes it. Pure, so the page and its tests agree.
 */

const DAY = 86_400_000;

/** Idle-days choices for "Prune stale", and the default. */
export const STALE_DAYS = [3, 7, 14, 30, 60, 90] as const;
export const DEFAULT_STALE_DAYS = 14;

/**
 * The most telling fact first: an agent works in it, its folder is gone, its pull request was merged
 * or closed, it has an open one, nothing touched it for `staleDays`, or it is in use.
 */
export type WorktreeKind = "busy" | "missing" | "merged" | "closed" | "open" | "stale" | "active";

/**
 * Why the bulk actions leave a worktree alone. On its own it can still go, except while busy or locked:
 * uncommitted changes and a detached HEAD's unsaved commits are discarded only after an explicit force.
 */
export type Hold = "busy" | "locked" | "orphan" | "dirty";

export interface Verdict {
  kind: WorktreeKind;
  hold?: Hold;
  /** "Delete merged/closed" takes it. */
  shipped: boolean;
  /** "Prune stale" takes it. */
  stale: boolean;
  /** Days since its last activity (`activeAt`, else when it was created); null when unknown. */
  idleDays: number | null;
}

export function holdOf(w: CleanupWorktree): Hold | undefined {
  if (w.busy) return "busy";
  if (w.locked !== undefined) return "locked";
  if (w.orphanCommits) return "orphan";
  if ((w.dirty ?? 0) > 0) return "dirty";
  return undefined;
}

export function classify(w: CleanupWorktree, now: number, staleDays: number): Verdict {
  const last = w.activeAt ?? w.createdAt;
  const idleDays = last === undefined ? null : Math.max(0, (now - last) / DAY);
  const hold = holdOf(w);
  const verdict = (kind: WorktreeKind, take: { shipped?: boolean; stale?: boolean } = {}): Verdict => ({
    kind,
    hold,
    shipped: !hold && !!take.shipped,
    stale: !hold && !!take.stale,
    idleDays,
  });
  if (w.busy) return verdict("busy");
  // Only git's record is left. Never bulk: the folder may sit on a disk that is just not mounted,
  // and dropping its record would orphan the checkout. "Forget" is a per-row, confirmed action.
  if (w.missing) return verdict("missing");
  const state = w.pr?.state;
  if (state === "MERGED") return verdict("merged", { shipped: true });
  if (state === "CLOSED") return verdict("closed", { shipped: true });
  if (state === "OPEN") return verdict("open");
  // No pull request (or none known: gh missing, no GitHub remote): stale once untouched for long
  // enough and nothing has it open.
  const idle = idleDays !== null && idleDays >= staleDays && !w.workspaceId && w.agents === 0;
  return idle ? verdict("stale", { stale: true }) : verdict("active");
}

export type BulkKind = "shipped" | "stale";

export interface BulkSet {
  /** What the action removes, in report order. */
  items: CleanupWorktree[];
  /** What it would take but leaves alone, and why. */
  held: { worktree: CleanupWorktree; hold: Hold }[];
  /** Bytes the items take (known sizes only). */
  bytes: number;
}

/** The worktrees one bulk action takes. */
export function bulkSet(report: CleanupReport | undefined, which: BulkKind, now: number, staleDays: number): BulkSet {
  const out: BulkSet = { items: [], held: [], bytes: 0 };
  for (const repo of report?.repos ?? []) {
    for (const w of repo.worktrees) {
      const v = classify(w, now, staleDays);
      const fits = which === "shipped" ? v.kind === "merged" || v.kind === "closed" : v.kind === "stale";
      if (!fits) continue;
      if (v.hold) out.held.push({ worktree: w, hold: v.hold });
      else {
        out.items.push(w);
        out.bytes += w.size ?? 0;
      }
    }
  }
  return out;
}

export interface Totals {
  worktrees: number;
  /** Bytes of the worktrees whose size is known. */
  bytes: number;
  /** Some size is still unknown or partial. */
  partial: boolean;
  byKind: Record<WorktreeKind, number>;
}

export function totals(report: CleanupReport | undefined, now: number, staleDays: number): Totals {
  const byKind: Record<WorktreeKind, number> = { busy: 0, missing: 0, merged: 0, closed: 0, open: 0, stale: 0, active: 0 };
  const t: Totals = { worktrees: 0, bytes: 0, partial: false, byKind };
  for (const repo of report?.repos ?? []) {
    for (const w of repo.worktrees) {
      t.worktrees += 1;
      byKind[classify(w, now, staleDays).kind] += 1;
      if (w.size === undefined && !w.missing) t.partial = true;
      t.bytes += w.size ?? 0;
      if (w.sizePartial) t.partial = true;
    }
  }
  return t;
}

/** Worktrees whose kind sorts first: the ones a cleanup is about, then the ones in use. */
const ORDER: Record<WorktreeKind, number> = { merged: 0, closed: 1, missing: 2, stale: 3, open: 4, active: 5, busy: 6 };

/** A repo's worktrees for the page: removable kinds first, then the longest idle. */
export function sortForPage(worktrees: readonly CleanupWorktree[], now: number, staleDays: number): CleanupWorktree[] {
  const keyed = worktrees.map((w) => ({ w, v: classify(w, now, staleDays) }));
  keyed.sort((a, b) => ORDER[a.v.kind] - ORDER[b.v.kind] || (b.v.idleDays ?? -1) - (a.v.idleDays ?? -1) || a.w.path.localeCompare(b.w.path));
  return keyed.map((k) => k.w);
}
