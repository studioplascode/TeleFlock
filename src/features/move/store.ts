import { create } from "zustand";
import { agentKey as agentKeyOf, core, getRoute, navigate, onAppEvent, parseAgentKey, refreshHost, useHosts } from "@/core";
import { type MoveChoice, type MoveOutcome, type MoveProgress, reconcileMoves, runMove } from "@/core/move";
import { toast } from "@/design";
import { haptic } from "@/features/shell/haptics";

/*
 * Moves of agents to other hosts, kept here (keyed by the source agent's key) so one keeps running
 * when its dialog closes. The dialog (MoveDialog) shows `moves[key]`: progress while it runs, the
 * result after. The orchestration itself lives in `@/core/move`.
 */

export interface MoveEntry {
  /** The source agent's key. */
  key: string;
  agentId: string;
  name: string;
  srcHostId: string;
  dstHostId: string;
  srcLabel: string;
  dstLabel: string;
  progress: MoveProgress | null;
  /** Set once the move ended (either way). */
  outcome: MoveOutcome | null;
  controller: AbortController;
}

interface MoveStore {
  moves: Record<string, MoveEntry>;
  /** The agent the dialog is open for. */
  dialogKey: string | null;
  /** Increments on every open: the dialog body resets its state on it. */
  gen: number;
}

export const useMoves = create<MoveStore>()(() => ({ moves: {}, dialogKey: null, gen: 0 }));

function hostName(hostId: string): string {
  return useHosts.getState().profiles.find((p) => p.id === hostId)?.name ?? hostId;
}

function patch(key: string, change: Partial<MoveEntry>): void {
  useMoves.setState((s) => {
    const cur = s.moves[key];
    return cur ? { moves: { ...s.moves, [key]: { ...cur, ...change } } } : s;
  });
}

function drop(key: string): void {
  useMoves.setState((s) => {
    if (!(key in s.moves)) return s;
    const { [key]: _gone, ...moves } = s.moves;
    return { moves };
  });
}

/** Open the Move dialog for an agent: a fresh preflight (a move that is still running shows its progress). */
export function openMoveDialog(agentKey: string): void {
  if (useMoves.getState().moves[agentKey]?.outcome) drop(agentKey);
  useMoves.setState((s) => ({ dialogKey: agentKey, gen: s.gen + 1 }));
}

/** Open the dialog on a finished move's result. */
export function showMove(agentKey: string): void {
  useMoves.setState((s) => ({ dialogKey: agentKey, gen: s.gen + 1 }));
}

export function closeMoveDialog(): void {
  useMoves.setState({ dialogKey: null });
}

/** Forget a finished move (Retry: back to the preflight). */
export function dismissMove(agentKey: string): void {
  if (useMoves.getState().moves[agentKey]?.outcome) drop(agentKey);
}

/** Try a failed move again: back to the preflight, of the agent a rollback resumed (it has a new id). */
export function retryMove(agentKey: string, hostId: string, resumedAgentId?: string): void {
  dismissMove(agentKey);
  if (resumedAgentId && resumedAgentId !== parseAgentKey(agentKey).agentId) openMoveDialog(agentKeyOf(hostId, resumedAgentId));
}

export function useMoveFor(agentKey: string | null): MoveEntry | undefined {
  return useMoves((s) => (agentKey ? s.moves[agentKey] : undefined));
}

/** Navigate to the agent on the target. */
export function openMovedAgent(hostId: string, agentId: string): void {
  navigate({ name: "agent", hostId, agentId });
}

