import { useEffect } from "react";
import { create } from "zustand";
import type { DraftSetter } from "./drafts";

/*
 * Images attached to a draft (the session composer's pending images), per draft key. Kept in
 * memory and written through to IndexedDB (localStorage is far too small for screenshots).
 * IndexedDB missing or failing (private modes, old WebViews) degrades to memory only.
 */

export interface DraftImage {
  mime: string;
  /** Base64 payload (no data: prefix). */
  data: string;
  /** data: URL for the thumbnail (rebuilt from `mime` + `data`, never stored). */
  preview: string;
}

/** Images per draft at most. */
export const MAX_DRAFT_IMAGES = 8;
/** Stored drafts kept (newest first) and their maximum age. */
const MAX_STORED = 40;
const MAX_AGE_MS = 30 * 86_400_000;

const DB_NAME = "tf.drafts";
const STORE = "images";

/** What is stored per draft key. */
export interface StoredDraft {
  images: { mime: string; data: string }[];
  at: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).then((db) => {
    if (db) void sweep(db);
    return db;
  });
  return dbPromise;
}

/** One request in its own transaction; `undefined` on any failure (never rejects). */
async function request<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise<T | undefined>((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Drop expired drafts and all but the newest `MAX_STORED`. */
function sweep(db: IDBDatabase): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const seen: { key: IDBValidKey; at: number }[] = [];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) {
          seen.push({ key: c.key, at: (c.value as StoredDraft | undefined)?.at ?? 0 });
          c.continue();
          return;
        }
        const now = Date.now();
        seen.sort((a, b) => b.at - a.at);
        seen.forEach((e, i) => {
          if (i >= MAX_STORED || now - e.at > MAX_AGE_MS) store.delete(e.key);
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

/** Where draft images persist: IndexedDB unless a test swaps it out. */
export interface DraftImageBackend {
  read(key: string): Promise<StoredDraft | undefined>;
  /** `null` deletes the key. */
  write(key: string, value: StoredDraft | null): void;
}

const indexedDbBackend: DraftImageBackend = {
  read: (key) => request<StoredDraft | undefined>("readonly", (s) => s.get(key) as IDBRequest<StoredDraft | undefined>),
  write: (key, value) => void (value ? request("readwrite", (s) => s.put(value, key)) : request("readwrite", (s) => s.delete(key))),
};

let backend: DraftImageBackend = indexedDbBackend;

/** Swaps the storage (tests); returns the previous one. */
export function setDraftImageBackend(next: DraftImageBackend): DraftImageBackend {
  const prev = backend;
  backend = next;
  return prev;
}

const cap = (images: DraftImage[]): DraftImage[] => images.slice(0, MAX_DRAFT_IMAGES);

type Update = (cur: DraftImage[]) => DraftImage[];

interface ImagesState {
  images: Record<string, DraftImage[]>;
  /** Keys whose stored images have been read into memory in this session. */
  loaded: Record<string, true>;
}

const useImages = create<ImagesState>()(() => ({ images: {}, loaded: {} }));
/** Keys being read: the edits made meanwhile (replayed on top of the stored images) and the read. */
const pending = new Map<string, { updates: Update[]; done: Promise<void> }>();

function persist(key: string, images: DraftImage[]): void {
  backend.write(key, images.length ? { images: images.map(({ mime, data }) => ({ mime, data })), at: Date.now() } : null);
}

/**
 * Read a draft's stored images into memory (once per key; resolves when they are in). Edits made
 * before the read finished were shown right away on what was in memory; they are replayed in
 * order on top of the stored images, so an added image lands after them, a removed one stays
 * removed and a clear stays a clear. Nothing is written before that: an early write would replace
 * the stored images unseen.
 */
export function hydrateDraftImages(key: string): Promise<void> {
  const running = pending.get(key);
  if (running) return running.done;
  if (useImages.getState().loaded[key]) return Promise.resolve();
  const updates: Update[] = [];
  const done = backend
    .read(key)
    .catch(() => undefined)
    .then((stored) => {
      pending.delete(key);
      const fromDb: DraftImage[] = Array.isArray(stored?.images)
        ? stored.images.filter((i) => typeof i?.mime === "string" && typeof i.data === "string").map(({ mime, data }) => ({ mime, data, preview: `data:${mime};base64,${data}` }))
        : [];
      const images = updates.reduce((cur, update) => cap(update(cur)), cap(fromDb));
      const s = useImages.getState();
      useImages.setState({ images: { ...s.images, [key]: images }, loaded: { ...s.loaded, [key]: true } });
      if (updates.length > 0) persist(key, images);
    });
  pending.set(key, { updates, done });
  return done;
}

export function getDraftImages(key: string): DraftImage[] {
  return useImages.getState().images[key] ?? [];
}

/**
 * Edit a draft's images (capped at `MAX_DRAFT_IMAGES`; empty deletes the stored draft). Shown at
 * once; written once the stored images are in memory (see [`hydrateDraftImages`]).
 */
export function updateDraftImages(key: string, update: Update): void {
  const s = useImages.getState();
  useImages.setState({ images: { ...s.images, [key]: cap(update(s.images[key] ?? [])) } });
  if (s.loaded[key]) {
    persist(key, getDraftImages(key));
    return;
  }
  if (!pending.has(key)) void hydrateDraftImages(key);
  pending.get(key)?.updates.push(update);
}

/** Replace a draft's images, stored ones included. */
export function setDraftImages(key: string, images: DraftImage[]): void {
  updateDraftImages(key, () => images);
}

const NONE: DraftImage[] = [];

/** A draft's images: `[images, setImages, clear]`, hydrated from IndexedDB on first use. */
export function useDraftImages(key: string): [DraftImage[], DraftSetter<DraftImage[]>, () => void] {
  const images = useImages((s) => s.images[key]) ?? NONE;
  useEffect(() => {
    void hydrateDraftImages(key);
  }, [key]);
  const set: DraftSetter<DraftImage[]> = (next) => updateDraftImages(key, typeof next === "function" ? next : () => next);
  return [images, set, () => setDraftImages(key, [])];
}
