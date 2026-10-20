import { useEffect } from "react";
import { openSession, useCore } from "@/core";

/**
 * The agent's last assistant message (the context right before its question). Holds the
 * session open while mounted (ref-counted in core) so the transcript is available.
 */
export function useLastAssistant(key: string | null, enabled = true): { text: string | null; loading: boolean } {
  useEffect(() => {
    if (!key || !enabled) return;
    return openSession(key);
  }, [key, enabled]);
  const text = useCore((s) => {
    if (!key) return null;
    const se = s.sessions[key];
    if (!se) return null;
    for (let i = se.itemIds.length - 1; i >= 0; i--) {
      const id = se.itemIds[i];
      const item = id ? se.items[id] : undefined;
      if (item?.kind === "assistant" && item.text.trim()) return item.text;
    }
    return null;
  });
  const loading = useCore((s) => (key ? (s.sessions[key]?.status ?? "loading") === "loading" : false));
  return { text, loading };
}
