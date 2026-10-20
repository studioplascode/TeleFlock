import { useEffect, useState } from "react";
import type { ActivityTier } from "@/design";

/** Mean events/second for each simulated activity tier. */
export const SIM_RATE: Record<ActivityTier, number> = {
  silent: 0,
  calm: 0.25,
  steady: 0.8,
  busy: 2.2,
  frantic: 5,
};

export interface SimStream {
  beat: number;
  lastEventAt: number | undefined;
  tokens: number;
  cost: number;
  series: number[];
  /** Beat count when the series last rolled. */
  seriesBeat: number;
}

/** Poisson event stream for the gallery: beats, token/cost counters and a rolling activity series. */
export function useSimStream(rate: number, seedTokens = 1_240_000): SimStream {
  const [state, setState] = useState<SimStream>(() => ({
    beat: 0,
    lastEventAt: Date.now() - 4000,
    tokens: seedTokens,
    cost: seedTokens * 0.0000061,
    series: Array.from({ length: 24 }, (_, i) => 3 + Math.sin(i / 2.4) * 2 + ((i * 7) % 5) / 2),
    seriesBeat: 0,
  }));

  useEffect(() => {
    if (rate <= 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const wait = (-Math.log(1 - Math.random()) / rate) * 1000;
      timer = setTimeout(() => {
        const gained = 400 + Math.round(Math.random() * 2600);
        const at = Date.now();
        setState((s) => ({
          ...s,
          beat: s.beat + 1,
          lastEventAt: at,
          tokens: s.tokens + gained,
          cost: s.cost + gained * 0.0000061,
        }));
        schedule();
      }, Math.max(60, wait));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [rate]);

  // roll the sparkline series every 1.5s from the recent beat count
  useEffect(() => {
    const id = setInterval(() => {
      const jitter = Math.random() * 0.6;
      setState((s) => ({ ...s, seriesBeat: s.beat, series: [...s.series.slice(1), s.beat - s.seriesBeat + jitter] }));
    }, 1500);
    return () => clearInterval(id);
  }, []);

  return state;
}

const SCRIPT =
  "I'll wire the drag-and-drop between lanes first, then persist the column order through the herdr state file. Running the board tests now — 31 of 40 passing; the keyboard-move cases still fail because focus is lost after the card re-parents.";

/** Word-by-word streaming text that loops. */
export function useSimStreamingText(running: boolean): { text: string; streaming: boolean } {
  const [n, setN] = useState(0);
  const words = SCRIPT.split(" ");
  const streaming = running && n < words.length;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setN((v) => (v >= words.length + 14 ? 0 : v + 1));
    }, 85 + Math.random() * 60);
    return () => clearInterval(id);
  }, [running, words.length]);
  return { text: words.slice(0, Math.min(n, words.length)).join(" "), streaming };
}
