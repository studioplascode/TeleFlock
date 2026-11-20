import type { Subagent, SubagentStatus } from "@/core/gen";
import { groupSubagents, idParent } from "../subagents/grouping";
import { type BoardMessage, type ChatAgent, MAIN } from "./chat";

/**
 * The message board's Graph tab (architecture §6.17): the session's agent tree and who wrote to
 * whom, as of a point on the log's timeline. Pure: the tree, the aggregation, who was still running
 * at that point, the timeline's pacing and summary, and the layout.
 */

// ── the tree and the aggregation ──

/** An agent of the session's tree: the id the log names it by, and the agent it runs under (none: the tree's root). */
export interface TreeAgent {
  id: string;
  parent?: string;
}

/**
 * The session's agent tree as the graph names it: the main agent, then every subagent at any depth
 * in roster order, by omp's agent id (the roster's `name`, which the log names it by), under the
 * one it runs under (`groupSubagents`: `parentId`, else the dotted id; a parent the roster lacks by
 * that id; the main agent for its own). None without subagents.
 */
export function sessionTree(subs: readonly Subagent[]): TreeAgent[] {
  if (subs.length === 0) return [];
  const { nodes } = groupSubagents(subs);
  const out: TreeAgent[] = [{ id: MAIN }];
  const seen = new Set([MAIN]);
  for (const s of subs) {
    const n = nodes.get(s.id);
    // The log can't tell two roster rows with one omp id apart: the first one stands for both, as `agentNamer` does.
    if (!n || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({ id: s.name, parent: n.parent?.sub.name ?? n.orphanOf ?? MAIN });
  }
  return out;
}

/** An agent on the graph: one of the session's tree, or anyone else who sent a message or was sent one. */
export interface GraphNode {
  id: string;
  sent: number;
  /** Messages it was sent: direct ones, and broadcasts that list it. */
  got: number;
  /** Broadcasts it sent (`agent://all`): its `@all N` badge. */
  broadcasts: number;
  /**
   * It sent a message that names no recipient: a broadcast whose recipients the log doesn't know
   * (omp listed none, or the send was cut off before any went out). A dotted border.
   */
  unaddressed: boolean;
  /** Its newest message, sent or got; none for an agent of the tree that never wrote nor was written to (silent). */
  last?: string;
}

/** The messages from one agent to another, one way: A ↔ B are two edges. */
export interface GraphEdge {
  from: string;
  to: string;
  /** The legs of `from`'s broadcasts that list `to` (dashed, drawn with Expand @all only), not direct messages. */
  viaAll: boolean;
  /** Oldest first; the count is their number. */
  ids: string[];
}

/** Who runs under whom: the nearest agent on the graph `child` runs under. */
export interface SpawnEdge {
  parent: string;
  child: string;
}

export interface ChatGraph {
  /** The tree's agents in its order, then everyone else by first appearance. */
  nodes: GraphNode[];
  edges: GraphEdge[];
  spawns: SpawnEdge[];
}

/** An edge's key: its direction, and whether it carries broadcasts. */
export function edgeKey(e: Pick<GraphEdge, "from" | "to" | "viaAll">): string {
  return `${e.viaAll ? "*" : ""}${e.from}\n${e.to}`;
}

/**
 * The session's tree and who wrote to whom in `messages` (oldest first). Every agent of `tree` is a
 * node, silent or not; so is everyone else a message names. Every message counts once for its
 * sender and once for each recipient it lists (a reply too: it is a message to the one it answers),
 * on the edge from sender to recipient. A broadcast also counts for its sender's `@all` badge, and
 * its legs go on edges of their own. A message to oneself draws no edge. Each agent hangs under its
 * tree parent, else the agent its dotted id names, the nearest one on the graph (an agent of the tree
 * with neither: under the main agent).
 */
export function buildGraph(messages: readonly BoardMessage[], tree: readonly TreeAgent[] = []): ChatGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const node = (id: string, m?: BoardMessage): GraphNode => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { id, sent: 0, got: 0, broadcasts: 0, unaddressed: false }));
    if (m) n.last = m.id;
    return n;
  };
  for (const a of tree) node(a.id);
  for (const m of messages) {
    const from = node(m.from, m);
    from.sent++;
    if (m.broadcast) from.broadcasts++;
    const to = [...new Set(m.to)].filter((id) => id !== m.from);
    if (to.length === 0) from.unaddressed = true;
    for (const id of to) {
      node(id, m).got++;
      const key = edgeKey({ from: m.from, to: id, viaAll: m.broadcast });
      let e = edges.get(key);
      if (!e) edges.set(key, (e = { from: m.from, to: id, viaAll: m.broadcast, ids: [] }));
      e.ids.push(m.id);
    }
  }
  const parents = new Map(tree.map((a) => [a.id, a.parent]));
  const spawns: SpawnEdge[] = [];
  for (const id of nodes.keys()) {
    const inTree = parents.has(id);
    let p = inTree ? parents.get(id) : idParent(id);
    while (p !== undefined && !nodes.has(p)) p = idParent(p);
    if (p === undefined && inTree && id !== MAIN && nodes.has(MAIN)) p = MAIN;
    if (p !== undefined && p !== id) spawns.push({ parent: p, child: id });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], spawns };
}

