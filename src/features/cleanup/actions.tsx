import type { ReactNode } from "react";
import { core, toApiError } from "@/core";
import type { ApiError, CleanupWorktree } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { toast } from "@/design";
import { classifyHerdrError, describeError } from "@/features/workspace/shared/errors";
import { confirmAction } from "@/features/workspace/shared/overlays";
import { tildify } from "@/features/workspace/shared/paths";
import { cardsLeaveSentence, cardsLeaving } from "@/features/workspace/workspaceActions";
import { expectOf } from "./background";
import { type BulkKind, type BulkSet, type Hold } from "./classify";

/*
 * Removing worktrees from the Cleanup page, always through `cleanup.remove`. hostd checks each worktree
 * itself right before, never on the report: no agent works in it, it isn't locked, a detached HEAD keeps no
 * unsaved commit, and (hosts ≥ 0.9.6, `expect`) it is still what the page showed: its HEAD, branch, unpushed
 * commits, agents and herdr workspace (`worktree_changed` otherwise). git refuses uncommitted changes without
 * force; the branch is always kept. Forget (`forget`, hosts ≥ 0.9.6) only drops git's record of a folder that
 * is gone, never a checkout (`not_missing` when anything is at its path).
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

/** A worktree that keeps changing is confirmed again at most this often; then its removal gives up. */
const RECONFIRMS = 3;

/** What `removeOne` needs of the page's report of the host (`useCleanupReport`). */
export interface RemoveOptions {
  /** The host checks the worktree against what the page showed (`expect`) and knows `forget`. */
  revalidates: boolean;
  /** The host's current row of a worktree, kept as the page's report; undefined once it is not listed. */
  reloadRow(path: string): Promise<CleanupWorktree | undefined>;
  hostName?: string;
}

/** Says why `w` was not removed: the host's message and its hint. */
function failed(w: CleanupWorktree, err: ApiError): void {
  const d = describeError(err);
  toast({ title: `Couldn't ${w.missing ? "forget" : "remove"} ${nameOf(w)}`, description: d.hint ? `${d.title} — ${d.hint}` : d.title, status: "error" });
}

/**
 * What Delete or Forget of `w` does, for its confirm (shown again with its current facts when it changed):
 * the checkout goes with its ignored files (or only git's record of a folder that is gone), the branch
 * stays, the cards that leave the board with it, and what needs force (`forced`: the user chose "Force
 * remove" already, so that goes without asking again).
 */
function removeBody(hostId: string, w: CleanupWorktree, home: string | undefined, forced = false): ReactNode {
  const leaving = cardsLeaveSentence(cardsLeaving(hostId, w));
  const dirty = w.dirty ?? 0;
  return (
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
      {leaving && ` ${leaving}`}
      {dirty > 0 && (
        <span className="mt-2 block font-semibold text-warn">
          {dirty} uncommitted change{dirty === 1 ? "" : "s"} {forced ? "will be discarded (you chose Force remove)." : "will need a force remove."}
        </span>
      )}
      {w.orphanCommits && (
        <span className="mt-2 block font-semibold text-warn">
          {forced ? "The commits only its detached HEAD knows will be lost (you chose Force remove)." : "Its detached HEAD has commits on no branch: they will need a force remove."}
        </span>
      )}
    </>
  );
}

/**
 * One worktree: confirm (naming the cards that leave the board with it, `cardsLeaving`), then `cleanup.remove`;
 * uncommitted changes or a detached HEAD's unsaved commit ask a second, explicit confirm to force; a repository
 * owned by another user asks to trust it. A host that checks the worktree against what the page showed
 * (`opts.revalidates`) gets `expect`, and `forget` for a folder that is gone: when the worktree changed
 * meanwhile, its current facts are confirmed again ("Delete anyway", at most `RECONFIRMS` times; never while
 * an agent works in it or it is locked); when the folder to forget is back, Delete is offered instead. Toasts
 * its own outcome, never rejects; true once the worktree is gone (also when the host doesn't list it any more).
 */
