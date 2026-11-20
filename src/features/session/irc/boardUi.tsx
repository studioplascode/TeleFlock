import { lazy, Suspense } from "react";
import { create } from "zustand";
import { useUi } from "@/core";
import type { Pacing } from "./graph";

/** The board's tabs: the messages, who is on the board, and who wrote to whom as a graph. */
export type BoardTab = "board" | "members" | "graph";

/** The Graph tab's switches: alike for every session, kept while the app runs. */
export interface GraphPrefs {
  /** Leaves out the subagents that had finished at the timeline's point. */
  hideInactive: boolean;
  /** Draws each broadcast's legs to the agents it lists (dashed). */
  expandAll: boolean;
  pacing: Pacing;
  /** Playback speed, 1 = a message a second on average. */
  speed: number;
}

/**
 * Where a session's message board opens: in the split panel beside the session on desktop
 * (`SplitState` kind `agentChat`), or full screen: on phones, in focus mode, and from the panel's
 * Full screen button (one at a time, mounted once by the app: `AgentChatOverlay`).
 */
interface BoardUi {
  /** Agent key of the board shown full screen. */
  full: string | null;
  /** A message to bring into view when the session's board shows it (a preview on the card). */
  reveal: Record<string, string | undefined>;
  /** The tab each session's board shows (none: Board): the panel and full screen show the same. */
  tab: Record<string, BoardTab | undefined>;
  graph: GraphPrefs;
}

export const useBoardUi = create<BoardUi>()(() => ({ full: null, reveal: {}, tab: {}, graph: { hideInactive: false, expandAll: false, pacing: "even", speed: 1 } }));

/** Opens the session's message board; `messageId`: on the Board tab, scrolled to and flashed. */
export function openBoard(agentKey: string, mobile: boolean, messageId?: string): void {
  if (messageId) useBoardUi.setState((s) => ({ reveal: { ...s.reveal, [agentKey]: messageId }, tab: { ...s.tab, [agentKey]: "board" } }));
  const ui = useUi.getState();
  if (mobile || ui.focusMode) useBoardUi.setState({ full: agentKey });
  else ui.setSplit({ kind: "agentChat", key: agentKey });
}

export function showBoardFull(agentKey: string): void {
  useBoardUi.setState({ full: agentKey });
}

export function closeBoardFull(): void {
  useBoardUi.setState({ full: null });
}

export function setBoardTab(agentKey: string, tab: BoardTab): void {
  useBoardUi.setState((s) => ({ tab: { ...s.tab, [agentKey]: tab } }));
}

export function setGraphPrefs(change: Partial<GraphPrefs>): void {
  useBoardUi.setState((s) => ({ graph: { ...s.graph, ...change } }));
}

/** The message the board should bring into view, taken once. */
export function takeReveal(agentKey: string): string | undefined {
  const id = useBoardUi.getState().reveal[agentKey];
  if (id) useBoardUi.setState((s) => ({ reveal: { ...s.reveal, [agentKey]: undefined } }));
  return id;
}

const AgentChatFull = lazy(() => import("./BoardFrames").then((m) => ({ default: m.AgentChatFull })));

/** Mounted once by the app: the message board shown full screen, if any (the board loads on first use). */
export function AgentChatOverlay() {
  const key = useBoardUi((s) => s.full);
  if (!key) return null;
  return (
    <Suspense fallback={null}>
      <AgentChatFull key={key} agentKey={key} />
    </Suspense>
  );
}
