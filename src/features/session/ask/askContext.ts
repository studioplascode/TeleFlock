import type { TranscriptItem } from "@/core/gen";

/*
 * What the agent wrote before asking (`UiRequest.context` / `NeedsYou.context`, hosts ≥ 0.8.0), and
 * the same derivation from the rows a client holds, for hosts that don't send it.
 */

/** Hosts send at most about this much context; the rows fallback keeps to the same. */
export const CONTEXT_MAX = 4096;
/** Leads a text cut to its end. */
const CUT_MARK = "…\n\n";

/**
 * A longer text keeps its end, led by a `…` paragraph, cut as hosts cut `context`
 * (`replica/ask_context.rs` `bound`): from the first paragraph start that fits (outside code
 * blocks), unless that drops more than half the room; then from the first line start that fits,
 * where one inside a code block reopens its fence; a single overlong line is cut at a word. Shorter
 * ones come back trimmed.
 */
export function clipContext(text: string, max = CONTEXT_MAX): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const room = max - CUT_MARK.length;
  const min = t.length - room;
  // The first paragraph start, line start outside a code block, and line start inside one (with
  // the line that opened it) at or after `min`.
  let paragraph: number | undefined;
  let line: number | undefined;
  let fenced: { at: number; open: string } | undefined;
  let fence: string | undefined;
  let blankBefore = false;
  let at = 0;
  for (const l of t.split(/(?<=\n)/)) {
    if (at >= min) {
      if (fence !== undefined) fenced ??= { at, open: fence };
      else {
        line ??= at;
        if (blankBefore) {
          paragraph = at;
          break;
        }
      }
    }
    const s = l.trim();
    if (s.startsWith("```") || s.startsWith("~~~")) fence = fence === undefined ? l.trimEnd() : undefined;
    blankBefore = s === "";
    at += l.length;
  }
  let start: number;
  let reopen: string | undefined;
  if (paragraph !== undefined && paragraph - min <= room / 2) {
    start = paragraph;
  } else if (fenced !== undefined && (line === undefined || fenced.at < line)) {
    start = fenced.at;
    reopen = fenced.open;
  } else if (line !== undefined) {
    start = line;
  } else {
    const space = t.indexOf(" ", min);
    start = space >= 0 ? space + 1 : min;
    // never half a surrogate pair
    if (start < t.length && t.charCodeAt(start) >= 0xdc00 && t.charCodeAt(start) <= 0xdfff) start += 1;
  }
  return `${CUT_MARK}${reopen !== undefined ? `${reopen}\n` : ""}${t.slice(start).replace(/^\n+/, "")}`;
}

/**
 * Context from transcript rows, for hosts without `context` (asks only): the text of the assistant
 * message that carries the call `callId` (its assistant rows share the tool row's `at`, before it
 * in the same turn), else the latest assistant row with text since the last prompt and the rows of
 * its message (same `at`). A turn starts at a user row that isn't synthetic; thinking never counts.
 * Without a matching tool row it reads back from the newest row. Empty when the agent wrote nothing.
 */
export function contextFromRows(itemIds: readonly string[], items: Readonly<Record<string, TranscriptItem | undefined>>, callId?: string): string {
  let end = itemIds.length;
  let callAt: number | undefined;
  if (callId) {
    for (let i = itemIds.length - 1; i >= 0; i--) {
      const it = items[itemIds[i] ?? ""];
      if (it?.kind === "tool" && it.callId === callId) {
        end = i;
        callAt = it.at;
        break;
      }
    }
  }
  const message = (at: number | undefined): string => {
    const parts: string[] = [];
    let latest = at;
    for (let i = end - 1; i >= 0; i--) {
      const it = items[itemIds[i] ?? ""];
      if (!it) continue;
      if (it.kind === "user" && !it.synthetic) break;
      if (it.kind !== "assistant" || !it.text.trim()) continue;
      latest ??= it.at;
      if (it.at === latest) parts.unshift(it.text.trim());
    }
    return parts.join("\n\n");
  };
  return clipContext((callAt !== undefined ? message(callAt) : "") || message(undefined));
}

const TRAILING_PUNCT = /[\s.?!:;,…]+$/;
const WORD = /[\p{L}\p{N}]/u;
/** A sentence's end: `.`, `!`, `?` or `…` after a letter (a list number or "Step 2." ends none) and before a
 *  space or the end, with the quotes, brackets and emphasis closing it. */
const SENTENCE_END = /(?<=\p{L}["'”’)\]*_~`]*)[.!?…。！？]+["'”’)\]*_~`]*(?=\s|$)/gu;

/** A paragraph's words for comparing: no emphasis, heading, quote or list markers; whitespace collapsed, lower case. */
function plain(s: string): string {
  return s
    .split("\n")
    .map((line) => line.replace(/^\s*(?:>\s?)*/, "").replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, ""))
    .join(" ")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(TRAILING_PUNCT, "");
}

/** Emphasis left open where a paragraph was cut (its closer went with the question) is dropped. */
function balanced(s: string): string {
  let out = s;
  for (const m of ["**", "__", "~~", "*", "`"]) {
    if (out.split(m).length % 2 === 0) {
      const at = out.lastIndexOf(m);
      out = out.slice(0, at) + out.slice(at + m.length);
    }
  }
  return out.trim();
}

/** Where the last sentence of `s` ends (0 when none does). */
function lastSentenceEnd(s: string): number {
  let end = 0;
  for (const m of s.matchAll(SENTENCE_END)) end = m.index + m[0].length;
  return end;
}

/**
 * The context without trailing paragraphs that only repeat the question (Markdown markers, case and
 * whitespace ignored), so a card never shows the question twice. A paragraph that ends with the
 * question keeps what leads up to it, except a lead-in of three words or fewer after its last
 * sentence ("So:", "My question:"); a sentence before the question ("Tests fail!") always stays.
 * Empty when nothing else is left (show nothing).
 */
export function withoutQuestion(context: string, question: string): string {
  const q = plain(question);
  const paras = context.trim().split(/\n[ \t]*\n/);
  if (!q) return context.trim();
  while (paras.length > 0) {
    const last = paras[paras.length - 1] ?? "";
    const p = plain(last);
    if (p === q) {
      paras.pop();
      continue;
    }
    if (!p.endsWith(q) || WORD.test(p.charAt(p.length - q.length - 1))) break;
    // Where the question starts in the paragraph's own text: the longest suffix that reads as it.
    let start = -1;
    for (let i = last.length - q.length; i >= 0; i--) {
      const s = plain(last.slice(i));
      if (s === q) start = i;
      else if (s.length > q.length) break;
    }
    const lead = start > 0 ? balanced(last.slice(0, start)) : "";
    const end = lastSentenceEnd(lead);
    const short = plain(lead.slice(end)).split(" ").filter((w) => WORD.test(w)).length <= 3;
    const kept = short ? lead.slice(0, end).trim() : lead;
    if (!kept) {
      paras.pop();
      continue;
    }
    paras[paras.length - 1] = kept;
    break;
  }
  return paras.join("\n\n").trim();
}
