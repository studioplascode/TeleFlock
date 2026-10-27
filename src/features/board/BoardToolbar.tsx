import { FolderGit2 } from "lucide-react";
import type { Ref } from "react";
import { useCore, useHosts } from "@/core";
import { Input, Kbd, SegmentedControl, Select, cn } from "@/design";
import { type GroupBy, useBoard } from "./boardStore";
import { FilterChip } from "./FilterChip";
import { repoAccent } from "./RepoTag";

/** Distinct repo names across agents in view, sorted (newline-joined so the selector stays primitive). */
export function useRepoNames(hostFilter: string): string[] {
  const joined = useCore((s) => {
    const names = new Set<string>();
    for (const a of Object.values(s.agents)) if (a.repo && (hostFilter === "all" || a.hostId === hostFilter)) names.add(a.repo);
    return [...names].sort().join("\n");
  });
  return joined ? joined.split("\n") : [];
}

const GROUPS = [
  { value: "status", label: "Status" },
  { value: "repo", label: "Repo" },
] as const;

/**
 * Board header: repo filter, search and grouping. The host filter is the title-bar pill; "New task"
 * is the sidebar's primary button (always on screen, also in the collapsed rail), so it isn't repeated here.
 */
export function BoardToolbar({ searchRef, className }: { searchRef: Ref<HTMLInputElement>; className?: string }) {
  const filter = useHosts((s) => s.filter);
  const repo = useBoard((s) => s.repo);
  const setRepo = useBoard((s) => s.setRepo);
  const q = useBoard((s) => s.q);
  const setQ = useBoard((s) => s.setQ);
  const groupBy = useBoard((s) => s.groupBy);
  const setGroupBy = useBoard((s) => s.setGroupBy);
  const repos = useRepoNames(filter);

  return (
    // Wraps onto a second row in narrow boards (small window, open split) instead of squeezing every control.
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2", className)}>
      <h1 className="mr-2 shrink-0 font-display text-xl font-bold text-ink">Board</h1>
      <Select
        value={repo ?? "*"}
        onValueChange={(v) => setRepo(v === "*" ? null : v)}
        className="h-9 w-40 min-w-24 shrink"
        aria-label="Repo filter"
        options={[
          { value: "*", label: "All repos", icon: <FolderGit2 className="text-mute" aria-hidden /> },
          ...repos.map((r) => ({ value: r, label: r, icon: <FolderGit2 style={{ color: repoAccent(r) }} aria-hidden /> })),
        ]}
      />
      <Input
        ref={searchRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQ("");
            e.currentTarget.blur();
          }
        }}
        placeholder="Filter agents…"
        aria-label="Filter agents"
        boxClassName="h-9 w-56 min-w-32 shrink"
        leading={
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" strokeLinecap="round" />
          </svg>
        }
        trailing={<Kbd>/</Kbd>}
      />
      <SegmentedControl<GroupBy> size="sm" value={groupBy} onValueChange={setGroupBy} options={GROUPS} aria-label="Group by" className="shrink-0" />
      <FilterChip />
      <span className="ml-auto hidden items-center gap-1.5 text-2xs font-semibold text-mute-2 min-[1700px]:flex">
        <Kbd>J</Kbd>
        <Kbd>K</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>A</Kbd> answer · <Kbd>T</Kbd> terminal
      </span>
    </div>
  );
}
