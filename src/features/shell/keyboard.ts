import { useEffect, useRef } from "react";
import { toast } from "@/design";
import { navigate, parseAgentKey, type Route, type UiState, useRoute, useUi } from "@/core";
import { toggleSidebar } from "./sidebarState";
import { ACTIONS, SEND_KEYS, VIEWS } from "./vocab";

export interface ShortcutDef {
  keys: string[];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutDef[];
}

/** Ctrl+1…8 view order: the sidebar nav (Board · Inbox · Activity · Usage), Hosts, Settings, then Automations and omp settings. */
export const VIEW_KEYS = (["board", "inbox", "activity", "usage", "hosts", "settings", "automations", "omp"] as const).map((name) => ({ route: { name } as Route, label: VIEWS[name].label }));

/** "Ctrl J" → ["Ctrl", "J"] for the sheet's key caps. */
const caps = (shortcut: string): string[] => shortcut.split(" ");

/** Everything the `?` sheet lists (spec §6). Labels and keys come from the vocabulary. */
export const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: "Global",
    items: [
      { keys: ["Ctrl", "K"], label: "Command palette" },
      { keys: caps(ACTIONS.answerNext.shortcut), label: ACTIONS.answerNext.label },
      { keys: caps(ACTIONS.newTask.shortcut), label: ACTIONS.newTask.label },
      { keys: caps(ACTIONS.newWorktree.shortcut), label: ACTIONS.newWorktree.label },
      { keys: caps(ACTIONS.terminalBeside.shortcut), label: "Split view (terminal beside)" },
      { keys: ["Ctrl", "B"], label: "Toggle sidebar" },
      { keys: ["?"], label: "Keyboard shortcuts" },
      { keys: ["Esc"], label: "Close overlay → leave focus mode → stop turn" },
    ],
  },
  {
    title: "Views",
    items: VIEW_KEYS.map((v, i) => ({ keys: ["Ctrl", String(i + 1)], label: v.label })),
  },
  {
    title: "Typing",
    items: [
      { keys: caps(SEND_KEYS.send), label: "Send / steer" },
      { keys: caps(SEND_KEYS.newline), label: "New line" },
      { keys: caps(SEND_KEYS.followUp), label: "Follow-up (while the agent works)" },
      { keys: caps(SEND_KEYS.submitForm), label: "Submit forms (wizards, commit, pull request)" },
    ],
  },
  {
    title: "Board",
    items: [
      { keys: ["J"], label: "Next card" },
      { keys: ["K"], label: "Previous card" },
      { keys: ["H"], label: "Previous lane" },
      { keys: ["L"], label: "Next lane" },
      { keys: caps(ACTIONS.openSession.shortcut), label: ACTIONS.openSession.label },
      { keys: caps(ACTIONS.answer.shortcut), label: "Answer the selected card" },
      { keys: caps(ACTIONS.terminal.shortcut), label: ACTIONS.terminal.label },
      { keys: caps(ACTIONS.select.shortcut), label: ACTIONS.select.label },
      { keys: ["Ctrl", "Click"], label: "Add card to selection" },
    ],
  },
  {
    title: "Session",
    items: [
      { keys: caps(ACTIONS.stopTurn.shortcut), label: ACTIONS.stopTurn.label },
      { keys: caps(ACTIONS.resumeTurn.shortcut), label: `${ACTIONS.resumeTurn.description} (also Alt R)` },
      { keys: ["1", "…", "9"], label: "Pick an answer" },
      { keys: ["N+1"], label: "Other… (the number after the last option)" },
      { keys: caps(ACTIONS.focusMode.shortcut), label: ACTIONS.focusMode.label },
    ],
  },
  {
    title: "Review",
    items: [
      { keys: ["J"], label: "Next file" },
      { keys: ["K"], label: "Previous file" },
      { keys: ["X"], label: "Collapse / expand file" },
      { keys: ["V"], label: "Mark viewed, jump to next" },
      { keys: ["S"], label: "Split / unified diff" },
      { keys: ["W"], label: "Wrap lines" },
      { keys: ["R"], label: "Reload diff" },
      { keys: ["["], label: "Toggle file tree" },
      { keys: ["]"], label: "Toggle ship panel" },
      { keys: ["/"], label: "Filter files" },
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
      } else if (key === "d" && !e.shiftKey && r.name !== "dispatch") {
        e.preventDefault();
        navigate({ name: "dispatch" });
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