/** Start the move; its progress and result land in `useMoves`. */
export function startMove(args: { agentKey: string; name: string; dstHostId: string; choice: MoveChoice }): void {
  const { agentKey: key, name, dstHostId, choice } = args;
  const { hostId: srcHostId, agentId } = parseAgentKey(key);
  const current = useMoves.getState().moves[key];
  if (current && !current.outcome) return;
  const entry: MoveEntry = { key, agentId, name, srcHostId, dstHostId, srcLabel: hostName(srcHostId), dstLabel: hostName(dstHostId), progress: null, outcome: null, controller: new AbortController() };
  useMoves.setState((s) => ({ moves: { ...s.moves, [key]: entry } }));
  haptic("select");
  void runMove(
    {
      src: core.host(srcHostId),
      dst: core.host(dstHostId),
      srcHostId,
      agentId,
      name,
      fromLabel: entry.srcLabel,
      to: { label: entry.dstLabel, hostId: dstHostId },
      choice,
    },
    { signal: entry.controller.signal, onProgress: (progress) => patch(key, { progress }) },
  ).then((outcome) => void finished(entry, outcome));
}

/** Cancel a running move (the rollback follows; the dialog shows it). */
export function cancelMove(agentKey: string): void {
  useMoves.getState().moves[agentKey]?.controller.abort();
}

async function finished(entry: MoveEntry, outcome: MoveOutcome): Promise<void> {
  patch(entry.key, { outcome });
  const dialogOpen = () => useMoves.getState().dialogKey === entry.key;
  if (outcome.ok) {
    haptic("success");
    const { agentId } = outcome;
    toast({
      title: `${entry.name} moved to ${entry.dstLabel}`,
      description: outcome.notes[0],
      status: "done",
      ...(agentId ? { action: { label: "Open", onClick: () => openMovedAgent(entry.dstHostId, agentId) } } : {}),
    });
    if (!agentId) return;
    const viewing = () => {
      const r = getRoute();
      return r.name === "agent" && r.hostId === entry.srcHostId && r.agentId === entry.agentId;
    };
    if (!viewing()) return;
    // the agent shows up on the target's board with its next state update: fetch it, then follow
    await refreshHost(entry.dstHostId).catch(() => undefined);
    if (viewing()) openMovedAgent(entry.dstHostId, agentId);
    return;
  }
  haptic("warning");
  if (dialogOpen()) return;
  const f = outcome.failure;
  toast({
    title: f.cancelled ? `Cancelled moving ${entry.name}` : `Couldn't move ${entry.name} to ${entry.dstLabel}`,
    description: [f.error.message, f.rolledBack ? `${entry.name} is back on ${entry.srcLabel}` : undefined].filter(Boolean).join(" · "),
    status: f.cancelled ? undefined : "error",
    action: { label: "Details", onClick: () => showMove(entry.key) },
    duration: 8000,
  });
}

// ---------------------------------------------------------------- reconcile

let reconciling = false;

/** Settle moves a previous run (or an unreachable host) left unfinished; see `reconcileMoves`. */
export async function reconcileNow(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    const results = await reconcileMoves({
      client: (id) => (useHosts.getState().profiles.some((p) => p.id === id) ? core.host(id) : null),
      online: (id) => useHosts.getState().status[id]?.phase === "online",
    });
    for (const r of results) {
      if (r.action === "rolledBack") toast({ title: `Move of ${r.record.name} rolled back`, description: `It didn't finish, so ${r.record.name} runs on ${r.record.fromLabel} again.`, status: "review" });
      else if (r.notes.length > 0) toast({ title: `Move of ${r.record.name} to ${r.record.toLabel}`, description: r.notes[0], status: "needs-you" });
    }
  } finally {
    reconciling = false;
  }
}

let reconcileTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Reconcile at start and whenever a host comes online (both ends of an unfinished move must be
 * connected). Debounced so hosts connecting together are settled in one pass.
 */
export function startMoveReconcile(): () => void {
  const schedule = (ms: number) => {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => void reconcileNow(), ms);
  };
  schedule(4000);
  const off = onAppEvent((e) => {
    if (e.type === "hostStatus" && e.status.phase === "online") schedule(2500);
  });
  return () => {
    clearTimeout(reconcileTimer);
    off();
  };
}

if (typeof window !== "undefined") startMoveReconcile();
