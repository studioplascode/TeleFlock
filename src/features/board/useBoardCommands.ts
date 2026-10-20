import { type RefObject, useMemo } from "react";
import { useUi } from "@/core";
import { toast } from "@/design";
import { usePaletteCommands } from "@/features/palette/registry";
import { setArchived } from "./agentActions";
import { useBoard } from "./boardStore";

/** Board-contextual palette commands (registered while the board is mounted). */
export function useBoardCommands(reviewKeys: readonly string[], searchRef: RefObject<HTMLInputElement | null>): void {
  const groupBy = useBoard((s) => s.groupBy);
  const commands = useMemo(
    () => [
      {
        id: "board.group",
        title: groupBy === "status" ? "Group board by repo" : "Group board by status",
        group: "Board",
        keywords: ["swimlanes", "repository", "columns"],
        run: () => useBoard.getState().setGroupBy(groupBy === "status" ? "repo" : "status"),
      },
      {
        id: "board.search",
        title: "Filter board agents",
        group: "Board",
        shortcut: "/",
        run: () => window.setTimeout(() => searchRef.current?.focus(), 0),
      },
      {
        id: "board.clearFilters",
        title: "Clear board filters",
        group: "Board",
        run: () => {
          const b = useBoard.getState();
          b.setQ("");
          b.setRepo(null);
        },
      },
      {
        id: "board.answerNext",
        title: "Answer next question",
        group: "Board",
        shortcut: "Ctrl J",
        run: () => useUi.getState().setAnswerNext(true),
      },
      ...(reviewKeys.length > 0
        ? [
            {
              id: "board.archiveReviewed",
              title: `Archive all ${reviewKeys.length} reviewed agent${reviewKeys.length === 1 ? "" : "s"}`,
              group: "Board",
              keywords: ["done", "clean up"],
              run: async () => {
                const keys = [...reviewKeys];
                const results = await Promise.allSettled(keys.map((k) => setArchived(k, true)));
                const ok = results.filter((r) => r.status === "fulfilled").length;
                toast({
                  title: `Archived ${ok} agent${ok === 1 ? "" : "s"}`,
                  status: "done",
                  action: { label: "Undo", onClick: () => keys.forEach((k) => void setArchived(k, false).catch(() => {})) },
                });
              },
            },
          ]
        : []),
    ],
    [groupBy, reviewKeys, searchRef],
  );
  usePaletteCommands(commands);
}
