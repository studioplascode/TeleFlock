/**
 * Hosts that keep their Cleanup report fresh by themselves (tf-hostd ≥ 0.9.6, `CleanupReport.background`):
 * the page is answered from that report at once, their own background scan is not followed, and their
 * `cleanup.remove` checks each worktree against what the page showed (`expect`) and forgets only a folder
 * that is gone (`forget`). Older hosts: the page follows every scan, their bulk actions wait for it, and
 * Forget is off.
 */
import type { CleanupExpect, CleanupReport, CleanupWorktree } from "@/core/gen";
import { formatAge } from "@/design/lib/format";

/** The host keeps its report fresh by itself and checks each removal against what the page showed. */
export function revalidates(report: CleanupReport | undefined): boolean {
  return report?.background !== undefined;
}

/**
 * A scan runs that the page follows with `waitMs`: one it asked for (Rescan, a report older than the
 * host's interval), or any scan of an older host. Never the host's own background scan: the page's next
 * ask (every 2 min) picks its result up.
 */
export function followsScan(report: CleanupReport | undefined): boolean {
  return !!report?.scanning && !report.background?.running;
}

/**
 * What the page showed of `w` when its removal was confirmed (`CleanupRemoveParams.expect`), with why it was
 * chosen: a merged or closed pull request it shows (bulk "Delete merged/closed", the row's Delete: the host asks
 * gh again right before and deletes only while gh still says so), else `staleBefore`, the "untouched N+ days"
 * cutoff it was chosen by (Prune stale, Delete on a stale row: the host refuses when it was used since).
 */
export function expectOf(w: CleanupWorktree, staleBefore?: number): CleanupExpect {
  const pr = !w.missing && (w.pr?.state === "MERGED" || w.pr?.state === "CLOSED") ? w.pr : undefined;
  return {
    head: w.head,
    branch: w.branch,
    unpushed: w.unpushed,
    agents: w.agents,
    workspaceId: w.workspaceId,
    ...(pr ? { pr: { number: pr.number, state: pr.state } } : staleBefore !== undefined && !w.missing ? { staleBefore } : {}),
  };
}

/** The status line of a host that keeps its report fresh by itself. */
export interface BackgroundNote {
  /** "Updated in the background · scanned 12m ago"; "Updating in the background · …" while its own scan runs. */
  text: string;
  /** The host's own scan runs now. */
  running: boolean;
  /** How the host keeps the report fresh (the line's tooltip). */
  about: string;
}

/** Undefined for older hosts, and while a scan the page follows runs (the page says what is filling in then). */
export function backgroundNote(report: CleanupReport, now: number, hostName: string): BackgroundNote | undefined {
  const bg = report.background;
  if (!bg || followsScan(report)) return undefined;
  const running = report.scanning;
  const lead = running ? "Updating in the background" : "Updated in the background";
  const minutes = Math.max(1, Math.round(bg.everyMs / 60_000));
  return {
    text: report.scannedAt === undefined ? lead : `${lead} · scanned ${formatAge(now - report.scannedAt)}`,
    running,
    about: `${hostName || "The host"} checks its worktrees every ${minutes} minute${minutes === 1 ? "" : "s"} and soon after worktrees, workspaces or agents change, below the agents' work. Rescan checks everything again now.`,
  };
}
