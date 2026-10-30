import type { AgentView } from "@/core";
import { agentStateId } from "@/features/shell/vocab";

/*
 * Ambient mode's chimes: one sound per state an agent enters (it needs you, it finished, it went
 * back to work, it was marked done), each switchable, throttled so a busy flock never turns into a
 * wind chime. The decisions are pure (`stateChanges`, `ChimeGate`, tested); `playChime` only
 * synthesizes the sound.
 */

/** A state that can chime when an agent enters it. Fresh agents (no prompt yet) never chime. */
export type ChimeKind = "needs" | "review" | "running" | "done";

/** Most important first: a chime that stands for several changes takes the first kind among them. */
export const CHIME_KINDS: readonly ChimeKind[] = ["needs", "review", "running", "done"];

type ChimeAgent = Pick<AgentView, "key" | "column" | "turns" | "title">;

/** The chiming state an agent is in now (`null`: a fresh agent waiting for its first prompt). */
export function chimeState(a: ChimeAgent): ChimeKind | null {
  const s = agentStateId(a);
  return s === "fresh" ? null : s;
}

export interface StateChange {
  key: string;
  kind: ChimeKind;
}

/**
 * Agents that entered a chiming state between two snapshots (agent key → `chimeState`). An agent
 * seen for the first time is only news when it arrives needing you: a host that comes online, or
 * the first snapshot after the view opened, must not ring for everything already running.
 */
export function stateChanges(prev: ReadonlyMap<string, ChimeKind | null>, next: ReadonlyMap<string, ChimeKind | null>): StateChange[] {
  const out: StateChange[] = [];
  for (const [key, kind] of next) {
    if (kind === null) continue;
    if (!prev.has(key)) {
      if (kind === "needs") out.push({ key, kind });
    } else if (prev.get(key) !== kind) out.push({ key, kind });
  }
  return out;
}

export interface ChimeGateOptions {
  /** Least time between two chimes; changes inside it join the next one (ms). */
  gapMs: number;
  /** The same agent entering the same state again within this long stays quiet (a run of questions) (ms). */
  repeatMs: number;
  /** Chimes per rolling minute; past it only "needs you" still sounds. */
  perMinute: number;
}

export const CHIME_GATE: ChimeGateOptions = { gapMs: 2500, repeatMs: 30_000, perMinute: 6 };

const MINUTE_MS = 60_000;

/**
 * Throttle between state changes and the speaker. Changes inside `gapMs` of the last chime are held
 * and play as one chime when the gap ends (`due()` says when; call `flush`), with the most important
 * kind among them. An agent repeating the same state within `repeatMs` adds nothing, and past
 * `perMinute` chimes in a minute only "needs you" gets through.
 */
export class ChimeGate {
  private last = Number.NEGATIVE_INFINITY;
  private played: number[] = [];
  private heard = new Map<string, number>();
  private pending: ChimeKind | null = null;

  constructor(private readonly opts: ChimeGateOptions = CHIME_GATE) {}

  /** State changes seen at `now`; returns the chime to play right away, or null (held or quiet). */
  offer(changes: readonly StateChange[], now: number): ChimeKind | null {
    for (const [id, at] of this.heard) if (now - at >= this.opts.repeatMs) this.heard.delete(id);
    let best = this.pending;
    for (const c of changes) {
      const id = `${c.kind}|${c.key}`;
      if (this.heard.has(id)) continue;
      this.heard.set(id, now);
      if (best === null || CHIME_KINDS.indexOf(c.kind) < CHIME_KINDS.indexOf(best)) best = c.kind;
    }
    this.pending = best;
    return this.flush(now);
  }

  /** When the held chime may play (ms epoch), or null when nothing is held. */
  due(): number | null {
    return this.pending === null ? null : this.last + this.opts.gapMs;
  }

  /** Plays the held chime once the gap since the last one has passed. */
  flush(now: number): ChimeKind | null {
    const kind = this.pending;
    if (kind === null || now - this.last < this.opts.gapMs) return null;
    this.pending = null;
    this.played = this.played.filter((t) => now - t < MINUTE_MS);
    if (kind !== "needs" && this.played.length >= this.opts.perMinute) return null;
    this.played.push(now);
    this.last = now;
    return kind;
  }
}

/** Notes per kind (Hz): a rising triad asks, a falling pair finishes, one low note is back to work, a soft fifth settles. */
const NOTES: Record<ChimeKind, readonly number[]> = {
  needs: [659.25, 830.61, 987.77],
  review: [783.99, 587.33],
  running: [440],
  done: [523.25, 392],
};

let audio: AudioContext | null = null;

/**
 * Creates (or wakes) the audio context. Call it from the click that turns chimes on: browsers only
 * let a page start audio after a user gesture, and later chimes have none of their own.
 */
export function unlockChimes(): void {
  if (typeof AudioContext === "undefined") return;
  audio ??= new AudioContext();
  if (audio.state === "suspended") void audio.resume().catch(() => {});
}

/** A short synthesized chime (no asset). Silent before the first user gesture. */
export function playChime(kind: ChimeKind): void {
  if (typeof AudioContext === "undefined") return;
  if (!audio && navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  unlockChimes();
  const ctx = audio;
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.02;
  NOTES[kind].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === "needs" ? "triangle" : "sine";
    osc.frequency.value = freq;
    const start = t0 + i * 0.13;
    const peak = kind === "running" || kind === "done" ? 0.07 : 0.1;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.6);
  });
}
