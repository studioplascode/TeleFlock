import { useColumnKeys } from "@/core";
import { AgentGlyph, CardFlight, EmptyState, LayoutGroup, StatusOrb } from "@/design";
import { AgentCard } from "./AgentCard";
import { openAgent } from "./agentActions";
import { LANES } from "./lanes";

interface RepoFilter {
  hostId: string;
  q: string;
}

function RepoLaneSection({ repo, filter, column, selectedKey }: { repo: string; filter: RepoFilter; column: (typeof LANES)[number]; selectedKey: string | null }) {
  const keys = useColumnKeys(column.column, { hostId: filter.hostId, repo, q: filter.q || undefined });
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 px-1 text-2xs font-bold text-mute">
        <StatusOrb status={column.status} size={6} label={null} />
        {column.title}
        <span className="text-mute-2 tabular">{keys.length}</span>
      </div>
      {keys.map((k) => (
        <CardFlight key={k} flightId={k}>
          <div role="button" tabIndex={-1} data-agent-key={k} onClick={() => openAgent(k)} className="cursor-pointer rounded-xl">
            <AgentCard agentKey={k} lane={column.column} selected={k === selectedKey} />
          </div>
        </CardFlight>
      ))}
    </div>
  );
}

function RepoColumn({ repo, filter, selectedKey }: { repo: string; filter: RepoFilter; selectedKey: string | null }) {
  return (
    <section aria-label={`Repo ${repo}`} className="flex min-h-0 w-[300px] shrink-0 flex-col rounded-tile bg-white/[0.018] shadow-hairline">
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
        <AgentGlyph name={repo} size={18} />
        <h3 className="truncate font-display text-sm font-bold text-ink">{repo}</h3>
      </header>
      <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2.5 pb-3">
        {LANES.map((l) => (
          <RepoLaneSection key={l.column} repo={repo} filter={filter} column={l} selectedKey={selectedKey} />
        ))}
      </div>
    </section>
  );
}

/** Group-by-repo: one column per repository, status sections inside (archive via card actions). */
export function RepoBoard({ repos, filter, selectedKey }: { repos: string[]; filter: RepoFilter; selectedKey: string | null }) {
  if (repos.length === 0) return <EmptyState title="No repositories yet" description="Agents running inside a git repository are grouped here." className="flex-1" />;
  return (
    <LayoutGroup id="board-repos">
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-1">
        {repos.map((r) => (
          <RepoColumn key={r} repo={r} filter={filter} selectedKey={selectedKey} />
        ))}
      </div>
    </LayoutGroup>
  );
}
