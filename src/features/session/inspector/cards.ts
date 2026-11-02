/**
 * Device-local state of the inspector's cards (`tf.inspector`): which cards are collapsed, the side
 * questions (btw) the user dismissed or collapsed per session, and the subagent branches the user
 * opened or closed per session. The pure reducers below carry the logic (and the tests); the store
 * only persists their results.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { deviceStorage } from "@/core/deviceStorage";

/** Card ids: the inspector tabs plus the Session card's own tiles. */
export type CardId = "overview" | "spend" | "throughput" | "btw" | "todos" | "agents" | "jobs" | "artifacts" | "files" | "chat" | "tree";

/** Marks kept per session (side questions, subagent branches), and sessions kept: the oldest fall out, so the store stays small. */
export const MAX_MARK_IDS = 300;
export const MAX_MARK_SESSIONS = 40;

/** What the user did with a session's side questions. */
export interface BtwMarks {
  dismissed: string[];
  collapsed: string[];
}

export type BtwState = Record<string, BtwMarks>;

const NO_MARKS: BtwMarks = { dismissed: [], collapsed: [] };

/**
 * The session a mark belongs to. omp's session id is stable across pane and agent ids, so a
 * dismissal survives reopening the session; before the bridge reports it, the agent id stands in.
 */
export function sessionScope(hostId: string, agentId: string, sessionId: string | undefined): string {
  return sessionId ? `${hostId}/s:${sessionId}` : `${hostId}/a:${agentId}`;
}

export function marksOf(state: BtwState, scope: string): BtwMarks {
  return state[scope] ?? NO_MARKS;
}

function merge(list: readonly string[], ids: readonly string[], on: boolean): string[] {
  if (!on) {
    const drop = new Set(ids);
    return list.filter((id) => !drop.has(id));
  }
  const have = new Set(list);
  const out = [...list, ...ids.filter((id) => !have.has(id))];
  return out.length > MAX_MARK_IDS ? out.slice(out.length - MAX_MARK_IDS) : out;
}

/** `scope` set to `next` (gone when null) as the newest scope; the oldest scopes beyond the cap go. */
function withScope<M>(state: Record<string, M>, scope: string, next: M | null): Record<string, M> {
  const { [scope]: _old, ...rest } = state;
  if (next === null) return rest;
  const out: Record<string, M> = { ...rest, [scope]: next };
  const scopes = Object.keys(out);
  for (const s of scopes.slice(0, Math.max(0, scopes.length - MAX_MARK_SESSIONS))) delete out[s];
  return out;
}

/** Sets (or clears) `field` for `ids` in `scope`; the scope becomes the newest, the oldest scopes beyond the cap go. */
export function markBtw(state: BtwState, scope: string, field: keyof BtwMarks, ids: readonly string[], on: boolean): BtwState {
  if (ids.length === 0) return state;
  const cur = marksOf(state, scope);
  const next: BtwMarks = { ...cur, [field]: merge(cur[field], ids, on) };
  // dismissing makes "collapsed" moot
  if (field === "dismissed" && on) next.collapsed = merge(next.collapsed, ids, false);
  return withScope(state, scope, next.dismissed.length === 0 && next.collapsed.length === 0 ? null : next);
}

/** The rows still shown: dismissed ones are gone. */
export function visibleBtw<T extends { id: string }>(rows: readonly T[], marks: BtwMarks): T[] {
  if (marks.dismissed.length === 0) return [...rows];
  const gone = new Set(marks.dismissed);
  return rows.filter((r) => !gone.has(r.id));
}

/** Subagent branches the user opened or closed in a session; the others follow `opensByDefault` (subagents/grouping.ts). */
export interface SubMarks {
  open: string[];
  closed: string[];
}

export type SubsState = Record<string, SubMarks>;

const NO_SUB_MARKS: SubMarks = { open: [], closed: [] };

export function subMarksOf(state: SubsState, scope: string): SubMarks {
  return state[scope] ?? NO_SUB_MARKS;
}

/** Remembers that the user opened (or closed) subagent `id`'s branch in `scope`; the scope becomes the newest. */
export function markSub(state: SubsState, scope: string, id: string, open: boolean): SubsState {
  const cur = subMarksOf(state, scope);
  return withScope(state, scope, { open: merge(cur.open, [id], open), closed: merge(cur.closed, [id], !open) });
}

interface CardsState {
  /** Collapsed cards (only collapsed ones are stored: everything is open by default). */
  collapsed: Partial<Record<CardId, true>>;
  btw: BtwState;
  subs: SubsState;
  setCollapsed(id: CardId, collapsed: boolean): void;
  toggle(id: CardId): void;
  markBtw(scope: string, field: keyof BtwMarks, ids: readonly string[], on: boolean): void;
  markSub(scope: string, id: string, open: boolean): void;
}

function withCollapsed(map: CardsState["collapsed"], id: CardId, collapsed: boolean): CardsState["collapsed"] {
  if (!!map[id] === collapsed) return map;
  const { [id]: _drop, ...rest } = map;
  return collapsed ? { ...rest, [id]: true } : rest;
}

export const useInspectorCards = create<CardsState>()(
  persist(
    (set) => ({
      collapsed: {},
      btw: {},
      subs: {},
      setCollapsed: (id, collapsed) => set((s) => ({ collapsed: withCollapsed(s.collapsed, id, collapsed) })),
      toggle: (id) => set((s) => ({ collapsed: withCollapsed(s.collapsed, id, !s.collapsed[id]) })),
      markBtw: (scope, field, ids, on) => set((s) => ({ btw: markBtw(s.btw, scope, field, ids, on) })),
      markSub: (scope, id, open) => set((s) => ({ subs: markSub(s.subs, scope, id, open) })),
    }),
    { name: "tf.inspector", version: 1, storage: createJSONStorage(() => deviceStorage), partialize: ({ collapsed, btw, subs }) => ({ collapsed, btw, subs }) },
  ),
);

/** `[collapsed, toggle]` of a card. */
export function useCardCollapsed(id: CardId): [boolean, () => void] {
  const collapsed = useInspectorCards((s) => !!s.collapsed[id]);
  const toggle = useInspectorCards((s) => s.toggle);
  return [collapsed, () => toggle(id)];
}

/** Opens a card (a request to look at it: a slash command, a tab pick). */
export function expandCard(id: string): void {
  const s = useInspectorCards.getState();
  if (s.collapsed[id as CardId]) s.setCollapsed(id as CardId, false);
}
