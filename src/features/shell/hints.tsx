import { type ReactNode, useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { usePrefs } from "@/core";
import { cn } from "@/design";

/** How many times each first-use hint has been shown (or `Infinity` once its feature was used). */
const useHintCounts = create<{ counts: Record<string, number>; seen(id: string): void; used(id: string): void }>()(
  persist(
    (set) => ({
      counts: {},
      seen: (id) => set((s) => ({ counts: { ...s.counts, [id]: (s.counts[id] ?? 0) + 1 } })),
      used: (id) => set((s) => ({ counts: { ...s.counts, [id]: Number.MAX_SAFE_INTEGER } })),
    }),
    { name: "tf.firstUses", partialize: ({ counts }) => ({ counts }) },
  ),
);

/**
 * A first-use hint: shown on the first `limit` mounts of the surface that carries it, then never
 * again; `done()` retires it immediately (call it when the user actually uses the feature).
 * Settings → Hints turns every hint off.
 */
export function useFirstUse(id: string, limit = 3): { show: boolean; done: () => void } {
  const enabled = usePrefs((s) => s.hints);
  const count = useHintCounts((s) => s.counts[id] ?? 0);
  // Decided once per mount, so the exposure that reaches the limit is still shown in full.
  const [eligible] = useState(() => count < limit);
  const [retired, setRetired] = useState(false);
  const show = enabled && eligible && !retired;
  useEffect(() => {
    if (enabled && eligible) useHintCounts.getState().seen(id);
  }, [enabled, eligible, id]);
  return {
    show,
    done: () => {
      setRetired(true);
      useHintCounts.getState().used(id);
    },
  };
}

/** Forget every hint's count (Settings → Hints → "Show hints again"). */
export function resetFirstUses(): void {
  useHintCounts.setState({ counts: {} });
}

/** The visual of a first-use hint: one muted line beside the control it explains, never a popover. */
export function FirstUseHint({ id, limit, children, className }: { id: string; limit?: number; children: ReactNode; className?: string }) {
  const { show } = useFirstUse(id, limit);
  if (!show) return null;
  return <span className={cn("text-2xs leading-snug text-mute", className)}>{children}</span>;
}
