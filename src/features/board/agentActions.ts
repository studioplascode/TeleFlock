import { core, getAgentViews, getWorkspacesSnapshot, navigate, parseAgentKey, useSettings, useUi } from "@/core";
import type { Answer, ApiError } from "@/core/gen";
import { morphTo, toast } from "@/design";
import { haptic } from "@/features/shell/haptics";
import { useSessionUi } from "@/features/session/state";
import { removeWorktree } from "@/features/workspace/workspaceActions";

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

/** `agent.archive` (Mark done: Review → Done when true; Reopen: Done → Review when false). */
export async function setArchived(key: string, archived: boolean): Promise<void> {
  const { hostId, agentId } = parseAgentKey(key);
  try {
    await core.host(hostId).call("agent.archive", { agentId, archived });
    haptic("success");
  } catch (err) {
    haptic("warning");
    reportError(archived ? `Couldn't mark ${agentId} done` : `Couldn't reopen ${agentId}`, err);
    throw err;
  }
}

/**
 * Mark done with an Undo toast (cards, menus, drops, swipes, bulk): no confirm step, one click to revert.
 * Resolves to the keys that were marked done (failures toast on their own).
 */
export async function archiveWithUndo(keys: readonly string[]): Promise<string[]> {
  const results = await Promise.allSettled(keys.map((k) => setArchived(k, true)));
  const done = keys.filter((_, i) => results[i]?.status === "fulfilled");
  if (done.length === 0) return done;
  const label = done.length === 1 ? parseAgentKey(done[0] ?? "").agentId : `${done.length} agents`;
  toast({
    title: `Marked ${label} done`,
    status: "done",
    action: { label: "Undo", onClick: () => done.forEach((k) => void setArchived(k, false).catch(() => {})) },
  });
  return done;
}

/**
 * Mark done & remove worktree: the shared `removeWorktree` flow (confirm, force confirm when dirty, trust
 * prompt), then archives the agent if its card is still around. Handles its own errors; never rejects.
 */
export async function markDoneAndRemove(key: string): Promise<void> {
  const { hostId } = parseAgentKey(key);
  const agent = getAgentViews().find((a) => a.key === key);
  const ws = agent ? getWorkspacesSnapshot().find((w) => w.hostId === hostId && w.ws.id === agent.workspaceId)?.ws : undefined;
  if (!agent || !ws?.worktree) {
    toast({ title: "No worktree to remove", description: `${agent?.name ?? "This agent"} doesn't run in a linked worktree. Use Mark done instead.`, status: "error" });
    return;
  }
  const removed = await removeWorktree(hostId, ws, { title: `Mark ${agent.name} done and remove its worktree?`, confirmLabel: "Mark done & remove" });
  // Removing the worktree usually closes the agent's pane with it; archive only what is still on the board.
  if (removed && getAgentViews().some((a) => a.key === key)) await setArchived(key, true).catch(() => {});
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

/**
 * Open the session with the composer focused (fresh agents waiting for their first prompt). The
 * composer's draft (text and images) is kept.
 */
export function promptAgent(key: string): void {
  useSessionUi.getState().focusComposer(key);
  openAgent(key);
}

/** "Review diff" makes sense only in a git repo with something to look at. */
export function canReview(agent: { repo?: string; diff?: { files: number }; turns: number }): boolean {
  return !!agent.repo && ((agent.diff?.files ?? 0) > 0 || agent.turns > 0);
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
