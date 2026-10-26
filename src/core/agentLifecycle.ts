import { create } from "zustand";
import { core, pushInternal } from "./client";
import { agentKey, parseAgentKey } from "./keys";
import { getRoute, navigate } from "./nav";
import { FOLLOW_WINDOW_MS, newlyPruned, prunedKeys, resolveSuccessor } from "./store/lifecycle";
import type { CoreState } from "./store/state";
import { coreStore } from "./store/store";
import { useUi } from "./ui";

/*
 * Done agents on the client, side effects (pure parts: store/lifecycle.ts):
 * - resuming a parked agent and following it to its new id (route, split, board selection, and
 *   whatever features registered with `onAgentMoved`);
 * - forgetting agents whose omp session was deleted (`HostInfo.pruned`) wherever features keep
 *   them (`onAgentsPruned`).
 */

/** One pruned agent: every key it had (earlier ids before resumes included) and its omp session. */
export interface PrunedGone {
  hostId: string;
  agentId: string;
  keys: string[];
  sessionId?: string;
}

// ---------------------------------------------------------------- resuming

interface ResumingState {
  /** Parked agents being resumed from here (key → since), until the new agent shows up. */
  since: Record<string, number>;
}

const useResumingStore = create<ResumingState>()(() => ({ since: {} }));

/** Marks a parked agent as resuming here ("Resuming…") until its successor appears, or clears it. */
export function markResuming(key: string, on: boolean): void {
  const cur = useResumingStore.getState().since;
  if (on === (key in cur)) return;
  const since = { ...cur };
  if (!on) {
    delete since[key];
    useResumingStore.setState({ since });
    return;
  }
  const at = Date.now();
  since[key] = at;
  useResumingStore.setState({ since });
  // a resume that never showed up (host gone quiet) stops saying "Resuming…"
  setTimeout(() => useResumingStore.getState().since[key] === at && markResuming(key, false), FOLLOW_WINDOW_MS + 15_000);
}

/** Is this parked agent being resumed from this app? */
export function useResuming(key: string): boolean {
  return useResumingStore((s) => key in s.since);
}

/** Resolves with the agent's new key once that agent is in host state (null after the follow window). */
function whenPresent(key: string): Promise<string | null> {
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  return new Promise((resolve) => {
    const check = (s: CoreState): string | null => {
      const next = resolveSuccessor(s.successors, key);
      return next && s.agents[next] ? next : null;
    };
    const hit = check(coreStore.getState());
    if (hit) return resolve(hit);
    const timer = setTimeout(() => {
      unsub();
      resolve(null);
    }, FOLLOW_WINDOW_MS);
    const unsub = coreStore.subscribe((s) => {
      const next = check(s);
      if (!next) return;
      clearTimeout(timer);
      unsub();
      resolve(next);
    });
  });
}

/**
 * `agent.resume` of a parked agent (omp --resume in a new pane). Resolves with the new agent's key
 * once it is on the board (null if it never showed up); views on the old key follow on their own.
 * Rejects with the host's ApiError (older hosts: `unknown_method`).
 */
export async function resumeAgent(key: string): Promise<string | null> {
  const { hostId, agentId } = parseAgentKey(key);
  markResuming(key, true);
  try {
    const started = await core.host(hostId).call("agent.resume", { agentId });
    if (started.agentId) pushInternal({ type: "$successor", hostId, from: agentId, to: started.agentId });
  } catch (err) {
    markResuming(key, false);
    throw err;
  }
  return whenPresent(key);
}

// ---------------------------------------------------------------- following and pruning

type MovedListener = (from: string, to: string) => void;
type PrunedListener = (gone: PrunedGone[]) => void;

const movedListeners = new Set<MovedListener>();
const prunedListeners = new Set<PrunedListener>();
/** Every pruned agent seen since start, replayed to listeners that register later. */
const prunedLog: PrunedGone[] = [];
/** Successor links not applied yet: their new agent isn't in host state (key → when linked). */
const pendingMoves = new Map<string, number>();