/**
 * The graph with only the agents `keep` keeps, the edges between them, and each kept agent under
 * the nearest kept one it runs under (at any depth).
 */
export function keepNodes(g: ChatGraph, keep: (n: GraphNode) => boolean): ChatGraph {
  const nodes = g.nodes.filter(keep);
  if (nodes.length === g.nodes.length) return g;
  const on = new Set(nodes.map((n) => n.id));
  const up = new Map(g.spawns.map((s) => [s.child, s.parent]));
  const spawns: SpawnEdge[] = [];
  for (const n of nodes) {
    // A loop (only malformed data has one) ends the walk.
    const seen = new Set([n.id]);
    let p = up.get(n.id);
    while (p !== undefined && !on.has(p) && !seen.has(p)) {
      seen.add(p);
      p = up.get(p);
    }
    if (p !== undefined && on.has(p) && p !== n.id) spawns.push({ parent: p, child: n.id });
  }
  return { nodes, edges: g.edges.filter((e) => on.has(e.from) && on.has(e.to)), spawns };
}

/** The agent the layout puts at the top centre: the main agent, else the one in the most messages (the first of equals). */
export function pickHub(g: ChatGraph): string | undefined {
  if (g.nodes.some((n) => n.id === MAIN)) return MAIN;
  let hub: GraphNode | undefined;
  for (const n of g.nodes) if (!hub || n.sent + n.got > hub.sent + hub.got) hub = n;
  return hub?.id;
}

// ── who was running ──

/**
 * Whether an agent is on the graph at `t`: it posted or was addressed by then, or it isn't a
 * subagent the tree spawned after `t` (one the roster gives no start always was there).
 */
export function presentAt(n: GraphNode, a: ChatAgent, t: number): boolean {
  return n.sent + n.got > 0 || a.sub?.startedAt === undefined || a.sub.startedAt <= t;
}

/** A subagent's status at `t` (`Infinity`: now): one that ended after `t` was still running then. */
export function statusAt(sub: Subagent, t: number): SubagentStatus {
  if (sub.status === "running" || t === Number.POSITIVE_INFINITY) return sub.status;
  return sub.endedAt !== undefined && t < sub.endedAt ? "running" : sub.status;
}

/**
 * Whether an agent was still at work at `t`: a subagent while it ran. The main agent, You and agents
 * the roster doesn't list always count (nothing says they finished).
 */
export function activeAt(a: ChatAgent, t: number): boolean {
  return !a.sub || statusAt(a.sub, t) === "running";
}

// ── the timeline ──

/** `even`: every message one step; `real`: steps in proportion to the time between messages. */
export type Pacing = "even" | "real";
/** Playback at 1×: a message a second on average, at either pacing. */
export const STEP_MS = 1000;

/**
 * Where each message sits on the timeline's track (0..1; 0 is before the first, the last is at 1).
 * Even pacing spaces them equally; real-time pacing by their times, the first one an average gap
 * in. Messages all sent at once fall back to even spacing.
 */
export function trackPositions(ats: readonly number[], pacing: Pacing): number[] {
  const n = ats.length;
  const first = ats[0] ?? 0;
  const span = (ats[n - 1] ?? first) - first;
  if (pacing === "even" || span <= 0) return ats.map((_, i) => (i + 1) / n);
  const lead = span / n;
  return ats.map((at) => (at - first + lead) / (span + lead));
}

/** Where the playhead sits with the first `shown` messages on the graph. */
export function trackAt(positions: readonly number[], shown: number): number {
  return shown <= 0 ? 0 : (positions[Math.min(shown, positions.length) - 1] ?? 0);
}

/**
 * How many messages show with the playhead dragged to `x` (0..1): up to the message whose mark is
 * nearest (those sent at the same moment show together).
 */
export function countNear(positions: readonly number[], x: number): number {
  let best = 0;
  let dist = Math.abs(x);
  positions.forEach((p, i) => {
    const d = Math.abs(p - x);
    if (d <= dist) {
      best = i + 1;
      dist = d;
    }
  });
  return best;
}

