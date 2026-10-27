import { useSyncExternalStore } from "react";
import { isWindowVisible, onWindowVisible } from "./windowActive";

/*
 * Shared clocks. One setInterval per period and one requestAnimationFrame loop for the whole app,
 * no matter how many timers/heartbeats are on screen. Interval clocks hold still while the window
 * is hidden (minimized, in the tray, another tab): nothing re-renders for a clock nobody can see.
 * An unfocused window keeps ticking (a board watched on a second monitor stays truthful). They
 * tick at once when the window is shown again. The rAF loop stops with the browser while the
 * document is hidden.
 */

type Listener = () => void;

interface IntervalClock {
  now: number;
  listeners: Set<Listener>;
  id: ReturnType<typeof setInterval> | undefined;
}

const intervals = new Map<number, IntervalClock>();

function getIntervalClock(periodMs: number): IntervalClock {
  let clock = intervals.get(periodMs);
  if (!clock) {
    clock = { now: Date.now(), listeners: new Set(), id: undefined };
    intervals.set(periodMs, clock);
  }
  return clock;
}

function tick(clock: IntervalClock) {
  clock.now = Date.now();
  for (const l of clock.listeners) l();
}

let catchingUp = false;

function startInterval(periodMs: number, clock: IntervalClock) {
  if (clock.id !== undefined) return;
  if (!catchingUp) {
    catchingUp = true;
    // Shown again: every running clock ticks now instead of up to one period late.
    onWindowVisible((visible) => {
      if (visible) for (const c of intervals.values()) if (c.id !== undefined) tick(c);
    });
  }
  clock.now = Date.now();
  clock.id = setInterval(() => {
    if (isWindowVisible()) tick(clock);
  }, periodMs);
}

/**
 * Wall-clock `Date.now()` that re-renders every `periodMs` (default 1s). All subscribers with the
 * same period share one timer and tick in sync (so every Elapsed on screen flips together). The
 * value holds still while the window is hidden and catches up when it is shown again.
 * `null` subscribes to nothing (for a hook that only needs the clock some of the time); the
 * returned value is then the time of the last tick of any 1 s clock and must not be relied on.
 */
export function useNow(periodMs: number | null = 1000): number {
  const clock = getIntervalClock(periodMs ?? 1000);
  return useSyncExternalStore(
    (onChange) => {
      if (periodMs === null) return () => {};
      clock.listeners.add(onChange);
      startInterval(periodMs, clock);
      return () => {
        clock.listeners.delete(onChange);
        if (clock.listeners.size === 0 && clock.id !== undefined) {
          clearInterval(clock.id);
          clock.id = undefined;
        }
      };
    },
    () => clock.now,
    () => clock.now,
  );
}

/** Per-frame callback: (timeMs, deltaMs). */
export type FrameCallback = (t: number, dt: number) => void;

const frameSubs = new Set<FrameCallback>();
let rafId = 0;
let lastT = 0;

function loop(t: number) {
  const dt = lastT ? Math.min(t - lastT, 100) : 16.7;
  lastT = t;
  for (const cb of frameSubs) cb(t, dt);
  rafId = frameSubs.size ? requestAnimationFrame(loop) : 0;
}

/** Subscribe to the single shared rAF loop. Returns an unsubscribe function. */
export function onFrame(cb: FrameCallback): () => void {
  frameSubs.add(cb);
  if (!rafId) {
    lastT = 0;
    rafId = requestAnimationFrame(loop);
  }
  return () => {
    frameSubs.delete(cb);
    if (!frameSubs.size && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
}
