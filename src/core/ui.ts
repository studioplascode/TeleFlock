import { create } from "zustand";

export type UiDialog =
  | { kind: "newWorktree"; hostId?: string; cwd?: string }
  | { kind: "newAgent"; hostId?: string; workspaceId?: string }
  | { kind: "pastSessions"; hostId?: string }
  | { kind: "hostEditor"; hostId?: string }
  | { kind: "shortcuts" };

export type SplitState =
  | { kind: "terminal"; hostId: string; paneId?: string; agentId?: string }
  | { kind: "session"; key: string };

export interface UiState {
  dialog: UiDialog | null;
  openDialog(d: UiDialog): void;
  closeDialog(): void;
  paletteOpen: boolean;
  setPalette(open: boolean): void;
  answerNextOpen: boolean;
  setAnswerNext(open: boolean): void;
  split: SplitState | null;
  setSplit(s: SplitState | null): void;
  sidebarCollapsed: boolean;
  toggleSidebar(): void;
  /** Board keyboard selection (agent key). */
  selectedKey: string | null;
  select(key: string | null): void;
}

const SIDEBAR_KEY = "tf.sidebarCollapsed";

function readSidebar(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

/** Global UI state. `useUi()` / `useUi(selector)` / `useUi.getState()`. */
export const useUi = create<UiState>()((set, get) => ({
  dialog: null,
  openDialog: (dialog) => set({ dialog, paletteOpen: false }),
  closeDialog: () => set({ dialog: null }),
  paletteOpen: false,
  setPalette: (paletteOpen) => set({ paletteOpen }),
  answerNextOpen: false,
  setAnswerNext: (answerNextOpen) => set({ answerNextOpen }),
  split: null,
  setSplit: (split) => set({ split }),
  sidebarCollapsed: readSidebar(),
  toggleSidebar: () => {
    const sidebarCollapsed = !get().sidebarCollapsed;
    try {
      globalThis.localStorage?.setItem(SIDEBAR_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    set({ sidebarCollapsed });
  },
  selectedKey: null,
  select: (selectedKey) => set({ selectedKey }),
}));
