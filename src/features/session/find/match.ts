/**
 * Literal, case-folded matching for Find in a session: the same rules tf-hostd applies to the
 * rows the client has not loaded (`crates/tf-hostd/src/find/text.rs`), so a row counts the same
 * before and after it loads.
 *
 * Folding: each code point's simple lowercase, one code point for one (a code point whose
 * lowercase is longer, `İ`, stays), so offsets in the folded text are offsets in the original.
 * Counting is non-overlapping, left to right (`aaaa` holds `aa` twice).
 */

/** One code point's simple lowercase (itself when the full lowercase is longer). */
function foldPoint(ch: string): string {
  const l = ch.toLowerCase();
  return l === ch || [...l].length !== 1 ? ch : l;
}

const NEEDS_FOLD = /[A-Z\u0080-\uffff]/;
/** Code points `toLowerCase` maps by context (final sigma) or to more than one code point (`İ`). */
const CONTEXTUAL = /[\u0130\u03a3]/;

/** `s` with every code point folded; the same string when nothing changes. */
export function fold(s: string): string {
  if (!NEEDS_FOLD.test(s)) return s;
  // The common case: lowercasing the whole string is the same code point for code point.
  if (!CONTEXTUAL.test(s)) return s.toLowerCase();
  let out = "";
  for (const ch of s) out += foldPoint(ch);
  return out;
}

export interface Needle {
  /** The query as matched: folded unless case-sensitive. */
  text: string;
  caseSensitive: boolean;
}

/** `null` for a query of nothing but whitespace. */
export function needleOf(query: string, caseSensitive: boolean): Needle | null {
  if (!query.trim()) return null;
  return { text: caseSensitive ? query : fold(query), caseSensitive };
}

/** Occurrences of `n` in `hay`, non-overlapping, at most `cap`. */
export function countIn(hay: string, n: Needle, cap = Number.POSITIVE_INFINITY): number {
  if (hay.length < n.text.length) return 0;
  const h = n.caseSensitive ? hay : fold(hay);
  let count = 0;
  for (let at = h.indexOf(n.text); at >= 0 && count < cap; at = h.indexOf(n.text, at + n.text.length)) count++;
  return count;
}

/** Start offsets (UTF-16) of every occurrence of `n` in `hay`, non-overlapping. */
export function offsetsIn(hay: string, n: Needle): number[] {
  const out: number[] = [];
  if (hay.length < n.text.length) return out;
  const h = n.caseSensitive ? hay : fold(hay);
  for (let at = h.indexOf(n.text); at >= 0; at = h.indexOf(n.text, at + n.text.length)) out.push(at);
  return out;
}
