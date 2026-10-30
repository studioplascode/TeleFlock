import type { AgentView } from "@/core";
import { agentStateId } from "@/features/shell/vocab";

/*
 * The wall's tile logic, pure: which agent each tile shows. A tile either holds the agent the user
 * put there (a pin) or fills itself with the agent that matters most right now. Auto-filled tiles
 * stay put while their agent stays relevant, so a transcript you are reading never jumps away
 * because another agent got busier; only an agent that needs you takes a slot at once.
 */

/** Tiles on the wall: 2×2 or 3×3. */
export type WallSize = 4 | 9;

export const WALL_SIZES: readonly WallSize[] = [4, 9];

/** Pins are kept for the largest grid, so switching 3×3 → 2×2 → 3×3 restores the arrangement. */
export const MAX_TILES = 9;

/** Columns × rows of a grid. */
export function gridOf(size: WallSize): { cols: number; rows: number } {
  return size === 4 ? { cols: 2, rows: 2 } : { cols: 3, rows: 3 };
}

/**
 * Auto-fill priority: lower is more important. `offline`: any agent whose host isn't online (its
 * transcript can't move), which only fills a tile when nothing live is left.
 */
export const RANK = { needs: 0, running: 1, review: 2, fresh: 3, offline: 4 } as const;

/**
 * A finished (or otherwise demoted) agent keeps its auto-filled tile this long before a busier one
 * takes it, so you can still read how it ended. An agent that needs you never waits.
 */
export const LINGER_MS = 120_000;

/** An agent that may fill a tile: its rank and when it entered its current state. */
export interface WallCandidate {
  key: string;
  rank: number;
  since: number;
}

type CandidateAgent = Pick<AgentView, "key" | "hostId" | "column" | "turns" | "title" | "stateSince" | "needs">;

/** Rank of an agent for auto-fill; `null` = never auto-filled (done, parked). */
export function rankOf(a: CandidateAgent, online: boolean): number | null {
  const state = agentStateId(a);
  if (state === "done") return null;
  return online ? RANK[state] : RANK.offline;
}

/**
 * Agents that may fill a tile, most important first: needs you (oldest question first), running
 * (longest turn first), to review (newest first), fresh agents waiting for a prompt, then agents
 * of hosts that aren't online (`online` says which hosts are).
 */
export function wallCandidates(agents: readonly CandidateAgent[], online: (hostId: string) => boolean): WallCandidate[] {
  const out: WallCandidate[] = [];
  for (const a of agents) {
    const rank = rankOf(a, online(a.hostId));
    if (rank === null) continue;
    out.push({ key: a.key, rank, since: rank === RANK.needs ? (a.needs?.since ?? a.stateSince) : a.stateSince });
  }
  return out.sort((a, b) => a.rank - b.rank || (a.rank <= RANK.running ? a.since - b.since : b.since - a.since) || a.key.localeCompare(b.key));
}

export interface AssignInput {
  /** Tiles on screen. */
  size: number;
  /** The agent the user put in each tile (index = tile); `null` = the tile fills itself. */
  pins: readonly (string | null)[];
  /** What each tile showed last time: auto-filled tiles keep their agent while it stays a candidate. */
  prev: readonly (string | null)[];
  /** Agents that may fill a tile, most important first (`wallCandidates`). */
  candidates: readonly WallCandidate[];
  /** Agents taken off the wall by hand: never auto-filled. */
  hidden: readonly string[];
  /** Fill unpinned tiles automatically (off: they stay empty until you pick an agent). */
  auto: boolean;
  now: number;
  lingerMs?: number;
}

/**
 * What each tile shows: its pin, else (with `auto`) the agent it showed before if that one is still a
 * candidate, else the most important candidate not on the wall yet. A candidate that outranks an
 * auto-filled agent takes its tile: at once when it needs you, otherwise once that agent has been
 * in its current state for `lingerMs`. Pinned tiles never change by themselves.
 */
