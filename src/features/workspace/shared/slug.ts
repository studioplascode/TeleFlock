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
  ["a", "an", "the", "to", "and", "or", "of", "in", "on", "for", "with", "make", "add", "please", "it", "this", "that", "so"].map((w) => [w, true]),
);

/** "Add offline caching to the client" → "offline-caching-client" (up to 3 whole words, ≤ 24 chars). */
export function slugFromPrompt(prompt: string): string {
  const words = prompt.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => STOP[w] !== true) ?? [];
  let out = "";
  for (const w of words.slice(0, 3)) {
    const next = out ? `${out}-${w}` : w;
    if (out && next.length > 24) break;
    out = next;
  }
  return slugify(out, 24);
}
