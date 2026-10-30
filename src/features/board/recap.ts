import type { Agent, IdleRecap } from "@/core/gen";

/*
 * omp's idle recap (`OmpInfo.recap`): after `recap.idleSeconds` of an idle TUI, omp writes a short
 * recap of where the session stands ("Tests pass; PR body drafted; waiting on your call about the
 * migration"). The host sends it only while it is current (nothing happened in the session since);
 * an agent that works again shows its live line instead.
 */

/** The agent's current idle recap, while it is idle (Review / Done; never mid-turn or waiting on you). */
export function currentRecap(agent: Pick<Agent, "column" | "omp">): IdleRecap | undefined {
  if (agent.column === "running" || agent.column === "needs") return undefined;
  return agent.omp?.recap ?? undefined;
}

/** What an idle card says about the agent: its recap, else the last assistant line (`live.line`). */
export function restingLine(agent: Pick<Agent, "column" | "omp" | "live">): { text: string; recap?: IdleRecap } | null {
  const recap = currentRecap(agent);
  if (recap) return { text: recap.text, recap };
  return agent.live.line ? { text: agent.live.line } : null;
}
