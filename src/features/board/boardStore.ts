import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type BoardSort, draftKey, drafts } from "@/core";
import type { Column } from "@/core/gen";

/** The board's "Filter agents…" text, kept as a draft so it survives navigation and reload. */
const FILTER_DRAFT = draftKey("board.filter");

export type GroupBy = "status" | "repo";

interface BoardState {
  /** Repo name filter (`null` = all repos). Host filter lives in core (`useHosts().filter`). */
  repo: string | null;
  q: string;
  groupBy: GroupBy;
  /** Card order inside each lane (desktop and phone); kept on this device (localStorage "tf.board"). */
  sort: BoardSort;
  /** Optimistic lane overrides after a drop, until the host's state confirms (or the call fails). */
  moves: Record<string, Column>;
  doneOpen: boolean;
  /** Multi-selection (agent keys, in pick order). Separate from the keyboard cursor (`useUi().selectedKey`). */
  picked: string[];
  /** Where a Shift-click range starts. */
  anchor: string | null;
  /** Visible card order (flat), for Shift-click ranges. Set by the mounted board. */
  order: string[];
  setRepo(repo: string | null): void;
  setQ(q: string): void;
  setGroupBy(g: GroupBy): void;
  setSort(sort: BoardSort): void;
  setMove(key: string, column: Column | null): void;
  toggleDone(): void;
  togglePick(key: string): void;
  /** Select every card between the anchor and `key` (inclusive), keeping the rest of the selection. */
  pickRange(key: string): void;
  clearPicked(): void;
  setOrder(order: string[]): void;
}

export const useBoard = create<BoardState>()(
  persist(
    (set) => ({
      repo: null,
      q: drafts.get(FILTER_DRAFT),
      groupBy: "status",
      sort: "lane",
      moves: {},
      doneOpen: false,
      picked: [],
      anchor: null,
      order: [],
      setRepo: (repo) => set({ repo }),
      setQ: (q) => {
        drafts.set(FILTER_DRAFT, q);
        set({ q });
      },
      setGroupBy: (groupBy) => set({ groupBy }),
      setSort: (sort) => set({ sort }),
      setMove: (key, column) =>
        set((s) => {
          const moves = { ...s.moves };
          if (column) moves[key] = column;
          else delete moves[key];
          return { moves };
        }),
      toggleDone: () => set((s) => ({ doneOpen: !s.doneOpen })),
      togglePick: (key) => set((s) => ({ picked: s.picked.includes(key) ? s.picked.filter((k) => k !== key) : [...s.picked, key], anchor: key })),
      pickRange: (key) =>
        set((s) => {
          const from = s.anchor ? s.order.indexOf(s.anchor) : -1;
          const to = s.order.indexOf(key);
          if (from < 0 || to < 0) return { picked: s.picked.includes(key) ? s.picked : [...s.picked, key], anchor: key };
          const range = s.order.slice(Math.min(from, to), Math.max(from, to) + 1);
          return { picked: [...s.picked, ...range.filter((k) => !s.picked.includes(k))] };
        }),
      clearPicked: () => set({ picked: [], anchor: null }),
      setOrder: (order) => set({ order }),
    }),
    {
      name: "tf.board",
      partialize: ({ sort }) => ({ sort }),
      // A stored value from a later version this one doesn't know falls back to the lane order.
      merge: (stored, current) => {
        const sort = (stored as { sort?: unknown } | undefined)?.sort;
        return sort === "project" || sort === "created" || sort === "lane" ? { ...current, sort } : current;
      },
    },
  ),
);

/** The board's sort choices, in menu order. */
export const SORTS: readonly { value: BoardSort; label: string; legend: string }[] = [
  { value: "lane", label: "Lane order", legend: "" },
  { value: "project", label: "Project", legend: "by project" },
  { value: "created", label: "Worktree created", legend: "newest worktree first" },
];
