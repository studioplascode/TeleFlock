import type { ChangedFile, FileStatus } from "@/core/gen";

export type LineKind = "ctx" | "add" | "del" | "note";

export interface DiffLine {
  kind: LineKind;
  text: string;
  /** 1-based line numbers; absent on the side the line doesn't exist. */
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  header: string;
  /** Text after the second `@@` (enclosing function), if any. */
  section: string;
  oldStart: number;
  /** Line counts from the header (`-start,count +start,count`; a missing count means 1). */
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  added: number;
  removed: number;
  binary: boolean;
  hunks: Hunk[];
  /** Longest line in characters (drives horizontal scroll width without measuring). */
  maxLen: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1).replace(/\\(.)/g, "$1");
  return p;
}

function stripPrefix(p: string): string {
  const u = unquote(p.trim());
  return u.replace(/^[ab]\//, "");
}

/**
 * Parse `git diff` unified output (with or without the `diff --git` headers) into files and hunks.
 * Linear in the patch size; no regex runs per content line except the hunk header test.
 */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const begin = (path: string): DiffFile => {
    const f: DiffFile = { path, status: "modified", added: 0, removed: 0, binary: false, hunks: [], maxLen: 0 };
    files.push(f);
    hunk = null;
    return f;
  };

  const lines = patch.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (hunk && file) {
      const c = line.charCodeAt(0);
      // ' ' 32, '+' 43, '-' 45, '\\' 92
      if (c === 32 || line === "") {
        hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        if (line.length > file.maxLen) file.maxLen = line.length;
        continue;
      }
      if (c === 43 && !line.startsWith("+++ ")) {
        hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
        file.added++;
        if (line.length > file.maxLen) file.maxLen = line.length;
        continue;
      }
      if (c === 45 && !line.startsWith("--- ")) {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
        file.removed++;
        if (line.length > file.maxLen) file.maxLen = line.length;
        continue;
      }
      if (c === 92) {
        hunk.lines.push({ kind: "note", text: line.slice(2) });
        continue;
      }
    }
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/);
      file = begin(m?.[2] ?? line.slice(11));
      if (m?.[1] && m[1] !== m[2]) file.oldPath = m[1];
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (!file || file.hunks.length > 0) file = begin(stripPrefix(p));
      if (p.trim() === "/dev/null") file.status = "added";
      else if (!file.oldPath && stripPrefix(p) !== file.path) file.oldPath = stripPrefix(p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (!file) file = begin(stripPrefix(p));
      if (p.trim() === "/dev/null") file.status = "deleted";
      else file.path = stripPrefix(p);
      continue;
    }
    if (!file) continue;
    const h = line.match(HUNK_RE);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      hunk = { header: line, section: h[5] ?? "", oldStart: oldNo, oldLines: h[2] === undefined ? 1 : Number(h[2]), newStart: newNo, newLines: h[4] === undefined ? 1 : Number(h[4]), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.oldPath = line.slice(12);
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      file.path = line.slice(10);
      file.status = "renamed";
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
  }
  for (const f of files) if (f.oldPath && f.status === "modified") f.status = "renamed";
  return files;
}

/**
 * Merge parsed files with `git.status`/`git.diff` file stats: status from git (authoritative,
 * includes untracked), and files the patch omits (binary/untracked without content) still listed.
 */
export function mergeFiles(parsed: DiffFile[], stats: ChangedFile[]): DiffFile[] {
  const byPath = new Map(parsed.map((f) => [f.path, f]));
  const out: DiffFile[] = [];
  for (const s of stats) {
    const f = byPath.get(s.path);
    if (f) {
      byPath.delete(s.path);
      out.push({ ...f, status: s.status, oldPath: s.oldPath ?? f.oldPath, added: f.hunks.length ? f.added : s.added, removed: f.hunks.length ? f.removed : s.removed });
    } else {
      out.push({ path: s.path, oldPath: s.oldPath, status: s.status, added: s.added, removed: s.removed, binary: false, hunks: [], maxLen: 0 });
    }
  }
  for (const f of byPath.values()) out.push(f);
  return out;
}

/** Half-open character range `[start, end)` within a line. */
export type Range = [number, number];

/** Words (letters/digits/`_`/`$`), whitespace runs, or single punctuation characters. */
const WORD_RE = /[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu;
/** LCS table budget (tokens × tokens); longer pairs fall back to one prefix/suffix span. */
const MAX_CELLS = 40_000;

/**
 * Word-level intra-line diff for a deleted/added pair: the character ranges that changed on each
 * side (token LCS after trimming the common prefix/suffix). Returns null for whole-line rewrites,
 * where emphasis would carry no extra signal.
 */
export function wordDiff(a: string, b: string): { a: Range[]; b: Range[] } | null {
  if (a === b) return null;
  const ta = a.match(WORD_RE) ?? [];
  const tb = b.match(WORD_RE) ?? [];
  let p = 0;
  while (p < ta.length && p < tb.length && ta[p] === tb[p]) p++;
  let s = 0;
  while (s < ta.length - p && s < tb.length - p && ta[ta.length - 1 - s] === tb[tb.length - 1 - s]) s++;
  const n = ta.length - p - s;
  const m = tb.length - p - s;
  const changedA = new Uint8Array(ta.length);
  const changedB = new Uint8Array(tb.length);
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    changedA.fill(1, p, p + n);
    changedB.fill(1, p, p + m);
  } else {
    // LCS lengths of the middle tokens, filled from the end so the walk below goes forwards.
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = ta[p + i] === tb[p + j] ? (dp[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ta[p + i] === tb[p + j]) {
        i++;
        j++;
      } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0)) changedA[p + i++] = 1;
      else changedB[p + j++] = 1;
    }
    changedA.fill(1, p + i, p + n);
    changedB.fill(1, p + j, p + m);
  }
  const ra = toRanges(ta, changedA);
  const rb = toRanges(tb, changedB);
  const kept = a.length - ra.chars + (b.length - rb.chars);
  if (kept < (a.length + b.length) * 0.4) return null;
  return { a: ra.ranges, b: rb.ranges };
}

/** Changed tokens → merged character ranges (a single unchanged space between two changes joins them). */
function toRanges(toks: string[], changed: Uint8Array): { ranges: Range[]; chars: number } {
  const ranges: Range[] = [];
  let pos = 0;
  let chars = 0;
  for (let i = 0; i < toks.length; i++) {
    const len = toks[i]?.length ?? 0;
    if (changed[i]) {
      chars += len;
      const last = ranges[ranges.length - 1];
      const prev = toks[i - 1] ?? "";
      if (last && (last[1] === pos || (last[1] === pos - prev.length && !changed[i - 1] && prev.trim() === "" && prev.length <= 1))) last[1] = pos + len;
      else ranges.push([pos, pos + len]);
    }
    pos += len;
  }
  return { ranges, chars };
}
