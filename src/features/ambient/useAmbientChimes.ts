import { useEffect, useRef } from "react";
import { isMuted, useCore, useSettings } from "@/core";
import { inQuietHours } from "@/features/notify/chime";
import { ChimeGate, type ChimeKind, chimeState, playChime, stateChanges } from "./chimes";
import { useAmbientPrefs } from "./prefs";

const SEP_FIELD = "\u0001";
const SEP_AGENT = "\u0002";

function parse(sig: string): Map<string, ChimeKind | null> {
  const out = new Map<string, ChimeKind | null>();
  if (!sig) return out;
  for (const entry of sig.split(SEP_AGENT)) {
    const [key = "", kind = ""] = entry.split(SEP_FIELD);
    out.set(key, (kind || null) as ChimeKind | null);
  }
  return out;
}

/**
 * Plays ambient mode's chimes while it is open and chimes are on: each agent entering a state whose
 * chime is switched on, through one `ChimeGate` (coalescing, repeat and per-minute limits). Muted
 * agents and the user's quiet hours stay silent. The first snapshot after turning chimes on only
 * sets the baseline.
 */
export function useAmbientChimes(): void {
  const on = useAmbientPrefs((s) => s.chime);
  // one string per state change, not per streamed token: the effect below runs only when it changes
  const sig = useCore((s) =>
    on
      ? Object.values(s.agents)
          .map((a) => `${a.key}${SEP_FIELD}${chimeState(a) ?? ""}`)
          .sort()
          .join(SEP_AGENT)
      : "",
  );
  const prev = useRef<Map<string, ChimeKind | null> | null>(null);
  const gate = useRef<ChimeGate | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!on) {
      prev.current = null;
      gate.current = null;
      clearTimeout(timer.current);
      return;
    }
    const next = parse(sig);
    const before = prev.current;
    prev.current = next;
    if (!before) return;
    const { chimeOn } = useAmbientPrefs.getState();
    const changes = stateChanges(before, next).filter((c) => chimeOn[c.kind] && !isMuted(c.key));
    if (changes.length === 0 || inQuietHours(useSettings.getState())) return;
    if (!gate.current) gate.current = new ChimeGate();
    const g = gate.current;
    const play = (kind: ChimeKind | null) => {
      if (kind && !inQuietHours(useSettings.getState())) playChime(kind);
    };
    // a held chime plays when its gap ends; a newer change may move that moment, so re-arm each time
    const arm = () => {
      clearTimeout(timer.current);
      const due = g.due();
      if (due === null) return;
      timer.current = window.setTimeout(() => {
        play(g.flush(Date.now()));
        arm();
      }, Math.max(0, due - Date.now()));
    };
    play(g.offer(changes, Date.now()));
    arm();
  }, [on, sig]);

  useEffect(() => () => clearTimeout(timer.current), []);
}
