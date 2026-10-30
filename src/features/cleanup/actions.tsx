import { core, toApiError } from "@/core";
import type { CleanupWorktree } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { toast } from "@/design";
import { classifyHerdrError, describeError } from "@/features/workspace/shared/errors";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { tildify } from "@/features/workspace/shared/paths";
import { type BulkKind, type BulkSet, type Hold } from "./classify";

/*
 * Removing worktrees from the Cleanup page, always through `cleanup.remove` (hostd checks again that no
 * agent works in it, it isn't locked and a detached HEAD keeps no unsaved commit; git refuses uncommitted
 * changes without force; the branch is always kept).
 */

export const HOLD_WORDS: Record<Hold, string> = {
  busy: "an agent is working in it",
  locked: "locked",
  orphan: "unsaved commits on a detached HEAD",
  dirty: "uncommitted changes",
};

function nameOf(w: CleanupWorktree): string {
  return w.branch ?? w.path.split(/[\\/]/).pop() ?? w.path;
}

/**
 * One worktree: confirm, then `cleanup.remove`; uncommitted changes or a detached HEAD's unsaved commit
 * ask a second, explicit confirm to force; a repository owned by another user asks to trust it. Toasts
 * its own outcome, never rejects; true once the worktree is gone.
 */
export async function removeOne(hostId: string, w: CleanupWorktree, home?: string): Promise<boolean> {
  const name = nameOf(w);
  const ok = await confirmAction({
    title: w.missing ? `Forget worktree ${name}?` : `Delete worktree ${name}?`,
    body: (
      <>
        {w.missing ? (
          <>
            Its folder <span className="font-mono">{tildify(w.path, home)}</span> is already gone; git's record of it is dropped.
          </>
        ) : (
          <>
            Deletes the checkout at <span className="font-mono">{tildify(w.path, home)}</span>, ignored files (.env.local, local databases) included
            {w.size !== undefined && <> ({formatBytes(w.size)})</>}
            {w.workspaceId ? ", and closes its herdr workspace." : "."}
          </>
        )}
        {w.branch && (
          <>
            {" "}
            The branch <span className="font-mono">{w.branch}</span> is kept.
          </>
        )}
        {(w.dirty ?? 0) > 0 && (
          <span className="mt-2 block font-semibold text-warn">
            {w.dirty} uncommitted change{w.dirty === 1 ? "" : "s"} will need a force remove.
          </span>
        )}
        {w.orphanCommits && <span className="mt-2 block font-semibold text-warn">Its detached HEAD has commits on no branch: they will need a force remove.</span>}
      </>
    ),
    confirmLabel: w.missing ? "Forget worktree" : "Delete worktree",
    danger: true,
  });
  if (!ok) return false;
  let force = false;
  let trust = false;
  for (;;) {
    try {
      await core.host(hostId).call("cleanup.remove", { path: w.path, force, trust });
      toast({ title: `${w.missing ? "Forgot" : "Deleted"} worktree ${name}`, description: force ? "Forced: its local changes were discarded." : undefined, duration: 3000 });
      return true;
    } catch (e) {
      // Through herdr (a workspace shows it) the same refusals arrive in herdr's words.
      const failure = classifyHerdrError(e);
      const err = failure.error;
      const dirty = failure.kind === "dirtyNeedsForce";
      if ((dirty || err.code === "orphan_commits") && !force) {
        force = await confirmAction({
          title: dirty ? "The worktree has uncommitted changes" : "The worktree has commits on no branch",
          body: (
            <>
              {dirty ? "Modified or untracked files" : "Commits only its detached HEAD knows"} in <span className="font-mono">{tildify(w.path, home)}</span> will be{" "}
              <b>permanently deleted</b>. {dirty ? "Commit or stash them first if you need them." : "Create a branch there first if you need them."}
            </>
          ),
          confirmLabel: "Force remove",
          danger: true,
        });
        if (!force) return false;
        continue;
      }
      if (failure.kind === "untrusted" && !trust) {
        trust = await confirmAction({
          title: "This repository is owned by another user",
          body: "git refuses to touch it (“dubious ownership”). Trusting it passes -c safe.directory for this removal only; your gitconfig is not changed.",
          confirmLabel: "Trust & remove",
        });
        if (!trust) return false;
        continue;
      }
      const d = describeError(err);
      toast({ title: `Couldn't remove ${name}`, description: d.hint ? `${d.title} — ${d.hint}` : d.title, status: "error" });
      return false;
    }
  }
}

