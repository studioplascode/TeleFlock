import { Check, ChevronDown, FolderGit2, FolderSearch, GitBranch, Server } from "lucide-react";
import { useState } from "react";
import { useHosts } from "@/core";
import type { BranchList } from "@/core/gen";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  StatusOrb,
  cn,
  useIsMobile,
} from "@/design";
import { PHASE_STATUS } from "@/features/shell/status";
import { tildify } from "@/features/workspace/shared/paths";
import { ResponsiveDialog } from "@/features/workspace/shared/ResponsiveDialog";
import { FolderBrowser, type FolderPick } from "@/features/worktree/FolderBrowser";
import type { RecentRepo } from "./thread";

const chip =
  "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full bg-white/[0.04] px-3 text-xs font-bold text-ink-2 shadow-hairline pressable focus-ring hover:bg-white/8 hover:text-ink data-[state=open]:bg-white/10 data-[state=open]:text-ink disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0";

/** Host chip (only rendered with more than one host). */
export function HostPicker({ hostId, hostIds, onChange, className }: { hostId: string; hostIds: readonly string[]; onChange(id: string): void; className?: string }) {
  const profiles = useHosts((s) => s.profiles);
  const status = useHosts((s) => s.status);
  const nameOf = (id: string) => profiles.find((p) => p.id === id)?.name ?? id;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(chip, "max-w-[11rem] shrink", className)} aria-label="Host" title={nameOf(hostId)}>
        <StatusOrb status={PHASE_STATUS[status[hostId]?.phase ?? "idle"]} size={7} label={null} />
        <span className="min-w-0 truncate">{nameOf(hostId)}</span>
        <ChevronDown className="text-mute" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Host</DropdownMenuLabel>
        {hostIds.map((id) => (
          <DropdownMenuItem key={id} icon={<Server />} onSelect={() => onChange(id)}>
            <span className="flex-1 truncate">{nameOf(id)}</span>
            <span className="text-2xs text-mute">{status[id]?.phase ?? "idle"}</span>
            {id === hostId && <Check className="size-4 text-accent-hi" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Repo chip: recent repositories of the host, plus "Browse…" (folder browser in repo mode). */
export function RepoPicker({
  hostId,
  repo,
  recents,
  home,
  onChange,
  className,
}: {
  hostId: string;
  repo: string | null;
  recents: readonly RecentRepo[];
  home?: string;
  onChange(root: string): void;
  className?: string;
}) {
  const mobile = useIsMobile();
  const [browsing, setBrowsing] = useState(false);
  const [pick, setPick] = useState<FolderPick | null>(null);
  const current = recents.find((r) => r.root === repo);
  const confirm = (p: FolderPick | null) => {
    if (!p) return;
    onChange(p.path);
    setBrowsing(false);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className={cn(chip, repo ? "" : "bg-accent/18 text-accent-ink shadow-[inset_0_0_0_1px_rgb(163_92_240/0.4)]", className)} aria-label="Repository">
          <FolderGit2 className={repo ? "text-accent-hi" : undefined} />
          <span className="min-w-0 truncate">{repo ? (current?.name ?? repo.split(/[\\/]/).pop()) : "Pick a repository"}</span>
          {repo && !mobile && <span className="min-w-0 truncate font-mono text-2xs font-medium text-mute-2 max-lg:hidden">{tildify(repo, home)}</span>}
          <ChevronDown className="text-mute" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] w-[min(380px,calc(100vw-24px))] overflow-y-auto">
          {recents.length > 0 && <DropdownMenuLabel>Recent repositories</DropdownMenuLabel>}
          {recents.map((r) => (
            <DropdownMenuItem key={r.root} icon={<FolderGit2 />} onSelect={() => onChange(r.root)}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{r.name}</span>
                <span className="truncate font-mono text-2xs font-medium text-mute-2">{tildify(r.root, home)}</span>
              </span>
              {r.root === repo && <Check className="size-4 shrink-0 text-accent-hi" />}
            </DropdownMenuItem>
          ))}
          {recents.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem
            icon={<FolderSearch />}
            onSelect={() => {
              setPick(repo ? { path: repo } : null);
              setBrowsing(true);
            }}
          >
            Browse…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ResponsiveDialog
        open={browsing}
        onOpenChange={setBrowsing}
        title="Pick a repository"
        description="Every message you dispatch creates a new worktree of it."
        icon={<FolderGit2 />}
        width={640}
        tall
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            {!mobile && (
              <Button variant="ghost" onClick={() => setBrowsing(false)}>
                Cancel
              </Button>
            )}
            <Button variant="primary" disabled={!pick} onClick={() => confirm(pick)} className={mobile ? "flex-1" : undefined}>
              {pick ? `Use ${pick.path.split(/[\\/]/).pop()}` : "Select a repository"}
            </Button>
          </div>
        }
      >
        {browsing && <FolderBrowser hostId={hostId} mode="repo" value={pick?.path} initialPath={repo ?? undefined} autoFocus={!mobile} onSelect={setPick} onConfirm={confirm} />}
      </ResponsiveDialog>
    </>
  );
}

/** Base-branch chip: the repo's default branch unless changed. */
export function BasePicker({
  value,
  branches,
  onChange,
  disabled,
  className,
}: {
  value: string;
  branches: BranchList | undefined;
  onChange(base: string | null): void;
  disabled?: boolean;
  className?: string;
}) {
  const def = branches?.defaultBranch;
  const others = (branches?.branches ?? []).filter((b) => b.name !== def && !/\/HEAD$/.test(b.name) && !b.name.startsWith("dispatch/")).slice(0, 40);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(chip, "max-w-[11rem] shrink font-mono text-2xs", className)}
        disabled={disabled}
        aria-label="Base branch"
        title={`New worktrees branch from ${value}`}
      >
        <GitBranch className="text-mute" />
        <span className="min-w-0 truncate">{value}</span>
        <ChevronDown className="text-mute" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] min-w-56 overflow-y-auto">
        <DropdownMenuLabel>Branch from</DropdownMenuLabel>
        {def && (
          <DropdownMenuItem icon={<GitBranch />} onSelect={() => onChange(null)}>
            <span className="flex-1 truncate font-mono text-xs">{def}</span>
            <span className="text-2xs text-mute">default</span>
            {value === def && <Check className="size-4 text-accent-hi" />}
          </DropdownMenuItem>
        )}
        {others.map((b) => (
          <DropdownMenuItem key={b.name} icon={<GitBranch />} onSelect={() => onChange(b.name)}>
            <span className="flex-1 truncate font-mono text-xs">{b.name}</span>
            {b.remote && <span className="text-2xs text-mute">remote</span>}
            {value === b.name && <Check className="size-4 text-accent-hi" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem icon={<GitBranch />} onSelect={() => onChange("HEAD")}>
          <span className="flex-1 font-mono text-xs">HEAD</span>
          {value === "HEAD" && <Check className="size-4 text-accent-hi" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
