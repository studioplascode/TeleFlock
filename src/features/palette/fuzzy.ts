/**
 * Ranked fuzzy matching for the command palette.
 *
 * Score rules (higher is better): exact > prefix > word-start > substring > subsequence. Matches at
 * word boundaries and consecutive runs earn bonuses; gaps cost points. Returns null when the query
 * is not a subsequence of the text.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - Math.min(t.length - q.length, 100);
  const at = t.indexOf(q);
  if (at > 0) {
    const boundary = isBoundary(t, at);
    return (boundary ? 650 : 500) - Math.min(at, 100);
  }
  // subsequence with boundary/consecutive bonuses
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === " ") continue;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found < 0) return null;
    score += 10;
    if (found === prev + 1) score += 14;
    if (isBoundary(t, found)) score += 18;
    score -= Math.min(found - prev - 1, 12);
    prev = found;
    ti = found + 1;
  }
  return Math.max(1, Math.min(score, 450));
}

function isBoundary(t: string, i: number): boolean {
  if (i === 0) return true;
  const p = t[i - 1] ?? "";
  return p === " " || p === "/" || p === "-" || p === "_" || p === "." || p === ":" || p === "·";
}

/** Best score of a query over a title plus extra keywords (keywords weigh slightly less). */
export function rankItem(query: string, title: string, keywords: readonly string[] = []): number | null {
  let best = fuzzyScore(query, title);
  for (const k of keywords) {
    const s = fuzzyScore(query, k);
    if (s !== null && (best === null || s * 0.9 > best)) best = s * 0.9;
  }
  // multi-word queries: every word must match somewhere
  const words = query.trim().split(/\s+/);
  if (best === null && words.length > 1) {
    const hay = [title, ...keywords].join(" ");
    let sum = 0;
    for (const w of words) {
      const s = fuzzyScore(w, hay);
      if (s === null) return null;
      sum += s;
    }
    best = sum / words.length / 2;
  }
  return best;
}
