/** What a transcript list showed when its rows last changed. */
export interface ListMark {
  count: number;
  /** Its last row. */
  lastId: string | undefined;
  /** Which rows it showed (`TranscriptLogProps.view`, e.g. the message board's filter). */
  view: string | undefined;
}

/**
 * Rows that arrived since `prev` (the "N new" of the jump pill): only those after its last row, in
 * the same view. Older rows paged in above (Load older, Find) are not new, and neither are the rows
 * another view shows (clearing a filter brings back rows that were there all along).
 */
export function arrivedSince(prev: ListMark, ids: readonly string[], view: string | undefined): number {
  if (view !== prev.view || ids.length <= prev.count) return 0;
  const at = prev.lastId === undefined ? -1 : ids.lastIndexOf(prev.lastId);
  return at < 0 ? ids.length - prev.count : ids.length - 1 - at;
}
