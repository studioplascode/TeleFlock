import { useEffect } from "react";
import { inSessionScope } from "../context";
import { retryTurn } from "./actions";
import { isResumeKey } from "./words";

/**
 * omp's retry keys in a session view: F5 and Alt+R while focus is inside an element whose
 * `data-session-root` is this agent's key, or on nothing at all for the route's session
 * (`fallback`). They always `preventDefault()` (the webview never reloads) and run even when the
 * Resume button isn't shown: the answer then says there was nothing to resume, like omp's own F5.
 */
export function useResumeKeys(agentKey: string, fallback: boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || !isResumeKey(e)) return;
      if (!inSessionScope(e.target instanceof Element ? e.target : null, agentKey, fallback)) return;
      e.preventDefault();
      if (!e.repeat) void retryTurn(agentKey);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agentKey, fallback]);
}
