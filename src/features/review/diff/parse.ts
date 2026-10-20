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
  newStart: number;
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

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

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
      newNo = Number(h[2]);
      hunk = { header: line, section: h[3] ?? "", oldStart: oldNo, newStart: newNo, lines: [] };
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

/** Common-prefix/suffix intra-line change span for a deleted/added pair (cheap word-diff). */
export function changedSpan(a: string, b: string): { a: [number, number]; b: [number, number] } | null {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  const ae = a.length - s;
  const be = b.length - s;
  // Whole-line rewrites carry no extra signal; skip the highlight.
  if (p === 0 && s === 0) return null;
  if (ae - p > a.length * 0.85 && be - p > b.length * 0.85) return null;
  return { a: [p, ae], b: [p, be] };
}
