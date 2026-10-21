import { create } from "zustand";
import type { Column } from "@/core/gen";

export type GroupBy = "status" | "repo";

interface BoardState {
  /** Repo name filter (`null` = all repos). Host filter lives in core (`useHosts().filter`). */
  repo: string | null;
  q: string;
  groupBy: GroupBy;
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
  setMove(key: string, column: Column | null): void;
  toggleDone(): void;
  togglePick(key: string): void;
  /** Select every card between the anchor and `key` (inclusive), keeping the rest of the selection. */
  pickRange(key: string): void;
  clearPicked(): void;
  setOrder(order: string[]): void;
}

export const useBoard = create<BoardState>()((set) => ({
  repo: null,
  q: "",
  groupBy: "status",
  moves: {},
  doneOpen: false,
  picked: [],
  anchor: null,
  order: [],
  setRepo: (repo) => set({ repo }),
  setQ: (q) => set({ q }),
  setGroupBy: (groupBy) => set({ groupBy }),
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
}));
