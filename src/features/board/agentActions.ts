import { core, navigate, parseAgentKey, useUi } from "@/core";
import type { Answer, ApiError } from "@/core/gen";
import { toast } from "@/design";

function isApiError(e: unknown): e is ApiError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

/** Toast an ApiError (or anything thrown) with its hint. */
export function reportError(title: string, err: unknown): void {
  const description = isApiError(err) ? [err.message, err.hint].filter(Boolean).join(" — ") : String(err);
  toast({ title, description, status: "error" });
}

/** `agent.answer` for a pending request. Rejects (after toasting) on failure. */
export async function answerAgent(key: string, requestId: string, answer: Answer): Promise<void> {
  const { hostId, agentId } = parseAgentKey(key);
  try {
    await core.host(hostId).call("agent.answer", { agentId, requestId, answer });
  } catch (err) {
    reportError(`Couldn't answer ${agentId}`, err);
    throw err;
  }
}

/** `agent.archive` (Review → Done when true, Done → Review when false). */
export async function setArchived(key: string, archived: boolean): Promise<void> {
  const { hostId, agentId } = parseAgentKey(key);
  try {
    await core.host(hostId).call("agent.archive", { agentId, archived });
  } catch (err) {
    reportError(archived ? `Couldn't archive ${agentId}` : `Couldn't reopen ${agentId}`, err);
    throw err;
  }
}

/** Interrupt the current turn (Esc in the TUI); the agent stays alive. */
export async function stopAgent(key: string): Promise<void> {
  const { hostId, agentId } = parseAgentKey(key);
  try {
    await core.host(hostId).call("agent.stop", { agentId, mode: "interrupt" });
    toast({ title: `Stopping ${agentId}`, description: "Sent an interrupt to the current turn.", status: "idle" });
  } catch (err) {
    reportError(`Couldn't stop ${agentId}`, err);
  }
}

export function openAgent(key: string): void {
  const { hostId, agentId } = parseAgentKey(key);
  navigate({ name: "agent", hostId, agentId });
}

/** Desktop: open the agent's terminal in the split pane. Mobile: the full terminal view. */
export function openTerminal(key: string, mobile: boolean): void {
  const { hostId, agentId } = parseAgentKey(key);
  if (mobile) navigate({ name: "terminal", hostId, agentId });
  else useUi.getState().setSplit({ kind: "terminal", hostId, agentId });
}

/** Answer-next HUD, starting at this agent. */
export function openAnswerHud(key: string): void {
  const ui = useUi.getState();
  ui.select(key);
  ui.setAnswerNext(true);
}
