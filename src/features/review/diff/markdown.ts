/**
 * The Rendered view of a Markdown file in Review: which files get it, the old/new text a diff
 * implies, and the document cut into chunks so only the ones in view render and the changed ones
 * can be marked. Pure; the viewer and its loader live next to it.
 */
import type { DiffFile } from "./parse";

/** `.md`, `.markdown` and `.mdx` (rendered as Markdown: JSX shows as the text it is). */
export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(path);
}

/** Larger files stay a diff: rendering is for reading, and one chunk's layout is not free. */
export const RENDER_MAX_BYTES = 400_000;

/** The deleted file's text, which the patch carries whole (every line is a `-` line). */
export function oldText(file: DiffFile): string {
  const out: string[] = [];
  for (const h of file.hunks) for (const l of h.lines) if (l.kind === "del" || l.kind === "ctx") out.push(l.text);
  return out.length ? `${out.join("\n")}\n` : "";
}

/** 1-based lines of the new text that the diff adds or changes. */
export function addedLines(file: DiffFile): Set<number> {
  const s = new Set<number>();
  for (const h of file.hunks) for (const l of h.lines) if (l.kind === "add" && l.newNo !== undefined) s.add(l.newNo);
  return s;
}

/** A run of whole blocks: rendered by one Markdown instance. */
export interface MdChunk {
  text: string;
  /** 1-based first line in the document. */
  line: number;
  /** The diff adds or changes a line in it. */
  changed: boolean;
}

/** `[first, last]` 1-based, inclusive: a top-level block cut at blank lines outside code fences (and a front-matter header). */
function blockRanges(lines: readonly string[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  let fence: { ch: string; len: number } | undefined;
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (end > 0) {
      out.push([1, end + 1]);
      i = end + 1;
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && (m[1] as string)[0] === fence.ch && (m[1] as string).length >= fence.len && line.trim() === m[1]) fence = undefined;
    } else if (m) {
      fence = { ch: (m[1] as string)[0] as string, len: (m[1] as string).length };
      if (start < 0) start = i;
    } else if (line.trim() === "") {
      if (start >= 0) out.push([start + 1, i]);
      start = -1;
      continue;
    }
    if (start < 0) start = i;
  }
  if (start >= 0) out.push([start + 1, lines.length]);
  return out;
}

/**
 * Cuts `text` into chunks of consecutive blocks that are all changed or all unchanged. Cuts fall
 * between blocks (blank lines), so each chunk is a complete piece of Markdown. `changed`: the
 * lines the diff touches (none: nothing is marked).
 */
export function markdownChunks(text: string, changed: ReadonlySet<number>): MdChunk[] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const chunks: MdChunk[] = [];
  let cur: { from: number; to: number; changed: boolean } | undefined;
  const flush = () => {
    if (cur) chunks.push({ text: lines.slice(cur.from - 1, cur.to).join("\n"), line: cur.from, changed: cur.changed });
  };
  for (const [first, last] of blockRanges(lines)) {
    let touched = false;
    if (changed.size > 0) for (let n = first; n <= last && !touched; n++) touched = changed.has(n);
    if (cur && cur.changed === touched) cur.to = last;
    else {
      flush();
      cur = { from: first, to: last, changed: touched };
    }
  }
  flush();
  return chunks;
}

/** What Rendered shows for one file. */
export type RenderedDoc = { state: "loading" } | { state: "message"; message: string } | { state: "ready"; chunks: MdChunk[] };

/** Row height before measuring: ~one line per 90 characters at the reading size, plus block spacing. */
export function estimateChunkHeight(chunk: MdChunk): number {
  const lines = chunk.text.split("\n");
  return Math.max(40, Math.round(lines.reduce((h, l) => h + Math.max(1, Math.ceil(l.length / 90)) * 21, 0) + 16));
}