export async function removeOne(hostId: string, w: CleanupWorktree, home?: string, opts?: RemoveOptions): Promise<boolean> {
  const ok = await confirmAction({
    title: w.missing ? `Forget worktree ${nameOf(w)}?` : `Delete worktree ${nameOf(w)}?`,
    body: removeBody(hostId, w, home),
    confirmLabel: w.missing ? "Forget worktree" : "Delete worktree",
    danger: true,
  });
  if (!ok) return false;
  // The row acted on: the one confirmed, then its current facts once they are confirmed again.
  let cur = w;
  let force = false;
  let trust = false;
  let reconfirmed = 0;
  for (;;) {
    try {
      // Older hosts know neither `expect` nor `forget`: Forget is off there and Delete goes as before.
      await core.host(hostId).call("cleanup.remove", {
        path: cur.path,
        force,
        trust,
        forget: !!opts?.revalidates && cur.missing,
        expect: opts?.revalidates ? expectOf(cur) : undefined,
      });
      toast({ title: `${cur.missing ? "Forgot" : "Deleted"} worktree ${nameOf(cur)}`, description: force ? "Forced: its local changes were discarded." : undefined, duration: 3000 });
      return true;
    } catch (e) {
      // Through herdr (a workspace shows it) the same refusals arrive in herdr's words.
      const failure = classifyHerdrError(e);
      const err = failure.error;
      const changed = err.code === "worktree_changed";
      if (opts?.revalidates && (changed || (err.code === "not_missing" && cur.missing))) {
        // hostd refreshed the worktree's row in its report before refusing.
        let fresh: CleanupWorktree | undefined;
        try {
          fresh = await opts.reloadRow(cur.path);
        } catch {
          failed(cur, err);
          return false;
        }
        if (!fresh) {
          toast({ title: `Worktree ${nameOf(cur)} is already gone`, description: `${opts.hostName || "The host"} doesn't list it any more.`, duration: 4000 });
          return true;
        }
        if (fresh.busy || fresh.locked !== undefined) {
          // Its row has no Delete now (an agent works in it, or it is locked): nothing to confirm again.
          toast({ title: `Couldn't ${cur.missing ? "forget" : "remove"} ${nameOf(cur)}`, description: `${err.message}; ${fresh.busy ? HOLD_WORDS.busy : "it is locked"} now.`, status: "error" });
          return false;
        }
        if (changed) {
          if (reconfirmed >= RECONFIRMS) {
            toast({ title: `Couldn't remove ${nameOf(cur)}`, description: `It keeps changing (${err.message}). Look at it again once it has settled.`, status: "error" });
            return false;
          }
          reconfirmed++;
          // What changed, in the host's words, as the confirm's first sentence.
          const what = err.message.charAt(0).toUpperCase() + err.message.slice(1);
          const again = await confirmAction({
            title: `${nameOf(cur)} changed since the report`,
            body: (
              <>
                <span className="mb-2 block font-semibold text-ink">{what}</span>
                {removeBody(hostId, fresh, home, force)}
              </>
            ),
            confirmLabel: fresh.missing ? "Forget anyway" : "Delete anyway",
            danger: true,
          });
          if (!again) return false;
          cur = fresh;
          continue;
        }
        // Forget refused: something is at the path. Still `missing` (an empty mount point, a folder on the way
        // that can't be read): the host's message says which.
        if (fresh.missing) {
          failed(cur, err);
          return false;
        }
        const del = await confirmAction({
          title: `The folder of ${nameOf(cur)} is back`,
          body: (
            <>
              <span className="mb-2 block">
                Its path is there again (a disk mounted again, or the folder restored), so nothing was forgotten. Delete the checkout instead?
              </span>
              {removeBody(hostId, fresh, home)}
            </>
          ),
          confirmLabel: "Delete worktree",
          danger: true,
        });
        if (!del) return false;
        cur = fresh;
        force = false;
        continue;
      }
      const dirty = failure.kind === "dirtyNeedsForce";
      if ((dirty || err.code === "orphan_commits") && !force) {
        force = await confirmAction({
          title: dirty ? "The worktree has uncommitted changes" : "The worktree has commits on no branch",
          body: (
            <>
              {dirty ? "Modified or untracked files" : "Commits only its detached HEAD knows"} in <span className="font-mono">{tildify(cur.path, home)}</span> will be{" "}
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
      failed(cur, err);
      return false;
    }
  }
}

const BULK_TITLE: Record<BulkKind, string> = {
  shipped: "Delete merged and closed worktrees?",
  stale: "Prune stale worktrees?",
  cleanable: "Delete merged, closed and stale worktrees?",
};

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
 * needs either is left for its own Delete), never `forget` (bulk actions take no folder that is gone). A host
 * that checks each worktree against what the page showed (`opts.revalidates`) gets its `expect`: one that
 * changed since the report is not removed and listed as such ("changed since the report: …"). `onProgress`
 * gets the count done; `opts.title` replaces the confirm's (an agent group names its agent). Null when
 * cancelled.
 */
export async function removeMany(
  hostId: string,
  which: BulkKind,
  set: BulkSet,
  home: string | undefined,
  onProgress: (done: number) => void,
  opts?: { revalidates: boolean; title?: string },
): Promise<BulkOutcome | null> {
  if (set.items.length === 0) return null;
  const n = set.items.length;
  const ok = await confirmAction({
    title: opts?.title ?? BULK_TITLE[which],
    body: <BulkList set={set} home={home} />,
    confirmLabel: `${which === "stale" ? "Prune" : "Delete"} ${n} worktree${n === 1 ? "" : "s"}${set.bytes > 0 ? ` (${formatBytes(set.bytes)})` : ""}`,
    danger: true,
  });
  if (!ok) return null;
  const out: BulkOutcome = { removed: [], failed: [] };
  for (const [i, w] of set.items.entries()) {
    try {
      await core.host(hostId).call("cleanup.remove", { path: w.path, force: false, trust: false, forget: false, expect: opts?.revalidates ? expectOf(w) : undefined });
      out.removed.push(w);
    } catch (e) {
      const err = toApiError(e);
      const why = err.code === "worktree_changed" ? `changed since the report: ${err.message}` : err.hint ? `${err.message} — ${err.hint}` : err.message;
      out.failed.push({ worktree: w, error: why });
    }
    onProgress(i + 1);
  }
  const freed = out.removed.reduce((sum, w) => sum + (w.size ?? 0), 0);
  toast({
    title: `${which === "stale" ? "Pruned" : "Deleted"} ${out.removed.length} worktree${out.removed.length === 1 ? "" : "s"}${freed > 0 ? `, ${formatBytes(freed)} freed` : ""}`,
    description: out.failed.length ? `${out.failed.length} not removed: ${out.failed.map((f) => `${nameOf(f.worktree)} (${f.error})`).join("; ")}` : undefined,
    status: out.failed.length ? "error" : undefined,
    duration: out.failed.length ? 12_000 : 4000,
  });
  return out;
}
