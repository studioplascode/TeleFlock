import type { Ref } from "react";
import { useCore, useHosts, useUi } from "@/core";
import { Button, Input, Kbd, SegmentedControl, Select, cn } from "@/design";
import { type GroupBy, useBoard } from "./boardStore";

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

export function BoardToolbar({ searchRef, className }: { searchRef: Ref<HTMLInputElement>; className?: string }) {
  const profiles = useHosts((s) => s.profiles);
  const filter = useHosts((s) => s.filter);
  const setFilter = useHosts((s) => s.setFilter);
  const repo = useBoard((s) => s.repo);
  const setRepo = useBoard((s) => s.setRepo);
  const q = useBoard((s) => s.q);
  const setQ = useBoard((s) => s.setQ);
  const groupBy = useBoard((s) => s.groupBy);
  const setGroupBy = useBoard((s) => s.setGroupBy);
  const repos = useRepoNames(filter);
  const openDialog = useUi((s) => s.openDialog);

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <h1 className="mr-2 font-display text-xl font-bold text-ink">Board</h1>
      {profiles.length > 1 && (
        <Select
          value={filter}
          onValueChange={setFilter}
          className="h-9 w-36"
          options={[{ value: "all", label: "All hosts" }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
        />
      )}
      <Select
        value={repo ?? "*"}
        onValueChange={(v) => setRepo(v === "*" ? null : v)}
        className="h-9 w-40"
        options={[{ value: "*", label: "All repos" }, ...repos.map((r) => ({ value: r, label: r }))]}
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
        boxClassName="h-9 w-56"
        leading={
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" strokeLinecap="round" />
          </svg>
        }
        trailing={<Kbd>/</Kbd>}
      />
      <SegmentedControl<GroupBy> size="sm" value={groupBy} onValueChange={setGroupBy} options={GROUPS} aria-label="Group by" />
      <span className="ml-auto hidden items-center gap-1.5 text-2xs font-semibold text-mute-2 min-[1700px]:flex">
        <Kbd>J</Kbd>
        <Kbd>K</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>A</Kbd> answer · <Kbd>T</Kbd> terminal
      </span>
      <Button
        size="sm"
        variant="primary"
        className="ml-auto min-[1700px]:ml-0"
        onClick={() => openDialog({ kind: "newWorktree", hostId: filter !== "all" ? filter : undefined })}
        trailing={<Kbd>N</Kbd>}
      >
        New worktree
      </Button>
    </div>
  );
}
