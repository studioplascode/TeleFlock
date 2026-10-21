import type { NotifyKind, Settings } from "@/core/gen";

let ctx: AudioContext | null = null;

/** Minutes since midnight for `HH:MM`, or null when malformed. */
function minutes(hhmm: string | undefined): number | null {
  const m = hhmm ? /^(\d{1,2}):(\d{2})$/.exec(hhmm) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Inside the user's quiet hours (window may wrap past midnight). */
export function inQuietHours(s: Pick<Settings, "quietStart" | "quietEnd">, now = new Date()): boolean {
  const a = minutes(s.quietStart);
  const b = minutes(s.quietEnd);
  if (a === null || b === null || a === b) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return a < b ? t >= a && t < b : t >= a || t < b;
}

/** Two-note notes per kind: rising for "needs you", soft fall for finished, low for errors. */
const NOTES: Partial<Record<NotifyKind, readonly [number, number]>> = {
  needs: [659.25, 987.77],
  finished: [783.99, 587.33],
  error: [329.63, 261.63],
};

/**
 * A short synthesized chime (no asset) for in-app notifications. Used where the OS doesn't play
 * one (browser / devserver); silently does nothing before the first user gesture.
 */
export function playChime(kind: NotifyKind): void {
  const notes = NOTES[kind];
  if (!notes || typeof AudioContext === "undefined") return;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  ctx ??= new AudioContext();
  const t0 = ctx.currentTime + 0.01;
  notes.forEach((freq, i) => {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = t0 + i * 0.12;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.4);
  });
}
