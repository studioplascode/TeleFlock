import { useEffect } from "react";
import { retryTurn } from "./actions";
import { isResumeKey } from "./words";

/** Where focus counts as "in this session" for F5 / Alt+R: the element carrying the agent key. */
const ROOT = "data-session-root";

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
      const t = e.target instanceof Element ? e.target : null;
      const root = t?.closest(`[${ROOT}]`);
      const mine = root ? root.getAttribute(ROOT) === agentKey : fallback && (t === null || t === document.body || t === document.documentElement);
      if (!mine) return;
      e.preventDefault();
      if (!e.repeat) void retryTurn(agentKey);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agentKey, fallback]);
}
