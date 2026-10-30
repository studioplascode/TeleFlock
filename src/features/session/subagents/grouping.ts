import type { Subagent, SubagentStatus } from "@/core/gen";

/**
 * What a subagent's status means to the user. The wire's `parked` (omp parking an idle agent; sent by
 * hostds before the replica kept the outcome, and still in session caches) says "finished" and
 * nothing else, so it reads as done instead of its own colour.
 */
export type SubagentOutcome = "running" | "done" | "failed" | "aborted";

export function outcomeOf(status: SubagentStatus): SubagentOutcome {
  return status === "parked" ? "done" : status;
}

export interface SubagentGroups {
  /** Always visible: running first, then failed (they need a look), each in the roster's order. */
  active: Subagent[];
  /** Collapsed by default: done and aborted ones, the most recently finished first. */
  completed: Subagent[];
  running: number;
  failed: number;
  done: number;
  aborted: number;
}

/** Splits a session's roster for the Subagents panel (desktop sidebar and the phone's Agents tab). */
export function groupSubagents(subs: readonly Subagent[]): SubagentGroups {
  const running: Subagent[] = [];
  const failed: Subagent[] = [];
  const completed: Subagent[] = [];
  let done = 0;
  let aborted = 0;
  for (const s of subs) {
    const o = outcomeOf(s.status);
    if (o === "running") running.push(s);
    else if (o === "failed") failed.push(s);
    else {
      completed.push(s);
      if (o === "done") done++;
      else aborted++;
    }
  }
  // Array.prototype.sort is stable: agents that ended together (or have no end time) keep roster order.
  completed.sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0));
  return { active: [...running, ...failed], completed, running: running.length, failed: failed.length, done, aborted };
}

/** Header detail of the collapsed group: "3 done · 1 stopped" (killed, or cut off when omp's process died). */
export function completedSummary(g: Pick<SubagentGroups, "done" | "aborted">): string {
  return [g.done > 0 && `${g.done} done`, g.aborted > 0 && `${g.aborted} stopped`].filter(Boolean).join(" · ");
}
