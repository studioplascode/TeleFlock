import { core, navigate, parseAgentKey, useSettings, useUi } from "@/core";
import type { Answer, ApiError } from "@/core/gen";
import { morphTo, toast } from "@/design";
import { haptic } from "@/features/shell/haptics";

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
    haptic("success");
  } catch (err) {
    haptic("warning");
    reportError(`Couldn't answer ${agentId}`, err);
    throw err;
  }
}

/** `agent.archive` (Review → Done when true, Done → Review when false). */
export async function setArchived(key: string, archived: boolean): Promise<void> {
  const { hostId, agentId } = parseAgentKey(key);
  try {
    await core.host(hostId).call("agent.archive", { agentId, archived });
    haptic("success");
  } catch (err) {
    haptic("warning");
    reportError(archived ? `Couldn't archive ${agentId}` : `Couldn't reopen ${agentId}`, err);
    throw err;
  }
}

/** Archive with an Undo toast (mobile swipe, bulk actions): no confirm step, one tap to revert. */
export async function archiveWithUndo(keys: readonly string[]): Promise<void> {
  const results = await Promise.allSettled(keys.map((k) => setArchived(k, true)));
  const done = keys.filter((_, i) => results[i]?.status === "fulfilled");
  if (done.length === 0) return;
  const label = done.length === 1 ? parseAgentKey(done[0] ?? "").agentId : `${done.length} agents`;
  toast({
    title: `Archived ${label}`,
    status: "done",
    action: { label: "Undo", onClick: () => done.forEach((k) => void setArchived(k, false).catch(() => {})) },
  });
}

/** Whether an agent's notifications are muted (`Settings.mutedAgents`). */
export function useMuted(key: string): boolean {
  return useSettings((s) => (s.mutedAgents ?? []).includes(key));
}

/** Mute or unmute agents: their needs-you cards stay on the board, but they stop pinging you. */
export async function setMuted(keys: readonly string[], muted: boolean): Promise<void> {
  const s = useSettings.getState();
  const cur = s.mutedAgents ?? [];
  const next = muted ? [...cur, ...keys.filter((k) => !cur.includes(k))] : cur.filter((k) => !keys.includes(k));
  try {
    await s.update({ mutedAgents: next });
  } catch (err) {
    reportError(muted ? "Couldn't mute" : "Couldn't unmute", err);
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

/** Open the agent's session; tagged cards on screen morph into its header (design `morphTo`). */
export function openAgent(key: string): void {
  const { hostId, agentId } = parseAgentKey(key);
  morphTo(key, () => navigate({ name: "agent", hostId, agentId }));
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