export function assignTiles({ size, pins, prev, candidates, hidden, auto, now, lingerMs = LINGER_MS }: AssignInput): (string | null)[] {
  const tiles: (string | null)[] = Array.from({ length: size }, () => null);
  const pinned: boolean[] = tiles.map(() => false);
  const used = new Set<string>();
  for (let i = 0; i < size; i++) {
    const pin = pins[i];
    if (pin == null || used.has(pin)) continue;
    tiles[i] = pin;
    pinned[i] = true;
    used.add(pin);
  }
  if (!auto) return tiles;

  const skip = new Set(hidden);
  const byKey = new Map(candidates.map((c, order) => [c.key, { ...c, order }]));
  for (let i = 0; i < size; i++) {
    const was = prev[i];
    if (pinned[i] || was == null || used.has(was) || skip.has(was) || !byKey.has(was)) continue;
    tiles[i] = was;
    used.add(was);
  }
  const pending = candidates.filter((c) => !used.has(c.key) && !skip.has(c.key));
  for (let i = 0; i < size && pending.length > 0; i++) {
    if (pinned[i] || tiles[i] !== null) continue;
    const next = pending.shift() as WallCandidate;
    tiles[i] = next.key;
    used.add(next.key);
  }

  // Promotion: the best waiting candidate takes the least important auto-filled tile it outranks.
  while (pending.length > 0) {
    const p = pending[0] as WallCandidate;
    let slot = -1;
    let worst: { rank: number; order: number } | null = null;
    for (let i = 0; i < size; i++) {
      const key = tiles[i];
      if (pinned[i] || key == null) continue;
      const o = byKey.get(key);
      if (!o || o.rank <= p.rank) continue;
      if (p.rank !== RANK.needs && now - o.since < lingerMs) continue;
      if (!worst || o.rank > worst.rank || (o.rank === worst.rank && o.order > worst.order)) {
        worst = { rank: o.rank, order: o.order };
        slot = i;
      }
    }
    // Later candidates rank no better, so whoever this one can't displace, they can't either.
    if (slot < 0) break;
    pending.shift();
    tiles[slot] = p.key;
  }
  return tiles;
}

/** Pins padded to `MAX_TILES` (stored arrays from older versions may be shorter). */
export function normalizePins(pins: readonly (string | null)[]): (string | null)[] {
  return Array.from({ length: MAX_TILES }, (_, i) => pins[i] ?? null);
}

/**
 * Put `key` in tile `index`. When it already shows in another tile, the two tiles trade places
 * (both pinned: an arrangement made by hand is kept); otherwise it is pinned there and whatever
 * the tile pinned before is let go.
 */
export function placeAgent(pins: readonly (string | null)[], shown: readonly (string | null)[], index: number, key: string): (string | null)[] {
  const from = shown.indexOf(key);
  if (from >= 0 && from !== index) return swapTiles(pins, shown, from, index);
  const next = normalizePins(pins);
  // the same agent pinned beyond the visible grid would show twice after switching to 3×3
  for (let i = 0; i < next.length; i++) if (next[i] === key) next[i] = null;
  next[index] = key;
  return next;
}

/** Trade the agents of two tiles (drag a tile onto another); both end up pinned, an empty tile stays unpinned. */
export function swapTiles(pins: readonly (string | null)[], shown: readonly (string | null)[], a: number, b: number): (string | null)[] {
  const next = normalizePins(pins);
  if (a === b) return next;
  const atA = shown[a] ?? null;
  const atB = shown[b] ?? null;
  // either agent pinned in a tile beyond the visible grid would show twice after switching to 3×3
  for (let i = 0; i < next.length; i++) if (next[i] !== null && (next[i] === atA || next[i] === atB)) next[i] = null;
  next[a] = atB;
  next[b] = atA;
  return next;
}

/** A parked agent resumed under a new id: its pin (and its place on the hidden list) follow it. */
export function renameKey<T extends string | null>(list: readonly T[], from: string, to: string): T[] {
  return list.map((k) => (k === from ? (to as T) : k));
}

/** Agents whose session was deleted leave the wall: their pins empty, the hidden list forgets them. */
export function dropKeys(pins: readonly (string | null)[], hidden: readonly string[], gone: ReadonlySet<string>): { pins: (string | null)[]; hidden: string[] } {
  return { pins: pins.map((k) => (k !== null && gone.has(k) ? null : k)), hidden: hidden.filter((k) => !gone.has(k)) };
}
