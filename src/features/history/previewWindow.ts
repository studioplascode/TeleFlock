import type { SessionRows, TranscriptItem } from "@/core/gen";

/** The rows of a session file the preview holds: one contiguous window of the session. */
export interface PreviewWindow {
  /** Row ids, oldest first. */
  ids: string[];
  items: Record<string, TranscriptItem>;
  /** Where `ids[0]` sits in the session, 0 = oldest. */
  start: number;
  /** Rows the session has. */
  rows: number;
}

export function windowOf(r: SessionRows): PreviewWindow {
  const items: Record<string, TranscriptItem> = {};
  for (const it of r.items) items[it.id] = it;
  return { ids: r.items.map((it) => it.id), items, start: r.start, rows: r.rows };
}

/** Older rows exist above the window. */
export function hasOlder(w: PreviewWindow): boolean {
  return w.start > 0;
}

/** Newer rows exist below the window. */
export function hasNewer(w: PreviewWindow): boolean {
  return w.start + w.ids.length < w.rows;
}

/** The window with the rows just above it (`search.read` with `before`). An empty answer ends the paging. */
export function prepend(w: PreviewWindow, r: SessionRows): PreviewWindow {
  const fresh = r.items.filter((it) => !(it.id in w.items));
  if (fresh.length === 0) return { ...w, start: 0, rows: r.rows };
  const items = { ...w.items };
  for (const it of fresh) items[it.id] = it;
  return { ids: [...fresh.map((it) => it.id), ...w.ids], items, start: Math.max(0, w.start - fresh.length), rows: r.rows };
}

/** The window with the rows just below it (`search.read` with `after`). An empty answer ends the paging. */
export function append(w: PreviewWindow, r: SessionRows): PreviewWindow {
  const fresh = r.items.filter((it) => !(it.id in w.items));
  if (fresh.length === 0) return { ...w, rows: w.start + w.ids.length };
  const items = { ...w.items };
  for (const it of fresh) items[it.id] = it;
  return { ids: [...w.ids, ...fresh.map((it) => it.id)], items, start: w.start, rows: r.rows };
}
