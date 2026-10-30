import type { DraftSetter } from "./drafts";
import { draftSlots, indexedDbSlots, type SlotBackend, useDraftSlot } from "./draftSlots";

/*
 * Images attached to a draft (the composers' pending images), per draft key. Kept in memory and
 * written through to IndexedDB "tf.drafts"/"images" (`./draftSlots`).
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

/** What is stored per draft key. */
export interface StoredDraft {
  images: { mime: string; data: string }[];
  at: number;
}

export type DraftImageBackend = SlotBackend<StoredDraft>;

const images = draftSlots<DraftImage[], StoredDraft>({
  // Stored drafts kept (newest first) and their maximum age.
  backend: indexedDbSlots<StoredDraft>("tf.drafts", "images", { maxStored: 40, maxAgeMs: 30 * 86_400_000 }),
  empty: [],
  isEmpty: (v) => v.length === 0,
  decode: (stored) =>
    Array.isArray(stored?.images)
      ? stored.images.filter((i) => typeof i?.mime === "string" && typeof i.data === "string").map(({ mime, data }) => ({ mime, data, preview: `data:${mime};base64,${data}` }))
      : [],
  encode: (v) => ({ images: v.map(({ mime, data }) => ({ mime, data })), at: Date.now() }),
  cap: (v) => v.slice(0, MAX_DRAFT_IMAGES),
});

/** Swaps the storage (tests); returns the previous one. */
export function setDraftImageBackend(next: DraftImageBackend): DraftImageBackend {
  return images.setBackend(next);
}

/** Read a draft's stored images into memory (see `DraftSlots.hydrate`). */
export function hydrateDraftImages(key: string): Promise<void> {
  return images.hydrate(key);
}

export function getDraftImages(key: string): DraftImage[] {
  return images.get(key);
}

/** Keys holding draft images, in memory or stored (to find the drafts of a gone agent). */
export function draftImageKeys(): Promise<string[]> {
  return images.keys();
}

/**
 * Edit a draft's images (capped at `MAX_DRAFT_IMAGES`; empty deletes the stored draft). Shown at
 * once; written once the stored images are in memory (see `DraftSlots.hydrate`).
 */
export function updateDraftImages(key: string, update: (cur: DraftImage[]) => DraftImage[]): void {
  images.update(key, update);
}

/** Replace a draft's images, stored ones included. */
export function setDraftImages(key: string, next: DraftImage[]): void {
  images.update(key, () => next);
}

/** A draft's images: `[images, setImages, clear]`, hydrated from IndexedDB on first use. */
export function useDraftImages(key: string): [DraftImage[], DraftSetter<DraftImage[]>, () => void] {
  return useDraftSlot(images, key);
}
