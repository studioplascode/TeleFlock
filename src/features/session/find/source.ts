import type { SessionFindResult, TranscriptItem } from "@/core/gen";

/** Where a find bar's rows come from: the session store, or rows a view holds itself (a preview). */
export interface FindSource {
  /** Loaded rows, oldest first. */
  ids: readonly string[];
  items: Readonly<Record<string, TranscriptItem | undefined>>;
  /** Older rows exist that are not loaded. */
  hasMore: boolean;
  /** Searches the rows older than `before` on the host (`session.find`). Absent: loaded rows only. */
  search?: (query: string, caseSensitive: boolean, before: string | undefined) => Promise<SessionFindResult>;
  /**
   * Pages older rows in until row `id` is loaded (the host has it at `index` of `rows`); true
   * once it is, false when no older rows are left without it. Absent: matches in rows not
   * loaded cannot be reached.
   */
  loadUntil?: (id: string, index: number | undefined, rows: number | undefined) => Promise<boolean>;
}
