import type { TranscriptItem } from "@/core/gen";

/** A fetched subagent transcript: row ids in order plus the rows by id. */
export interface Snapshot {
  ids: string[];
  byId: Map<string, TranscriptItem>;
}

/** Structural equality for JSON-shaped transcript items. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => same(v, b[i]));
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Fold a re-fetched page into the previous snapshot by id: unchanged items (and the id list, when
 * no rows came or went) keep their identity, so memoised rows don't re-render and the list
 * doesn't re-layout. Returns `prev` itself when nothing changed.
 */
export function mergeSnapshot(prev: Snapshot | null, items: TranscriptItem[]): Snapshot {
  const byId = new Map<string, TranscriptItem>();
  let idsChanged = prev == null || prev.ids.length !== items.length;
  let itemsChanged = idsChanged;
  items.forEach((it, i) => {
    const old = prev?.byId.get(it.id);
    const kept = old && same(old, it) ? old : it;
    byId.set(it.id, kept);
    if (prev?.ids[i] !== it.id) idsChanged = true;
    if (kept !== old) itemsChanged = true;
  });
  if (prev && !idsChanged && !itemsChanged) return prev;
  return { ids: prev && !idsChanged ? prev.ids : items.map((it) => it.id), byId };
}
