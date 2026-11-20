import { createContext, useContext } from "react";

export interface SessionRef {
  hostId: string;
  agentId: string;
  /** `${hostId}::${agentId}` */
  key: string;
}

export const SessionCtx = createContext<SessionRef | null>(null);

/** The session the current subtree renders (transcript rows, tool cards, inspector panels). */
export function useSessionRef(): SessionRef {
  const ref = useContext(SessionCtx);
  if (!ref) throw new Error("useSessionRef outside <SessionCtx.Provider>");
  return ref;
}

/** Marks the element of a session view (its pane, the desktop view around it, a phone page) with its agent key. */
const ROOT = "data-session-root";

/**
 * Whether a key pressed at `target` is meant for session `agentKey`: focus is inside an element
 * whose `data-session-root` is that key, or on nothing at all for the route's session (`fallback`).
 */
export function inSessionScope(target: Element | null, agentKey: string, fallback: boolean): boolean {
  const root = target?.closest(`[${ROOT}]`);
  return root ? root.getAttribute(ROOT) === agentKey : fallback && (target === null || target === document.body || target === document.documentElement);
}