/** How long playback waits before the next message at `speed`, `shown` on the graph: the whole log takes as long at either pacing. */
export function stepDelay(positions: readonly number[], shown: number, speed: number): number {
  const next = positions[shown];
  if (next === undefined) return 0;
  return ((next - trackAt(positions, shown)) * positions.length * STEP_MS) / speed;
}

export interface TimelineSummary {
  shown: number;
  total: number;
  /** From the first message to the last one shown. */
  span: number;
  /** From the first message to the last. */
  totalSpan: number;
}

/** The timeline with its first `shown` messages on the graph; `ats` oldest first. */
export function summarize(ats: readonly number[], shown: number): TimelineSummary {
  const first = ats[0] ?? 0;
  const k = Math.max(0, Math.min(shown, ats.length));
  return { shown: k, total: ats.length, span: k > 0 ? (ats[k - 1] as number) - first : 0, totalSpan: ats.length > 0 ? (ats[ats.length - 1] as number) - first : 0 };
}

/** "45s", "12m 40s", "3h 05m", "2d 4h". */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

/** "15 posts over 3h 05m"; scrubbed back: "7 of 15 posts · 1h 12m of 3h 05m"; none yet: "0 posts". */
export function summaryText(s: TimelineSummary): string {
  const posts = (n: number) => `${n} post${n === 1 ? "" : "s"}`;
  if (s.total === 0) return posts(0);
  if (s.shown >= s.total) return s.total === 1 ? posts(1) : `${posts(s.total)} over ${spanText(s.totalSpan)}`;
  if (s.shown === 0) return `0 of ${posts(s.total)}`;
  return `${s.shown} of ${posts(s.total)} · ${spanText(s.span)} of ${spanText(s.totalSpan)}`;
}

// ── layout ──

/** A node to place: its pill's size and the agent it hangs under (another item; none or unknown: the hub). */
export interface LayoutItem {
  id: string;
  parent?: string;
  w: number;
  h: number;
}

export interface GraphLayout {
  /** Each node's centre. */
  pos: Map<string, { x: number; y: number }>;
  /** What the drawing needs: the canvas's height, or more when it doesn't fit (the canvas scrolls). */
  height: number;
}

/** Canvas edge to a node. */
const MARGIN = 14;
/** Room above the hub for its `@all` badge. */
const BADGE_ROOM = 12;
/** Between neighbours in a lane. */
const GAP_X = 14;
/** Between the lanes of a crowded row (plus a node's height). */
const LANE_GAP = 12;
/** Widest column a leaf gets: few agents stay together on a wide canvas. */
const MAX_SLOT = 180;
const MIN_ROW = 72;
const MAX_ROW = 150;

/**
 * Places the graph: the hub at the top centre, every other agent in a row by its depth under the
 * hub, in its tree's order, so an agent's own subagents sit below it (a parent over the middle of
 * its children, each leaf its own column across the canvas's width), which keeps the edges of an
 * orchestration short. A row whose agents fit side by side stays one lane, each as near its column
 * as its neighbours leave room for, and sags in the middle, so a row of workers arcs around the hub
 * and the edges between them curve inside the arc instead of running along the row. A row too
 * wide for the canvas staggers into lanes; a drawing taller than the canvas grows it (it
 * scrolls), a shorter one sits in its middle. Deterministic: the same items and size give the
 * same places.
 */
