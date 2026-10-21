import { useEffect, useRef } from "react";
import { toast } from "@/design";
import { navigate, parseAgentKey, type Route, type UiState, useRoute, useUi } from "@/core";
import { toggleSidebar } from "./sidebarState";

export interface ShortcutDef {
  keys: string[];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutDef[];
}

/** Ctrl+1…6 view order. */
export const VIEW_KEYS: readonly { route: Route; label: string }[] = [
  { route: { name: "board" }, label: "Board" },
  { route: { name: "inbox" }, label: "Inbox" },
  { route: { name: "activity" }, label: "Activity" },
  { route: { name: "usage" }, label: "Usage" },
  { route: { name: "hosts" }, label: "Hosts" },
  { route: { name: "settings" }, label: "Settings" },
];

/** Everything the `?` sheet lists (spec §6). */
export const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: "Global",
    items: [
      { keys: ["Ctrl", "K"], label: "Command palette" },
      { keys: ["Ctrl", "J"], label: "Answer next" },
      { keys: ["Ctrl", "\\"], label: "Toggle split view" },
      { keys: ["Ctrl", "B"], label: "Toggle sidebar" },
      { keys: ["N"], label: "New worktree" },
      { keys: ["?"], label: "Keyboard shortcuts" },
      { keys: ["Esc"], label: "Close overlay" },
    ],
  },
  {
    title: "Views",
    items: VIEW_KEYS.map((v, i) => ({ keys: ["Ctrl", String(i + 1)], label: v.label })),
  },
  {
    title: "Board",
    items: [
      { keys: ["J"], label: "Next card" },
      { keys: ["K"], label: "Previous card" },
      { keys: ["Enter"], label: "Open agent" },
      { keys: ["A"], label: "Answer" },
      { keys: ["T"], label: "Terminal" },
    ],
  },
  {
    title: "Session",
    items: [
      { keys: ["Ctrl", "Enter"], label: "Send" },
      { keys: ["Alt", "Enter"], label: "Queue follow-up" },
      { keys: ["Esc"], label: "Stop the agent" },
      { keys: ["1", "…", "9"], label: "Pick an answer" },
    ],
  },
];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Install the global keyboard map (desktop, bubble phase). Single-key shortcuts are ignored while
 * typing or while a modal is open. Inside a terminal, FrontTerminal stops propagation of every key
 * the shell owns and lets only Ctrl+K / Ctrl+1…6 reach us.
 */
export function useGlobalShortcuts(): void {
  const ui = useUi();
  const route = useRoute();
  const live = useRef({ ui, route });
  useEffect(() => {
    live.current = { ui, route };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const { ui: u, route: r } = live.current;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (ctrl && !e.altKey && !e.shiftKey) {
        if (key === "k") {
          e.preventDefault();
          u.setPalette(!u.paletteOpen);
          return;
        }
        if (key === "j") {
          e.preventDefault();
          u.setAnswerNext(!u.answerNextOpen);
          return;
        }
        if (key === "b") {
          e.preventDefault();
          toggleSidebar();
          return;
        }
        if (key === "\\") {
          e.preventDefault();
          toggleSplit(u, r);
          return;
        }
        const n = Number.parseInt(e.key, 10);
        const view = VIEW_KEYS[n - 1];
        if (view && !Number.isNaN(n)) {
          e.preventDefault();
          navigate(view.route);
        }
        return;
      }

      if (ctrl || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
      if (e.key === "?") {
        e.preventDefault();
        u.openDialog({ kind: "shortcuts" });
      } else if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        u.openDialog({ kind: "newWorktree" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Ctrl+\ : close the split, or open the most useful one for where you are. */
export function toggleSplit(u: UiState, r: Route): void {
  if (u.split) {
    u.setSplit(null);
    return;
  }
  if (r.name === "agent") {
    u.setSplit({ kind: "terminal", hostId: r.hostId, agentId: r.agentId });
    return;
  }
  if (u.selectedKey) {
    const { hostId, agentId } = parseAgentKey(u.selectedKey);
    if (r.name === "terminal") u.setSplit({ kind: "session", key: u.selectedKey });
    else u.setSplit({ kind: "terminal", hostId, agentId });
    return;
  }
  toast({ title: "Nothing to split yet", description: "Open an agent or select a card first, then press Ctrl+\\." });
}
