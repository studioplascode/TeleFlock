import type { TranscriptItem } from "@/core/gen";

/** `assistant`: the agent's text; `user`: a prompt (the user's, or a subagent's task). */
export type MessageKind = "assistant" | "user";

/** A message row: what the "last message" pill and the message steppers bring to the top of the list. */
export interface MessageRow {
  id: string;
  kind: MessageKind;
}

/** Which way a step goes through the rows: up to older ones or down to newer ones. */
export type StepDir = "older" | "newer";

/**
 * Which kind of message a row is, or null for a row that is no message to read from its start:
 * thinking, tool calls, notices, compactions, mode and IRC rows, a text row without text
 * (streaming hasn't brought any yet, or only an error: a failed attempt, a provider limit) and
 * omp's system turns (todo reminders, async results).
 */
export function messageKind(item: TranscriptItem | undefined): MessageKind | null {
  if (item?.kind === "assistant") return /\S/.test(item.text) ? "assistant" : null;
  if (item?.kind === "user") return item.synthetic ? null : "user";
  return null;
}

/**
 * The message nearest to row `anchor` going `dir`, the anchor itself left out: the previous one
 * (`older`) or the next (`newer`), of `kind` when given, else of either kind. The anchor may lie
 * past an end: `ids.length` steps back from the bottom, -1 on from the top. Null when there is none.
 */
export function nearestMessage(ids: readonly string[], kindOf: (id: string) => MessageKind | null, anchor: number, dir: StepDir, kind?: MessageKind): MessageRow | null {
  const step = dir === "older" ? -1 : 1;
  for (let i = Math.min(Math.max(anchor, -1), ids.length) + step; i >= 0 && i < ids.length; i += step) {
    const id = ids[i] as string;
    const k = kindOf(id);
    if (k != null && (kind == null || k === kind)) return { id, kind: k };
  }
  return null;
}

/**
 * The newest message of a transcript (the pill beside "Jump to latest"), met going up from the
 * bottom: the agent's last text or the last prompt, whichever comes first.
 */
export function lastMessage(ids: readonly string[], itemOf: (id: string) => TranscriptItem | undefined): MessageRow | null {
  return nearestMessage(ids, (id) => messageKind(itemOf(id)), ids.length, "older");
}

export const sameMessage = (a: MessageRow | null, b: MessageRow | null): boolean => a?.id === b?.id && a?.kind === b?.kind;

/** Where a list is read (`readingRows`): the last row above the spot and the first one below it. */
export interface ReadingRows {
  /** -1: none above. */
  above: number;
  /** The row count: none below. */
  below: number;
}

/**
 * Where a list is read, from its rows' places (`rows`: their tops, ascending, as the virtualiser lays
 * them out) and the spot a jump brings a row's top to (`spot`, same coordinates): rows starting above
 * the spot by more than `near` end at `above`, rows starting below it by more than `near` begin at
 * `below`. A row starting within `near` of the spot is there already (just jumped to), so it is
 * neither; a row the spot falls inside is above it, so stepping back from the middle of a message
 * goes to that message's start first.
 */
export function readingRows(rows: readonly { start: number }[], spot: number, near: number): ReadingRows {
  return { above: firstFrom(rows, spot - near, false) - 1, below: firstFrom(rows, spot + near, true) };
}

/** Index of the first row starting at or past `y` (`past`: strictly past it), by binary search. */
function firstFrom(rows: readonly { start: number }[], y: number, past: boolean): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const s = rows[mid]?.start ?? Number.POSITIVE_INFINITY;
    if (s < y || (past && s === y)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Where a step goes from where the list is read: back to the nearest message of `kind` starting
 * above the spot, or on to the nearest one starting below it. A message at the spot (where the last
 * step put it) is passed over both ways, so each step moves on by one.
 */
export function stepMessage(ids: readonly string[], kindOf: (id: string) => MessageKind | null, at: ReadingRows, dir: StepDir, kind: MessageKind): MessageRow | null {
  return dir === "older" ? nearestMessage(ids, kindOf, at.above + 1, "older", kind) : nearestMessage(ids, kindOf, at.below - 1, "newer", kind);
}