const BULK_TITLE: Record<BulkKind, string> = { shipped: "Delete merged and closed worktrees?", stale: "Prune stale worktrees?" };

/** The confirm's list: exactly what goes, then what stays and why. */
function BulkList({ set, home }: { set: BulkSet; home?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <ul className="max-h-60 overflow-auto rounded-md well p-2 font-mono text-2xs leading-relaxed">
        {set.items.map((w) => (
          <li key={w.path} className="flex gap-2">
            <span className="min-w-0 flex-1 truncate" title={w.path}>
              {w.branch ?? "(detached)"} <span className="text-mute-2">{tildify(w.path, home)}</span>
            </span>
            <span className="shrink-0 text-mute">{w.missing ? "gone" : w.size !== undefined ? formatBytes(w.size) : ""}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-mute">
        Branches are kept; files git ignores (.env.local, local databases) go with the folders.
        {set.items.some((w) => w.workspaceId) && " Worktrees open in herdr close their workspace (their idle agents' sessions stay in Past sessions)."}
        {set.held.length > 0 && ` Left alone: ${set.held.map((h) => `${nameOf(h.worktree)} (${HOLD_WORDS[h.hold]})`).join(", ")}.`}
      </p>
    </div>
  );
}

export interface BulkOutcome {
  removed: CleanupWorktree[];
  failed: { worktree: CleanupWorktree; error: string }[];
}

/**
 * A bulk action: confirm the exact list, then remove one at a time without force or trust (anything that
 * needs either is left for its own Delete). `onProgress` gets the count done. Null when cancelled.
 */
export async function removeMany(hostId: string, which: BulkKind, set: BulkSet, home: string | undefined, onProgress: (done: number) => void): Promise<BulkOutcome | null> {
  if (set.items.length === 0) return null;
  const n = set.items.length;
  const ok = await confirmAction({
    title: BULK_TITLE[which],
    body: <BulkList set={set} home={home} />,
    confirmLabel: `${which === "shipped" ? "Delete" : "Prune"} ${n} worktree${n === 1 ? "" : "s"}${set.bytes > 0 ? ` (${formatBytes(set.bytes)})` : ""}`,
    danger: true,
  });
  if (!ok) return null;
  const out: BulkOutcome = { removed: [], failed: [] };
  for (const [i, w] of set.items.entries()) {
    try {
      await core.host(hostId).call("cleanup.remove", { path: w.path, force: false, trust: false });
      out.removed.push(w);
    } catch (e) {
      const err = toApiError(e);
      out.failed.push({ worktree: w, error: err.hint ? `${err.message} — ${err.hint}` : err.message });
    }
    onProgress(i + 1);
  }
  const freed = out.removed.reduce((sum, w) => sum + (w.size ?? 0), 0);
  toast({
    title: `${which === "shipped" ? "Deleted" : "Pruned"} ${out.removed.length} worktree${out.removed.length === 1 ? "" : "s"}${freed > 0 ? `, ${formatBytes(freed)} freed` : ""}`,
    description: out.failed.length ? `${out.failed.length} not removed: ${out.failed.map((f) => `${nameOf(f.worktree)} (${f.error})`).join("; ")}` : undefined,
    status: out.failed.length ? "error" : undefined,
    duration: out.failed.length ? 12_000 : 4000,
  });
  return out;
}
