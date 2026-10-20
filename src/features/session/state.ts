import { create } from "zustand";

export type SessionDialog = "model" | "goal" | "rename" | "fork" | "handoff" | "compact" | "newSession" | null;
export type InspectorTab = "overview" | "todos" | "agents" | "files" | "tree" | "btw";

interface SessionUiState {
  dialog: Record<string, SessionDialog>;
  tab: Record<string, InspectorTab>;
  /** Mobile inspector sheet open, per agent key. */
  sheet: Record<string, boolean>;
  /** Pending btw ids started from this client, newest last. */
  btw: Record<string, { id: string; question: string; at: number }[]>;
  /** Text pushed into the composer from elsewhere (tree "edit from here", queue chip). */
  draft: Record<string, { text: string; nonce: number } | undefined>;
  openDialog(key: string, d: SessionDialog): void;
  setTab(key: string, t: InspectorTab): void;
  setSheet(key: string, open: boolean): void;
  addBtw(key: string, id: string, question: string): void;
  setDraft(key: string, text: string): void;
}

/** View-local UI state shared by header, composer and inspector of one session. */
export const useSessionUi = create<SessionUiState>()((set) => ({
  dialog: {},
  tab: {},
  sheet: {},
  btw: {},
  draft: {},
  openDialog: (key, d) => set((s) => ({ dialog: { ...s.dialog, [key]: d } })),
  setTab: (key, t) => set((s) => ({ tab: { ...s.tab, [key]: t } })),
  setSheet: (key, open) => set((s) => ({ sheet: { ...s.sheet, [key]: open } })),
  addBtw: (key, id, question) => set((s) => ({ btw: { ...s.btw, [key]: [...(s.btw[key] ?? []).slice(-9), { id, question, at: Date.now() }] } })),
  setDraft: (key, text) => set((s) => ({ draft: { ...s.draft, [key]: { text, nonce: (s.draft[key]?.nonce ?? 0) + 1 } } })),
}));
