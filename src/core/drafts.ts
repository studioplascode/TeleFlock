import { useMemo } from "react";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { answerFlushRequests, onFlush } from "./draftFlush";
import { mirroredItem } from "./mirrored";

/*
 * Drafts: every user-typed text field in the app (composers, answers, dialog forms, filters)
 * keeps its value here, keyed by context, so it survives unmounts (switching agent or view),
 * reloads, restarts and kills. Persisted to localStorage with an IndexedDB copy (`./mirrored`;
 * debounced, pruned to a budget) by the main page only (`startDrafts`); an entry that equals its
 * field's default is deleted, so only real drafts are stored.
 */

export interface DraftEntry {
  /** The field's value. */
  v: string;
  /** Last change (ms epoch): pruning drops the oldest first. */
  at: number;
}

export interface DraftLimits {
  maxEntries: number;
  maxAgeMs: number;
  /** Characters (keys + values) persisted at most; localStorage is ~5 MB, shared with the app. */
  maxChars: number;
}

export const DRAFT_LIMITS: DraftLimits = { maxEntries: 400, maxAgeMs: 30 * 86_400_000, maxChars: 1_000_000 };

const SEP = "\u0000";

/** Draft key from a scope (`composer`, `answer`, `dialog.goal`…) and context parts (host, agent, repo…). */
export function draftKey(scope: string, ...parts: (string | number)[]): string {
  return [scope, ...parts].join(SEP);
}

/** Inverse of `draftKey`: `[scope, ...parts]`. */
export function draftKeyParts(key: string): string[] {
  return key.split(SEP);
}

/**
 * The entries worth persisting: drops malformed and expired entries, then keeps the newest ones
 * within the count and size budget (an entry too big for what is left is skipped, so smaller older
 * ones can still fit).
 */
export function pruneDrafts(drafts: Record<string, DraftEntry>, now: number, limits: DraftLimits = DRAFT_LIMITS): Record<string, DraftEntry> {
  const live = Object.entries(drafts).filter(([, e]) => typeof e?.v === "string" && typeof e.at === "number" && now - e.at <= limits.maxAgeMs);
  live.sort((a, b) => b[1].at - a[1].at);
  const out: Record<string, DraftEntry> = {};
  let chars = 0;
  let n = 0;
  for (const [k, e] of live) {
    if (n >= limits.maxEntries) break;
    const size = k.length + e.v.length;
    if (chars + size > limits.maxChars) continue;
    out[k] = e;
    chars += size;
    n++;
  }
  return out;
}

interface DraftsState {
  drafts: Record<string, DraftEntry>;
}

type Persisted = DraftsState;

// ---------------------------------------------------------------- storage

const STORAGE_KEY = "tf.drafts";
const WRITE_DELAY_MS = 300;

/** localStorage `tf.drafts` and its IndexedDB copy, which a kill can't lose once written. */
const mirror = mirroredItem(STORAGE_KEY);

let pending: StorageValue<Persisted> | null = null;
let timer: number | undefined;
/** `startDrafts` made this page the writer and the IndexedDB copy has been read. */
let writable = false;

function serialize(value: StorageValue<Persisted>, maxChars: number): string {
  return JSON.stringify({ ...value, state: { drafts: pruneDrafts(value.state.drafts, Date.now(), { ...DRAFT_LIMITS, maxChars }) } });
}

/**
 * Write the pending drafts now (after a pause in typing, page hide / unload, `flushAll`). Only in
 * the page that writes the drafts, once it has read their IndexedDB copy (`startDrafts`).
 */
export function flushDrafts(): void {
  clearTimeout(timer);
  timer = undefined;
  const p = pending;
  if (!writable || !p) return;
  pending = null;
  // localStorage is ~5 MB, shared with the app: a full one gets the smaller budget.
  mirror.set(serialize(p, DRAFT_LIMITS.maxChars), () => serialize(p, DRAFT_LIMITS.maxChars / 8));
}

/**
 * zustand's storage: never throws, writes debounced (one serialization per pause in typing, not
 * per keystroke) and flushed when the page is hidden or unloaded.
 */
const storage: PersistStorage<Persisted> = {
  getItem: () => {
    try {
      return mirror.initial ? (JSON.parse(mirror.initial) as StorageValue<Persisted>) : null;
    } catch {
      return null;
    }
  },
  setItem: (_name, value) => {
    pending = value;
    timer ??= setTimeout(flushDrafts, WRITE_DELAY_MS);
  },
  removeItem: () => {
    if (writable) mirror.set(null);
  },
};

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushDrafts);
  window.addEventListener("beforeunload", flushDrafts);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDrafts();
  });
}

export const useDrafts = create<DraftsState>()(
  persist(() => ({ drafts: {} }), {
    name: STORAGE_KEY,
    version: 1,
    storage,
    partialize: (s): Persisted => ({ drafts: s.drafts }),
    // Stored drafts under in-memory ones typed before hydration finished.
    merge: (persisted, current) => {
      const stored = (persisted as Partial<Persisted> | undefined)?.drafts;
      return { ...current, drafts: { ...(stored && typeof stored === "object" ? pruneDrafts(stored, Date.now()) : {}), ...current.drafts } };
    },
  }),
);

