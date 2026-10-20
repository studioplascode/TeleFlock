import { useEffect, useState } from "react";
import { useNow } from "../lib/clock";

/** How busy an agent is, from its event rate. Drives breath speed, heartbeat energy, etc. */
export type ActivityTier = "silent" | "calm" | "steady" | "busy" | "frantic";

/** Seconds per breath cycle for each tier (StatusOrb, GlowBorder speed). */
export const BREATH_SECONDS: Record<ActivityTier, number> = {
  silent: 4.2,
  calm: 3.0,
  steady: 2.1,
  busy: 1.35,
  frantic: 0.85,
};

const WINDOW_MS = 8000;

/** Events per second → tier. */
export function tierForRate(eventsPerSecond: number): ActivityTier {
  if (eventsPerSecond <= 0) return "silent";
  if (eventsPerSecond < 0.35) return "calm";
  if (eventsPerSecond < 1.2) return "steady";
  if (eventsPerSecond < 3.5) return "busy";
  return "frantic";
}

/**
 * Track activity from a monotonically increasing event counter (`beat`).
 * Increment the counter whenever the agent emits anything (token, tool call, state change).
 */
export function useActivity(beat: number): { tier: ActivityTier; rate: number } {
  const [stamps, setStamps] = useState<number[]>([]);
  const [prevBeat, setPrevBeat] = useState(beat);
  const now = useNow(1000);

  useEffect(() => {
    if (beat === prevBeat) return;
    const t = Date.now();
    const added = Math.max(1, Math.min(beat - prevBeat, 20));
    setPrevBeat(beat);
    setStamps((s) => {
      const kept = s.filter((x) => x > t - WINDOW_MS);
      for (let i = 0; i < added; i++) kept.push(t);
      return kept;
    });
  }, [beat, prevBeat]);

  const horizon = Math.max(now, stamps[stamps.length - 1] ?? 0) - WINDOW_MS;
  let count = 0;
  for (const s of stamps) if (s > horizon) count++;
  const rate = count / (WINDOW_MS / 1000);
  return { tier: tierForRate(rate), rate };
}
