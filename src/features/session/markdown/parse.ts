/**
 * Streaming-tolerant markdown block parser. Unclosed fences, half-typed tables and lists
 * parse to something sensible, so a growing assistant message never flickers between layouts.
 * Each block keeps its raw source; the renderer memoises blocks by source so only the block
 * that is still growing re-renders per token.
 */

export type Block =
  | { t: "p"; src: string; text: string }
  | { t: "h"; src: string; level: number; text: string }
  | { t: "code"; src: string; lang?: string; code: string; open: boolean }
  /** Display math: `$$…$$` / `\[…\]` on their own lines. `open`: the closing delimiter hasn't streamed in yet. */
  | { t: "math"; src: string; tex: string; open: boolean }
  | { t: "hr"; src: string }
  | { t: "quote"; src: string; blocks: Block[] }
  | { t: "list"; src: string; ordered: boolean; start: number; items: ListItem[] }
  | { t: "table"; src: string; head: string[]; align: ("left" | "center" | "right" | undefined)[]; rows: string[][] };

export interface ListItem {
  task?: boolean;
  checked?: boolean;
  blocks: Block[];
}

// `s` on the two that capture what follows a marker: `.` would refuse U+2028/U+2029, so such a line failed to match after
// the marker and the engine tried every way to split the blanks and the text before giving up (quadratic).
const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)?.*$/s;
/** An ATX heading's opening: up to three spaces, one to six `#` and a blank. Its text is cut by `headingText`. */
const HEADING_OPEN = /^ {0,3}(#{1,6})\s+/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/s;
const MATH_OPEN = /^ {0,3}(\$\$|\\\[)(.*)$/;
/** A line that is nothing but a display-math delimiter: it also ends a paragraph. */
const MATH_DELIM = /^ {0,3}(\$\$|\\\[)\s*$/;

/** JS's `\s` for a UTF-16 unit (a NaN, past the end of the text, is none). */
const isSpace = (c: number): boolean => (c < 128 ? c === 32 || (c >= 9 && c <= 13) : /\s/.test(String.fromCharCode(c)));

/**
 * A thematic break: after at most three spaces, three or more `-`, `*` or `_` (one kind) with blanks
 * anywhere between. Read as a scan: `(?:\s*\1){2,}` cost ~200 ns a character on a long line of markers.
 */
function isRule(line: string): boolean {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  const mark = line.charCodeAt(i);
  if (mark !== 45 && mark !== 42 && mark !== 95) return false;
  let marks = 0;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === mark) marks++;
    else if (!isSpace(c)) return false;
  }
  return marks >= 3;
}

const skipBlanks = (s: string, i: number): number => {
  while (isSpace(s.charCodeAt(i))) i++;
  return i;
};

/**
 * A table's separator row, `|---|:-:|`: dash cells (`:` may touch either end of the dashes) split by pipes,
 * and a pipe may open and close the row. Read as a scan: `\s*\|?\s*` as a regex splits a run of blanks every
 * way it can (quadratic), and a long row costs ~0.5 µs a cell.
 */
function isSeparator(line: string): boolean {
  let i = skipBlanks(line, 0);
  if (line.charCodeAt(i) === 124) i = skipBlanks(line, i + 1);
  for (;;) {
    if (line.charCodeAt(i) === 58) i++;
    const dashes = i;
    while (line.charCodeAt(i) === 45) i++;
    if (i === dashes) return false;
    if (line.charCodeAt(i) === 58) i++;
    i = skipBlanks(line, i);
    if (i >= line.length) return true;
    if (line.charCodeAt(i) !== 124) return false;
    i = skipBlanks(line, i + 1);
    if (i >= line.length) return true;
  }
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      inCode = !inCode;
      cur += c;
    } else if (c === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * The text of an ATX heading, `rest` being what follows its opening: the blanks at the end go, then
 * the closing `#`s (`## Title ##`), then the blanks before them. Cut from the end, not matched with
 * `(.*?)\s*#*\s*$`: that regex retries its tail at every position, which is cubic in a run of blanks.
 */
function headingText(rest: string): string {
  const s = rest.trimEnd();
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 35) end--;
  return s.slice(0, end).trimEnd();
}

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING_OPEN.test(line) || isRule(line) || /^ {0,3}>/.test(line) || LIST_ITEM.test(line) || MATH_DELIM.test(line);
}