/** A parked agent resumed under a new key (after core views followed it). Returns `unsubscribe`. */
export function onAgentMoved(cb: MovedListener): () => void {
  movedListeners.add(cb);
  return () => movedListeners.delete(cb);
}

/**
 * Agents whose omp session was deleted: drop everything kept for them. Listeners get the agents
 * pruned so far right away, then each new batch; handlers must be idempotent.
 */
export function onAgentsPruned(cb: PrunedListener): () => void {
  prunedListeners.add(cb);
  if (prunedLog.length > 0) cb(prunedLog.slice());
  return () => prunedListeners.delete(cb);
}

/** Point the route, the split and the board selection at the agent's new key. */
function follow(from: string, to: string): void {
  const next = parseAgentKey(to);
  const route = getRoute();
  if (route.name === "agent" && agentKey(route.hostId, route.agentId) === from) navigate({ name: "agent", ...next }, { replace: true });
  else if (route.name === "terminal" && route.agentId && agentKey(route.hostId, route.agentId) === from)
    navigate({ name: "terminal", hostId: next.hostId, agentId: next.agentId }, { replace: true });
  const ui = useUi.getState();
  const split = ui.split;
  if (split?.kind === "session" && split.key === from) ui.setSplit({ kind: "session", key: to });
  else if (split?.kind === "terminal" && split.agentId && agentKey(split.hostId, split.agentId) === from) ui.setSplit({ kind: "terminal", hostId: next.hostId, agentId: next.agentId });
  if (ui.selectedKey === from) ui.select(to);
  markResuming(from, false);
  for (const l of movedListeners) l(from, to);
}

function applyMoves(s: CoreState, prev: CoreState): void {
  if (s.successors !== prev.successors) {
    for (const [from, to] of Object.entries(s.successors)) if (prev.successors[from] !== to) pendingMoves.set(from, Date.now());
  }
  if (pendingMoves.size === 0 || (s.agents === prev.agents && s.successors === prev.successors)) return;
  const now = Date.now();
  for (const [from, at] of pendingMoves) {
    const to = resolveSuccessor(s.successors, from);
    if (to && s.agents[to]) {
      pendingMoves.delete(from);
      follow(from, to);
    } else if (now - at > FOLLOW_WINDOW_MS) pendingMoves.delete(from);
  }
}

function scanPruned(s: CoreState, prev: CoreState): void {
  if (s.hosts === prev.hosts) return;
  const batch: PrunedGone[] = [];
  for (const [hostId, entry] of Object.entries(s.hosts)) {
    for (const p of newlyPruned(prev.hosts[hostId]?.state.info.pruned, entry.state.info.pruned)) {
      batch.push({ hostId, agentId: p.agentId, sessionId: p.sessionId, keys: [...prunedKeys(s.successors, hostId, [p])] });
    }
  }
  if (batch.length === 0) return;
  prunedLog.push(...batch);
  if (prunedLog.length > 1000) prunedLog.splice(0, prunedLog.length - 1000);
  const keys = new Set(batch.flatMap((g) => g.keys));
  for (const key of keys) {
    markResuming(key, false);
    pendingMoves.delete(key);
  }
  // Nothing is left to show: views on the agent go back to the board.
  const route = getRoute();
  if ((route.name === "agent" || (route.name === "terminal" && route.agentId)) && keys.has(agentKey(route.hostId, route.agentId ?? ""))) navigate({ name: "board" }, { replace: true });
  const ui = useUi.getState();
  const split = ui.split;
  if (split && keys.has(split.kind === "session" ? split.key : agentKey(split.hostId, split.agentId ?? ""))) ui.setSplit(null);
  if (ui.selectedKey && keys.has(ui.selectedKey)) ui.select(null);
  for (const l of prunedListeners) l(batch);
}

let started = false;

/** Follow resumed agents and announce pruned ones from every store change. Idempotent. */
export function startAgentLifecycle(): void {
  if (started) return;
  started = true;
  coreStore.subscribe((s, prev) => {
    applyMoves(s, prev);
    scanPruned(s, prev);
  });
}
