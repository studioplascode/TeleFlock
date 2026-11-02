import { lazy, Suspense } from "react";
import { create } from "zustand";
import { useUi } from "@/core";

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
}

export const useBoardUi = create<BoardUi>()(() => ({ full: null, reveal: {} }));

/** Opens the session's message board; `messageId`: scrolled to and flashed. */
export function openBoard(agentKey: string, mobile: boolean, messageId?: string): void {
  if (messageId) useBoardUi.setState((s) => ({ reveal: { ...s.reveal, [agentKey]: messageId } }));
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
