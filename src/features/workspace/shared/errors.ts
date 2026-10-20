import { toApiError } from "@/core";
import type { ApiError } from "@/core/gen";

/**
 * herdr / git failure modes that get a dedicated, actionable fix in the UI
 * (`docs/research/herdr.md` §8).
 */
export type HerdrFailure =
  | { kind: "untrusted"; error: ApiError }
  | { kind: "branchInUse"; branch?: string; path?: string; error: ApiError }
  | { kind: "branchExists"; branch?: string; error: ApiError }
  | { kind: "pathExists"; path?: string; error: ApiError }
  | { kind: "notRepo"; error: ApiError }
  | { kind: "dirtyNeedsForce"; error: ApiError }
  | { kind: "groupCloseRequired"; error: ApiError }
  | { kind: "other"; error: ApiError };

/** Extract a quoted or bare absolute path from a message/hint ("… at '/x/y'" or "… at /x/y"). */
function pathIn(text: string): string | undefined {
  return text.match(/'(\/[^']+|[A-Za-z]:\\[^']+|~\/[^']+)'/)?.[1] ?? text.match(/\bat ((?:\/|~\/)[^\s,;'"]+)/)?.[1];
}

export function classifyHerdrError(raw: unknown): HerdrFailure {
  const error = toApiError(raw);
  const text = `${error.code} ${error.message} ${error.hint ?? ""}`;
  // tf-hostd's specific codes (crates/tf-hostd/src/ops/README.md), then herdr/git message shapes.
  switch (error.code) {
    case "untrusted_repo":
      return { kind: "untrusted", error };
    case "branch_in_use":
      return { kind: "branchInUse", branch: text.match(/'([^'/][^']*)' is already/)?.[1], path: pathIn(`${error.hint ?? ""} ${error.message}`), error };
    case "branch_exists":
      return { kind: "branchExists", branch: error.message.match(/[`']([^`']+)[`']/)?.[1], error };
    case "path_exists":
      return { kind: "pathExists", path: pathIn(`${error.message} ${error.hint ?? ""}`), error };
    case "not_git_repo":
      return { kind: "notRepo", error };
    case "dirty_worktree":
      return { kind: "dirtyNeedsForce", error };
    case "group_close_required":
      return { kind: "groupCloseRequired", error };
  }
  if (/dubious ownership|safe\.directory/i.test(text)) return { kind: "untrusted", error };
  const inUse = text.match(/'([^']+)' is already (?:used by worktree|checked out) at '([^']+)'/i);
  if (inUse) return { kind: "branchInUse", branch: inUse[1], path: inUse[2], error };
  if (/already used by worktree|already checked out/i.test(text)) return { kind: "branchInUse", error };
  const branchExists = text.match(/a branch named '([^']+)' already exists/i);
  if (branchExists) return { kind: "branchExists", branch: branchExists[1], error };
  const pathExists = text.match(/'([^']+)' already exists/i);
  if (pathExists) return { kind: "pathExists", path: pathExists[1], error };
  if (/not_git_worktree|require a path inside a git work ?tree|not a git repository/i.test(text)) return { kind: "notRepo", error };
  if (/dirty_worktree_requires_force|modified or untracked files|use --force/i.test(text)) return { kind: "dirtyNeedsForce", error };
  if (/workspace_group_close_required|close_group|--group/i.test(text)) return { kind: "groupCloseRequired", error };
  return { kind: "other", error };
}

/** Human description of an error: first meaningful line of the message, plus the hint. */
export function describeError(raw: unknown): { title: string; hint?: string } {
  const e = toApiError(raw);
  const firstLine = e.message.split("\n").find((l) => l.trim()) ?? e.message;
  return { title: firstLine.replace(/^(fatal|error):\s*/i, ""), hint: e.hint };
}
