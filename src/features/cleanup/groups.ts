import type { CleanupOwner, CleanupOwnerState, CleanupReport, CleanupWorktree } from "@/core/gen";
import { type BulkSet, type WorktreeKind, bulkSetIn, classify, sortForPage } from "./classify";

/*
 * The Cleanup page's agent view: the report's worktrees by the main agent they belong to (hostd's
 * `CleanupWorktree.owner`, hosts ≥ 0.9.0; a subagent's worktree belongs to its top-level session).
 * Pure, so the page and its tests agree.
 */

/** A worktree with the name of its repository. */
export interface Placed {
  worktree: CleanupWorktree;
  repo: string;
}

/** The worktrees of one main agent, or of none. */
export interface AgentGroup {
  /** `CleanupOwner.key`; null for the worktrees no agent is known to have worked in. */
  key: string | null;
  owner?: CleanupOwner;
  /** Removable kinds first, the longest idle first (`sortForPage`). */
  items: Placed[];
  /** Bytes of the worktrees whose size is known. */
  bytes: number;
  /** Some size is still unknown or a lower bound. */
  partial: boolean;
  /** The newest last use among them. */
  usedAt?: number;
  /** How many of each kind (`byKind.busy`: an agent works or waits for you in one). */
  byKind: Record<WorktreeKind, number>;
  /** Their repositories, the most used first. */
  repos: string[];
  /** What "Delete merged, closed and stale" takes, and what it leaves alone. */
  cleanable: BulkSet;
}

/** What the page calls an agent: its card's name, else its session's title, else its folder. */
export function ownerLabel(owner: CleanupOwner | undefined): string {
  if (!owner) return "Unknown agent";
  return owner.name ?? owner.title ?? owner.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? "Untitled session";
}

/** Cleanup candidates first: agents without a card, then ended, done, and live ones last. */
const STATE_ORDER: Record<CleanupOwnerState, number> = { gone: 0, ended: 1, parked: 2, live: 3 };

/** Where a main agent is, in a word or two (the group header shows the board's own status for a card). */
export const OWNER_STATE: Record<CleanupOwnerState, string> = { live: "on the board", parked: "done", ended: "ended", gone: "no card left" };

/**
 * The report's worktrees by the main agent they belong to, then "No agent" (worktrees no session,
 * subagent or card is known to have worked in). Agents whose worktrees are most removable come
 * first: no card left, ended, done, then live ones; within those, more to clean up first.
 */
export function groupByOwner(report: CleanupReport | undefined, now: number, staleDays: number): AgentGroup[] {
  const owners = new Map((report?.owners ?? []).map((o) => [o.key, o]));
  const placed = new Map<string | null, Placed[]>();
  for (const repo of report?.repos ?? []) {
    for (const worktree of repo.worktrees) {
      const key = worktree.owner?.key ?? null;
      const list = placed.get(key) ?? [];
      list.push({ worktree, repo: repo.name });
      placed.set(key, list);
    }
  }
  const groups: AgentGroup[] = [...placed.entries()].map(([key, list]) => {
    const byKind: Record<WorktreeKind, number> = { busy: 0, missing: 0, merged: 0, closed: 0, open: 0, stale: 0, active: 0 };
    const repoCount = new Map<string, number>();
    let bytes = 0;
    let partial = false;
    let usedAt: number | undefined;
    for (const { worktree: w, repo } of list) {
      byKind[classify(w, now, staleDays).kind] += 1;
      repoCount.set(repo, (repoCount.get(repo) ?? 0) + 1);
      bytes += w.size ?? 0;
      if ((w.size === undefined && !w.missing) || w.sizePartial) partial = true;
      const used = w.activeAt ?? w.createdAt;
      if (used !== undefined && (usedAt === undefined || used > usedAt)) usedAt = used;
    }
    const order = new Map(sortForPage(list.map((p) => p.worktree), now, staleDays).map((w, i) => [w.path, i]));
    const items = [...list].sort((a, b) => (order.get(a.worktree.path) ?? 0) - (order.get(b.worktree.path) ?? 0));
    return {
      key,
      owner: key === null ? undefined : owners.get(key),
      items,
      bytes,
      partial,
      usedAt,
      byKind,
      repos: [...repoCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([r]) => r),
      cleanable: bulkSetIn(
        items.map((p) => p.worktree),
        "cleanable",
        now,
        staleDays,
      ),
    };
  });
  groups.sort((a, b) => {
    // "No agent" last.
    const ra = a.key === null ? 9 : STATE_ORDER[a.owner?.state ?? "gone"];
    const rb = b.key === null ? 9 : STATE_ORDER[b.owner?.state ?? "gone"];
    return (
      ra - rb ||
      b.cleanable.items.length - a.cleanable.items.length ||
      b.bytes - a.bytes ||
      ownerLabel(a.owner).localeCompare(ownerLabel(b.owner)) ||
      (a.key ?? "").localeCompare(b.key ?? "")
    );
  });
  return groups;
}
