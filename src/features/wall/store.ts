import { create } from "zustand";
import { persist } from "zustand/middleware";
import { assignTiles, dropKeys, MAX_TILES, normalizePins, placeAgent, renameKey, swapTiles, type WallCandidate, type WallSize } from "./layout";

/** What the wall remembers on this device: a big monitor's wall is not a laptop's. */
interface WallPrefs {
  size: WallSize;
  /** The agent the user put in each tile (index = tile, kept for 3×3 even while 2×2 shows). */
  pins: (string | null)[];
  /** Agents taken off the wall by hand: auto-fill skips them until you pick them again. */
  hidden: string[];
  /** Fill unpinned tiles with the agents that matter most right now. */
  auto: boolean;
}

export interface WallState extends WallPrefs {
  /** What each visible tile shows: its pin, else what auto-fill put there (not persisted). */
  shown: (string | null)[];
  /** Candidates of the last `sync`, reused when the arrangement changes in between. */
  candidates: WallCandidate[];
  setSize(size: WallSize): void;
  setAuto(on: boolean): void;
  /** Show `key` in tile `index` (trades places with the tile already showing it). */
  place(index: number, key: string): void;
  /** Trade two tiles' agents (drag and drop, Move left/right). */
  swap(a: number, b: number): void;
  /** Let auto-fill manage the tile again. */
  unpin(index: number): void;
  /** Take the tile's agent off the wall (auto-fill won't bring it back). */
  remove(index: number): void;
  /** No pins, nothing hidden. */
  reset(): void;
  /** New candidates (agents changed state) or the clock moved on (lingering tiles may be due). */
  sync(candidates: WallCandidate[], now: number): void;
  /** A parked agent resumed under a new id. */
  rename(from: string, to: string): void;
  /** Agents whose omp session was deleted. */
  forget(keys: ReadonlySet<string>): void;
}

const DEFAULTS: WallPrefs = { size: 4, pins: normalizePins([]), hidden: [], auto: true };

/** Recompute `shown` after a change of prefs or candidates (the same array while nothing moved). */
function arrange(s: WallState, patch: Partial<WallState>, now = Date.now()): Partial<WallState> {
  const next = { ...s, ...patch };
  const shown = assignTiles({ size: next.size, pins: next.pins, prev: s.shown, candidates: next.candidates, hidden: next.hidden, auto: next.auto, now });
  const same = shown.length === s.shown.length && shown.every((k, i) => k === s.shown[i]);
  return { ...patch, shown: same ? s.shown : shown };
}

export const useWall = create<WallState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,
      shown: [],
      candidates: [],
      setSize: (size) => set((s) => arrange(s, { size })),
      setAuto: (auto) => set((s) => arrange(s, { auto })),
      place: (index, key) => set((s) => arrange(s, { pins: placeAgent(s.pins, s.shown, index, key), hidden: s.hidden.filter((k) => k !== key) })),
      swap: (a, b) => {
        const { size } = get();
        if (a === b || a < 0 || b < 0 || a >= size || b >= size) return;
        set((s) => arrange(s, { pins: swapTiles(s.pins, s.shown, a, b) }));
      },
      unpin: (index) => set((s) => arrange(s, { pins: s.pins.map((k, i) => (i === index ? null : k)) })),
      remove: (index) =>
        set((s) => {
          const key = s.shown[index];
          const pins = s.pins.map((k, i) => (i === index ? null : k));
          return arrange(s, { pins, hidden: key && !s.hidden.includes(key) ? [...s.hidden, key] : s.hidden });
        }),
      reset: () => set((s) => arrange(s, { pins: normalizePins([]), hidden: [] })),
      sync: (candidates, now) => set((s) => arrange(s, { candidates }, now)),
      rename: (from, to) =>
        set((s) => {
          if (!s.pins.includes(from) && !s.hidden.includes(from) && !s.shown.includes(from)) return s;
          // the auto-filled tile keeps its place for the new id too
          const shown = renameKey(s.shown, from, to);
          return arrange({ ...s, shown }, { pins: renameKey(s.pins, from, to), hidden: renameKey(s.hidden, from, to) });
        }),
      forget: (keys) =>
        set((s) => {
          if (![...s.pins, ...s.hidden].some((k) => k !== null && keys.has(k))) return s;
          return arrange(s, dropKeys(s.pins, s.hidden, keys));
        }),
    }),
    {
      name: "tf.wall",
      version: 1,
      partialize: ({ size, pins, hidden, auto }): WallPrefs => ({ size, pins, hidden, auto }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<WallPrefs>;
        return {
          ...current,
          size: p.size === 9 ? 9 : 4,
          pins: normalizePins(Array.isArray(p.pins) ? p.pins.slice(0, MAX_TILES).map((k) => (typeof k === "string" ? k : null)) : []),
          hidden: Array.isArray(p.hidden) ? p.hidden.filter((k): k is string => typeof k === "string") : [],
          auto: p.auto !== false,
        };
      },
    },
  ),
);

/** Is tile `index` showing its pin (not something auto-fill chose)? */
export function isPinned(s: Pick<WallState, "pins" | "shown">, index: number): boolean {
  const key = s.shown[index];
  return key != null && s.pins[index] === key;
}