export function layoutGraph(items: readonly LayoutItem[], hub: string, width: number, height: number): GraphLayout {
  const byId = new Map(items.map((it) => [it.id, it]));
  const pos = new Map<string, { x: number; y: number }>();
  const top = byId.get(hub);
  if (!top) return { pos, height };

  const kids = new Map<string, string[]>(items.map((it) => [it.id, []]));
  for (const it of items) {
    if (it.id === hub) continue;
    const up = it.parent !== undefined && it.parent !== it.id && byId.has(it.parent) ? it.parent : hub;
    kids.get(up)?.push(it.id);
  }

  // Depth first from the hub: leaves take the next column, a parent sits over the middle of its
  // children. A parent link that loops (malformed data) leaves its agents out: they go under the hub.
  const depth = new Map<string, number>();
  const col = new Map<string, number>();
  let leaves = 0;
  const place = (root: string, d0: number) => {
    const stack: { id: string; d: number; done: boolean }[] = [{ id: root, d: d0, done: false }];
    while (stack.length > 0) {
      const cur = stack.pop() as { id: string; d: number; done: boolean };
      const ch = (kids.get(cur.id) ?? []).filter((c) => !depth.has(c) || col.has(c));
      if (cur.done) {
        const placed = ch.filter((c) => col.has(c));
        col.set(cur.id, placed.length === 0 ? leaves++ : ((col.get(placed[0] as string) as number) + (col.get(placed[placed.length - 1] as string) as number)) / 2);
        continue;
      }
      if (depth.has(cur.id)) continue;
      depth.set(cur.id, cur.d);
      stack.push({ ...cur, done: true });
      for (let i = ch.length - 1; i >= 0; i--) if (!depth.has(ch[i] as string)) stack.push({ id: ch[i] as string, d: cur.d + 1, done: false });
    }
  };
  depth.set(hub, 0);
  for (const c of kids.get(hub) ?? []) place(c, 1);
  for (const it of items) if (!depth.has(it.id)) place(it.id, 1);

  const cx = width / 2;
  const avail = Math.max(1, width - 2 * MARGIN);
  const slot = leaves > 0 ? Math.min(MAX_SLOT, avail / leaves) : 0;
  const xOf = (it: LayoutItem) => {
    const x = cx + ((col.get(it.id) ?? 0) - (leaves - 1) / 2) * slot;
    const half = it.w / 2;
    return half * 2 >= avail ? cx : Math.min(width - MARGIN - half, Math.max(MARGIN + half, x));
  };

  // Rows by depth, each agent where its column puts it.
  const rows: LayoutItem[][] = [];
  for (const it of items) if (it.id !== hub) (rows[(depth.get(it.id) ?? 1) - 1] ??= []).push(it);
  const xs = new Map<string, number>();
  const lane = new Map<string, number>();
  const lanes: number[] = [];
  let maxH = top.h;
  rows.forEach((row, r) => {
    const sorted = row.map((it) => ({ it, x: xOf(it) })).sort((a, b) => a.x - b.x || (col.get(a.it.id) ?? 0) - (col.get(b.it.id) ?? 0));
    for (const { it } of sorted) maxH = Math.max(maxH, it.h);
    lanes[r] = 1;
    if (sorted.reduce((sum, s) => sum + s.it.w + GAP_X, -GAP_X) <= avail) {
      // They fit in one lane: left to right each clears the one before, then right to left each
      // stays on the canvas and clears the one after.
      sorted.forEach((s, i) => {
        const prev = sorted[i - 1];
        s.x = Math.max(s.x, MARGIN + s.it.w / 2, prev ? prev.x + (prev.it.w + s.it.w) / 2 + GAP_X : Number.NEGATIVE_INFINITY);
      });
      for (let i = sorted.length - 1; i >= 0; i--) {
        const s = sorted[i] as (typeof sorted)[number];
        const next = sorted[i + 1];
        s.x = Math.min(s.x, width - MARGIN - s.it.w / 2, next ? next.x - (next.it.w + s.it.w) / 2 - GAP_X : Number.POSITIVE_INFINITY);
      }
      for (const s of sorted) xs.set(s.it.id, s.x);
      return;
    }
    // Too wide: each agent in the first lane with room for it.
    const right: number[] = [];
    for (const { it, x } of sorted) {
      xs.set(it.id, x);
      let j = right.findIndex((edge) => edge + GAP_X <= x - it.w / 2);
      if (j < 0) j = right.push(Number.NEGATIVE_INFINITY) - 1;
      right[j] = x + it.w / 2;
      lane.set(it.id, j);
    }
    lanes[r] = right.length;
  });

  const laneH = maxH + LANE_GAP;
  const hubY = MARGIN + BADGE_ROOM + top.h / 2;
  const extra = lanes.reduce((sum, n) => sum + (n - 1) * laneH, 0);
  const free = height - hubY - MARGIN - maxH / 2 - extra;
  const rowGap = rows.length > 0 ? Math.min(MAX_ROW, Math.max(MIN_ROW, free / (rows.length + 0.35))) : 0;
  const sag = Math.max(0, Math.min(rowGap * 0.35, rowGap - maxH - 14));
  let spread = 0;
  for (const x of xs.values()) spread = Math.max(spread, Math.abs(x - cx));

  pos.set(hub, { x: cx, y: hubY });
  let rowY = hubY;
  rows.forEach((row, r) => {
    rowY += rowGap;
    // A staggered row stays straight: bending it would let lanes close in on each other.
    const bend = (lanes[r] ?? 1) > 1 ? 0 : sag;
    for (const it of row) {
      const x = xs.get(it.id) as number;
      const u = spread > 0 ? (x - cx) / spread : 0;
      pos.set(it.id, { x, y: rowY + (lane.get(it.id) ?? 0) * laneH + bend * (1 - u * u) });
    }
    rowY += ((lanes[r] ?? 1) - 1) * laneH;
  });

  let bottom = 0;
  for (const [id, p] of pos) bottom = Math.max(bottom, p.y + (byId.get(id)?.h ?? 0) / 2);
  bottom += MARGIN;
  if (bottom < height) {
    const shift = (height - bottom) / 2;
    for (const p of pos.values()) p.y += shift;
    return { pos, height };
  }
  return { pos, height: bottom };
}
