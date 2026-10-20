import { useEffect, useRef, useState } from "react";
import { pulseBus } from "@/core";

const HALF_LIFE_MS = 6000;
const PICK_EVERY_MS = 2500;
/** A challenger must beat the current leader by this factor to take over (no flapping). */
const HYSTERESIS = 1.6;

/**
 * The running agent with the most pulse energy (exponentially decayed), re-evaluated every 2.5 s.
 * Imperative pulse accounting; only a leader change re-renders.
 */
export function useMostActive(candidates: readonly string[]): string | null {
  const scores = useRef(new Map<string, { v: number; at: number }>());
  const [leader, setLeader] = useState<string | null>(candidates[0] ?? null);
  const candRef = useRef(candidates);
  useEffect(() => {
    candRef.current = candidates;
  }, [candidates]);

  useEffect(() => {
    const decayed = (key: string, now: number) => {
      const s = scores.current.get(key);
      return s ? s.v * 0.5 ** ((now - s.at) / HALF_LIFE_MS) : 0;
    };
    const unsub = pulseBus.subscribeAll((key, p) => {
      const now = performance.now();
      scores.current.set(key, { v: decayed(key, now) + Math.max(1, p.n), at: now });
    });
    const pick = () => {
      const now = performance.now();
      const cands = candRef.current;
      setLeader((cur) => {
        let best: string | null = null;
        let bestV = -1;
        for (const k of cands) {
          const v = decayed(k, now);
          if (v > bestV) {
            best = k;
            bestV = v;
          }
        }
        if (cur && cands.includes(cur) && best !== cur && bestV < decayed(cur, now) * HYSTERESIS) return cur;
        return best;
      });
    };
    pick();
    const t = window.setInterval(pick, PICK_EVERY_MS);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, []);

  // the leader left the running lane: re-pick right away
  useEffect(() => {
    if (leader && candidates.includes(leader)) return;
    setLeader(candidates[0] ?? null);
  }, [candidates, leader]);

  return leader;
}
