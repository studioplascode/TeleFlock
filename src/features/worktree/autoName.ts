import { baseSlug, uniqueSlug } from "@/features/dispatch/thread";
import { branchNameError } from "../workspace/shared/paths";

/**
 * The branch an auto-named worktree gets: the tiny model's slug when git accepts it, else the task's
 * own words (`baseSlug`); `-2`, `-3`… past the repo's existing branches. `ai` says which one won.
 */
export function autoBranchName(suggestion: string | null, prompt: string, taken: ReadonlySet<string>): { name: string; ai: boolean } {
  const s = suggestion?.trim();
  if (s && !branchNameError(s)) return { name: uniqueSlug(s, taken), ai: true };
  return { name: uniqueSlug(baseSlug(prompt), taken), ai: false };
}
