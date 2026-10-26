import { useEffect } from "react";
import { create } from "zustand";
import type { DraftImage } from "@/core";
import { MAX_DRAFT_IMAGES } from "@/core/draftImages";
import type { ImageInput } from "@/core/gen";

/*
 * Images of dispatched tasks, per entry id: shown in the thread and sent again by retries. Too
 * big for localStorage (where threads persist), so they live in IndexedDB `tf.dispatch`/`images`
 * with an in-memory copy; removed with their entries (dismiss, clear, cap, pruned agents) and
 * swept against the threads at startup. IndexedDB missing or failing → memory only.
 */

/** Images per task, as in the session composer. */
export const MAX_TASK_IMAGES = MAX_DRAFT_IMAGES;
/**
 * Base64 characters of images per task. `worktree.create` carries them to the host in one relay
 * message (16 MiB cap), so they stay well under it with room for the rest of the request.
 */
export const MAX_TASK_IMAGE_CHARS = 12 * 1024 * 1024;

const DB_NAME = "tf.dispatch";
const STORE = "images";

interface Stored {
  images: ImageInput[];
  at: number;
}

/** Where entry images persist: IndexedDB unless a test swaps it out. */
export interface EntryImageBackend {
  read(id: string): Promise<Stored | undefined>;
  write(id: string, value: Stored): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  keys(): Promise<string[]>;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
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
  });
  return dbPromise;
}

/** One transaction; `undefined` on any failure (never rejects). */
async function tx<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  // Executor form: tsconfig lib is ES2023, so Promise.withResolvers is not typed.
  return new Promise<T | undefined>((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = op(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

const indexedDbBackend: EntryImageBackend = {
  read: (id) => tx<Stored | undefined>("readonly", (s) => s.get(id) as IDBRequest<Stored | undefined>),
  write: async (id, value) => void (await tx("readwrite", (s) => s.put(value, id))),
  remove: async (ids) => {
    if (ids.length) await tx("readwrite", (s) => void ids.forEach((id) => s.delete(id)));
  },
  keys: async () => ((await tx("readonly", (s) => s.getAllKeys())) ?? []).map(String),
};

let backend: EntryImageBackend = indexedDbBackend;

/** Swaps the storage (tests); returns the previous one. */
export function setEntryImageBackend(next: EntryImageBackend): EntryImageBackend {
  const prev = backend;
  backend = next;
  return prev;
}

/** In memory: images per entry id (`null` = looked up, none stored). */
const useImages = create<Record<string, DraftImage[] | null>>(() => ({}));
const reading = new Map<string, Promise<DraftImage[] | null>>();

/** Store a new entry's images (shown at once; written through). */
export function saveEntryImages(id: string, images: readonly DraftImage[]): Promise<void> {
  if (!images.length) return Promise.resolve();
  useImages.setState({ [id]: [...images] });
  return backend.write(id, { images: images.map(({ mime, data }) => ({ mime, data })), at: Date.now() }).catch(() => undefined);
}

function read(id: string): Promise<DraftImage[] | null> {
  const mem = useImages.getState()[id];
  if (mem !== undefined) return Promise.resolve(mem);
  let p = reading.get(id);
  if (!p) {
    p = backend
      .read(id)
      .catch(() => undefined)
      .then((stored) => {
        reading.delete(id);
        const imgs = Array.isArray(stored?.images)
          ? stored.images.filter((i) => typeof i?.mime === "string" && typeof i.data === "string").map(({ mime, data }) => ({ mime, data, preview: `data:${mime};base64,${data}` }))
          : [];
        const value = imgs.length ? imgs : null;
        useImages.setState({ [id]: value });
        return value;
      });
    reading.set(id, p);
  }
  return p;
}

/** The images to send with an entry (null when it has none, or they are no longer stored on this device). */
export async function loadEntryImages(id: string): Promise<ImageInput[] | null> {
  const imgs = await read(id);
  return imgs ? imgs.map(({ mime, data }) => ({ mime, data })) : null;
}

/** An entry's images for display (`count` > 0 says it has some): undefined while loading, null when gone. */
export function useEntryImages(id: string, count: number): DraftImage[] | null | undefined {
  const imgs = useImages((s) => s[id]);
  useEffect(() => {
    if (count > 0) void read(id);
  }, [id, count]);
  return count > 0 ? imgs : null;
}

/** Forget entries' images (memory and storage). */
export function deleteEntryImages(ids: Iterable<string>): void {
  const list = [...ids];
  if (!list.length) return;
  const cur = useImages.getState();
  if (list.some((id) => id in cur)) {
    const next = { ...cur };
    for (const id of list) delete next[id];
    useImages.setState(next, true);
  }
  void backend.remove(list).catch(() => undefined);
}

/** Drop stored images of entries that no longer exist (cut by the thread caps, or removed in another tab). */
export async function sweepEntryImages(live: ReadonlySet<string>): Promise<void> {
  const keys = await backend.keys().catch(() => [] as string[]);
  const dead = keys.filter((k) => !live.has(k));
  if (dead.length) await backend.remove(dead).catch(() => undefined);
}

/** Sum of base64 characters (what the request carries). */
export function imageChars(images: readonly Pick<ImageInput, "data">[]): number {
  return images.reduce((n, i) => n + i.data.length, 0);
}
