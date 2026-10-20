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
  | { t: "hr"; src: string }
  | { t: "quote"; src: string; blocks: Block[] }
  | { t: "list"; src: string; ordered: boolean; start: number; items: ListItem[] }
  | { t: "table"; src: string; head: string[]; align: ("left" | "center" | "right" | undefined)[]; rows: string[][] };

export interface ListItem {
  task?: boolean;
  checked?: boolean;
  blocks: Block[];
}

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)?.*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

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

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || /^ {0,3}>/.test(line) || LIST_ITEM.test(line);
}

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
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
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ t: "h", src: line, level: h[1]!.length, text: h[2] ?? "" });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: "hr", src: line });
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const start = i;
      const inner: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i] ?? "")) {
        inner.push((lines[i] ?? "").replace(/^ {0,3}> ?/, ""));
        i++;
      }
      blocks.push({ t: "quote", src: lines.slice(start, i).join("\n"), blocks: parseBlocks(inner.join("\n")) });
      continue;
    }
    const li = LIST_ITEM.exec(line);
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
        items.push({ task, checked, blocks: parseBlocks([first, ...cur.slice(1)].join("\n")) });
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
    if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
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
  | { t: "br" };

const URL_RE = /^(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]])/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const rest = src.slice(i);
    if (c === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(src[i + 1]!)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(rest)![0];
      const end = src.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        out.push({ t: "code", v: src.slice(i + run.length, end).replace(/^ (.*) $/, "$1") });
        i = end + run.length;
        continue;
      }
      // unclosed while streaming: render the rest as code
      flush();
      out.push({ t: "code", v: src.slice(i + run.length) });
      break;
    }
    if (c === "\n") {
      if (buf.endsWith("  ") || buf.endsWith("\\")) {
        buf = buf.replace(/( {2,}|\\)$/, "");
        flush();
        out.push({ t: "br" });
      } else buf += " ";
      i++;
      continue;
    }
    if ((c === "*" || c === "_") && src[i + 1] === c) {
      const end = src.indexOf(c + c, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (c === "~" && src[i + 1] === "~") {
      const end = src.indexOf("~~", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "del", c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && src[i + 1] !== " " && src[i + 1] !== c) {
      // `_` only at word boundaries (snake_case stays plain)
      const prev = src[i - 1];
      if (c === "*" || !prev || !/\w/.test(prev)) {
        let end = i + 1;
        for (;;) {
          end = src.indexOf(c, end);
          if (end < 0) break;
          if (src[end - 1] !== " " && src[end + 1] !== c && (c === "*" || !/\w/.test(src[end + 1] ?? ""))) break;
          end++;
        }
        if (end > i + 1) {
          flush();
          out.push({ t: "em", c: parseInline(src.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }
    if (c === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (m) {
        flush();
        out.push({ t: "link", href: m[2]!, c: parseInline(m[1]!) });
        i += m[0].length;
        continue;
      }
    }
    if (c === "<") {
      const m = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
      if (m) {
        flush();
        out.push({ t: "link", href: m[1]!, c: [{ t: "text", v: m[1]! }] });
        i += m[0].length;
        continue;
      }
    }
    if (c === "h" && (rest.startsWith("http://") || rest.startsWith("https://"))) {
      const prev = src[i - 1];
      const m = !prev || /[\s(]/.test(prev) ? URL_RE.exec(rest) : null;
      if (m) {
        flush();
        out.push({ t: "link", href: m[1]!, c: [{ t: "text", v: m[1]! }] });
        i += m[1]!.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
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
