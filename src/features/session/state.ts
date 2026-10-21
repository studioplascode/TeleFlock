import { create } from "zustand";
import { draftKey } from "@/core";
import type { Subagent } from "@/core/gen";

/** Draft key of a session's composer (text in `drafts`, images in the draft image store). */
export function composerDraftKey(agentKey: string): string {
  return draftKey("composer", agentKey);
}

export type SessionDialog = "model" | "goal" | "rename" | "fork" | "handoff" | "compact" | "newSession" | null;
export type InspectorTab = "overview" | "todos" | "agents" | "chat" | "files" | "tree" | "btw";

interface SessionUiState {
  dialog: Record<string, SessionDialog>;
  tab: Record<string, InspectorTab>;
  /** Mobile inspector sheet open, per agent key. */
  sheet: Record<string, boolean>;
  /** Pending btw ids started from this client, newest last. */
  btw: Record<string, { id: string; question: string; at: number }[]>;
  /** Composer focus requests (nonce), consumed by the composer once it has focused. */
  composerFocus: Record<string, number | undefined>;
  /** Transcript row to scroll to and flash (Chat tab "jump to message"). */
  focus: Record<string, { itemId: string; nonce: number } | undefined>;
  /**
   * Subagent shown in the session's viewer (one per session, mounted by SessionPane). `subs`: the
   * opener's list, used when the session no longer lists this subagent (task card of an old turn).
   */
  subagent: Record<string, { id: string; subs?: Subagent[] } | undefined>;
  openDialog(key: string, d: SessionDialog): void;
  setTab(key: string, t: InspectorTab): void;
  setSheet(key: string, open: boolean): void;
  addBtw(key: string, id: string, question: string): void;
  /** Focus the composer (now, or when it mounts) without touching its draft. */
  focusComposer(key: string): void;
  consumeComposerFocus(key: string): void;
  focusItem(key: string, itemId: string): void;
  /** Open (or switch the open viewer to) a subagent of this session. */
  openSubagent(key: string, id: string, subs?: Subagent[]): void;
  closeSubagent(key: string): void;
}

/** View-local UI state shared by header, composer and inspector of one session. */
export const useSessionUi = create<SessionUiState>()((set) => ({
  dialog: {},
  tab: {},
  sheet: {},
  btw: {},
  composerFocus: {},
  focus: {},
  subagent: {},
  openDialog: (key, d) => set((s) => ({ dialog: { ...s.dialog, [key]: d } })),
  setTab: (key, t) => set((s) => ({ tab: { ...s.tab, [key]: t } })),
  setSheet: (key, open) => set((s) => ({ sheet: { ...s.sheet, [key]: open } })),
  addBtw: (key, id, question) => set((s) => ({ btw: { ...s.btw, [key]: [...(s.btw[key] ?? []).slice(-9), { id, question, at: Date.now() }] } })),
  focusComposer: (key) => set((s) => ({ composerFocus: { ...s.composerFocus, [key]: (s.composerFocus[key] ?? 0) + 1 } })),
  consumeComposerFocus: (key) => set((s) => (s.composerFocus[key] ? { composerFocus: { ...s.composerFocus, [key]: undefined } } : s)),
  focusItem: (key, itemId) => set((s) => ({ focus: { ...s.focus, [key]: { itemId, nonce: (s.focus[key]?.nonce ?? 0) + 1 } } })),
  openSubagent: (key, id, subs) => set((s) => ({ subagent: { ...s.subagent, [key]: { id, subs: subs ?? s.subagent[key]?.subs } } })),
  closeSubagent: (key) => set((s) => (s.subagent[key] ? { subagent: { ...s.subagent, [key]: undefined } } : s)),
}));