/**
 * A display-math block starting at `lines[start]` (`open` is the delimiter and what follows it on
 * that line), or null when the text is ordinary prose that merely begins with `$$` (a shell's PID,
 * a price list): a closing delimiter must come before the next blank line. A delimiter alone on
 * its line that is never closed is the streaming case (`open`) until a blank line shows it isn't.
 * `noCloser`: per closing delimiter, the line (a blank one, or the end) up to which a scan met none:
 * an opener before it would meet none either, so it doesn't scan again (a blank-free stretch of
 * `\[` lines took quadratic time).
 */
function parseMath(lines: string[], start: number, open: string, rest: string, noCloser: Record<string, number>): { block: Block; next: number } | null {
  const close = open === "$$" ? "$$" : "\\]";
  const tail = rest.trimEnd();
  if (tail.endsWith(close)) {
    // `$$ x $$` on one line
    const tex = tail.slice(0, -close.length).trim();
    if (tex) return { block: { t: "math", src: lines[start] ?? "", tex, open: false }, next: start + 1 };
  }
  const bare = tail.trim() === "";
  // Running into the end unclosed is only a failure for an opener with text after it (a bare one is still waiting for its math).
  const dead = noCloser[close] ?? 0;
  if (start < dead && (dead < lines.length || !bare)) return null;
  const body: string[] = [];
  if (!bare) body.push(tail);
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l.trim() === "") {
      noCloser[close] = i;
      return null;
    }
    const t = l.trimEnd();
    if (t.endsWith(close)) {
      const last = t.slice(0, -close.length);
      if (last.trim()) body.push(last);
      const tex = body.join("\n").trim();
      return tex ? { block: { t: "math", src: lines.slice(start, i + 1).join("\n"), tex, open: false }, next: i + 1 } : null;
    }
    body.push(l);
  }
  // Unclosed: only a bare delimiter can still be waiting for its math.
  if (bare) return { block: { t: "math", src: lines.slice(start).join("\n"), tex: body.join("\n"), open: true }, next: lines.length };
  noCloser[close] = lines.length;
  return null;
}

/**
 * Quotes and list items inside one another are read as such this many levels deep; past that a line
 * is plain text. Documents stop at a handful of levels, while `> > > …` or `- - - …` would otherwise
 * recurse once per marker (a stack overflow, and every level re-reads the rest of the line).
 */
const MAX_BLOCK_DEPTH = 16;

/** The blocks of a Markdown text; its unfinished tail (an open fence, a half-typed table) reads as what it is becoming. */
export function parseBlocks(text: string): Block[] {
  return blocksAt(text, 0);
}

