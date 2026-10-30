/*
 * Large pastes as attachments, the way omp's own editor takes them (omp 18.13.3: pi-tui
 * `components/editor.ts` #handlePaste / #expandPasteMarkers, coding-agent `input-controller.ts`
 * handleLargePaste / presentLargePasteMenu). A "marker-sized" paste (more than 10 lines or 1000
 * characters) does not flood the message: it becomes a token, `[Paste #2, +240 lines]` or
 * `[Paste #2, 1834 chars]`, that edits as one unit and turns back into the text when the message
 * is sent. From omp's `paste.largeMenuThreshold` lines on (default 100, 0 = never) omp asks what
 * to do with it: wrap it in `<attachment>` tags, save it as `local://paste-N.md` in the session
 * (the message then names that file), or paste it inline. Pure functions; the drafts keep the
 * pastes (`./draftPastes`), the composers show them (`features/session/composer/usePasteAttach`).
 */

/** A paste becomes a token past this many lines… */
export const MARKER_LINES = 10;
/** …or characters (UTF-16 code units, as omp counts). */
export const MARKER_CHARS = 1000;
/** omp's `paste.largeMenuThreshold` default. */
export const DEFAULT_PASTE_MENU_THRESHOLD = 100;
/** Largest paste kept as an attachment (UTF-8 bytes); hostd's `session.writeLocal` takes as much. */
export const MAX_PASTE_BYTES = 4 * 1024 * 1024;
/** Deleted pastes a draft keeps (newest first) so undo can bring their token back. */
export const MAX_ORPHAN_PASTES = 3;

/** `inline`: the text goes where its token is; `block`: wrapped in `<attachment>` tags first. */
export type PasteMode = "inline" | "block";

export interface DraftPaste {
  /** `Paste #n`, unique within its draft until the draft is sent or cleared. */
  n: number;
  /** As pasted, line endings normalized to `\n`. */
  text: string;
  mode: PasteMode;
  /** When it was pasted (ms). */
  at: number;
}

/** A token's place in the message: `[start, end)`. */
export interface TokenSpan {
  start: number;
  end: number;
  n: number;
}

