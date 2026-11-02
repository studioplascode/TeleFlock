import { MessagesSquare } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { selectAgentKeys, useCore } from "@/core";
import { isChat } from "@/core/chats";
import { AgentGlyph, CardFlight, EmptyState, FlightGroup, StatusOrb, cn } from "@/design";
import { AgentCard } from "./AgentCard";
import { useBoard } from "./boardStore";
import { onCardClick } from "./Kanban";
import { LANES } from "./lanes";

type Lane = (typeof LANES)[number];

function RepoCard({ agentKey, lane, selected }: { agentKey: string; lane: (typeof LANES)[number]["column"]; selected: boolean }) {
  const picked = useBoard((s) => s.picked.includes(agentKey));
  return (
    <CardFlight flightId={agentKey}>
      <div
        role="button"
        tabIndex={-1}
        aria-pressed={picked}
        data-agent-key={agentKey}
        onClick={(e) => onCardClick(e, agentKey)}
        onMouseDown={(e) => e.shiftKey && e.preventDefault()}
        className="cursor-pointer rounded-xl"
      >
        <AgentCard agentKey={agentKey} lane={lane} selected={selected} picked={picked} />
      </div>
    </CardFlight>
  );
}

interface RepoFilter {
  hostId: string;
  q: string;
}

/** Whether a chat is on the board in view (the title-bar host filter): Repo grouping then gets one Chats column. */
export function useChatsInView(hostFilter: string): boolean {
  return useCore((s) => Object.values(s.agents).some((a) => isChat(a) && (hostFilter === "all" || a.hostId === hostFilter)));
}

/** One lane of a column: the repository's agents, or with `repo` null the chats (they have no repository). */
function RepoLaneSection({ repo, filter, column, selectedKey }: { repo: string | null; filter: RepoFilter; column: Lane; selectedKey: string | null }) {
  const q = filter.q || undefined;
  const keys = useCore(
    useShallow((s) =>
      repo === null
        ? selectAgentKeys(s, { column: column.column, hostId: filter.hostId, q }).filter((k) => isChat(s.agents[k]))
        : selectAgentKeys(s, { column: column.column, hostId: filter.hostId, repo, q }),
    ),
  );
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 px-1 text-2xs font-bold text-mute">
        <StatusOrb status={column.status} size={6} label={null} />
        {column.title}
        <span className="text-mute-2 tabular">{keys.length}</span>
      </div>
      {keys.map((k) => (
        <RepoCard key={k} agentKey={k} lane={column.column} selected={k === selectedKey} />
      ))}
    </div>
  );
}

function RepoColumn({ repo, filter, selectedKey }: { repo: string | null; filter: RepoFilter; selectedKey: string | null }) {
  // room under the last card for the floating selection bar (same as the status lanes)
  const selecting = useBoard((s) => s.picked.length > 0);
  return (
    <section aria-label={repo === null ? "Chats" : `Repo ${repo}`} className="flex min-h-0 max-w-[440px] min-w-[280px] flex-[1_0_300px] flex-col rounded-tile bg-ink/[0.018] shadow-hairline">
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
        {repo === null ? <MessagesSquare className="size-[18px] shrink-0 text-mute" aria-hidden /> : <AgentGlyph name={repo} size={18} />}
        <h3 className="min-w-0 truncate font-display text-sm font-bold text-ink">{repo ?? "Chats"}</h3>
      </header>
      <div
        className={cn(
          "no-scrollbar -mt-2 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-b-tile px-2.5 pt-2 pb-3 [mask-image:linear-gradient(to_bottom,transparent,#000_8px,#000_calc(100%-14px),transparent)]",
          selecting && "pb-[calc(var(--tf-selbar-h,48px)+24px)]",
        )}
      >
        {LANES.map((l) => (
          <RepoLaneSection key={l.column} repo={repo} filter={filter} column={l} selectedKey={selectedKey} />
        ))}
      </div>
    </section>
  );
}

/**
 * Group-by-repo: one column per repository, status sections inside (archive via card actions); chats (no
 * repository) share one Chats column after them. `arrangement`: see FlightGroup.
 */
export function RepoBoard({ repos, chats = false, filter, selectedKey, arrangement }: { repos: string[]; chats?: boolean; filter: RepoFilter; selectedKey: string | null; arrangement: string }) {
  if (repos.length === 0 && !chats) return <EmptyState title="No repositories yet" description="Agents running inside a git repository are grouped here." className="flex-1" />;
  return (
    <FlightGroup id="board-repos" arrangement={arrangement}>
      {/* Bleeds into the board padding like the status lanes, so scrolled columns reach the window edge. */}
      <div className="-mx-4 flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-1 short:-mx-3 short:px-3">
        {repos.map((r) => (
          <RepoColumn key={r} repo={r} filter={filter} selectedKey={selectedKey} />
        ))}
        {chats && <RepoColumn repo={null} filter={filter} selectedKey={selectedKey} />}
      </div>
    </FlightGroup>
  );
}