function blocksAt(text: string, depth: number): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let noCloser: Record<string, number> | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const math = MATH_OPEN.exec(line);
    if (math) {
      const block = parseMath(lines, i, math[1]!, math[2] ?? "", (noCloser ??= {}));
      if (block) {
        blocks.push(block.block);
        i = block.next;
        continue;
      }
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2] ?? "```";
      const start = i;
      const body: string[] = [];
      i++;
      let open = true;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (l.trim().startsWith(marker[0]!.repeat(marker.length)) && l.trim().replace(/[`~]/g, "") === "") {
          open = false;
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      blocks.push({ t: "code", src: lines.slice(start, i).join("\n"), lang: fence[3] || undefined, code: body.join("\n"), open });
      continue;
    }
    const h = HEADING_OPEN.exec(line);
    if (h) {
      blocks.push({ t: "h", src: line, level: h[1]!.length, text: headingText(line.slice(h[0].length)) });
      i++;
      continue;
    }
    if (isRule(line)) {
      blocks.push({ t: "hr", src: line });
      i++;
      continue;
    }
    if (depth < MAX_BLOCK_DEPTH && /^ {0,3}>/.test(line)) {
      const start = i;
      const inner: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i] ?? "")) {
        inner.push((lines[i] ?? "").replace(/^ {0,3}> ?/, ""));
        i++;
      }
      blocks.push({ t: "quote", src: lines.slice(start, i).join("\n"), blocks: blocksAt(inner.join("\n"), depth + 1) });
      continue;
    }
    const li = depth < MAX_BLOCK_DEPTH ? LIST_ITEM.exec(line) : null;
    if (li) {
      const start = i;
      const ordered = /\d/.test(li[2] ?? "");
      const baseIndent = li[1]!.length;
      const items: ListItem[] = [];
      let cur: string[] | null = null;
      const flush = () => {
        if (!cur) return;
        let first = cur[0] ?? "";
        let task: boolean | undefined;
        let checked: boolean | undefined;
        const tm = /^\[([ xX])\]\s+/.exec(first);
        if (tm) {
          task = true;
          checked = tm[1] !== " ";
          first = first.slice(tm[0].length);
        }
        items.push({ task, checked, blocks: blocksAt([first, ...cur.slice(1)].join("\n"), depth + 1) });
      };
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = LIST_ITEM.exec(l);
        if (m && m[1]!.length <= baseIndent + 1 && /\d/.test(m[2] ?? "") === ordered) {
          flush();
          cur = [m[3] ?? ""];
          i++;
          continue;
        }
        if (l.trim() === "") {
          // Blank line: continue the list only if the next line is indented or another item.
          const next = lines[i + 1] ?? "";
          const nm = LIST_ITEM.exec(next);
          if ((nm && nm[1]!.length <= baseIndent + 1) || /^\s{2,}\S/.test(next)) {
            cur?.push("");
            i++;
            continue;
          }
          break;
        }
        if (/^\s{2,}/.test(l) || (cur && !isBlockStart(l))) {
          cur?.push(l.replace(/^\s{1,4}/, ""));
          i++;
          continue;
        }
        break;
      }
      flush();
      blocks.push({ t: "list", src: lines.slice(start, i).join("\n"), ordered, start: ordered ? Number.parseInt(li[2] ?? "1", 10) || 1 : 1, items });
      continue;
    }
    // table: header row followed by a separator row
    if (line.includes("|") && isSeparator(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
      const start = i;
      const head = splitRow(line);
      const align = splitRow(lines[i + 1] ?? "").map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : undefined;
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      blocks.push({ t: "table", src: lines.slice(start, i).join("\n"), head, align, rows });
      continue;
    }
    // paragraph
    const start = i;
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "" || (para.length > 0 && isBlockStart(l))) break;
      para.push(l);
      i++;
    }
    blocks.push({ t: "p", src: lines.slice(start, i).join("\n"), text: para.join("\n") });
  }
  return blocks;
}

// ---------- inline ----------

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" }
  /** `![alt](src)`: the renderer decides which sources it will show. */
  | { t: "image"; alt: string; src: string }
  /** `$x$`, `\(x\)` (inline) or `$$x$$` mid-paragraph (display). */
  | { t: "math"; tex: string; display: boolean }
  /** Streaming only: a just-arrived chunk of text that fades in (never produced by the parser). */
  | { t: "fresh"; key: number; v: string };

/*
 * Inline parsing takes time linear in the text, whatever it holds. An opener that never closes
 * (`[`, `*`, `$`, `<http://` …) must not send every later opener of its kind scanning to the end
 * again, and nothing is copied off the front of the text per character: `[` × 400 000 took 89 s.
 * Where an opener looks for its closer, the search remembers its answer (`Ahead`), so each
 * stretch of text is searched once per kind of closer.
 */

/** A bare URL, matched where it starts (sticky: no copy of the rest of the text). */
const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]]/y;
/** Two words with blanks between them, as in `$5 and got 5$`. Two letters on each side tell as well as more, and don't backtrack over a long run of them. */
const PROSE_RE = /[A-Za-z]{2}\s+[A-Za-z]{2}/;

const table = (chars: string): Uint8Array => {
  const t = new Uint8Array(128);
  for (const ch of chars) t[ch.charCodeAt(0)] = 1;
  return t;
};
/** The ASCII characters `parseInline` has to look at; the rest of a text is passed over unread. */
const MARKS = table("\\`*_~$[!<\nh");
/** What a backslash escapes. */
const ESCAPABLE = table("\\`*_{}[]()#+-.!|~<>$");

/** JS's `\w`. */
const isWord = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

type Find = (src: string, p: number) => number;

/** The first match of the global `re` at or after `p`, or -1. */
const matching =
  (re: RegExp): Find =>
  (src, p) => {
    re.lastIndex = p;
    return re.exec(src)?.index ?? -1;
  };

/** The first `*` or `_` (`code`) at or after `p` that can close emphasis: after no space, before no second one, and for `_` before no word character. */
function emCloser(src: string, p: number, code: number): number {
  const ch = code === 42 ? "*" : "_";
  for (let e = src.indexOf(ch, p); e >= 0; e = src.indexOf(ch, e + 1)) {
    const next = src.charCodeAt(e + 1);
    if (src.charCodeAt(e - 1) !== 32 && next !== code && (code === 42 || !isWord(next))) return e;
  }
  return -1;
}

/** The first place at or after `from` where `k` backticks in a row begin, or -1. A shorter run is passed over whole. */
function findTicks(src: string, from: number, k: number): number {
  for (let p = src.indexOf("`", from); p >= 0; ) {
    let q = p + 1;
    while (src.charCodeAt(q) === 96) q++;
    if (q - p >= k) return p;
    p = src.indexOf("`", q);
  }
  return -1;
}

/** What an opener looks for, each as "the first … at or after `p`". */
const SEARCHES = {
  /** The `\)` closing `\(`. */
  closeParen: (src, p) => src.indexOf("\\)", p),
  /** The `$$` closing `$$`. */
  dollars: (src, p) => src.indexOf("$$", p),
  /** The `]` closing a link's text or an image's alt. */
  closeBracket: (src, p) => src.indexOf("]", p),
  /** What ends a link's url: a `)` or any blank. */
  urlEnd: matching(/[)\s]/g),
  nonSpace: matching(/\S/g),
  quote: (src, p) => src.indexOf('"', p),
  /** What ends an autolink's url: a `>` or any blank. */
  angleEnd: matching(/[>\s]/g),
  emStar: (src, p) => emCloser(src, p, 42),
  emUnderscore: (src, p) => emCloser(src, p, 95),
} satisfies Record<string, Find>;

/**
 * A forward search through one text that remembers its last answer. Openers of a kind ask "where
 * do I close?" one after another, each from further along. A closer found ahead of the new start
 * still answers it, and "nothing from an earlier start on" answers every later one, so none of
 * them scans what the one before scanned.
 */
class Ahead {
  private from = -1;
  private at = -1;

  next(src: string, p: number, find: Find): number {
    if (this.from < 0 || p < this.from || (this.at >= 0 && p > this.at)) {
      this.at = find(src, p);
      this.from = p;
    }
    return this.at;
  }
}

/** What `parseInline`'s openers look for in one text. */
class Scan {
  private readonly memo: { [K in keyof typeof SEARCHES]?: Ahead } = {};

  constructor(private readonly src: string) {}

  private find(kind: keyof typeof SEARCHES, p: number): number {
    return (this.memo[kind] ??= new Ahead()).next(this.src, p, SEARCHES[kind]);
  }

  /**
   * Inline math starting at `src[i]`: `$x$`, `$$x$$` or `\(x\)`. A single `$` follows pandoc's rules so
   * prices and shell variables stay text: the opener has a non-space right after it and no letter or
   * digit right before it, the closer has a non-space right before it and no digit right after it
   * (`$5 and $10`, `$5-$10`, `$5.00/$10.00`), and the first `$` that can't close ends the attempt.
   * Prose between the dollars (`5 and got 5`) and `$HOME/$USER` are refused too.
   */
  math(i: number): { tex: string; display: boolean; end: number } | null {
    const { src } = this;
    if (src[i] === "\\") {
      if (src[i + 1] !== "(") return null;
      const end = this.find("closeParen", i + 2);
      const tex = end > 0 ? src.slice(i + 2, end).trim() : "";
      return tex ? { tex, display: false, end: end + 2 } : null;
    }
    if (src[i] !== "$") return null;
    if (src[i + 1] === "$") {
      const end = this.find("dollars", i + 2);
      const tex = end > i + 2 ? src.slice(i + 2, end).trim() : "";
      return tex ? { tex, display: true, end: end + 2 } : null;
    }
    const before = src.charCodeAt(i - 1);
    if (before < 128 ? isWord(before) && before !== 95 : i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1]!)) return null;
    if (i + 1 >= src.length || isSpace(src.charCodeAt(i + 1))) return null;
    for (let j = i + 1; j < src.length; j++) {
      const c = src.charCodeAt(j);
      if (c === 92) j++;
      else if (c === 36) {
        const after = src.charCodeAt(j + 1);
        if (isSpace(src.charCodeAt(j - 1)) || (after >= 48 && after <= 57)) return null;
        const tex = src.slice(i + 1, j);
        if (!tex.includes("\\") && PROSE_RE.test(tex)) return null;
        if (/^[A-Za-z_]\w{2,}\//.test(tex)) return null;
        return { tex, display: false, end: j + 1 };
      }
    }
    return null;
  }

  /** `[text](url)` or `[text](url "title")` whose `[` is at `open`: the text, the url and where it all ends. */
  bracket(open: number): { text: string; href: string; end: number } | null {
    const { src } = this;
    const close = this.find("closeBracket", open + 1);
    if (close < 0 || src.charCodeAt(close + 1) !== 40) return null;
    const url = close + 2;
    const stop = this.find("urlEnd", url);
    if (stop <= url) return null; // no end to the url, or an empty one
    let end = stop + 1;
    if (src.charCodeAt(stop) !== 41) {
      // blanks, a quoted title, then the parenthesis
      const quote = this.find("nonSpace", stop);
      const last = src.charCodeAt(quote) === 34 ? this.find("quote", quote + 1) : -1;
      if (last < 0 || src.charCodeAt(last + 1) !== 41) return null;
      end = last + 2;
    }
    return { text: src.slice(open + 1, close), href: src.slice(url, stop), end };
  }

  /** Where the `<https://…>` at `open` ends, or -1. */
  autolink(open: number): number {
    const { src } = this;
    const url = src.startsWith("https://", open + 1) ? open + 9 : src.startsWith("http://", open + 1) ? open + 8 : -1;
    if (url < 0) return -1;
    const stop = this.find("angleEnd", url);
    return stop > url && src.charCodeAt(stop) === 62 ? stop + 1 : -1;
  }

  /** Where the emphasis opened with `code` (`*` or `_`) just before `p` ends, or -1. */
  emEnd(code: number, p: number): number {
    return this.find(code === 42 ? "emStar" : "emUnderscore", p);
  }
}

