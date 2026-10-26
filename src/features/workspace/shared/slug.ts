/** Branch / agent-name slugs derived from free text (fan-out, dispatch). */

/** Lowercase `[a-z0-9-]` slug, at most `max` chars. */
export function slugify(s: string, max: number): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

const STOP: Record<string, true> = Object.fromEntries(
  [
    ...["a", "an", "the", "to", "and", "or", "of", "in", "on", "for", "with", "from", "by", "at", "into", "make", "add", "please", "it", "this", "that", "so"],
    ...["i", "me", "my", "we", "our", "us", "you", "your", "is", "are", "be", "can", "could", "would", "should", "will", "when", "then", "also", "just", "some", "all", "following"],
  ].map((w) => [w, true]),
);

/** Longest prompt slug (leaves room for `-N` under herdr's 32-char agent-name limit). */
const MAX_SLUG = 24;
const MAX_WORDS = 3;

/** Courtesy and hand-off openers in front of the actual task. */
const LEAD_FILLER_RE =
  /^(?:please|kindly|hey|hi|hello|ok(?:ay)?|so|now|can you|could you|would you|will you|i (?:want|need|would like|'d like|’d like) you to|we need to|you need to|let'?s|go ahead and|try to)\b[\s,:]*/i;
/** Trailing hand-off clauses ("… when you are done", "…, thanks"). */
const TAIL_RE = /\b(?:(?:when|once|after|as soon as)\s+(?:you(?:'re|’re| are)?\s+|it(?:'s|’s| is)\s+|everything(?:'s| is)\s+)?(?:done|finished|ready|complete)|if (?:possible|you can)|thanks?|thank you)\b.*$/i;
/** "fix the following points", "address these issues": the lead only announces a list. */
const LIST_RE =
  /\b(?:(fix|address|resolve|handle|tackle|implement|do|work through|go through|look into|look at)\s+)?(?:all\s+)?(?:of\s+)?(?:the|these|those|my|our)?\s*(?:following|below|listed|above)(?:\s+(points?|issues?|items?|things?|bugs?|problems?|tasks?|todos?|feedback|comments?|changes?|features?|requests?))?\b|\b(fix|address|resolve|handle|tackle)\s+(?:all\s+)?(?:of\s+)?(?:the|these|those|my|our)\s+(points|issues|items|things|bugs|problems|todos|feedback|comments)\b/i;
/** A list item: at the start of a line, or ` - ` inside one-line lists. */
const BULLET_LINE_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;
const INLINE_BULLET_RE = /\s[-•*]\s+(?=\S)/g;

/** Lowercase words; versions (`0.5.0`) stay one word (`0-5-0`). */
function words(text: string): string[] {
  return (text.toLowerCase().match(/\d+(?:\.\d+)+|[a-z0-9]+/g) ?? []).map((w) => w.replace(/\./g, "-")).filter((w) => STOP[w] !== true);
}

/** Whole words while they fit `max` chars (at least the first, cut short if it alone is longer). */
function fit(ws: readonly string[], max: number): string {
  let out = "";
  for (const w of ws.slice(0, MAX_WORDS)) {
    const next = out ? `${out}-${w}` : w;
    if (out && next.length > max) break;
    out = next;
  }
  return slugify(out, max);
}

/** The suffix a list-announcing lead stands for ("fix the following points" → "fixes"); null when it names no kind of work. */
function listSuffix(verb: string | undefined, noun: string | undefined): string | null {
  const n = noun?.toLowerCase() ?? "";
  if ((verb && /^(?:fix|address|resolve|handle|tackle)$/i.test(verb)) || /^(?:bug|issue|problem)/.test(n)) return "fixes";
  if (/^(?:feature|change)/.test(n)) return n.endsWith("s") ? n : `${n}s`;
  return verb || n ? "tasks" : null;
}

/**
 * A short slug for a task: the goal of its lead sentence, not the noise around it.
 * "Add offline caching to the client" → "offline-caching-client";
 * "Fix the following points and release 0.5.0 when you are done. - … - …" → "release-0-5-0-fixes".
 * Up to 3 whole words (a version counts as one), ≤ 24 chars; "" when the text has no words.
 */
export function slugFromPrompt(prompt: string): string {
  const text = prompt.trim();
  const lines = text.split(/\r?\n/);
  const bulletLines = lines.filter((l) => BULLET_LINE_RE.test(l));
  const firstLine = lines.find((l) => l.trim() && !BULLET_LINE_RE.test(l)) ?? "";
  // The lead: the first sentence of the first plain line, before any inline list.
  let lead = firstLine.split(INLINE_BULLET_RE)[0] ?? "";
  lead = lead.split(/[.!?;](?=\s|$)|:(?:\s|$)/)[0] ?? "";
  const inlinePoints = (firstLine.match(INLINE_BULLET_RE) ?? []).length;
  const points = bulletLines.length + inlinePoints;
  const firstPoint = (bulletLines[0]?.replace(BULLET_LINE_RE, "") ?? firstLine.split(INLINE_BULLET_RE)[1] ?? "").trim();

  for (let i = 0; i < 3; i++) lead = lead.trim().replace(LEAD_FILLER_RE, "");
  lead = lead.replace(TAIL_RE, "");
  let suffix: string | null = null;
  const list = LIST_RE.exec(lead);
  if (list) {
    suffix = listSuffix(list[1] ?? list[3], list[2] ?? list[4] ?? "");
    lead = `${lead.slice(0, list.index)} ${lead.slice(list.index + list[0].length)}`;
  }

  let goal = words(lead);
  if (goal.length === 0 && (suffix || points >= 2)) goal = words(firstPoint);
  if (goal.length === 0) return fit(words(text), MAX_SLUG);
  if (!suffix) return fit(goal, MAX_SLUG);
  // Room for the suffix: the goal's words that fit in front of it.
  const head = fit(goal.slice(0, MAX_WORDS - 1), MAX_SLUG - suffix.length - 1);
  return head ? `${head}-${suffix}` : suffix;
}
