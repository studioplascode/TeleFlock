import type { ChangedFile } from "@/core/gen";

/**
 * A path omp keeps for itself, not a file of the repository: a URL-style internal path
 * (`local://PLAN.md`, `artifact://3`, `agent://…`) or the folder one resolves to in omp's session
 * storage. The Artifacts panel lists those. Mirrors tf-collab's `is_session_internal`: hosts that
 * predate it still send such paths in `SessionMeta.files`.
 */
export function isSessionInternalPath(path: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) return true;
  const slashed = path.replaceAll("\\", "/");
  return slashed.includes("/.omp/agent/sessions/") || slashed.includes("/omp-local/");
}

/** The session's changed files without omp-internal ones. */
export function repoFiles(files: readonly ChangedFile[]): ChangedFile[] {
  return files.some((f) => isSessionInternalPath(f.path)) ? files.filter((f) => !isSessionInternalPath(f.path)) : [...files];
}