/** Clipboard text as a textarea takes it: CRLF and CR line endings become LF. */
export function normalizePaste(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Lines of `text`, as omp counts them (`split("\n").length`, without the array). */
export function lineCount(text: string): number {
  let lines = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lines++;
  return lines;
}

/** omp collapses a paste into a token past 10 lines or 1000 characters. */
export function isMarkerSized(text: string): boolean {
  return text.length > MARKER_CHARS || lineCount(text) > MARKER_LINES;
}

/** omp asks what to do with a marker-sized paste of `threshold` lines or more (`0`: never asks). */
export function offersMenu(text: string, threshold: number): boolean {
  return threshold > 0 && isMarkerSized(text) && lineCount(text) >= threshold;
}

/** omp's setting value as a threshold: a whole number ≥ 0 (numeric text too), else the default. */
export function parseThreshold(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_PASTE_MENU_THRESHOLD;
}

/** UTF-8 bytes of `text`. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The paste's token in the message, omp's marker: `[Paste #n, +L lines]` past 10 lines, else `[Paste #n, C chars]`. */
export function pasteToken(p: Pick<DraftPaste, "n" | "text">): string {
  const lines = lineCount(p.text);
  return lines > MARKER_LINES ? `[Paste #${p.n}, +${lines} lines]` : `[Paste #${p.n}, ${p.text.length} chars]`;
}

/** omp's "Attach as a wrapped block": the text in `<attachment>` tags, each on its own line. */
export function attachmentBlock(text: string): string {
  return `<attachment>\n${text}\n</attachment>`;
}

/** What the paste's token turns into when the message is sent. */
export function pasteExpansion(p: DraftPaste): string {
  return p.mode === "block" ? attachmentBlock(p.text) : p.text;
}

/** Anything shaped like a paste token, with its number. */
const ANY_TOKEN = /\[Paste #(\d+), (?:\+\d+ lines|\d+ chars)\]/g;

/**
 * The next paste number of a draft: past every paste it holds (deleted ones kept for undo too)
 * and every token-shaped text in it, so a new paste never gives meaning to an old marker.
 */
export function nextPasteNumber(pastes: readonly DraftPaste[], text: string): number {
  let max = pastes.reduce((m, p) => Math.max(m, p.n), 0);
  for (const hit of text.matchAll(ANY_TOKEN)) max = Math.max(max, Number(hit[1]));
  return max + 1;
}

/** Every token-shaped marker in `text` (a paste's or not), in order. */
export function markerSpans(text: string): TokenSpan[] {
  return [...text.matchAll(ANY_TOKEN)].map((hit) => ({ start: hit.index, end: hit.index + hit[0].length, n: Number(hit[1]) }));
}

/** Numbers of the tokens in `text` whose paste the draft doesn't have (lost with the device's storage). */
export function missingPastes(text: string, pastes: readonly DraftPaste[]): number[] {
  const known = new Set(pastes.map((p) => p.n));
  return [...new Set(markerSpans(text).map((s) => s.n))].filter((n) => !known.has(n));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One regex over every paste's token (longer first) and the paste of each token. */
function tokenMatcher(pastes: readonly DraftPaste[]): { re: RegExp; byToken: Map<string, DraftPaste> } | null {
  if (!pastes.length) return null;
  const byToken = new Map(pastes.map((p) => [pasteToken(p), p]));
  const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length);
  return { re: new RegExp(tokens.map(escapeRe).join("|"), "g"), byToken };
}

/** Where `pastes`' tokens are in `text`, in order. */
export function tokenSpans(text: string, pastes: readonly DraftPaste[]): TokenSpan[] {
  const m = tokenMatcher(pastes);
  if (!m) return [];
  const spans: TokenSpan[] = [];
  for (const hit of text.matchAll(m.re)) {
    const p = m.byToken.get(hit[0]);
    if (p) spans.push({ start: hit.index, end: hit.index + hit[0].length, n: p.n });
  }
  return spans;
}

/** The pastes whose token is in `text`, in the order they first appear. */
export function livePastes(text: string, pastes: readonly DraftPaste[]): DraftPaste[] {
  const byN = new Map(pastes.map((p) => [p.n, p]));
  const live = new Map<number, DraftPaste>();
  for (const s of tokenSpans(text, pastes)) {
    const p = byN.get(s.n);
    if (p && !live.has(s.n)) live.set(s.n, p);
  }
  return [...live.values()];
}

/**
 * The message as the agent gets it: every token replaced by its paste's text (or `<attachment>`
 * block), in one pass, so a pasted text that contains another token stays verbatim (omp
 * `#expandPasteMarkers`). omp trims the result on submit; so do the composers.
 */
export function expandPastes(text: string, pastes: readonly DraftPaste[]): string {
  const m = tokenMatcher(pastes);
  if (!m) return text;
  return text.replace(m.re, (token) => {
    const p = m.byToken.get(token);
    return p ? pasteExpansion(p) : token;
  });
}

/** `text` with every token of `paste` replaced by `by`; removing (`""`) also takes one space after each. */
export function replaceToken(text: string, paste: DraftPaste, by: string): string {
  const token = pasteToken(paste);
  if (by) return text.split(token).join(by);
  return text.split(`${token} `).join("").split(token).join("");
}

/**
 * Backspace / Delete over tokens: the range to delete instead of `[start, end)` so no token is
 * left half deleted, or `null` when no token is involved. A collapsed caret takes the token it
 * ends (Backspace) or starts (Delete); a selection grows to the tokens it cuts into.
 */
export function deletionRange(spans: readonly TokenSpan[], start: number, end: number, key: "Backspace" | "Delete"): { start: number; end: number } | null {
  if (start === end) {
    const hit = spans.find((s) => (key === "Backspace" ? s.start < start && start <= s.end : s.start <= start && start < s.end));
    return hit ? { start: hit.start, end: hit.end } : null;
  }
  return wholeTokens(spans, start, end);
}

/** `[start, end)` grown to whole tokens where it cuts into one; `null` when it cuts into none. */
export function wholeTokens(spans: readonly TokenSpan[], start: number, end: number): { start: number; end: number } | null {
  let from = start;
  let to = end;
  for (const s of spans) {
    if (s.start < from && from < s.end) from = s.start;
    if (s.start < to && to < s.end) to = s.end;
  }
  return from === start && to === end ? null : { start: from, end: to };
}

/**
 * A caret inside a token moves to an edge (omp's cursor never rests in one): moving into it from
 * one side carries it to the other side (arrow keys step over it), a click lands on the nearer
 * edge. `null`: not inside one.
 */
export function snapCaret(spans: readonly TokenSpan[], caret: number, previous: number): number | null {
  const s = spans.find((x) => x.start < caret && caret < x.end);
  if (!s) return null;
  if (previous >= s.end) return s.start;
  if (previous <= s.start) return s.end;
  return caret - s.start < s.end - caret ? s.start : s.end;
}

/**
 * The safety net for edits that cut into a token some other way (word deletion, typing over a
 * selection, a phone keyboard's corrections): from `prev` to `next` with the caret at `caret`
 * after the edit, the result that keeps every token whole. An insertion inside a token lands after
 * it; a deletion or replacement that cuts into one takes all of it. `null`: no token was damaged
 * (`next` stands).
 */
export function reconcileTokens(prev: string, next: string, caret: number, pastes: readonly DraftPaste[]): { text: string; caret: number } | null {
  const before = tokenSpans(prev, pastes);
  if (!before.length || tokenSpans(next, pastes).length >= before.length) return null;
  // The edit: prev[p, prev.length - s) became next[p, next.length - s); the inserted text ends at the caret.
  let s = 0;
  const maxS = Math.min(prev.length, next.length - Math.min(caret, next.length));
  while (s < maxS && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  let p = 0;
  const maxP = Math.min(prev.length - s, next.length - s);
  while (p < maxP && prev[p] === next[p]) p++;
  const removedEnd = prev.length - s;
  const inserted = next.slice(p, next.length - s);
  let out: { text: string; caret: number };
  if (p === removedEnd) {
    const inside = before.find((t) => t.start < p && p < t.end);
    if (!inside) return null;
    out = { text: prev.slice(0, inside.end) + inserted + prev.slice(inside.end), caret: inside.end + inserted.length };
  } else {
    const range = wholeTokens(before, p, removedEnd) ?? { start: p, end: removedEnd };
    out = { text: prev.slice(0, range.start) + inserted + prev.slice(range.end), caret: range.start + inserted.length };
  }
  return out.text === next ? null : out;
}

/**
 * The pastes a draft keeps for `text`: every paste with a token in it, plus the newest
 * `MAX_ORPHAN_PASTES` without one (undo may bring their token back).
 */
export function keptPastes(text: string, pastes: readonly DraftPaste[]): DraftPaste[] {
  const live = new Set(livePastes(text, pastes).map((p) => p.n));
  const orphans = pastes
    .filter((p) => !live.has(p.n))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ORPHAN_PASTES)
    .map((p) => p.n);
  const keep = new Set([...live, ...orphans]);
  return pastes.filter((p) => keep.has(p.n));
}

/**
 * `pastes` with `paste` added to a draft holding at most `max`: room is made by forgetting the oldest
 * deleted pastes (no token in `text`); null when `max` pastes are all in the draft, so the new one is
 * refused: a paste whose token is still in the draft is never dropped.
 */
export function addPaste(text: string, pastes: readonly DraftPaste[], paste: DraftPaste, max: number): DraftPaste[] | null {
  const live = new Set(livePastes(text, pastes).map((p) => p.n));
  if (live.size >= max) return null;
  const rest = pastes.filter((p) => p.n !== paste.n);
  const drop = new Set(
    rest
      .filter((p) => !live.has(p.n))
      .sort((a, b) => a.at - b.at)
      .slice(0, Math.max(0, rest.length + 1 - max))
      .map((p) => p.n),
  );
  return [...rest.filter((p) => !drop.has(p.n)), paste];
}

/** The first `max` lines with text in them, trimmed at the end and cut at `width` characters. */
export function previewLines(text: string, max: number, width = 160): string[] {
  const out: string[] = [];
  let from = 0;
  while (out.length < max && from <= text.length) {
    const nl = text.indexOf("\n", from);
    const line = text.slice(from, nl < 0 ? text.length : nl).trimEnd();
    if (out.length > 0 || line.trim() !== "") out.push(line.length > width ? `${line.slice(0, width - 1)}…` : line);
    if (nl < 0) break;
    from = nl + 1;
  }
  return out;
}

/** "240 lines" past 10 lines, else "1,834 chars", as the token counts. */
export function pasteSize(text: string): string {
  const lines = lineCount(text);
  return lines > MARKER_LINES ? `${lines.toLocaleString("en-US")} lines` : `${text.length.toLocaleString("en-US")} chars`;
}