/**
 * Emphasis, links and the like nest this deep, no deeper. A text can chain openers whose closers are only
 * valid at the end of what they enclose (`_a _a _a ___`), which nests once per opener: every level would
 * read the rest again, and the recursion could overflow the stack. Written Markdown nests at most one of
 * each kind (bold in italic in a link …), a handful of levels.
 */
const MAX_INLINE_DEPTH = 8;

/** Where the first character that needs a look is (an `h` counts only if `http` follows), or -1: what has none is a single text. */
function firstMark(src: string): number {
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c < 128 && MARKS[c] && (c !== 104 || src.startsWith("http", i))) return i;
  }
  return -1;
}

/** The inline nodes of one paragraph, heading or table cell. */
export function parseInline(src: string): Inline[] {
  return inline(src, 0);
}

function inline(src: string, depth: number): Inline[] {
  const first = firstMark(src);
  if (first < 0) return src ? [{ t: "text", v: src }] : [];
  const out: Inline[] = [];
  const n = src.length;
  let scan: Scan | undefined;
  const nested = (s: string): Inline[] => (depth < MAX_INLINE_DEPTH ? inline(s, depth + 1) : [{ t: "text", v: s }]);
  // Text waits as `buf` and the run src[start, i): a character that opens nothing just stays in the run.
  let buf = "";
  // The last two characters of `buf`, so a hard break is read without flattening `buf` (a rope, with a piece added per line).
  let c1 = 0;
  let c2 = 0;
  let start = 0;
  let i = first;
  const add = (s: string) => {
    const last = s.length - 1;
    c2 = last > 0 ? s.charCodeAt(last - 1) : c1;
    c1 = s.charCodeAt(last);
    buf += s;
  };
  const cut = (end: number) => {
    if (end > start) add(src.slice(start, end));
  };
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
    c1 = c2 = 0;
  };
  /** `node` stands for src[i, end): the text before it is done and reading goes on at `end`. */
  const emit = (node: Inline, end: number) => {
    cut(i);
    flush();
    out.push(node);
    i = start = end;
  };
  while (i < n) {
    const code = src.charCodeAt(i);
    if (code >= 128 || !MARKS[code]) {
      i++;
      continue;
    }
    // Four or more of one delimiter in a row (`****`, `$$$$`): each but the last three meets another pair at once, and fails.
    if ((code === 36 || code === 42 || code === 95 || code === 126) && src.charCodeAt(i + 1) === code && src.charCodeAt(i + 2) === code && src.charCodeAt(i + 3) === code) {
      let j = i + 4;
      while (src.charCodeAt(j) === code) j++;
      i = j - 3;
      continue;
    }
    switch (code) {
      case 36: // $
      case 92: {
        // `$…$` and `\(…\)` are math; a backslash before punctuation escapes it
        if (code === 36 || src.charCodeAt(i + 1) === 40) {
          const m = (scan ??= new Scan(src)).math(i);
          if (m) {
            emit({ t: "math", tex: m.tex, display: m.display }, m.end);
            continue;
          }
        }
        const next = src.charCodeAt(i + 1);
        if (code === 92 && next < 128 && ESCAPABLE[next]) {
          // the escaped character is text, the first of the next run
          cut(i);
          start = i + 1;
          i += 2;
          continue;
        }
        break;
      }
      case 96: {
        let k = 1;
        while (src.charCodeAt(i + k) === 96) k++;
        const end = findTicks(src, i + k, k);
        if (end < 0) {
          // unclosed while streaming: render the rest as code
          cut(i);
          flush();
          out.push({ t: "code", v: src.slice(i + k) });
          return out;
        }
        let v = src.slice(i + k, end);
        // one space on each side is padding (a span may begin or end with a backtick)
        if (v.length > 1 && v.charCodeAt(0) === 32 && v.charCodeAt(v.length - 1) === 32) v = v.replace(/^ (.*) $/, "$1");
        emit({ t: "code", v }, end + k);
        continue;
      }
      case 10: {
        cut(i);
        if ((c1 === 32 && c2 === 32) || c1 === 92) {
          // a hard break: two spaces or a backslash before the newline, which are not part of the text
          let end = buf.length;
          if (c1 === 92) end--;
          else while (buf.charCodeAt(end - 1) === 32) end--;
          buf = buf.slice(0, end);
          flush();
          out.push({ t: "br" });
        } else add(" ");
        start = i + 1;
        break;
      }
      case 42: // *
      case 95: {
        // `_`: `**`/`__` is strong, a single one emphasis
        const next = src.charCodeAt(i + 1);
        if (next === code) {
          const end = src.indexOf(code === 42 ? "**" : "__", i + 2);
          if (end > i + 2) {
            emit({ t: "strong", c: nested(src.slice(i + 2, end)) }, end + 2);
            continue;
          }
        } else if (next !== 32 && (code === 42 || !isWord(src.charCodeAt(i - 1)))) {
          // `_` only at word boundaries (snake_case stays plain)
          const end = (scan ??= new Scan(src)).emEnd(code, i + 1);
          if (end >= 0) {
            emit({ t: "em", c: nested(src.slice(i + 1, end)) }, end + 1);
            continue;
          }
        }
        break;
      }
      case 126: {
        // `~~` is strike
        if (src.charCodeAt(i + 1) === 126) {
          const end = src.indexOf("~~", i + 2);
          if (end > i + 2) {
            emit({ t: "del", c: nested(src.slice(i + 2, end)) }, end + 2);
            continue;
          }
        }
        break;
      }
      case 33: {
        // !
        const m = src.charCodeAt(i + 1) === 91 ? (scan ??= new Scan(src)).bracket(i + 1) : null;
        if (m) {
          emit({ t: "image", alt: m.text, src: m.href }, m.end);
          continue;
        }
        break;
      }
      case 91: {
        // [
        const m = (scan ??= new Scan(src)).bracket(i);
        if (m) {
          emit({ t: "link", href: m.href, c: nested(m.text) }, m.end);
          continue;
        }
        break;
      }
      case 60: {
        // <
        const end = src.charCodeAt(i + 1) === 104 ? (scan ??= new Scan(src)).autolink(i) : -1;
        if (end >= 0) {
          const href = src.slice(i + 1, end - 1);
          emit({ t: "link", href, c: [{ t: "text", v: href }] }, end);
          continue;
        }
        break;
      }
      case 104: {
        // h: a bare URL, after a blank, a `(` or the start
        if (src.charCodeAt(i + 1) === 116 && (src.startsWith("http://", i) || src.startsWith("https://", i))) {
          const prev = src.charCodeAt(i - 1);
          if (i === 0 || prev === 40 || isSpace(prev)) {
            URL_RE.lastIndex = i;
            const m = URL_RE.exec(src);
            if (m) {
              emit({ t: "link", href: m[0], c: [{ t: "text", v: m[0] }] }, i + m[0].length);
              continue;
            }
          }
        }
        break;
      }
    }
    i++;
  }
  cut(n);
  flush();
  return out;
}

/** `http://localhost:5173`, `127.0.0.1:3000` … → port, for preview tunnels. */
export function localhostPort(href: string): number | undefined {
  const m = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/.exec(href);
  if (!m) return undefined;
  const port = Number.parseInt(m[1]!, 10);
  return port > 0 && port < 65536 ? port : undefined;
}
