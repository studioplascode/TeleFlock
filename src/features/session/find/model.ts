import type { TranscriptItem } from "@/core/gen";
import type { Needle } from "./match";
import { rowCount } from "./rowText";
import type { FindActive, FindTarget, RemoteFind } from "./store";

/** A row holding matches, in transcript order. `loaded`: the client has the row (`index` then unknown). */
export interface MatchRow {
  id: string;
  count: number;
  loaded: boolean;
  /** Where the host has the row (rows not loaded). */
  index?: number;
  at?: number;
}

/**
 * Every matching row: the host's hits among the rows the client has not loaded (older than its
 * window), then the loaded rows, counted here (they may have changed since the host answered).
 */
export function matchRows(ids: readonly string[], items: Readonly<Record<string, TranscriptItem | undefined>>, needle: Needle, remote: RemoteFind | null): MatchRow[] {
  const out: MatchRow[] = [];
  if (remote?.hits.length) {
    const loaded = new Set(ids);
    for (const h of remote.hits) if (!loaded.has(h.id)) out.push({ id: h.id, count: h.count, loaded: false, index: h.index });
  }
  for (const id of ids) {
    const it = items[id];
    if (!it) continue;
    const count = rowCount(it, needle);
    if (count > 0) out.push({ id, count, loaded: true, at: it.at });
  }
  return out;
}

export function totalOf(rows: readonly MatchRow[]): number {
  let n = 0;
  for (const r of rows) n += r.count;
  return n;
}

/** The newest occurrence (where Find starts: the bottom of the conversation). */
export function newest(rows: readonly MatchRow[]): FindActive | null {
  const last = rows[rows.length - 1];
  return last ? { id: last.id, n: last.count - 1 } : null;
}

/**
 * The occurrence one step `dir` from `active`, wrapping around: `older` walks up the
 * transcript (Enter), `newer` down (Shift+Enter). Without a current one: the newest.
 */
export function step(rows: readonly MatchRow[], active: FindActive | null, dir: "older" | "newer"): FindActive | null {
  const i = active ? rows.findIndex((r) => r.id === active.id) : -1;
  const row = rows[i];
  if (!active || !row) return newest(rows);
  const n = Math.min(active.n, row.count - 1);
  if (dir === "older") {
    if (n > 0) return { id: row.id, n: n - 1 };
    const prev = rows[i - 1] ?? rows[rows.length - 1];
    return prev ? { id: prev.id, n: prev.count - 1 } : null;
  }
  if (n < row.count - 1) return { id: row.id, n: n + 1 };
  const next = rows[i + 1] ?? rows[0];
  return next ? { id: next.id, n: 0 } : null;
}

/** 1-based position of `active` counted from the newest occurrence (0 when it is not a match). */
export function ordinal(rows: readonly MatchRow[], active: FindActive | null): number {
  if (!active) return 0;
  let n = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] as MatchRow;
    if (r.id === active.id) return n + (r.count - Math.min(active.n, r.count - 1));
    n += r.count;
  }
  return 0;
}

/** Where open-at-match lands: the target's row, else the first match at or after its time. */
export function resolveTarget(rows: readonly MatchRow[], t: FindTarget): FindActive | null {
  const byId = t.rowId ? rows.find((r) => r.id === t.rowId) : undefined;
  if (byId) return { id: byId.id, n: 0 };
  if (t.at != null) {
    const at = t.at;
    const after = rows.find((r) => r.at != null && r.at >= at);
    if (after) return { id: after.id, n: 0 };
  }
  return null;
}

/** The current match after the matches changed: kept when its row still matches, else the nearest newer one. */
export function keep(rows: readonly MatchRow[], active: FindActive | null, ids: readonly string[]): FindActive | null {
  if (!active) return null;
  const row = rows.find((r) => r.id === active.id);
  if (row) return active.n < row.count ? active : { id: row.id, n: row.count - 1 };
  const at = ids.indexOf(active.id);
  if (at >= 0) {
    // The row no longer matches: the next match below it, else the newest.
    const pos = new Map(ids.map((id, i) => [id, i]));
    const below = rows.find((r) => r.loaded && (pos.get(r.id) ?? -1) > at);
    if (below) return { id: below.id, n: 0 };
  }
  return newest(rows);
}
