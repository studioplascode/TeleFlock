import type { Notification } from "@/core/gen";

/**
 * Whether a live notification gets its own row in the Activity timeline: only when the host's activity feed has
 * no entry for it. That is a quiet agent, and a notice of the host's own (no agent: herdr's health, a test, idle
 * shells it closed). An `info` notice about an agent (a refusal fallback, Decide for me, an automation run, an
 * agent that ended) comes with its activity entry, which stands for it; needs, finished and errors have theirs.
 */
export function isTimelineNotice(n: Pick<Notification, "kind" | "agentId">): boolean {
  return n.kind === "quiet" || (n.kind === "info" && !n.agentId);
}

/**
 * The name a notice row shows: its agent's as the app knows it (`known`: the board's, else what the host's activity
 * last called it), never herdr's terminal id; a host's own notice (no agent) is TeleFlock's.
 */
export function noticeName(n: Pick<Notification, "agentId">, known: string | undefined): string {
  if (!n.agentId) return "TeleFlock";
  return known ?? "An agent";
}
