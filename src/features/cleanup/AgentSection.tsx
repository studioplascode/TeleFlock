import { Bot, ChevronRight, History, SquareArrowOutUpRight, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { navigate, useCore } from "@/core";
import type { CleanupWorktree } from "@/core/gen";
import { formatBytes } from "@/core/upload";
import { Button, Spinner, StatusPill, Tile, Tooltip, cn, formatAge } from "@/design";
import { openPastSessions } from "@/features/history/PastSessionsDialog";
import { agentStatus } from "@/features/session/api";
import { classify, type WorktreeKind } from "./classify";
import { type AgentGroup, ownerLabel } from "./groups";
import { WorktreeRow } from "./WorktreeRow";

/** Rows an open group shows at first, and each "Show more" adds: a 100-worktree agent stays cheap. */
export const GROUP_PAGE = 20;

/** The kinds a group header counts, in the page's order. */
const KIND_WORDS: [WorktreeKind, string][] = [
  ["merged", "merged"],
  ["closed", "closed"],
  ["stale", "stale"],
  ["missing", "folder gone"],
  ["open", "PR open"],
  ["active", "in use"],
  ["busy", "agent working"],
];

/**
 * One main agent's worktrees (or "No agent"): a header with the agent as the board shows it, how many
 * worktrees, their size and last use, opening the agent, and "Delete" for the merged, closed and stale
 * ones (the existing bulk safety: anything held is left for its own Delete); collapsible, its rows paged.
 */
export function AgentSection({
  hostId,
  group,
  home,
  now,
  staleDays,
  removing,
  multiRepo,
  open,
  onToggle,
  onDelete,
  onClean,
  progress,
  disabled,
}: {
  hostId: string;
  group: AgentGroup;
  home?: string;
  now: number;
  staleDays: number;
  removing: ReadonlySet<string>;
  /** Worktrees of several repositories are listed: rows name theirs. */
  multiRepo: boolean;
  open: boolean;
  onToggle(): void;
  onDelete(w: CleanupWorktree): void;
  onClean(): void;
  /** Its bulk removal's progress ("Removing 2/5…"). */
  progress: string | null;
  /** A scan or another bulk removal runs. */
  disabled: boolean;
}) {
  const [shown, setShown] = useState(GROUP_PAGE);
  const owner = group.owner;
  const card = useCore((s) => (owner?.agentId ? s.hosts[hostId]?.state.agents.find((a) => a.id === owner.agentId) : undefined));
  const label = group.key === null ? "No agent" : ownerLabel(owner);
  // The card's title next to its name; a session without a card is already named by its title.
  const title = group.key === null ? "No omp session, subagent or card is known to have worked in these." : owner?.name ? owner.title : undefined;
  const n = group.items.length;
  const clean = group.cleanable;
  const kinds = KIND_WORDS.filter(([k]) => group.byKind[k] > 0).map(([k, word]) => `${group.byKind[k]} ${word}`);
  const repos = group.repos.length > 3 ? `${group.repos.slice(0, 3).join(", ")} +${group.repos.length - 3}` : group.repos.join(", ");
  const rest = n - shown;

  let pill = null;
  if (owner && group.key !== null) {
    if (card && owner.state !== "gone") {
      pill = (
        <StatusPill status={agentStatus(card)} size="sm">
          {owner.state === "ended" ? "Ended" : undefined}
        </StatusPill>
      );
    } else {
      const about =
        owner.state === "gone" ? "No card on the board any more: only its omp session is left (Past sessions can open and resume it)." : `On the board: ${owner.state}.`;
      pill = (
        <Tooltip content={about}>
          <span>
            <StatusPill status={owner.state === "parked" ? "done" : "idle"} size="sm">
              {owner.state === "gone" ? "No card" : owner.state === "parked" ? "Done" : owner.state === "ended" ? "Ended" : "Live"}
            </StatusPill>
          </span>
        </Tooltip>
      );
    }
  }

  let openButton = null;
  if (card) {
    openButton = (
      <Button size="sm" variant="ghost" icon={<SquareArrowOutUpRight />} onClick={() => navigate({ name: "agent", hostId, agentId: card.id })}>
        Open
      </Button>
    );
  } else if (owner?.state === "gone" && owner.cwd) {
    const cwd = owner.cwd;
    openButton = (
      <Button size="sm" variant="ghost" icon={<History />} onClick={() => openPastSessions({ hostId, cwd })}>
        Past sessions
      </Button>
    );
  }

  return (
    <section aria-label={label}>
      <Tile className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pr-3 max-md:pr-0">
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex min-w-0 flex-1 basis-80 items-start gap-2.5 px-4 py-3 text-left focus-ring max-md:basis-full max-md:px-3.5"
          >
            <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-mute transition-transform", open && "rotate-90")} aria-hidden />
            {group.key === null ? <Users className="mt-0.5 size-4 shrink-0 text-mute" aria-hidden /> : <Bot className="mt-0.5 size-4 shrink-0 text-mute" aria-hidden />}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 truncate text-sm font-bold text-ink">{label}</span>
                {pill}
              </span>
              {title && <span className="min-w-0 truncate text-xs text-mute">{title}</span>}
              <span className="text-2xs text-mute">
                <b className="font-semibold text-ink-2">
                  {n} worktree{n === 1 ? "" : "s"}
                </b>
                {group.bytes > 0 && ` · ${group.partial ? "≥ " : ""}${formatBytes(group.bytes)}`}
                {group.usedAt !== undefined && ` · used ${formatAge(now - group.usedAt)}`}
                {multiRepo && repos && ` · ${repos}`}
                {kinds.length > 0 && <span className="text-mute-2"> · {kinds.join(" · ")}</span>}
              </span>
            </span>
          </button>
          {(openButton || clean.items.length > 0) && (
            <div className="flex shrink-0 items-center gap-2 max-md:w-full max-md:justify-end max-md:px-3.5 max-md:pb-3">
              {openButton}
              {clean.items.length > 0 && (
                <Tooltip
                  content={`Delete its ${clean.items.length} merged, closed and stale worktree${clean.items.length === 1 ? "" : "s"} (asks first; branches are kept).${clean.held.length > 0 ? ` ${clean.held.length} more left alone (uncommitted changes, locked, or unsaved commits).` : ""}`}
                >
                  <span>
                    <Button size="sm" variant="danger" icon={progress ? <Spinner /> : <Trash2 />} disabled={disabled} onClick={onClean}>
                      {progress ?? `Delete ${clean.items.length}${clean.bytes > 0 ? ` · ${formatBytes(clean.bytes)}` : ""}`}
                    </Button>
                  </span>
                </Tooltip>
              )}
            </div>
          )}
        </div>
        {open && n > 0 && (
          <>
            <ol className="flex flex-col divide-y divide-line border-t border-line">
              {group.items.slice(0, shown).map(({ worktree: w, repo }) => (
                <WorktreeRow
                  key={w.path}
                  hostId={hostId}
                  worktree={w}
                  verdict={classify(w, now, staleDays)}
                  home={home}
                  now={now}
                  removing={removing.has(w.path)}
                  liveAgent={false}
                  inGroup
                  repo={multiRepo ? repo : undefined}
                  onDelete={() => onDelete(w)}
                />
              ))}
            </ol>
            {rest > 0 && (
              <div className="border-t border-line px-4 py-2 max-md:px-3.5">
                <Button size="sm" variant="ghost" onClick={() => setShown((s) => s + GROUP_PAGE)}>
                  Show {Math.min(rest, GROUP_PAGE)} more ({rest} not shown)
                </Button>
              </div>
            )}
          </>
        )}
      </Tile>
    </section>
  );
}
