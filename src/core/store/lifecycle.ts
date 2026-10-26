import type { Agent, PrunedAgent } from "@/core/gen";
import { agentKey } from "../keys";
import type { AgentView, CoreState, Departed } from "./state";
import type { Tx } from "./tx";

/*
 * Done agents' lifecycle on the client (architecture §6.1 "Parked and pruned agents"):
 * - a parked agent (Mark done closed its pane) that resumes comes back under a new id with the same
 *   omp session: `successors` maps its old key to the new one so views can follow it;
 * - an agent whose omp session file was deleted is listed in `HostInfo.pruned`: the client drops
 *   what it keeps for it.
 */

/** How long after a parked agent leaves the list the agent resuming its session may appear. */
export const FOLLOW_WINDOW_MS = 30_000;
/** Successor links kept (oldest dropped first); a link only matters while a view shows the old id. */
const MAX_SUCCESSORS = 200;

/** The live key an old key leads to (following resume after resume), or undefined when it never moved. */
export function resolveSuccessor(successors: Readonly<Record<string, string>>, key: string): string | undefined {
  let cur: string | undefined = successors[key];
  if (cur === undefined) return undefined;
  for (let hops = 0; hops < 32; hops++) {
    const next: string | undefined = successors[cur];
    if (next === undefined || next === key) break;
    cur = next;
  }
  return cur;
}

/** Every key that leads to `key` through successor links (its earlier ids), `key` excluded. */
export function predecessorsOf(successors: Readonly<Record<string, string>>, key: string): string[] {
  return Object.keys(successors).filter((k) => k !== key && resolveSuccessor(successors, k) === key);
}

function sameSession(s: { sessionId?: string; sessionFile?: string }, a: Agent): boolean {
  const o = a.omp;
  if (!o || a.parked) return false;
  return (!!s.sessionId && o.sessionId === s.sessionId) || (!!s.sessionFile && o.sessionFile === s.sessionFile);
}

function link(tx: Tx, d: CoreState, from: string, to: string): void {
  if (from === to || d.successors[from] === to) return;
  d.successors = tx.own(d.successors);
  d.successors[from] = to;
  const keys = Object.keys(d.successors);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SUCCESSORS))) delete d.successors[k];
}

/** `agent.resume` answered with the new id (`Started.agentId`). */
export function noteSuccessor(tx: Tx, d: CoreState, hostId: string, from: string, to: string): void {
  link(tx, d, agentKey(hostId, from), agentKey(hostId, to));
}

/**
 * An agent left its host's list. A parked one links to the live agent already holding its session
 * (both changes in one patch), or waits in `departed` for that agent to show up.
 */
export function agentGone(tx: Tx, d: CoreState, old: AgentView, now: number): void {
  if (!old.parked) return;
  const session = { sessionId: old.omp?.sessionId, sessionFile: old.parked.sessionFile || old.omp?.sessionFile };
  const heir = Object.values(d.agents).find((a) => a.hostId === old.hostId && a.key !== old.key && sameSession(session, a));
  if (heir) {
    link(tx, d, old.key, heir.key);
    return;
  }
  const departed: Departed = { key: old.key, hostId: old.hostId, ...session, at: now };
  d.departed = [...d.departed.filter((x) => now - x.at <= FOLLOW_WINDOW_MS && x.key !== old.key), departed];
}

/** An agent appeared or changed: is it the one resuming a parked agent that just left? */
export function agentSeen(tx: Tx, d: CoreState, hostId: string, next: Agent, now: number): void {
  if (d.departed.length === 0 || next.parked) return;
  const key = agentKey(hostId, next.id);
  const live = d.departed.filter((x) => now - x.at <= FOLLOW_WINDOW_MS);
  const hit = live.find((x) => x.hostId === hostId && x.key !== key && sameSession(x, next));
  if (hit) link(tx, d, hit.key, key);
  if (hit || live.length !== d.departed.length) d.departed = live.filter((x) => x !== hit);
}

/** `HostInfo.pruned` entries in `next` that `prev` didn't list. */
export function newlyPruned(prev: readonly PrunedAgent[] | undefined, next: readonly PrunedAgent[] | undefined): PrunedAgent[] {
  if (!next?.length || next === prev) return [];
  const seen = new Set((prev ?? []).map((p) => `${p.agentId}@${p.at}`));
  return next.filter((p) => !seen.has(`${p.agentId}@${p.at}`));
}

/** Keys of pruned agents on a host, earlier ids (before resumes) included. */
export function prunedKeys(successors: Readonly<Record<string, string>>, hostId: string, pruned: readonly PrunedAgent[]): Set<string> {
  const keys = new Set<string>();
  for (const p of pruned) {
    const key = agentKey(hostId, p.agentId);
    keys.add(key);
    for (const k of predecessorsOf(successors, key)) keys.add(k);
  }
  return keys;
}

/** Drops what the store keeps for pruned agents: their notifications and session caches. */
export function dropPruned(tx: Tx, d: CoreState, hostId: string, pruned: readonly PrunedAgent[]): void {
  if (pruned.length === 0) return;
  const keys = prunedKeys(d.successors, hostId, pruned);
  if (d.notifications.some((n) => n.hostId === hostId && keys.has(agentKey(hostId, n.agentId)))) {
    d.notifications = d.notifications.filter((n) => !(n.hostId === hostId && keys.has(agentKey(hostId, n.agentId))));
  }
  if ([...keys].some((k) => k in d.sessions)) {
    d.sessions = tx.own(d.sessions);
    for (const k of keys) delete d.sessions[k];
  }
}
