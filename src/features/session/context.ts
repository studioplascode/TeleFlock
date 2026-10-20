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
