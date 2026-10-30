import { type AgentView, core, getAgentViews, getWorkspacesSnapshot, markResuming, navigate, parseAgentKey, resumeAgent, useSettings, useUi } from "@/core";
import type { Answer, ApiError } from "@/core/gen";
import { morphTo, toast } from "@/design";
import { haptic } from "@/features/shell/haptics";
import { confirmResumeMoved } from "@/features/move/resumeGuard";
import { useSessionUi } from "@/features/session/state";
import { removeWorktreeTarget, type WorktreeTarget, worktreeTargetOf } from "@/features/workspace/workspaceActions";

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

/**
 * `agent.archive` (Mark done: Review → Done when true; Reopen: Done → Review when false). Mark done
 * also closes the pane once the agent is idle (`Settings.closeDone`; the agent stays in Done,
 * parked); reopening a parked agent resumes it under a new id (views follow it).
 */
export async function setArchived(key: string, archived: boolean): Promise<void> {
  const { hostId, agentId } = parseAgentKey(key);
  const parked = !archived && getAgentViews().some((a) => a.key === key && a.parked);
  // a card that moved to another host forks an older copy when it resumes here: ask first
  if (parked && !(await confirmResumeMoved(key))) return;
  if (parked) markResuming(key, true);
  try {
    await core.host(hostId).call("agent.archive", archived ? { agentId, archived, close: useSettings.getState().closeDone } : { agentId, archived });
    haptic("success");
  } catch (err) {
    if (parked) markResuming(key, false);
    haptic("warning");
    reportError(archived ? `Couldn't mark ${agentId} done` : `Couldn't reopen ${agentId}`, err);
    throw err;
  }
}

/**
 * Resume a parked agent (its pane was closed when it was marked done): omp --resume in a new pane.
 * Resolves to the new agent's key (null when it failed or never showed up; failures toast).
 */
export async function resumeParked(key: string): Promise<string | null> {
  if (!(await confirmResumeMoved(key))) return null;
  try {
    const next = await resumeAgent(key);
    haptic("success");
    return next;
  } catch (err) {
    haptic("warning");
    if (isApiError(err) && err.code === "unknown_method") toast({ title: "This host can't resume closed agents", description: "Update TeleFlock on the host, or reopen it from Past sessions.", status: "error" });
    else reportError(`Couldn't resume ${parseAgentKey(key).agentId}`, err);
    return null;
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
 * The agent's linked worktree: its live workspace's, else, for a parked agent (Mark done closed the
 * workspace), the checkout its card remembers (hosts ≥ 0.5.2).
 */
export function agentWorktree(agent: AgentView): WorktreeTarget | null {
  const ws = getWorkspacesSnapshot().find((w) => w.hostId === agent.hostId && w.ws.id === agent.workspaceId)?.ws;
  if (ws?.worktree) return worktreeTargetOf(ws);
  const parked = agent.parked?.worktree;
  if (!parked) return null;
  return { path: parked.path, branch: agent.branch, label: parked.path.split(/[\\/]/).filter(Boolean).pop() ?? parked.path, dirty: 0 };
}

/**
 * The shared `removeWorktree` flow (confirm, force confirm when dirty, trust prompt) for the agent's linked
 * worktree, then Mark done while the agent is still on the board and not done yet. Never rejects.
 */
async function removeAgentWorktree(key: string, confirm: (agent: AgentView, name: string) => { title: string; confirmLabel: string }, missing: string): Promise<void> {
  const { hostId } = parseAgentKey(key);
  const agent = getAgentViews().find((a) => a.key === key);
  const target = agent ? agentWorktree(agent) : null;
  if (!agent || !target) {
    toast({ title: "No worktree to remove", description: `${agent?.name ?? "This agent"} doesn't run in a linked worktree. ${missing}`, status: "error" });
    return;
  }
  const removed = await removeWorktreeTarget(hostId, target, confirm(agent, target.branch ?? target.label));
  // Removing the worktree usually closes the agent's pane with it; archive only what is still on the board.
  if (removed && getAgentViews().some((a) => a.key === key && !a.archived)) await setArchived(key, true).catch(() => {});
}

/** Mark done & remove worktree (Review cards, Review's wrap-up): `removeAgentWorktree`. Never rejects. */
export async function markDoneAndRemove(key: string): Promise<void> {
  await removeAgentWorktree(key, (agent) => ({ title: `Mark ${agent.name} done and remove its worktree?`, confirmLabel: "Mark done & remove" }), "Use Mark done instead.");
}

/**
 * Delete worktree (Review/Done cards whose pull request is merged or closed, parked ones included):
 * `removeAgentWorktree`, so a Review card is marked done afterwards. Never rejects.
 */
export async function deleteWorktree(key: string): Promise<void> {
  await removeAgentWorktree(
    key,
    (agent, name) =>
      agent.archived
        ? { title: `Delete worktree ${name}?`, confirmLabel: "Delete worktree" }
        : { title: `Delete worktree ${name} and mark ${agent.name} done?`, confirmLabel: "Delete & mark done" },
    "It may be gone already.",
  );
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

/**
 * Desktop: open the agent's terminal in the split pane. Mobile: the full terminal view. A parked
 * agent has no pane: it resumes first, then its new pane opens.
 */
export function openTerminal(key: string, mobile: boolean): void {
  if (getAgentViews().some((a) => a.key === key && a.parked)) {
    void resumeParked(key).then((next) => next && openTerminal(next, mobile));
    return;
  }
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
