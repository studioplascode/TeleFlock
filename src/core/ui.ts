import { create } from "zustand";
import type { ArtifactKind, PresentKind } from "./gen";

export type UiDialog =
  | { kind: "newWorktree"; hostId?: string; cwd?: string }
  | { kind: "newAgent"; hostId?: string; workspaceId?: string }
  | { kind: "pastSessions"; hostId?: string }
  | { kind: "hostEditor"; hostId?: string }
  | { kind: "hostSync"; hostId?: string; sourceHostId?: string }
  | { kind: "shortcuts" }
  | { kind: "fanOut"; hostId?: string; cwd?: string; prompt?: string };

export type SplitState =
  | { kind: "terminal"; hostId: string; paneId?: string; agentId?: string }
  | { kind: "session"; key: string }
  /** A document of a session (`key`): a file of its artifacts (`file` = its root), or `review`, the
   *  plan under review. `as`/`title`/`language`: what the agent said when it presented it. */
  | { kind: "artifact"; key: string; file: ArtifactKind | "review"; name: string; as?: PresentKind; title?: string; language?: string }
  /** This device's TeleFlock Browser, opened beside the session `key` (it offers "Let <agent> use my browser"). */
  | { kind: "browser"; key?: string }
  /** The message board of session `key`: the agent chat of its whole agent tree. */
  | { kind: "agentChat"; key: string };

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
  /** Focus mode (the session's and the wall's `F`): title bar stays, sidebar/split/bottom nav hide. */
  focusMode: boolean;
  setFocusMode(on: boolean): void;
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
  focusMode: false,
  setFocusMode: (focusMode) => set({ focusMode }),
}));
