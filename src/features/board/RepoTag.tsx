import { FolderGit2, FolderOpen } from "lucide-react";
import type { CSSProperties } from "react";
import { useCore } from "@/core";
import { agentGlyphTheme, cn } from "@/design";
import { basename, tildify } from "@/features/workspace/shared/paths";

/**
 * A repository's identity colour, derived from its name: the start colour of the glyph the Repo grouping
 * draws for it, so one repo carries one hue on every card, row, filter and column header.
 */
export function repoAccent(repo: string): string {
  return agentGlyphTheme(repo).from;
}

/** What names an agent's checkout: its repo, else the folder it runs in (`~` for the host's home folder). */
export function checkoutName(a: { repo?: string; cwd?: string }, home?: string): { repo: boolean; name: string } | null {
  if (a.repo) return { repo: true, name: a.repo };
  const cwd = a.cwd?.replace(/(.)[\\/]+$/, "$1");
  if (!cwd) return null;
  return { repo: false, name: tildify(cwd, home) === "~" ? "~" : basename(cwd) || cwd };
}

export interface RepoTagProps {
  /** Host of the agent (its home folder reads as `~`). */
  hostId: string;
  repo?: string;
  branch?: string;
  cwd?: string;
  /** On the sunset hero card: white on a dark tint, like the card's state pill. */
  sunset?: boolean;
  className?: string;
}

/**
 * Where an agent works, the same on every agent surface: a chip with the repo icon and name in the repo's
 * accent (a neutral folder chip when the agent isn't in a git repo), then the branch as secondary text.
 * The branch gives way first when the line runs out of room.
 */
export function RepoTag({ hostId, repo, branch, cwd, sunset = false, className }: RepoTagProps) {
  const home = useCore((s) => (repo ? undefined : s.hosts[hostId]?.state.info.home));
  const name = checkoutName({ repo, cwd }, home);
  if (!name && !branch) return null;
  const accent = name?.repo && !sunset ? repoAccent(name.name) : undefined;
  const Icon = name?.repo ? FolderGit2 : FolderOpen;
  const title = [name && (name.repo ? `Repository ${name.name}` : `Folder ${cwd ? tildify(cwd, home) : name.name}`), branch && `branch ${branch}`].filter(Boolean).join(" · ");
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5", className)} title={title}>
      {name && (
        <span
          style={accent ? ({ "--repo": accent } as CSSProperties) : undefined}
          className={cn(
            // never shrinks for the branch (a sub-pixel squeeze would show an ellipsis); only the line's width caps it
            "inline-flex max-w-full shrink-0 items-center gap-1 rounded-xs py-px pr-1.5 pl-1 text-2xs font-bold",
            sunset
              ? "bg-[rgb(40_0_20/0.28)] text-white"
              : accent
                ? "bg-[color-mix(in_oklab,var(--repo)_14%,transparent)] text-[var(--repo)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--repo)_30%,transparent)]"
                : "bg-white/6 text-ink-2",
          )}
        >
          <Icon className={cn("size-3 shrink-0", !accent && !sunset && "text-mute")} aria-hidden />
          <span className="truncate">{name.name}</span>
        </span>
      )}
      {branch && <span className="min-w-0 truncate font-mono text-2xs text-mute-2">{branch}</span>}
    </span>
  );
}
