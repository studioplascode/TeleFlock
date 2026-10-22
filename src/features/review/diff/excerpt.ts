import type { ChangedFile, FileStatus } from "@/core/gen";

/*
 * What the review view hands omp's tiny model when it drafts a commit message or a pull request:
 * the changed-file list and a bounded excerpt of the patch that's already loaded.
 */

/** Patch budget for one AI prompt (characters). */
export const AI_PATCH_LIMIT = 12_000;

const LETTER: Record<FileStatus, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U" };
const TRUNCATED = "\n[… diff truncated]\n";

/** One `M src/a.ts (+3 -1)` line per file (renames as `old → new`). */
export function fileList(files: readonly ChangedFile[]): string {
  return files.map((f) => `${LETTER[f.status]} ${f.oldPath ? `${f.oldPath} → ` : ""}${f.path} (+${f.added} -${f.removed})`).join("\n");
}

/** `b/` path of a `diff --git a/x b/y` chunk, if it has that header. */
function chunkPath(chunk: string): string | undefined {
  const m = chunk.match(/^diff --git "?a\/.+?"? "?b\/(.+?)"?$/m);
  return m?.[1];
}

/** As many whole hunks of `chunk` (with its file header) as fit in `room`, else "". */
function partialChunk(chunk: string, room: number): string {
  const parts = chunk.split(/(?=^@@ )/m);
  const head = parts[0] ?? "";
  if (parts.length < 2 || head.length >= room) return "";
  let out = head;
  for (const h of parts.slice(1)) {
    if (out.length + h.length > room) break;
    out += h;
  }
  return out === head ? "" : out;
}

/**
 * `patch` cut to at most `max` characters at a file boundary (or a hunk boundary inside the first
 * file that doesn't fit), with a marker line when something was left out. `only` keeps just those
 * paths (e.g. the uncommitted files out of a diff against the base).
 */
export function patchExcerpt(patch: string, max = AI_PATCH_LIMIT, only?: ReadonlySet<string>): string {
  const all = patch.split(/(?=^diff --git )/m).filter((c) => c.trim());
  const chunks = only ? all.filter((c) => {
    const p = chunkPath(c);
    return p === undefined || only.has(p);
  }) : all;
  const whole = chunks.join("");
  if (whole.length <= max) return whole;
  const room = max - TRUNCATED.length;
  let out = "";
  for (const c of chunks) {
    if (out.length + c.length <= room) {
      out += c;
      continue;
    }
    out += partialChunk(c, room - out.length);
    break;
  }
  // A single huge hunk: cut at the last line that fits.
  if (!out) out = whole.slice(0, Math.max(0, whole.lastIndexOf("\n", room) + 1));
  return out + TRUNCATED;
}
