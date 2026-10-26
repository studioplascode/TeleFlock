import { CloudDownload, GitBranch, GitFork } from "lucide-react";
import type { BranchList } from "@/core/gen";
import { type SelectOption, formatAge } from "@/design";
import type { PreviewLine } from "../workspace/shared/CommandPreview";
import { shellQuote } from "../workspace/shared/paths";

/*
 * Base ref of a new worktree branch ("Base" select, `WorktreeCreateParams.base`).
 * Hosts report `defaultBase` (`origin/main` when the repo has it): the untouched select shows it and
 * sends no `base`, so hostd fetches it and forks from the fresh commit, not a stale local `main`.
 * Older hosts (no `defaultBase`) get what the select shows, as before: the default branch, else HEAD.
 * Explicit picks — HEAD and the local default branch included — are sent as they are.
 */

/** The ref the Base select shows (`picked` = the user's pick, "" when untouched). */
export function shownBase(list: BranchList | undefined, picked: string): string {
  return picked || list?.defaultBase || list?.defaultBranch || "HEAD";
}

/** `WorktreeCreateParams.base` for a Base select state: absent = the host's `defaultBase`. */
export function baseParam(list: BranchList | undefined, picked: string): string | undefined {
  if (picked) return picked;
  return list?.defaultBase ? undefined : shownBase(list, "");
}

/** `[remote, branch]` when `ref` is one of the repo's remote-tracking branches (`origin/main`). */
export function remoteOf(list: BranchList | undefined, ref: string): [string, string] | null {
  if (!list?.branches.some((b) => b.remote && b.name === ref)) return null;
  const i = ref.indexOf("/");
  return i > 0 ? [ref.slice(0, i), ref.slice(i + 1)] : null;
}

/** Command-preview line for hostd's best-effort fetch of a remote-tracking base (null for local bases). */
export function fetchPreview(list: BranchList | undefined, ref: string, branches: "one" | "many" = "one"): PreviewLine | null {
  const r = remoteOf(list, ref);
  if (!r) return null;
  const which = branches === "one" ? "the new branch doesn't" : "new branches don't";
  return { argv: ["git", "fetch", shellQuote(r[0]), shellQuote(r[1])], note: `fetched first (skipped when offline); ${which} track ${ref}` };
}

/** Base select options: the default base first, then the local default branch, other branches, HEAD. */
export function baseOptions(list: BranchList | undefined): SelectOption[] {
  const def = list?.defaultBranch;
  const defBase = list?.defaultBase;
  const opts: SelectOption[] = [];
  if (defBase) {
    const remote = !!remoteOf(list, defBase);
    opts.push({ value: defBase, label: defBase, hint: remote ? "default · fetched first" : "default branch", icon: remote ? <CloudDownload /> : <GitBranch /> });
  }
  if (def && def !== defBase) opts.push({ value: def, label: def, hint: defBase ? "local default branch" : "default branch", icon: <GitBranch /> });
  const rest = (list?.branches ?? []).filter((b) => b.name !== def && b.name !== defBase && !/\/HEAD$/.test(b.name));
  rest.sort((a, b) => Number(a.remote) - Number(b.remote) || (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0));
  for (const b of rest) {
    opts.push({
      value: b.name,
      label: b.name,
      hint: `${b.remote ? "remote" : b.current ? "checked out here" : "local"}${b.lastCommitAt ? ` · ${formatAge(Date.now() - b.lastCommitAt)}` : ""}`,
      icon: b.remote ? <CloudDownload /> : <GitBranch />,
    });
  }
  opts.push({ value: "HEAD", label: "HEAD", hint: "current commit of the repo", icon: <GitFork /> });
  return opts;
}
