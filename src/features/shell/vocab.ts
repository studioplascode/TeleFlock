import type { Agent, Column, NeedsKind } from "@/core/gen";
import { formatAge, formatElapsed } from "@/design";

/*
 * TeleFlock's vocabulary: one word per lane, agent state and action. Every surface that names one
 * of them (board, phone, sidebar, session, Dispatch, palette, menus, tooltips, the shortcuts sheet)
 * imports it from here, so a word changes in one place.
 */

// ───────────────────────────── Lanes ─────────────────────────────

/** Board lanes, left to right. Needs you leads: it is the one lane that asks for action. */
export const LANE_ORDER: readonly Column[] = ["needs", "running", "review", "done"];

export const LANE_TITLE: Record<Column, string> = {
  needs: "Needs you",
  running: "Running",
  review: "Review",
  done: "Done",
};

/** Lane legend: the sort order and what each card's time means. */
export const LANE_LEGEND: Record<Column, string> = {
  needs: "oldest first · time waiting",
  running: "longest first · turn time",
  review: "newest first · time finished",
  done: "newest first · drag back to reopen",
};

// ───────────────────────────── Agent states ─────────────────────────────

/** What a needs-you agent is waiting for (pills, badges, the HUD). */
export const NEEDS_WORD: Record<NeedsKind, string> = {
  ask: "Question",
  approval: "Approval",
  planReview: "Plan review",
  confirm: "Confirm",
  input: "Input",
  blocked: "Blocked",
  error: "Error",
};

/** The five states an agent can be in. `fresh` lives in the Review lane but has nothing to review. */
export type AgentStateId = "needs" | "running" | "fresh" | "review" | "done";

/** Started but never prompted: no completed turn and no title yet. */
export function isFresh(a: Pick<Agent, "column" | "turns" | "title">): boolean {
  return a.column === "review" && a.turns === 0 && a.title.trim() === "";
}

export function agentStateId(a: Pick<Agent, "column" | "turns" | "title">): AgentStateId {
  if (a.column === "review") return isFresh(a) ? "fresh" : "review";
  return a.column;
}

/** Full state word (card state strip, session header pill, Dispatch reply pill). */
export const STATE_WORD: Record<AgentStateId, string> = {
  needs: "Needs you",
  running: "Running",
  fresh: "Waiting for prompt",
  review: "To review",
  done: "Done",
};

/** Short state word for tight pills (sidebar tree, phone rows). Same meaning as STATE_WORD. */
export const STATE_SHORT: Record<AgentStateId, string> = {
  needs: "You",
  running: "Run",
  fresh: "New",
  review: "Review",
  done: "Done",
};

/** The pill word for an agent: the needs kind while it waits on you ("Question"), else its state. */
export function agentStateWord(a: Pick<Agent, "column" | "turns" | "title" | "needs">): string {
  if (a.column === "needs" && a.needs) return NEEDS_WORD[a.needs.kind];
  return STATE_WORD[agentStateId(a)];
}

/**
 * The time on a card, with the verb that says what it measures: "turn 27:24", "waiting 6:13",
 * "finished 25m ago". Fresh and done agents show the bare age ("46s ago", "2h ago"): their state
 * word ("Waiting for prompt", "Done") already is the verb. `since` is the state's start
 * (stateSince / needs.since / turn start).
 */
export function stateTime(state: AgentStateId, since: number | undefined, now: number): string | null {
  if (since === undefined) return null;
  const ms = Math.max(0, now - since);
  switch (state) {
    case "running":
      return `turn ${formatElapsed(ms)}`;
    case "needs":
      return `waiting ${formatElapsed(ms)}`;
    case "fresh":
    case "done":
      return formatAge(ms);
    case "review":
      return `finished ${formatAge(ms)}`;
  }
}

// ───────────────────────────── Actions ─────────────────────────────

export interface ActionDef {
  /** Visible label in menus, buttons and the palette. */
  label: string;
  /** Desktop shortcut as shown in tooltips and `Kbd`s ("Ctrl J", "N"). */
  shortcut?: string;
  /** One line: what it does (palette description column, tooltips, menu second lines). */
  description?: string;
  /** The omp slash command it maps to, shown as a hint where omp users look for it. */
  slash?: string;
}

