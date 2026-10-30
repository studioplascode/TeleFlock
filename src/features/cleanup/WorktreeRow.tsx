import { Bot, ExternalLink, FolderGit2, GitBranch, GitPullRequest, Lock, Trash2 } from "lucide-react";
import { navigate } from "@/core";
import type { CleanupWorktree } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { Button, Chip, Tooltip, cn, formatAge } from "@/design";
import type { Status } from "@/design/tokens";
import { openExternal } from "@/features/hosts/ConnStatusCard";
import { tildify } from "@/features/workspace/shared/paths";
import { HOLD_WORDS } from "./actions";
import type { Verdict, WorktreeKind } from "./classify";

const KIND: Record<WorktreeKind, { label: string; tone: "neutral" | "accent" | Status; about: string }> = {
  merged: { label: "Merged", tone: "done", about: "Its pull request is merged" },
  closed: { label: "Closed", tone: "idle", about: "Its pull request was closed without merging" },
  missing: { label: "Folder gone", tone: "idle", about: "The checkout folder no longer exists; only git's record of it is left" },
  stale: { label: "Stale", tone: "review", about: "No pull request, not open anywhere, untouched for a while" },
  open: { label: "PR open", tone: "accent", about: "Its pull request is open" },
  active: { label: "In use", tone: "neutral", about: "Open in herdr, an agent is in it, or it was used recently" },
  busy: { label: "Agent working", tone: "running", about: "An agent is working or waiting for you in it: it is never removed then" },
};

function prLine(w: CleanupWorktree, now: number): { text: string; url?: string } {
  if (w.pr) {
    const when = w.pr.closedAt ? ` ${formatAge(now - w.pr.closedAt)}` : "";
    const state = w.pr.state === "MERGED" ? `merged${when}` : w.pr.state === "CLOSED" ? `closed${when}` : w.pr.draft ? "draft" : "open";
    return { text: `#${w.pr.number} ${state}`, url: w.pr.url };
  }
  if (w.prError) return { text: "PR unknown" };
  if (w.prCheckedAt !== undefined) return { text: "no PR" };
  return { text: w.branch ? "PR …" : "detached" };
}

/** One linked worktree: what it is, its facts, and its own Delete. */
export function WorktreeRow({
  hostId,
  worktree: w,
  verdict,
  home,
  now,
  onDelete,
  removing,
  liveAgent,
}: {
  hostId: string;
  worktree: CleanupWorktree;
  verdict: Verdict;
  home?: string;
  now: number;
  onDelete(): void;
  /** Its removal is in progress (its own, or a bulk action's). */
  removing: boolean;
  /** The last agent is still on the board (it can be opened). */
  liveAgent: boolean;
}) {
  const kind = KIND[verdict.kind];
  const pr = prLine(w, now);
  const idle = w.activeAt ?? w.createdAt;
  const changes =
    w.dirty === undefined ? (w.missing ? null : "changes unknown") : w.dirty > 0 ? `${w.dirty} uncommitted change${w.dirty === 1 ? "" : "s"}` : "clean";
  const agent = w.lastAgent;
  const canDelete = !w.busy && w.locked === undefined;
  const why = w.busy ? HOLD_WORDS.busy : w.locked !== undefined ? `Locked${w.locked ? `: ${w.locked}` : ""}. Unlock it first (git worktree unlock).` : undefined;
  return (
    <li className={cn("flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 max-md:px-3.5", removing && "opacity-50")}>
      <Tooltip content={kind.about}>
        <span className="mt-0.5 flex w-[104px] shrink-0 max-md:w-auto">
          <Chip tone={kind.tone} className="justify-center">
            {kind.label}
          </Chip>
        </span>
      </Tooltip>
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <GitBranch className="size-3.5 shrink-0 text-mute" aria-hidden />
          <span className="min-w-0 truncate font-mono text-sm font-bold text-ink">{w.branch ?? `detached at ${w.head ?? "?"}`}</span>
          {w.workspaceId && (
            <span className="shrink-0 rounded-full bg-white/6 px-1.5 text-2xs font-semibold text-mute" title="Open as a herdr workspace">
              open
            </span>
          )}
        </div>
        <span className="min-w-0 truncate font-mono text-2xs text-mute-2" title={w.path}>
          {tildify(w.path, home)}
        </span>
        {agent && (
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-mute">
            <Bot className="size-3.5 shrink-0" aria-hidden />
            {liveAgent && agent.agentId ? (
              <button
                type="button"
                className="min-w-0 truncate rounded-sm text-left font-semibold text-ink-2 focus-ring hover:text-ink hover:underline"
                onClick={() => navigate({ name: "agent", hostId, agentId: agent.agentId as string })}
              >
                {agent.name}
              </button>
            ) : (
              agent.name && <span className="shrink-0 font-semibold text-ink-2">{agent.name}</span>
            )}
            {agent.title && <span className="min-w-0 truncate">{agent.title}</span>}
            <span className="shrink-0 text-mute-2">· {formatAge(now - agent.at)}</span>
          </div>
        )}
        {w.automation && <span className="text-2xs text-mute-2">made by the automation “{w.automation}”</span>}
      </div>
      <div className="flex w-56 shrink-0 flex-col gap-0.5 text-xs text-mute max-md:w-full">
        <span className="flex min-w-0 items-center gap-1.5">
          <GitPullRequest className="size-3.5 shrink-0" aria-hidden />
          {pr.url ? (
            <button type="button" className="inline-flex min-w-0 items-center gap-1 truncate rounded-sm font-semibold text-ink-2 focus-ring hover:underline" onClick={() => openExternal(pr.url as string)} title={w.pr?.title}>
              {pr.text}
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </button>
          ) : (
            <span title={w.prError}>{pr.text}</span>
          )}
        </span>
        <span>
          {w.createdAt !== undefined && <>created {formatAge(now - w.createdAt)}</>}
          {idle !== undefined && w.activeAt !== undefined && <> · used {formatAge(now - idle)}</>}
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5">
          {changes && <span className={cn((w.dirty ?? 0) > 0 && "font-semibold text-warn")}>{changes}</span>}
          {(w.unpushed ?? 0) > 0 && <span>· {w.unpushed} unpushed</span>}
          {w.orphanCommits && <span className="font-semibold text-warn">· commits on no branch</span>}
          {w.locked !== undefined && (
            <span className="inline-flex items-center gap-1 font-semibold text-ink-2" title={w.locked || undefined}>
              <Lock className="size-3" aria-hidden /> locked
            </span>
          )}
        </span>
      </div>
      <div className="flex w-[148px] shrink-0 items-center justify-end gap-2 max-md:w-full max-md:justify-between">
        <span className="font-mono text-xs text-ink-2 tabular" title={w.sizePartial ? "Still counting: at least this much" : "Space it takes on disk"}>
          {w.missing ? "—" : w.size !== undefined ? `${w.sizePartial ? "≥ " : ""}${formatBytes(w.size)}` : "…"}
        </span>
        <Tooltip content={why ?? (w.missing ? "Drop git's record of it (the branch stays)" : "Delete the checkout folder (asks first; the branch stays)")}>
          <span>
            <Button size="sm" variant="danger" icon={w.missing ? <FolderGit2 /> : <Trash2 />} disabled={!canDelete || removing} onClick={onDelete}>
              {w.missing ? "Forget" : "Delete"}
            </Button>
          </span>
        </Tooltip>
      </div>
    </li>
  );
}
