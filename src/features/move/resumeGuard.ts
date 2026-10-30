import { getAgentViews } from "@/core";
import { toast } from "@/design";
import { confirmAction } from "@/features/workspace/shared/overlays";

/**
 * Before a parked card resumes (Resume, prompting it, Reopen, its terminal): a card that moved to
 * another host (or may have) forks an older copy when resumed here, so ask first; one being moved
 * right now is refused. Resolves whether to go on.
 */
export async function confirmResumeMoved(agentKey: string): Promise<boolean> {
  const agent = getAgentViews().find((a) => a.key === agentKey);
  const moved = agent?.parked?.moved;
  if (!agent || !moved) return true;
  if (moved.state === "moving") {
    toast({ title: `${agent.name} is being moved to ${moved.to}`, description: "It can be resumed once the move is done or cancelled.", status: "review" });
    return false;
  }
  const interrupted = moved.state === "interrupted";
  return confirmAction({
    title: interrupted ? `Resume ${agent.name} here?` : `${agent.name} moved to ${moved.to}`,
    body: interrupted
      ? `The move to ${moved.to} was interrupted before it was confirmed, so ${moved.to} may be running ${agent.name} now. Check ${moved.to} first: resuming here starts a fork of an older copy of the session.`
      : `It continues on ${moved.to}. Resuming it here forks an older copy of the session: the two will diverge.`,
    confirmLabel: "Resume here anyway",
    danger: true,
  });
}