/** Every user-facing action, by id. Menus, the palette, tooltips and the `?` sheet read from here. */
export const ACTIONS = {
  // ── start work ──
  newTask: { label: "New task", shortcut: "D", description: "Type a task: it gets its own worktree and agent, named for you" },
  newWorktree: { label: "New worktree", shortcut: "N", description: "Choose the branch, base and agent yourself" },
  newAgent: { label: "New agent", description: "Start omp in a checkout you already have" },
  fanOut: { label: "Fan out", description: "One task on 2–5 agents, each in its own worktree; keep the best" },
  openFolder: { label: "Open folder", description: "Add any folder as a workspace, with or without an agent" },
  pastSessions: { label: "Past sessions", description: "Resume an earlier omp session in a new pane" },

  // ── one agent ──
  openSession: { label: "Open session", shortcut: "Enter", description: "Transcript, composer and controls" },
  terminal: { label: "Terminal", shortcut: "T", description: "The agent's real terminal in herdr" },
  terminalBeside: { label: "Terminal beside", shortcut: "Ctrl \\", description: "The agent's terminal next to its session" },
  review: { label: "Review", description: "Diff, then commit, push, pull request and merge" },
  answer: { label: "Answer…", shortcut: "A", description: "Answer its question or approval" },
  answerNext: { label: "Answer next", shortcut: "Ctrl J", description: "Everything waiting on you, oldest first" },
  markDone: { label: "Mark done", description: "Move it to Done; its pane closes once idle (see Settings) and the session resumes when needed" },
  markDoneRemove: { label: "Mark done & remove worktree…", description: "Also deletes the checkout folder (asks first)" },
  deleteWorktree: { label: "Delete worktree…", description: "Its pull request is merged or closed: delete the checkout folder (asks first); the branch stays" },
  reopen: { label: "Reopen", description: "Move it back to Review" },
  resume: { label: "Resume", description: "Reopen the closed session (omp --resume) in a new pane" },
  stopTurn: { label: "Stop turn", shortcut: "Esc", description: "Interrupt the current turn; the session stays" },
  exitOmp: { label: "Exit omp (keep pane)", description: "Quit omp; the herdr pane stays open" },
  closePane: { label: "Close pane…", description: "Quit omp and close its herdr pane (asks first)" },
  mute: { label: "Mute notifications", description: "No sound or OS notification from it; its card stays" },
  unmute: { label: "Unmute notifications", description: "Notify again when it needs you or finishes" },
  select: { label: "Select", shortcut: "X", description: "Add to the selection for bulk actions" },
  focusMode: { label: "Focus mode", shortcut: "F", description: "Just the transcript and the composer" },
  rename: { label: "Rename…", slash: "/rename", description: "Give the session a name" },

  // ── session commands (omp) ──
  compact: { label: "Compact…", slash: "/compact", description: "Summarise older turns to free context" },
  handoff: { label: "Hand off…", slash: "/handoff", description: "Continue in a fresh session from a summary" },
  forkInPlace: { label: "Fork in place", slash: "/fork", description: "Branch the conversation here; the old path stays in the tree" },
  forkNewPane: { label: "Fork into new pane", description: "Copy the session into a new pane and continue there" },
  exportHtml: { label: "Export HTML", slash: "/export", description: "Save the transcript as a web page" },
  newSession: { label: "New session…", slash: "/new", description: "Start over in this pane; the old session stays on disk" },
} as const satisfies Record<string, ActionDef>;

export type ActionId = keyof typeof ACTIONS;

/** Views reachable from the nav (desktop sidebar / phone tabs) with their shortcuts. */
export const VIEWS = {
  board: { label: "Board", shortcut: "Ctrl 1", description: "Every agent on every host, by state" },
  inbox: { label: "Inbox", shortcut: "Ctrl 2", description: "What needs you, then unread updates" },
  activity: { label: "Activity", shortcut: "Ctrl 3", description: "Everything that happened, newest first" },
  usage: { label: "Usage", shortcut: "Ctrl 4", description: "Spend, tokens and subscription limits" },
  hosts: { label: "Hosts", shortcut: "Ctrl 5", description: "Connections, health and setup" },
  settings: { label: "Settings", shortcut: "Ctrl 6", description: "Notifications, motion, hints and AI naming" },
  dispatch: { label: "Dispatch", shortcut: "D", description: "Send tasks to a repository like messages" },
  automations: { label: "Automations", shortcut: "Ctrl 7", description: "Agents a host starts on a schedule" },
  omp: { label: "omp settings", shortcut: "Ctrl 8", description: "omp's models, roles, tools and every other setting, per host" },
} as const satisfies Record<string, ActionDef>;

/**
 * Send keys, one contract everywhere. Single message boxes (session composer, Dispatch, Other…,
 * prompts): Enter sends, Shift+Enter is a newline, Alt+Enter queues a follow-up while the agent
 * works. Multi-field forms (wizards, commit, pull request): Ctrl+Enter submits.
 */
export const SEND_KEYS = {
  send: "Enter",
  newline: "Shift Enter",
  followUp: "Alt Enter",
  submitForm: "Ctrl Enter",
} as const;
