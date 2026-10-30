import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { DraftSetter } from "./drafts";

/*
 * Per-draft-key values too large for localStorage (a draft's images, its pasted texts): kept in
 * memory and written through to IndexedDB. IndexedDB missing or failing (private modes, old
 * WebViews) degrades to memory only. Each kind has its own database, so adding a kind never
 * upgrades another's.
 */

/** Where a kind of draft value persists. */
export interface SlotBackend<S> {
  read(key: string): Promise<S | undefined>;
  /** `null` deletes the key. */
  write(key: string, value: S | null): void;
  /** Every stored key (absent: storage can't list, memory only). */
  keys?(): Promise<string[]>;
}

/** Stored values carry their write time: the sweep drops old ones. */
export interface Stamped {
  at: number;
}

/**
 * One IndexedDB database `db` with one object store `store`. When first opened it drops entries
 * older than `maxAgeMs` and all but the newest `maxStored`. Never rejects: a failing request reads
 * as missing and a failing write is lost (memory keeps the value for this run).
 */
export function indexedDbSlots<S extends Stamped>(db: string, store: string, limits: { maxStored: number; maxAgeMs: number }): SlotBackend<S> {
  let opened: Promise<IDBDatabase | null> | null = null;
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  const open = (): Promise<IDBDatabase | null> => {
    opened ??= new Promise<IDBDatabase | null>((resolve) => {
      try {
        if (typeof indexedDB === "undefined") return resolve(null);
        const req = indexedDB.open(db, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(store);
        req.onsuccess = () => {
          const handle = req.result;
          handle.onversionchange = () => handle.close();
          resolve(handle);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    }).then((handle) => {
      if (handle) void sweep(handle, store, limits);
      return handle;
    });
    return opened;
  };
  const request = async <T,>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> => {
    const handle = await open();
    if (!handle) return undefined;
    return new Promise<T | undefined>((resolve) => {
      try {
        const tx = handle.transaction(store, mode);
        const req = op(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => resolve(undefined);
        tx.onabort = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  };
  return {
    read: (key) => request<S | undefined>("readonly", (s) => s.get(key) as IDBRequest<S | undefined>),
    write: (key, value) => void (value ? request("readwrite", (s) => s.put(value, key)) : request("readwrite", (s) => s.delete(key))),
    keys: async () => ((await request("readonly", (s) => s.getAllKeys())) ?? []).filter((k): k is string => typeof k === "string"),
  };
}

/** Drop expired entries and all but the newest `maxStored`. */
function sweep(db: IDBDatabase, store: string, limits: { maxStored: number; maxAgeMs: number }): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(store, "readwrite");
      const os = tx.objectStore(store);
      const seen: { key: IDBValidKey; at: number }[] = [];
      const cursor = os.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) {
          seen.push({ key: c.key, at: (c.value as Stamped | undefined)?.at ?? 0 });
          c.continue();
          return;
        }
        const now = Date.now();
        seen.sort((a, b) => b.at - a.at);
        seen.forEach((e, i) => {
          if (i >= limits.maxStored || now - e.at > limits.maxAgeMs) os.delete(e.key);
        });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

interface SlotState<T> {
  values: Record<string, T>;
  /** Keys whose stored value has been read into memory in this session. */
  loaded: Record<string, true>;
}

/** One kind of draft value (see [`draftSlots`]). */
export interface DraftSlots<T, S> {
  /**
   * Read a draft's stored value into memory (once per key; resolves when it is in). Edits made
   * before the read finished were shown right away on what was in memory; they are replayed in
   * order on top of the stored value, so an added item lands after the stored ones, a removed one
   * stays removed and a clear stays a clear. Nothing is written before that: an early write would
   * replace the stored value unseen.
   */
  hydrate(key: string): Promise<void>;
  get(key: string): T;
  /** Edit a draft's value (an empty one deletes the stored draft). Shown at once; written once the stored value is in memory. */
  update(key: string, update: (cur: T) => T): void;
  /** Keys holding a value, in memory or stored (to find the drafts of a gone agent). */
  keys(): Promise<string[]>;
  /** Swaps the storage (tests); returns the previous one. */
  setBackend(next: SlotBackend<S>): SlotBackend<S>;
  readonly api: StoreApi<SlotState<T>>;
  readonly empty: T;
}

/**
 * A kind of per-draft value persisted through `backend`: `decode` turns what is stored into the
 * value (dropping malformed parts), `encode` the reverse (`null` for an empty value: the stored
 * draft is deleted), `cap` bounds every value set.
 */
export function draftSlots<T, S>(opts: {
  backend: SlotBackend<S>;
  empty: T;
  isEmpty(v: T): boolean;
  decode(stored: S | undefined): T;
  encode(v: T): S | null;
  cap?(v: T): T;
}): DraftSlots<T, S> {
  let backend = opts.backend;
  const cap = opts.cap ?? ((v: T) => v);
  const api = createStore<SlotState<T>>()(() => ({ values: {}, loaded: {} }));
  /** Keys being read: the edits made meanwhile (replayed on top of the stored value) and the read. */
  const pending = new Map<string, { updates: ((cur: T) => T)[]; done: Promise<void> }>();
  const get = (key: string): T => api.getState().values[key] ?? opts.empty;
  const persist = (key: string, v: T) => backend.write(key, opts.isEmpty(v) ? null : opts.encode(v));

  const hydrate = (key: string): Promise<void> => {
    const running = pending.get(key);
    if (running) return running.done;
    if (api.getState().loaded[key]) return Promise.resolve();
    const updates: ((cur: T) => T)[] = [];
    const done = backend
      .read(key)
      .catch(() => undefined)
      .then((stored) => {
        pending.delete(key);
        const value = updates.reduce((cur, update) => cap(update(cur)), cap(opts.decode(stored)));
        const s = api.getState();
        api.setState({ values: { ...s.values, [key]: value }, loaded: { ...s.loaded, [key]: true } });
        if (updates.length > 0) persist(key, value);
      });
    pending.set(key, { updates, done });
    return done;
  };

  return {
    api,
    empty: opts.empty,
    hydrate,
    get,
    update(key, update) {
      const s = api.getState();
      api.setState({ values: { ...s.values, [key]: cap(update(s.values[key] ?? opts.empty)) } });
      if (s.loaded[key]) {
        persist(key, get(key));
        return;
      }
      if (!pending.has(key)) void hydrate(key);
      pending.get(key)?.updates.push(update);
    },
    async keys() {
      const stored = (await backend.keys?.().catch(() => [])) ?? [];
      const inMemory = Object.entries(api.getState().values)
        .filter(([, v]) => !opts.isEmpty(v))
        .map(([k]) => k);
      return [...new Set([...inMemory, ...stored])];
    },
    setBackend(next) {
      const prev = backend;
      backend = next;
      return prev;
    },
  };
}

/** A draft's value: `[value, setValue, clear]`, hydrated from storage on first use. */
export function useDraftSlot<T, S>(slots: DraftSlots<T, S>, key: string): [T, DraftSetter<T>, () => void] {
  const value = useStore(slots.api, (s) => s.values[key]) ?? slots.empty;
  useEffect(() => {
    void slots.hydrate(key);
  }, [slots, key]);
  const set: DraftSetter<T> = (next) => slots.update(key, typeof next === "function" ? (next as (cur: T) => T) : () => next);
  return [value, set, () => slots.update(key, () => slots.empty)];
}
