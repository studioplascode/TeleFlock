import type { DraftSetter } from "./drafts";
import { draftSlots, indexedDbSlots, type SlotBackend, useDraftSlot } from "./draftSlots";
import type { DraftPaste } from "./pastes";

/*
 * Large texts pasted into a draft (`./pastes`), per draft key: the draft's text holds their
 * tokens, this store their texts. Kept in memory and written through to IndexedDB
 * "tf.draftPastes"/"pastes" (`./draftSlots`), like a draft's images.
 */

/** Pastes per draft at most (deleted ones kept for undo included). */
export const MAX_DRAFT_PASTES = 16;

export interface StoredPastes {
  pastes: DraftPaste[];
  at: number;
}

export type DraftPasteBackend = SlotBackend<StoredPastes>;

function isPaste(p: unknown): p is DraftPaste {
  if (!p || typeof p !== "object") return false;
  const x = p as Record<string, unknown>;
  return typeof x.n === "number" && Number.isInteger(x.n) && x.n > 0 && typeof x.text === "string" && (x.mode === "inline" || x.mode === "block") && typeof x.at === "number";
}

export const draftPastes = draftSlots<DraftPaste[], StoredPastes>({
  backend: indexedDbSlots<StoredPastes>("tf.draftPastes", "pastes", { maxStored: 40, maxAgeMs: 30 * 86_400_000 }),
  empty: [],
  isEmpty: (v) => v.length === 0,
  decode: (stored) => (Array.isArray(stored?.pastes) ? stored.pastes.filter(isPaste).map(({ n, text, mode, at }) => ({ n, text, mode, at })) : []),
  encode: (v) => ({ pastes: v, at: Date.now() }),
  // The newest ones when there are too many.
  cap: (v) => (v.length > MAX_DRAFT_PASTES ? [...v].sort((a, b) => b.at - a.at).slice(0, MAX_DRAFT_PASTES).sort((a, b) => a.n - b.n) : v),
});

/** A draft's pastes: `[pastes, setPastes, clear]`, hydrated from IndexedDB on first use. */
export function useDraftPastes(key: string): [DraftPaste[], DraftSetter<DraftPaste[]>, () => void] {
  return useDraftSlot(draftPastes, key);
}
