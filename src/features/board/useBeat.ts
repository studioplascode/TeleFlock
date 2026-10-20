import { useEffect, useState } from "react";
import { pulseBus } from "@/core";
import type { PulseKind } from "@/core/gen";

/**
 * One heart beat at most every BEAT_GAP_MS: pulses arrive at up to 10 Hz, an ECG complex is ~0.8 s
 * wide, so busier agents beat faster (up to ~2.8 Hz) instead of smearing into noise.
 */
const BEAT_GAP_MS = 360;

export interface BeatState {
  /** Monotonic counter for <Heartbeat beat> and useActivity(). */
  beat: number;
  /** Kind of the most recent pulse (drives small accents, e.g. tool vs token). */
  kind: PulseKind | null;
  /** Time of the last pulse (ms epoch). */
  lastAt: number | undefined;
}

/**
 * Subscribe to pulses (imperative pulseBus) of one agent key, or of any agent in a key list
 * (aggregate heartbeat), and expose a throttled beat counter. Only the calling component
 * re-renders on pulses; keep it small (orb, heartbeat).
 */
export function useBeat(source: string | readonly string[] | null | undefined): BeatState {
  const [state, setState] = useState<BeatState>({ beat: 0, kind: null, lastAt: undefined });
  const single = typeof source === "string" ? source : null;
  const many = Array.isArray(source) ? source.join("\n") : null;

  useEffect(() => {
    if (!single && !many) return;
    let lastBeat = 0;
    let timer: number | undefined;
    let pendingKind: PulseKind | null = null;
    let pendingAt = 0;
    const flush = () => {
      timer = undefined;
      lastBeat = performance.now();
      const kind = pendingKind;
      const lastAt = pendingAt;
      setState((s) => ({ beat: s.beat + 1, kind, lastAt }));
    };
    const onPulse = (kind: PulseKind) => {
      pendingKind = kind;
      pendingAt = Date.now();
      if (timer !== undefined) return;
      const wait = BEAT_GAP_MS - (performance.now() - lastBeat);
      if (wait <= 0) flush();
      else timer = window.setTimeout(flush, wait);
    };
    let unsub: () => void;
    if (single) unsub = pulseBus.subscribe(single, (p) => onPulse(p.kind));
    else {
      const keys = new Set(many?.split("\n"));
      unsub = pulseBus.subscribeAll((key, p) => {
        if (keys.has(key)) onPulse(p.kind);
      });
    }
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, [single, many]);
  return state;
}