/** The drafts as localStorage had them at start (hydration is synchronous). */
const hydrated = useDrafts.getState().drafts;

/**
 * The drafts once the IndexedDB copy (`stored`) turned out newer than localStorage's (a kill lost
 * localStorage's last writes): the stored entries, except for keys changed in this page since the
 * start (`boot` → `current`), which keep their current value or stay deleted.
 */
export function adoptStored(boot: Record<string, DraftEntry>, current: Record<string, DraftEntry>, stored: Record<string, DraftEntry>): Record<string, DraftEntry> {
  const next: Record<string, DraftEntry> = {};
  for (const [k, e] of Object.entries(stored)) if (current[k] === boot[k]) next[k] = e;
  for (const [k, e] of Object.entries(current)) if (e !== boot[k]) next[k] = e;
  return next;
}

let started = false;

/**
 * Makes this page the one that writes the drafts (the main page; Quick capture only reads them):
 * reads the IndexedDB copy and takes it when it is newer than localStorage's, writes from then on,
 * and answers the shell's flush requests (`./draftFlush`). Idempotent.
 */
export function startDrafts(): void {
  if (started) return;
  started = true;
  void mirror.load().then((newer) => {
    if (newer !== undefined) {
      let stored: unknown;
      try {
        stored = newer === null ? {} : (JSON.parse(newer) as Partial<StorageValue<Partial<Persisted>>>).state?.drafts;
      } catch {
        stored = undefined;
      }
      if (stored && typeof stored === "object") {
        useDrafts.setState({ drafts: adoptStored(hydrated, useDrafts.getState().drafts, pruneDrafts(stored as Record<string, DraftEntry>, Date.now())) });
      }
    }
    writable = true;
    flushDrafts();
  });
  onFlush(async () => {
    // Writes wait for the IndexedDB copy to be read (bounded: `LOAD_WAIT_MS`).
    await mirror.load();
    flushDrafts();
    await mirror.flushed();
  });
  answerFlushRequests();
}

// ---------------------------------------------------------------- imperative API

function without(all: Record<string, DraftEntry>, pred: (key: string) => boolean): Record<string, DraftEntry> | null {
  let next: Record<string, DraftEntry> | null = null;
  for (const k of Object.keys(all)) {
    if (!pred(k)) continue;
    next ??= { ...all };
    delete next[k];
  }
  return next;
}

export const drafts = {
  /** The draft's value, or `initial` when there is none. */
  get(key: string, initial = ""): string {
    return useDrafts.getState().drafts[key]?.v ?? initial;
  },
  /** Store a value; one equal to `initial` (the field's default, `""` by default) deletes the draft. */
  set(key: string, value: string, initial = ""): void {
    useDrafts.setState((s) => {
      const cur = s.drafts[key];
      if (value === initial) {
        if (!cur) return s;
        const next = { ...s.drafts };
        delete next[key];
        return { drafts: next };
      }
      if (cur?.v === value) return s;
      return { drafts: { ...s.drafts, [key]: { v: value, at: Date.now() } } };
    });
  },
  /** Delete a draft (its field falls back to its default). */
  clear(key: string): void {
    const next = without(useDrafts.getState().drafts, (k) => k === key);
    if (next) useDrafts.setState({ drafts: next });
  },
  /** Delete every draft whose key matches. */
  clearWhere(pred: (key: string) => boolean): void {
    const next = without(useDrafts.getState().drafts, pred);
    if (next) useDrafts.setState({ drafts: next });
  },
  /** Keys of the stored drafts. */
  keys(): string[] {
    return Object.keys(useDrafts.getState().drafts);
  },
};

export type DraftSetter<T> = (next: T | ((cur: T) => T)) => void;

/**
 * A persisted text field: `[value, setValue, clear]`. `initial` is the field's default (shown
 * while there is no draft; a value equal to it is not stored). Clear after a successful submit.
 */
export function useDraft(key: string, initial = ""): [string, DraftSetter<string>, () => void] {
  const stored = useDrafts((s) => s.drafts[key]?.v);
  const set: DraftSetter<string> = (next) => drafts.set(key, typeof next === "function" ? next(drafts.get(key, initial)) : next, initial);
  return [stored ?? initial, set, () => drafts.clear(key)];
}

function parse<T>(raw: string | undefined, initial: T): T {
  if (raw === undefined) return initial;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return initial;
  }
}

/**
 * A persisted form object (JSON-serializable: no functions, Sets, Dates…): `[value, setValue,
 * clear]`. A value equal to `initial` (by JSON) is not stored.
 */
export function useDraftState<T>(key: string, initial: T): [T, DraftSetter<T>, () => void] {
  const stored = useDrafts((s) => s.drafts[key]?.v);
  const initialJson = JSON.stringify(initial);
  const value = useMemo(() => parse(stored, JSON.parse(initialJson) as T), [stored, initialJson]);
  const set: DraftSetter<T> = (next) => {
    const cur = parse(drafts.get(key, initialJson), initial);
    const v = typeof next === "function" ? (next as (cur: T) => T)(cur) : next;
    drafts.set(key, JSON.stringify(v), initialJson);
  };
  return [value, set, () => drafts.clear(key)];
}
