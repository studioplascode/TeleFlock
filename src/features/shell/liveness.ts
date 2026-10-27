import { useEffect } from "react";
import { create } from "zustand";
import { type AmbientMood, moodFor, useLivelyMotion } from "@/design";
import { pulseBus, useAgentKeys, useHosts, useInbox } from "@/core";

interface GlobalPulse {
  /** Monotonic beat counter across every agent (feeds Heartbeat). */
  beat: number;
  /** Wall-clock time of the last pulse anywhere. */
  lastAt: number | undefined;
}

/** Aggregated heartbeat of the whole flock. Fed by `useGlobalPulseFeed` (mounted once by the shell). */
export const useGlobalPulse = create<GlobalPulse>()(() => ({ beat: 0, lastAt: undefined }));

/** Lively coalescing window: pulses arrive per agent at ≤10 Hz; React sees at most ~6 updates/s. */
const FLUSH_MS = 160;
/**
 * Calm and Reduced: one beat per second at most, however many agents stream, so the title-bar
 * heartbeat (a still trace there, see Heartbeat) settles into a resting rhythm instead of redrawing
 * on every pulse.
 */
const RESTING_FLUSH_MS = 1000;

/** Fold every agent's pulses into `useGlobalPulse`. Mount exactly once. */
export function useGlobalPulseFeed(): void {
  const lively = useLivelyMotion();
  useEffect(() => {
    let pending = 0;
    let timer: number | undefined;
    const flush = () => {
      timer = undefined;
      const n = lively ? Math.min(pending, 3) : 1;
      pending = 0;
      useGlobalPulse.setState((s) => ({ beat: s.beat + n, lastAt: Date.now() }));
    };
    const unsub = pulseBus.subscribeAll(() => {
      pending++;
      if (timer === undefined) timer = window.setTimeout(flush, lively ? FLUSH_MS : RESTING_FLUSH_MS);
    });
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, [lively]);
}

export interface FlockCounts {
  needs: number;
  running: number;
  /** Hosts in an error phase. */
  errors: number;
}

/** Counts that drive the global mood (ambient glow, heartbeat colour, title bar). */
export function useFlockCounts(): FlockCounts {
  const needs = useInbox().length;
  const running = useAgentKeys({ column: "running" }).length;
  const errors = useHosts((h) => {
    let n = 0;
    for (const s of Object.values(h.status)) if (s.phase === "error") n++;
    return n;
  });
  return { needs, running, errors };
}

/** Sunset when anything needs you, purple while work runs, calm when idle. */
export function useGlobalMood(): AmbientMood {
  const c = useFlockCounts();
  return moodFor({ needsYou: c.needs, running: c.running, error: c.errors });
}
