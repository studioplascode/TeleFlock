import { type RefObject, useEffect } from "react";
import { useAgent, useUi } from "@/core";
import { openAgent, openAnswerHud, openTerminal } from "./agentActions";
import { useBoard } from "./boardStore";

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || !!target.closest("[role='dialog'],[role='menu'],[role='listbox']");
}

/**
 * Board keys (spec §6): J/K or ↓/↑ move within the flat card order, H/L or ←/→ jump lanes,
 * Enter opens, A answers (HUD at the card), T opens the terminal split, X toggles the card in the
 * multi-selection, / focuses search, Esc clears the multi-selection, then the cursor.
 * `groups` is the visible order: one array of keys per lane/column.
 */
export function useBoardKeys(groups: readonly (readonly string[])[], searchRef: RefObject<HTMLInputElement | null>): void {
  const selected = useUi((s) => s.selectedKey);
  const needs = useAgent(selected ?? "")?.column === "needs";

  useEffect(() => {
    const flat = groups.flat();
    const locate = (key: string | null) => {
      if (!key) return null;
      for (let g = 0; g < groups.length; g++) {
        const i = groups[g]?.indexOf(key) ?? -1;
        if (i >= 0) return { g, i };
      }
      return null;
    };
    const selectKey = (key: string | undefined) => {
      if (!key) return;
      useUi.getState().select(key);
      document.querySelector(`[data-agent-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const ui = useUi.getState();
      if (ui.paletteOpen || ui.answerNextOpen || ui.dialog) return;
      const cur = ui.selectedKey && flat.includes(ui.selectedKey) ? ui.selectedKey : null;
      const at = cur ? flat.indexOf(cur) : -1;
      const pos = locate(cur);
      const k = e.key;
      if (k === "j" || k === "J" || k === "ArrowDown") selectKey(flat[Math.min(flat.length - 1, at + 1)]);
      else if (k === "k" || k === "K" || k === "ArrowUp") selectKey(flat[at <= 0 ? 0 : at - 1]);
      else if (k === "h" || k === "H" || k === "ArrowLeft" || k === "l" || k === "L" || k === "ArrowRight") {
        const dir = k === "h" || k === "H" || k === "ArrowLeft" ? -1 : 1;
        for (let g = (pos?.g ?? (dir > 0 ? -1 : groups.length)) + dir; g >= 0 && g < groups.length; g += dir) {
          const lane = groups[g];
          if (lane && lane.length > 0) {
            selectKey(lane[Math.min(pos?.i ?? 0, lane.length - 1)]);
            break;
          }
        }
      } else if (k === "Enter" && cur) openAgent(cur);
      else if ((k === "a" || k === "A") && cur && needs) openAnswerHud(cur);
      else if ((k === "a" || k === "A") && !cur) ui.setAnswerNext(true);
      else if ((k === "t" || k === "T") && cur) openTerminal(cur, false);
      else if (k === "/") searchRef.current?.focus();
      else if ((k === "x" || k === "X") && cur) useBoard.getState().togglePick(cur);
      else if (k === "Escape" && useBoard.getState().picked.length > 0) useBoard.getState().clearPicked();
      else if (k === "Escape" && cur) ui.select(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groups, searchRef, needs]);
}
