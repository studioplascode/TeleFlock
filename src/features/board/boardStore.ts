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
  setRepo(repo: string | null): void;
  setQ(q: string): void;
  setGroupBy(g: GroupBy): void;
  setMove(key: string, column: Column | null): void;
  toggleDone(): void;
}

export const useBoard = create<BoardState>()((set) => ({
  repo: null,
  q: "",
  groupBy: "status",
  moves: {},
  doneOpen: false,
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
}));
