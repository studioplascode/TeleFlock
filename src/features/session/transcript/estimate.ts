import type { ToolItem, TranscriptItem } from "@/core/gen";

/*
 * Row heights before a row is measured (px, without the gap between rows). The virtualiser sizes
 * the transcript from these until each row has rendered once, so the closer they are, the less the
 * scrollbar thumb (and the content under it) jumps while scrolling up measures older rows in.
 * A single figure per kind overestimated a long session by ~40% (a read or grep call is a one-line
 * 38 px card, not 320 px). Calibrated against the rendered rows at 1440×900 and 412×915; mirrors
 * the row layouts coarsely: ToolCard's open-by-default views and the caps on their bodies.
 */

interface Metrics {
  /** A collapsed tool card (one line). */
  toolHead: number;
  /** One line of monospace output / diff. */
  codeLine: number;
  /** Characters per line of a user bubble / of omp's markdown text. */
  userChars: number;
  textChars: number;
  /** Fixed parts of a user / assistant row around its text. */
  userChrome: number;
  assistantChrome: number;
}

const WIDE: Metrics = { toolHead: 38, codeLine: 19.2, userChars: 88, textChars: 96, userChrome: 48, assistantChrome: 26 };
/** Phones: tighter cards, narrower text, no avatar column. */
const DENSE: Metrics = { toolHead: 34, codeLine: 17.8, userChars: 46, textChars: 52, userChrome: 36, assistantChrome: 22 };

const TEXT_LINE = 21.5;
/** Output panes (bash, ANSI) and diffs stop growing here (AnsiText maxHeight, DiffBody COLLAPSED_LINES). */
const OUTPUT_MAX = 280;
const DIFF_LINES = 36;
const IMAGE_MAX_H = 420;
const IMAGE_MAX_W = 480;

/** Lines `text` wraps into at `perLine` characters; hard breaks count, blank lines a little. */
export function wrappedLines(text: string, perLine: number): number {
  let lines = 0;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const len = end - start;
    lines += len === 0 ? 0.4 : Math.ceil(len / perLine);
    start = end + 1;
  }
  return Math.max(1, lines);
}

/** omp's markdown: paragraphs and list items wrap, table rows and code lines don't, blocks add margins. */
function markdownHeight(text: string, m: Metrics): number {
  let h = 0;
  let code = false;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (line.startsWith("```")) {
      // fence: the block's chrome (padding, header) once per open/close pair
      h += code ? 0 : 34;
      code = !code;
    } else if (code) h += m.codeLine;
    else if (line.trim() === "") h += 8;
    else if (line.startsWith("|")) h += /^\|[\s:|-]+\|?$/.test(line) ? 0 : 33;
    else if (line.startsWith("#")) h += 30;
    else h += TEXT_LINE * Math.ceil(line.length / m.textChars);
  }
  return h;
}

function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

function toolHeight(item: ToolItem, m: Metrics): number {
  const v = item.view;
  const head = m.toolHead;
  // Views arrive in pieces while a call runs (a bash view before its output, …): every part is optional here.
  switch (v?.type) {
    case "bash": {
      const a = v.output ?? "";
      const b = item.output ?? "";
      const out = b.length > a.length ? b : a;
      return head + 35 + (out ? Math.min(OUTPUT_MAX, lineCount(out) * m.codeLine + 16) : 20);
    }
    case "diff": {
      // DiffBody opens up to three files, each showing its first DIFF_LINES lines
      const files = v.files ?? [];
      return files.reduce((sum, f, i) => {
        if (files.length > 3) return sum + 36;
        const lines = lineCount(f.patch ?? "");
        return sum + 40 + Math.min(lines, DIFF_LINES) * (m.codeLine - 0.6) + (lines > DIFF_LINES ? 32 : 0) + (i > 0 ? 6 : 0);
      }, head + 8);
    }
    case "todo":
      return head + 9 + 22 * (v.phases ?? []).reduce((n, p) => n + 1 + (p.tasks?.length ?? 0), 0);
    case "task":
      return head + 7 + 80 * (v.agents?.length ?? 0);
    case "web":
      // the answer, then one title + snippet per source
      return head + 69 + 60 * (v.sources?.length ?? 0);
    case "image": {
      const w = v.image?.width ?? IMAGE_MAX_W;
      const h = v.image?.height ?? 270;
      return head + 38 + Math.min(IMAGE_MAX_H, h * Math.min(1, IMAGE_MAX_W / w));
    }
    case "ask":
      return head + 30 + 40 * (v.questions?.length ?? 1);
    case "markdown":
      return head + 12 + markdownHeight(v.text ?? "", m);
    case "irc":
      return 55 + TEXT_LINE * (wrappedLines(v.text ?? "", m.textChars) - 1);
    default:
      // read, search and plain calls start collapsed; a failed one opens on its error / output
      if (item.status !== "error") return head;
      return head + 20 + Math.min(OUTPUT_MAX, wrappedLines(item.error ?? item.output ?? "", m.textChars) * m.codeLine);
  }
}

function rowHeight(item: TranscriptItem, m: Metrics): number {
  switch (item.kind) {
    case "user":
      return item.synthetic ? 46 : m.userChrome + TEXT_LINE * wrappedLines(item.text ?? "", m.userChars) + ((item.images?.length ?? 0) > 0 ? 168 : 0);
    case "assistant":
      return m.assistantChrome + markdownHeight(item.text ?? "", m) + (item.error ? 44 : 0);
    case "thinking":
      // the collapsed pill; while streaming, a tail of the thoughts under it
      return item.streaming ? 90 : 25;
    case "tool":
      return toolHeight(item, m);
    case "notice":
      return 28;
    case "mode":
      return 20;
    case "compaction":
      return 32;
    case "irc":
      return 34 + TEXT_LINE * wrappedLines(item.message?.text ?? "", m.textChars);
    default:
      return 48;
  }
}

const cache = { wide: new WeakMap<TranscriptItem, number>(), dense: new WeakMap<TranscriptItem, number>() };

/**
 * Estimated height of one transcript row (px). Cached per item object: the store replaces an item
 * when it changes, so an edited row is estimated again while the rest cost a lookup.
 */
export function estimateRowHeight(item: TranscriptItem | undefined, dense: boolean): number {
  if (!item) return 48;
  const memo = dense ? cache.dense : cache.wide;
  let h = memo.get(item);
  if (h === undefined) {
    h = Math.round(rowHeight(item, dense ? DENSE : WIDE));
    memo.set(item, h);
  }
  return h;
}

/**
 * Where a transcript that opens at the bottom starts scrolling: its estimated height less one
 * viewport. The scroll box can't go past that, so a transcript shorter than the viewport starts at 0
 * and its first rows render (an offset of the whole estimated height, which no scroll event ever
 * corrected, left a short transcript without its first rows and a gap in their place).
 */
export function initialScrollOffset(totalHeight: number, viewportHeight: number): number {
  return Math.max(0, totalHeight - viewportHeight);
}
