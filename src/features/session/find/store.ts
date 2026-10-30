import { create } from "zustand";
import type { FindHit } from "@/core/gen";

/** The current match: its row and which of the row's occurrences (0-based, in the row's text order). */
export interface FindActive {
  id: string;
  n: number;
}

/** What the host matched in rows the client has not loaded (`session.find`). */
export interface RemoteFind {
  /** Query and case mode it answers (`matchKey`). */
  key: string;
  hits: FindHit[];
  /** Rows the session has. */
  rows: number;
  truncated: boolean;
}

export type RemoteStatus = "idle" | "searching" | "done" | "unsupported" | "error";

/** Open-at-match: where to land once the matches are known. */
export interface FindTarget {
  rowId?: string;
  /** Nearest match at or after this time when the row is unknown. */
  at?: number;
}

export interface FindState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  active: FindActive | null;
  /** Bumped whenever the current match should be brought into view (a step, a new query). */
  nonce: number;
  /** Bumped to focus and select the find field (Ctrl+F while open). */
  focus: number;
  remote: RemoteFind | null;
  remoteStatus: RemoteStatus;
  /** Paging older rows in to reach the current match. */
  loading: boolean;
  target?: FindTarget;
  /** Loaded rows holding matches (what the transcript paints), kept by the find bar. */
  rows: ReadonlySet<string>;
}

const NO_ROWS: ReadonlySet<string> = new Set();
const CLOSED: FindState = { open: false, query: "", caseSensitive: false, active: null, nonce: 0, focus: 0, remote: null, remoteStatus: "idle", loading: false, rows: NO_ROWS };

interface FindStore {
  /** Per scope: an agent key (the session transcript) or a preview key. */
  scopes: Record<string, FindState>;
  patch(scope: string, p: Partial<FindState>): void;
}

export const useFindStore = create<FindStore>()((set) => ({
  scopes: {},
  patch: (scope, p) => set((s) => ({ scopes: { ...s.scopes, [scope]: { ...(s.scopes[scope] ?? CLOSED), ...p } } })),
}));

export function findState(scope: string): FindState {
  return useFindStore.getState().scopes[scope] ?? CLOSED;
}

/** The find state of a scope (closed when never opened). */
export function useFind<T>(scope: string, pick: (s: FindState) => T): T {
  return useFindStore((s) => pick(s.scopes[scope] ?? CLOSED));
}

/** `query` + case mode: what a remote answer and a cached count belong to. */
export function matchKey(query: string, caseSensitive: boolean): string {
  return `${caseSensitive ? "1" : "0"}${query}`;
}

/**
 * Opens Find on a scope (Ctrl+F, the session menu, Past sessions' "open at match"). With a
 * query, it replaces the current one; with a target, the first answer lands there.
 */
export function openFind(scope: string, opts: { query?: string; target?: FindTarget } = {}): void {
  const cur = findState(scope);
  const query = opts.query ?? cur.query;
  const fresh = query !== cur.query;
  useFindStore.getState().patch(scope, {
    open: true,
    query,
    focus: cur.focus + 1,
    ...(fresh ? { active: null, remote: null, remoteStatus: "idle" as const } : {}),
    target: opts.target,
    nonce: cur.nonce + 1,
  });
}

/** Closes Find on a scope; reopened, it asks the host again unless it holds the answer to its query. */
export function closeFind(scope: string): void {
  if (!findState(scope).open) return;
  useFindStore.getState().patch(scope, { open: false, active: null, loading: false, target: undefined, rows: NO_ROWS, remoteStatus: "idle" });
}

/** Forgets a scope entirely (a preview that closed). */
export function dropFind(scope: string): void {
  const { scopes } = useFindStore.getState();
  if (!(scope in scopes)) return;
  const { [scope]: _, ...rest } = scopes;
  useFindStore.setState({ scopes: rest });
}
