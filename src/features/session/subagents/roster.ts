import type { Subagent } from "@/core/gen";

/**
 * A `task` card's subagents as the session's roster (`meta.subagents`) knows them now. omp
 * (≥ 18.13) runs a `task` call's subagents in the background: the call's result, and the
 * transcript row built from it, keep the status they had when the call returned ("running"),
 * while the roster follows each subagent to its end. Only agents the card still shows running
 * take the roster's record; finished ones keep the card's (final) record, and agents the roster
 * doesn't know stay as they are. Returns `agents` itself when nothing changes.
 */
export function withRoster(agents: Subagent[], roster: readonly Subagent[] | undefined): Subagent[] {
  if (!roster?.length) return agents;
  const byId = new Map(roster.map((s) => [s.id, s]));
  let changed = false;
  const out = agents.map((a) => {
    const live = a.status === "running" ? byId.get(a.id) : undefined;
    if (!live) return a;
    changed = true;
    return live.description != null || a.description == null ? live : { ...live, description: a.description };
  });
  return changed ? out : agents;
}
